/**
 * Mission state, reconstructed from the event log.
 *
 * Mission state lives in the SAME EventStore as task state: same hash chain,
 * same redacting sink, same torn-line quarantine, same `verify()`. There is no
 * second store and no mission database — a mission is a log, and
 * `reconstructMission` is a reading of it.
 *
 * Reconstruction is TOTAL. For any prefix of any log — a crash between any two
 * appends — it returns a coherent record rather than throwing, and the fields
 * that must only move one way do only move one way. A reconstruction that can
 * throw is a reconstruction that turns a crash into an outage.
 */

import { EventStore, StoredEvent } from '../engine/events';
import { killRecorded } from '../engine/exec';
import {
  Achievement, MissionCheckpoint, MissionRecord, PlanGraph, SpawnedTask, TaskNode,
  TerminationReason, makeMissionId, requireScope,
} from './types';
import { AcceptanceMode, CriterionOutcome, Evaluator, Oracle } from './oracle';
import { achievementFrom } from './evaluate';

/** A mission's log, read once. */
function eventsOf(store: EventStore, missionId: string): StoredEvent[] {
  try { return store.read(missionId); } catch { return []; }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Builds the current record from a list of events.
 *
 * Exported separately from the store read so a property test can hand it any
 * prefix of any sequence without touching a filesystem.
 */
export function reconstructFromEvents(missionId: string, evs: StoredEvent[]): MissionRecord | null {
  const created = evs.find((e) => e.type === 'MISSION_CREATED');
  if (!created) return null;                       // not a mission log (yet)
  const c = (created.payload ?? {}) as Record<string, unknown>;

  const rec: MissionRecord = {
    missionId,
    projectId: str(c.projectId),
    goal: str(c.goal),
    createdAt: str(c.createdAt, created.ts),
    baseSha: str(c.baseSha, 'unknown'),
    planVersion: null,
    plan: null,
    planInvalidations: [],
    acceptedPlanVersion: null,
    acceptedPlan: null,
    planRejections: 0,
    planCritiques: 0,
    replans: 0,
    spawned: [],
    checkpoints: [],
    ratchetSha: null,
    cancelRequested: false,
    escalations: 0,
    terminated: false,
    achievement: 'UNEVALUATED',
    terminationReason: null,
    events: evs.length,
    oracle: null,
    oracleVersion: null,
    acceptanceMode: null,
    oracleAccepted: false,
    acceptedBy: null,
    acceptedDespite: [],
    recompiles: 0,
    criterionOutcomes: {},
    evaluations: 0,
    evaluatorRevisions: 0,
    derivedAchievement: 'UNEVALUATED',
  };

  const spawnedById = new Map<string, SpawnedTask>();

  for (const e of evs) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case 'PLAN_RECORDED': {
        const version = num(p.version);
        const plan = p.plan as PlanGraph | undefined;
        // A malformed payload must not lose the rest of the log.
        if (version !== null) rec.planVersion = version;
        if (plan && Array.isArray((plan as PlanGraph).nodes)) rec.plan = plan as PlanGraph;
        break;
      }
      case 'PLAN_ACCEPTED': {
        const version = num(p.version);
        const plan = p.plan as PlanGraph | undefined;
        if (version !== null && plan && Array.isArray((plan as PlanGraph).nodes)) {
          rec.acceptedPlanVersion = version;
          rec.acceptedPlan = plan as PlanGraph;
        }
        break;
      }
      case 'PLAN_REJECTED': { rec.planRejections += 1; break; }
      case 'PLAN_CRITIQUED': { rec.planCritiques += 1; break; }
      case 'MISSION_REPLAN': { rec.replans += 1; break; }
      case 'PLAN_INVALIDATED': {
        rec.planInvalidations.push({ reason: str(p.reason, 'unstated'), supersededBy: num(p.supersededBy) });
        // The plan is gone until a new one is recorded; the version is not,
        // because "which version was invalidated" is part of the history.
        rec.plan = null;
        // The MANDATE goes with it. An invalidated plan authorises nothing,
        // so every later spawn is refused until a new plan is accepted —
        // which is what stops execution running on a plan the world has
        // already diverged from.
        rec.acceptedPlan = null;
        break;
      }
      case 'TASK_SPAWNED': {
        const taskId = str(p.taskId);
        if (!taskId) break;
        const entry: SpawnedTask = {
          taskId, nodeId: str(p.nodeId), planVersion: num(p.planVersion) ?? -1,
          outcome: null, evidence: [],
        };
        if (!spawnedById.has(taskId)) { spawnedById.set(taskId, entry); rec.spawned.push(entry); }
        break;
      }
      case 'TASK_OUTCOME': {
        const taskId = str(p.taskId);
        const entry = spawnedById.get(taskId);
        // An outcome for a task nobody recorded spawning is still evidence:
        // record it rather than drop it, so the gap is visible.
        const target = entry ?? { taskId, nodeId: str(p.nodeId), planVersion: -1, outcome: null, evidence: [] };
        target.outcome = str(p.state) || target.outcome;
        target.evidence = [...target.evidence, ...strArray(p.evidence)];
        if (!entry && taskId) { spawnedById.set(taskId, target); rec.spawned.push(target); }
        break;
      }
      case 'MISSION_CHECKPOINT': {
        const sha = str(p.sha);
        if (!sha) break;
        const cp: MissionCheckpoint = { sha, invariants: strArray(p.invariants), at: e.ts };
        rec.checkpoints.push(cp);
        // The ratchet only ever moves forward, and only here.
        rec.ratchetSha = sha;
        break;
      }
      case 'ORACLE_COMPILED': {
        const oracle = p.oracle as Oracle | undefined;
        if (oracle && Array.isArray((oracle as Oracle).criteria)) {
          rec.oracle = oracle;
          rec.oracleVersion = (oracle as Oracle).version ?? rec.oracleVersion;
          // A newly compiled oracle is not an accepted one.
          rec.oracleAccepted = false;
          rec.acceptedBy = null;
          rec.acceptedDespite = [];
        }
        if (p.findingsForwarded === true) rec.recompiles += 1;
        break;
      }
      case 'ORACLE_ACCEPTED': {
        const mode = str(p.acceptanceMode);
        if (mode) rec.acceptanceMode = mode;
        rec.oracleAccepted = true;
        const by = str(p.acceptedBy);
        rec.acceptedBy = (['auto', 'user-confirmed', 'default-policy'].includes(by)
          ? by : 'default-policy') as MissionRecord['acceptedBy'];
        rec.acceptedDespite = Array.isArray(p.acceptedDespite)
          ? (p.acceptedDespite as Array<{ code: string; criterionId?: string }>) : [];
        if (rec.oracle) {
          rec.oracle = { ...(rec.oracle as Oracle),
            acceptanceMode: (rec.acceptanceMode ?? (rec.oracle as Oracle).acceptanceMode) as AcceptanceMode,
            acceptedAt: e.ts };
        }
        break;
      }
      case 'ORACLE_EVALUATED': {
        rec.evaluations += 1;
        const results = Array.isArray(p.results) ? p.results : [];
        for (const r of results as Array<Record<string, unknown>>) {
          const id = str(r.criterionId);
          const outcome = str(r.outcome);
          if (id && ['PROVEN', 'FAILED', 'UNEVALUATED'].includes(outcome)) {
            rec.criterionOutcomes[id] = outcome as CriterionOutcome;
          }
        }
        break;
      }
      case 'EVALUATOR_REVISED': {
        rec.evaluatorRevisions += 1;
        const id = str(p.criterionId);
        const next = p.newEvaluator as Evaluator | undefined;
        if (id && rec.oracle) {
          const o = rec.oracle as Oracle;
          rec.oracle = { ...o, criteria: o.criteria.map(
            (c) => (c.criterionId === id && next ? { ...c, evaluator: next } : c)) };
        }
        // Evidence produced by an evaluator that turned out to be wrong is not
        // evidence. Every prior outcome for this criterion goes back to
        // UNEVALUATED — not FAILED, because nothing was disproven either.
        if (id) rec.criterionOutcomes[id] = 'UNEVALUATED';
        break;
      }
      case 'MISSION_ESCALATED':
        rec.escalations += 1;
        break;
      case 'CANCEL_REQUESTED':
        rec.cancelRequested = true;
        break;
      case 'MISSION_TERMINATED': {
        // Absorbing: the FIRST termination is the one that counts. A second
        // one cannot change the verdict, and silently overwriting it would
        // let a late event rewrite history.
        if (rec.terminated) break;
        rec.terminated = true;
        const a = str(p.achievement);
        rec.achievement = (['ACHIEVED', 'PARTIAL', 'NONE', 'UNEVALUATED'] as string[]).includes(a)
          ? (a as Achievement) : 'UNEVALUATED';
        const r = str(p.terminationReason);
        rec.terminationReason = r ? (r as TerminationReason) : null;
        break;
      }
      default:
        break;
    }
  }
  if (rec.oracle) {
    rec.derivedAchievement = achievementFrom(
      new Map(Object.entries(rec.criterionOutcomes)), rec.oracle as Oracle);
  }
  return rec;
}

export interface MissionRegistryOptions {
  events: EventStore;
  projectId: string;
  /** Needed only by `cancel`, which reaches live task processes. */
  stateRoot?: string;
}

/**
 * The mission-side companion to `Engine`.
 *
 * Deliberately NOT part of Engine: a mission has no worktree, spawns no
 * processes of its own and calls no provider. Keeping it separate is what
 * makes "stage 1 contains zero model calls" checkable by looking at the
 * imports rather than by reading every branch.
 */
export class MissionRegistry {
  readonly events: EventStore;
  readonly projectId: string;
  private readonly stateRoot: string | null;

  constructor(opts: MissionRegistryOptions) {
    this.events = opts.events;
    this.projectId = opts.projectId;
    this.stateRoot = opts.stateRoot ?? null;
  }

  /** Sequential per project, and blind to task ids sharing the store. */
  nextMissionId(): string {
    const seqs = this.events.listTasks()
      .map((t) => /\/M-(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number);
    return makeMissionId(this.projectId, seqs.length ? Math.max(...seqs) + 1 : 1);
  }

  list(): string[] {
    return this.events.listTasks().filter((id) => /\/M-\d+$/.test(id)).sort();
  }

  private append(missionId: string, type: string, payload: Record<string, unknown>): void {
    requireScope('MISSION', missionId);
    this.events.append({ taskId: missionId, type, payload });
  }

  create(goal: string, baseSha: string): MissionRecord {
    const missionId = this.nextMissionId();
    const createdAt = new Date().toISOString();
    this.events.append({ taskId: missionId, type: 'MISSION_CREATED', payload: {
      goal, projectId: this.projectId, createdAt, baseSha,
    } });
    return this.mission(missionId)!;
  }

  /** The mission's current record, derived from its log. Never stored twice. */
  mission(missionId: string): MissionRecord | null {
    requireScope('MISSION', missionId);
    const evs = eventsOf(this.events, missionId);
    if (!evs.length) return null;
    return reconstructFromEvents(missionId, evs);
  }

  /**
   * Records a proposed plan, with any non-blocking findings the deterministic
   * validator raised against it.
   *
   * The findings ride with the plan because acceptance happens later, from the
   * LOG, and a finding that is not on the log at that moment is a finding
   * nobody re-reads at the point of decision.
   */
  recordPlan(missionId: string, plan: PlanGraph, scopeFindings: unknown[] = [],
    providerUsage?: unknown): void {
    this.append(missionId, 'PLAN_RECORDED', {
      version: plan.version, plan, nodes: plan.nodes.length, scopeFindings,
      ...(providerUsage ? { providerUsage } : {}),
    });
  }

  invalidatePlan(missionId: string, reason: string, supersededBy: number | null): void {
    this.append(missionId, 'PLAN_INVALIDATED', { reason, supersededBy });
  }

  taskSpawned(missionId: string, taskId: string, nodeId: string, planVersion: number): void {
    requireScope('TASK', taskId);
    this.append(missionId, 'TASK_SPAWNED', { taskId, nodeId, planVersion });
  }

  taskOutcome(missionId: string, taskId: string, state: string, evidence: string[] = []): void {
    requireScope('TASK', taskId);
    this.append(missionId, 'TASK_OUTCOME', { taskId, state, evidence });
  }

  /**
   * Records a ratchet advance. The EVENT is the truth; the git ref is a
   * recoverable pointer at it, which is why this does not touch git.
   */
  checkpoint(missionId: string, sha: string, invariants: string[]): void {
    this.append(missionId, 'MISSION_CHECKPOINT', { sha, invariants });
  }

  /* ---- stage 2: the Oracle ---------------------------------------------- */

  /** Records a compiled contract. Compiling is not accepting. */
  recordOracle(missionId: string, oracle: Oracle, structuredHash: string,
    validation: unknown, providerUsage?: unknown): void {
    // Pre-execution spend is spend. The compiler, the critic and the planner
    // are real model calls made outside any task, so their cost reached no log
    // and a mission could report $0.00 after several of them. `missionUsage`
    // already sums providerUsage on ANY event; it simply had none to find.
    this.append(missionId, 'ORACLE_COMPILED', {
      ...(providerUsage ? { providerUsage } : {}),
      oracle, version: oracle.version, structuredHash,
      compilerProviderId: oracle.compilerProviderId,
      criterionCount: oracle.criteria.length, validation,
    });
  }

  /**
   * Records a compile the validation refused.
   *
   * The mission is unchanged and can simply be retried — but "unchanged" used
   * to mean "no trace", so a refusal was only visible to whoever was watching
   * the terminal at the time. The proposed criteria are recorded AS RECEIVED
   * (the redacting sink handles them like any other payload), because the
   * question a reader has is what the compiler actually said.
   */
  recordCompileRejected(missionId: string, spec: {
    findings: unknown[]; criteria: unknown[]; compilerProviderId: string;
    providerUsage?: unknown; structuredHash: string;
  }): void {
    this.append(missionId, 'ORACLE_COMPILE_REJECTED', {
      ...spec, criterionCount: Array.isArray(spec.criteria) ? spec.criteria.length : 0,
      retryable: true,
      detail: 'the compiled criteria did not validate; the mission is unchanged and can be recompiled',
    });
  }

  recordCritique(missionId: string, critique: {
    valid: boolean; findings: unknown[]; modeOpinion: string | null;
    promptHash: string; hashes: Record<string, string>; violations: unknown[];
    criticProviderId: string; reconciliation: unknown; providerUsage?: unknown;
  }): void {
    this.append(missionId, 'ORACLE_CRITIQUED', { ...critique });
  }

  /**
   * Accepts the contract, recording HOW consent was given.
   *
   * The mode and every input the mode function used are on the record, so the
   * decision can be re-derived later rather than taken on trust.
   */
  acceptOracle(missionId: string, spec: {
    acceptanceMode: AcceptanceMode;
    acceptedBy: 'auto' | 'user-confirmed' | 'default-policy';
    modeInputs: unknown; modeReasons: string[]; escalatedByCritic: boolean;
    escalatedByFindings?: boolean;
    /**
     * The findings that stood when this was accepted. Recorded so a later
     * report can say "accepted despite N findings, by human consent" instead
     * of showing an approval with no visible cost.
     */
    acceptedDespite?: Array<{ code: string; criterionId?: string }>;
    findingsFloor?: unknown;
  }): boolean {
    const rec = this.mission(missionId);
    if (!rec || !rec.oracle || rec.terminated) return false;
    this.append(missionId, 'ORACLE_ACCEPTED', { ...spec });
    return true;
  }

  /** A compile attempt that carried the previous critique back to the compiler. */
  recordRecompile(missionId: string, spec: {
    fromVersion: number; findingsForwarded: number; attempt: number; limit: number;
  }): void {
    this.append(missionId, 'ORACLE_RECOMPILED', { ...spec });
  }

  recordEvaluation(missionId: string, run: {
    oracleVersion: number; scope: string;
    results: Array<{ criterionId: string; outcome: string; evidence: string[]; detail: string }>;
    provenRequired: number; totalRequired: number;
  }): void {
    this.append(missionId, 'ORACLE_EVALUATED', { ...run, incremental: run.scope === 'incremental' });
  }

  /**
   * Refuses a change to what success MEANS.
   *
   * After acceptance a criterion's statement is immutable. Changing it is not
   * a repair, it is a different mission — or an exercise of authority Zeus
   * does not have. The attempt is recorded either way: a refused attempt to
   * move the goalposts is exactly the thing a later reader wants to see.
   */
  refuseSemanticsChange(missionId: string, criterionId: string, attempted: {
    field: string; from: string; to: string; reason?: string;
  }): { refused: true; code: 'ORACLE_SEMANTICS_IMMUTABLE' } {
    this.append(missionId, 'ORACLE_SEMANTICS_REFUSED', {
      code: 'ORACLE_SEMANTICS_IMMUTABLE', criterionId, ...attempted,
    });
    return { refused: true, code: 'ORACLE_SEMANTICS_IMMUTABLE' };
  }

  /**
   * Revises HOW a criterion is proven, never WHAT it claims.
   *
   * A rubric is treated as semantics-adjacent: it is what "passing" means for
   * an AI_JUDGED criterion, so loosening one is goalpost movement wearing an
   * evaluator-repair costume. Revising a rubric therefore needs explicit
   * consent, not merely a critique that approves of it.
   */
  reviseEvaluator(missionId: string, spec: {
    criterionId: string; oldEvaluator: Evaluator; newEvaluator: Evaluator;
    reason: string; criticVerdict: unknown; consent?: 'user-confirmed' | null;
  }): { ok: boolean; code?: 'RUBRIC_REVISION_REQUIRES_CONSENT'; invalidated: string[] } {
    const rec = this.mission(missionId);
    if (!rec || !rec.oracle) return { ok: false, invalidated: [] };
    const isRubric = spec.oldEvaluator?.kind === 'rubric' || spec.newEvaluator?.kind === 'rubric';
    if (isRubric && spec.consent !== 'user-confirmed') {
      this.append(missionId, 'ORACLE_SEMANTICS_REFUSED', {
        code: 'RUBRIC_REVISION_REQUIRES_CONSENT', criterionId: spec.criterionId,
        field: 'evaluator.rubric', reason: spec.reason,
        detail: 'a rubric is what passing means for this criterion; revising it needs consent',
      });
      return { ok: false, code: 'RUBRIC_REVISION_REQUIRES_CONSENT', invalidated: [] };
    }
    // Everything this evaluator previously "proved" is withdrawn: evidence
    // produced by a broken evaluator is not evidence.
    const invalidated = rec.criterionOutcomes[spec.criterionId] === 'PROVEN'
      ? [`outcome:${spec.criterionId}:PROVEN`] : [];
    this.append(missionId, 'EVALUATOR_REVISED', {
      criterionId: spec.criterionId, oldEvaluator: spec.oldEvaluator,
      newEvaluator: spec.newEvaluator, reason: spec.reason,
      criticVerdict: spec.criticVerdict, invalidatedEvidence: invalidated,
      consent: spec.consent ?? null,
    });
    return { ok: true, invalidated };
  }

  escalate(missionId: string, payload: Record<string, unknown>): void {
    this.append(missionId, 'MISSION_ESCALATED', payload);
  }

  /**
   * Terminates with both dimensions, independently.
   *
   * Absorbing, like a task's cancellation: a terminated mission stays
   * terminated, and a second call records nothing rather than rewriting the
   * verdict.
   */
  terminate(missionId: string, achievement: Achievement, terminationReason: TerminationReason): boolean {
    const rec = this.mission(missionId);
    if (!rec || rec.terminated) return false;
    this.append(missionId, 'MISSION_TERMINATED', { achievement, terminationReason });
    return true;
  }

  /**
   * Cancels the mission and every live task it spawned.
   *
   * The spawned tasks belong to a DIFFERENT process in the normal case, so the
   * on-disk run registry is what reaches them — the same path `zeus cancel`
   * uses. Cancellation is absorbing: the mission terminates CANCELLED and
   * nothing advances it afterwards.
   */
  cancel(missionId: string, reason: string): { cancelled: boolean; killed: number; tasks: string[] } {
    const rec = this.mission(missionId);
    if (!rec) return { cancelled: false, killed: 0, tasks: [] };
    if (rec.terminated) return { cancelled: false, killed: 0, tasks: [] };

    this.append(missionId, 'CANCEL_REQUESTED', { reason });

    let killed = 0;
    const tasks: string[] = [];
    for (const s of rec.spawned) {
      if (s.outcome) continue;                     // already terminal: nothing to kill
      tasks.push(s.taskId);
      if (this.stateRoot) {
        killed += killRecorded(this.stateRoot, { taskId: s.taskId }, reason).killed;
      }
      this.append(missionId, 'TASK_OUTCOME', { taskId: s.taskId, state: 'CANCELLED', evidence: [] });
    }
    this.append(missionId, 'MISSION_TERMINATED', {
      achievement: 'UNEVALUATED', terminationReason: 'CANCELLED', reason,
    });
    return { cancelled: true, killed, tasks };
  }

  /* ---- stage 3: the execution loop -------------------------------------- */

  /**
   * A plan the deterministic validator refused. Retryable, and recorded.
   *
   * The NODES are recorded, not just the findings. The oracle layer learned
   * this already — `ORACLE_COMPILE_REJECTED` carries the criteria it refused —
   * and the plan layer did not inherit it, so the first live planner rejection
   * could not be read back without paying a model to produce it again.
   */
  recordPlanRejected(missionId: string, spec: {
    version: number; nodes: unknown[]; findings: unknown[]; retryable: boolean; note?: string;
  }): void {
    this.append(missionId, 'PLAN_REJECTED', {
      version: spec.version, nodes: spec.nodes, nodeCount: spec.nodes.length,
      findings: spec.findings, retryable: spec.retryable, note: spec.note ?? null,
    });
  }

  /** What the plan critic said, whether or not anyone acted on it. */
  recordPlanCritique(missionId: string, spec: {
    version: number; findings: unknown[]; acceptance: string;
    contaminated: boolean; contaminationDetail?: string | null; providerUsage?: unknown;
  }): void {
    this.append(missionId, 'PLAN_CRITIQUED', {
      version: spec.version, findings: spec.findings, acceptance: spec.acceptance,
      contaminated: spec.contaminated, contaminationDetail: spec.contaminationDetail ?? null,
      ...(spec.providerUsage ? { providerUsage: spec.providerUsage } : {}),
    });
  }

  /**
   * Grants a plan the mandate `spawnNode` reads.
   *
   * Deliberately separate from `recordPlan`: recording a plan says one exists,
   * accepting it says execution may act on it. Collapsing the two would make
   * every proposal self-authorising.
   */
  acceptPlan(missionId: string, plan: PlanGraph, spec: {
    acceptedBy: string; acceptedDespite?: string[];
  }): void {
    this.append(missionId, 'PLAN_ACCEPTED', {
      version: plan.version, plan, nodes: plan.nodes.length,
      acceptedBy: spec.acceptedBy, acceptedDespite: spec.acceptedDespite ?? [],
    });
  }

  recordReplan(missionId: string, spec: {
    reason: string; detail: string; fromVersion: number | null;
  }): void {
    this.append(missionId, 'MISSION_REPLAN', {
      reason: spec.reason, detail: spec.detail, fromVersion: spec.fromVersion,
    });
  }

  /**
   * What integrating one node actually did.
   *
   * `dependents` is recorded here rather than looked up later because
   * enabling credit is settled against the plan that was live AT THE TIME:
   * a later replan must not retroactively grant or revoke credit.
   */
  recordIntegration(missionId: string, spec: {
    nodeId: string; taskId: string; planVersion: number; integrated: boolean;
    sha: string | null; provedCriteria: string[]; dependents: string[];
    invariantsBroken: string[]; reason: string;
  }): void {
    this.append(missionId, 'INTEGRATION_RESULT', { ...spec });
  }

  recordEffectMismatch(missionId: string, spec: {
    nodeId: string; planVersion: number; mismatches: unknown[];
  }): void {
    this.append(missionId, 'EFFECT_MISMATCH', {
      nodeId: spec.nodeId, planVersion: spec.planVersion,
      mismatches: spec.mismatches, count: spec.mismatches.length,
    });
  }

  /** An observed flip, plus whatever the attribution machinery made of it. */
  recordOscillation(missionId: string, spec: {
    criterionId: string; at: string; attribution: string; evidence: string[];
  }): void {
    this.append(missionId, 'OSCILLATION_DETECTED', { ...spec });
  }

  recordProgress(missionId: string, spec: {
    cycle: number; currency: string; nodeId: string | null;
    provenRequired: number; consecutiveNoProgress: number;
  }): void {
    this.append(missionId, 'MISSION_PROGRESS', { ...spec });
  }

  /**
   * What a human was SHOWN before deciding, and what they decided.
   *
   * Separate from PLAN_ACCEPTED's `acceptedDespite`, which records the
   * findings. This records the RENDERING — the text that was on screen — so a
   * later reader can tell what the decision was actually made against rather
   * than reconstructing it from a list of codes.
   */
  recordPlanStopDecision(missionId: string, spec: {
    version: number; rendered: string[]; decision: string;
    decidedBy: string; deferred?: boolean;
  }): void {
    this.append(missionId, 'PLAN_STOP_DECISION', {
      version: spec.version, rendered: spec.rendered, decision: spec.decision,
      decidedBy: spec.decidedBy, deferred: spec.deferred === true,
    });
  }

  /**
   * Raises (or lowers) one mission budget, deliberately and on the record.
   *
   * Budgets are recomputed from the log every cycle so a restart cannot reset
   * them. A revision therefore has to be an event, or the next recomputation
   * would quietly undo it.
   */
  reviseBudget(missionId: string, spec: {
    limit: string; from: number; to: number; reason: string; decidedBy: string;
  }): void {
    this.append(missionId, 'MISSION_BUDGET_REVISED', { ...spec });
  }

  /** A reconciliation between what the log says and what the world shows. */
  recordReconciliation(missionId: string, spec: {
    kind: string; expected: string; observed: string; resolution: string;
  }): void {
    this.append(missionId, 'MISSION_RECONCILIATION', { ...spec });
  }

  /**
   * PRINCIPLE A. The only door through which a mission spawns a task.
   *
   * The node is looked up in the plan THE LOG SAYS WAS ACCEPTED, never in the
   * graph object the caller is holding. Those two agree right up until the
   * moment it matters — a stale caller, a replan that landed underneath, a
   * node someone appended in memory — and in exactly those moments the log is
   * right and the object is wrong. This is the selection-ledger principle
   * moved up to the plan layer: a check that reads its own subject proves
   * nothing.
   */
  authoriseNode(missionId: string, nodeId: string): SpawnDecision {
    requireScope('MISSION', missionId);
    const rec = this.mission(missionId);
    if (!rec) return { ok: false, code: 'NO_SUCH_MISSION', message: `no mission ${missionId}` };
    if (rec.terminated) {
      return { ok: false, code: 'MISSION_TERMINATED',
        message: `mission ${missionId} terminated (${rec.terminationReason ?? 'unstated'})` };
    }
    const plan = rec.acceptedPlan;
    if (!plan || rec.acceptedPlanVersion === null) {
      return { ok: false, code: 'PLAN_NOT_ACCEPTED',
        message: `mission ${missionId} has no accepted plan in its log; nothing may be spawned` };
    }
    const node = plan.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      return { ok: false, code: 'PLAN_NODE_NOT_ACCEPTED',
        message: `node "${nodeId}" is not in the accepted plan (v${rec.acceptedPlanVersion}) `
          + `for ${missionId}; accepted nodes are ${plan.nodes.map((n) => n.nodeId).join(', ') || '(none)'}` };
    }
    return { ok: true, planVersion: rec.acceptedPlanVersion, node };
  }

  spawnNode(missionId: string, taskId: string, nodeId: string, opts: {
    repair?: boolean; reason?: string;
  } = {}): SpawnDecision {
    requireScope('TASK', taskId);
    // Re-asked here, not inherited from an earlier call. The gap between
    // authorising a node and recording its spawn is exactly where a replan
    // lands, and a decision cached across that gap authorises the past.
    const decision = this.authoriseNode(missionId, nodeId);
    if (!decision.ok) return decision;
    const rec = this.mission(missionId)!;
    if (rec.spawned.some((sp) => sp.taskId === taskId)) {
      return { ok: false, code: 'TASK_ALREADY_SPAWNED', message: `task ${taskId} is already recorded` };
    }
    this.append(missionId, 'TASK_SPAWNED', {
      taskId, nodeId, planVersion: decision.planVersion,
      repair: opts.repair === true, reason: opts.reason ?? null,
    });
    return decision;
  }
}

export type SpawnRefusalCode =
  | 'NO_SUCH_MISSION' | 'MISSION_TERMINATED' | 'PLAN_NOT_ACCEPTED'
  | 'PLAN_NODE_NOT_ACCEPTED' | 'TASK_ALREADY_SPAWNED';

export type SpawnDecision =
  | { ok: true; planVersion: number; node: TaskNode }
  | { ok: false; code: SpawnRefusalCode; message: string };
