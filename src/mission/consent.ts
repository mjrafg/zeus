/**
 * Informed consent, made mechanical.
 *
 * The UI's job is to RENDER; the server's job is to REFUSE. A button is a
 * convenience and proves nothing about what a person saw — a stale tab, a
 * replayed request, a script written against yesterday's findings all press it
 * identically. So consent carries a digest of the findings it is answering,
 * and the server recomputes that digest from the LOG at the moment of the
 * decision. Mismatch means the human was looking at something else, and the
 * answer is refusal plus the current findings, never acceptance.
 *
 * This is principle A and principle D in one function: the check derives from
 * the event log, and no argument to it can wave the findings away. There is
 * deliberately no force flag, no `--yes` analogue, and no "I already read
 * them" parameter. Those are the shapes this exists to prevent.
 */

import * as crypto from 'crypto';
import { MissionRegistry } from './registry';
import { StoredEvent } from '../engine/events';

export type ConsentKind = 'oracle' | 'plan';

/**
 * A stable digest of what was rendered.
 *
 * Canonicalised by sorting keys, so a JSON serialiser that reorders fields
 * cannot invalidate a decision a human genuinely made — and so that a caller
 * cannot manufacture a match by reordering either.
 */
export function findingsDigest(findings: unknown[]): string {
  const canon = JSON.stringify(findings, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 32);
}

export interface ConsentSubject {
  kind: ConsentKind;
  version: number;
  findings: unknown[];
  digest: string;
  /** Nothing to decide: no critique on the log for this version. */
  decidable: boolean;
  detail: string;
}

/** What a human would currently be shown, derived from the log. */
export function consentSubject(missions: MissionRegistry, missionId: string,
  kind: ConsentKind): ConsentSubject | null {
  const log: StoredEvent[] = missions.events.read(missionId);
  const rec = missions.mission(missionId);
  if (!rec) return null;

  if (kind === 'oracle') {
    const critique = [...log].reverse().find((e) => e.type === 'ORACLE_CRITIQUED');
    const version = rec.oracleVersion ?? 0;
    const findings = (critique?.payload as any)?.findings ?? [];
    return {
      kind, version, findings, digest: findingsDigest(findings),
      decidable: !!critique && !!rec.oracle && !rec.oracleAccepted,
      detail: !rec.oracle ? 'no oracle has been compiled'
        : rec.oracleAccepted ? 'this oracle is already accepted'
          : !critique ? 'no critique on the log — there is no second opinion to consent over'
            : `${findings.length} finding(s) stand against oracle v${version}`,
    };
  }

  const recorded = [...log].reverse().find((e) => e.type === 'PLAN_RECORDED');
  const version = (recorded?.payload as any)?.version ?? 0;
  const critique = [...log].reverse().find((e) => e.type === 'PLAN_CRITIQUED'
    && (e.payload as any)?.version === version);
  const cp = (critique?.payload ?? {}) as any;
  const scope = ((recorded?.payload as any)?.scopeFindings ?? []) as unknown[];
  const findings = [...((cp.findings ?? []) as unknown[]), ...scope];
  return {
    kind, version, findings, digest: findingsDigest(findings),
    decidable: !!recorded && !!critique && !cp.contaminated
      && cp.acceptance !== 'REJECT' && rec.acceptedPlanVersion !== version,
    detail: !recorded ? 'no plan has been recorded'
      : !critique ? `plan v${version} has no critique on the log; there is no second opinion to consent over`
        : cp.contaminated ? `the critique of plan v${version} was contaminated, so it is not a second opinion`
          : cp.acceptance === 'REJECT' ? `the critique REJECTED plan v${version}; it cannot be accepted by consent`
            : rec.acceptedPlanVersion === version ? `plan v${version} is already accepted`
              : `${findings.length} finding(s) stand against plan v${version}`,
  };
}

export interface ConsentRequest {
  kind: ConsentKind;
  version: number;
  findingsDigest: string;
  decision: 'ACCEPT' | 'REFUSE';
}

export type ConsentVerdict =
  | { ok: true; subject: ConsentSubject }
  | {
    ok: false;
    code: 'NO_SUCH_MISSION' | 'NOTHING_TO_CONFIRM' | 'VERSION_DRIFT' | 'DIGEST_MISMATCH'
    | 'BAD_REQUEST';
    message: string;
    /** Always returned on refusal: the caller is told what to render next. */
    current: ConsentSubject | null;
  };

/**
 * Decides whether a confirm may proceed. Reads the log; trusts nothing else.
 *
 * Version drift and digest mismatch are separate codes on purpose. "The plan
 * changed under you" and "the findings changed under you" are different things
 * for a human to be told, and collapsing them into one error would leave the
 * reader guessing which happened.
 */
export function evaluateConsent(missions: MissionRegistry, missionId: string,
  req: ConsentRequest): ConsentVerdict {
  if (req.kind !== 'oracle' && req.kind !== 'plan') {
    return { ok: false, code: 'BAD_REQUEST', message: 'kind must be oracle or plan', current: null };
  }
  if (req.decision !== 'ACCEPT' && req.decision !== 'REFUSE') {
    return { ok: false, code: 'BAD_REQUEST', message: 'decision must be ACCEPT or REFUSE', current: null };
  }
  const current = consentSubject(missions, missionId, req.kind);
  if (!current) {
    return { ok: false, code: 'NO_SUCH_MISSION', message: `unknown mission ${missionId}`, current: null };
  }
  if (!current.decidable) {
    return { ok: false, code: 'NOTHING_TO_CONFIRM', message: current.detail, current };
  }
  if (current.version !== req.version) {
    return {
      ok: false, code: 'VERSION_DRIFT', current,
      message: `you answered v${req.version}; the log now holds v${current.version}`
        + ' — re-read the findings before deciding',
    };
  }
  if (current.digest !== req.findingsDigest) {
    return {
      ok: false, code: 'DIGEST_MISMATCH', current,
      message: 'the findings changed since they were rendered to you'
        + ` (you answered ${req.findingsDigest.slice(0, 8)}, the log now digests to `
        + `${current.digest.slice(0, 8)}) — re-read them before deciding`,
    };
  }
  return { ok: true, subject: current };
}
