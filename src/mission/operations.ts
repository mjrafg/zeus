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

/* ------------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------------ */

export type CompileResult =
  | { ok: false; kind: 'NO_SUCH_MISSION' | 'TERMINATED'; detail: string }
  | { ok: false; kind: 'INFRASTRUCTURE'; detail: string }
  | { ok: false; kind: 'REJECTED'; findings: OracleFinding[]; criteria: Criterion[] }
  | {
    ok: true; oracle: Oracle; validation: unknown;
    critique: { valid: boolean; findings: CriticFindingRef[]; modeOpinion: string | null };
    proposal: ReturnType<typeof proposeAcceptance>;
    /** Non-null only when the fast path applied: no findings, and the mode allows it. */
    acceptedBy: 'auto' | 'default-policy' | null;
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
