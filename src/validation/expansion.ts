/**
 * The reviewer's request to validate more, and its limits.
 *
 * A reviewer noticing "this touches the session refresh path, run those tests
 * too" is one of the most valuable things in the pipeline: it is a second
 * opinion turning into concrete evidence. So expansion stays allowed.
 *
 * What it does not get is an unbounded loop. "Run everything to be safe" is
 * not a review finding — it is the absence of one, and honouring it converts
 * every task into a full-suite run while looking like diligence. So an
 * expansion must name a concrete affected behaviour, it costs a review cycle,
 * and repeatedly expanding without finding anything is itself recorded.
 */

import { Tier, TierDecision, escalateDecision } from './tier';

export type ExpansionCode =
  | 'REVIEW_EXPANSION_ACCEPTED'
  | 'REVIEW_EXPANSION_VAGUE'
  | 'REVIEW_EXPANSION_BUDGET_EXHAUSTED'
  | 'REVIEW_EXPANSION_UNPRODUCTIVE';

export interface ExpansionRequest {
  /** The concrete behaviour the reviewer believes may be affected. */
  behavior: string;
  /** Why the current validation does not already cover it. */
  rationale?: string;
  /** Optional specific checks or paths the reviewer wants exercised. */
  scope?: string[];
}

export interface ExpansionState {
  /** Expansions already granted for this task. */
  granted: number;
  budget: number;
  /** Findings produced by each previously granted expansion. */
  findingsPerExpansion: number[];
}

export interface ExpansionVerdict {
  accepted: boolean;
  code: ExpansionCode;
  detail: string;
  /** Present when accepted. */
  tier?: Tier;
  /** Recorded whether accepted or not — a refused request is still evidence. */
  request: ExpansionRequest;
}

/**
 * Phrases that describe caution rather than a behaviour.
 *
 * Matching one is not automatically fatal — "run everything, because the
 * session refresh path may be affected" is a real request with a padded
 * opening. It is fatal only when nothing concrete survives alongside it.
 */
const VAGUE = [
  /\brun (everything|it all|the (whole|full|entire) suite)\b/i,
  /\b(to be|just to be|for) safe(ty)?\b/i,
  /\bjust in case\b/i,
  /\bbetter safe than sorry\b/i,
  /\b(all|every) tests?\b/i,
  /\b(not sure|unsure|no idea|unclear) (what|which|if)\b/i,
  /\bfull (regression|validation)\b/i,
];

/** Something specific enough to point at in the codebase or the product. */
const CONCRETE = [
  /[A-Za-z0-9_]+\.[A-Za-z0-9_]{2,}/,               // a path or a dotted symbol
  /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/,        // camelCase identifier
  /\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/,               // kebab or snake identifier
  /\b(login|logout|signup|refresh|expiry|expiration|rollback|migration|checkout|payment|upload|download|pagination|cache|retry|timeout|permission|session|token)\b/i,
];

export interface ConcretenessResult {
  concrete: boolean;
  matchedVague: string[];
  reason: string;
}

/**
 * Decides whether a request names a behaviour or merely expresses anxiety.
 *
 * Deterministic on purpose: no model is asked to judge this, because the
 * judgement gates how much validation runs and would be trivially talked
 * around by a more eloquent request.
 */
export function assessConcreteness(req: ExpansionRequest): ConcretenessResult {
  const text = `${req.behavior ?? ''} ${req.rationale ?? ''}`.trim();
  const matchedVague = VAGUE.filter((re) => re.test(text)).map((re) => re.source);

  if (text.length < 12 || text.split(/\s+/).filter(Boolean).length < 3) {
    return { concrete: false, matchedVague, reason: 'the request names no behaviour at all' };
  }
  const hasScope = Array.isArray(req.scope) && req.scope.some((s) => /[\/.]/.test(s));
  const hasConcreteToken = CONCRETE.some((re) => re.test(req.behavior ?? ''));
  if (!hasConcreteToken && !hasScope) {
    return {
      concrete: false, matchedVague,
      reason: matchedVague.length
        ? 'the request asks for more validation without naming an affected behaviour'
        : 'the request names no identifiable behaviour, module or path',
    };
  }
  return { concrete: true, matchedVague, reason: 'names a concrete affected behaviour' };
}

/**
 * Evaluates one expansion request against the budget.
 *
 * Budget is checked after concreteness so that a vague request is refused for
 * the honest reason rather than silently absorbing a cycle.
 */
export function evaluateExpansion(req: ExpansionRequest, state: ExpansionState): ExpansionVerdict {
  const c = assessConcreteness(req);
  if (!c.concrete) {
    return {
      accepted: false, code: 'REVIEW_EXPANSION_VAGUE', request: req,
      detail: `${c.reason}. Name the behaviour that may be affected, for example "session refresh may break for expired tokens".`,
    };
  }
  if (state.granted >= state.budget) {
    return {
      accepted: false, code: 'REVIEW_EXPANSION_BUDGET_EXHAUSTED', request: req,
      detail: `the reviewer expansion budget for this task is exhausted (${state.granted}/${state.budget}); the request is recorded but not granted`,
    };
  }
  return {
    accepted: true, code: 'REVIEW_EXPANSION_ACCEPTED', request: req,
    detail: `expansion granted (${state.granted + 1}/${state.budget}): ${req.behavior}`,
  };
}

/** Applies an accepted expansion by escalating one tier. */
export function applyExpansion(decision: TierDecision, req: ExpansionRequest): TierDecision {
  return escalateDecision(decision, 'reviewerExpansion', `reviewer named an affected behaviour: ${req.behavior}`);
}

export interface UnproductiveSignal {
  code: 'REVIEW_EXPANSION_UNPRODUCTIVE';
  expansions: number;
  findings: number;
  detail: string;
}

/**
 * Repeated expansion that finds nothing is a signal in its own right.
 *
 * It usually means the reviewer is uncertain rather than informed, and that is
 * worth seeing in telemetry — both to tune the review prompt and to notice a
 * reviewer that has started asking for everything.
 */
export function unproductiveExpansion(state: ExpansionState, minimumExpansions = 2): UnproductiveSignal | null {
  if (state.findingsPerExpansion.length < minimumExpansions) return null;
  const findings = state.findingsPerExpansion.reduce((a, b) => a + b, 0);
  if (findings > 0) return null;
  return {
    code: 'REVIEW_EXPANSION_UNPRODUCTIVE',
    expansions: state.findingsPerExpansion.length, findings,
    detail: `${state.findingsPerExpansion.length} reviewer expansions produced no findings; the reviewer is expanding without evidence`,
  };
}
