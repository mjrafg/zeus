/**
 * Revalidation against a moved integration target.
 *
 * A task verified against HEAD X and integrated into HEAD Y was never actually
 * verified against what it lands on. Usually that is fine. Occasionally the
 * intervening commits touched the same code, and the result is a defect that
 * every individual task validated cleanly — the most demoralising kind,
 * because the evidence all looks green.
 *
 * So integration is not a merge, it is a small pipeline:
 *
 *   rebase onto Y → recompute impact on the REBASED diff → rerun the floor
 *   → escalate one tier if the rebased diff overlaps what changed between
 *     X and Y → only then integrate
 *
 * Git access is injected. That keeps this testable without a repository and
 * keeps the decision logic separable from the plumbing.
 */

import { parseDiff, ParsedDiff, touchedPaths } from './diff';
import { Tier, TierDecision, resolveTier, escalateDecision, planFor, ValidationPlan, Confidence } from './tier';
import { HardeningSettings } from './tier';

/** The git operations revalidation needs, and nothing more. */
export interface GitAccess {
  /** Current commit of the integration target. */
  headOf(ref: string): string;
  /** Files changed between two commits. */
  filesChangedBetween(from: string, to: string): string[];
  /** Rebases the task's work onto `onto`. Must not throw on conflict. */
  rebase(onto: string): { ok: boolean; conflicts: string[]; detail: string };
  /** Unified diff of the task's work as it now stands. */
  diffAgainst(base: string): string;
}

export type RevalidationCode =
  | 'REVALIDATION_NOT_NEEDED'
  | 'REVALIDATION_REQUIRED'
  | 'REVALIDATION_CONFLICT';

export interface RevalidationDecision {
  code: RevalidationCode;
  /** The commit the task was verified against. */
  verifiedAgainst: string;
  /** Where the integration target is now. */
  integrationHead: string;
  /** Files changed on the target since the task was verified. */
  intervening: string[];
  /** Files the rebased diff touches that also moved underneath it. */
  overlap: string[];
  /** Tier before any integration escalation. */
  originalTier: Tier;
  tier: Tier;
  escalated: boolean;
  /** What must be rerun before integrating. */
  plan: ValidationPlan | null;
  decision: TierDecision | null;
  conflicts: string[];
  detail: string;
}

export interface RevalidationInput {
  git: GitAccess;
  integrationRef: string;
  /** The commit the task's validation evidence was produced against. */
  verifiedAgainst: string;
  originalTier: Tier;
  adapterId: string;
  confidence: Confidence;
  commands: Record<string, string | null | undefined>;
  hardening?: Partial<HardeningSettings>;
}

/**
 * Computes the overlap between a rebased diff and the intervening commits.
 *
 * Deliberately path-level rather than semantic. A cheap over-approximation is
 * correct here: escalating one tier because two changes touched the same file
 * costs a few minutes, and missing a genuine interaction costs a regression
 * that every task validated clean.
 */
export function overlapBetween(rebased: ParsedDiff, intervening: string[]): string[] {
  const moved = new Set(intervening.map((p) => p.replace(/^\.\//, '')));
  return touchedPaths(rebased)
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => moved.has(p))
    .sort();
}

/**
 * Runs the decision half of integration revalidation.
 *
 * Performs the rebase (through the injected git access) because the diff to
 * classify is the rebased one — classifying the pre-rebase diff would answer a
 * question nobody asked.
 */
export function revalidateForIntegration(input: RevalidationInput): RevalidationDecision {
  const integrationHead = input.git.headOf(input.integrationRef);

  const base = {
    verifiedAgainst: input.verifiedAgainst, integrationHead,
    originalTier: input.originalTier, conflicts: [] as string[],
  };

  if (integrationHead === input.verifiedAgainst) {
    return {
      ...base, code: 'REVALIDATION_NOT_NEEDED', intervening: [], overlap: [],
      tier: input.originalTier, escalated: false, plan: null, decision: null,
      detail: 'the integration target has not moved since this task was verified',
    };
  }

  const intervening = input.git.filesChangedBetween(input.verifiedAgainst, integrationHead)
    .map((p) => p.replace(/^\.\//, ''));

  const rebase = input.git.rebase(integrationHead);
  if (!rebase.ok) {
    // A conflict is a human's decision, not something to validate around.
    return {
      ...base, code: 'REVALIDATION_CONFLICT', intervening, overlap: [],
      tier: input.originalTier, escalated: false, plan: null, decision: null,
      conflicts: rebase.conflicts,
      detail: `rebase onto ${integrationHead.slice(0, 12)} conflicts in ${rebase.conflicts.length} file(s): ${rebase.detail}`,
    };
  }

  // Impact is recomputed on what will actually be integrated.
  const rebased = parseDiff(input.git.diffAgainst(integrationHead));
  let decision = resolveTier({
    diff: rebased, adapterId: input.adapterId,
    confidence: input.confidence, hardening: input.hardening,
  });

  const overlap = overlapBetween(rebased, intervening);
  let escalated = false;
  if (overlap.length) {
    decision = escalateDecision(decision, 'integrationOverlap',
      `the rebased diff touches ${overlap.length} file(s) that also changed between ${input.verifiedAgainst.slice(0, 12)} and ${integrationHead.slice(0, 12)}: ${overlap.slice(0, 5).join(', ')}`);
    escalated = true;
  }

  return {
    ...base, code: 'REVALIDATION_REQUIRED', intervening, overlap,
    tier: decision.tier, escalated,
    plan: planFor(decision.tier, input.commands),
    decision,
    detail: overlap.length
      ? `integration target moved and the rebased diff overlaps ${overlap.length} intervening change(s): escalated one tier before integration`
      : 'integration target moved; impact recomputed on the rebased diff and the affected floor must rerun',
  };
}
