/**
 * Compiling a goal into a contract, and having that contract criticised.
 *
 * Two model calls live here, and both produce CLAIMS rather than evidence.
 * The compiler proposes criteria; deterministic validation decides whether
 * they are a contract at all. The critic reads the goal and the criteria
 * independently and says whether the second is a faithful reading of the
 * first — through the same payload machinery the code reviewer uses, because
 * a second mechanism would be a second place for a leak to be possible.
 *
 * Neither model chooses how much scrutiny its own work receives. The
 * acceptance mode is computed by a pure function (`computeAcceptanceMode`),
 * and the critic may only push it UP.
 */

import { Provider, AgentResponse } from '../engine/providers';
import { ProcessSupervisor } from '../engine/exec';
import { ExecutionPolicy } from '../engine/policy';
import {
  buildReviewPayload, reconcileReviewerReport, ReviewPayload,
  ORACLE_CRITIQUE_POLICY,
} from '../engine/reviewcontext';
import {
  AcceptanceMode, Criterion, ModeDecision, OracleValidation, ProjectContext,
  applyCriticMode, computeAcceptanceMode, makeCriterionId, oracleHash, validateOracle,
  ACCEPTANCE_MODES, CriticFindingRef, FindingsFloor, findingsFloor,
} from './oracle';

export interface CompileInput {
  missionId: string;
  /**
   * A previous attempt and what the critic said about it.
   *
   * The review→fix pattern, lifted to the oracle layer: the COMPILER is shown
   * the findings so it can answer them. The CRITIC never is — a critic shown a
   * previous verdict reviews the verdict instead of the contract, which is the
   * contamination the payload policy exists to prevent.
   */
  prior?: { criteria: Criterion[]; findings: CriticFindingRef[]; version: number };
  projectId: string;
  goal: string;
  context: ProjectContext;
  provider: Provider;
  /** The model and effort Zeus resolved for this stage. Null = provider decides. */
  model?: string | null;
  reasoning?: string | null;
  stage?: string;
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  baseSha: string;
}

export interface CompileResult {
  ok: boolean;
  /** Provider-reported cost/tokens for the compile, when the CLI volunteered them. */
  providerUsage?: unknown;
  /** Set when the PROVIDER failed. Infrastructure, not a failed compile. */
  infrastructureFailure: string | null;
  criteria: Criterion[];
  validation: OracleValidation;
  compilerProviderId: string;
  structuredHash: string;
  raw: string;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Normalises whatever the model returned into the criterion shape.
 *
 * Deliberately forgiving about SHAPE and unforgiving about CONTENT: missing
 * fields become empty rather than throwing, and `validateOracle` then refuses
 * the result with a typed finding. A parser that throws turns "the model
 * produced a bad criterion" into "Zeus crashed", and loses the finding that
 * would have told someone which criterion.
 */
export function normaliseCriteria(missionId: string, raw: unknown, ctx?: ProjectContext): Criterion[] {
  const list = Array.isArray(raw) ? raw : [];
  const commands = ctx?.commands ?? {};
  return list.map((c: any, i) => {
    const ev = c?.evaluator ?? {};
    const kind = str(ev.kind);
    // The compiler names a declared command by its KEY roughly as often as by
    // its value, because the prompt hands it a map. Resolving the key here is
    // bookkeeping, not leniency: the command still has to be one this project
    // declared, and an unknown key stays unknown and fails validation.
    const rawCommand = str(ev.command);
    const resolvedFromKey = rawCommand && commands[rawCommand] ? rawCommand : undefined;
    const command = resolvedFromKey ? commands[resolvedFromKey] : rawCommand;
    const evaluator = kind === 'rubric'
      ? { kind: 'rubric' as const, rubric: str(ev.rubric), artifacts: arr(ev.artifacts) }
      : kind === 'probe'
        ? { kind: 'probe' as const, command,
            expect: (ev.expect === 'TEST_FAILED' ? 'TEST_FAILED' : 'PASSED') as 'PASSED' | 'TEST_FAILED',
            requiresNetwork: ev.requiresNetwork === true }
        : kind === 'command'
          ? { kind: 'command' as const, command,
              expect: (ev.expect === 'TEST_FAILED' ? 'TEST_FAILED' : 'PASSED') as 'PASSED' | 'TEST_FAILED',
              // Carried through UNVALIDATED on purpose: an out-of-range value
              // must reach validateOracle and be refused by name, not be
              // quietly clamped into something the compiler never proposed.
              ...(ev.repeat !== undefined ? { repeat: ev.repeat } : {}) }
          : (ev as any);
    const supplied = str(c?.criterionId);
    return {
      // ALWAYS canonical, and always ours. The model's id becomes a slug.
      criterionId: makeCriterionId(missionId, i + 1),
      ...(supplied && supplied !== makeCriterionId(missionId, i + 1) ? { slug: supplied } : {}),
      ...(resolvedFromKey ? { resolvedFromKey } : {}),
      type: c?.type,
      statement: str(c?.statement),
      evaluator,
      affectedBy: arr(c?.affectedBy),
      required: c?.required !== false,
      requiresAuthority: arr(c?.requiresAuthority) as Criterion['requiresAuthority'],
      derivedFrom: arr(c?.derivedFrom),
    } as Criterion;
  });
}

const COMPILE_HEADER = [
  'Compile this mission goal into a CONTRACT: a set of criteria, each of which',
  'can be proven or disproven. Reply with ONLY a JSON object:',
  '{"criteria":[{"criterionId":"...","type":"EXECUTABLE|AI_JUDGED|EXTERNAL_FACT",',
  ' "statement":"...","evaluator":{...},"affectedBy":[],"required":true,',
  ' "requiresAuthority":[],"derivedFrom":[]}]}',
  '',
  'An EXECUTABLE criterion carries {"kind":"command","command":"<command>","expect":"PASSED"}.',
  'The declared commands are given below as a MAP of name -> command line. Use',
  'the COMMAND LINE, not the name. If the map contains "unitTest": "npm test",',
  'then write   "command": "npm test"   and NOT   "command": "unitTest".',
  '',
  'Do not invent a criterionId; omit it, or use a short descriptive slug such as',
  '"unit-tests-pass". Zeus assigns the canonical identifier.',
  '',
  'To prove stability or determinism, add "repeat": N (1-10) to a declared',
  'command — Zeus runs it N times and proves the criterion only if every run',
  'passes. Never write shell loops, pipes or && chains inside "command": a',
  'command string is a command, not a script.',
  'For ad-hoc verification that is not a declared command, use EXTERNAL_FACT',
  'with a probe — inline verification is a probe, not a command.',
  'An AI_JUDGED criterion carries {"kind":"rubric","rubric":"<what passing means>","artifacts":["path"]}.',
  'An EXTERNAL_FACT criterion carries {"kind":"probe","command":"...","expect":"PASSED","requiresNetwork":false}.',
  '',
  'A claim with no way to be proven is not a criterion. Derive criteria from the',
  'evidence given; do not invent target states nobody has observed. Declare in',
  'requiresAuthority anything needing spending, credentials, destructive external',
  'action, or publishing.',
].join('\n');

/**
 * Model call #1.
 *
 * A provider failure is INFRASTRUCTURE, not a failed compile: the mission stays
 * in its pre-oracle state and can retry, exactly as a task treats a provider
 * outage as NEEDS_RECONCILIATION rather than a verdict.
 */
export async function compileOracle(input: CompileInput): Promise<CompileResult> {
  const priorSections = input.prior ? [
    `--- your previous attempt (oracle v${input.prior.version}) ---\n`
      + JSON.stringify(input.prior.criteria, null, 1),
    `--- an independent critic's findings on that attempt ---\n`
      + input.prior.findings.map((f) => `${f.code} ${f.criterionId ?? ''}: ${f.detail ?? ''}`).join('\n'),
    'Answer these findings. Remove criteria the critic showed to be beyond the goal,',
    'repair evaluators it showed do not measure what they claim, and declare any',
    'authority it says is undeclared. Produce the FULL criteria set again.',
  ] : [];

  const prompt = [
    COMPILE_HEADER, '',
    ...priorSections,
    `--- mission goal ---\n${input.goal}`,
    `--- declared commands ---\n${JSON.stringify(input.context.commands, null, 1)}`,
    `--- currently failing checks ---\n${(input.context.failingChecks ?? []).join('\n') || '(none)'}`,
    `--- recorded findings ---\n${(input.context.findings ?? []).join('\n') || '(none)'}`,
  ].join('\n');

  let res: AgentResponse;
  try {
    res = await input.provider.invoke({
      role: 'planner', taskId: input.missionId, projectId: input.projectId,
      model: input.model ?? null, reasoning: input.reasoning ?? null, stage: input.stage,
      prompt, policy: input.policy, readOnly: true,
    }, input.supervisor);
  } catch (e: any) {
    return {
      ok: false, infrastructureFailure: `compiler provider threw: ${e?.message ?? e}`,
      criteria: [], validation: { valid: false, findings: [], criterionCount: 0 },
      compilerProviderId: input.provider.id, structuredHash: oracleHash([]), raw: '',
    };
  }

  if (!res.ok || res.infrastructureFailure) {
    return {
      ok: false,
      infrastructureFailure: res.infrastructureFailure ?? `compiler outcome ${res.outcome}`,
      criteria: [], validation: { valid: false, findings: [], criterionCount: 0 },
      compilerProviderId: input.provider.id, structuredHash: oracleHash([]), raw: res.raw ?? '',
    };
  }
  if (!res.structured || !Array.isArray((res.structured as any).criteria)) {
    // Malformed output is the provider failing to answer, not the goal failing
    // to compile. Retryable, and the mission has not moved.
    return {
      ok: false,
      infrastructureFailure: 'compiler returned no parsable {"criteria":[...]} object',
      criteria: [], validation: { valid: false, findings: [], criterionCount: 0 },
      compilerProviderId: input.provider.id, structuredHash: oracleHash([]), raw: res.raw ?? '',
    };
  }

  const criteria = normaliseCriteria(input.missionId, (res.structured as any).criteria, input.context);
  return {
    ok: true, infrastructureFailure: null, criteria,
    ...(res.providerUsage ? { providerUsage: res.providerUsage } : {}),
    validation: validateOracle(criteria, input.context),
    compilerProviderId: input.provider.id,
    structuredHash: oracleHash(criteria),
    raw: res.raw ?? '',
  };
}

/* ------------------------------------------------------------------------ *
 * The independent critic
 * ------------------------------------------------------------------------ */

export interface CriticFinding {
  code: 'MISSING_CRITERION' | 'SCOPE_INVENTION' | 'WRONG_TYPE' | 'WEAK_RUBRIC'
    | 'IMPLAUSIBLE_EVALUATOR' | 'UNDECLARED_AUTHORITY';
  criterionId?: string;
  detail: string;
}

export interface CritiqueResult {
  ok: boolean;
  /** False when the payload was contaminated — the critique is then worthless. */
  valid: boolean;
  payload: ReviewPayload;
  findings: CriticFinding[];
  modeOpinion: AcceptanceMode | null;
  reconciliation: { consistent: boolean; unsupportedClaims: string[] };
  criticProviderId: string;
  infrastructureFailure: string | null;
  /**
   * What the critic's provider reported it cost.
   *
   * Attached at runtime since the transport work, but absent from this
   * interface — so a caller wanting to record the spend could not see it
   * without an `any`. Declared now: pre-execution spend is spend.
   */
  providerUsage?: unknown;
}

const CRITIQUE_HEADER = [
  'You are reviewing a compiled mission contract INDEPENDENTLY.',
  'You have the goal, the criteria, what this project can run, and the evidence',
  'that exists. You do NOT have the compiler\'s reasoning: form your own.',
  '',
  'Report: criteria the goal needs that are missing; criteria beyond the goal;',
  'criteria typed AI_JUDGED that could be proven mechanically; rubrics too weak',
  'to decide anything; evaluators that would not prove their statement; and',
  'authority the compiler failed to declare.',
  '',
  'Reply with ONLY: {"findings":[{"code":"...","criterionId":"...","detail":"..."}],',
  ' "modeOpinion":"AUTO|OPTIONAL_CONFIRMATION|REQUIRED_CONSENT","usedContext":[...]}',
].join('\n');

/**
 * Model call #2, through the shared payload machinery.
 *
 * A contaminated payload INVALIDATES the critique rather than annotating it:
 * the prompt is never handed over, and the caller records the violation. Same
 * rule, same code path and same failure mode as reviewer independence — this
 * is `buildReviewPayload` with a different policy, not a second mechanism.
 */
export async function critiqueOracle(input: {
  missionId: string; projectId: string; goal: string; criteria: Criterion[];
  context: ProjectContext; provider: Provider; supervisor: ProcessSupervisor;
  policy: ExecutionPolicy; baseSha: string;
  /** The model and effort Zeus resolved for this stage. Null = provider decides. */
  model?: string | null; reasoning?: string | null; stage?: string;
  /** Extra sections a caller wants delivered — used by tests to prove refusal. */
  extraInputs?: Array<{ kind: any; label: string; content: string }>;
}): Promise<CritiqueResult> {
  const payload = buildReviewPayload({
    taskId: input.missionId, projectId: input.projectId,
    baseSha: input.baseSha, headSha: input.baseSha,
    policy: ORACLE_CRITIQUE_POLICY,
    header: CRITIQUE_HEADER,
    inputs: [
      { kind: 'mission-goal', label: 'MISSION GOAL', content: input.goal },
      { kind: 'compiled-criteria', label: 'COMPILED CRITERIA', content: JSON.stringify(input.criteria, null, 1) },
      { kind: 'project-commands', label: 'PROJECT COMMANDS', content: JSON.stringify(input.context.commands, null, 1) },
      { kind: 'evidence-summary', label: 'EVIDENCE', content: [
        `failing checks: ${(input.context.failingChecks ?? []).join(', ') || '(none)'}`,
        `findings: ${(input.context.findings ?? []).join(', ') || '(none)'}`,
      ].join('\n') },
      ...(input.extraInputs ?? []),
    ],
  });

  if (!payload.valid) {
    return {
      ok: false, valid: false, payload, findings: [], modeOpinion: null,
      reconciliation: { consistent: false, unsupportedClaims: [] },
      criticProviderId: input.provider.id, infrastructureFailure: null,
    };
  }

  let res: AgentResponse;
  try {
    res = await input.provider.invoke({
      role: 'reviewer', taskId: input.missionId, projectId: input.projectId,
      model: input.model ?? null, reasoning: input.reasoning ?? null, stage: input.stage,
      prompt: payload.prompt, policy: input.policy, readOnly: true,
    }, input.supervisor);
  } catch (e: any) {
    return {
      ok: false, valid: true, payload, findings: [], modeOpinion: null,
      reconciliation: { consistent: true, unsupportedClaims: [] },
      criticProviderId: input.provider.id,
      infrastructureFailure: `critic provider threw: ${e?.message ?? e}`,
    };
  }
  if (!res.ok || res.infrastructureFailure || !res.structured) {
    return {
      ok: false, valid: true, payload, findings: [], modeOpinion: null,
      reconciliation: { consistent: true, unsupportedClaims: [] },
      criticProviderId: input.provider.id,
      infrastructureFailure: res.infrastructureFailure ?? `critic outcome ${res.outcome}`,
    };
  }

  const s = res.structured as any;
  const findings: CriticFinding[] = (Array.isArray(s.findings) ? s.findings : [])
    .map((f: any) => ({ code: str(f?.code) as CriticFinding['code'],
      criterionId: str(f?.criterionId) || undefined, detail: str(f?.detail) }))
    .filter((f: CriticFinding) => !!f.code);
  const opinion = str(s.modeOpinion);
  return {
    ok: true, valid: true, payload, findings,
    modeOpinion: (ACCEPTANCE_MODES as readonly string[]).includes(opinion)
      ? (opinion as AcceptanceMode) : null,
    reconciliation: reconcileReviewerReport(payload, res.structured),
    criticProviderId: input.provider.id, infrastructureFailure: null,
  };
}

export interface AcceptanceProposal {
  computed: ModeDecision;
  floor: FindingsFloor;
  mode: AcceptanceMode;
  escalatedByCritic: boolean;
  escalatedByFindings: boolean;
  /** False whenever a human must look before this oracle can be accepted. */
  autoAcceptable: boolean;
}

/**
 * The mode: computed, then raised by whichever of the critic's opinion and the
 * critic's FINDINGS asks for more scrutiny. Never lowered by either.
 *
 * Three inputs, one direction. The findings input exists because a real
 * critique returned seven findings and an opinion of AUTO, and the opinion was
 * the only thing the mode listened to.
 */
export function proposeAcceptance(criteria: Criterion[], ctx: ProjectContext,
  criticOpinion: AcceptanceMode | null,
  findings: CriticFindingRef[] = []): AcceptanceProposal {
  const computed = computeAcceptanceMode(criteria, ctx);
  const byOpinion = applyCriticMode(computed.mode, criticOpinion);
  const floor = findingsFloor(findings);
  const withFloor = applyCriticMode(byOpinion.mode, floor.floor);
  return {
    computed, floor, mode: withFloor.mode,
    escalatedByCritic: byOpinion.escalated,
    escalatedByFindings: withFloor.escalated,
    // A findings-free critique keeps the old fast path; anything else stops.
    autoAcceptable: floor.autoAcceptable,
  };
}
