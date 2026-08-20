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
  Achievement, MissionCheckpoint, MissionRecord, PlanGraph, SpawnedTask,
  TerminationReason, makeMissionId, requireScope,
} from './types';

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
    spawned: [],
    checkpoints: [],
    ratchetSha: null,
    cancelRequested: false,
    escalations: 0,
    terminated: false,
    achievement: 'UNEVALUATED',
    terminationReason: null,
    events: evs.length,
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
      case 'PLAN_INVALIDATED': {
        rec.planInvalidations.push({ reason: str(p.reason, 'unstated'), supersededBy: num(p.supersededBy) });
        // The plan is gone until a new one is recorded; the version is not,
        // because "which version was invalidated" is part of the history.
        rec.plan = null;
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

  recordPlan(missionId: string, plan: PlanGraph): void {
    this.append(missionId, 'PLAN_RECORDED', { version: plan.version, plan, nodes: plan.nodes.length });
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
}
