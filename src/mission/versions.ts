/**
 * What version of each provider CLI Zeus last saw working.
 *
 * The drift lane exists because a provider CLI can change its output format
 * underneath Zeus overnight, and the failure mode of finding that out during a
 * mission is an hour and a budget spent discovering it. The lane was dead
 * until now: it read a config key that nothing ever wrote, so it reported
 * SKIPPED on every project forever. A check that can never fire is worse than
 * no check, because it still appears in the report.
 *
 * The baseline is DURABLE STATE, not an in-memory cache: it lives beside the
 * event log under the project state root, so a restart, a second process and a
 * fresh shell all compare against the same recorded fact. A cache that dies
 * with the process would make every first run of the day look like a baseline
 * and no run ever look like drift.
 */

import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets } from '../engine/redact';

export interface VersionRecord {
  version: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface VersionBaseline {
  providers: Record<string, VersionRecord>;
}

const EMPTY: VersionBaseline = { providers: {} };

export function baselinePath(stateRoot: string): string {
  return path.join(stateRoot, 'provider-versions.json');
}

/** Reads the baseline. A missing or unreadable file is "nothing recorded yet". */
export function readBaseline(stateRoot: string): VersionBaseline {
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath(stateRoot), 'utf8')) as VersionBaseline;
    if (!raw || typeof raw !== 'object' || !raw.providers || typeof raw.providers !== 'object') return EMPTY;
    // A malformed entry is dropped rather than trusted: a corrupt baseline that
    // still compares would silently answer DRIFT or PASS on garbage.
    const providers: Record<string, VersionRecord> = {};
    for (const [id, rec] of Object.entries(raw.providers)) {
      if (rec && typeof (rec as VersionRecord).version === 'string' && (rec as VersionRecord).version) {
        providers[id] = rec as VersionRecord;
      }
    }
    return { providers };
  } catch { return EMPTY; }
}

/**
 * Normalises a CLI's `--version` output into something safe to persist.
 *
 * First line only, whitespace collapsed, length-bounded, and run through the
 * same redactor the event sink uses. Provider CLIs print more than a version
 * when they feel like it, and a baseline file is not a place to discover that
 * one of them volunteered an account identifier.
 */
export function normaliseVersion(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  const { text } = redactSecrets(first.replace(/\s+/g, ' '));
  const clipped = text.slice(0, 120).trim();
  // An address-shaped token is an identity, not a version, whatever the CLI
  // called it. Dropped rather than redacted so nothing half-identifying lands.
  if (!clipped || /@|\bakia\b/i.test(clipped)) return null;
  return clipped;
}

export type VersionVerdict = 'BASELINE_RECORDED' | 'MATCH' | 'DRIFT' | 'UNKNOWN';

export interface VersionComparison {
  providerId: string;
  verdict: VersionVerdict;
  observed: string | null;
  baseline: string | null;
  detail: string;
}

/**
 * Compares one provider against the baseline, WITHOUT writing anything.
 *
 * Separated from the write so the decision can be tested without a filesystem,
 * and so a caller cannot accidentally establish a baseline by asking a
 * question about one.
 */
export function compareVersion(
  baseline: VersionBaseline, providerId: string, observed: string | null,
): VersionComparison {
  const known = baseline.providers[providerId]?.version ?? null;
  if (observed === null) {
    // Never PASS. "The CLI would not tell us" is not "the CLI is unchanged",
    // and recording the absence of an answer as agreement is the same error as
    // treating REQUIRED_TEST_NOT_RUN as a pass.
    return {
      providerId, verdict: 'UNKNOWN', observed: null, baseline: known,
      detail: known === null
        ? `${providerId} did not report a version, and none was recorded before`
        : `${providerId} did not report a version this time; the recorded baseline is "${known}"`,
    };
  }
  if (known === null) {
    return {
      providerId, verdict: 'BASELINE_RECORDED', observed, baseline: null,
      detail: `${providerId} ${observed} recorded as the baseline — a first contact is not drift`,
    };
  }
  if (known === observed) {
    return { providerId, verdict: 'MATCH', observed, baseline: known,
      detail: `${providerId} is still ${observed}` };
  }
  return {
    providerId, verdict: 'DRIFT', observed, baseline: known,
    detail: `${providerId} changed under Zeus: ${known} → ${observed}`,
  };
}

/**
 * Writes a first-contact baseline. Only ever writes when there was none.
 *
 * Drift does NOT update the baseline. Silently adopting the new version would
 * make the lane report drift exactly once and then forget, which is the same
 * as not reporting it — a human decides whether the new version is accepted,
 * and `acceptVersion` is how they say so.
 */
export function recordBaseline(
  stateRoot: string, providerId: string, version: string | null, at: string,
): { recorded: boolean; reason: string } {
  if (version === null) return { recorded: false, reason: 'no version was reported' };
  const current = readBaseline(stateRoot);
  const existing = current.providers[providerId];
  if (existing) {
    if (existing.version !== version) {
      return { recorded: false, reason: `a different baseline (${existing.version}) is already recorded` };
    }
    return writeBaseline(stateRoot, {
      providers: { ...current.providers, [providerId]: { ...existing, lastSeenAt: at } },
    }) ? { recorded: false, reason: 'the baseline was already this version; only lastSeenAt moved' }
      : { recorded: false, reason: 'the baseline could not be written' };
  }
  const ok = writeBaseline(stateRoot, {
    providers: { ...current.providers, [providerId]: { version, firstSeenAt: at, lastSeenAt: at } },
  });
  return ok ? { recorded: true, reason: 'first contact' } : { recorded: false, reason: 'the baseline could not be written' };
}

/** Deliberate human acceptance of a drifted version as the new baseline. */
export function acceptVersion(
  stateRoot: string, providerId: string, version: string, at: string,
): boolean {
  const current = readBaseline(stateRoot);
  const prior = current.providers[providerId];
  return writeBaseline(stateRoot, {
    providers: {
      ...current.providers,
      [providerId]: { version, firstSeenAt: prior?.firstSeenAt ?? at, lastSeenAt: at },
    },
  });
}

function writeBaseline(stateRoot: string, next: VersionBaseline): boolean {
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
    const tmp = `${baselinePath(stateRoot)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`, 'utf8');
    fs.renameSync(tmp, baselinePath(stateRoot));
    return true;
  } catch { return false; }
}
