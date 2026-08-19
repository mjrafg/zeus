/**
 * Telling a validation miss apart from a flaky test.
 *
 * When a later checkpoint fails and the failure points back at an earlier
 * task, two very different things may have happened: validation genuinely let
 * a defect through, or a test that fails one run in five happened to fail this
 * one. Recording the second as the first poisons the feedback loop — the
 * impact analyzer learns to be conservative about a surface that was never
 * actually risky, and the fast path quietly dies of a thousand flakes.
 *
 * The separation is made by re-running, not by reasoning: a bounded number of
 * deterministic retries in a clean environment. Consistent failure is a miss.
 * Intermittent failure is a flake, recorded against the TEST.
 *
 * The one thing this module must never do is let a flake verdict suppress a
 * real miss. When the retries disagree in a way that cannot be read as either,
 * the answer is the conservative one.
 */

export type Attribution = 'VALIDATION_MISS' | 'SUSPECTED_FLAKE' | 'INCONCLUSIVE';

export interface RetryAttempt {
  attempt: number;
  passed: boolean;
  /** Non-product outcomes (infrastructure, timeout) are not evidence either way. */
  conclusive: boolean;
  detail: string;
}

export interface AttributionInput {
  taskId: string;
  checkName: string;
  /** The original failing observation that started this. */
  originalFailure: string;
  attempts: RetryAttempt[];
}

export interface AttributionResult {
  attribution: Attribution;
  taskId: string;
  checkName: string;
  conclusiveAttempts: number;
  failures: number;
  passes: number;
  /**
   * Whether this result may influence impact analysis. A flake never may:
   * §5 is explicit that flakes must not tune the analyzer toward conservatism.
   */
  influencesImpactAnalyzer: boolean;
  /** Whether the earlier task carries this regression in its telemetry. */
  attributedToTask: boolean;
  detail: string;
}

export const DEFAULT_RETRY_ATTEMPTS = 2;

/**
 * Classifies a set of retry observations.
 *
 * Only conclusive attempts count. An infrastructure failure during a retry
 * tells us nothing about the code, and treating it as a pass would be the
 * cheapest possible way to make a real miss disappear.
 */
export function attribute(input: AttributionInput): AttributionResult {
  const conclusive = input.attempts.filter((a) => a.conclusive);
  const failures = conclusive.filter((a) => !a.passed).length;
  const passes = conclusive.filter((a) => a.passed).length;

  const base = {
    taskId: input.taskId, checkName: input.checkName,
    conclusiveAttempts: conclusive.length, failures, passes,
  };

  if (!conclusive.length) {
    // Nothing was learned. The failure stands as reported and stays attributed,
    // because "we could not re-run it" is not evidence of innocence.
    return {
      ...base, attribution: 'INCONCLUSIVE',
      influencesImpactAnalyzer: false, attributedToTask: true,
      detail: 'no retry produced a conclusive result; the original failure stands and remains attributed',
    };
  }

  if (passes > 0 && failures > 0) {
    return {
      ...base, attribution: 'SUSPECTED_FLAKE',
      influencesImpactAnalyzer: false, attributedToTask: false,
      detail: `intermittent across ${conclusive.length} clean re-run(s) (${failures} failed, ${passes} passed): recorded against the test, not the validation decision`,
    };
  }

  if (failures === conclusive.length) {
    return {
      ...base, attribution: 'VALIDATION_MISS',
      influencesImpactAnalyzer: true, attributedToTask: true,
      detail: `failed consistently across ${conclusive.length} clean re-run(s): validation let this through`,
    };
  }

  // Every conclusive re-run passed. The original failure was real but is not
  // reproducible, which is the definition of a suspected flake.
  return {
    ...base, attribution: 'SUSPECTED_FLAKE',
    influencesImpactAnalyzer: false, attributedToTask: false,
    detail: `original failure did not reproduce across ${conclusive.length} clean re-run(s): recorded against the test`,
  };
}

/** Runs the bounded retry loop. The runner is injected so this is testable. */
export async function attributeByRetry(
  input: Omit<AttributionInput, 'attempts'>,
  runOnce: (attempt: number) => Promise<{ passed: boolean; conclusive: boolean; detail: string }>,
  maxAttempts = DEFAULT_RETRY_ATTEMPTS,
): Promise<AttributionResult> {
  const attempts: RetryAttempt[] = [];
  for (let i = 1; i <= Math.max(1, maxAttempts); i += 1) {
    const r = await runOnce(i);
    attempts.push({ attempt: i, ...r });
    // A pass and a fail together already prove intermittency; further runs
    // cost time and cannot change the answer.
    if (attempts.some((a) => a.conclusive && a.passed) && attempts.some((a) => a.conclusive && !a.passed)) break;
  }
  return attribute({ ...input, attempts });
}

// ---------------------------------------------------------------------------
// Test reliability
// ---------------------------------------------------------------------------

export interface FlakeRecord {
  checkName: string;
  taskId: string;
  at: string;
}

export interface ReliabilityFinding {
  code: 'TEST_RELIABILITY';
  checkName: string;
  occurrences: number;
  detail: string;
}

export const FLAKE_FINDING_THRESHOLD = 3;

/**
 * Surfaces a reliability problem once a test has flaked repeatedly.
 *
 * This is the productive use of flake data: it says something true about the
 * test suite. What it must not do is feed back into tier selection — that is
 * how a flaky test ends up permanently slowing down an unrelated surface.
 */
export function reliabilityFindings(
  records: FlakeRecord[],
  threshold = FLAKE_FINDING_THRESHOLD,
): ReliabilityFinding[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.checkName, (counts.get(r.checkName) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([checkName, occurrences]) => ({
      code: 'TEST_RELIABILITY' as const, checkName, occurrences,
      detail: `"${checkName}" has been recorded as intermittent ${occurrences} times; the test is unreliable and should be fixed or quarantined deliberately`,
    }));
}
