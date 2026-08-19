/**
 * Which validation tier a change earns.
 *
 * The rule that makes the rest safe is simple and absolute:
 *
 *   final tier = MAX(tier of every hunk in the diff)
 *
 * FAST is not "the diff looks small". FAST is "every single hunk, considered
 * on its own, qualified as FAST". One session-helper hunk bundled with a label
 * change makes the whole diff DEEP, which is the point: an agent must not be
 * able to buy a cheap validation path by padding a risky change with a
 * harmless one.
 *
 * Every decision here is deterministic and recorded per hunk, so a reader can
 * later ask "why was this validated at this depth?" and get an answer from the
 * log rather than from a reconstruction.
 */

import { ParsedDiff, FileDiff, Hunk, hunksOf } from './diff';
import { classifyPath, Surface, SurfaceClassification } from './surface';

export type Tier = 'FAST' | 'NORMAL' | 'DEEP';

/** How much the impact analysis is worth believing. */
export type Confidence = 'KNOWN' | 'UNKNOWN';

const ORDER: Tier[] = ['FAST', 'NORMAL', 'DEEP'];
export function rank(t: Tier): number { return ORDER.indexOf(t); }
export function maxTier(a: Tier, b: Tier): Tier { return rank(a) >= rank(b) ? a : b; }
/** One tier up, saturating at DEEP. */
export function escalate(t: Tier): Tier { return ORDER[Math.min(rank(t) + 1, ORDER.length - 1)]; }

/** The tier a surface earns on its own, before any hardening rule applies. */
export function baseTierFor(s: Surface): Tier {
  switch (s) {
    case 'documentation':
    case 'ui-copy':
      return 'FAST';
    case 'ui':
      return 'FAST';
    case 'test':
    case 'test-config':
    case 'fixture':
    case 'snapshot':
      return 'NORMAL';
    case 'auth-session':
    case 'schema-migration':
    case 'dependency-manifest':
    case 'ci-build':
    case 'shared-core':
      return 'DEEP';
    case 'application':
      return 'NORMAL';
    case 'unknown':
    default:
      return 'NORMAL';
  }
}

/**
 * Whether impact analysis is worth believing for this change.
 *
 * KNOWN requires three things at once: a diff that parsed, an adapter that
 * understands the ecosystem, and every touched path landing on a surface Zeus
 * recognises. Any gap means UNKNOWN — and §4 then refuses to walk uncertainty
 * up one tier at a time when the surface is already dangerous.
 */
export function impactConfidence(diff: ParsedDiff, adapterId: string): Confidence {
  if (diff.unparsed) return 'UNKNOWN';
  if (adapterId === 'generic') return 'UNKNOWN';
  if (!diff.files.length) return 'UNKNOWN';
  const anyUnknown = diff.files.some((f) => classifyPath(f.path).surface === 'unknown');
  return anyUnknown ? 'UNKNOWN' : 'KNOWN';
}

export interface HunkClassification {
  file: string;
  hunkIndex: number;
  hunkHeader: string;
  surface: Surface;
  testSurface: boolean;
  highRisk: boolean;
  commentOnly: boolean;
  tier: Tier;
  /** Every rule that contributed, in the order it applied. */
  reasons: string[];
}

export interface HardeningSettings {
  /** §1. Non-disableable in v1; the value is recorded, never honoured as false. */
  mixedDiffMaxTier: boolean;
  /** §2. Non-disableable in v1. */
  testSurfaceRisk: boolean;
  /** §4. */
  unknownPlusRiskDirectDeep: boolean;
  /** §6. Floor applied when the project adapter cannot produce real impact. */
  genericAdapterFloor: Tier;
  /** §7. Reviewer-requested expansions allowed per task. */
  reviewerExpansionBudget: number;
}

export const DEFAULT_HARDENING: HardeningSettings = {
  mixedDiffMaxTier: true,
  testSurfaceRisk: true,
  unknownPlusRiskDirectDeep: true,
  genericAdapterFloor: 'NORMAL',
  reviewerExpansionBudget: 2,
};

export interface TierInput {
  diff: ParsedDiff;
  /** The project adapter's id; 'generic' cannot produce real impact analysis. */
  adapterId: string;
  /** Whether impact analysis is trustworthy for this change. */
  confidence: Confidence;
  hardening?: Partial<HardeningSettings>;
}

export interface TierDecision {
  tier: Tier;
  confidence: Confidence;
  /** Every hunk, classified. This is the audit trail §1 asks for. */
  perHunk: HunkClassification[];
  /** Rules that moved the tier above the plain per-hunk maximum. */
  escalations: Array<{ rule: string; from: Tier; to: Tier; detail: string }>;
  /** Files whose change can alter what counts as passing. */
  testSurfaceFiles: string[];
  /** Files on a known-dangerous surface. */
  highRiskFiles: string[];
  /** True only when every hunk independently qualified as FAST. */
  fastEligible: boolean;
  reasons: string[];
  hardening: HardeningSettings;
}

/**
 * A hunk that changes nothing but comments is as cheap as documentation —
 * but only in a file where "comment" is a concept we can recognise, and never
 * on a high-risk surface, where even a comment change signals someone was
 * editing something that matters.
 */
function classifyHunk(f: FileDiff, h: Hunk, sc: SurfaceClassification): HunkClassification {
  const reasons: string[] = [`${sc.surface}: ${sc.reason}`];
  let tier = baseTierFor(sc.surface);

  if (h.commentOnly && !sc.highRisk && !sc.testSurface) {
    if (tier !== 'FAST') reasons.push('comment-only hunk: treated as documentation');
    tier = 'FAST';
  }

  // A deleted or renamed file is a structural change; there is no "small"
  // version of removing something other code may depend on.
  if (f.status === 'deleted') {
    reasons.push('file deleted');
    tier = maxTier(tier, 'NORMAL');
  }
  if (f.status === 'renamed') {
    reasons.push(`file renamed from ${f.oldPath}`);
    tier = maxTier(tier, 'NORMAL');
  }
  if (f.binary) {
    reasons.push('binary change: contents cannot be inspected');
    tier = maxTier(tier, 'NORMAL');
  }

  if (sc.testSurface) {
    reasons.push('test surface: can change what counts as passing');
    tier = maxTier(tier, 'NORMAL');
  }
  if (sc.highRisk) {
    reasons.push('high-risk surface');
    tier = maxTier(tier, 'DEEP');
  }

  return {
    file: f.path, hunkIndex: h.index, hunkHeader: h.header,
    surface: sc.surface, testSurface: sc.testSurface, highRisk: sc.highRisk,
    commentOnly: h.commentOnly, tier, reasons,
  };
}

/**
 * Resolves the tier for a whole diff.
 *
 * Order matters and is fixed: classify every hunk, take the maximum, then
 * apply the floors. Floors can only raise.
 */
export function resolveTier(input: TierInput): TierDecision {
  const hardening: HardeningSettings = { ...DEFAULT_HARDENING, ...(input.hardening ?? {}) };
  // §1 and §2 are trust infrastructure, not preference. A config that switches
  // them off is recorded and ignored rather than obeyed.
  hardening.mixedDiffMaxTier = true;
  hardening.testSurfaceRisk = true;

  const perHunk: HunkClassification[] = [];
  const testSurfaceFiles = new Set<string>();
  const highRiskFiles = new Set<string>();

  for (const f of input.diff.files) {
    const sc = classifyPath(f.path);
    // A rename is evaluated against both names: moving a session helper into a
    // docs directory must not launder it.
    const scOld = f.oldPath ? classifyPath(f.oldPath) : null;
    const merged: SurfaceClassification = scOld
      ? {
        path: f.path,
        surface: rank(baseTierFor(scOld.surface)) > rank(baseTierFor(sc.surface)) ? scOld.surface : sc.surface,
        testSurface: sc.testSurface || scOld.testSurface,
        highRisk: sc.highRisk || scOld.highRisk,
        reason: `${sc.reason}; previously ${scOld.reason}`,
      }
      : sc;

    if (merged.testSurface) testSurfaceFiles.add(f.path);
    if (merged.highRisk) highRiskFiles.add(f.path);
    for (const h of hunksOf(f)) perHunk.push(classifyHunk(f, h, merged));
  }

  const reasons: string[] = [];
  const escalations: TierDecision['escalations'] = [];

  // An empty or unreadable diff is not evidence of a small change.
  if (!perHunk.length) {
    const tier: Tier = input.diff.unparsed ? 'DEEP' : 'NORMAL';
    reasons.push(input.diff.unparsed
      ? 'diff could not be parsed: validated at maximum depth rather than assumed harmless'
      : 'no changed hunks detected: validated at the standard floor rather than skipped');
    return {
      tier, confidence: input.confidence, perHunk: [], escalations,
      testSurfaceFiles: [], highRiskFiles: [], fastEligible: false, reasons, hardening,
    };
  }

  // §1 — the maximum, never the average and never the majority.
  let tier = perHunk.reduce<Tier>((acc, h) => maxTier(acc, h.tier), 'FAST');
  const fastEligible = perHunk.every((h) => h.tier === 'FAST');
  reasons.push(`per-hunk maximum over ${perHunk.length} hunk(s): ${tier}`);
  if (!fastEligible && perHunk.some((h) => h.tier === 'FAST')) {
    const driver = perHunk.find((h) => h.tier === tier)!;
    reasons.push(`mixed diff: ${driver.file} hunk ${driver.hunkIndex} (${driver.surface}) sets the tier`);
  }

  // §2 — any test-surface change is at least NORMAL, whatever else is true.
  if (testSurfaceFiles.size && rank(tier) < rank('NORMAL')) {
    escalations.push({ rule: 'testSurfaceRisk', from: tier, to: 'NORMAL',
      detail: `test surface changed: ${[...testSurfaceFiles].join(', ')}` });
    tier = 'NORMAL';
  }

  // §4 — uncertainty on a dangerous surface does not get walked up gradually.
  if (hardening.unknownPlusRiskDirectDeep && input.confidence === 'UNKNOWN' && highRiskFiles.size && tier !== 'DEEP') {
    escalations.push({ rule: 'unknownPlusRiskDirectDeep', from: tier, to: 'DEEP',
      detail: `UNKNOWN impact confidence on a high-risk surface (${[...highRiskFiles].join(', ')}): escalated directly, not one level at a time` });
    tier = 'DEEP';
  }

  // §6 — the generic adapter cannot produce reliable impact, so it may only
  // claim FAST for changes whose safety does not depend on impact analysis.
  if (input.adapterId === 'generic') {
    const trivialOnly = perHunk.every((h) => h.commentOnly || h.surface === 'documentation' || h.surface === 'ui-copy');
    if (!trivialOnly) {
      const floor = hardening.genericAdapterFloor;
      const detail = 'the generic adapter cannot compute reliable impact; FAST is available only for documentation-only or comment-only diffs';
      // Recorded even when the tier already met the floor. A reader asking
      // "why was this not FAST?" should not have to infer that the adapter was
      // the reason, and a floor that only shows up when it bites is invisible
      // exactly when someone is auditing why the fast path is never taken.
      escalations.push({ rule: 'genericAdapterFloor', from: tier, to: maxTier(tier, floor), detail });
      tier = maxTier(tier, floor);
    } else {
      reasons.push('generic adapter: documentation-only or comment-only diff, FAST permitted');
    }
  }

  return {
    tier, confidence: input.confidence, perHunk, escalations,
    testSurfaceFiles: [...testSurfaceFiles], highRiskFiles: [...highRiskFiles],
    fastEligible: fastEligible && tier === 'FAST', reasons, hardening,
  };
}

/**
 * Raises a decision by one tier, recording why.
 *
 * Used by integration revalidation (§8) and by accepted reviewer expansions
 * (§7). Escalation is always additive: nothing in this module can lower a tier
 * that has already been earned.
 */
export function escalateDecision(d: TierDecision, rule: string, detail: string): TierDecision {
  const to = escalate(d.tier);
  if (to === d.tier) {
    return { ...d, reasons: [...d.reasons, `${rule}: already at DEEP, nothing higher to escalate to`] };
  }
  return {
    ...d, tier: to,
    escalations: [...d.escalations, { rule, from: d.tier, to, detail }],
    fastEligible: false,
  };
}

/** The checks a tier requires. The floor is authoritative; tiers only add. */
export interface ValidationPlan {
  tier: Tier;
  /** Always run, at every tier. Removing one is not a decision a tier can make. */
  floor: string[];
  additional: string[];
}

/**
 * Turns a tier into the set of configured checks to run.
 *
 * The deterministic floor — typecheck and unit tests, whatever the project
 * declares — runs at every tier including FAST. A tier decides how much runs
 * *on top*, never how much runs at all.
 */
export function planFor(tier: Tier, commands: Record<string, string | null | undefined>): ValidationPlan {
  const floor: string[] = [];
  if (commands.typecheck) floor.push('typecheck');
  if (commands.unitTest) floor.push('unit-test');

  const additional: string[] = [];
  if (tier !== 'FAST') {
    if (commands.lint) additional.push('lint');
    if (commands.build) additional.push('build');
  }
  if (tier === 'DEEP' && commands.integrationTest) additional.push('integration-test');

  return { tier, floor, additional };
}
