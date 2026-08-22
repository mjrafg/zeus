/**
 * Whether a mission is getting anywhere, and what it costs.
 *
 * Everything here is a pure function over the EVENT LOG. That is principle A:
 * an enforcement boundary that reads the object it is meant to constrain has
 * not constrained anything. Budgets, progress, oscillation and effect
 * verification are all derived from what was recorded, so a restart cannot
 * reset them and an in-memory mistake cannot loosen them.
 */

import { StoredEvent } from '../engine/events';
import { Achievement, PredictedEffect, TaskNode } from './types';

/* ------------------------------------------------------------------------ *
 * Mission budgets
 * ------------------------------------------------------------------------ */

export interface MissionBudgets {
  maxTasks: number;
  maxReplans: number;
  maxRepairs: number;
  /**
   * How many times Zeus may replan BY ITSELF after a plan is rejected.
   *
   * A bound on autonomy, not on planning. A person who reads the findings and
   * asks for another attempt is not the thing this exists to stop — what it
   * stops is a machine burning the budget on rounds nobody asked for. Human
   * replans are counted separately and are limited by the mission's cost, time
   * and safety budgets like any other spend.
   */
  maxPlanRecompiles: number;
  wallClockSeconds: number;
  /** Provider-reported spend ceiling. Never estimated; see `unmeteredCalls`. */
  costCeilingUsd: number;
  /** Fraction of each budget held back for repairs and replans. */
  reserveFraction: number;
  maxNoProgressCycles: number;
}

export const DEFAULT_MISSION_BUDGETS: MissionBudgets = {
  maxTasks: 20,
  maxReplans: 2,
  maxRepairs: 5,
  maxPlanRecompiles: 3,
  wallClockSeconds: 6 * 60 * 60,
  costCeilingUsd: 5,
  reserveFraction: 0.4,
  maxNoProgressCycles: 3,
};

export function mergeMissionBudgets(over: Partial<MissionBudgets> = {}): MissionBudgets {
  return { ...DEFAULT_MISSION_BUDGETS, ...over };
}

/**
 * Budget revisions, replayed from the log in order.
 *
 * A raise is an event, not a flag and not a field someone edited: budgets are
 * recomputed from the log on every cycle precisely so a restart cannot reset
 * them, and a revision that lived anywhere else would be undone by the same
 * mechanism that makes the rest of the budget trustworthy.
 */
export function applyBudgetRevisions(base: MissionBudgets, events: StoredEvent[]): MissionBudgets {
  let out = { ...base };
  for (const e of events) {
    if (e.type !== 'MISSION_BUDGET_REVISED') continue;
    const p = (e.payload ?? {}) as any;
    const limit = String(p.limit ?? '') as keyof MissionBudgets;
    const to = p.to;
    if (!(limit in out) || typeof to !== 'number' || !Number.isFinite(to)) continue;
    out = { ...out, [limit]: to };
  }
  return out;
}

/** The planned/reserve split. Planned work may not touch the reserve. */
export function plannedAllowance(b: MissionBudgets): number {
  return Math.max(1, Math.floor(b.maxTasks * (1 - b.reserveFraction)));
}

export interface MissionUsage {
  tasksSpawned: number;
  plannedTasks: number;
  replans: number;
  repairs: number;
  planRecompiles: number;
  /** Of those, the ones Zeus started on its own. The bounded kind. */
  autoPlanRecompiles: number;
  elapsedSeconds: number;
  /** Summed from providerUsage. Provider-reported only. */
  costUsd: number;
  /**
   * Provider calls that reported no cost at all.
   *
   * Reported as unmetered rather than folded into the total as zero: a call
   * whose price nobody stated is not a free call, and treating it as one lets
   * a ceiling be passed in silence.
   */
  unmeteredCalls: number;
  /** Reserve draws, each with the reason it was taken. */
  reserveDraws: Array<{ kind: string; reason: string }>;
}

/**
 * Reads provider cost out of a TASK's log.
 *
 * Cost is reported by the provider to the task that invoked it, so it lands on
 * the task's events and never on the mission's. The mission is what holds the
 * budget, so without this the USD ceiling was structurally unreachable: a
 * mission could spend without limit and report $0.00, which the first live run
 * demonstrated at $0.635 for a single agent call.
 */
export function providerSpendOf(taskEvents: StoredEvent[]): { costUsd: number; unmetered: number } {
  let costUsd = 0;
  let unmetered = 0;
  for (const e of taskEvents) {
    const usage = (e.payload as any)?.providerUsage as { totalCostUsd?: unknown } | undefined;
    if (!usage || typeof usage !== 'object') continue;
    if (typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd)) {
      costUsd += usage.totalCostUsd;
    } else unmetered += 1;
  }
  return { costUsd: Number(costUsd.toFixed(6)), unmetered };
}

/**
 * Everything the loop has spent, recomputed from the log on every cycle.
 *
 * `spendOf` reaches into each spawned task's own log for provider cost. It is
 * injected rather than assumed so this stays a pure function over events, and
 * so a caller with no store still gets every other budget.
 */
export function missionUsage(events: StoredEvent[], now = Date.now(),
  spendOf?: (taskId: string) => { costUsd: number; unmetered: number }): MissionUsage {
  let tasksSpawned = 0, plannedTasks = 0, replans = 0, repairs = 0, planRecompiles = 0;
  let autoPlanRecompiles = 0;
  // Which attempt produced each plan version, so a rejection can be charged to
  // whoever asked for it. An attempt recorded before triggers existed counts as
  // autonomous: the conservative reading, so nothing silently gains unlimited
  // retries by being old.
  const triggerOf = new Map<number, string>();
  let costUsd = 0, unmeteredCalls = 0;
  const reserveDraws: Array<{ kind: string; reason: string }> = [];
  let startedAt: number | null = null;

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, any>;
    if (startedAt === null) startedAt = Date.parse(e.ts) || null;
    switch (e.type) {
      case 'TASK_SPAWNED': {
        tasksSpawned += 1;
        // The task's own log is where the provider reported what it charged.
        const spend = spendOf && typeof p.taskId === 'string' ? spendOf(p.taskId) : null;
        if (spend) { costUsd += spend.costUsd; unmeteredCalls += spend.unmetered; }
        if (p.repair === true) {
          repairs += 1;
          reserveDraws.push({ kind: 'repair', reason: String(p.reason ?? 'unstated') });
        } else plannedTasks += 1;
        break;
      }
      case 'MISSION_REPLAN':
        replans += 1;
        reserveDraws.push({ kind: 'replan', reason: String(p.reason ?? 'unstated') });
        break;
      case 'PLAN_RECORDED':
        triggerOf.set(Number(p.version), String(p.trigger ?? 'AUTO'));
        break;
      case 'PLAN_REJECTED': {
        // A plan the validator refused: the planner has to be called again.
        planRecompiles += 1;
        const who = String(p.trigger ?? triggerOf.get(Number(p.version)) ?? 'AUTO');
        if (who === 'AUTO') autoPlanRecompiles += 1;
        break;
      }
      case 'PLAN_CRITIQUED':
        // A critique that rejected the plan costs another planner call too.
        // A critique that merely raised advisory findings does not.
        if (p.acceptance === 'REJECT') {
          planRecompiles += 1;
          if ((triggerOf.get(Number(p.version)) ?? 'AUTO') === 'AUTO') autoPlanRecompiles += 1;
        }
        break;
      default: break;
    }
    const usage = p.providerUsage as { totalCostUsd?: unknown } | undefined;
    if (usage && typeof usage === 'object') {
      if (typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd)) {
        costUsd += usage.totalCostUsd;
      } else unmeteredCalls += 1;
    }
  }
  return {
    tasksSpawned, plannedTasks, replans, repairs, planRecompiles, autoPlanRecompiles,
    elapsedSeconds: startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0,
    costUsd: Number(costUsd.toFixed(6)), unmeteredCalls, reserveDraws,
  };
}

export interface MissionBreach { limit: keyof MissionBudgets; detail: string }

/**
 * Whether Zeus has used up its own replanning.
 *
 * NOT part of checkMissionBudgets, deliberately. That function is consulted
 * before every operation, including the ones a person asked for — so putting
 * the autonomy bound in it made the HUMAN the thing being rate-limited, and a
 * mission that had exhausted its automatic attempts refused the operator who
 * had just read the findings and asked for one more.
 *
 * This bounds a cascade. Cost, time and the safety guards bound the mission.
 */
export function autoReplansExhausted(b: MissionBudgets, u: MissionUsage):
{ used: number; limit: number; exhausted: boolean } {
  return {
    used: u.autoPlanRecompiles,
    limit: b.maxPlanRecompiles,
    exhausted: u.autoPlanRecompiles >= b.maxPlanRecompiles,
  };
}

export function checkMissionBudgets(b: MissionBudgets, u: MissionUsage): MissionBreach | null {
  if (u.tasksSpawned >= b.maxTasks) {
    return { limit: 'maxTasks', detail: `${u.tasksSpawned} task(s) spawned, limit ${b.maxTasks}` };
  }
  if (u.replans >= b.maxReplans) {
    return { limit: 'maxReplans', detail: `${u.replans} replan(s), limit ${b.maxReplans}` };
  }
  if (u.repairs >= b.maxRepairs) {
    return { limit: 'maxRepairs', detail: `${u.repairs} repair attempt(s), limit ${b.maxRepairs}` };
  }
  if (u.elapsedSeconds >= b.wallClockSeconds) {
    return { limit: 'wallClockSeconds', detail: `${u.elapsedSeconds}s elapsed, limit ${b.wallClockSeconds}s` };
  }
  if (u.costUsd >= b.costCeilingUsd) {
    return {
      limit: 'costCeilingUsd',
      detail: `$${u.costUsd.toFixed(4)} of provider-reported spend, limit $${b.costCeilingUsd.toFixed(2)}`
        + (u.unmeteredCalls ? ` (plus ${u.unmeteredCalls} call(s) that reported no cost)` : ''),
    };
  }
  return null;
}

/** Planned work is refused once it would eat the repair/replan reserve. */
export function plannedExhausted(b: MissionBudgets, u: MissionUsage): boolean {
  return u.plannedTasks >= plannedAllowance(b);
}

/**
 * Principle B, at the one place a mission's verdict is written.
 *
 * A terminating caller may record an achievement equal to or WORSE than what
 * the criteria derive. Nobody ends a mission by claiming more than the
 * evidence supports — including a caller that means well and is simply wrong.
 */
const ACHIEVEMENT_RANK: Record<Achievement, number> =
  { ACHIEVED: 3, PARTIAL: 2, NONE: 1, UNEVALUATED: 0 } as Record<Achievement, number>;

export function clampAchievement(claimed: Achievement, derived: Achievement):
  { achievement: Achievement; downgraded: boolean; reason: string | null } {
  if (claimed === derived) return { achievement: claimed, downgraded: false, reason: null };
  // UNEVALUATED is not "worst", it is "nobody knows". A caller may always fall
  // back to it, and may never climb out of it on its own say-so.
  if (claimed === 'UNEVALUATED') {
    return { achievement: 'UNEVALUATED', downgraded: true, reason: 'the caller declined to claim anything' };
  }
  if (derived === 'UNEVALUATED') {
    return {
      achievement: 'UNEVALUATED', downgraded: true,
      reason: `claimed ${claimed}, but no required criterion was ever successfully evaluated`,
    };
  }
  if (ACHIEVEMENT_RANK[claimed] > ACHIEVEMENT_RANK[derived]) {
    return { achievement: derived, downgraded: true, reason: `claimed ${claimed}, the criteria derive ${derived}` };
  }
  return { achievement: claimed, downgraded: false, reason: null };
}

/* ------------------------------------------------------------------------ *
 * Budget negotiation, at plan time
 * ------------------------------------------------------------------------ */

export interface BudgetNegotiation {
  fits: boolean;
  nodeCount: number;
  /** Nodes plus one repair's headroom, which the reserve exists to fund. */
  tasksNeeded: number;
  maxTasks: number;
  /**
   * The planner's own summed estimate, in the dollars the prompt asks for.
   * Null when no node offered one — an absent estimate is not a zero estimate,
   * and a cost stop on invented numbers would be worse than no stop.
   */
  estimatedCostUsd: number | null;
  costCeilingUsd: number;
  reasons: string[];
  rendered: string;
}

/**
 * Whether the plan the planner produced can be paid for.
 *
 * Asked BEFORE acceptance, because the alternative is what already happened
 * once: a budget sized for a small repository, a goal that genuinely needed
 * more nodes, and a mission that died at task five having spent the money to
 * get there. A plan that does not fit is a conversation, not a failure — the
 * budget may be the wrong size, or the plan may be, and only a person can say
 * which.
 */
export function negotiateBudget(nodes: Array<{ estimatedCost?: number }>,
  budgets: MissionBudgets): BudgetNegotiation {
  const nodeCount = nodes.length;
  const tasksNeeded = nodeCount + 1;                  // one repair, from reserve
  const reasons: string[] = [];

  const estimates = nodes
    .map((n) => n.estimatedCost)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
  const estimatedCostUsd = estimates.length
    ? Number(estimates.reduce((a, b) => a + b, 0).toFixed(2))
    : null;

  if (tasksNeeded > budgets.maxTasks) {
    reasons.push(`this plan needs ${nodeCount} task(s) plus one repair = ${tasksNeeded}, `
      + `and the budget is ${budgets.maxTasks}`);
  }
  if (estimatedCostUsd !== null && estimatedCostUsd > budgets.costCeilingUsd) {
    reasons.push(`the planner ESTIMATES ~$${estimatedCostUsd.toFixed(2)} across ${estimates.length} `
      + `node(s), and the ceiling is $${budgets.costCeilingUsd.toFixed(2)}`);
  }

  const fits = reasons.length === 0;
  const rendered = fits
    ? `${nodeCount} task(s) within a budget of ${budgets.maxTasks}`
      + (estimatedCostUsd === null
        ? '; the planner gave no cost estimate'
        : `; estimated ~$${estimatedCostUsd.toFixed(2)} of a $${budgets.costCeilingUsd.toFixed(2)} ceiling`)
    : `${reasons.join('; ')}. Options: raise the budget for this mission, `
      + 'ask the planner to re-scope smaller, or abort.';

  return { fits, nodeCount, tasksNeeded, maxTasks: budgets.maxTasks,
    estimatedCostUsd, costCeilingUsd: budgets.costCeilingUsd, reasons, rendered };
}

/* ------------------------------------------------------------------------ *
 * Effect verification
 * ------------------------------------------------------------------------ */

export interface ObservedEvidence {
  /** Check name to the outcome actually recorded for it. */
  checks: Record<string, string>;
  /** Paths observed to exist (or not) in the worktree after integration. */
  artifacts: Record<string, boolean>;
  /** Deterministically re-probed state facts. */
  facts: Record<string, string>;
}

export interface EffectMismatch {
  nodeId: string;
  predicted: PredictedEffect;
  observed: string;
  evidence: string[];
}

/**
 * Compares what a node PREDICTED against what was OBSERVED.
 *
 * Never against what the agent said it did. An agent's report of its own work
 * is the one piece of evidence that cannot be independent of the work, which
 * is why every comparison here reads recorded outcomes and the filesystem.
 */
export function verifyEffects(node: TaskNode, observed: ObservedEvidence): EffectMismatch[] {
  const out: EffectMismatch[] = [];
  for (const eff of node.predictedEffects ?? []) {
    if (eff.kind === 'expectedCheckTransition') {
      const actual = observed.checks[eff.check];
      if (actual === undefined) {
        out.push({
          nodeId: node.nodeId, predicted: eff,
          observed: 'the check was never run after this node',
          evidence: [`check:${eff.check}:absent`],
        });
      } else if (actual !== eff.to) {
        out.push({ nodeId: node.nodeId, predicted: eff, observed: actual, evidence: [`check:${eff.check}:${actual}`] });
      }
    } else if (eff.kind === 'expectedArtifact') {
      const exists = observed.artifacts[eff.path];
      if (exists !== eff.exists) {
        out.push({
          nodeId: node.nodeId, predicted: eff,
          observed: exists === undefined ? 'not looked for' : `exists=${exists}`,
          evidence: [`artifact:${eff.path}:${String(exists)}`],
        });
      }
    } else {
      const actual = observed.facts[eff.fact];
      if (actual !== eff.value) {
        out.push({
          nodeId: node.nodeId, predicted: eff,
          observed: actual === undefined ? 'not probed' : actual,
          evidence: [`fact:${eff.fact}:${String(actual)}`],
        });
      }
    }
  }
  return out;
}

export const EFFECT_MODEL_WRONG_THRESHOLD = 3;

/** Mismatches recorded against one plan version, counted from the log. */
export function mismatchesForVersion(events: StoredEvent[], planVersion: number): number {
  return events.filter((e) => e.type === 'EFFECT_MISMATCH'
    && (e.payload as any)?.planVersion === planVersion).length;
}

/* ------------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------------ */

export const MAX_CONSECUTIVE_ENABLING = 2;

export interface ProgressScore {
  provenRequired: number;
  /** Nodes that earned enabling credit, in order. */
  enablingCredits: string[];
  consecutiveEnabling: number;
  consecutiveNoProgress: number;
  history: Array<{ nodeId: string; currency: 'proven' | 'enabling' | 'none'; at: string }>;
}

/**
 * Progress in exactly two currencies, both earned rather than assumed.
 *
 * A node that proves a required criterion has plainly moved the mission. A
 * node that proves nothing may still have been necessary — but "necessary" is
 * a claim, and the claim is only honoured once a DEPENDENT NODE IS ACTUALLY
 * SPAWNED afterwards. Otherwise "this unblocks future work" becomes a way to
 * make no progress indefinitely while reporting progress.
 *
 * Capped at two consecutive enabling credits: three integrations in a row that
 * proved nothing is a mission going nowhere, whatever it unblocked.
 */
export function progressFrom(events: StoredEvent[]): ProgressScore {
  const provenNow = new Set<string>();
  const history: ProgressScore['history'] = [];
  const enablingCredits: string[] = [];
  let consecutiveEnabling = 0;
  let consecutiveNoProgress = 0;

  // Spawn order, so enabling credit is settled by what actually happened next
  // rather than by what the plan intended to happen next.
  const spawnOrder: string[] = [];
  for (const e of events) {
    if (e.type === 'TASK_SPAWNED') spawnOrder.push(String((e.payload as any)?.nodeId ?? ''));
  }

  for (const e of events) {
    const p = (e.payload ?? {}) as any;
    if (e.type === 'ORACLE_EVALUATED') {
      for (const r of (p.results ?? []) as Array<any>) {
        if (r?.outcome === 'PROVEN') provenNow.add(String(r.criterionId));
        else provenNow.delete(String(r.criterionId));
      }
      continue;
    }
    if (e.type !== 'INTEGRATION_RESULT') continue;
    const nodeId = String(p.nodeId ?? '');
    const proved: string[] = Array.isArray(p.provedCriteria) ? p.provedCriteria : [];
    const dependents: string[] = Array.isArray(p.dependents) ? p.dependents : [];
    const spawnedAfter = spawnOrder.slice(spawnOrder.lastIndexOf(nodeId) + 1);
    const enabled = dependents.some((d) => spawnedAfter.includes(d));

    if (proved.length) {
      history.push({ nodeId, currency: 'proven', at: e.ts });
      consecutiveEnabling = 0; consecutiveNoProgress = 0;
    } else if (enabled && consecutiveEnabling < MAX_CONSECUTIVE_ENABLING) {
      history.push({ nodeId, currency: 'enabling', at: e.ts });
      enablingCredits.push(nodeId);
      consecutiveEnabling += 1; consecutiveNoProgress = 0;
    } else {
      history.push({ nodeId, currency: 'none', at: e.ts });
      consecutiveNoProgress += 1;
    }
  }
  return { provenRequired: provenNow.size, enablingCredits, consecutiveEnabling, consecutiveNoProgress, history };
}

/* ------------------------------------------------------------------------ *
 * Oscillation
 * ------------------------------------------------------------------------ */

export interface Flip { criterionId: string; from: string; to: string; at: string }

/**
 * A criterion that was PROVEN and is no longer.
 *
 * An OBSERVATION, never a diagnosis. Whether it is a genuine regression or a
 * flaky test is a question for the existing attribution machinery, which
 * retries deterministically; answering it here would be guessing in an
 * authoritative voice.
 */
export function detectFlips(events: StoredEvent[]): Flip[] {
  const last: Record<string, string> = {};
  const flips: Flip[] = [];
  for (const e of events) {
    if (e.type !== 'ORACLE_EVALUATED') continue;
    for (const r of ((e.payload as any)?.results ?? []) as Array<any>) {
      const id = String(r?.criterionId ?? '');
      const outcome = String(r?.outcome ?? '');
      if (!id || !outcome) continue;
      if (last[id] === 'PROVEN' && outcome === 'FAILED') {
        flips.push({ criterionId: id, from: 'PROVEN', to: outcome, at: e.ts });
      }
      last[id] = outcome;
    }
  }
  return flips;
}

/**
 * Flips the attribution machinery did NOT put down to a flaky test.
 *
 * Anything inconclusive stays on this list: the safe direction is to believe a
 * regression happened, because a regression wrongly dismissed as flake is a
 * mission that ships broken work.
 */
export function genuineFlips(events: StoredEvent[]): Flip[] {
  const flakes = new Set<string>();
  for (const e of events) {
    if (e.type !== 'OSCILLATION_DETECTED') continue;
    const p = (e.payload ?? {}) as any;
    if (p.attribution === 'SUSPECTED_FLAKE' && p.criterionId) flakes.add(`${p.criterionId}@${p.at ?? ''}`);
  }
  return detectFlips(events).filter((f) => !flakes.has(`${f.criterionId}@${f.at}`));
}
