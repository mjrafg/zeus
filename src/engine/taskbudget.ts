/**
 * Task-level budgets.
 *
 * Bounding each command is not enough: a task that keeps making small,
 * successful calls can run for hours and cost real money while never tripping
 * a per-command limit. These ceilings apply to the task as a whole and are
 * recomputed from the event log, so they survive a process restart — a budget
 * that resets when the orchestrator does is not a budget.
 *
 * Waiting is not working: queue time is tracked separately and never counts
 * against the active-execution budget, or a busy machine would look like a
 * runaway task.
 */

import { StoredEvent } from './events';

export interface TaskBudgets {
  maxTaskWallClockMs: number;
  maxAgentInvocations: number;
  maxDesignAttempts: number;
  maxReviewCycles: number;
  maxRepairCycles: number;
  /** Total time spent inside provider calls, excluding queue wait. */
  maxProviderWallClockMs: number;
  /**
   * Only enforced when the provider actually reports a cost. No token pricing
   * is invented here: an unmeasured cost is reported as unknown, not guessed.
   */
  maxEstimatedCostUsd: number | null;
}

export const DEFAULT_TASK_BUDGETS: TaskBudgets = {
  maxTaskWallClockMs: 2 * 60 * 60_000,
  maxAgentInvocations: 40,
  maxDesignAttempts: 3,
  maxReviewCycles: 5,
  maxRepairCycles: 5,
  maxProviderWallClockMs: 45 * 60_000,
  maxEstimatedCostUsd: null,
};

export interface BudgetUsage {
  taskWallClockMs: number;
  activeExecutionMs: number;
  queueWaitMs: number;
  agentInvocations: number;
  designAttempts: number;
  reviewCycles: number;
  repairCycles: number;
  providerWallClockMs: number;
  /** Null when no provider reported a cost — never estimated. */
  estimatedCostUsd: number | null;
  costMeasured: boolean;
}

export interface BudgetBreach {
  budget: keyof TaskBudgets;
  limit: number;
  observed: number;
  detail: string;
}

/** Recomputes usage from the log, so restarts cannot reset a budget. */
export function usageFrom(events: StoredEvent[], now = Date.now()): BudgetUsage {
  let agentInvocations = 0, designAttempts = 0, reviewCycles = 0, repairCycles = 0;
  let providerWallClockMs = 0, activeExecutionMs = 0, queueWaitMs = 0;
  let cost = 0, costMeasured = false;

  for (const e of events) {
    const p = e.payload as any;
    if (e.type === 'AGENT_STARTED') {
      agentInvocations += 1;
      if (p.role === 'planner') designAttempts += 1;
      if (p.role === 'reviewer') reviewCycles += 1;
    }
    if (e.type === 'AGENT_FINISHED' || e.type === 'AGENT_FAILED') {
      providerWallClockMs += Number(p.durationMs) || 0;
      // Cost only counts when the provider actually reported one.
      const c = Number(p.costUsd);
      if (Number.isFinite(c) && c > 0) { cost += c; costMeasured = true; }
    }
    if (e.type === 'CHECK_RESULT') {
      activeExecutionMs += Number(p.durationMs) || 0;
      queueWaitMs += Number(p.queueWaitMs) || 0;
    }
    if (e.type === 'STATE_CHANGED' && p.to === 'FIX') repairCycles += 1;
  }
  const first = events[0] ? Date.parse(events[0].ts) : now;
  return {
    taskWallClockMs: now - first,
    activeExecutionMs: activeExecutionMs + providerWallClockMs,
    queueWaitMs,
    agentInvocations, designAttempts, reviewCycles, repairCycles, providerWallClockMs,
    estimatedCostUsd: costMeasured ? Number(cost.toFixed(4)) : null,
    costMeasured,
  };
}

/** The first ceiling this task has crossed, or null. */
export function checkBudgets(budgets: TaskBudgets, usage: BudgetUsage): BudgetBreach | null {
  const tests: Array<[keyof TaskBudgets, number, number, string]> = [
    ['maxTaskWallClockMs', budgets.maxTaskWallClockMs, usage.taskWallClockMs, 'total elapsed time since the task was created'],
    ['maxAgentInvocations', budgets.maxAgentInvocations, usage.agentInvocations, 'agent invocations'],
    ['maxDesignAttempts', budgets.maxDesignAttempts, usage.designAttempts, 'design attempts'],
    ['maxReviewCycles', budgets.maxReviewCycles, usage.reviewCycles, 'review cycles'],
    ['maxRepairCycles', budgets.maxRepairCycles, usage.repairCycles, 'repair cycles'],
    ['maxProviderWallClockMs', budgets.maxProviderWallClockMs, usage.providerWallClockMs, 'time spent inside provider calls'],
  ];
  for (const [budget, limit, observed, detail] of tests) {
    if (limit > 0 && observed > limit) return { budget, limit, observed, detail };
  }
  if (budgets.maxEstimatedCostUsd !== null && usage.costMeasured
      && (usage.estimatedCostUsd ?? 0) > budgets.maxEstimatedCostUsd) {
    return {
      budget: 'maxEstimatedCostUsd', limit: budgets.maxEstimatedCostUsd,
      observed: usage.estimatedCostUsd ?? 0, detail: 'measured provider cost',
    };
  }
  return null;
}

export function mergeBudgets(overrides: Partial<TaskBudgets> = {}): TaskBudgets {
  return { ...DEFAULT_TASK_BUDGETS, ...overrides };
}
