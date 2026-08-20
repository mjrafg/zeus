/**
 * The Mission contract.
 *
 * A goal is a sentence. A contract is a set of claims each of which can be
 * PROVEN, FAILED, or — the load-bearing third case — left UNEVALUATED because
 * the thing that would prove it could not run. That distinction is the whole
 * point of this stage: it is `REQUIRED_TEST_NOT_RUN` one level up, and
 * collapsing it into FAILED would let a broken evaluator masquerade as a
 * verdict about the work.
 *
 * Everything in this file is deterministic. The compiler, critic and judge —
 * the parts that call a model — live in `compile.ts` and `evaluate.ts`, and
 * what they produce is a CLAIM that this file validates.
 */

import { sha256 } from '../engine/events';
import {
  Scope, ScopeMismatchError, localLabel, projectOf,
  isCriterionId, makeCriterionId, missionOfCriterion,
} from './types';

// Identity lives in types.ts with the other scopes: one place decides what an
// id names, so the answer cannot differ depending on which module was asked.
export { isCriterionId, makeCriterionId, missionOfCriterion };

/* ------------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------------ */

export const CRITERION_TYPES = ['EXECUTABLE', 'AI_JUDGED', 'EXTERNAL_FACT'] as const;
export type CriterionType = typeof CRITERION_TYPES[number];

/**
 * Per-criterion evaluation outcome.
 *
 * `UNEVALUATED` is not "no result yet" used loosely — it is the recorded fact
 * that the evaluator did not produce a verdict. A timeout, a policy refusal, a
 * contaminated judge payload and a cancelled probe all land here, because none
 * of them is a statement about whether the criterion holds.
 */
export const CRITERION_OUTCOMES = ['PROVEN', 'FAILED', 'UNEVALUATED'] as const;
export type CriterionOutcome = typeof CRITERION_OUTCOMES[number];

export const ACCEPTANCE_MODES = ['AUTO', 'OPTIONAL_CONFIRMATION', 'REQUIRED_CONSENT'] as const;
export type AcceptanceMode = typeof ACCEPTANCE_MODES[number];

/** Strictly ordered: the critic may move a mode UP this list, never down. */
export const MODE_RANK: Record<AcceptanceMode, number> =
  { AUTO: 0, OPTIONAL_CONFIRMATION: 1, REQUIRED_CONSENT: 2 };

/* ------------------------------------------------------------------------ *
 * Evaluators
 * ------------------------------------------------------------------------ */

/**
 * How many times a command evaluator runs. 1..10.
 *
 * Determinism is proven by repetition, and the vocabulary had no way to say
 * so. A real compile answered "make one flaky test deterministic" with
 * `for i in 1 2 3 4 5; do npm run test || exit 1; done` — semantically right,
 * and correctly refused, because a shell loop is proof logic hiding inside a
 * command string where the ledger cannot see it. `repeat` is the door; the
 * wall stays up.
 *
 * Bounded at 10 because this is a contract term, not a stress harness: N runs
 * cost N executions of real budget, and an unbounded N would let a criterion
 * spend a task's entire wall clock proving one thing.
 */
export const MAX_REPEAT = 10;

export type Evaluator =
  | { kind: 'command'; command: string; expect: 'PASSED' | 'TEST_FAILED'; repeat?: number }
  | { kind: 'rubric'; rubric: string; artifacts: string[] }
  | { kind: 'probe'; command: string; expect: 'PASSED' | 'TEST_FAILED'; requiresNetwork: boolean };

export const EVALUATOR_KINDS: Evaluator['kind'][] = ['command', 'rubric', 'probe'];

/** Which evaluator kind each criterion type must carry. */
export const EVALUATOR_FOR: Record<CriterionType, Evaluator['kind']> = {
  EXECUTABLE: 'command', AI_JUDGED: 'rubric', EXTERNAL_FACT: 'probe',
};

export interface Criterion {
  criterionId: string;
  /**
   * The compiler's own name for this criterion, kept for readability.
   *
   * The model names things well — `unit-tests-pass`, `no-scope-creep` — and
   * those names are worth showing a human. They are NOT identity: the
   * canonical id is assigned by Zeus, because asking a model to produce our
   * internal `/C-NNNN` format is asking it to count, and asking it to count is
   * asking for collisions.
   */
  slug?: string;
  /**
   * Set when the compiler named a declared command by its KEY and
   * normalisation resolved it to the command string. Recorded rather than
   * silently rewritten: a reader should be able to see that a substitution
   * happened.
   */
  resolvedFromKey?: string;
  type: CriterionType;
  /** The human-meaningful claim. IMMUTABLE once the oracle is accepted. */
  statement: string;
  /** How the statement is proven. Revisable with evidence and a critique. */
  evaluator: Evaluator;
  /** Globs or check names that make this cheap to re-evaluate when touched. */
  affectedBy: string[];
  required: boolean;
  /**
   * What the compiler DECLARES this criterion needs authority for. Declared,
   * not trusted: the mode function detects authority mechanically as well, and
   * the critic is asked whether anything was omitted here.
   */
  requiresAuthority: AuthorityKind[];
  /**
   * The observed fact this criterion was derived from — a currently-failing
   * check or a recorded finding. Empty means invented, which is exactly what
   * disqualifies a mission from AUTO.
   */
  derivedFrom: string[];
}

export interface Oracle {
  missionId: string;
  version: number;
  criteria: Criterion[];
  acceptanceMode: AcceptanceMode;
  compiledAt: string;
  acceptedAt?: string;
  compilerProviderId: string;
  criticProviderId: string;
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export type OracleFindingCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_CRITERION_ID'
  | 'EVALUATOR_MISSING'
  | 'RUBRIC_MISSING'
  | 'UNRESOLVABLE_EVALUATOR'
  | 'EVALUATOR_TYPE_MISMATCH'
  | 'REPEAT_OUT_OF_RANGE';

export interface OracleFinding {
  code: OracleFindingCode;
  severity: 'error' | 'info';
  criterionId?: string;
  detail: string;
}

export interface OracleValidation {
  valid: boolean;
  findings: OracleFinding[];
  criterionCount: number;
}

export interface ProjectContext {
  /** Commands the project declares, by name. The resolvable universe. */
  commands: Record<string, string>;
  /** Checks currently observed failing. Evidence a criterion may derive from. */
  failingChecks: string[];
  /** Recorded findings a criterion may derive from. */
  findings: string[];
}

const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Whether an evaluator command is something this project can actually run.
 *
 * A criterion whose proof cannot be executed is not a contract, it is a wish.
 * Resolvable means: it IS one of the declared commands, or it starts with one
 * (a declared runner with extra arguments).
 */
export function evaluatorResolves(command: string, ctx: ProjectContext): boolean {
  const declared = Object.values(ctx.commands ?? {}).filter(Boolean);
  const cmd = command.trim();
  if (!cmd) return false;
  return declared.some((d) => cmd === d || cmd.startsWith(`${d} `));
}

export function validateOracle(criteria: Criterion[], ctx: ProjectContext): OracleValidation {
  const findings: OracleFinding[] = [];
  const list = Array.isArray(criteria) ? criteria : [];
  const bad = (code: OracleFindingCode, criterionId: string | undefined, detail: string,
    severity: 'error' | 'info' = 'error') => findings.push({ code, severity, criterionId, detail });

  const seen = new Map<string, number>();
  list.forEach((c, i) => {
    const at = typeof c?.criterionId === 'string' && c.criterionId ? c.criterionId : `#${i}`;
    if (typeof c?.criterionId !== 'string' || !isCriterionId(c.criterionId)) {
      bad('SCHEMA_INVALID', at, 'criterionId must be a criterion-scoped id ending in /C-NNNN');
    } else {
      seen.set(c.criterionId, (seen.get(c.criterionId) ?? 0) + 1);
    }
    if (typeof c?.statement !== 'string' || c.statement.trim().length < 3) {
      bad('SCHEMA_INVALID', at, 'statement must be a non-empty claim');
    }
    if (!CRITERION_TYPES.includes(c?.type)) {
      bad('SCHEMA_INVALID', at, `type must be one of ${CRITERION_TYPES.join(', ')}`);
      return;                       // the checks below all key off the type
    }
    if (typeof c?.required !== 'boolean') bad('SCHEMA_INVALID', at, 'required must be a boolean');
    for (const key of ['affectedBy', 'requiresAuthority', 'derivedFrom'] as const) {
      if (!isStrings((c as any)?.[key])) bad('SCHEMA_INVALID', at, `${key} must be an array of strings`);
    }

    const ev = c?.evaluator as Evaluator | undefined;
    if (!ev || typeof ev !== 'object' || !EVALUATOR_KINDS.includes((ev as any).kind)) {
      // A criterion with no way to be proven is prose. "The code should be
      // clean" is not a contract term; the compiler must either produce an
      // evaluator or classify it AI_JUDGED with a rubric.
      bad('EVALUATOR_MISSING', at,
        `"${String(c?.statement ?? '').slice(0, 60)}" has no evaluator; a claim with no way to be proven is prose`);
      return;
    }
    if (ev.kind !== EVALUATOR_FOR[c.type]) {
      bad('EVALUATOR_TYPE_MISMATCH', at,
        `a ${c.type} criterion needs a ${EVALUATOR_FOR[c.type]} evaluator, not ${ev.kind}`);
      return;
    }
    if (ev.kind === 'rubric') {
      if (typeof ev.rubric !== 'string' || ev.rubric.trim().length < 10) {
        // Without a rubric, "the judge decides" means the judge invents the
        // standard at evaluation time — which is not a contract either.
        bad('RUBRIC_MISSING', at, 'an AI_JUDGED criterion needs a rubric stating what passing means');
      }
      if (!isStrings(ev.artifacts) || ev.artifacts.length === 0) {
        bad('SCHEMA_INVALID', at, 'an AI_JUDGED criterion must select the artifacts the judge is shown');
      }
    }
    if (ev.kind === 'command' || ev.kind === 'probe') {
      if (typeof ev.command !== 'string' || !ev.command.trim()) {
        bad('SCHEMA_INVALID', at, `${ev.kind} evaluator needs a command`);
      } else if (ev.kind === 'command' && !evaluatorResolves(ev.command, ctx)) {
        bad('UNRESOLVABLE_EVALUATOR', at,
          `"${ev.command}" is not one of this project's declared commands, so it cannot be run to prove anything`);
      }
      if (!['PASSED', 'TEST_FAILED'].includes((ev as any).expect)) {
        bad('SCHEMA_INVALID', at, 'expect must be PASSED or TEST_FAILED');
      }
      const repeat = (ev as any).repeat;
      if (repeat !== undefined
        && (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT)) {
        bad('REPEAT_OUT_OF_RANGE', at,
          `repeat must be a whole number between 1 and ${MAX_REPEAT} (got ${JSON.stringify(repeat)}); `
          + 'a repetition count is a contract term, not a stress-test dial');
      }
      if (ev.kind === 'probe' && typeof ev.requiresNetwork !== 'boolean') {
        bad('SCHEMA_INVALID', at, 'a probe must declare whether it requires the network');
      }
    }
  });

  for (const [id, n] of seen) {
    if (n > 1) bad('DUPLICATE_CRITERION_ID', id, `${n} criteria share the id "${id}"`);
  }

  return {
    valid: !findings.some((f) => f.severity === 'error'),
    findings,
    criterionCount: list.length,
  };
}

/* ------------------------------------------------------------------------ *
 * Authority detection and the acceptance mode
 * ------------------------------------------------------------------------ */

export const AUTHORITY_KINDS = ['SPEND', 'CREDENTIALS', 'DESTRUCTIVE_EXTERNAL', 'PUBLISH'] as const;
export type AuthorityKind = typeof AUTHORITY_KINDS[number];

/**
 * Authority a criterion's evaluator would exercise, detected from the command.
 *
 * Mechanical, and deliberately broad: a false positive costs one confirmation
 * prompt, a false negative spends someone's money or publishes something. The
 * compiler ALSO declares what it thinks it needs, and the two are unioned —
 * a declaration cannot lower the answer, only raise it.
 */
const AUTHORITY_PATTERNS: Array<{ kind: AuthorityKind; re: RegExp; what: string }> = [
  { kind: 'SPEND', re: /\b(purchase|checkout|billing|stripe|paypal|payment|invoice|subscribe)\b/i, what: 'a payment operation' },
  { kind: 'CREDENTIALS', re: /\b(login|signin|sign-in|authenticate|api[_-]?key|credential|oauth|token\s*=)\b/i, what: 'credential handling' },
  { kind: 'DESTRUCTIVE_EXTERNAL', re: /\b(drop\s+(table|database)|terraform\s+destroy|aws\s+\w+\s+delete|rm\s+-rf\s+\/(?!tmp))/i, what: 'a destructive external action' },
  { kind: 'PUBLISH', re: /\b(npm\s+publish|docker\s+push|git\s+push|helm\s+(install|upgrade)|kubectl\s+apply|terraform\s+apply|deploy)\b/i, what: 'publishing or deployment' },
];

export interface AuthorityHit { kind: AuthorityKind; criterionId: string; detail: string }

export function detectAuthority(criteria: Criterion[]): AuthorityHit[] {
  const hits: AuthorityHit[] = [];
  for (const c of criteria) {
    const ev = c.evaluator as any;
    const text = [ev?.command, ev?.rubric].filter((x) => typeof x === 'string').join('\n');
    for (const p of AUTHORITY_PATTERNS) {
      if (p.re.test(text)) {
        hits.push({ kind: p.kind, criterionId: c.criterionId, detail: `evaluator implies ${p.what}` });
      }
    }
    for (const declared of c.requiresAuthority ?? []) {
      if ((AUTHORITY_KINDS as readonly string[]).includes(declared)) {
        hits.push({ kind: declared, criterionId: c.criterionId, detail: 'declared by the compiler' });
      }
    }
  }
  return hits;
}

export interface ModeDecision {
  mode: AcceptanceMode;
  /** Every input the decision was made from, so it can be re-derived later. */
  inputs: {
    criterionCount: number;
    types: Record<string, number>;
    allExecutable: boolean;
    allResolvable: boolean;
    allDerivedFromEvidence: boolean;
    authority: AuthorityHit[];
  };
  /** Why, in the order the rules were applied. */
  reasons: string[];
}

/**
 * The acceptance mode, computed rather than proposed.
 *
 * A pure function over the validated oracle. The compiler never chooses the
 * mode for its own contract — asking the author of a promise how much scrutiny
 * the promise deserves is not a check, and a compiler that wanted less
 * oversight could simply ask for it. The compiler's only input here is
 * DECLARING facts (`requiresAuthority`), which can raise the mode and never
 * lower it, and which the critic is asked to check for omissions.
 */
export function computeAcceptanceMode(criteria: Criterion[], ctx: ProjectContext): ModeDecision {
  const types: Record<string, number> = {};
  for (const c of criteria) types[c.type] = (types[c.type] ?? 0) + 1;

  const authority = detectAuthority(criteria);
  const allExecutable = criteria.length > 0 && criteria.every((c) => c.type === 'EXECUTABLE');
  const allResolvable = criteria.every((c) => {
    const ev = c.evaluator as any;
    return ev?.kind === 'command' ? evaluatorResolves(ev.command, ctx) : false;
  });
  const known = new Set([...(ctx.failingChecks ?? []), ...(ctx.findings ?? [])]);
  const allDerivedFromEvidence = criteria.length > 0 && criteria.every(
    (c) => (c.derivedFrom ?? []).length > 0 && (c.derivedFrom ?? []).every((d) => known.has(d)));

  const inputs = { criterionCount: criteria.length, types, allExecutable, allResolvable,
    allDerivedFromEvidence, authority };
  const reasons: string[] = [];

  if (authority.length) {
    reasons.push(`authority Zeus does not have: ${[...new Set(authority.map((a) => a.kind))].join(', ')}`);
    return { mode: 'REQUIRED_CONSENT', inputs, reasons };
  }
  if (allExecutable && allResolvable && allDerivedFromEvidence) {
    reasons.push('every criterion is EXECUTABLE, resolves against a declared command, '
      + 'and was derived from currently observed evidence');
    return { mode: 'AUTO', inputs, reasons };
  }
  if (!allExecutable) reasons.push(`not every criterion is EXECUTABLE (${Object.keys(types).join(', ')})`);
  if (!allResolvable) reasons.push('at least one evaluator does not resolve to a declared command');
  if (!allDerivedFromEvidence) reasons.push('at least one criterion states a target nobody has observed');
  return { mode: 'OPTIONAL_CONFIRMATION', inputs, reasons };
}

/* ------------------------------------------------------------------------ *
 * Findings → consent floor
 * ------------------------------------------------------------------------ */

export type FindingFamily = 'evaluator-integrity' | 'scope-authority' | 'other';

/**
 * Which family a critic finding belongs to.
 *
 * Matched on SHAPE rather than an enumerated list, because the critic invents
 * codes: a real critique produced `EVALUATOR_DOES_NOT_PROVE_STATEMENT`,
 * `RUBRIC_TOO_WEAK` and `AI_JUDGED_MECHANICALLY_PROVABLE`, none of which were
 * in any list. A closed list would have silently sorted every one of them into
 * "other". Anything unrecognised still counts as a finding, so it still stops
 * the default acceptance — an unknown objection is not a resolved one.
 */
export function findingFamily(code: string): FindingFamily {
  if (/EVALUATOR|RUBRIC|MECHANICALLY_PROVABLE/i.test(code)) return 'evaluator-integrity';
  if (/BEYOND_GOAL|SCOPE|AUTHORITY|MISSING_CRITERION|WRONG_TYPE/i.test(code)) return 'scope-authority';
  return 'other';
}

export interface CriticFindingRef { code: string; criterionId?: string; detail?: string }

export interface FindingsFloor {
  floor: AcceptanceMode;
  findingCount: number;
  families: Record<FindingFamily, number>;
  /** The findings that forced the floor, so the decision can be re-derived. */
  forcedBy: Array<{ code: string; criterionId?: string }>;
  reasons: string[];
  /**
   * Whether acceptance may proceed without asking anyone. False whenever there
   * is ANY finding: the default path exists for a critique that objected to
   * nothing, and seven objections is not nothing.
   */
  autoAcceptable: boolean;
}

/**
 * The consent floor the critic's FINDINGS impose, independently of its opinion.
 *
 * This exists because of a real run. The critic produced seven findings —
 * including one saying an evaluator does not measure what it claims — and also
 * returned `modeOpinion: "AUTO"`. The escalate-only rule worked perfectly and
 * did nothing, because the opinion was the ONLY thing feeding the mode. A
 * critique that cannot affect the outcome is decoration, so the findings now
 * feed it directly and the opinion is no longer load-bearing.
 *
 * Floors only ever raise. Nothing here can lower the independently computed
 * mode.
 */
export function findingsFloor(findings: CriticFindingRef[]): FindingsFloor {
  const list = Array.isArray(findings) ? findings.filter((f) => f && typeof f.code === 'string') : [];
  const families: Record<FindingFamily, number> = { 'evaluator-integrity': 0, 'scope-authority': 0, other: 0 };
  for (const f of list) families[findingFamily(f.code)] += 1;

  const reasons: string[] = [];
  let floor: AcceptanceMode = 'AUTO';
  const forcedBy: Array<{ code: string; criterionId?: string }> = [];

  if (families['evaluator-integrity'] > 0) {
    // An oracle whose measuring instruments are contested may not be accepted
    // by default. If the ruler is disputed, nothing measured with it settles
    // anything.
    floor = 'REQUIRED_CONSENT';
    for (const f of list) {
      if (findingFamily(f.code) === 'evaluator-integrity') forcedBy.push({ code: f.code, criterionId: f.criterionId });
    }
    reasons.push(`${families['evaluator-integrity']} finding(s) contest an evaluator's validity`);
  } else if (list.length > 0) {
    floor = 'OPTIONAL_CONFIRMATION';
    for (const f of list) forcedBy.push({ code: f.code, criterionId: f.criterionId });
    reasons.push(`${list.length} finding(s) from the independent critique`);
  }

  return {
    floor, findingCount: list.length, families, forcedBy, reasons,
    // ANY finding means a human looks. The fast path is for a critique that
    // objected to nothing.
    autoAcceptable: list.length === 0,
  };
}

/**
 * The critic's opinion, applied.
 *
 * Escalate-only, by construction rather than by convention: the maximum of two
 * ranks cannot be lower than either. A critic that could lower the mode would
 * be a second place to argue for less oversight.
 */
export function applyCriticMode(computed: AcceptanceMode, opinion: AcceptanceMode | null):
  { mode: AcceptanceMode; escalated: boolean } {
  if (!opinion || !(ACCEPTANCE_MODES as readonly string[]).includes(opinion)) {
    return { mode: computed, escalated: false };
  }
  const mode = MODE_RANK[opinion] > MODE_RANK[computed] ? opinion : computed;
  return { mode, escalated: mode !== computed };
}

/** A stable identity for a compiled criteria set, recorded with the event. */
export function oracleHash(criteria: Criterion[]): string {
  return `sha256:${sha256(JSON.stringify(criteria)).slice(0, 32)}`;
}

export { Scope, ScopeMismatchError, localLabel, projectOf };
