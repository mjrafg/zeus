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
/**
 * Whether a PERSON already refused this exact stop.
 *
 * `decidable` used to mean only "a critique exists and nothing accepted it",
 * which stays true after a refusal — so the console recorded the answer and
 * then asked the identical question again, for ever, with no way forward.
 *
 * Keyed on version AND the digest of the findings, because a refusal answers
 * the findings that were on screen; a fresh critique of the same version is a
 * different question and deserves to be asked. `decidedBy` must be a person:
 * the engine records REFUSED_NO_CONSENT with 'nobody yet' when it stops for
 * want of a decision, and treating that as an answer would hide the stop.
 */
function refusedByAPerson(log: StoredEvent[], version: number, digest: string): boolean {
  return [...log].reverse().some((e) => {
    if (e.type !== 'PLAN_STOP_DECISION') return false;
    const p = (e.payload ?? {}) as any;
    if (p.version !== version) return false;
    if (p.decidedBy !== 'user-confirmed') return false;
    if (p.findingsDigest && p.findingsDigest !== digest) return false;
    return String(p.decision ?? '').startsWith('REFUSED')
      || String(p.decision ?? '') === 'ORACLE_REFUSED';
  });
}

export function consentSubject(missions: MissionRegistry, missionId: string,
  kind: ConsentKind): ConsentSubject | null {
  const log: StoredEvent[] = missions.events.read(missionId);
  const rec = missions.mission(missionId);
  if (!rec) return null;

  if (kind === 'oracle') {
    const critique = [...log].reverse().find((e) => e.type === 'ORACLE_CRITIQUED');
    const version = rec.oracleVersion ?? 0;
    const findings = (critique?.payload as any)?.findings ?? [];
    const digest = findingsDigest(findings);
    const answered = refusedByAPerson(log, version, digest);
    return {
      kind, version, findings, digest,
      decidable: !rec.terminated && !!critique && !!rec.oracle && !rec.oracleAccepted
        && !answered,
      detail: !rec.oracle ? 'no oracle has been compiled'
        : rec.oracleAccepted ? 'this oracle is already accepted'
          : !critique ? 'no critique on the log — there is no second opinion to consent over'
            : answered
              ? `oracle v${version} was refused; the next move is a recompile that answers `
                + `its ${findings.length} finding(s)`
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
  const planDigest = findingsDigest(findings);
  const planAnswered = refusedByAPerson(log, version, planDigest);
  return {
    kind, version, findings, digest: planDigest,
    decidable: !rec.terminated && !!recorded && !!critique && !cp.contaminated
      && cp.acceptance !== 'REJECT' && rec.acceptedPlanVersion !== version
      && !planAnswered,
    detail: !recorded ? 'no plan has been recorded'
      : !critique ? `plan v${version} has no critique on the log; there is no second opinion to consent over`
        : cp.contaminated ? `the critique of plan v${version} was contaminated, so it is not a second opinion`
          : cp.acceptance === 'REJECT' ? `the critique REJECTED plan v${version}; it cannot be accepted by consent`
            : rec.acceptedPlanVersion === version ? `plan v${version} is already accepted`
              : planAnswered
                ? `plan v${version} was refused; the next move is a new plan`
                : `${findings.length} finding(s) stand against plan v${version}`,
  };
}

export interface ConsentRequest {
  kind: ConsentKind;
  version: number;
  findingsDigest: string;
  /** ABORT cancels the mission — a decision, recorded like any other. */
  decision: 'ACCEPT' | 'REFUSE' | 'ABORT';
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
  if (!['ACCEPT', 'REFUSE', 'ABORT'].includes(req.decision)) {
    return { ok: false, code: 'BAD_REQUEST',
      message: 'decision must be ACCEPT, REFUSE or ABORT', current: null };
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

/* ------------------------------------------------------------------------ *
 * What is waiting for a human, reconstructed
 * ------------------------------------------------------------------------ */

export interface PendingDecisionOption {
  id: string;
  label: string;
  detail: string;
}

export interface PendingDecision {
  layer: ConsentKind;
  version: number;
  /** The findings AS RENDERED when the stop happened. Not a summary. */
  findings: unknown[];
  digest: string;
  options: PendingDecisionOption[];
  /**
   * How this stop came about — a CLI run with no terminal, a web stop, or an
   * inference from the log's shape. Recorded so a reader knows whether anyone
   * has ever actually seen these findings.
   */
  source: string;
  detail: string;
}

/**
 * The decision a mission is waiting on, derived from the LOG.
 *
 * PRINCIPLE A, at the last place that was still ignoring it. Everything else
 * in this system decides from the reconstruction; consent rendering leaned on
 * the live event instead, so a refresh, a reconnect, or simply arriving later
 * showed a mission that needed a human with no way to answer it. The stop was
 * always in the log — nothing was lost, it just was not being read.
 *
 * Pending means: the layer is decidable and nobody has decided. For the plan
 * layer a stop is an explicit event; for the oracle layer it is the ABSENCE of
 * an acceptance after a critique, because the CLI's oracle stop writes no event
 * of its own. Both are facts about the log, and neither is a session.
 *
 * The oracle comes first when both are open: a plan cannot be answered while
 * the contract it was built against is still unagreed.
 */
export function pendingDecision(missions: MissionRegistry,
  missionId: string): PendingDecision | null {
  const rec = missions.mission(missionId);
  if (!rec || rec.terminated) return null;

  for (const layer of ['oracle', 'plan'] as ConsentKind[]) {
    const subject = consentSubject(missions, missionId, layer);
    if (!subject || !subject.decidable) continue;

    const log = missions.events.read(missionId);
    // A recorded stop tells us a human was shown this. Its absence means the
    // stop happened somewhere that writes no event — worth saying, not hiding.
    const stop = [...log].reverse().find((e) => e.type === 'PLAN_STOP_DECISION'
      && (e.payload as any)?.version === subject.version);
    const stopped = stop && String((stop.payload as any)?.decision ?? '').startsWith('STOPPED');
    const source = stopped
      ? ((stop!.payload as any)?.deferred
        ? 'DEFERRED_NON_TTY — the run had no terminal to ask, so it stopped and recorded'
        : 'stopped for consent and recorded')
      : 'inferred from the log: a critique exists and nothing accepted it';

    const options: PendingDecisionOption[] = layer === 'oracle'
      ? [
        { id: 'accept', label: 'Accept the contract',
          detail: 'record these findings as accepted-despite and proceed to planning' },
        { id: 'recompile', label: 'Send the findings back',
          detail: 'ask the compiler to answer them and produce a new contract' },
        { id: 'abort', label: 'Cancel the mission',
          detail: 'stop here; the mission terminates CANCELLED and nothing is accepted' },
      ]
      : [
        { id: 'accept', label: 'Accept the plan',
          detail: 'record these findings as accepted-despite and allow the nodes to spawn' },
        { id: 'replan', label: 'Ask for a new plan',
          detail: 'invalidate this plan and have the planner produce another' },
        { id: 'abort', label: 'Cancel the mission',
          detail: 'stop here; the mission terminates CANCELLED and nothing is accepted' },
      ];

    return {
      layer, version: subject.version, findings: subject.findings,
      digest: subject.digest, options, source, detail: subject.detail,
    };
  }
  return null;
}

/** Whether a mission is waiting on a person. Same predicate, one line. */
export function awaitingHuman(missions: MissionRegistry, missionId: string): boolean {
  return pendingDecision(missions, missionId) !== null;
}
