/**
 * Proving criteria.
 *
 * Three evaluator kinds, one rule: an evaluation either produces a verdict
 * about the criterion or it produces UNEVALUATED. Nothing that failed to run
 * is allowed to look like a criterion that failed.
 *
 * The accepted oracle is the LEDGER. A command that is not in it is refused
 * before spawning — the same principle as the validation selection ledger,
 * one level up. Without it, "evaluate this mission" would be an arbitrary
 * command-execution surface wearing a contract's clothes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProcessSupervisor, ExecutionResult } from '../engine/exec';
import { ExecutionPolicy, resolveWithin } from '../engine/policy';
import { Provider } from '../engine/providers';
import {
  buildReviewPayload, reconcileReviewerReport, ORACLE_JUDGE_POLICY,
} from '../engine/reviewcontext';
import { Criterion, CriterionOutcome, MAX_REPEAT, Oracle } from './oracle';

export interface CriterionResult {
  criterionId: string;
  outcome: CriterionOutcome;
  /** Pointers into evidence that already exists. Never a re-explanation. */
  evidence: string[];
  /** One line a human can act on. Diagnostic; the outcome is authoritative. */
  detail: string;
  /** Present when the evaluation was refused before anything ran. */
  refusal?: 'ORACLE_EVALUATOR_NOT_ACCEPTED' | 'POLICY_DENIED' | 'JUDGE_CONTEXT_CONTAMINATED';
  durationMs: number;
}

export interface EvaluationRun {
  missionId: string;
  oracleVersion: number;
  scope: 'incremental' | 'full';
  results: CriterionResult[];
  /** Required criteria proven / required criteria total. */
  provenRequired: number;
  totalRequired: number;
}

/**
 * The check vocabulary, mapped one level up.
 *
 * PASSED is the only outcome that proves anything, and TEST_FAILED is the only
 * one that disproves it. Everything else — timeout, resource limit, policy
 * denial, infrastructure failure, cancellation — means the evaluator did not
 * deliver a verdict, so the criterion is UNEVALUATED.
 *
 * A note carried forward from the cross-process cancellation fix: CANCELLED is
 * best-effort, because the intent marker can fail to be written under disk
 * pressure and the outcome would then read RESOURCE_LIMIT_EXCEEDED. Both land
 * in UNEVALUATED, so no decision here rides on telling them apart. M3 must
 * keep it that way: the moment something branches differently on CANCELLED vs
 * RESOURCE_LIMIT_EXCEEDED, a full disk starts changing verdicts.
 */
export function outcomeForExecution(res: ExecutionResult, expect: 'PASSED' | 'TEST_FAILED'): CriterionOutcome {
  const passed = res.outcome === 'COMPLETED';
  const failed = res.outcome === 'FAILED';
  if (!passed && !failed) return 'UNEVALUATED';
  const observed: 'PASSED' | 'TEST_FAILED' = passed ? 'PASSED' : 'TEST_FAILED';
  return observed === expect ? 'PROVEN' : 'FAILED';
}

/** Every command the accepted oracle authorises. The ledger, as a set. */
export function acceptedCommands(oracle: Oracle): Set<string> {
  const out = new Set<string>();
  for (const c of oracle.criteria) {
    const ev = c.evaluator as any;
    if (ev?.kind === 'command' || ev?.kind === 'probe') out.add(String(ev.command));
  }
  return out;
}

export interface EvaluateInput {
  oracle: Oracle;
  projectId: string;
  worktree: string;
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  /** Only needed when the oracle contains AI_JUDGED criteria. */
  judge?: Provider;
  scope?: 'incremental' | 'full';
  /** Explicit subset. Ignored when scope is 'full'. */
  criterionIds?: string[];
  /**
   * The ledger: every command the ACCEPTED oracle authorises.
   *
   * Deliberately separate from `oracle`. Deriving it from the same object
   * whose criteria are being executed would make the check a tautology — the
   * ledger would always contain exactly what was about to run, and could never
   * refuse anything. The caller passes what the mission LOG says was accepted,
   * so a criteria set that drifted from it is caught.
   *
   * Defaults to the passed oracle only for callers that have no accepted
   * oracle yet (a dry run over a freshly compiled one).
   */
  ledger?: Set<string>;
  /** Paths that changed, for incremental selection via affectedBy. */
  touched?: string[];
  /** Per-RUN wall clock. With `repeat`, each run gets this, not a share of it. */
  timeoutSeconds?: number;
  baseSha?: string;
}

/** Which criteria an incremental pass should look at. */
export function selectCriteria(oracle: Oracle, input: EvaluateInput): Criterion[] {
  if ((input.scope ?? 'full') === 'full') return oracle.criteria;
  if (input.criterionIds?.length) {
    return oracle.criteria.filter((c) => input.criterionIds!.includes(c.criterionId));
  }
  const touched = input.touched ?? [];
  if (!touched.length) return [];
  return oracle.criteria.filter((c) => (c.affectedBy ?? []).some((hint) =>
    touched.some((t) => t === hint || t.startsWith(hint.replace(/\*.*$/, '')))));
}

async function runCommandEvaluator(input: EvaluateInput, c: Criterion,
  command: string, expect: 'PASSED' | 'TEST_FAILED', network: boolean): Promise<CriterionResult> {
  const started = Date.now();
  const ledger = input.ledger ?? acceptedCommands(input.oracle);
  if (!ledger.has(command)) {
    // The accepted oracle is the ledger. Refused BEFORE spawning, because the
    // point is not to notice afterwards that something ran.
    return {
      criterionId: c.criterionId, outcome: 'UNEVALUATED', evidence: [],
      refusal: 'ORACLE_EVALUATOR_NOT_ACCEPTED', durationMs: Date.now() - started,
      detail: `"${command}" is not an evaluator in the accepted oracle; nothing was executed`,
    };
  }
  // A probe that needs the network gets it only if the POLICY grants it. This
  // is not a second door to the network: the probe runs under the same policy
  // as every other project command, and a denial is UNEVALUATED with the
  // violation on the record — never a silent skip, never a bypass.
  if (network && !input.policy.network) {
    return {
      criterionId: c.criterionId, outcome: 'UNEVALUATED', evidence: [],
      refusal: 'POLICY_DENIED', durationMs: Date.now() - started,
      detail: 'the probe declares it requires the network and the execution policy '
        + 'denies it; nothing was spawned. This is a refusal on the record, not a '
        + 'skipped check, and not a second door to the network.',
    };
  }

  const [cmd, ...args] = command.split(/\s+/).filter(Boolean);

  // N SEPARATE SUPERVISED EXECUTIONS, never one execution repeated internally.
  //
  // Each run is individually bounded, individually classified and individually
  // recorded, and each one takes a slot from the governor — so `repeat: 5`
  // costs five executions of budget, which is what it actually is. A loop
  // inside one spawn would have hidden four of them from every ceiling Zeus
  // has.
  const repeat = Math.max(1, Math.min(MAX_REPEAT,
    Number.isInteger((c.evaluator as any).repeat) ? (c.evaluator as any).repeat : 1));
  const runs: Array<{ index: number; outcome: string; durationMs: number; id: string }> = [];
  let final: CriterionOutcome = 'UNEVALUATED';

  for (let i = 1; i <= repeat; i += 1) {
    const res = await input.supervisor.run({
      id: `${c.criterionId}-r${i}-${Date.now()}`,
      projectId: input.projectId, taskId: c.criterionId, cls: 'light',
      command: cmd, args, cwd: input.worktree,
      policy: input.policy, confineFilesystem: true,
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
    } as any);
    runs.push({ index: i, outcome: res.outcome, durationMs: res.durationMs, id: res.id });
    final = outcomeForExecution(res, expect);
    // SHORT-CIRCUIT. Once a run has failed the criterion is disproven, and
    // once a run failed to produce a verdict the criterion is unevaluable —
    // in both cases the remaining runs cannot change the answer, and running
    // them would spend budget to learn nothing. The runs that did not happen
    // are reported as not-executed rather than left to be inferred from a
    // count.
    if (final !== 'PROVEN') break;
  }

  const executed = runs.length;
  const totalMs = runs.reduce((a, r) => a + r.durationMs, 0);
  const failing = final === 'PROVEN' ? null : runs[runs.length - 1];
  return {
    criterionId: c.criterionId,
    outcome: final,
    evidence: [
      ...runs.map((r) => `run:${r.index}/${repeat}:${r.outcome}:${r.durationMs}ms:${r.id}`),
      `runs:${executed}/${repeat}`,
      `totalRunMs:${totalMs}`,
      ...(executed < repeat ? [`notExecuted:${repeat - executed}`] : []),
    ],
    detail: repeat === 1
      ? `${command} → ${runs[0]?.outcome ?? 'not run'}`
      : `${command} ×${repeat} → ${final}`
        + (failing ? `, run ${failing.index} was ${failing.outcome}` : ', every run passed')
        + (executed < repeat ? ` (runs ${executed + 1}-${repeat} not executed)` : ''),
    durationMs: Date.now() - started,
  };
}

const JUDGE_HEADER = [
  'Decide whether the artifacts below satisfy the rubric. You have the rubric',
  'and the artifacts and nothing else: no implementation notes, no compiler or',
  'critic reasoning, and no previous verdict. Judge what is in front of you.',
  '',
  'Reply with ONLY: {"satisfied":true|false,"findings":["..."],',
  ' "evidenceSummary":"...","usedContext":[...]}',
].join('\n');

async function runJudge(input: EvaluateInput, c: Criterion,
  rubric: string, artifacts: string[]): Promise<CriterionResult> {
  const started = Date.now();
  if (!input.judge) {
    return { criterionId: c.criterionId, outcome: 'UNEVALUATED', evidence: [],
      detail: 'no judge provider is configured, so this criterion was not judged',
      durationMs: Date.now() - started };
  }
  // Artifacts are read from inside the worktree, through the containment rule
  // the rest of the engine uses.
  const sections = artifacts.map((rel) => {
    const within = resolveWithin(input.worktree, rel);
    if (!within.ok) return { kind: 'judged-artifact' as const, label: rel, content: `[refused: ${within.reason}]` };
    let content = '';
    try { content = fs.readFileSync(within.abs, 'utf8').slice(0, 20_000); }
    catch (e: any) { content = `[unreadable: ${e?.code ?? e}]`; }
    return { kind: 'judged-artifact' as const, label: rel, content };
  });

  const payload = buildReviewPayload({
    taskId: c.criterionId, projectId: input.projectId,
    baseSha: input.baseSha ?? 'unknown', headSha: input.baseSha ?? 'unknown',
    policy: ORACLE_JUDGE_POLICY, header: JUDGE_HEADER,
    inputs: [{ kind: 'criterion-rubric', label: 'RUBRIC', content: rubric }, ...sections],
  });
  if (!payload.valid) {
    // A contaminated payload invalidates the judgment. The criterion is
    // UNEVALUATED — not FAILED — because nothing about the artifact was
    // actually decided.
    return {
      criterionId: c.criterionId, outcome: 'UNEVALUATED',
      evidence: payload.violations.map((v) => `violation:${v.kind}`),
      refusal: 'JUDGE_CONTEXT_CONTAMINATED', durationMs: Date.now() - started,
      detail: `judge payload refused: ${payload.violations.map((v) => v.detail).join('; ')}`,
    };
  }

  try {
    const res = await input.judge.invoke({
      role: 'reviewer', taskId: c.criterionId, projectId: input.projectId,
      prompt: payload.prompt, policy: input.policy, readOnly: true,
    }, input.supervisor);
    if (!res.ok || res.infrastructureFailure || !res.structured) {
      return { criterionId: c.criterionId, outcome: 'UNEVALUATED',
        evidence: [`judge:${payload.reviewInvocationId}`],
        detail: `judge did not return a verdict: ${res.infrastructureFailure ?? res.outcome}`,
        durationMs: Date.now() - started };
    }
    const s = res.structured as any;
    const reconciliation = reconcileReviewerReport(payload, res.structured);
    if (typeof s.satisfied !== 'boolean') {
      return { criterionId: c.criterionId, outcome: 'UNEVALUATED',
        evidence: [`judge:${payload.reviewInvocationId}`],
        detail: 'judge verdict had no boolean "satisfied" field',
        durationMs: Date.now() - started };
    }
    return {
      criterionId: c.criterionId,
      outcome: s.satisfied ? 'PROVEN' : 'FAILED',
      evidence: [`judge:${payload.reviewInvocationId}`, `promptHash:${payload.promptHash}`,
        ...(reconciliation.consistent ? [] : ['unsupported-claims'])],
      detail: String(s.evidenceSummary ?? (s.satisfied ? 'rubric satisfied' : 'rubric not satisfied')),
      durationMs: Date.now() - started,
    };
  } catch (e: any) {
    return { criterionId: c.criterionId, outcome: 'UNEVALUATED', evidence: [],
      detail: `judge provider threw: ${e?.message ?? e}`, durationMs: Date.now() - started };
  }
}

/** Evaluates the selected criteria and reports each one's outcome. */
export async function evaluateCriteria(input: EvaluateInput): Promise<EvaluationRun> {
  const scope = input.scope ?? 'full';
  const chosen = selectCriteria(input.oracle, input);
  const results: CriterionResult[] = [];

  // Sequential on purpose. These are project commands, and the supervisor's
  // pools are the only thing bounding them; fanning them out here would put a
  // second, unbounded scheduler above the one that exists.
  for (const c of chosen) {
    const ev = c.evaluator as any;
    if (ev?.kind === 'command') {
      results.push(await runCommandEvaluator(input, c, ev.command, ev.expect, false));
    } else if (ev?.kind === 'probe') {
      results.push(await runCommandEvaluator(input, c, ev.command, ev.expect, ev.requiresNetwork === true));
    } else if (ev?.kind === 'rubric') {
      results.push(await runJudge(input, c, ev.rubric, ev.artifacts ?? []));
    } else {
      results.push({ criterionId: c.criterionId, outcome: 'UNEVALUATED', evidence: [],
        detail: 'criterion has no usable evaluator', durationMs: 0 });
    }
  }

  const required = input.oracle.criteria.filter((c) => c.required);
  const byId = new Map(results.map((r) => [r.criterionId, r]));
  return {
    missionId: input.oracle.missionId, oracleVersion: input.oracle.version, scope, results,
    provenRequired: required.filter((c) => byId.get(c.criterionId)?.outcome === 'PROVEN').length,
    totalRequired: required.length,
  };
}

/**
 * Mission achievement from the criteria that have been evaluated.
 *
 * The distinction M1's terminal model exists for: a mission whose required
 * criteria were never successfully evaluated is UNEVALUATED, not NONE. "We
 * could not tell" and "it achieved nothing" are different reports, and only
 * one of them is a reason to stop trying.
 */
export function achievementFrom(outcomes: Map<string, CriterionOutcome>, oracle: Oracle):
  'ACHIEVED' | 'PARTIAL' | 'NONE' | 'UNEVALUATED' {
  const required = oracle.criteria.filter((c) => c.required);
  if (!required.length) return 'UNEVALUATED';
  const seen = required.map((c) => outcomes.get(c.criterionId) ?? 'UNEVALUATED');
  if (seen.every((o) => o === 'PROVEN')) return 'ACHIEVED';
  if (seen.every((o) => o === 'UNEVALUATED')) return 'UNEVALUATED';
  if (seen.some((o) => o === 'PROVEN')) return 'PARTIAL';
  return 'NONE';
}

export { path };
