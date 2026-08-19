/**
 * What Zeus says when it needs a person.
 *
 * The cost of an interruption is not the interruption. It is the time between
 * the notification and the moment work resumes — reading the task, rebuilding
 * the context, working out what is actually being asked, deciding, and then
 * discovering the decision was not the one that unblocks it. "Task needs
 * attention" outsources all of that to the human.
 *
 * So a human-attention state without a complete payload is treated as a defect
 * in Zeus, not as a message. `validateEscalation` is what makes that
 * enforceable, and it is used by the engine as well as by the tests.
 */

export type EscalationReason =
  | 'MISSING_CREDENTIAL'
  | 'MISSING_ENVIRONMENT'
  | 'AMBIGUOUS_REQUIREMENT'
  | 'TASK_BUDGET_EXCEEDED'
  | 'REQUIRED_TEST_TAMPERED'
  | 'TEST_SURFACE_UNJUSTIFIED'
  | 'REQUIRED_TEST_NOT_RUN'
  | 'NO_VERIFICATION_CONFIGURED'
  | 'REVIEW_CONTEXT_POLICY_VIOLATION'
  | 'REVIEW_FINDINGS_BLOCKING'
  | 'INTEGRATION_CONFLICT'
  | 'PROVIDER_OUTAGE'
  | 'POLICY_APPROVAL_REQUIRED';

/** A pointer into evidence that already exists, so nothing is re-explained. */
export interface EvidenceRef {
  kind: 'check' | 'review' | 'event' | 'file' | 'finding' | 'commit';
  id: string;
  detail?: string;
}

export interface NeededInput {
  /** What kind of thing will unblock this. */
  kind: 'credential' | 'decision' | 'information' | 'fix' | 'approval';
  /** The single specific thing. Not a list of possibilities. */
  description: string;
  /** How to supply it, when that is not obvious. */
  how?: string;
  /** Illustrative, never a real value. */
  example?: string;
}

export interface EscalationPayload {
  taskId: string;
  reasonCode: EscalationReason;
  /** One sentence: what cannot proceed. */
  blocked: string;
  /** What Zeus already attempted, so nobody suggests it again. */
  tried: string[];
  evidence: EvidenceRef[];
  needed: NeededInput;
  /** What happens automatically once the need is met. */
  resumeBehavior: string;
  createdAt: string;
}

export interface EscalationProblem { field: string; detail: string }

const PLACEHOLDERS = [
  /^task needs attention\.?$/i,
  /^needs attention\.?$/i,
  /^see logs?\.?$/i,
  /^(unknown|unclear|something went wrong)\.?$/i,
  /^error\.?$/i,
];

/**
 * Rejects a payload that would waste the human's time.
 *
 * The checks are about substance rather than length: a specific need, real
 * evidence to look at, and a stated resume behaviour so the person knows
 * whether they are unblocking a pipeline or adopting a task.
 */
export function validateEscalation(p: Partial<EscalationPayload>): EscalationProblem[] {
  const problems: EscalationProblem[] = [];
  const bare = (s?: string) => !s || !s.trim() || PLACEHOLDERS.some((re) => re.test(s.trim()));

  if (!p.taskId) problems.push({ field: 'taskId', detail: 'the escalation names no task' });
  if (!p.reasonCode) {
    problems.push({ field: 'reasonCode', detail: 'a machine-readable reason code is required' });
  }
  if (bare(p.blocked)) {
    problems.push({ field: 'blocked', detail: 'say what is blocked and why; "needs attention" is not a reason' });
  } else if ((p.blocked ?? '').trim().split(/\s+/).length < 4) {
    problems.push({ field: 'blocked', detail: 'too terse to act on without opening the task' });
  }
  if (!Array.isArray(p.tried) || !p.tried.length) {
    problems.push({ field: 'tried', detail: 'list what Zeus already attempted, so the human does not repeat it' });
  }
  if (!Array.isArray(p.evidence) || !p.evidence.length) {
    problems.push({ field: 'evidence', detail: 'reference the checks, reviews or events that show the problem' });
  }
  if (!p.needed || bare(p.needed.description)) {
    problems.push({ field: 'needed', detail: 'name the ONE specific decision or piece of information required' });
  }
  if (bare(p.resumeBehavior)) {
    problems.push({ field: 'resumeBehavior', detail: 'say what happens automatically once the need is met' });
  }
  return problems;
}

export function isComplete(p: Partial<EscalationPayload>): boolean {
  return validateEscalation(p).length === 0;
}

/**
 * Builds a payload, stamping the time.
 *
 * Returns the payload even when incomplete: the caller records the problems
 * rather than silently dropping an escalation, because a malformed request for
 * help is still better than silence.
 */
export function escalation(
  p: Omit<EscalationPayload, 'createdAt'>,
  now = new Date().toISOString(),
): { payload: EscalationPayload; problems: EscalationProblem[] } {
  const payload: EscalationPayload = { ...p, createdAt: now };
  return { payload, problems: validateEscalation(payload) };
}

/** The short human-facing form. Designed to be read on a phone. */
export function renderEscalation(p: EscalationPayload): string {
  const lines = [
    `${p.taskId} blocked: ${p.blocked}`,
    `  Tried: ${p.tried.join('; ')}`,
    `  Needed: ${p.needed.description}${p.needed.how ? ` — ${p.needed.how}` : ''}`,
  ];
  if (p.needed.example) lines.push(`  Example: ${p.needed.example}`);
  lines.push(`  On receipt: ${p.resumeBehavior}`);
  if (p.evidence.length) {
    lines.push(`  Evidence: ${p.evidence.map((e) => `${e.kind}:${e.id}`).join(', ')}`);
  }
  lines.push(`  Reason code: ${p.reasonCode}`);
  return lines.join('\n');
}
