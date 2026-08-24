/**
 * What the previous attempt at a node learned, carried to the next one.
 *
 * A repair used to be a boolean. The task was told THAT it was a repair and
 * never WHAT had gone wrong: `createTask` re-sent the node description
 * byte-for-byte, so the second attempt re-derived its design from the same
 * words that produced the first one and had no way to know which specific
 * claims a reviewer had already refused.
 *
 * Observed on talkbridge/M-0016: three independent review rounds converged on
 * the same two blockers — `<html lang="es">` set globally while every other
 * route stayed English, and an annual price rendering "$79.99/year" beside
 * Spanish copy — and the repair task's designer prompt contained neither. It
 * happened to fix one of them by luck of re-derivation; luck is not a feedback
 * loop.
 *
 * This is the same rule the plan critic already gets (`priorPlanFor`), one
 * level down: a rejected attempt must not start blind from the same goal.
 */
import type { Engine } from '../engine/orchestrator';

/** IMPORTANT and CRITICAL block; SUGGESTION does not. Same split the reviewer's own gate uses. */
const BLOCKING = new Set(['CRITICAL', 'IMPORTANT']);

export interface PriorFinding { severity: string; claim: string; file?: string }

export interface PriorAttempt {
  taskId: string;
  /** Blocking findings only, newest review round first, deduplicated by claim. */
  findings: PriorFinding[];
  /** Checks that did not pass, so a repair does not re-break a proven one. */
  failedChecks: Array<{ name: string; outcome: string }>;
  /** Why the attempt did not land, in the loop's own words. */
  reason: string;
}

/**
 * Which of a review's claims the next attempt must answer.
 *
 * Kept separate and exported because it is the rule, not the plumbing: a
 * SUGGESTION is advice and listing it under "every one of these must be
 * resolved" turns taste into a blocker, and a reviewer that expands twice
 * repeats itself — three copies of one blocker read as three blockers.
 *
 * Rounds are newest-first; the newest wording of a repeated claim wins.
 */
export function blockingFindings(rounds: Array<unknown>): PriorFinding[] {
  const out: PriorFinding[] = [];
  const seen = new Set<string>();
  for (const list of rounds) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const severity = String((f as any)?.severity ?? '');
      const claim = String((f as any)?.claim ?? '').trim();
      if (!claim || !BLOCKING.has(severity)) continue;
      const key = claim.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ severity, claim, ...((f as any)?.file ? { file: String((f as any).file) } : {}) });
    }
  }
  return out;
}

/**
 * Reads a finished attempt's log for what the next attempt has to answer.
 *
 * Newest round first and deduplicated by claim: a reviewer that expanded twice
 * says the same thing three times, and three copies of one blocker reads as
 * three blockers.
 */
export function priorAttempt(engine: Engine, taskId: string, reason: string): PriorAttempt | null {
  let events: ReturnType<Engine['logs']>;
  try { events = engine.logs(taskId, 2000); } catch { return null; }
  if (!events.length) return null;

  const findings = blockingFindings([...events].reverse()
    .filter((e) => e.type === 'FINDINGS')
    .map((e) => (e.payload as any)?.findings));

  const checks = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'CHECK_RESULT') continue;
    const p = e.payload as any;
    if (typeof p?.name === 'string' && typeof p?.outcome === 'string') checks.set(p.name, p.outcome);
  }
  const failedChecks = [...checks.entries()]
    .filter(([, o]) => o !== 'PASSED' && o !== 'SKIPPED')
    .map(([name, outcome]) => ({ name, outcome }));

  if (!findings.length && !failedChecks.length) return null;
  return { taskId, findings, failedChecks, reason };
}

/**
 * The prior attempt as text the next designer reads.
 *
 * Says plainly that the work is a second attempt and that each listed item has
 * to be resolved, rather than appending the findings as background the model
 * may weigh against its own re-derivation.
 */
export function repairBrief(prior: PriorAttempt): string {
  const lines: string[] = [
    '',
    'THIS IS A REPAIR OF A FAILED ATTEMPT, NOT A FRESH START.',
    `A previous attempt (${prior.taskId}) at this exact task did not land: ${prior.reason}`,
  ];
  if (prior.findings.length) {
    lines.push('', 'A reviewer refused it for the following reasons. Every one of these must be'
      + ' resolved by this attempt — not re-litigated, not partially addressed:');
    prior.findings.forEach((f, i) => {
      lines.push(`  ${i + 1}. [${f.severity}]${f.file ? ` ${f.file}:` : ''} ${f.claim}`);
    });
  }
  if (prior.failedChecks.length) {
    lines.push('', 'These checks did not pass on the previous attempt:');
    for (const c of prior.failedChecks) lines.push(`  - ${c.name}: ${c.outcome}`);
  }
  lines.push('', 'Say in your design how each item above is addressed. Keep whatever the previous'
    + ' attempt got right; change only what these findings require.');
  return lines.join('\n');
}
