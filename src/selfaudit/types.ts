/**
 * The durable self-audit harness: shared vocabulary.
 *
 * This harness is permanent. It lives in the repository, it is part of release
 * gating, and every future audit cycle re-runs it. That is the whole point:
 * a one-off audit tells you about one afternoon, while a suite that runs on
 * every candidate tells you whether the property still holds.
 *
 * The central rule is encoded in the types rather than left to discipline:
 * a probe either OBSERVES a defect or it does not. There is no way to record a
 * CONFIRMED finding without a probe having run and captured what it saw, so
 * "confirmed by reasoning" is not expressible here.
 */

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export type FindingStatus =
  /** A probe executed and observed the defect. Evidence is attached. */
  | 'CONFIRMED'
  /** Reasoned, not reproduced. Never enters the fix queue on its own. */
  | 'SUSPECTED'
  /** Investigated and disproved, with the evidence that disproves it. */
  | 'REJECTED_WITH_EVIDENCE'
  /** Real, but not resolved this cycle. Carries an impact statement. */
  | 'UNRESOLVED';

export interface Finding {
  id: string;
  lane: string;
  /** Charter sections this speaks to. */
  sections: string[];
  severity: Severity;
  status: FindingStatus;
  title: string;
  /** What is wrong, in one paragraph. */
  detail: string;
  /** The probe id that reproduces it. Empty only for SUSPECTED. */
  reproduction: string;
  /** Literal observed output. This is the evidence, not a description of it. */
  observed: string;
  /** What it costs if left alone. */
  impact: string;
  fixed?: boolean;
  /** The regression test that now fails on the buggy behaviour. */
  regressionTest?: string;
  /** For disputes arbitrated in Lane G. */
  disputeNote?: string;
}

export type CoverageStatus = 'TESTED' | 'NOT_TESTED' | 'NOT_APPLICABLE';

export interface CoverageEntry {
  section: string;
  title: string;
  status: CoverageStatus;
  /**
   * Mandatory for anything but TESTED. "Not practical" is not a reason: say
   * what was attempted and what blocked it.
   */
  reason?: string;
  probes: string[];
}

export interface ProbeOutcome {
  /** True when the invariant held. False means a defect was observed. */
  held: boolean;
  /** Literal output, either way. A passing probe still shows its working. */
  observed: string;
  /** Present when held is false. */
  finding?: Omit<Finding, 'id' | 'lane' | 'reproduction' | 'observed' | 'status'>;
}

export interface Probe {
  id: string;
  /** Charter section this probe exercises. */
  section: string;
  title: string;
  run(ctx: ProbeContext): Promise<ProbeOutcome> | ProbeOutcome;
}

export interface ProbeContext {
  /** A scratch directory that is removed when the lane finishes. */
  tmp: string;
  /** Root of the checkout under audit. NEVER the live runtime. */
  auditRoot: string;
  /** Records a note that appears in the report regardless of outcome. */
  note(s: string): void;
}

export interface LaneSpec {
  lane: string;
  title: string;
  /** Charter sections this lane owns, with their titles. */
  sections: Array<{ id: string; title: string }>;
  probes: Probe[];
  /**
   * Sections this lane deliberately does not test, and why. Declaring one is
   * how a lane says "I looked and could not" rather than staying silent.
   */
  declared?: Array<{ section: string; status: 'NOT_TESTED' | 'NOT_APPLICABLE'; reason: string }>;
}

export interface LaneResult {
  lane: string;
  title: string;
  findings: Finding[];
  coverage: CoverageEntry[];
  probesRun: number;
  probesHeld: number;
  notes: string[];
  durationMs: number;
  /** True when the lane ran every probe it declares. */
  complete: boolean;
  error?: string;
}

/** Convenience for a probe whose invariant held. */
export function held(observed: string): ProbeOutcome {
  return { held: true, observed };
}

/** Convenience for a probe that observed a defect. */
export function defect(
  observed: string,
  finding: Omit<Finding, 'id' | 'lane' | 'reproduction' | 'observed' | 'status'>,
): ProbeOutcome {
  return { held: false, observed, finding };
}
