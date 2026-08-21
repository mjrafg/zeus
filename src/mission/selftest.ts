/**
 * The preflight that runs BEFORE a mission spends real money.
 *
 * Everything Zeus knows about its providers it learned at some point in the
 * past — which CLI was installed, what its output looked like, whether the
 * credentials worked. Every one of those facts can be stale, and the failure
 * mode of a stale fact here is not a bad answer but a mission that burns an
 * hour and a budget discovering that the provider CLI changed its output
 * format overnight. Real provider contact found a real transport bug once
 * already; this is the check that finds the next one for five cents.
 *
 * The lanes deliberately return three states, not two. FAIL means the run
 * cannot proceed. DRIFT means something changed underneath Zeus and a human
 * should say whether to continue — automatically refusing would make every
 * provider release an outage, and automatically continuing would make it a
 * silent one.
 */

import { Provider } from '../engine/providers';
import { ProcessSupervisor } from '../engine/exec';
import { ExecutionPolicy } from '../engine/policy';
import { IsolationReport } from '../engine/isolation';
import { VersionComparison, compareVersion, normaliseVersion, readBaseline, recordBaseline } from './versions';

export type LaneStatus = 'PASS' | 'DRIFT' | 'FAIL' | 'SKIPPED';

export const SELFTEST_LANES = [
  'provider-contract', 'cli-version-drift', 'auth', 'quota', 'isolation-live',
] as const;
export type LaneId = typeof SELFTEST_LANES[number];

export interface LaneResult {
  lane: LaneId;
  status: LaneStatus;
  detail: string;
  /** Provider-reported spend for this lane. Never estimated. */
  costUsd: number | null;
  evidence: string[];
}

export interface SelftestReport {
  live: boolean;
  lanes: LaneResult[];
  /** Provider-reported total. Null when no provider reported anything. */
  costUsd: number | null;
  /** The ceiling this run was judged against, scaled to providers contacted. */
  costCapUsd: number;
  /** Providers actually contacted, which is what the cap is scaled by. */
  contacts: number;
  /**
   * True when at least one contact reported no price, so `costUsd` is a LOWER
   * BOUND rather than the total. An unpriced call is unknown, never free.
   */
  costIsLowerBound: boolean;
  unmeteredCalls: number;
  /** True when at least one lane failed: the mission must not start. */
  refused: boolean;
  /** True when something drifted: a human must confirm. */
  needsConfirmation: boolean;
  detail: string;
}

/**
 * What one metered provider contact has actually been observed to cost.
 *
 * MEASURED, not chosen. On 2026-08-20 a two-provider preflight against this
 * project reported $0.0695 in total, from ONE metered contact — the second
 * provider is subscription-billed and reports no cost at all. So the observed
 * price of a single metered contact is $0.0695, and that is the only cost
 * number in this file that came from anywhere but a provider.
 */
export const OBSERVED_CONTACT_COST_USD = 0.0695;

/**
 * Headroom over the single observation above.
 *
 * A judgement, and stated as one: there is exactly one measurement, so the
 * factor exists to absorb model and pricing variation rather than to encode
 * any distribution. Doubling keeps the cap tight enough that a preflight
 * costing an order of magnitude more still trips it.
 */
export const SELFTEST_HEADROOM = 2;

/** Per-contact ceiling, rounded up to the cent. */
export const SELFTEST_PER_CONTACT_CAP_USD =
  Math.ceil(OBSERVED_CONTACT_COST_USD * SELFTEST_HEADROOM * 100) / 100;

/**
 * The ceiling for a preflight that contacts `contacts` providers.
 *
 * The previous constant was a single whole-preflight figure sized as though
 * one provider would be contacted, so adding a second provider put an entirely
 * healthy preflight over the cap. A cap on the whole run has to scale with the
 * work the run actually does, or it measures the project's provider topology
 * rather than the preflight's cost.
 */
export function selftestCostCap(contacts: number): number {
  return Number((SELFTEST_PER_CONTACT_CAP_USD * Math.max(1, contacts)).toFixed(2));
}

/** The smallest exchange that still exercises the whole transport. */
const CONTRACT_PROMPT =
  'Reply with exactly this JSON object and nothing else: {"zeus_selftest":"ok"}';

export interface SelftestInput {
  providers: Provider[];
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  projectId: string;
  isolation: IsolationReport;
  /**
   * Where the durable version baseline lives. Absent means the lane cannot
   * record anything and says so, rather than quietly passing.
   */
  stateRoot?: string;
  /** Reads a provider CLI's current version string, or null if it cannot. */
  versionOf?: (providerId: string) => string | null;
  /** Clock, injected so the baseline's timestamps are testable. */
  now?: () => string;
  timeoutSeconds?: number;
}

const lane = (id: LaneId, status: LaneStatus, detail: string,
  evidence: string[] = [], costUsd: number | null = null): LaneResult =>
  ({ lane: id, status, detail, costUsd, evidence });

/**
 * Runs the live preflight.
 *
 * MAKES REAL PROVIDER CALLS. That is the entire point: a mock provider proves
 * that Zeus can talk to a mock, and the thing that breaks in production is
 * everything between Zeus and the real CLI.
 */
export async function selftestLive(input: SelftestInput): Promise<SelftestReport> {
  const lanes: LaneResult[] = [];
  const at = (input.now ?? (() => new Date().toISOString()))();
  let cost = 0;
  let metered = 0;
  let unmeteredCalls = 0;
  let contacts = 0;

  /* -- auth + provider contract, in one real call per provider ------------ */

  for (const provider of input.providers) {
    const avail = await provider.available();
    if (!avail.ok) {
      lanes.push(lane('auth', 'FAIL', `${provider.id}: ${avail.detail}`, [`provider:${provider.id}`]));
      lanes.push(lane('provider-contract', 'SKIPPED',
        `${provider.id} is unavailable, so nothing was sent to it`, [`provider:${provider.id}`]));
      continue;
    }

    contacts += 1;
    const res = await provider.invoke({
      role: 'reviewer', taskId: `${input.projectId}/selftest`, projectId: input.projectId,
      prompt: CONTRACT_PROMPT, policy: input.policy, readOnly: true,
      timeoutSeconds: input.timeoutSeconds ?? 60,
    }, input.supervisor);

    const reported = res.providerUsage?.totalCostUsd;
    if (typeof reported === 'number' && Number.isFinite(reported)) { cost += reported; metered += 1; }
    else unmeteredCalls += 1;

    if (res.infrastructureFailure) {
      lanes.push(lane('auth', 'FAIL', `${provider.id}: ${res.infrastructureFailure}`,
        [`provider:${provider.id}`, `outcome:${res.outcome}`], reported ?? null));
      continue;
    }
    lanes.push(lane('auth', 'PASS', `${provider.id} accepted the request`,
      [`provider:${provider.id}`, `outcome:${res.outcome}`], reported ?? null));

    // The contract is not "did it answer" but "did the TRANSPORT deliver a
    // parsed object". A provider that answers correctly through a stream
    // wrapper Zeus cannot unwrap is a provider Zeus cannot use.
    const value = res.structured?.zeus_selftest;
    if (!res.ok) {
      lanes.push(lane('provider-contract', 'FAIL',
        `${provider.id} returned ${res.outcome}`, [`provider:${provider.id}`], reported ?? null));
    } else if (res.structured === null) {
      lanes.push(lane('provider-contract', 'FAIL',
        `${provider.id} produced output the transport could not unwrap into JSON`,
        [`provider:${provider.id}`, `chars:${res.text.length}`], reported ?? null));
    } else if (value !== 'ok') {
      // Parsed, but not what was asked for. DRIFT rather than FAIL: the
      // transport works, and the model declining to follow a trivial
      // instruction is a quality signal, not a broken pipe.
      lanes.push(lane('provider-contract', 'DRIFT',
        `${provider.id} parsed cleanly but answered ${JSON.stringify(value ?? null)} rather than "ok"`,
        [`provider:${provider.id}`], reported ?? null));
    } else {
      lanes.push(lane('provider-contract', 'PASS',
        `${provider.id} round-tripped a structured answer`, [`provider:${provider.id}`], reported ?? null));
    }

    /* -- quota, from what the CLI volunteered --------------------------- */

    const rl = res.rateLimit as { limited?: boolean; detail?: string } | undefined;
    if (rl && rl.limited) {
      lanes.push(lane('quota', 'FAIL', `${provider.id}: ${rl.detail ?? 'rate limited'}`,
        [`provider:${provider.id}`]));
    } else if (rl) {
      lanes.push(lane('quota', 'PASS', `${provider.id}: ${rl.detail ?? 'quota available'}`,
        [`provider:${provider.id}`]));
    } else {
      // Not a pass. "The CLI said nothing about quota" is not "there is
      // quota", and recording it as one is how a mission starts on an
      // account that ran out an hour ago.
      lanes.push(lane('quota', 'SKIPPED',
        `${provider.id} reported no quota information`, [`provider:${provider.id}`]));
    }
  }

  if (!input.providers.length) {
    lanes.push(lane('auth', 'FAIL', 'no providers are configured'));
    lanes.push(lane('provider-contract', 'FAIL', 'no providers are configured'));
    lanes.push(lane('quota', 'SKIPPED', 'no providers are configured'));
  }

  /* -- CLI version drift ------------------------------------------------- */

  const versionOf = input.versionOf;
  const comparisons: VersionComparison[] = [];
  if (!versionOf || !input.stateRoot) {
    lanes.push(lane('cli-version-drift', 'SKIPPED',
      'no durable state root, so a version baseline can neither be read nor recorded'));
  } else {
    const baseline = readBaseline(input.stateRoot);
    for (const provider of input.providers) {
      const observed = normaliseVersion(versionOf(provider.id));
      const cmp = compareVersion(baseline, provider.id, observed);
      comparisons.push(cmp);
      // Recorded only on a genuine first contact. A drifted version is NOT
      // adopted: adopting it would make the lane report drift exactly once and
      // then forget, which is indistinguishable from never reporting it.
      if (cmp.verdict === 'BASELINE_RECORDED' || cmp.verdict === 'MATCH') {
        recordBaseline(input.stateRoot, provider.id, observed, at);
      }
    }
    const drifted = comparisons.filter((c) => c.verdict === 'DRIFT');
    const unknown = comparisons.filter((c) => c.verdict === 'UNKNOWN');
    const fresh = comparisons.filter((c) => c.verdict === 'BASELINE_RECORDED');
    const ev = comparisons.map((c) => `${c.providerId}:${c.verdict}`);

    if (drifted.length) {
      lanes.push(lane('cli-version-drift', 'DRIFT',
        drifted.map((c) => c.detail).join('; '), ev));
    } else if (!comparisons.length) {
      lanes.push(lane('cli-version-drift', 'SKIPPED', 'no providers to ask', ev));
    } else if (unknown.length) {
      // A silence is not a verdict in either direction. It is not DRIFT —
      // nothing was observed to change, and blocking a mission on a CLI that
      // declined to print a version would be a refusal with no finding behind
      // it. It is emphatically not PASS either, so the lane goes unevaluated
      // and says which provider went quiet and what baseline is now unchecked.
      lanes.push(lane('cli-version-drift', 'SKIPPED',
        unknown.map((c) => c.detail).join('; ')
        + (unknown.length < comparisons.length
          ? ` (${comparisons.length - unknown.length} other provider(s) did answer)` : ''), ev));
    } else if (fresh.length) {
      lanes.push(lane('cli-version-drift', 'PASS',
        fresh.map((c) => c.detail).join('; '), ev));
    } else {
      lanes.push(lane('cli-version-drift', 'PASS',
        `every provider CLI is the recorded baseline (${comparisons.map((c) => c.observed).join(', ')})`, ev));
    }
  }

  /* -- isolation, as it is actually enforced on this host ---------------- */

  const iso = input.isolation;
  if (iso.fallbackMode || iso.resourceEnforcement === 'none') {
    lanes.push(lane('isolation-live', 'DRIFT',
      `isolation is running in fallback mode (${iso.selected}, ${iso.resourceEnforcement}); `
      + iso.resourceDetail, [`backend:${iso.selected}`]));
  } else {
    lanes.push(lane('isolation-live', 'PASS',
      `${iso.selected} with ${iso.resourceEnforcement} enforcement`, [`backend:${iso.selected}`]));
  }

  /* -- the verdict -------------------------------------------------------- */

  const failed = lanes.filter((l) => l.status === 'FAIL');
  const cap = selftestCostCap(contacts);
  const overCap = cost > cap;
  if (overCap) {
    lanes.push(lane('provider-contract', 'DRIFT',
      `the preflight itself cost $${cost.toFixed(4)} across ${contacts} contact(s), `
      + `over its $${cap.toFixed(2)} cap`
      + (unmeteredCalls ? ` — and ${unmeteredCalls} contact(s) reported no price, so the real total is higher` : '')));
  }
  const drifted = lanes.filter((l) => l.status === 'DRIFT');

  return {
    live: true, lanes,
    costUsd: metered ? Number(cost.toFixed(6)) : null,
    costCapUsd: cap,
    contacts,
    costIsLowerBound: unmeteredCalls > 0,
    unmeteredCalls,
    refused: failed.length > 0,
    needsConfirmation: drifted.length > 0 || overCap,
    detail: failed.length
      ? `${failed.length} lane(s) failed: ${failed.map((l) => l.lane).join(', ')}`
      : drifted.length || overCap
        ? `${drifted.length + (overCap ? 1 : 0)} lane(s) drifted; a human must confirm before the mission runs`
        : 'every lane passed',
  };
}
