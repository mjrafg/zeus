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
  unmeteredCalls: number;
  /** True when at least one lane failed: the mission must not start. */
  refused: boolean;
  /** True when something drifted: a human must confirm. */
  needsConfirmation: boolean;
  detail: string;
}

/**
 * The ceiling for the whole preflight.
 *
 * Small on purpose. A preflight that can cost real money is a preflight people
 * disable, and a disabled preflight is worth less than no preflight at all
 * because it is still in the docs.
 */
export const SELFTEST_COST_CAP_USD = 0.05;

/** The smallest exchange that still exercises the whole transport. */
const CONTRACT_PROMPT =
  'Reply with exactly this JSON object and nothing else: {"zeus_selftest":"ok"}';

export interface SelftestInput {
  providers: Provider[];
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  projectId: string;
  isolation: IsolationReport;
  /** The provider CLI versions recorded when the project was last set up. */
  recordedVersions?: Record<string, string>;
  /** Reads a provider CLI's current version string, or null if it cannot. */
  versionOf?: (providerId: string) => string | null;
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
  let cost = 0;
  let metered = 0;
  let unmeteredCalls = 0;

  /* -- auth + provider contract, in one real call per provider ------------ */

  for (const provider of input.providers) {
    const avail = await provider.available();
    if (!avail.ok) {
      lanes.push(lane('auth', 'FAIL', `${provider.id}: ${avail.detail}`, [`provider:${provider.id}`]));
      lanes.push(lane('provider-contract', 'SKIPPED',
        `${provider.id} is unavailable, so nothing was sent to it`, [`provider:${provider.id}`]));
      continue;
    }

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

  const recorded = input.recordedVersions ?? {};
  const versionOf = input.versionOf;
  if (!versionOf || !Object.keys(recorded).length) {
    lanes.push(lane('cli-version-drift', 'SKIPPED',
      'no provider CLI versions were recorded, so drift cannot be detected'));
  } else {
    const drifted: string[] = [];
    const gone: string[] = [];
    for (const [id, was] of Object.entries(recorded)) {
      const now = versionOf(id);
      if (now === null) gone.push(id);
      else if (now !== was) drifted.push(`${id}: ${was} → ${now}`);
    }
    if (gone.length) {
      lanes.push(lane('cli-version-drift', 'FAIL',
        `cannot read the version of ${gone.join(', ')}`, gone.map((g) => `provider:${g}`)));
    } else if (drifted.length) {
      lanes.push(lane('cli-version-drift', 'DRIFT',
        `the provider CLI changed under Zeus — ${drifted.join('; ')}`, drifted));
    } else {
      lanes.push(lane('cli-version-drift', 'PASS', 'every provider CLI is the recorded version'));
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
  const drifted = lanes.filter((l) => l.status === 'DRIFT');
  const overCap = cost > SELFTEST_COST_CAP_USD;
  if (overCap) {
    lanes.push(lane('provider-contract', 'DRIFT',
      `the preflight itself cost $${cost.toFixed(4)}, over its $${SELFTEST_COST_CAP_USD.toFixed(2)} cap`));
  }

  return {
    live: true, lanes,
    costUsd: metered ? Number(cost.toFixed(6)) : null,
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
