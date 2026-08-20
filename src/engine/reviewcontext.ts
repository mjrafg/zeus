/**
 * Reviewer independence, enforced mechanically.
 *
 * The reviewer's value comes entirely from forming its own opinion. If the
 * planner's reasoning or the implementer's private transcript leaks into the
 * review prompt, the reviewer is no longer a second opinion — it is an echo,
 * and an echo that reports "no findings" is worse than no reviewer at all
 * because it looks like corroboration.
 *
 * Architecture alone does not prove this: a future edit could concatenate the
 * wrong string. So the payload the reviewer actually receives is assembled
 * here, inspected against a policy, hashed, and recorded. A violation
 * INVALIDATES the review rather than annotating it.
 */

import * as crypto from 'crypto';

export type ReviewInputKind =
  | 'task-requirement' | 'changed-files' | 'diff' | 'current-source'
  | 'test-evidence' | 'test-surface' | 'protected-paths' | 'structural-map' | 'area-context'
  | 'planner-reasoning' | 'planner-plan' | 'implementer-transcript'
  | 'implementer-rationale' | 'previous-review' | 'adjudication' | 'acceptance-verdict'
  // Mission Mode: the Oracle's own review surfaces. Same machinery, different
  // policies — a second payload mechanism would be a second place for a leak
  // to be possible.
  | 'mission-goal' | 'compiled-criteria' | 'project-commands' | 'evidence-summary'
  | 'criterion-rubric' | 'judged-artifact'
  | 'accepted-criteria' | 'task-plan' | 'validator-findings' | 'planner-transcript'
  | 'compiler-transcript' | 'compiler-reasoning' | 'critic-verdict' | 'judge-verdict';

/** What a reviewer may see, and what it must never see. */
export interface ReviewContextPolicy {
  allowed: ReviewInputKind[];
  forbidden: ReviewInputKind[];
  /** Cross-task semantic memory is off unless a policy explicitly enables it. */
  allowAreaContext: boolean;
}

/**
 * What the ORACLE CRITIC may see.
 *
 * The critic's job is to read the goal and the compiled criteria and say
 * whether the second is a faithful contract for the first. It must form that
 * opinion from the goal itself — so it gets the goal, the criteria, what the
 * project can actually run, and the evidence that exists. It must NOT get the
 * compiler's reasoning: a critic shown the argument for a set of criteria
 * tends to review the argument instead of the goal, which turns a second
 * opinion into a proofread.
 */
export const ORACLE_CRITIQUE_POLICY: ReviewContextPolicy = {
  allowed: ['mission-goal', 'compiled-criteria', 'project-commands', 'evidence-summary'],
  forbidden: [
    'compiler-transcript', 'compiler-reasoning', 'critic-verdict',
    'planner-reasoning', 'planner-plan', 'implementer-transcript', 'implementer-rationale',
    'previous-review', 'adjudication', 'acceptance-verdict', 'area-context',
  ],
  allowAreaContext: false,
};

/**
 * What the AI JUDGE may see.
 *
 * Only the rubric and the artifacts it selects. Not the implementer's output
 * about how hard the work was, not the compiler's or critic's reasoning, and
 * not what a previous judge concluded — a judge that can see "previously
 * judged satisfied" is being told the answer.
 */
export const ORACLE_JUDGE_POLICY: ReviewContextPolicy = {
  allowed: ['criterion-rubric', 'judged-artifact'],
  forbidden: [
    'implementer-transcript', 'implementer-rationale', 'compiler-transcript',
    'compiler-reasoning', 'critic-verdict', 'judge-verdict',
    'planner-reasoning', 'planner-plan', 'previous-review', 'adjudication',
    'acceptance-verdict', 'area-context',
  ],
  allowAreaContext: false,
};

/**
 * What the PLAN CRITIC may see.
 *
 * The goal, the contract, the plan, what the project can run, the evidence, and
 * the deterministic validator's findings — including the interference data,
 * which is a fact about the plan rather than an opinion about it. Not the
 * planner's reasoning, and not a previous critique: the planner seeing findings
 * is the fix loop, a critic seeing its past self is contamination.
 */
export const PLAN_CRITIQUE_POLICY: ReviewContextPolicy = {
  allowed: ['mission-goal', 'accepted-criteria', 'task-plan', 'project-commands',
    'evidence-summary', 'validator-findings'],
  forbidden: [
    'planner-transcript', 'planner-reasoning', 'planner-plan', 'critic-verdict',
    'compiler-transcript', 'compiler-reasoning', 'judge-verdict',
    'implementer-transcript', 'implementer-rationale', 'previous-review',
    'adjudication', 'acceptance-verdict', 'area-context',
  ],
  allowAreaContext: false,
};

export const DEFAULT_REVIEW_POLICY: ReviewContextPolicy = {
  allowed: [
    'task-requirement', 'changed-files', 'diff', 'current-source', 'test-evidence',
    // What the change did to the tests themselves. Facts from the diff, never
    // an opinion about them: the reviewer forms that.
    'test-surface',
    'protected-paths', 'structural-map',
  ],
  forbidden: [
    'planner-reasoning', 'planner-plan', 'implementer-transcript', 'implementer-rationale',
    'previous-review', 'adjudication', 'acceptance-verdict', 'area-context',
  ],
  allowAreaContext: false,
};

export interface ReviewInput {
  kind: ReviewInputKind;
  label: string;
  content: string;
}

export interface ReviewPayload {
  reviewInvocationId: string;
  taskId: string;
  projectId: string;
  baseSha: string;
  headSha: string;
  /** What policy says may be delivered. */
  configuredContext: ReviewInputKind[];
  /** What was actually assembled into the prompt. */
  deliveredContext: ReviewInputKind[];
  /** Per-section durable identifiers, so a later reader can check the claim. */
  hashes: Record<string, string>;
  promptHash: string;
  promptBytes: number;
  prompt: string;
  violations: ReviewContextViolation[];
  valid: boolean;
}

export interface ReviewContextViolation {
  code: 'REVIEW_CONTEXT_POLICY_VIOLATION';
  kind: ReviewInputKind | 'content-scan';
  detail: string;
}

export function hash(s: string): string {
  return `sha256:${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
}

/**
 * Content-level scan.
 *
 * The kind labels describe intent; this catches the case where forbidden
 * material is smuggled inside a section that claims to be something else —
 * a diff that happens to contain the planner's rationale, for instance.
 */
const LEAK_PATTERNS: Array<{ kind: ReviewInputKind; re: RegExp; what: string }> = [
  { kind: 'planner-reasoning', re: /<thinking>|<\/thinking>|chain[- ]of[- ]thought|"thinking":/i, what: 'model reasoning block' },
  { kind: 'planner-plan', re: /^\s*PLAN:\s|"scopeAllowlist"\s*:|DESIGN REVISION/mi, what: 'planner design output' },
  { kind: 'implementer-transcript', re: /"type"\s*:\s*"(assistant|tool_use|tool_result)"|IMPLEMENTER TRANSCRIPT/i, what: 'implementation agent transcript' },
  { kind: 'implementer-rationale', re: /^\s*(IMPLEMENTATION NOTES|why I chose|I decided to)\b/mi, what: 'implementer rationale' },
  { kind: 'previous-review', re: /PREVIOUS REVIEW|earlier reviewer (found|said)|"findingId"\s*:/i, what: 'a previous review verdict' },
  { kind: 'adjudication', re: /ADJUDICATION|adjudicated (required )?change/i, what: 'adjudication conclusion' },
  { kind: 'acceptance-verdict', re: /ACCEPTANCE VERDICT|previously accepted as/i, what: 'a prior acceptance verdict' },
  { kind: 'area-context', re: /^AREA CONTEXT\b/mi, what: 'cross-task area memory' },
  // The Oracle's equivalents. A critic that can see how the compiler argued
  // for its criteria is not an independent reading of the goal, and a judge
  // that can see a previous verdict is not judging the artifact.
  { kind: 'compiler-transcript', re: /COMPILER TRANSCRIPT|"role"\s*:\s*"compiler"/i, what: 'the compiler transcript' },
  { kind: 'compiler-reasoning', re: /COMPILER REASONING|I chose these criteria|why I compiled/i, what: 'the compiler reasoning' },
  { kind: 'critic-verdict', re: /CRITIC VERDICT|the critic (found|said)|"modeOpinion"\s*:/i, what: 'a critic verdict' },
  { kind: 'judge-verdict', re: /JUDGE VERDICT|previously judged (as )?satisfied|"satisfied"\s*:/i, what: 'a prior judge verdict' },
  { kind: 'planner-transcript', re: /PLANNER TRANSCRIPT|"role"\s*:\s*"planner"/i, what: 'the planner transcript' },
];

/**
 * Assembles the reviewer prompt and proves what went into it.
 *
 * Returns an invalid payload rather than throwing: the caller records the
 * violation as evidence and refuses the review, which is more useful than an
 * exception that loses the detail.
 */
export function buildReviewPayload(args: {
  taskId: string; projectId: string; baseSha: string; headSha: string;
  inputs: ReviewInput[];
  policy?: ReviewContextPolicy;
  header?: string;
}): ReviewPayload {
  const policy = args.policy ?? DEFAULT_REVIEW_POLICY;
  const violations: ReviewContextViolation[] = [];
  const hashes: Record<string, string> = {};
  const delivered: ReviewInputKind[] = [];
  const kept: ReviewInput[] = [];

  for (const input of args.inputs) {
    const isArea = input.kind === 'area-context';
    const permitted = policy.allowed.includes(input.kind) || (isArea && policy.allowAreaContext);
    if (!permitted) {
      violations.push({
        code: 'REVIEW_CONTEXT_POLICY_VIOLATION', kind: input.kind,
        detail: `"${input.label}" is ${input.kind}, which the review policy forbids`,
      });
      continue;   // never deliver it, even while reporting the violation
    }
    // A permitted section may still carry forbidden material inside it.
    for (const p of LEAK_PATTERNS) {
      if (policy.allowAreaContext && p.kind === 'area-context') continue;
      if (!policy.forbidden.includes(p.kind)) continue;
      if (p.re.test(input.content)) {
        violations.push({
          code: 'REVIEW_CONTEXT_POLICY_VIOLATION', kind: 'content-scan',
          detail: `"${input.label}" (${input.kind}) contains ${p.what}`,
        });
      }
    }
    hashes[input.label] = hash(input.content);
    delivered.push(input.kind);
    kept.push(input);
  }

  const header = args.header ?? [
    'Independently review this change against current source.',
    'No planning rationale, implementation notes or previous verdicts are included:',
    'your review must be your own, formed from the task and the code.',
  ].join('\n');

  const prompt = [header, '', ...kept.map((i) => `--- ${i.label} ---\n${i.content}`)].join('\n');
  const valid = violations.length === 0;

  return {
    reviewInvocationId: `RV-${crypto.randomBytes(8).toString('hex')}`,
    taskId: args.taskId, projectId: args.projectId,
    baseSha: args.baseSha, headSha: args.headSha,
    configuredContext: [...policy.allowed, ...(policy.allowAreaContext ? ['area-context' as ReviewInputKind] : [])],
    deliveredContext: [...new Set(delivered)],
    hashes,
    promptHash: hash(prompt),
    promptBytes: Buffer.byteLength(prompt),
    prompt: valid ? prompt : '',   // a contaminated prompt is never handed over
    violations, valid,
  };
}

/**
 * Compares what the reviewer SAYS it used against what was delivered.
 *
 * Self-report is never the source of truth; this exists so a reviewer claiming
 * to have read something it was never given is visible in the record.
 */
export function reconcileReviewerReport(payload: ReviewPayload, reported: unknown):
  { consistent: boolean; unsupportedClaims: string[] } {
  const claims: string[] = [];
  const r = reported as any;
  if (r && typeof r === 'object') {
    for (const key of ['usedContext', 'contextUsed', 'inputsUsed']) {
      if (Array.isArray(r[key])) claims.push(...r[key].map(String));
    }
  }
  const delivered = new Set<string>(payload.deliveredContext);
  const unsupported = claims.filter((c) => !delivered.has(c));
  return { consistent: unsupported.length === 0, unsupportedClaims: unsupported };
}
