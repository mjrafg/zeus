/**
 * Mission Mode, stage 1: identity, vocabulary and the shape of a plan.
 *
 * A Mission is a first-class domain object, not a Task wearing a different
 * label. It has its own identity, its own event log and its own terminal
 * model, and the two must not be confusable: a mission id arriving where a
 * task id is expected has to fail loudly rather than resolve to something
 * plausible. That is the whole reason for the `scope` discriminant below —
 * both ids are strings of the same shape, and string types cannot tell them
 * apart.
 *
 * NOTHING IN THIS FILE CALLS A MODEL. Stage 1 is entirely deterministic:
 * identity, events, reconstruction, graph validation, the terminal model and
 * the ratchet. The Oracle and the execution loop arrive later and are not
 * represented here even in outline.
 */

/** Which kind of thing an id names. Ids are strings; this is what separates them. */
export type Scope = 'MISSION' | 'TASK';

const MISSION_ID = /\/M-(\d+)$/;
const TASK_ID = /\/T-(\d+)$/;

export function makeMissionId(projectId: string, seq: number): string {
  return `${projectId}/M-${String(seq).padStart(4, '0')}`;
}

export function isMissionId(id: string): boolean { return MISSION_ID.test(id); }
export function isTaskId(id: string): boolean { return TASK_ID.test(id); }

/** What an id names, or null when it is neither. Never guesses. */
export function scopeOf(id: string): Scope | null {
  if (isMissionId(id)) return 'MISSION';
  if (isTaskId(id)) return 'TASK';
  return null;
}

export class ScopeMismatchError extends Error {
  constructor(readonly expected: Scope, readonly id: string) {
    super(`${expected.toLowerCase()} id expected, got ${scopeOf(id) === null
      ? `an unrecognised id "${id}"`
      : `a ${scopeOf(id)!.toLowerCase()} id "${id}"`}`);
    this.name = 'ScopeMismatchError';
  }
}

/**
 * Gate for an API that takes one kind of id.
 *
 * Throws rather than returning null: passing a mission id to a task API is a
 * programming error, and the failure a caller most needs is the loud one. A
 * silent null would be indistinguishable from "no such task", which is exactly
 * the confusion this exists to prevent.
 */
export function requireScope(expected: Scope, id: string): string {
  if (scopeOf(id) !== expected) throw new ScopeMismatchError(expected, id);
  return id;
}

/** Filesystem-safe form, since ids become directory names. Same rule as tasks. */
export function missionIdToDir(missionId: string): string {
  return missionId.replace(/[^A-Za-z0-9_.-]/g, '~');
}

/** The short label a human reads and types. `proj/M-0007` → `M-0007`. */
export function localLabel(id: string): string {
  return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
}

/* ------------------------------------------------------------------------ *
 * Event vocabulary
 * ------------------------------------------------------------------------ */

/**
 * Mission event types emitted by stage 1.
 *
 * Central by design: the names are part of the contract, and a name invented
 * at a call site is a name nobody can search for. The array is also what the
 * event-type inventory reads — see `src/engine/eventtypes.ts`, which discovers
 * declarations named `*_EVENT_TYPES` precisely so a registry like this one is
 * covered by the redaction probe without anyone remembering to add it.
 */
export const MISSION_EVENT_TYPES = [
  'MISSION_CREATED',
  'PLAN_RECORDED',
  'PLAN_INVALIDATED',
  'TASK_SPAWNED',
  'TASK_OUTCOME',
  'MISSION_CHECKPOINT',
  'MISSION_ESCALATED',
  'MISSION_TERMINATED',
] as const;

export type MissionEventType = typeof MISSION_EVENT_TYPES[number];

/**
 * Names reserved for later stages, so they cannot be reused for something else
 * in the meantime. NOT emitted by stage 1, and deliberately not in
 * `MISSION_EVENT_TYPES`: the inventory should describe events that exist, and
 * an event nobody writes is not one. Renaming this constant to end in
 * `_EVENT_TYPES` would silently enrol these in the redaction probe.
 */
export const RESERVED_MISSION_EVENT_NAMES = [
  'ORACLE_CONSULTED', 'ORACLE_VERDICT',
  'EFFECT_MISMATCH', 'OSCILLATION_DETECTED',
  'DEPENDENCY_MODEL_VIOLATION', 'MISSION_REPLAN', 'EVALUATOR_REVISED',
] as const;

/* ------------------------------------------------------------------------ *
 * Terminal model
 * ------------------------------------------------------------------------ */

/**
 * Two independent dimensions, and they stay independent.
 *
 * `UNEVALUATED` is a first-class value: "nobody has judged this" is a
 * different statement from "this achieved nothing", and collapsing the two
 * turns an absence of evidence into a verdict. That is the same mistake the
 * check vocabulary avoids by keeping REQUIRED_TEST_NOT_RUN apart from
 * TEST_FAILED.
 */
export const ACHIEVEMENTS = ['ACHIEVED', 'PARTIAL', 'NONE', 'UNEVALUATED'] as const;
export type Achievement = typeof ACHIEVEMENTS[number];

export const TERMINATION_REASONS = [
  'COMPLETED', 'BUDGET_EXCEEDED', 'BLOCKED', 'NOT_ACHIEVABLE',
  'ARCHITECTURAL_CONFLICT', 'AUTHORITY_REQUIRED', 'POLICY_REFUSAL',
  'UNRESOLVED_JUDGMENT', 'CANCELLED',
] as const;
export type TerminationReason = typeof TERMINATION_REASONS[number];

/* ------------------------------------------------------------------------ *
 * Structured task graph
 * ------------------------------------------------------------------------ */

/** A machine-checkable fact, never prose. Stage 1 defines; stage 3 evaluates. */
export interface Precondition {
  kind: 'fileExists' | 'fileAbsent' | 'checkFailing' | 'checkPassing' | 'criterionState';
  /** A path, a check name or a criterion id, depending on `kind`. */
  target: string;
  /** Required only by `criterionState`. */
  value?: string;
}

export const PRECONDITION_KINDS: Precondition['kind'][] =
  ['fileExists', 'fileAbsent', 'checkFailing', 'checkPassing', 'criterionState'];

/**
 * What a node claims it will change.
 *
 * Typed, with no free-prose variant. A predicted effect exists so that stage 3
 * can compare it against what actually happened; "improves error handling"
 * cannot be compared to anything, so it is not expressible here.
 */
export type PredictedEffect =
  | { kind: 'expectedCheckTransition'; check: string; from: string; to: string }
  | { kind: 'expectedArtifact'; path: string; exists: boolean }
  | { kind: 'expectedStateFact'; fact: string; value: string };

export const EFFECT_KINDS: PredictedEffect['kind'][] =
  ['expectedCheckTransition', 'expectedArtifact', 'expectedStateFact'];

export const TIERS = ['FAST', 'NORMAL', 'DEEP'] as const;
export const RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export interface TaskNode {
  nodeId: string;
  description: string;
  dependsOn: string[];
  preconditions: Precondition[];
  /** Path globs. Used by the validator to find undeclared interference. */
  reads: string[];
  writes: string[];
  /** Criterion ids. Empty is allowed in stage 1; criteria arrive with the Oracle. */
  affectedCriteria: string[];
  predictedEffects: PredictedEffect[];
  estimatedTier: typeof TIERS[number];
  estimatedCost: number;
  risk: typeof RISKS[number];
}

export interface PlanGraph {
  version: number;
  nodes: TaskNode[];
}

/* ------------------------------------------------------------------------ *
 * Mission record
 * ------------------------------------------------------------------------ */

export interface SpawnedTask {
  taskId: string;
  nodeId: string;
  planVersion: number;
  /** The task's terminal state, once it has one. */
  outcome: string | null;
  evidence: string[];
}

export interface MissionCheckpoint {
  sha: string;
  invariants: string[];
  at: string;
}

/**
 * The mission's current state, derived from its log and never stored twice.
 *
 * Same discipline as `Engine.task()`: the log is the truth, this is a reading
 * of it. Reconstruction is total — see `reconstructMission`.
 */
export interface MissionRecord {
  missionId: string;
  projectId: string;
  goal: string;
  createdAt: string;
  baseSha: string;
  planVersion: number | null;
  plan: PlanGraph | null;
  planInvalidations: Array<{ reason: string; supersededBy: number | null }>;
  spawned: SpawnedTask[];
  checkpoints: MissionCheckpoint[];
  /** The ratchet position the EVENTS imply. The git ref is a pointer to this. */
  ratchetSha: string | null;
  cancelRequested: boolean;
  escalations: number;
  terminated: boolean;
  achievement: Achievement;
  terminationReason: TerminationReason | null;
  events: number;
}
