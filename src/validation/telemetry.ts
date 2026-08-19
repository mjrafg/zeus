/**
 * The product metric.
 *
 * Zeus is trying to do work without a person in the loop, and the honest
 * measure of that is not throughput and not test coverage. It is: how often
 * did a task complete with nobody touching it AND stay correct afterwards?
 *
 * Both halves matter, and they pull against each other. Dropping validation
 * raises the first and destroys the second, which is why they are one metric
 * rather than two. A task that finished untouched and caused a regression next
 * week is not a success; counting it as one is exactly the self-deception this
 * number exists to prevent.
 *
 * Everything is derived from the hash-chained event log. There is no second
 * store to drift out of agreement with it.
 */

import { StoredEvent } from '../engine/events';

/** States that mean a person has to do something. */
export const HUMAN_ATTENTION_STATES = ['AWAITING_HUMAN', 'BLOCKED', 'NEEDS_RECONCILIATION'];

export interface TaskTelemetry {
  taskId: string;
  outcome: string;
  startedAt: string | null;
  endedAt: string | null;
  wallClockMs: number;
  /** Approvals, answers and manual fixes. */
  humanInterventionCount: number;
  interventionReasons: string[];
  /** Regressions later attributed to this task as VALIDATION_MISS. */
  attributedRegressions: number;
  /** Flakes seen against this task. Recorded, and never counted as a miss. */
  suspectedFlakes: number;
  validationTier: string | null;
  /** Completed, untouched, and no regression has been attributed since. */
  zeroTouchClean: boolean;
  completed: boolean;
}

function payload(e: StoredEvent): any { return e.payload as any; }

/**
 * Derives one task's telemetry from its log.
 *
 * An intervention is counted from the evidence, not self-reported: an explicit
 * HUMAN_INTERVENTION event, or the task entering a state that cannot advance
 * without a person. Counting only explicit events would let a task that sat in
 * AWAITING_HUMAN for a day be scored as zero-touch.
 */
export function taskTelemetry(taskId: string, events: StoredEvent[]): TaskTelemetry {
  const evs = events.filter((e) => e.taskId === taskId);
  const created = evs.find((e) => e.type === 'TASK_CREATED');
  const states = evs.filter((e) => e.type === 'STATE_CHANGED');
  const last = states[states.length - 1];
  const outcome = last ? String(payload(last).to) : 'NEW';

  const interventionReasons: string[] = [];
  let interventions = 0;

  for (const e of evs) {
    if (e.type === 'HUMAN_INTERVENTION') {
      interventions += 1;
      interventionReasons.push(String(payload(e).reason ?? 'unspecified intervention'));
      continue;
    }
    if (e.type === 'STATE_CHANGED' && HUMAN_ATTENTION_STATES.includes(String(payload(e).to))) {
      interventions += 1;
      const p = payload(e);
      interventionReasons.push(String(p.reason ?? p.reasonCode ?? `entered ${p.to}`));
    }
  }

  const attributions = evs.filter((e) => e.type === 'REGRESSION_ATTRIBUTED').map(payload);
  const attributedRegressions = attributions.filter((p) => p.attribution === 'VALIDATION_MISS').length;
  const suspectedFlakes = attributions.filter((p) => p.attribution === 'SUSPECTED_FLAKE').length;

  const planEvent = [...evs].reverse().find((e) => e.type === 'VALIDATION_PLAN');
  const validationTier = planEvent ? String(payload(planEvent).tier ?? '') || null : null;

  const startedAt = created?.ts ?? null;
  const endedAt = evs.length ? evs[evs.length - 1].ts : null;
  const wallClockMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
  const completed = outcome === 'COMPLETED';

  return {
    taskId, outcome, startedAt, endedAt, wallClockMs,
    humanInterventionCount: interventions, interventionReasons,
    attributedRegressions, suspectedFlakes, validationTier,
    completed,
    zeroTouchClean: completed && interventions === 0 && attributedRegressions === 0,
  };
}

export interface ZeroTouchMetric {
  /** The number. Null when there is nothing to divide by. */
  rate: number | null;
  clean: number;
  completed: number;
  /** Completed tasks that needed a person. */
  withIntervention: number;
  /** Completed tasks that later caused an attributed regression. */
  withRegression: number;
  /** Median wall clock across completed tasks, in ms. */
  medianWallClockMs: number;
  /** Why the rate is what it is, in the order that costs the most. */
  topInterventionReasons: Array<{ reason: string; count: number }>;
}

/**
 * ZERO_TOUCH_CLEAN_RATE.
 *
 * Denominator is completed tasks. A task still running has not yet had the
 * chance to need a person, and including it would make the number drift with
 * queue depth rather than with quality.
 */
export function zeroTouchCleanRate(records: TaskTelemetry[]): ZeroTouchMetric {
  const completed = records.filter((r) => r.completed);
  const clean = completed.filter((r) => r.zeroTouchClean).length;

  const reasonCounts = new Map<string, number>();
  for (const r of completed) {
    for (const reason of r.interventionReasons) {
      // Group by the reason's leading code or first clause, so the list is
      // short enough to act on.
      const key = (/^([A-Z_]{4,})/.exec(reason)?.[1]) ?? reason.split(':')[0].slice(0, 60);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }

  const durations = completed.map((r) => r.wallClockMs).sort((a, b) => a - b);
  const median = durations.length
    ? (durations.length % 2
      ? durations[(durations.length - 1) / 2]
      : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2))
    : 0;

  return {
    rate: completed.length ? clean / completed.length : null,
    clean,
    completed: completed.length,
    withIntervention: completed.filter((r) => r.humanInterventionCount > 0).length,
    withRegression: completed.filter((r) => r.attributedRegressions > 0).length,
    medianWallClockMs: median,
    topInterventionReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

/** Formats the metric for a terminal. Null reads as "not yet", never as 0%. */
export function formatZeroTouch(m: ZeroTouchMetric): string {
  if (m.rate === null) return 'ZERO_TOUCH_CLEAN_RATE  n/a (no completed tasks yet)';
  const pct = (m.rate * 100).toFixed(m.completed < 20 ? 0 : 1);
  return `ZERO_TOUCH_CLEAN_RATE  ${pct}%  (${m.clean}/${m.completed} completed tasks: 0 interventions, 0 attributed regressions)`;
}
