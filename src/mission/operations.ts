/**
 * Compile and plan, as engine operations rather than CLI internals.
 *
 * These lived inside `cmdMission`, which meant the only way to reach them was
 * to be the CLI. A second caller — the web console — would have had to
 * reimplement the sequence, and a reimplemented sequence is a second engine
 * with a different opinion about when a contract is accepted. So the
 * capability moved into the engine and both callers now invoke it: the CLI
 * renders the result, the web serialises it, and neither decides anything.
 *
 * NOTHING HERE PRINTS. An operation that writes to stdout cannot be called by
 * a server, and an operation that decides what a human sees has taken a
 * decision that belongs to the caller.
 */

import { MissionRegistry } from './registry';
import { Engine } from '../engine/orchestrator';
import { ExecutionPolicy } from '../engine/policy';
import {
  Criterion, Oracle, OracleFinding, ProjectContext,
} from './oracle';
import { compileOracle, critiqueOracle, proposeAcceptance } from './compile';
import {
  critiquePlan, planAcceptance, planMission, requireAcceptedOracle, PlanCriticFinding,
} from './planner';
import { PlanFinding } from './plan';
import { PlanGraph } from './types';
import { BudgetNegotiation, applyBudgetRevisions, mergeMissionBudgets, negotiateBudget } from './progress';

export interface CriticFindingRef { code: string; criterionId?: string; detail: string }

export interface OperationContext {
  missions: MissionRegistry;
  engine: Engine;
  projectRoot: string;
  context: ProjectContext;
  policy: ExecutionPolicy;
}

/**
 * How many times a compiler may be asked to answer its critic before a person
 * is needed instead. A compiler that cannot answer in two rounds is not going
 * to answer in a third; it is going to spend money looking like progress.
 */
export const MAX_ORACLE_RECOMPILES = 2;

/** The findings of the most recent critique — what a recompile must answer. */
export function latestCritiqueFindings(missions: MissionRegistry,
  missionId: string): CriticFindingRef[] {
  const evs = [...missions.events.read(missionId)].reverse();
  const q = evs.find((e) => e.type === 'ORACLE_CRITIQUED');
  const raw = (q?.payload as any)?.findings;
  return Array.isArray(raw) ? raw.filter((f: any) => f && typeof f.code === 'string') : [];
}

/**
 * Compiles again, with the critic's findings in the prompt, and critiques the
 * result with a FRESH critic that has not seen the previous round.
 *
 * Never accepts. A recompile answers objections; whether the answer is good
 * enough is still a consent decision, and an operation that could accept its
 * own second attempt would be marking its own homework.
 */
export async function recompileMissionOracle(ctx: OperationContext,
  missionId: string): Promise<CompileResult> {
  const { missions, engine } = ctx;
  const rec = missions.mission(missionId);
  if (!rec) return { ok: false, kind: 'NO_SUCH_MISSION', detail: `unknown mission ${missionId}` };
  if (rec.terminated) return { ok: false, kind: 'TERMINATED', detail: `${missionId} is terminated` };
  if (!rec.oracle) {
    return { ok: false, kind: 'NO_ORACLE', detail: `${missionId} has no compiled oracle to recompile` };
  }
  if (rec.oracleAccepted) {
    return { ok: false, kind: 'ALREADY_ACCEPTED', detail: `${missionId} is already accepted` };
  }
  if (rec.recompiles >= MAX_ORACLE_RECOMPILES) {
    return { ok: false, kind: 'RECOMPILE_LIMIT',
      detail: `${missionId} has already been recompiled ${rec.recompiles} time(s); the limit is `
        + `${MAX_ORACLE_RECOMPILES}. A compiler that cannot answer the critique in `
        + `${MAX_ORACLE_RECOMPILES} rounds needs a person, not another round.` };
  }

  const prior = rec.oracle as Oracle;
  const findings = latestCritiqueFindings(missions, missionId);
  const attempt = rec.recompiles + 1;

  const compiled = await compileOracle({
    missionId, projectId: engine.projectId, goal: rec.goal, context: ctx.context,
    provider: engine.opts.providers.planner, supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha: rec.baseSha,
    prior: { criteria: prior.criteria, findings, version: prior.version },
  });
  if (!compiled.ok) {
    // No round consumed. The provider never answered, so there is nothing to
    // hold against a limit whose point is "this compiler cannot do it".
    return { ok: false, kind: 'INFRASTRUCTURE',
      detail: compiled.infrastructureFailure ?? 'the compiler did not answer' };
  }
  // The compiler answered: this round is spent, whatever it answered with. A
  // reply that is not a contract still used the round, or a compiler emitting
  // nonsense would loop for ever inside the limit.
  missions.recordRecompile(missionId, {
    fromVersion: prior.version, findingsForwarded: findings.length,
    attempt, limit: MAX_ORACLE_RECOMPILES,
  });
  if (!compiled.validation.valid) {
    missions.recordCompileRejected(missionId, {
      findings: compiled.validation.findings, criteria: compiled.criteria,
      compilerProviderId: compiled.compilerProviderId,
      structuredHash: compiled.structuredHash,
      ...(compiled.providerUsage ? { providerUsage: compiled.providerUsage } : {}),
    });
    return { ok: false, kind: 'REJECTED',
      findings: compiled.validation.findings, criteria: compiled.criteria };
  }

  // A FRESH critique. Same policy, no prior verdict anywhere in its payload.
  const critique = await critiqueOracle({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: compiled.criteria,
    context: ctx.context, provider: engine.opts.providers.reviewer,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha: rec.baseSha,
  });
  const nextFindings: CriticFindingRef[] = critique.valid
    ? (critique.findings as CriticFindingRef[]) : [];
  const proposal = proposeAcceptance(compiled.criteria, ctx.context,
    critique.valid ? critique.modeOpinion : null, nextFindings);
  const oracle: Oracle = {
    missionId, version: prior.version + 1, criteria: compiled.criteria,
    acceptanceMode: proposal.mode, compiledAt: new Date().toISOString(),
    compilerProviderId: compiled.compilerProviderId, criticProviderId: critique.criticProviderId,
  };
  missions.recordOracle(missionId, oracle, compiled.structuredHash, compiled.validation,
    compiled.providerUsage);
  missions.recordCritique(missionId, {
    valid: critique.valid, findings: critique.findings, modeOpinion: critique.modeOpinion,
    promptHash: critique.payload.promptHash, hashes: critique.payload.hashes,
    violations: critique.payload.violations, criticProviderId: critique.criticProviderId,
    reconciliation: critique.reconciliation, providerUsage: critique.providerUsage,
  });

  return {
    ok: true, oracle, validation: compiled.validation,
    critique: { valid: critique.valid, findings: nextFindings,
      modeOpinion: critique.valid ? critique.modeOpinion : null },
    proposal,
    // NEVER accepted here. A recompile answers objections; whether the answer
    // is good enough is still a consent decision, and an operation that could
    // accept its own second attempt would be marking its own homework.
    acceptedBy: null,
    recompiledFrom: { version: prior.version, findingsForwarded: findings.length, attempt },
  };
}

/* ------------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------------ */

export type CompileResult =
  | {
    ok: false;
    kind: 'NO_SUCH_MISSION' | 'TERMINATED' | 'NO_ORACLE' | 'ALREADY_ACCEPTED'
    | 'RECOMPILE_LIMIT';
    detail: string;
  }
  | { ok: false; kind: 'INFRASTRUCTURE'; detail: string }
  | { ok: false; kind: 'REJECTED'; findings: OracleFinding[]; criteria: Criterion[] }
  | {
    ok: true; oracle: Oracle; validation: unknown;
    critique: { valid: boolean; findings: CriticFindingRef[]; modeOpinion: string | null };
    proposal: ReturnType<typeof proposeAcceptance>;
    /** Non-null only when the fast path applied: no findings, and the mode allows it. */
    acceptedBy: 'auto' | 'default-policy' | null;
    /** Present when this was a second round answering a critic. */
    recompiledFrom?: { version: number; findingsForwarded: number; attempt: number };
  };

/**
 * Compiles a goal into a contract, critiques it, and accepts it ONLY on the
 * fast path — a critique that objected to nothing, at a mode that permits it.
 *
 * Everything else stops. That is principle D and it is the same stop for every
 * caller: there is no argument to this function that accepts an oracle with
 * findings standing against it, because a flag that could do that would be a
 * flag someone eventually passes from a script.
 */
export async function compileMissionOracle(ctx: OperationContext, missionId: string,
  opts: { wantsReview?: boolean } = {}): Promise<CompileResult> {
  const { missions, engine } = ctx;
  const rec = missions.mission(missionId);
  if (!rec) return { ok: false, kind: 'NO_SUCH_MISSION', detail: `unknown mission ${missionId}` };
  if (rec.terminated) return { ok: false, kind: 'TERMINATED', detail: `${missionId} is terminated` };

  // A second compile over an unaccepted oracle is a RECOMPILE, and a recompile
  // carries the findings back to the compiler. The console offered 'send the
  // findings back', recorded the refusal, and then compiled from scratch — so
  // the critic's objections went nowhere and the same contract came back. The
  // prompt for answering findings already existed; only this path to it did not.
  if (rec.oracle && !rec.oracleAccepted) {
    return recompileMissionOracle(ctx, missionId);
  }

  const compiled = await compileOracle({
    missionId, projectId: engine.projectId, goal: rec.goal, context: ctx.context,
    provider: engine.opts.providers.planner, supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha: rec.baseSha,
  });
  if (!compiled.ok) {
    // A provider that could not answer is infrastructure. The mission has not
    // moved and the operation can simply be repeated.
    return { ok: false, kind: 'INFRASTRUCTURE',
      detail: compiled.infrastructureFailure ?? 'the compiler did not answer' };
  }
  if (!compiled.validation.valid) {
    missions.recordCompileRejected(missionId, {
      findings: compiled.validation.findings, criteria: compiled.criteria,
      compilerProviderId: compiled.compilerProviderId,
      structuredHash: compiled.structuredHash,
      ...(compiled.providerUsage ? { providerUsage: compiled.providerUsage } : {}),
    });
    return { ok: false, kind: 'REJECTED',
      findings: compiled.validation.findings, criteria: compiled.criteria };
  }

  const critique = await critiqueOracle({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: compiled.criteria,
    context: ctx.context, provider: engine.opts.providers.reviewer,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha: rec.baseSha,
  });
  const findings: CriticFindingRef[] = critique.valid ? (critique.findings as CriticFindingRef[]) : [];
  const proposal = proposeAcceptance(compiled.criteria, ctx.context,
    critique.valid ? critique.modeOpinion : null, findings);

  const oracle: Oracle = {
    missionId, version: (rec.oracleVersion ?? 0) + 1, criteria: compiled.criteria,
    acceptanceMode: proposal.mode, compiledAt: new Date().toISOString(),
    compilerProviderId: compiled.compilerProviderId, criticProviderId: critique.criticProviderId,
  };
  missions.recordOracle(missionId, oracle, compiled.structuredHash, compiled.validation,
    compiled.providerUsage);
  missions.recordCritique(missionId, {
    valid: critique.valid, findings: critique.findings, modeOpinion: critique.modeOpinion,
    promptHash: critique.payload.promptHash, hashes: critique.payload.hashes,
    violations: critique.payload.violations, criticProviderId: critique.criticProviderId,
    reconciliation: critique.reconciliation, providerUsage: critique.providerUsage,
  });

  const mayProceed = proposal.autoAcceptable
    && (proposal.mode === 'AUTO'
      || (proposal.mode === 'OPTIONAL_CONFIRMATION' && !opts.wantsReview));
  const acceptedBy: 'auto' | 'default-policy' | null = mayProceed
    ? (proposal.mode === 'AUTO' ? 'auto' : 'default-policy') : null;
  if (acceptedBy) {
    missions.acceptOracle(missionId, {
      acceptanceMode: proposal.mode, acceptedBy,
      modeInputs: proposal.computed.inputs, modeReasons: proposal.computed.reasons,
      escalatedByCritic: proposal.escalatedByCritic,
      escalatedByFindings: proposal.escalatedByFindings,
      acceptedDespite: [], findingsFloor: proposal.floor,
    });
  }

  return { ok: true, oracle, validation: compiled.validation,
    critique: { valid: critique.valid, findings, modeOpinion: critique.modeOpinion },
    proposal, acceptedBy };
}

/* ------------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------------ */

export type PlanOperationResult =
  | { ok: false; kind: 'NO_SUCH_MISSION' | 'TERMINATED' | 'ORACLE_NOT_ACCEPTED'; detail: string }
  | { ok: false; kind: 'INFRASTRUCTURE'; detail: string }
  | { ok: false; kind: 'REJECTED'; version: number; findings: PlanFinding[] }
  | {
    ok: true; version: number; graph: PlanGraph;
    findings: PlanCriticFinding[];
    scopeGaps: PlanFinding[];
    acceptance: ReturnType<typeof planAcceptance>;
    negotiation: BudgetNegotiation;
    /** True only when the critique raised nothing AND the plan fits the budget. */
    accepted: boolean;
  };

/** The budget a mission is operating under, revisions replayed from its log. */
export function budgetsFor(missions: MissionRegistry, missionId: string) {
  return applyBudgetRevisions(mergeMissionBudgets(), missions.events.read(missionId));
}

/**
 * Produces a plan, validates it, has it critiqued, and accepts it ONLY when
 * the critique raised nothing and it fits the budget.
 *
 * Same rule as compile, for the same reason: a caller cannot pass anything
 * that skips the stop. Accepting a plan that findings stand against, or one
 * the budget cannot pay for, happens through `acceptRecordedPlan` — an
 * explicit second act, against a version, carrying what was rendered.
 */
export async function planMissionGraph(ctx: OperationContext,
  missionId: string): Promise<PlanOperationResult> {
  const { missions, engine } = ctx;
  const rec = missions.mission(missionId);
  if (!rec) return { ok: false, kind: 'NO_SUCH_MISSION', detail: `unknown mission ${missionId}` };
  if (rec.terminated) return { ok: false, kind: 'TERMINATED', detail: `${missionId} is terminated` };

  const gate = requireAcceptedOracle(missions, missionId);
  if (!gate.ok) return { ok: false, kind: 'ORACLE_NOT_ACCEPTED', detail: gate.message };

  const version = (rec.planVersion ?? 0) + 1;
  const baseSha = rec.ratchetSha ?? rec.baseSha;
  const planned = await planMission({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: gate.criteria,
    context: ctx.context, provider: engine.opts.providers.planner,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha,
  });
  if (planned.infrastructureFailure) {
    return { ok: false, kind: 'INFRASTRUCTURE', detail: planned.infrastructureFailure };
  }
  const graph: PlanGraph = { version, nodes: planned.graph.nodes };
  const scopeGaps = planned.validation.findings
    .filter((f) => f.code === 'CRITERION_SCOPE_MISMATCH');

  if (!planned.validation.valid) {
    missions.recordPlanRejected(missionId, {
      version, nodes: graph.nodes, findings: planned.validation.findings, retryable: true,
      note: 'the deterministic validator refused the plan; the mission is unchanged',
    });
    return { ok: false, kind: 'REJECTED', version, findings: planned.validation.findings };
  }
  missions.recordPlan(missionId, graph, scopeGaps, planned.providerUsage);

  const critique = await critiquePlan({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: gate.criteria,
    graph, validation: planned.validation, context: ctx.context,
    provider: engine.opts.providers.reviewer, supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha,
  });
  const acceptance = planAcceptance(critique);
  missions.recordPlanCritique(missionId, {
    version, findings: critique.findings, acceptance: acceptance.decision,
    contaminated: !critique.valid,
    contaminationDetail: critique.valid ? null : 'the critique payload was contaminated',
    providerUsage: critique.providerUsage,
  });

  const negotiation = negotiateBudget(graph.nodes, budgetsFor(missions, missionId));
  const clean = acceptance.decision === 'FLOW' && scopeGaps.length === 0;
  const accepted = clean && negotiation.fits;
  if (accepted) {
    missions.acceptPlan(missionId, graph, { acceptedBy: 'auto' });
    missions.recordPlanStopDecision(missionId, {
      version, rendered: [negotiation.rendered], decision: 'FLOW',
      decidedBy: 'auto', deferred: false,
    });
  } else {
    missions.recordPlanStopDecision(missionId, {
      version,
      rendered: [...acceptance.reasons, negotiation.rendered, ...scopeGaps.map((f) => f.detail)],
      decision: negotiation.fits ? 'STOPPED_FINDINGS' : 'STOPPED_BUDGET',
      decidedBy: 'nobody yet', deferred: true,
    });
  }

  return { ok: true, version, graph, findings: critique.findings, scopeGaps,
    acceptance, negotiation, accepted };
}
