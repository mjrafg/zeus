/**
 * Planning a mission, and having the plan criticised.
 *
 * Two model calls, both producing CLAIMS. Deterministic validation decides
 * whether the graph is coherent and whether it can possibly achieve the
 * contract; only then is anyone asked for an opinion about it.
 *
 * Every lesson the oracle layer learned the hard way is applied here without
 * having to re-learn it: node ids are OURS and the model's names become slugs,
 * the prompt distinguishes a command name from a command line, and the two
 * standing rules about probes and shell loops are stated rather than assumed.
 */

import { Provider, AgentResponse } from '../engine/providers';
import { ProcessSupervisor } from '../engine/exec';
import { ExecutionPolicy } from '../engine/policy';
import {
  buildReviewPayload, reconcileReviewerReport, ReviewPayload, ReviewInput,
  PLAN_CRITIQUE_POLICY,
} from '../engine/reviewcontext';
import { MissionRecord, PlanGraph, TaskNode } from './types';
import {
  CriterionScopeInput, PlanFinding, PlanValidation, validatePlanForOracle,
} from './plan';
import { Criterion, Oracle, ProjectContext } from './oracle';

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** `p/M-0001` + 3 → `p/M-0001/N-0003`. Node ids are ours, like criterion ids. */
export function makeNodeId(missionId: string, seq: number): string {
  return `${missionId}/N-${String(seq).padStart(4, '0')}`;
}

/**
 * Normalises whatever the planner returned into the node schema.
 *
 * Canonical ids ALWAYS, the model's name kept as a slug. Asking a model to
 * produce our internal id format is asking it to count; it produced good names
 * (`unit-tests-pass`, `no-scope-creep`) and those are worth showing a human.
 *
 * Criterion references are resolved from a slug or a bare local label to the
 * canonical criterion id where possible, for the same reason: the planner
 * knows the criteria by the names it can see.
 */
export function normaliseNodes(missionId: string, raw: unknown, criteria: Criterion[] = []): TaskNode[] {
  const list = Array.isArray(raw) ? raw : [];
  // Two ways the planner might name a criterion, both resolvable to one id.
  const byAlias = new Map<string, string>();
  for (const c of criteria) {
    byAlias.set(c.criterionId, c.criterionId);
    if (c.slug) byAlias.set(c.slug, c.criterionId);
    const local = c.criterionId.slice(c.criterionId.lastIndexOf('/') + 1);
    byAlias.set(local, c.criterionId);
  }
  // The planner names dependencies by ITS ids; we renumber, so the mapping
  // from its name to our id has to be built before dependsOn is rewritten.
  const idOf = new Map<string, string>();
  list.forEach((n: any, i) => {
    const supplied = str(n?.nodeId);
    if (supplied) idOf.set(supplied, makeNodeId(missionId, i + 1));
  });

  return list.map((n: any, i) => {
    const supplied = str(n?.nodeId);
    const nodeId = makeNodeId(missionId, i + 1);
    return {
      nodeId,
      ...(supplied && supplied !== nodeId ? { slug: supplied } : {}),
      description: str(n?.description),
      // Rewritten through the same mapping, or left as-is so a dangling
      // reference is REFUSED by the validator rather than silently dropped.
      dependsOn: arr(n?.dependsOn).map((d) => idOf.get(d) ?? d),
      preconditions: Array.isArray(n?.preconditions) ? n.preconditions : [],
      reads: arr(n?.reads),
      writes: arr(n?.writes),
      affectedCriteria: arr(n?.affectedCriteria).map((c) => byAlias.get(c) ?? c),
      predictedEffects: Array.isArray(n?.predictedEffects) ? n.predictedEffects : [],
      estimatedTier: ['FAST', 'NORMAL', 'DEEP'].includes(n?.estimatedTier) ? n.estimatedTier : 'NORMAL',
      estimatedCost: num(n?.estimatedCost, 1),
      risk: ['LOW', 'MEDIUM', 'HIGH'].includes(n?.risk) ? n.risk : 'MEDIUM',
    } as TaskNode;
  });
}

export const PLAN_HEADER = [
  'Plan the work that will satisfy this mission contract. Reply with ONLY a',
  'JSON object: {"nodes":[{ "nodeId":"a-slug", "description":"...",',
  ' "dependsOn":["another-slug"], "preconditions":[], "reads":[], "writes":[],',
  ' "affectedCriteria":["C-0001"], "predictedEffects":[], "estimatedTier":"FAST",',
  ' "estimatedCost":1.5, "risk":"LOW" }]}',
  '',
  'estimatedCost is YOUR ESTIMATE OF THE US DOLLAR COST of running that node,',
  'and it is compared against the mission budget before the plan is accepted.',
  'It is recorded and reported as an estimate, never as spend. Give a number',
  'you actually believe; a placeholder makes the budget check meaningless.',
  '',
  'Do not invent an internal id format: use a short descriptive slug for nodeId',
  'and refer to dependencies by the same slug. Zeus assigns canonical ids.',
  '',
  'EVERY required criterion must appear in at least one node\'s affectedCriteria.',
  'A plan that leaves one uncovered cannot achieve the mission and will be refused.',
  '',
  'predictedEffects are typed and are compared later against what actually',
  'happened, so only these three forms exist:',
  '  {"kind":"expectedCheckTransition","check":"<name>","from":"TEST_FAILED","to":"PASSED"}',
  '  {"kind":"expectedArtifact","path":"<path>","exists":true}',
  '  {"kind":"expectedStateFact","fact":"<fact>","value":"<value>"}',
  'Prose is not an effect: "improves error handling" cannot be compared to anything.',
  '',
  'Where a check is named, the declared commands are given below as a MAP of',
  'name -> command line. Use the NAME in a check transition ("unitTest"), and the',
  'COMMAND LINE only where a command is asked for ("npm test").',
  'Inline verification is a probe, not a command.',
  'To prove stability or determinism, use repeat on a declared command; never',
  'write shell loops.',
  '',
  'preconditions are facts checked immediately before the node runs, and only',
  'these five forms exist. A precondition nobody can answer FAILS, so state only',
  'what is checkable:',
  '  {"kind":"fileExists","target":"<path>"}',
  '  {"kind":"fileAbsent","target":"<path>"}',
  '  {"kind":"checkPassing","target":"<check name>"}',
  '  {"kind":"checkFailing","target":"<check name>"}',
  '  {"kind":"criterionState","target":"<criterion id>","value":"PROVEN"}',
  'There is no kind for "the working tree is clean", for a git state, or for',
  'anything phrased as prose. If a node needs something none of these can say,',
  'leave preconditions empty and put the requirement in the description.',
  '',
  'reads/writes are path globs and are used to detect nodes that would interfere',
  'if run together. Declare them honestly; an undeclared write is how two pieces',
  'of work destroy each other.',
].join('\n');

export interface PlanInput {
  missionId: string;
  projectId: string;
  goal: string;
  criteria: Criterion[];
  context: ProjectContext;
  provider: Provider;
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  baseSha: string;
  /** A previous attempt and what the critic said, for the fix loop. */
  prior?: { graph: PlanGraph; findings: PlanFinding[]; version: number };
}

export interface PlanResult {
  ok: boolean;
  /** Set when the PROVIDER failed. Infrastructure, retryable, not a bad plan. */
  infrastructureFailure: string | null;
  graph: PlanGraph;
  validation: PlanValidation;
  plannerProviderId: string;
  providerUsage?: unknown;
  raw: string;
}

/**
 * The evaluator text a scope can be read out of.
 *
 * Only the evaluator, never the statement. A statement is prose written for a
 * human — "zero implicit-any errors across src/" — and parsing prose for a
 * path is exactly the guessing the scope check refuses to do. The evaluator is
 * the machine-checkable half, so it is the half that gets parsed.
 */
export function scopeInputsFor(criteria: Criterion[]): CriterionScopeInput[] {
  return criteria.map((c) => {
    const ev = c.evaluator as any;
    const texts: string[] = [];
    if (ev?.kind === 'command' || ev?.kind === 'probe') {
      if (typeof ev.command === 'string') texts.push(ev.command);
    } else if (ev?.kind === 'rubric') {
      for (const a of (ev.artifacts ?? [])) if (typeof a === 'string') texts.push(a);
    }
    return { criterionId: c.criterionId, texts };
  });
}

export type OracleGate =
  | { ok: true; oracle: Oracle; criteria: Criterion[]; required: string[] }
  | { ok: false; code: 'NO_SUCH_MISSION' | 'ORACLE_NOT_COMPILED' | 'ORACLE_NOT_ACCEPTED'; message: string };

/**
 * The planner may not run until the mission has an ACCEPTED oracle in its log.
 *
 * Not merely a compiled one. A compiled oracle is a proposal about what
 * success means, and planning against a proposal produces a plan for a target
 * nobody agreed to — work that looks like progress right up to the moment the
 * contract changes underneath it. Read from the log rather than from a record
 * the caller passed in, for the same reason `spawnNode` is.
 */
export function requireAcceptedOracle(
  missions: { mission(id: string): MissionRecord | null }, missionId: string,
): OracleGate {
  const rec = missions.mission(missionId);
  if (!rec) return { ok: false, code: 'NO_SUCH_MISSION', message: `no mission ${missionId}` };
  if (!rec.oracle) {
    return { ok: false, code: 'ORACLE_NOT_COMPILED',
      message: `${missionId} has no compiled oracle; there is nothing to plan against` };
  }
  if (!rec.oracleAccepted) {
    return { ok: false, code: 'ORACLE_NOT_ACCEPTED',
      message: `${missionId} has a compiled oracle that nobody accepted; `
        + 'planning against an unaccepted contract plans for a target that can still change' };
  }
  // `MissionRecord.oracle` is deliberately `unknown` — stage 1 does not know
  // what an oracle is — so the shape is checked here rather than asserted.
  const oracle = rec.oracle as Oracle;
  if (!oracle || !Array.isArray(oracle.criteria)) {
    return { ok: false, code: 'ORACLE_NOT_COMPILED',
      message: `${missionId} has an oracle the log cannot read back as a contract` };
  }
  return { ok: true, oracle, criteria: oracle.criteria,
    required: oracle.criteria.filter((c) => c.required).map((c) => c.criterionId) };
}

/** Model call: propose a task graph for an accepted contract. */
export async function planMission(input: PlanInput): Promise<PlanResult> {
  const required = input.criteria.filter((c) => c.required).map((c) => c.criterionId);
  const scopeInputs = scopeInputsFor(input.criteria);
  const criteriaView = input.criteria.map((c) => ({
    criterionId: c.criterionId, slug: c.slug, required: c.required,
    statement: c.statement, type: c.type,
  }));
  const priorSections = input.prior ? [
    `--- your previous plan (v${input.prior.version}) ---\n${JSON.stringify(input.prior.graph.nodes, null, 1)}`,
    `--- findings against that plan ---\n${input.prior.findings.map((f) => `${f.code} ${f.nodeId ?? ''}: ${f.detail}`).join('\n')}`,
    'Answer these findings. Produce the FULL node set again.',
  ] : [];

  const prompt = [
    PLAN_HEADER, '',
    ...priorSections,
    `--- mission goal ---\n${input.goal}`,
    `--- accepted criteria ---\n${JSON.stringify(criteriaView, null, 1)}`,
    `--- declared commands ---\n${JSON.stringify(input.context.commands, null, 1)}`,
    `--- currently failing checks ---\n${(input.context.failingChecks ?? []).join('\n') || '(none)'}`,
    `--- recorded findings ---\n${(input.context.findings ?? []).join('\n') || '(none)'}`,
  ].join('\n');

  const empty: PlanGraph = { version: 0, nodes: [] };
  const fail = (why: string, raw = ''): PlanResult => ({
    ok: false, infrastructureFailure: why, graph: empty,
    validation: { valid: false, findings: [], roots: [], nodeCount: 0 },
    plannerProviderId: input.provider.id, raw,
  });

  let res: AgentResponse;
  try {
    res = await input.provider.invoke({
      role: 'planner', taskId: input.missionId, projectId: input.projectId,
      prompt, policy: input.policy, readOnly: true,
    }, input.supervisor);
  } catch (e: any) { return fail(`planner provider threw: ${e?.message ?? e}`); }

  if (!res.ok || res.infrastructureFailure) {
    return fail(res.infrastructureFailure ?? `planner outcome ${res.outcome}`, res.raw ?? '');
  }
  if (!res.structured || !Array.isArray((res.structured as any).nodes)) {
    return fail('planner returned no parsable {"nodes":[...]} object', res.raw ?? '');
  }

  const nodes = normaliseNodes(input.missionId, (res.structured as any).nodes, input.criteria);
  const graph: PlanGraph = { version: (input.prior?.version ?? 0) + 1, nodes };
  return {
    ok: true, infrastructureFailure: null, graph,
    validation: validatePlanForOracle(graph, required, scopeInputs),
    plannerProviderId: input.provider.id,
    ...(res.providerUsage ? { providerUsage: res.providerUsage } : {}),
    raw: res.raw ?? '',
  };
}

/* ------------------------------------------------------------------------ *
 * The plan critic
 * ------------------------------------------------------------------------ */

export interface PlanCriticFinding {
  code: string;
  /** BLOCKING rejects the plan outright; ADVISORY stops for rendered consent. */
  severity: 'BLOCKING' | 'ADVISORY';
  nodeId?: string;
  detail: string;
}

export interface PlanCritique {
  ok: boolean;
  valid: boolean;
  payload: ReviewPayload;
  findings: PlanCriticFinding[];
  reconciliation: { consistent: boolean; unsupportedClaims: string[] };
  criticProviderId: string;
  infrastructureFailure: string | null;
  providerUsage?: unknown;
}

export const PLAN_CRITIQUE_HEADER = [
  'Review this plan INDEPENDENTLY against the goal and the accepted criteria.',
  'You have the goal, the contract, the plan, what this project can run, the',
  'evidence that exists, and the deterministic validator\'s findings. You do NOT',
  'have the planner\'s reasoning or any previous critique: form your own.',
  '',
  'FOR EACH REQUIRED CRITERION: can the union of the plan\'s writes plausibly',
  'move it from FAILED to PROVEN? If not, say which criterion and why. A plan',
  'whose nodes name a criterion but touch a fraction of what the criterion is',
  'evaluated over will report FAILED after the work is paid for.',
  '',
  'Report: work a criterion needs that no node does; work beyond the goal;',
  'ordering that cannot succeed; interference the validator flagged that the plan',
  'does not acknowledge; predicted effects that will not happen; risk that is',
  'misjudged.',
  '',
  'Mark a finding BLOCKING only if the plan cannot succeed as written. Everything',
  'else is ADVISORY.',
  '',
  'Reply with ONLY: {"findings":[{"code":"...","severity":"BLOCKING|ADVISORY",',
  ' "nodeId":"...","detail":"..."}],"usedContext":[...]}',
].join('\n');

/**
 * Model call: an independent reading of the plan.
 *
 * Same machinery as the code reviewer and the oracle critic — a different
 * policy, not a different mechanism. A second mechanism would be a second
 * place for a leak to be possible.
 */
export async function critiquePlan(input: {
  missionId: string; projectId: string; goal: string;
  criteria: Criterion[]; graph: PlanGraph; validation: PlanValidation;
  context: ProjectContext; provider: Provider; supervisor: ProcessSupervisor;
  policy: ExecutionPolicy; baseSha: string;
  extraInputs?: ReviewInput[];
}): Promise<PlanCritique> {
  const payload = buildReviewPayload({
    taskId: input.missionId, projectId: input.projectId,
    baseSha: input.baseSha, headSha: input.baseSha,
    policy: PLAN_CRITIQUE_POLICY, header: PLAN_CRITIQUE_HEADER,
    inputs: [
      { kind: 'mission-goal', label: 'MISSION GOAL', content: input.goal },
      { kind: 'accepted-criteria', label: 'ACCEPTED CRITERIA',
        content: JSON.stringify(input.criteria.map((c) => ({ id: c.criterionId, required: c.required,
          statement: c.statement })), null, 1) },
      { kind: 'task-plan', label: 'PLAN', content: JSON.stringify(input.graph, null, 1) },
      { kind: 'project-commands', label: 'PROJECT COMMANDS', content: JSON.stringify(input.context.commands, null, 1) },
      { kind: 'evidence-summary', label: 'EVIDENCE', content: [
        `failing checks: ${(input.context.failingChecks ?? []).join(', ') || '(none)'}`,
        `findings: ${(input.context.findings ?? []).join(', ') || '(none)'}`,
      ].join('\n') },
      { kind: 'validator-findings', label: 'VALIDATOR FINDINGS',
        content: input.validation.findings.map((f) => `${f.code} ${f.nodeId ?? ''}: ${f.detail}`).join('\n')
          || '(the deterministic validator found nothing)' },
      ...(input.extraInputs ?? []),
    ],
  });

  const base = {
    payload, findings: [] as PlanCriticFinding[],
    reconciliation: { consistent: true, unsupportedClaims: [] as string[] },
    criticProviderId: input.provider.id,
  };
  if (!payload.valid) {
    return { ...base, ok: false, valid: false, infrastructureFailure: null,
      reconciliation: { consistent: false, unsupportedClaims: [] } };
  }

  let res: AgentResponse;
  try {
    res = await input.provider.invoke({
      role: 'reviewer', taskId: input.missionId, projectId: input.projectId,
      prompt: payload.prompt, policy: input.policy, readOnly: true,
    }, input.supervisor);
  } catch (e: any) {
    return { ...base, ok: false, valid: true, infrastructureFailure: `plan critic threw: ${e?.message ?? e}` };
  }
  if (!res.ok || res.infrastructureFailure || !res.structured) {
    return { ...base, ok: false, valid: true,
      infrastructureFailure: res.infrastructureFailure ?? `plan critic outcome ${res.outcome}` };
  }

  const findings: PlanCriticFinding[] = (Array.isArray((res.structured as any).findings)
    ? (res.structured as any).findings : [])
    .map((f: any) => ({
      code: str(f?.code), severity: f?.severity === 'BLOCKING' ? 'BLOCKING' : 'ADVISORY',
      nodeId: str(f?.nodeId) || undefined, detail: str(f?.detail),
    }))
    .filter((f: PlanCriticFinding) => !!f.code);

  return {
    ok: true, valid: true, payload, findings,
    reconciliation: reconcileReviewerReport(payload, res.structured),
    criticProviderId: input.provider.id, infrastructureFailure: null,
    ...(res.providerUsage ? { providerUsage: res.providerUsage } : {}),
  };
}

/**
 * What the critique means for acceptance — principle D, at the plan layer.
 *
 * The same discipline the oracle uses: blocking findings reject outright,
 * anything else stops for rendered consent, and only a findings-free critique
 * flows. A consent flag supplied in advance cannot answer a finding nobody has
 * seen.
 */
export interface PlanAcceptance {
  decision: 'REJECT' | 'STOP' | 'FLOW';
  blocking: PlanCriticFinding[];
  advisory: PlanCriticFinding[];
  reasons: string[];
}

export function planAcceptance(critique: PlanCritique): PlanAcceptance {
  if (!critique.valid) {
    return { decision: 'REJECT', blocking: [], advisory: [],
      reasons: ['the critique payload was contaminated, so there is no second opinion'] };
  }
  const blocking = critique.findings.filter((f) => f.severity === 'BLOCKING');
  const advisory = critique.findings.filter((f) => f.severity !== 'BLOCKING');
  if (blocking.length) {
    return { decision: 'REJECT', blocking, advisory,
      reasons: [`${blocking.length} blocking finding(s): the plan cannot succeed as written`] };
  }
  if (advisory.length) {
    return { decision: 'STOP', blocking, advisory,
      reasons: [`${advisory.length} finding(s) from the independent critique`] };
  }
  return { decision: 'FLOW', blocking, advisory, reasons: ['the critique raised nothing'] };
}
