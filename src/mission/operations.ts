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

import { MissionRegistry, PlanTrigger } from './registry';
import { Engine } from '../engine/orchestrator';
import { Provider } from '../engine/providers';
import { PipelineStage } from '../routing';
import {
  EffectiveTrace, TraceLevel, isTraceLevel, resolveTraceLevel, TraceStore, BlobRef,
} from '../trace';
import { readConfig, readUserDefaults } from '../config';
import { ExecutionPolicy } from '../engine/policy';
import {
  Criterion, Oracle, OracleFinding, ProjectContext,
} from './oracle';
import { compileOracle, critiqueOracle, proposeAcceptance } from './compile';
import { attach, evidenceLogPath, REPO_AWARE } from '../graph/access';
import { checkWrites, isReadOnlyStage, verdictFor, type WriteVerdict }
  from '../engine/writecheck';
import { checkReadScope, type ReadScopeVerdict } from '../engine/readscope';
import { decide, type FrontDoorDecision } from './frontdoor';
import { chatStreamId } from './chat';
import { createHash } from 'crypto';
import { frontDoorTools } from '../engine/providers';
import { readGraphOps } from '../graph/intel';
import type { GraphState, GraphFault } from '../graph/graphify';
import type { GraphAccess } from '../engine/providers';

/**
 * The script the MCP server is started from — Zeus's own entry point.
 *
 * Resolved from this module rather than from argv: a runner started through
 * ts-node has argv[1] pointing at ts-node, and spawning THAT as an MCP server
 * would start a second REPL instead of a tool.
 */
const ZEUS_CLI_PATH = require('path').resolve(__dirname, '..', 'cli.ts');
/**
 * Where Zeus itself lives, derived rather than configured.
 *
 * An agent that reads this directory is reading the machinery that is grading
 * it. Deriving it from `__dirname` means it is correct for a git checkout, a
 * global npm install and the compiled `dist/` alike, and cannot drift out of
 * date the way a setting would.
 */
const ZEUS_INSTALL_ROOT = require('path').resolve(__dirname, '..', '..');
import {
  critiquePlan, planAcceptance, planMission, requireAcceptedOracle, PlanCriticFinding,
} from './planner';
import { PlanFinding } from './plan';
import { PlanGraph } from './types';
import {
  BudgetNegotiation, applyBudgetRevisions, mergeMissionBudgets, negotiateBudget,
  missionUsage, providerSpendOf, checkMissionBudgets, autoReplansExhausted,
} from './progress';

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
  const roomToRecompile = preflightBudget(missions, missionId);
  if (roomToRecompile) return { ok: false, kind: 'BUDGET', detail: roomToRecompile.detail };
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
    supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha: rec.baseSha, ...route(engine, 'oracle', missions, missionId),
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
    context: ctx.context,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha: rec.baseSha,
    ...route(engine, 'oracle-critic', missions, missionId),
  });
  const nextFindings: CriticFindingRef[] = critique.valid
    ? (critique.findings as CriticFindingRef[]) : [];
  // critique.valid is false when the critic never produced a verdict — a
  // refused payload, a provider failure, an unparseable reply. Passing that
  // through as "no findings" is what let M-0024 accept a contract 0 seconds
  // after compiling it, with no second opinion anywhere in the log.
  // critique.ok, not critique.valid. `valid` only says the payload was clean;
  // a critic whose provider crashed returns valid:true with no findings, which
  // is indistinguishable from a clean critique. `ok` is the field that means a
  // verdict was actually produced, and until now nothing read it.
  const proposal = proposeAcceptance(compiled.criteria, ctx.context,
    critique.valid ? critique.modeOpinion : null, nextFindings, critique.ok === true);
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

/**
 * The model and effort resolved for one pipeline stage.
 *
 * Spread into a provider call rather than passed as an object, so a call site
 * that forgets it fails to compile against a route-carrying input type instead
 * of quietly running on the provider's default.
 *
 * This is where four stages stopped being two settings: the oracle and the
 * planner both used providers.planner, and the oracle critic and the plan
 * critic both used providers.reviewer, so wanting a cheaper model for one and
 * not the other was not expressible.
 */
function route(engine: Engine, stage: PipelineStage, missions?: MissionRegistry,
  missionId?: string): {
  provider: Provider;
  model: string | null; reasoning: string | null; stage: string;
  traceLevel: TraceLevel;
  traceLevelSource: string;
  /** The MCP server for this call's graph, or null when there is none. */
  repoGraph: GraphAccess | null;
  graphState: GraphState | null;
  graphFault: GraphFault | null;
  graphLogPath: string | null;
  /** The REPOSITORY INTELLIGENCE section to put in the prompt. */
  intel: string | null;
  /** Whether this stage was told not to modify source. */
  readOnlyStage: boolean;
  /**
   * Looks at the repository AFTER the call and records a violation if the
   * stage wrote anything. Null for stages that are allowed to write.
   */
  verifyWrites: ((traceCallId: string, before: string | null) => WriteVerdict) | null;
  /**
   * Reads the provider's own transcript afterwards and records where the stage
   * LOOKED. Never null and never blocking: the write check guards the tree, and
   * this one is the only thing that notices an agent leaving the repository at
   * all. Every stage gets it, because reading out of scope has nothing to do
   * with whether a stage is allowed to write.
   */
  inspectReads: (traceCallId: string, raw: string) => ReadScopeVerdict;
  keep: (content: string) => BlobRef | null;
  trace?: (type: string, payload: Record<string, unknown>) => void;
} {
  const r = engine.routeFor(stage);
  // Repository intelligence is prepared HERE because route() is the one door
  // every stage goes through. Wiring it anywhere else would mean wiring it
  // seven times and forgetting one — and the one forgotten would be a stage
  // quietly reasoning about a repository it cannot see.
  //
  // The mission-level stages reason about the project root. Task stages get
  // their worktree through the orchestrator, which knows which snapshot the
  // task is actually on.
  const attached = REPO_AWARE.has(stage)
    ? attach({
      projectId: engine.projectId,
      sourceDir: engine.opts.projectRoot,
      providerId: engine.providerFor(stage).id,
      stateRoot: engine.stateRoot,
      logPath: evidenceLogPath(engine.stateRoot, `${stage}-${Date.now()}-${process.pid}`),
      execPath: process.execPath,
      cliPath: ZEUS_CLI_PATH,
    })
    : null;
  // SNAPSHOTTED HERE, at call start. Someone raising the level from audit to
  // debug while a provider call is already running must not retroactively
  // change what that call kept — the policy travels with the call.
  const trace = (missions && missionId)
    ? traceLevelFor(missions, missionId, engine.opts.projectRoot)
    : { level: 'normal' as TraceLevel, source: 'zeus-default' as const };
  const store = new TraceStore(engine.stateRoot);
  // V1 VERIFIES INSTEAD OF PREVENTING.
  //
  // The provider sandbox used to make a read-only role read-only, and it was
  // also what cancelled every MCP tool call in a non-interactive codex run —
  // so the price of the boundary was that the critics could not see the graph
  // they were meant to check claims against. The sandbox is gone; the
  // instruction stays; and Zeus looks at the tree afterwards.
  //
  // Handed to the caller rather than run here, because it must run AFTER the
  // provider call and route() returns before one is made.
  const verifyWrites = isReadOnlyStage(stage)
    ? (traceCallId: string, before: string | null): WriteVerdict => {
      const verdict = verdictFor(stage, traceCallId, before,
        checkWrites(engine.opts.projectRoot));
      // Both failing states go on the log under their own name. An operator
      // asking "why did this stage stop" should not have to infer it from a
      // field on a trace record.
      // WRITTEN AS TWO LITERAL TYPES, not one computed one.
      //
      // The event registry discovers types by scanning for a literal `type:`
      // beside a `payload`, and RS2 exercises every DISCOVERED type against
      // secret fixtures. `type: verdict.state` was invisible to that scan — so
      // two new event types carrying raw `diff` and `porcelain` output would
      // have gone into the log without ever being checked for leaks. A
      // computed type name is a type nobody tested.
      if (missions && missionId) {
        try {
          if (verdict.state === 'ROLE_WRITE_VIOLATION') {
            missions.events.append({ taskId: missionId,
              type: 'ROLE_WRITE_VIOLATION', payload: verdict.payload });
          } else if (verdict.state === 'WRITE_CHECK_UNAVAILABLE') {
            missions.events.append({ taskId: missionId,
              type: 'WRITE_CHECK_UNAVAILABLE',
              payload: { reasonCode: 'WRITE_CHECK_UNAVAILABLE', stage, traceCallId,
                beforeRevision: before, detail: verdict.detail, checkMs: verdict.ms,
                // Said plainly, because "unknown" is the whole point.
                consequence: 'this stage is NOT verified; Zeus cannot say whether '
                  + 'the role modified the repository, so it stops rather than '
                  + 'continuing as though it had been checked' } });
          }
        } catch { /* the verdict still reaches the caller */ }
      }
      return verdict;
    }
    : null;

  // WHAT THE PAYLOAD POLICY CANNOT SEE.
  //
  // ORACLE_CRITIQUE_POLICY, the leak patterns and the contaminated-payload
  // refusal all guard what Zeus HANDS an agent. None of them guards what the
  // agent FETCHES, and M-0032's oracle critic walked straight around them: it
  // read Zeus's own source for the definitions the prompt never gave it, and
  // enumerated every mission's event log on the way past.
  //
  // OBSERVATIONAL IN V1, on purpose. Nobody yet knows how often this happens,
  // and a gate tuned on a guess fires either constantly or never. The prompt
  // now says the repository root is the boundary; this says whether that held.
  const inspectReads = (traceCallId: string, raw: string): ReadScopeVerdict => {
    const verdict = checkReadScope(raw ?? '', {
      projectRoot: engine.opts.projectRoot,
      zeusRoot: ZEUS_INSTALL_ROOT,
      stateRoot: engine.stateRoot,
    }, { stage, traceCallId, provider: engine.providerFor(stage).id });
    // TWO LITERAL TYPES, for the reason the write check has two: the event
    // registry finds types by scanning for a literal `type:` beside a
    // `payload`, and a computed name is a type the redaction probe never
    // exercises. ROLE_READ_ESCAPE carries verbatim command lines.
    if (missions && missionId) {
      try {
        if (verdict.state === 'ROLE_READ_ESCAPE') {
          missions.events.append({ taskId: missionId,
            type: 'ROLE_READ_ESCAPE', payload: verdict.payload });
        } else if (verdict.state === 'READ_SCOPE_UNKNOWN') {
          missions.events.append({ taskId: missionId,
            type: 'READ_SCOPE_UNKNOWN',
            payload: { reasonCode: 'READ_SCOPE_UNKNOWN', stage, traceCallId,
              detail: verdict.detail, checkMs: verdict.ms,
              consequence: 'where this stage looked is not known; V1 does not '
                + 'stop for it, but this call is NOT evidence that the stage '
                + 'stayed inside the repository' } });
        }
      } catch { /* the verdict still reaches the caller */ }
    }
    return verdict;
  };

  return {
    traceLevel: trace.level,
    traceLevelSource: trace.source,
    verifyWrites,
    inspectReads,
    readOnlyStage: isReadOnlyStage(stage),
    repoGraph: attached?.access ?? null,
    graphState: attached?.state ?? null,
    graphFault: attached?.fault ?? null,
    graphLogPath: attached?.logPath ?? null,
    intel: attached?.section ?? null,
    keep: (content: string) => store.put(content, trace.level),
    // The PROVIDER the route names, not the one the role happens to hold. The
    // first cut passed the model and the effort and left the provider behind,
    // so a project routing its oracle to codex sent a codex model name to the
    // claude CLI. The trace caught it on the first real call.
    provider: engine.providerFor(stage),
    model: r.model, reasoning: r.reasoning, stage: r.stage,
    // The trace goes on the MISSION's log, beside the events it explains.
    // Failing to write one must never fail the mission: observability is a
    // second concern, and a mission killed by its own logging would be a worse
    // outcome than a mission nobody can explain.
    ...(missions && missionId ? {
      trace: (type: string, payload: Record<string, unknown>) => {
        try { missions.events.append({ taskId: missionId, type, payload }); }
        catch (e: any) {
          try {
            missions.events.append({ taskId: missionId, type: 'TRACE_WRITE_FAILED',
              payload: { forType: type, detail: String(e?.message ?? e) } });
          } catch { /* if even this fails, the mission still proceeds */ }
        }
      },
    } : {}),
  };
}

/* ------------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------------ */

export type CompileResult =
  | {
    ok: false;
    kind: 'NO_SUCH_MISSION' | 'TERMINATED' | 'NO_ORACLE' | 'ALREADY_ACCEPTED'
    | 'RECOMPILE_LIMIT' | 'BUDGET';
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

  const room = preflightBudget(missions, missionId);
  if (room) return { ok: false, kind: 'BUDGET', detail: room.detail };

  const compiled = await compileOracle({
    missionId, projectId: engine.projectId, goal: rec.goal, context: ctx.context,
    supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha: rec.baseSha, ...route(engine, 'oracle', missions, missionId),
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
    context: ctx.context,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha: rec.baseSha,
    ...route(engine, 'oracle-critic', missions, missionId),
  });
  const findings: CriticFindingRef[] = critique.valid ? (critique.findings as CriticFindingRef[]) : [];
  // Same rule on the first-compile path: a critique that did not happen is not
  // a critique that found nothing.
  // Same on the first-compile path: `ok`, not `valid`.
  const proposal = proposeAcceptance(compiled.criteria, ctx.context,
    critique.valid ? critique.modeOpinion : null, findings, critique.ok === true);

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
  | {
    ok: false;
    kind: 'NO_SUCH_MISSION' | 'TERMINATED' | 'ORACLE_NOT_ACCEPTED' | 'BUDGET';
    detail: string;
  }
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

export interface LiveRun {
  pid: number;
  startedAt: string;
  /** True when the process is still there; a crashed runner holds no lock. */
  alive: boolean;
}

/**
 * The run that currently owns this mission, if any.
 *
 * Derived from the log and then CHECKED against the world: a MISSION_RUN_STARTED
 * with no matching MISSION_RUN_FINISHED means a runner claimed the mission, and
 * `kill(pid, 0)` says whether it is still there. Without the liveness check a
 * crashed runner would lock the mission for ever; without the log the question
 * could not be asked at all, because the runner is another process.
 */
export function liveRun(missions: MissionRegistry, missionId: string): LiveRun | null {
  let claim: { pid: number; startedAt: string } | null = null;
  for (const e of missions.events.read(missionId)) {
    const p = (e.payload ?? {}) as any;
    if (e.type === 'MISSION_RUN_STARTED' && typeof p.pid === 'number') {
      claim = { pid: p.pid, startedAt: String(p.startedAt ?? e.ts) };
    } else if (e.type === 'MISSION_RUN_FINISHED' && claim && p.pid === claim.pid) {
      claim = null;
    }
  }
  if (!claim) return null;
  let alive = false;
  try { process.kill(claim.pid, 0); alive = true; } catch { alive = false; }
  return { ...claim, alive };
}

/**
 * The last plan and everything said against it, for the next attempt.
 *
 * Read from the log rather than passed along, because a replan can happen in a
 * different process from the one that produced the plan being revised.
 * Returns nothing when there is no previous plan — a first plan has nothing to
 * answer, and inventing an empty `prior` would tell the planner it was revising.
 */
export function priorPlanFor(missions: MissionRegistry, missionId: string):
{ prior: NonNullable<Parameters<typeof planMission>[0]['prior']> } | null {
  const log = missions.events.read(missionId);
  const recorded = [...log].reverse().find((e) => e.type === 'PLAN_RECORDED');
  if (!recorded) return null;
  const p = (recorded.payload ?? {}) as any;
  const graph = p.plan as PlanGraph | undefined;
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const version = Number(p.version ?? graph.version ?? 0);
  const critique = [...log].reverse().find((e) => e.type === 'PLAN_CRITIQUED'
    && (e.payload as any)?.version === version);
  const critic = ((critique?.payload as any)?.findings ?? []) as PlanCriticFinding[];
  return {
    prior: {
      graph, version,
      findings: (p.scopeFindings ?? []) as PlanFinding[],
      critic: Array.isArray(critic) ? critic : [],
    },
  };
}

/**
 * How much of this mission's model calls is kept, and which tier decided.
 *
 * Replayed from the log like every budget revision, so a level raised an hour
 * ago survives a restart and a level raised DURING a call does not reach back
 * and change what that call captured.
 */
export function traceLevelFor(missions: MissionRegistry, missionId: string,
  projectRoot?: string): EffectiveTrace {
  let mission: TraceLevel | null = null;
  for (const e of missions.events.read(missionId)) {
    if (e.type !== 'MISSION_TRACE_LEVEL_REVISED') continue;
    const to = (e.payload as any)?.to;
    if (isTraceLevel(to)) mission = to;
  }
  const project = projectRoot ? readConfig(projectRoot)?.trace?.level : undefined;
  const global = readUserDefaults()?.trace?.level;
  return resolveTraceLevel({
    mission,
    project: isTraceLevel(project) ? project : null,
    global: isTraceLevel(global) ? global : null,
  });
}

/** How much of its OWN replanning this mission has spent. */
export function autoReplanState(missions: MissionRegistry, missionId: string) {
  const log = missions.events.read(missionId);
  return autoReplansExhausted(
    applyBudgetRevisions(mergeMissionBudgets(), log),
    missionUsage(log, Date.now(), (taskId) => {
      try { return providerSpendOf(missions.events.read(taskId)); }
      catch { return { costUsd: 0, unmetered: 0 }; }
    }),
  );
}

/** The budget a mission is operating under, revisions replayed from its log. */
export function budgetsFor(missions: MissionRegistry, missionId: string) {
  return applyBudgetRevisions(mergeMissionBudgets(), missions.events.read(missionId));
}

/**
 * The mission budget, checked BEFORE a provider is called.
 *
 * checkMissionBudgets had exactly one caller — the execution loop — so the
 * ceiling governed execution and nothing else. Everything spent before the
 * first task ran (compile, critique, recompile, plan, plan-critique) was
 * unbounded: one mission reached $2.38 across five plans without the ceiling
 * ever being consulted, because it never got as far as running a task. A
 * spend ceiling that only applies after the expensive part is not a ceiling.
 *
 * Returns the breach, or null when there is room.
 */
export function preflightBudget(missions: MissionRegistry,
  missionId: string): { limit: string; detail: string } | null {
  const budgets = budgetsFor(missions, missionId);
  const usage = missionUsage(missions.events.read(missionId), Date.now(),
    (taskId) => {
      try { return providerSpendOf(missions.events.read(taskId)); }
      catch { return { costUsd: 0, unmetered: 0 }; }
    });
  const breach = checkMissionBudgets(budgets, usage);
  return breach ? { limit: String(breach.limit), detail: breach.detail } : null;
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
export async function planMissionGraph(ctx: OperationContext, missionId: string,
  opts: { trigger?: PlanTrigger } = {}): Promise<PlanOperationResult> {
  const { missions } = ctx;
  // The FIRST attempt of a call belongs to whoever made the call; every retry
  // inside it is Zeus trying again by itself. That is the whole distinction
  // maxPlanRecompiles bounds, so it is recorded rather than assumed.
  let trigger: PlanTrigger = opts.trigger ?? 'HUMAN';
  let last = await planOnce(ctx, missionId, trigger);

  for (;;) {
    // Only a REJECTED plan is worth another attempt. An accepted one is done,
    // and a stop that is waiting on consent is waiting on a person.
    const rejected = (last.ok === false && last.kind === 'REJECTED')
      || (last.ok === true && last.acceptance.decision === 'REJECT');
    if (!rejected) return last;

    // --- the guards, checked between every round --------------------------
    const rec = missions.mission(missionId);
    if (!rec || rec.terminated || rec.cancelRequested) return last;
    const held = liveRun(missions, missionId);
    if (held && held.alive) return last;
    if (preflightBudget(missions, missionId)) return last;
    if (autoReplanState(missions, missionId).exhausted) return last;

    trigger = 'AUTO';
    last = await planOnce(ctx, missionId, trigger);
  }
}

/** One attempt: plan, validate, critique, and stop. Never retries. */
async function planOnce(ctx: OperationContext, missionId: string,
  trigger: PlanTrigger): Promise<PlanOperationResult> {
  const { missions, engine } = ctx;
  const rec = missions.mission(missionId);
  if (!rec) return { ok: false, kind: 'NO_SUCH_MISSION', detail: `unknown mission ${missionId}` };
  if (rec.terminated) return { ok: false, kind: 'TERMINATED', detail: `${missionId} is terminated` };

  const gate = requireAcceptedOracle(missions, missionId);
  if (!gate.ok) return { ok: false, kind: 'ORACLE_NOT_ACCEPTED', detail: gate.message };

  const room = preflightBudget(missions, missionId);
  if (room) return { ok: false, kind: 'BUDGET', detail: room.detail };

  const version = (rec.planVersion ?? 0) + 1;
  const baseSha = rec.ratchetSha ?? rec.baseSha;
  const planned = await planMission({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: gate.criteria,
    context: ctx.context,
    supervisor: engine.opts.supervisor, policy: ctx.policy, baseSha,
    ...route(engine, 'planner', missions, missionId),
    // The previous attempt AND what was said against it. Without this a replan
    // starts from the goal alone and repeats the last plan's mistakes: two
    // plans in a row left the site chrome outside the localisation nodes,
    // because the second planner had never seen the first critique.
    ...(priorPlanFor(missions, missionId) ?? {}),
  });
  if (planned.infrastructureFailure) {
    return { ok: false, kind: 'INFRASTRUCTURE', detail: planned.infrastructureFailure };
  }
  const graph: PlanGraph = { version, nodes: planned.graph.nodes };
  const scopeGaps = planned.validation.findings
    .filter((f) => f.code === 'CRITERION_SCOPE_MISMATCH');
  const revision = (planned.resolutions?.length || planned.delta)
    ? { resolutions: planned.resolutions ?? [], delta: planned.delta ?? null }
    : null;

  if (!planned.validation.valid) {
    missions.recordPlanRejected(missionId, {
      version, nodes: graph.nodes, findings: planned.validation.findings, retryable: true,
      note: 'the deterministic validator refused the plan; the mission is unchanged',
      trigger,
    });
    return { ok: false, kind: 'REJECTED', version, findings: planned.validation.findings };
  }
  missions.recordPlan(missionId, graph, scopeGaps, planned.providerUsage, revision, trigger);

  const critique = await critiquePlan({
    missionId, projectId: engine.projectId, goal: rec.goal, criteria: gate.criteria,
    graph, validation: planned.validation, context: ctx.context,
    supervisor: engine.opts.supervisor,
    policy: ctx.policy, baseSha, ...route(engine, 'plan-critic', missions, missionId),
  });
  const acceptance = planAcceptance(critique);
  missions.recordPlanCritique(missionId, {
    version, findings: critique.findings, acceptance: acceptance.decision,
    contaminated: !critique.valid,
    contaminationDetail: critique.valid
      ? (critique.ok === false
        ? `the critic did not answer: ${critique.infrastructureFailure ?? 'no verdict'}`
        : null)
      : 'the critique payload was contaminated',
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


/* ------------------------------------------------------------------------ *
 * The chat front door
 * ------------------------------------------------------------------------ */

/**
 * Reads one chat message with read-only tools and decides what it asks for.
 *
 * Lives here, beside compile and plan, because it is the same kind of thing:
 * an operation that calls a provider and is invoked by both the CLI and the
 * console. The console does not construct engines.
 */
export async function frontDoorDecision(ctx: OperationContext, message: string):
Promise<FrontDoorDecision> {
  const engine = ctx.engine;
  const callId = `FD-${Date.now().toString(36)}-${process.pid}`;
  const logPath = evidenceLogPath(engine.stateRoot, callId);

  const att = attach({
    projectId: engine.projectId,
    sourceDir: engine.opts.projectRoot,
    stateRoot: engine.stateRoot,
    providerId: engine.providerFor('front-door').id,
    logPath,
    execPath: process.execPath,
    cliPath: ZEUS_CLI_PATH,
  });

  // One server, two kinds of evidence: the repository graph and Zeus's own
  // records. Two servers would mean two evidence logs to reconcile when asking
  // what this agent actually looked at.
  const access = att.access
    ? { ...att.access,
      args: [...att.access.args, '--state', engine.stateRoot, '--project', engine.projectId] }
    : null;

  const r = engine.routeFor('front-door');

  // The chat stream is just another task in the event store, so the trace
  // machinery applies to it unchanged: a level recorded on the stream
  // overrides the project's, which overrides the global one.
  const stream = chatStreamId(engine.projectId);
  const trace = traceLevelFor(ctx.missions, stream, engine.opts.projectRoot);
  const store = new TraceStore(engine.stateRoot);
  const traceCallId = `TC-${createHash('sha256')
    .update(`${stream}:front-door:${Date.now()}`).digest('hex').slice(0, 20)}`;

  const decision = await decide({
    message,
    context: att.section,
    provider: engine.providerFor('front-door'),
    supervisor: engine.opts.supervisor,
    policy: ctx.policy,
    projectId: engine.projectId,
    model: r.model,
    reasoning: r.reasoning,
    graph: access,
    // Read, Grep, Glob, graph, Zeus state. No Bash.
    tools: frontDoorTools(),
    traceCallId,
    traceLevel: trace.level,
    traceLevelSource: trace.source,
    // SNAPSHOTTED at call start, like every other stage: raising the level
    // mid-call must not retroactively change what that call kept.
    keep: (content: string) => store.put(content, trace.level),
    // Read AFTER the call, so the log holds what the tools actually answered
    // rather than what the agent said it asked.
    readOps: () => readGraphOps(logPath) as unknown as Array<Record<string, unknown>>,
    // The front door does not go through route(), so its read scope has to be
    // wired here. Same check, same two event names, written to the CHAT stream
    // beside the message that caused it.
    inspectReads: (id: string, raw: string) => {
      const verdict = checkReadScope(raw ?? '', {
        projectRoot: engine.opts.projectRoot,
        zeusRoot: ZEUS_INSTALL_ROOT,
        stateRoot: engine.stateRoot,
      }, { stage: 'front-door', traceCallId: id, provider: engine.providerFor('front-door').id });
      try {
        if (verdict.state === 'ROLE_READ_ESCAPE') {
          ctx.missions.events.append({ taskId: stream,
            type: 'ROLE_READ_ESCAPE', payload: verdict.payload });
        } else if (verdict.state === 'READ_SCOPE_UNKNOWN') {
          ctx.missions.events.append({ taskId: stream,
            type: 'READ_SCOPE_UNKNOWN',
            payload: { reasonCode: 'READ_SCOPE_UNKNOWN', stage: 'front-door',
              traceCallId: id, detail: verdict.detail, checkMs: verdict.ms,
              consequence: 'where this call looked is not known; V1 does not stop '
                + 'for it, but this call is NOT evidence that it stayed inside '
                + 'the repository' } });
        }
      } catch { /* the verdict still reaches the caller */ }
      return verdict;
    },
    // Written to the CHAT stream, beside the message that caused them.
    trace: (type: string, payload: Record<string, unknown>) => {
      try { ctx.missions.events.append({ taskId: stream, type, payload }); }
      catch (e: any) {
        try {
          ctx.missions.events.append({ taskId: stream, type: 'TRACE_WRITE_FAILED',
            payload: { forType: type, detail: String(e?.message ?? e) } });
        } catch { /* observability must never take the answer down */ }
      }
    },
  });

  const ops = readGraphOps(logPath);
  return {
    ...decision,
    traceCallId,
    evidenceUsed: ops.map((o) => ({
      kind: o.tool,
      id: String((o.args as any)?.term ?? (o.args as any)?.id
        ?? (o.args as any)?.missionId ?? ''),
      detail: `${o.results} result(s), ${o.ms}ms`,
    })),
  };
}
