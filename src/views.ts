/**
 * The shapes the CLI's `--json` paths emit, extracted so a second caller
 * cannot invent a second shape.
 *
 * The web is a CLIENT of the engine, and the cheapest way for that claim to
 * quietly stop being true is for the HTTP layer to build its own view of a
 * mission "just for the UI". Two serializers drift, and the one that drifts
 * silently is the one a human is looking at. So both callers come here.
 *
 * Everything below is a projection of the EVENT LOG. Nothing consults an
 * in-memory object a caller could have influenced.
 */

import * as path from 'path';
import { MissionRegistry } from './mission/registry';
import { MissionRecord } from './mission/types';
import { Oracle } from './mission/oracle';
import { missionUsage, progressFrom, providerSpendOf, MissionUsage, ProgressScore } from './mission/progress';
import { ratchetRef, readRatchet } from './mission/ratchet';
import { StoredEvent } from './engine/events';

/** Provider cost lives on the spawned task's log, not the mission's. */
export function spendReader(missions: MissionRegistry) {
  return (taskId: string) => {
    try { return providerSpendOf(missions.events.read(taskId)); }
    catch { return { costUsd: 0, unmetered: 0 }; }
  };
}

export interface MissionStatusView extends MissionRecord {
  ratchetRef: string;
  ratchetRefSha: string | null;
}

/** Exactly what `zeus mission status --json` prints. */
export function missionStatusView(missions: MissionRegistry, root: string,
  missionId: string): MissionStatusView | null {
  const rec = missions.mission(missionId);
  if (!rec) return null;
  return { ...rec, ratchetRef: ratchetRef(missionId), ratchetRefSha: readRatchet(root, missionId) };
}

/** Exactly what `zeus mission list --json` prints. */
export function missionListView(missions: MissionRegistry): MissionRecord[] {
  return missions.list().map((id) => missions.mission(id))
    .filter((r): r is MissionRecord => !!r);
}

export interface MissionReportView {
  mission: MissionRecord;
  usage: MissionUsage;
  score: ProgressScore;
  integrations: unknown[];
  mismatches: unknown[];
  flips: unknown[];
  replans: unknown[];
  escalations: unknown[];
}

/** Exactly what `zeus mission report --json` prints. */
export function missionReportView(missions: MissionRegistry,
  missionId: string, now = Date.now()): MissionReportView | null {
  const rec = missions.mission(missionId);
  if (!rec) return null;
  const log = missions.events.read(missionId);
  const of = (t: string) => log.filter((e) => e.type === t).map((e) => e.payload as unknown);
  return {
    mission: rec,
    usage: missionUsage(log, now, spendReader(missions)),
    score: progressFrom(log),
    integrations: of('INTEGRATION_RESULT'),
    mismatches: of('EFFECT_MISMATCH'),
    flips: of('OSCILLATION_DETECTED'),
    replans: of('MISSION_REPLAN'),
    escalations: of('MISSION_ESCALATED'),
  };
}

/**
 * The phase a mission is in, derived from its log.
 *
 * A rendering convenience with no authority: nothing branches on it, and the
 * per-criterion outcomes and terminal fields remain the truth. It exists so a
 * live view can say "Critic" instead of making the reader infer it.
 */
export type MissionPhase =
  | 'CREATED' | 'ORACLE' | 'CONSENT' | 'PLANNING' | 'PLAN_CONSENT'
  | 'RUNNING' | 'INTEGRATING' | 'EVALUATING' | 'TERMINATED';

export function missionPhase(events: StoredEvent[]): MissionPhase {
  let phase: MissionPhase = 'CREATED';
  for (const e of events) {
    switch (e.type) {
      case 'ORACLE_COMPILED': case 'ORACLE_RECOMPILED': phase = 'ORACLE'; break;
      case 'ORACLE_CRITIQUED': phase = 'CONSENT'; break;
      case 'ORACLE_ACCEPTED': phase = 'PLANNING'; break;
      case 'PLAN_RECORDED': case 'PLAN_REJECTED': phase = 'PLANNING'; break;
      case 'PLAN_CRITIQUED': phase = 'PLAN_CONSENT'; break;
      case 'PLAN_ACCEPTED': phase = 'RUNNING'; break;
      case 'TASK_SPAWNED': phase = 'RUNNING'; break;
      case 'INTEGRATION_RESULT': phase = 'INTEGRATING'; break;
      case 'ORACLE_EVALUATED': phase = 'EVALUATING'; break;
      case 'MISSION_TERMINATED': phase = 'TERMINATED'; break;
      default: break;
    }
  }
  return phase;
}

/**
 * Spend, broken down by the phase that incurred it.
 *
 * Reads providerUsage wherever it was recorded — the mission's own events for
 * pre-execution calls, and each spawned task's log for execution. Unpriced
 * calls stay counted as unmetered, never folded in as zero.
 */
export interface CostBreakdown {
  byPhase: Record<string, number>;
  totalUsd: number;
  unmeteredCalls: number;
  /** True when at least one call reported no price, so the total is a floor. */
  isLowerBound: boolean;
}

const PHASE_OF: Record<string, string> = {
  ORACLE_COMPILED: 'oracle', ORACLE_RECOMPILED: 'oracle', ORACLE_CRITIQUED: 'critic',
  PLAN_RECORDED: 'planner', PLAN_CRITIQUED: 'plan-critic',
};

export function costBreakdown(missions: MissionRegistry, missionId: string): CostBreakdown {
  const byPhase: Record<string, number> = {};
  let unmeteredCalls = 0;
  const add = (phase: string, e: StoredEvent) => {
    const u = (e.payload as any)?.providerUsage as { totalCostUsd?: unknown } | undefined;
    if (!u || typeof u !== 'object') return;
    if (typeof u.totalCostUsd === 'number' && Number.isFinite(u.totalCostUsd)) {
      byPhase[phase] = Number(((byPhase[phase] ?? 0) + u.totalCostUsd).toFixed(6));
    } else unmeteredCalls += 1;
  };

  const log = missions.events.read(missionId);
  for (const e of log) add(PHASE_OF[e.type] ?? 'other', e);
  for (const e of log) {
    if (e.type !== 'TASK_SPAWNED') continue;
    const taskId = (e.payload as any)?.taskId;
    if (typeof taskId !== 'string') continue;
    try { for (const te of missions.events.read(taskId)) add('execution', te); }
    catch { /* a task whose log is unreadable contributes nothing, and says so via unmetered */ }
  }
  const totalUsd = Number(Object.values(byPhase).reduce((a, b) => a + b, 0).toFixed(6));
  return { byPhase, totalUsd, unmeteredCalls, isLowerBound: unmeteredCalls > 0 };
}

/** The oracle a mission accepted, or null. Read from the record, not a cache. */
export function oracleOf(rec: MissionRecord): Oracle | null {
  const o = rec.oracle as Oracle | null;
  return o && Array.isArray(o.criteria) ? o : null;
}

/** Where a mission's diff line runs from, for the read-only diff route. */
export function integrationLine(rec: MissionRecord): { from: string; to: string } {
  return { from: rec.baseSha, to: rec.ratchetSha ?? rec.baseSha };
}

export { path };
