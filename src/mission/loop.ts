/**
 * The execution loop.
 *
 * One node in flight at a time; every decision derived from the mission log;
 * every advance of the ratchet paid for with evidence that was gathered after
 * the change landed, not before it.
 *
 * The host is injected. Not for testability alone — though a loop that can
 * only be exercised by spending real money on real models is a loop nobody
 * tests — but because the loop's job is sequencing and refusal, and mixing
 * that with git, provider transports and process supervision would produce a
 * file where neither half could be read.
 */

import type { PriorAttempt } from './attempt';
import { Achievement, PlanGraph, TaskNode, TerminationReason } from './types';
import { CriterionOutcome, Oracle } from './oracle';
import { MissionRegistry } from './registry';
import { achievementFrom } from './evaluate';
import {
  PreconditionProbe, ScheduleState, checkPreconditions, dependentsOf, divergenceDetail,
  nextNode, unreachableNow,
} from './schedule';
import {
  EFFECT_MODEL_WRONG_THRESHOLD, MissionBudgets, ObservedEvidence, checkMissionBudgets,
  applyBudgetRevisions, clampAchievement, genuineFlips, mergeMissionBudgets, missionUsage,
  mismatchesForVersion, plannedExhausted, progressFrom, providerSpendOf, verifyEffects,
} from './progress';

/* ------------------------------------------------------------------------ *
 * What the loop needs from the world
 * ------------------------------------------------------------------------ */

export interface NodeExecution {
  taskId: string;
  /** A terminal task state. Only COMPLETED is eligible for integration. */
  state: string;
  evidence: string[];
  detail: string;
}

export interface IntegrationOutcome {
  integrated: boolean;
  /** The commit the mission would advance to. Null when nothing integrated. */
  sha: string | null;
  /** Paths the integrated change touched, for incremental evaluation. */
  touched: string[];
  detail: string;
}

export interface EvaluationOutcome {
  results: Array<{ criterionId: string; outcome: CriterionOutcome; evidence: string[]; detail: string }>;
}

export interface LoopHost {
  /** Creates a task id for a node without recording anything on the mission. */
  createTask(node: TaskNode,
    ctx: { missionId: string; repair: boolean; prior?: PriorAttempt | null }): string;
  /**
   * What a failed attempt at this node left behind, for its successor to answer.
   * Optional: a host with no event log to read simply sends the repair in blind,
   * which is what every host did before this existed.
   */
  priorAttempt?(taskId: string, reason: string): PriorAttempt | null;
  /** Runs one node to a terminal task state. */
  runNode(taskId: string, node: TaskNode, ctx: { baseSha: string; repair: boolean }): Promise<NodeExecution>;
  /** Revalidates and integrates onto the mission's current green. */
  integrate(exec: NodeExecution, ctx: { node: TaskNode; baseSha: string }): Promise<IntegrationOutcome>;
  /** Evaluates criteria at a candidate commit. Incremental unless told otherwise. */
  evaluate(ctx: { sha: string; touched: string[]; scope: 'incremental' | 'full' }): Promise<EvaluationOutcome>;
  /** Deterministic observations of the world after integration. */
  observe(node: TaskNode, ctx: { sha: string; touched: string[] }): Promise<ObservedEvidence>;
  /** Answers preconditions against the world as it is now. */
  probe(): PreconditionProbe;
  /** Moves the mission ratchet. Called only after a green checkpoint. */
  advanceRatchet(sha: string): void;
  /** Produces a fresh accepted plan, or null when replanning is unavailable. */
  replan(reason: string, detail: string): Promise<PlanGraph | null>;
  /** Undoes an integration that broke an invariant, if the host can. */
  rollback?(sha: string): void;
  now(): number;
}

export interface LoopOptions {
  missionId: string;
  oracle: Oracle;
  budgets?: Partial<MissionBudgets>;
  /** Hard stop on cycles, independent of budgets. A loop needs a floor. */
  maxCycles?: number;
}

export interface LoopResult {
  missionId: string;
  cycles: number;
  terminated: boolean;
  achievement: Achievement;
  terminationReason: TerminationReason | null;
  detail: string;
  /** Everything the loop refused, in order, for the report. */
  refusals: Array<{ code: string; detail: string }>;
}

/* ------------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------------ */

const REPAIRS_PER_NODE = 1;

export async function runMissionLoop(
  missions: MissionRegistry, host: LoopHost, opts: LoopOptions,
): Promise<LoopResult> {
  const { missionId, oracle } = opts;
  // Revisions are replayed from the log, so a budget raised at plan time is
  // still raised after a restart — and a caller's in-memory override cannot
  // quietly outrank what the log records.
  const budgets = applyBudgetRevisions(
    mergeMissionBudgets(opts.budgets), missions.events.read(missionId));
  const maxCycles = opts.maxCycles ?? budgets.maxTasks * 3;
  const refusals: LoopResult['refusals'] = [];

  const state: ScheduleState = { done: new Set(), abandoned: new Set() };
  const repairsFor = new Map<string, number>();
  /** The attempt that failed at each node, so its successor is not sent in blind. */
  const lastAttempt = new Map<string, PriorAttempt>();
  const remember = (nodeId: string, taskId: string, reason: string): void => {
    const prior = host.priorAttempt?.(taskId, reason);
    if (prior) lastAttempt.set(nodeId, prior);
    else lastAttempt.delete(nodeId);
  };
  const outcomes = new Map<string, CriterionOutcome>();
  let cycles = 0;

  const events = () => missions.events.read(missionId);
  /** Provider cost lives on the spawned task's log, not the mission's. */
  const spendOf = (taskId: string) => {
    try { return providerSpendOf(missions.events.read(taskId)); }
    catch { return { costUsd: 0, unmetered: 0 }; }
  };
  const notedFlips = new Set<string>();

  /**
   * Records flips the attribution machinery has not put down to a flake.
   *
   * Deduplicated, because the log is re-scanned every cycle and a flip that
   * happened once is not evidence of a mission oscillating repeatedly.
   */
  const noteOscillation = (): void => {
    for (const flip of genuineFlips(events())) {
      const key = `${flip.criterionId}@${flip.at}`;
      if (notedFlips.has(key)) continue;
      notedFlips.add(key);
      missions.recordOscillation(missionId, {
        criterionId: flip.criterionId, at: flip.at, attribution: 'INCONCLUSIVE',
        evidence: [`flip:${flip.criterionId}:${flip.from}->${flip.to}`],
      });
    }
  };

  const requiredIds = oracle.criteria.filter((c) => c.required).map((c) => c.criterionId);

  /** Records an evaluation, with the required tally derived rather than passed. */
  const record = (scope: 'incremental' | 'full', run: EvaluationOutcome) => {
    for (const r of run.results) outcomes.set(r.criterionId, r.outcome);
    missions.recordEvaluation(missionId, {
      oracleVersion: oracle.version, scope, results: run.results,
      provenRequired: requiredIds.filter((id) => outcomes.get(id) === 'PROVEN').length,
      totalRequired: requiredIds.length,
    });
  };
  const refuse = (code: string, detail: string) => {
    refusals.push({ code, detail });
    missions.escalate(missionId, { kind: code, detail });
  };

  const finish = (achievement: Achievement, reason: TerminationReason, detail: string): LoopResult => {
    // Principle B at the exit. A caller that believes it achieved more than
    // the criteria show is corrected here, once, in the one place a verdict
    // is written — not argued with at every site that might want to claim.
    const derived = achievementFrom(outcomes, oracle);
    const clamped = clampAchievement(achievement, derived);
    if (clamped.downgraded) {
      missions.recordReconciliation(missionId, {
        kind: 'ACHIEVEMENT_CLAMPED', expected: achievement, observed: derived,
        resolution: clamped.reason ?? 'downgraded to what the criteria derive',
      });
    }
    missions.terminate(missionId, clamped.achievement, reason);
    return {
      missionId, cycles, terminated: true, achievement: clamped.achievement,
      terminationReason: reason, detail, refusals,
    };
  };

  /** Replan, or stop if the mission has replanned as often as it may. */
  const replanOrStop = async (reason: string, detail: string): Promise<LoopResult | null> => {
    const rec = missions.mission(missionId)!;
    missions.invalidatePlan(missionId, reason, null);
    const usage = missionUsage(events(), host.now(), spendOf);
    if (usage.replans >= budgets.maxReplans) {
      return finish('PARTIAL', 'BUDGET_EXCEEDED',
        `${reason}: already replanned ${usage.replans} time(s), the limit is ${budgets.maxReplans}`);
    }
    // Same reason as the integration guard: replanning is the most expensive
    // thing a stale cycle can do, and a terminated mission has no next plan.
    const alive = missions.mission(missionId);
    if (!alive || alive.terminated) {
      return { missionId, cycles, terminated: true,
        achievement: alive ? alive.achievement : 'UNEVALUATED',
        terminationReason: (alive ? alive.terminationReason : null) as TerminationReason | null,
        detail: 'the mission terminated before this replan; nothing was replanned', refusals };
    }
    missions.recordReplan(missionId, { reason, detail, fromVersion: rec.acceptedPlanVersion });
    const fresh = await host.replan(reason, detail);
    if (!fresh) {
      return finish('PARTIAL', 'BLOCKED', `${reason}: ${detail}; replanning produced nothing`);
    }
    // A new plan is a new world. Nothing carries across except what actually
    // integrated: abandonments belonged to the plan that named them.
    state.abandoned.clear();
    for (const id of [...state.done]) {
      if (!fresh.nodes.some((n) => n.nodeId === id)) state.done.delete(id);
    }
    return null;
  };

  for (;;) {
    cycles += 1;
    if (cycles > maxCycles) {
      return finish('PARTIAL', 'BUDGET_EXCEEDED', `${maxCycles} cycles without terminating`);
    }

    const rec = missions.mission(missionId);
    if (!rec) return { missionId, cycles, terminated: false, achievement: 'UNEVALUATED',
      terminationReason: null, detail: `no mission ${missionId}`, refusals };
    if (rec.terminated) {
      return { missionId, cycles, terminated: true, achievement: rec.achievement,
        terminationReason: rec.terminationReason as TerminationReason | null,
        detail: 'the mission was already terminated', refusals };
    }

    // Budgets, recomputed from the log every cycle rather than tracked in a
    // counter. A counter survives neither a crash nor a second process.
    const usage = missionUsage(events(), host.now(), spendOf);
    const breach = checkMissionBudgets(budgets, usage);
    if (breach) return finish('PARTIAL', 'BUDGET_EXCEEDED', `${breach.limit}: ${breach.detail}`);

    const graph = rec.acceptedPlan;
    if (!graph || rec.acceptedPlanVersion === null) {
      return finish('UNEVALUATED', 'BLOCKED', 'no accepted plan in the log; nothing may be spawned');
    }
    const planVersion = rec.acceptedPlanVersion;

    /* -- pick a node ----------------------------------------------------- */

    const node = nextNode(graph, state);
    if (!node) {
      const stranded = unreachableNow(graph, state);
      record('full', await host.evaluate({
        sha: rec.ratchetSha ?? rec.baseSha, touched: [], scope: 'full',
      }));
      const derived = achievementFrom(outcomes, oracle);
      if (derived === 'ACHIEVED') {
        return finish('ACHIEVED', 'COMPLETED', 'every required criterion is proven');
      }
      if (stranded.length) {
        return finish(derived, 'BLOCKED',
          `${stranded.length} node(s) can never run: ${stranded.join(', ')}`);
      }
      // The plan ran out and the criteria are not satisfied. That is a wrong
      // plan, not a finished mission, so it is worth one replan.
      const stop = await replanOrStop('PLAN_EXHAUSTED',
        'every node in the accepted plan is done and the required criteria are still not proven');
      if (stop) return stop;
      continue;
    }

    if (plannedExhausted(budgets, usage)) {
      return finish('PARTIAL', 'BUDGET_EXCEEDED',
        `planned work has used its share of the task budget (${usage.plannedTasks}); `
        + 'the remainder is reserved for repairs and replans');
    }

    /* -- preconditions, immediately before the spawn ---------------------- */

    const pre = checkPreconditions(node, host.probe());
    if (!pre.ok) {
      // The plan was written against a world that has since moved. Executing
      // anyway would be running a plan whose reasoning no longer holds.
      const stop = await replanOrStop('PRECONDITION_DIVERGENCE', divergenceDetail(node, pre));
      if (stop) return stop;
      continue;
    }

    /* -- spawn, through the one door -------------------------------------- */

    const repair = (repairsFor.get(node.nodeId) ?? 0) > 0;
    const prior = repair ? (lastAttempt.get(node.nodeId) ?? null) : null;
    const taskId = host.createTask(node, { missionId, repair, prior });
    const decision = missions.spawnNode(missionId, taskId, node.nodeId, {
      repair, reason: repair ? 'repair after a failed integration' : undefined,
    });
    if (!decision.ok) {
      refuse(decision.code, decision.message);
      if (decision.code === 'PLAN_NODE_NOT_ACCEPTED' || decision.code === 'PLAN_NOT_ACCEPTED') {
        return finish('PARTIAL', 'BLOCKED', decision.message);
      }
      state.abandoned.add(node.nodeId);
      continue;
    }

    const baseSha = rec.ratchetSha ?? rec.baseSha;
    const exec = await host.runNode(taskId, node, { baseSha, repair });
    missions.taskOutcome(missionId, taskId, exec.state, exec.evidence);

    const dependents = dependentsOf(graph, node.nodeId);

    /* -- integrate --------------------------------------------------------- */

    // Re-read before integrating. The check at the top of the cycle is minutes
    // old by now: a cycle spawns a task, waits for it and integrates, and in
    // that window another process — or a cancel — can end the mission. One did.
    // A second `zeus mission run` on the same mission finished its cycle three
    // minutes after MISSION_TERMINATED and wrote an INTEGRATION_RESULT
    // integrated=true, a PLAN_INVALIDATED and a MISSION_REPLAN into a mission
    // whose achievement was already settled. A terminated mission does not
    // move again, least of all because a process nobody knew about was slow.
    const still = missions.mission(missionId);
    if (!still || still.terminated) {
      return { missionId, cycles, terminated: true,
        achievement: still ? still.achievement : 'UNEVALUATED',
        terminationReason: (still ? still.terminationReason : null) as TerminationReason | null,
        detail: 'the mission terminated while this cycle was running; nothing was integrated',
        refusals };
    }

    let integration: IntegrationOutcome = { integrated: false, sha: null, touched: [], detail: exec.detail };
    if (exec.state === 'COMPLETED') {
      integration = await host.integrate(exec, { node, baseSha });
    }

    if (!integration.integrated || !integration.sha) {
      const used = repairsFor.get(node.nodeId) ?? 0;
      missions.recordIntegration(missionId, {
        nodeId: node.nodeId, taskId, planVersion, integrated: false, sha: null,
        provedCriteria: [], dependents, invariantsBroken: [],
        reason: integration.detail || `task ${exec.state}`,
      });
      if (used < REPAIRS_PER_NODE) {
        repairsFor.set(node.nodeId, used + 1);
        remember(node.nodeId, taskId, integration.detail || `task ${exec.state}`);
        continue;                                   // one repair, then no more
      }
      // A second failure is not a worse first failure. Escalating rather than
      // retrying is the difference between a loop and a loop that spins.
      refuse('NODE_UNREPAIRABLE', `${node.nodeId} failed twice: ${integration.detail}`);
      state.abandoned.add(node.nodeId);
      continue;
    }

    /* -- invariants, evaluated AFTER the change landed --------------------- */

    const before = new Map(outcomes);
    const run = await host.evaluate({
      sha: integration.sha, touched: integration.touched, scope: 'incremental',
    });
    record('incremental', run);

    // Oscillation is scanned HERE, not on the green path. A criterion that
    // flips is a criterion whose integration broke an invariant, and that
    // branch stops the cycle early — scanning after it would be scanning
    // where flips cannot be.
    noteOscillation();

    const broken = [...before.entries()]
      .filter(([id, was]) => was === 'PROVEN' && outcomes.get(id) !== 'PROVEN')
      .map(([id]) => id);

    const proved = run.results
      .filter((r) => r.outcome === 'PROVEN' && before.get(r.criterionId) !== 'PROVEN')
      .map((r) => r.criterionId);

    if (broken.length) {
      // NO RATCHET. A change that broke something already proven is not a
      // smaller advance; it is not an advance.
      missions.recordIntegration(missionId, {
        nodeId: node.nodeId, taskId, planVersion, integrated: true, sha: integration.sha,
        provedCriteria: [], dependents, invariantsBroken: broken,
        reason: `broke ${broken.length} previously proven criterion(s)`,
      });
      host.rollback?.(integration.sha);
      for (const id of broken) outcomes.set(id, before.get(id)!);
      const used = repairsFor.get(node.nodeId) ?? 0;
      if (used < REPAIRS_PER_NODE) {
        repairsFor.set(node.nodeId, used + 1);
        remember(node.nodeId, taskId,
          `it broke ${broken.length} previously proven criterion(s): ${broken.join(', ')}`);
        continue;
      }
      refuse('INVARIANT_BROKEN_TWICE', `${node.nodeId} broke ${broken.join(', ')} twice`);
      state.abandoned.add(node.nodeId);
      continue;
    }

    /* -- green: checkpoint, then ratchet ----------------------------------- */

    missions.checkpoint(missionId, integration.sha, [...outcomes.entries()]
      .filter(([, o]) => o === 'PROVEN').map(([id]) => id));
    host.advanceRatchet(integration.sha);
    state.done.add(node.nodeId);
    repairsFor.delete(node.nodeId);
    lastAttempt.delete(node.nodeId);

    missions.recordIntegration(missionId, {
      nodeId: node.nodeId, taskId, planVersion, integrated: true, sha: integration.sha,
      provedCriteria: proved, dependents, invariantsBroken: [],
      reason: proved.length ? `proved ${proved.join(', ')}` : 'integrated green, proved nothing new',
    });

    /* -- effects: predicted against observed -------------------------------- */

    const observed = await host.observe(node, { sha: integration.sha, touched: integration.touched });
    const mismatches = verifyEffects(node, observed);
    if (mismatches.length) {
      missions.recordEffectMismatch(missionId, { nodeId: node.nodeId, planVersion, mismatches });
      const total = mismatchesForVersion(events(), planVersion);
      if (total >= EFFECT_MODEL_WRONG_THRESHOLD) {
        // Not this node's fault. A plan whose predictions keep missing is a
        // plan built on a wrong model of the codebase, and the fix is a new
        // plan rather than a third node that also surprises everyone.
        const stop = await replanOrStop('EFFECT_MODEL_WRONG',
          `${total} effect mismatch(es) against plan v${planVersion}`);
        if (stop) return stop;
        continue;
      }
    }

    /* -- progress ----------------------------------------------------------- */

    const score = progressFrom(events());
    const currency = score.history.length ? score.history[score.history.length - 1].currency : 'none';
    missions.recordProgress(missionId, {
      cycle: cycles, currency, nodeId: node.nodeId,
      provenRequired: score.provenRequired, consecutiveNoProgress: score.consecutiveNoProgress,
    });

    if (score.consecutiveNoProgress >= budgets.maxNoProgressCycles) {
      const stop = await replanOrStop('NO_PROGRESS',
        `${score.consecutiveNoProgress} consecutive integration(s) proved nothing and enabled nothing`);
      if (stop) return stop;
      continue;
    }

    if (achievementFrom(outcomes, oracle) === 'ACHIEVED') {
      return finish('ACHIEVED', 'COMPLETED', 'every required criterion is proven');
    }
  }
}
