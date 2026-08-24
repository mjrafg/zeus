/**
 * Mission Mode, stage 3: the execution loop.
 *
 * NO REAL PROVIDER IS CALLED HERE. Every model call is the built-in
 * deterministic fake, and every host interface — git, integration, evaluation,
 * observation — is a fake whose answers the test dictates. That is not a
 * limitation of the tests; it is what makes them able to assert about the
 * loop's REFUSALS, which are the part that matters and the part a real
 * provider would make unreproducible.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { main } from '../src/cli';
import { EventStore, StoredEvent } from '../src/engine/events';
import { MissionRegistry } from '../src/mission/registry';
import { blockingFindings, repairBrief } from '../src/mission/attempt';
import { PlanGraph, TaskNode } from '../src/mission/types';
import { Criterion, Oracle } from '../src/mission/oracle';
import {
  requireAcceptedOracle, makeNodeId, normaliseNodes, planAcceptance,
  PLAN_CRITIQUE_HEADER, PLAN_HEADER,
} from '../src/mission/planner';
import {
  validatePlanForOracle, coverageFindings, scopeMismatchFindings, extractScopes,
  isDirectoryScope,
} from '../src/mission/plan';
import {
  topoOrder, nextNode, dependentsOf, checkPreconditions, unreachableNow, PreconditionProbe,
} from '../src/mission/schedule';
import {
  missionUsage, checkMissionBudgets, mergeMissionBudgets, verifyEffects, progressFrom,
  genuineFlips, detectFlips, clampAchievement, mismatchesForVersion, plannedExhausted,
  EFFECT_MODEL_WRONG_THRESHOLD, providerSpendOf, negotiateBudget, applyBudgetRevisions,
} from '../src/mission/progress';
import {
  isZeusArtifact, ZEUS_PATHSPEC_EXCLUDES, ZEUS_WORKTREE_EXCLUDES,
} from '../src/engine/orchestrator';
import { runMissionLoop, LoopHost, NodeExecution } from '../src/mission/loop';
import {
  selftestLive, selftestCostCap, SELFTEST_PER_CONTACT_CAP_USD, OBSERVED_CONTACT_COST_USD,
} from '../src/mission/selftest';
import {
  readBaseline, baselinePath, normaliseVersion, compareVersion,
} from '../src/mission/versions';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-m3-'));
let storeSeq = 0;
const freshRegistry = (): MissionRegistry => new MissionRegistry({
  events: new EventStore(path.join(TMP, `s${storeSeq += 1}`)), projectId: 'p',
});

/* -- fixtures -------------------------------------------------------------- */

const criterion = (id: string, over: Partial<Criterion> = {}): Criterion => ({
  criterionId: id, type: 'EXECUTABLE', statement: `statement for ${id}`,
  evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' } as any,
  affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'],
  ...over,
});

const oracleOf = (criteria: Criterion[]): Oracle => ({
  missionId: 'p/M-0001', version: 1, criteria, acceptanceMode: 'AUTO',
  compiledAt: '2026-01-01T00:00:00.000Z', compilerProviderId: 'mock', criticProviderId: 'mock',
});

const node = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  nodeId: id, description: `do ${id}`, dependsOn: [], preconditions: [],
  reads: [], writes: [], affectedCriteria: [], predictedEffects: [],
  estimatedTier: 'NORMAL', estimatedCost: 1, risk: 'LOW', ...over,
});

const graphOf = (nodes: TaskNode[], version = 1): PlanGraph => ({ version, nodes });

/** A mission with an accepted oracle and an accepted plan, all through the log. */
function armed(missions: MissionRegistry, criteria: Criterion[], plan: PlanGraph) {
  const rec = missions.create('goal', 'base0');
  const oracle = { ...oracleOf(criteria), missionId: rec.missionId };
  missions.recordOracle(rec.missionId, oracle, 'hash', { ok: true });
  missions.acceptOracle(rec.missionId, {
    acceptanceMode: 'AUTO', acceptedBy: 'auto', modeInputs: {}, modeReasons: [],
    escalatedByCritic: false,
  } as any);
  missions.recordPlan(rec.missionId, plan);
  missions.acceptPlan(rec.missionId, plan, { acceptedBy: 'auto' });
  return { missionId: rec.missionId, oracle };
}

const noProbe: PreconditionProbe = {
  fileExists: () => true, checkOutcome: () => 'PASSED', criterionState: () => 'PROVEN',
};

/** A host whose every answer the test dictates. */
function fakeHost(over: Partial<LoopHost> = {}): LoopHost {
  let n = 0;
  return {
    createTask: () => `p/T-${String(n += 1).padStart(4, '0')}`,
    runNode: async (taskId): Promise<NodeExecution> =>
      ({ taskId, state: 'COMPLETED', evidence: [], detail: 'ok' }),
    integrate: async () => ({ integrated: true, sha: `sha${n}`, touched: ['src/a.ts'], detail: 'clean' }),
    evaluate: async () => ({ results: [] }),
    observe: async () => ({ checks: {}, artifacts: {}, facts: {} }),
    probe: () => noProbe,
    advanceRatchet: () => {},
    replan: async () => null,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

const evs = (missions: MissionRegistry, id: string): StoredEvent[] => missions.events.read(id);
const typesOf = (missions: MissionRegistry, id: string): string[] => evs(missions, id).map((e) => e.type);

export async function executionSuite(): Promise<void> {
  section('mission repair: the second attempt is told what refused the first');
  {
    // A repair used to be a boolean. The task was told THAT it was a repair
    // and never WHAT had gone wrong, so the second attempt re-derived its
    // design from the same words that produced the first one. Observed on
    // talkbridge/M-0016, where three review rounds converged on the same two
    // blockers and the repair task's prompt contained neither.
    const missions = freshRegistry();
    const plan = graphOf([node('p/M-0001/N-0001',
      { affectedCriteria: ['p/M-0001/C-0001'] })]);
    const { missionId, oracle } = armed(missions, [criterion('p/M-0001/C-0001')], plan);

    const refused = {
      taskId: 'p/T-0001',
      findings: [
        { severity: 'IMPORTANT', claim: 'html lang is set globally while other routes stay English' },
        { severity: 'IMPORTANT', claim: 'the annual price renders $79.99/year untranslated', file: 'landing.jsx' },
      ],
      failedChecks: [{ name: 'build', outcome: 'FAILED' }],
      reason: 'a reviewer refused it',
    };
    const descriptions: string[] = [];
    let attempt = 0;
    let n = 0;
    await runMissionLoop(missions, fakeHost({
      createTask: (nd, ctx: any) => {
        // The host is what folds the prior attempt into the description; the
        // stub does the same so the test sees what a designer would receive.
        descriptions.push(ctx?.prior
          ? `${nd.description}\n${repairBrief(ctx.prior)}` : nd.description);
        return `p/T-${String(n += 1).padStart(4, '0')}`;
      },
      priorAttempt: () => refused,
      // fail once, then succeed, so exactly one repair is scheduled
      integrate: async () => (attempt++ === 0
        ? { integrated: false, sha: null, touched: [], detail: 'review refused it' }
        : { integrated: true, sha: 'sha1', touched: [], detail: 'clean' }),
    }), { missionId, oracle });

    const [first, second] = descriptions;
    check('PA1: a repair is actually scheduled, so there are two attempts',
      descriptions.length >= 2, `attempts=${descriptions.length}`);
    check('PA2: the FIRST attempt carries no findings — there are none yet',
      !!first && !/REPAIR OF A FAILED ATTEMPT/.test(first), 'a first attempt is not a repair');
    check('PA3: the second attempt is told it is a repair, not a fresh start',
      !!second && /THIS IS A REPAIR OF A FAILED ATTEMPT, NOT A FRESH START/.test(second),
      'the emphatic line survives');
    check('PA4: and it carries the actual blocking claims, not just a flag',
      !!second && /html lang is set globally/.test(second)
      && /\$79\.99\/year untranslated/.test(second),
      'both blockers travel');
    check('PA5: the failed check travels too',
      !!second && /build: FAILED/.test(second), 'a repair does not re-break a proven check');
    check('PA6: the second attempt still contains the original task',
      !!second && !!first && second.startsWith(first), 'findings are added, not substituted');

    // SUGGESTION is advice, not a refusal. Listing it under "every one of these
    // must be resolved" would turn taste into a blocker.
    const mixed = blockingFindings([[
      { severity: 'SUGGESTION', claim: 'prefer the tu register' },
      { severity: 'CRITICAL', claim: 'the build does not run' },
    ]]);
    check('PA7: CRITICAL blocks and SUGGESTION does not',
      mixed.length === 1 && mixed[0].claim === 'the build does not run',
      JSON.stringify(mixed));

    // A reviewer that expands twice says the same thing three times, and three
    // copies of one blocker reads as three blockers.
    const dupes = blockingFindings([
      [{ severity: 'IMPORTANT', claim: 'the annual price is untranslated' }],
      [{ severity: 'IMPORTANT', claim: 'The Annual Price Is Untranslated' }],
    ]);
    check('PA8: the same claim from two review rounds is one finding',
      dupes.length === 1, JSON.stringify(dupes));
    check('PA9: and the NEWEST round wins the wording',
      dupes[0]?.claim === 'the annual price is untranslated', JSON.stringify(dupes));
  }


  section('mission stage 3: planning is gated on an accepted contract');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    const bare = requireAcceptedOracle(missions, rec.missionId);

    const oracle = { ...oracleOf([criterion('p/M-0001/C-0001')]), missionId: rec.missionId };
    missions.recordOracle(rec.missionId, oracle, 'hash', { ok: true });
    const compiled = requireAcceptedOracle(missions, rec.missionId);

    missions.acceptOracle(rec.missionId, {
      acceptanceMode: 'AUTO', acceptedBy: 'auto', modeInputs: {}, modeReasons: [],
      escalatedByCritic: false,
    } as any);
    const accepted = requireAcceptedOracle(missions, rec.missionId);

    check('M3-1: planning is refused before an oracle is compiled',
      !bare.ok && bare.code === 'ORACLE_NOT_COMPILED', JSON.stringify(bare));
    check('M3-1b: a COMPILED oracle is still not a licence to plan',
      !compiled.ok && compiled.code === 'ORACLE_NOT_ACCEPTED', JSON.stringify(compiled));
    check('M3-1c: an accepted oracle is read back FROM THE LOG',
      accepted.ok && accepted.required.length === 1
      && accepted.required[0] === 'p/M-0001/C-0001');
  }

  section('mission stage 3: the planner names nothing that becomes identity');
  {
    // What a model actually returns: its own names, everywhere.
    const raw = [
      { nodeId: 'add-parser', description: 'write the parser', dependsOn: [],
        affectedCriteria: ['parser-works'], writes: ['src/p.ts'] },
      { nodeId: 'wire-it-up', description: 'call it', dependsOn: ['add-parser'],
        affectedCriteria: ['parser-works'], writes: ['src/main.ts'] },
    ];
    const criteria = [criterion('p/M-0001/C-0001', { slug: 'parser-works' }),
      criterion('p/M-0001/C-0002', { slug: 'docs-updated' })];
    const nodes = normaliseNodes('p/M-0001', raw, criteria);

    check('M3-2: node ids are ours, assigned in order',
      nodes[0].nodeId === makeNodeId('p/M-0001', 1)
      && nodes[1].nodeId === makeNodeId('p/M-0001', 2), nodes.map((x) => x.nodeId).join(','));
    check('M3-2b: the model’s name survives as a slug, not as identity',
      nodes[0].slug === 'add-parser' && nodes[1].slug === 'wire-it-up');
    check('M3-2c: dependsOn is rewritten to canonical ids',
      nodes[1].dependsOn.length === 1 && nodes[1].dependsOn[0] === nodes[0].nodeId,
      nodes[1].dependsOn.join(','));
    check('M3-2d: affectedCriteria resolve through the criterion slug',
      nodes[0].affectedCriteria[0] === 'p/M-0001/C-0001', nodes[0].affectedCriteria.join(','));

    const required = criteria.map((c) => c.criterionId);
    const gaps = coverageFindings(graphOf(nodes), required);
    const validation = validatePlanForOracle(graphOf(nodes), required);
    check('M3-2e: a required criterion no node touches is CRITERION_UNCOVERED',
      gaps.length === 1 && gaps[0].code === 'CRITERION_UNCOVERED'
      && gaps[0].detail.includes('C-0002'), JSON.stringify(gaps));
    check('M3-2f: deterministic validation refuses the plan before anyone is asked for an opinion',
      !validation.valid && validation.findings.some((f) => f.code === 'CRITERION_UNCOVERED'),
      JSON.stringify({ valid: validation.valid, codes: validation.findings.map((f) => f.code) }));
  }

  section('mission stage 3: principle A at the plan layer');
  {
    const missions = freshRegistry();
    const accepted = graphOf([node('p/M-0001/N-0001')]);
    const { missionId } = armed(missions, [criterion('p/M-0001/C-0001')], accepted);

    // The caller holds a graph object that has one MORE node than the log
    // ever accepted. This is the tautology the ledger fix was about, moved up
    // a layer: if the check read this object it could never refuse.
    const inMemory = graphOf([...accepted.nodes, node('p/M-0001/N-0099')]);
    const smuggled = inMemory.nodes[1].nodeId;

    const good = missions.spawnNode(missionId, 'p/T-0001', 'p/M-0001/N-0001');
    const bad = missions.spawnNode(missionId, 'p/T-0002', smuggled);

    check('M3-3: a node the log accepted spawns',
      good.ok && good.planVersion === 1, JSON.stringify(good));
    check('M3-3b: a node only the caller’s object contains is refused',
      !bad.ok && bad.code === 'PLAN_NODE_NOT_ACCEPTED', JSON.stringify(bad));
    check('M3-3c: the refusal names what IS accepted, so it is actionable',
      !bad.ok && bad.message.includes('p/M-0001/N-0001'));
    check('M3-3d: the refused spawn wrote no TASK_SPAWNED',
      typesOf(missions, missionId).filter((t) => t === 'TASK_SPAWNED').length === 1);

    // And an invalidated plan authorises nothing at all, even a node it named.
    missions.invalidatePlan(missionId, 'PRECONDITION_DIVERGENCE', null);
    const after = missions.spawnNode(missionId, 'p/T-0003', 'p/M-0001/N-0001');
    check('M3-3e: an invalidated plan is not a licence for the nodes it named',
      !after.ok && after.code === 'PLAN_NOT_ACCEPTED', JSON.stringify(after));
  }

  section('mission stage 3: the plan critic, and what a critique means');
  {
    const contaminated = planAcceptance({
      ok: false, valid: false, payload: {} as any, findings: [],
      reconciliation: { consistent: false, unsupportedClaims: [] },
      criticProviderId: 'mock', infrastructureFailure: null,
    });
    const blocking = planAcceptance({
      ok: true, valid: true, payload: {} as any,
      findings: [{ code: 'ORDER_IMPOSSIBLE', severity: 'BLOCKING', detail: 'N-2 needs N-3' }],
      reconciliation: { consistent: true, unsupportedClaims: [] },
      criticProviderId: 'mock', infrastructureFailure: null,
    });
    const advisory = planAcceptance({
      ok: true, valid: true, payload: {} as any,
      findings: [{ code: 'RISK_UNDERSTATED', severity: 'ADVISORY', detail: 'N-1 touches the schema' }],
      reconciliation: { consistent: true, unsupportedClaims: [] },
      criticProviderId: 'mock', infrastructureFailure: null,
    });
    const clean = planAcceptance({
      ok: true, valid: true, payload: {} as any, findings: [],
      reconciliation: { consistent: true, unsupportedClaims: [] },
      criticProviderId: 'mock', infrastructureFailure: null,
    });

    check('M3-4: a contaminated critique is not a second opinion, so the plan is rejected',
      contaminated.decision === 'REJECT'
      && contaminated.reasons[0].includes('contaminated'), JSON.stringify(contaminated));
    check('M3-4b: a BLOCKING finding rejects the plan outright',
      blocking.decision === 'REJECT' && blocking.blocking.length === 1);
    check('M3-4c: a non-blocking finding STOPS rather than flowing',
      advisory.decision === 'STOP' && advisory.advisory.length === 1);
    check('M3-4d: only a findings-free critique flows',
      clean.decision === 'FLOW');
  }

  section('mission stage 3: serial order, and it is the same order twice');
  {
    const g = graphOf([
      node('p/M-0001/N-0003', { dependsOn: ['p/M-0001/N-0001', 'p/M-0001/N-0002'] }),
      node('p/M-0001/N-0002', { dependsOn: ['p/M-0001/N-0001'] }),
      node('p/M-0001/N-0001'),
      node('p/M-0001/N-0004', { dependsOn: ['p/M-0001/N-0001'] }),
    ]);
    const a = topoOrder(g).order;
    const b = topoOrder({ ...g, nodes: [...g.nodes].reverse() }).order;

    check('M3-5: dependencies come before dependants',
      a.indexOf('p/M-0001/N-0001') < a.indexOf('p/M-0001/N-0002')
      && a.indexOf('p/M-0001/N-0002') < a.indexOf('p/M-0001/N-0003'), a.join(','));
    check('M3-5b: the order does not depend on how the nodes were listed',
      a.join(',') === b.join(','), `${a.join(',')} vs ${b.join(',')}`);
    check('M3-5c: ties break on the id, so two runs schedule identically',
      a.join(',') === ['p/M-0001/N-0001', 'p/M-0001/N-0002',
        'p/M-0001/N-0003', 'p/M-0001/N-0004'].join(','), a.join(','));

    const state = { done: new Set<string>(), abandoned: new Set<string>() };
    check('M3-5d: exactly one node is offered at a time',
      nextNode(g, state)!.nodeId === 'p/M-0001/N-0001');
    state.abandoned.add('p/M-0001/N-0001');
    check('M3-5e: nothing behind an abandoned node is offered',
      nextNode(g, state) === null);
    check('M3-5f: and the stranded nodes are named rather than left looking alive',
      unreachableNow(g, state).length === 3, unreachableNow(g, state).join(','));

    const cyclic = graphOf([
      node('a', { dependsOn: ['b'] }), node('b', { dependsOn: ['a'] }), node('c'),
    ]);
    check('M3-5g: a cycle is reported as unordered rather than silently dropped',
      topoOrder(cyclic).order.join(',') === 'c'
      && topoOrder(cyclic).unordered.join(',') === 'a,b');
  }

  section('mission stage 3: preconditions are re-checked against the world');
  {
    const n = node('p/M-0001/N-0001', { preconditions: [
      { kind: 'fileExists', target: 'src/a.ts' },
      { kind: 'checkFailing', target: 'unitTest' },
      { kind: 'criterionState', target: 'p/M-0001/C-0001', value: 'PROVEN' },
    ] });

    const holds = checkPreconditions(n, {
      fileExists: () => true, checkOutcome: () => 'TEST_FAILED', criterionState: () => 'PROVEN',
    });
    const moved = checkPreconditions(n, {
      fileExists: () => false, checkOutcome: () => 'PASSED', criterionState: () => 'FAILED',
    });
    const unknown = checkPreconditions(n, {
      fileExists: () => true, checkOutcome: () => null, criterionState: () => 'PROVEN',
    });

    check('M3-6: satisfied preconditions pass', holds.ok, JSON.stringify(holds.failures));
    check('M3-6b: each divergence is reported separately, not as one blur',
      !moved.ok && moved.failures.length === 3, JSON.stringify(moved.failures));
    check('M3-6c: a check nobody ran cannot be said to be failing',
      !unknown.ok && unknown.failures[0].observed === 'NOT_RUN',
      JSON.stringify(unknown.failures));
  }

  section('mission stage 3: divergence invalidates the plan and forces a replan');
  {
    const missions = freshRegistry();
    const plan = graphOf([node('p/M-0001/N-0001', {
      preconditions: [{ kind: 'fileExists', target: 'src/gone.ts' }],
      affectedCriteria: ['p/M-0001/C-0001'],
    })]);
    const { missionId, oracle } = armed(missions, [criterion('p/M-0001/C-0001')], plan);

    let replanned: string[] = [];
    const result = await (runMissionLoop(missions, fakeHost({
      probe: () => ({ fileExists: () => false, checkOutcome: () => 'PASSED', criterionState: () => 'PROVEN' }),
      replan: async (reason) => { replanned.push(reason); return null; },
    }), { missionId, oracle }));

    check('M3-7: the plan is invalidated rather than executed against a moved world',
      typesOf(missions, missionId).includes('PLAN_INVALIDATED'));
    check('M3-7b: the invalidation names the divergence',
      evs(missions, missionId).some((e) => e.type === 'PLAN_INVALIDATED'
        && (e.payload as any).reason === 'PRECONDITION_DIVERGENCE'));
    check('M3-7c: a replan is attempted, with the reason carried into it',
      replanned.join(',') === 'PRECONDITION_DIVERGENCE', replanned.join(','));
    check('M3-7d: nothing was spawned against the stale plan',
      !typesOf(missions, missionId).includes('TASK_SPAWNED'));
    check('M3-7e: a mission that cannot replan stops BLOCKED rather than proceeding',
      result.terminationReason === 'BLOCKED', String(result.terminationReason));
  }

  section('mission stage 3: the ratchet is paid for with evidence');
  {
    const missions = freshRegistry();
    const plan = graphOf([node('p/M-0001/N-0001', { affectedCriteria: ['p/M-0001/C-0001'] })]);
    const { missionId, oracle } = armed(missions, [criterion('p/M-0001/C-0001')], plan);
    const advanced: string[] = [];

    const result = await (runMissionLoop(missions, fakeHost({
      integrate: async () => ({ integrated: true, sha: 'green1', touched: ['src/a.ts'], detail: 'clean' }),
      evaluate: async () => ({ results: [{ criterionId: 'p/M-0001/C-0001', outcome: 'PROVEN',
        evidence: ['check:unitTest'], detail: 'passed' }] }),
      advanceRatchet: (sha) => advanced.push(sha),
    }), { missionId, oracle }));

    check('M3-8: a green integration checkpoints',
      typesOf(missions, missionId).includes('MISSION_CHECKPOINT'));
    check('M3-8b: and only then does the ratchet move',
      advanced.join(',') === 'green1', advanced.join(','));
    check('M3-8c: the ratchet event records the invariants it is guarding',
      evs(missions, missionId).some((e) => e.type === 'MISSION_CHECKPOINT'
        && (e.payload as any).invariants.includes('p/M-0001/C-0001')));
    check('M3-8d: the mission terminates ACHIEVED on proven required criteria',
      result.achievement === 'ACHIEVED' && result.terminationReason === 'COMPLETED',
      `${result.achievement}/${result.terminationReason}`);
  }

  section('mission stage 3: a broken invariant does not ratchet, and is not retried forever');
  {
    const missions = freshRegistry();
    const plan = graphOf([
      node('p/M-0001/N-0001', { affectedCriteria: ['p/M-0001/C-0001'] }),
      node('p/M-0001/N-0002', { affectedCriteria: ['p/M-0001/C-0002'], dependsOn: ['p/M-0001/N-0001'] }),
    ]);
    const { missionId, oracle } = armed(missions,
      [criterion('p/M-0001/C-0001'), criterion('p/M-0001/C-0002')], plan);

    const advanced: string[] = [];
    let cycle = 0;
    const result = await (runMissionLoop(missions, fakeHost({
      integrate: async () => ({ integrated: true, sha: `sha${cycle}`, touched: ['src/a.ts'], detail: 'clean' }),
      evaluate: async () => {
        cycle += 1;
        // Cycle 1 proves C-0001. Every later cycle breaks it again.
        if (cycle === 1) {
          return { results: [{ criterionId: 'p/M-0001/C-0001', outcome: 'PROVEN' as const,
            evidence: ['e'], detail: 'passed' }] };
        }
        return { results: [{ criterionId: 'p/M-0001/C-0001', outcome: 'FAILED' as const,
          evidence: ['e'], detail: 'regressed' }] };
      },
      advanceRatchet: (sha) => advanced.push(sha),
    }), { missionId, oracle, maxCycles: 12 }));

    const integrations = evs(missions, missionId)
      .filter((e) => e.type === 'INTEGRATION_RESULT').map((e) => e.payload as any);
    const brokenOnes = integrations.filter((p) => p.invariantsBroken.length > 0);

    check('M3-9: an integration that broke a proven criterion is recorded as such',
      brokenOnes.length >= 1 && brokenOnes[0].invariantsBroken[0] === 'p/M-0001/C-0001',
      JSON.stringify(brokenOnes.map((p) => p.invariantsBroken)));
    check('M3-9b: it does not ratchet',
      advanced.length === 1, advanced.join(','));
    check('M3-9c: exactly one repair is attempted',
      brokenOnes.length === 2, `${brokenOnes.length} broken integration(s)`);
    check('M3-9d: the second failure escalates rather than retrying again',
      result.refusals.some((r) => r.code === 'INVARIANT_BROKEN_TWICE'),
      JSON.stringify(result.refusals));
    check('M3-9e: the escalation is on the log, not only in the return value',
      evs(missions, missionId).some((e) => e.type === 'MISSION_ESCALATED'
        && (e.payload as any).kind === 'INVARIANT_BROKEN_TWICE'));
  }

  section('mission stage 3: predicted effects are checked against observation');
  {
    const n = node('p/M-0001/N-0001', { predictedEffects: [
      { kind: 'expectedCheckTransition', check: 'unitTest', from: 'TEST_FAILED', to: 'PASSED' },
      { kind: 'expectedArtifact', path: 'src/parser.ts', exists: true },
      { kind: 'expectedStateFact', fact: 'schemaVersion', value: '3' },
    ] });

    const asPredicted = verifyEffects(n, {
      checks: { unitTest: 'PASSED' }, artifacts: { 'src/parser.ts': true }, facts: { schemaVersion: '3' },
    });
    const wrong = verifyEffects(n, {
      checks: { unitTest: 'TEST_FAILED' }, artifacts: { 'src/parser.ts': false }, facts: { schemaVersion: '2' },
    });
    const unlooked = verifyEffects(n, { checks: {}, artifacts: {}, facts: {} });

    check('M3-10: effects that happened raise nothing', asPredicted.length === 0);
    check('M3-10b: every effect that did not happen is reported',
      wrong.length === 3, JSON.stringify(wrong.map((m) => m.observed)));
    check('M3-10c: an effect nobody looked for is a mismatch, not a pass',
      unlooked.length === 3
      && unlooked[0].evidence[0] === 'check:unitTest:absent'
      && unlooked[1].observed === 'not looked for'
      && unlooked[2].observed === 'not probed',
      JSON.stringify(unlooked.map((m) => m.observed)));
  }

  section('mission stage 3: a plan whose predictions keep missing is the wrong plan');
  {
    const missions = freshRegistry();
    const plan = graphOf([1, 2, 3, 4].map((i) => node(makeNodeId('p/M-0001', i), {
      affectedCriteria: ['p/M-0001/C-0001'],
      predictedEffects: [{ kind: 'expectedArtifact', path: `src/${i}.ts`, exists: true }],
    })));
    const { missionId, oracle } = armed(missions, [criterion('p/M-0001/C-0001')], plan);
    const reasons: string[] = [];

    await (runMissionLoop(missions, fakeHost({
      // Everything integrates green, and every prediction is wrong.
      observe: async () => ({ checks: {}, artifacts: {}, facts: {} }),
      replan: async (reason) => { reasons.push(reason); return null; },
    }), { missionId, oracle, maxCycles: 10 }));

    check('M3-11: each mismatch is recorded against the plan version',
      mismatchesForVersion(evs(missions, missionId), 1) === EFFECT_MODEL_WRONG_THRESHOLD,
      String(mismatchesForVersion(evs(missions, missionId), 1)));
    check('M3-11b: the third one invalidates the PLAN rather than blaming the node',
      evs(missions, missionId).some((e) => e.type === 'PLAN_INVALIDATED'
        && (e.payload as any).reason === 'EFFECT_MODEL_WRONG'));
    check('M3-11c: and a replan is asked for with that reason',
      reasons.includes('EFFECT_MODEL_WRONG'), reasons.join(','));
  }

  section('mission stage 3: progress is earned in two currencies');
  {
    const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const ev = (type: string, payload: any, seq: number): StoredEvent =>
      ({ id: `e${seq}`, taskId: 'p/M-0001', seq, ts: at(seq), type, prev: '', payload });

    // N-1 proves nothing but its dependant IS spawned afterwards: enabling.
    const enabling = progressFrom([
      ev('TASK_SPAWNED', { nodeId: 'N-1' }, 1),
      ev('INTEGRATION_RESULT', { nodeId: 'N-1', provedCriteria: [], dependents: ['N-2'] }, 2),
      ev('TASK_SPAWNED', { nodeId: 'N-2' }, 3),
    ]);
    // Same shape, but the dependant is never spawned: no credit.
    const claimed = progressFrom([
      ev('TASK_SPAWNED', { nodeId: 'N-1' }, 1),
      ev('INTEGRATION_RESULT', { nodeId: 'N-1', provedCriteria: [], dependents: ['N-2'] }, 2),
    ]);
    // Three in a row that prove nothing: the cap bites on the third.
    const capped = progressFrom([
      ev('TASK_SPAWNED', { nodeId: 'N-1' }, 1), ev('TASK_SPAWNED', { nodeId: 'N-2' }, 2),
      ev('TASK_SPAWNED', { nodeId: 'N-3' }, 3), ev('TASK_SPAWNED', { nodeId: 'N-4' }, 4),
      ev('INTEGRATION_RESULT', { nodeId: 'N-1', provedCriteria: [], dependents: ['N-2'] }, 5),
      ev('INTEGRATION_RESULT', { nodeId: 'N-2', provedCriteria: [], dependents: ['N-3'] }, 6),
      ev('INTEGRATION_RESULT', { nodeId: 'N-3', provedCriteria: [], dependents: ['N-4'] }, 7),
    ]);

    check('M3-12: a node that proves nothing earns credit only once a dependant actually runs',
      enabling.enablingCredits.join(',') === 'N-1', JSON.stringify(enabling.enablingCredits));
    check('M3-12b: an unblocking CLAIM with no dependent spawn earns nothing',
      claimed.enablingCredits.length === 0 && claimed.consecutiveNoProgress === 1,
      JSON.stringify(claimed));
    check('M3-12c: enabling credit is capped at two in a row',
      capped.enablingCredits.length === 2 && capped.consecutiveNoProgress === 1,
      JSON.stringify(capped.history.map((h) => h.currency)));
  }

  section('mission stage 3: a mission that is going nowhere stops saying so');
  {
    const missions = freshRegistry();
    const plan = graphOf([1, 2, 3, 4, 5].map((i) => node(makeNodeId('p/M-0001', i), {
      affectedCriteria: ['p/M-0001/C-0001'],
    })));
    const { missionId, oracle } = armed(missions, [criterion('p/M-0001/C-0001')], plan);
    const reasons: string[] = [];

    const result = await (runMissionLoop(missions, fakeHost({
      evaluate: async () => ({ results: [] }),      // nothing is ever proven
      replan: async (reason) => { reasons.push(reason); return null; },
    }), { missionId, oracle, budgets: { maxNoProgressCycles: 3 }, maxCycles: 12 }));

    const progress = evs(missions, missionId).filter((e) => e.type === 'MISSION_PROGRESS');
    check('M3-13: every cycle records what currency it earned',
      progress.length >= 3 && (progress[0].payload as any).currency === 'none',
      String(progress.length));
    check('M3-13b: three cycles of nothing forces the question rather than a fourth node',
      reasons.includes('NO_PROGRESS'), reasons.join(','));
    check('M3-13c: with no replan available the mission stops, and says PARTIAL not ACHIEVED',
      result.terminated && result.achievement !== 'ACHIEVED',
      `${result.achievement}/${result.terminationReason}`);
    check('M3-13d: an unevaluated contract is reported UNEVALUATED, never NONE',
      result.achievement === 'UNEVALUATED', result.achievement);
  }

  section('mission stage 3: oscillation is observed, and a flake is not a regression');
  {
    const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const ev = (type: string, payload: any, seq: number): StoredEvent =>
      ({ id: `e${seq}`, taskId: 'p/M-0001', seq, ts: at(seq), type, prev: '', payload });

    const log = [
      ev('ORACLE_EVALUATED', { results: [{ criterionId: 'C-1', outcome: 'PROVEN' }] }, 1),
      ev('ORACLE_EVALUATED', { results: [{ criterionId: 'C-1', outcome: 'FAILED' }] }, 2),
    ];
    const flips = detectFlips(log);
    const withFlake = [...log, ev('OSCILLATION_DETECTED',
      { criterionId: 'C-1', at: at(2), attribution: 'SUSPECTED_FLAKE' }, 3)];
    const withMiss = [...log, ev('OSCILLATION_DETECTED',
      { criterionId: 'C-1', at: at(2), attribution: 'VALIDATION_MISS' }, 3)];
    const inconclusive = [...log, ev('OSCILLATION_DETECTED',
      { criterionId: 'C-1', at: at(2), attribution: 'INCONCLUSIVE' }, 3)];

    check('M3-14: PROVEN then FAILED is observed as a flip',
      flips.length === 1 && flips[0].criterionId === 'C-1', JSON.stringify(flips));
    check('M3-14b: a flip the attribution machinery called a flake is not a genuine flip',
      genuineFlips(withFlake).length === 0);
    check('M3-14c: a validation miss stays a genuine flip',
      genuineFlips(withMiss).length === 1);
    check('M3-14d: an INCONCLUSIVE attribution stays a genuine flip — the safe direction',
      genuineFlips(inconclusive).length === 1);

    // And the loop records the observation without diagnosing it.
    const missions = freshRegistry();
    // Two nodes: the first proves the criterion, the second regresses it.
    // That is the only shape in which a flip can reach the loop at all.
    const plan = graphOf([
      node('p/M-0001/N-0001', { affectedCriteria: ['p/M-0001/C-0001'] }),
      node('p/M-0001/N-0002', { affectedCriteria: ['p/M-0001/C-0002'] }),
    ]);
    // Two required criteria, so proving the first does not end the mission
    // before the second node ever runs.
    const { missionId, oracle } = armed(missions,
      [criterion('p/M-0001/C-0001'), criterion('p/M-0001/C-0002')], plan);
    let n = 0;
    await (runMissionLoop(missions, fakeHost({
      evaluate: async () => {
        n += 1;
        return { results: [{ criterionId: 'p/M-0001/C-0001',
          outcome: (n === 1 ? 'PROVEN' : 'FAILED') as any, evidence: ['e'], detail: 'd' }] };
      },
      replan: async () => null,
    }), { missionId, oracle, maxCycles: 8 }));
    const recorded = evs(missions, missionId).filter((e) => e.type === 'OSCILLATION_DETECTED');
    check('M3-14e: the loop records the flip with an INCONCLUSIVE attribution, not a diagnosis',
      recorded.length === 1 && (recorded[0].payload as any).attribution === 'INCONCLUSIVE',
      JSON.stringify(recorded.map((r) => (r.payload as any).attribution)));
    check('M3-14f: and records it once, not once per cycle it is re-read',
      recorded.length === 1, String(recorded.length));
  }

  section('mission stage 3: budgets come from the log, and cost comes from the provider');
  {
    const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const ev = (type: string, payload: any, seq: number): StoredEvent =>
      ({ id: `e${seq}`, taskId: 'p/M-0001', seq, ts: at(seq), type, prev: '', payload });

    const log = [
      ev('MISSION_CREATED', {}, 1),
      ev('TASK_SPAWNED', { nodeId: 'N-1', providerUsage: { totalCostUsd: 0.4 } }, 2),
      ev('TASK_SPAWNED', { nodeId: 'N-2', repair: true, reason: 'failed integration' }, 3),
      ev('MISSION_REPLAN', { reason: 'PRECONDITION_DIVERGENCE' }, 4),
      ev('ORACLE_EVALUATED', { providerUsage: { inputTokens: 10 } }, 5),
    ];
    const u = missionUsage(log, 1_700_000_010_000);

    check('M3-15: usage is recounted from the log, never from a counter',
      u.tasksSpawned === 2 && u.repairs === 1 && u.plannedTasks === 1 && u.replans === 1,
      JSON.stringify(u));
    check('M3-15b: cost is only what a provider reported',
      u.costUsd === 0.4, String(u.costUsd));
    check('M3-15c: a call that reported no cost is unmetered, not free',
      u.unmeteredCalls === 1, String(u.unmeteredCalls));
    check('M3-15d: every reserve draw records why it was taken',
      u.reserveDraws.length === 2
      && u.reserveDraws.some((d) => d.kind === 'repair' && d.reason === 'failed integration'),
      JSON.stringify(u.reserveDraws));

    const b = mergeMissionBudgets({ costCeilingUsd: 0.3, maxTasks: 20 });
    const breach = checkMissionBudgets(b, u);
    check('M3-15e: the USD ceiling is enforced against provider-reported spend',
      breach !== null && breach.limit === 'costCeilingUsd', JSON.stringify(breach));
    check('M3-15f: the breach detail names the unmetered calls rather than hiding them',
      breach !== null && breach.detail.includes('reported no cost'), breach?.detail ?? '');

    const split = mergeMissionBudgets({ maxTasks: 10, reserveFraction: 0.4 });
    check('M3-15g: planned work may use 60% of the task budget and no more',
      !plannedExhausted(split, { ...u, plannedTasks: 5 })
      && plannedExhausted(split, { ...u, plannedTasks: 6 }));

    const clampDown = clampAchievement('ACHIEVED', 'PARTIAL');
    const clampUnknown = clampAchievement('PARTIAL', 'UNEVALUATED');
    const clampHonest = clampAchievement('NONE', 'PARTIAL');
    check('M3-15h: a caller cannot claim more than the criteria derive',
      clampDown.achievement === 'PARTIAL' && clampDown.downgraded);
    check('M3-15i: an unevaluated contract cannot be talked into a verdict',
      clampUnknown.achievement === 'UNEVALUATED' && clampUnknown.downgraded);
    check('M3-15j: claiming LESS than the evidence shows is allowed',
      clampHonest.achievement === 'NONE' && !clampHonest.downgraded);
  }

  section('mission stage 3: the live preflight refuses, or asks');
  {
    const iso = { backends: [], selected: 'systemd-scope', fallbackMode: false,
      resourceEnforcement: 'cgroup', resourceDetail: 'cgroup v2', enforces: [] } as any;
    const fallback = { ...iso, fallbackMode: true, selected: 'process-group',
      resourceEnforcement: 'rlimit', resourceDetail: 'rlimit only' };

    const provider = (over: any) => ({
      id: 'fake', available: async () => ({ ok: true, detail: 'ok' }),
      invoke: async () => ({
        ok: true, role: 'reviewer', structured: { zeus_selftest: 'ok' }, text: '', raw: '',
        exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null,
        providerUsage: { totalCostUsd: 0.001 }, ...over,
      }),
    }) as any;

    const base = { supervisor: {} as any, policy: {} as any, projectId: 'p', isolation: iso };

    // A state root per case, so one case cannot seed another's baseline.
    const vroot = (n: string) => path.join(TMP, `m316-${n}-${storeSeq += 1}`);
    const driftRoot = vroot('drift');
    const good = await (selftestLive({ ...base, providers: [provider({})],
      stateRoot: vroot('good'), versionOf: () => '1.2.3' }));
    const unparsed = await (selftestLive({ ...base, providers: [provider({ structured: null })],
      stateRoot: vroot('unparsed'), versionOf: () => '1.2.3' }));
    // Baseline first, then the same CLI reports a different version.
    await selftestLive({ ...base, providers: [provider({})],
      stateRoot: driftRoot, versionOf: () => '1.2.3' });
    const drifted = await (selftestLive({ ...base, providers: [provider({})],
      stateRoot: driftRoot, versionOf: () => '1.3.0' }));
    const unavailable = await (selftestLive({ ...base, providers: [{
      id: 'fake', available: async () => ({ ok: false, detail: 'not logged in' }), invoke: async () => ({}),
    } as any] }));
    const degraded = await (selftestLive({ ...base, isolation: fallback, providers: [provider({})] }));

    check('M3-16: a clean preflight neither refuses nor asks',
      !good.refused && !good.needsConfirmation, good.detail);
    check('M3-16b: output the transport cannot unwrap FAILS the run',
      unparsed.refused && unparsed.lanes.some((l) => l.lane === 'provider-contract'
        && l.status === 'FAIL'), unparsed.detail);
    check('M3-16c: a provider CLI that changed under Zeus asks rather than refuses',
      !drifted.refused && drifted.needsConfirmation
      && drifted.lanes.some((l) => l.lane === 'cli-version-drift' && l.status === 'DRIFT'),
      drifted.detail);
    check('M3-16d: an unavailable provider refuses the run and sends it nothing',
      unavailable.refused
      && unavailable.lanes.some((l) => l.lane === 'provider-contract' && l.status === 'SKIPPED'),
      unavailable.detail);
    check('M3-16e: quota silence is SKIPPED, not PASS',
      good.lanes.some((l) => l.lane === 'quota' && l.status === 'SKIPPED'));
    check('M3-16f: fallback isolation asks before a mission runs unattended',
      degraded.needsConfirmation
      && degraded.lanes.some((l) => l.lane === 'isolation-live' && l.status === 'DRIFT'));
    check('M3-16g: the preflight cost is provider-reported and inside its scaled cap',
      good.costUsd !== null && good.costUsd <= good.costCapUsd
      && good.costCapUsd === selftestCostCap(good.contacts),
      `$${good.costUsd} of $${good.costCapUsd} for ${good.contacts} contact(s)`);
  }
  section('mission stage 3: the CLI refuses in the right order');
  {
    const root = path.join(TMP, 'cli-demo');
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"name":"clidemo","scripts":{"test":"node -e 0"}}\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

    const cwd = process.cwd();
    process.chdir(root);
    let planBeforeOracle = 0, runBeforePlan = 0, planned = 0, reported = 0, selftestNoLive = 0;
    let accepted: string[] = [];
    try {
      await main(['init']);
      await main(['mission', 'create', 'make the unit tests pass']);
      // Planning before there is a contract, and running before there is a
      // plan: both refused, and refused for the right reason.
      planBeforeOracle = await main(['mission', 'plan', 'M-0001', '--mock']);
      await main(['mission', 'compile', 'M-0001', '--mock']);
      runBeforePlan = await main(['mission', 'run', 'M-0001', '--mock']);
      planned = await main(['mission', 'plan', 'M-0001', '--mock']);
      reported = await main(['mission', 'report', 'M-0001', '--json']);
      selftestNoLive = await main(['mission', 'selftest']);

      // The project id comes from the directory, not from package.json, so
      // the mission is found rather than assumed.
      const store = new EventStore(path.join(root, '.zeus', 'state'));
      const found = store.listTasks().find((t) => /\/M-\d+$/.test(t));
      accepted = found ? store.read(found).map((e) => e.type) : ['(no mission log found)'];
    } finally { process.chdir(cwd); }

    check('M3-17: zeus mission plan is refused before an oracle exists',
      planBeforeOracle === 1, String(planBeforeOracle));
    check('M3-17b: zeus mission run is refused before a plan is ACCEPTED',
      runBeforePlan === 1, String(runBeforePlan));
    check('M3-17c: planning an accepted contract succeeds and records PLAN_ACCEPTED',
      planned === 0 && accepted.includes('PLAN_ACCEPTED'), `${planned} / ${accepted.join(',')}`);
    check('M3-17d: the critique is recorded whether or not it found anything',
      accepted.includes('PLAN_CRITIQUED'));
    check('M3-17e: zeus mission report reads back from the log',
      reported === 0, String(reported));
    check('M3-17f: zeus mission selftest without --live is a usage error, not a silent no-op',
      selftestNoLive === 2, String(selftestNoLive));
  }
  section('selftest: the cost cap scales with the work the preflight does');
  {
    const iso = { backends: [], selected: 'systemd-scope', fallbackMode: false,
      resourceEnforcement: 'cgroup', resourceDetail: 'cgroup v2', enforces: [] } as any;
    const priced = (usd: number | null) => ({
      id: `p${usd === null ? 'x' : String(usd).replace('.', '')}`,
      available: async () => ({ ok: true, detail: 'ok' }),
      invoke: async () => ({
        ok: true, role: 'reviewer', structured: { zeus_selftest: 'ok' }, text: '', raw: '',
        exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null,
        ...(usd === null ? {} : { providerUsage: { totalCostUsd: usd } }),
      }),
    }) as any;
    const base = { supervisor: {} as any, policy: {} as any, projectId: 'p', isolation: iso };

    check('SC1: one contact is capped at the observed contact price plus headroom',
      selftestCostCap(1) === SELFTEST_PER_CONTACT_CAP_USD
      && SELFTEST_PER_CONTACT_CAP_USD >= OBSERVED_CONTACT_COST_USD,
      `${selftestCostCap(1)} vs observed ${OBSERVED_CONTACT_COST_USD}`);
    check('SC2: the cap scales with the number of providers contacted',
      selftestCostCap(2) === Number((SELFTEST_PER_CONTACT_CAP_USD * 2).toFixed(2))
      && selftestCostCap(3) > selftestCostCap(2), `${selftestCostCap(2)}/${selftestCostCap(3)}`);
    check('SC3: zero contacts still has a floor rather than a zero cap',
      selftestCostCap(0) === SELFTEST_PER_CONTACT_CAP_USD, String(selftestCostCap(0)));

    // The regression: the exact topology that broke the old constant — two
    // providers, one of them subscription-billed and reporting no price.
    const observed = await selftestLive({ ...base,
      providers: [priced(OBSERVED_CONTACT_COST_USD), priced(null)] });
    check('SC4: the observed two-provider preflight is INSIDE the cap',
      !observed.needsConfirmation && observed.contacts === 2
      && observed.costUsd === OBSERVED_CONTACT_COST_USD
      && observed.costUsd! <= observed.costCapUsd,
      `$${observed.costUsd} of $${observed.costCapUsd}, ${observed.contacts} contact(s)`);
    check('SC4b: the unpriced contact makes the total a LOWER BOUND, not a total',
      observed.costIsLowerBound && observed.unmeteredCalls === 1,
      JSON.stringify({ lb: observed.costIsLowerBound, un: observed.unmeteredCalls }));
    check('SC4c: an unpriced contact is never counted as free',
      observed.costUsd === OBSERVED_CONTACT_COST_USD, String(observed.costUsd));

    // And it can still catch a genuinely expensive preflight.
    const expensive = await selftestLive({ ...base, providers: [priced(5), priced(5)] });
    check('SC5: a preflight that really is expensive still trips the cap',
      expensive.needsConfirmation
      && expensive.lanes.some((l) => l.status === 'DRIFT' && l.detail.includes('cap')),
      expensive.detail);
    check('SC5b: the over-cap message names the unmetered contacts it could not price',
      (await selftestLive({ ...base, providers: [priced(5), priced(null)] }))
        .lanes.some((l) => l.status === 'DRIFT' && l.detail.includes('reported no price')));
  }

  section('selftest: the version baseline is durable, and first contact is not drift');
  {
    const root = path.join(TMP, `vb-${storeSeq += 1}`);
    const iso = { backends: [], selected: 'systemd-scope', fallbackMode: false,
      resourceEnforcement: 'cgroup', resourceDetail: 'cgroup v2', enforces: [] } as any;
    const prov = (id: string) => ({
      id, available: async () => ({ ok: true, detail: 'ok' }),
      invoke: async () => ({
        ok: true, role: 'reviewer', structured: { zeus_selftest: 'ok' }, text: '', raw: '',
        exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null,
      }),
    }) as any;
    const base = {
      supervisor: {} as any, policy: {} as any, projectId: 'p', isolation: iso,
      providers: [prov('claude')], stateRoot: root, now: () => '2026-01-01T00:00:00.000Z',
    };
    const laneOf = (r: any) => r.lanes.find((l: any) => l.lane === 'cli-version-drift');

    const first = await selftestLive({ ...base, versionOf: () => '1.2.3' });
    const again = await selftestLive({ ...base, versionOf: () => '1.2.3' });
    const moved = await selftestLive({ ...base, versionOf: () => '1.3.0' });
    const stillMoved = await selftestLive({ ...base, versionOf: () => '1.3.0' });

    check('VB1: the lane is no longer permanently SKIPPED',
      laneOf(first).status !== 'SKIPPED', laneOf(first).status);
    check('VB2: first contact records the baseline and is not drift',
      laneOf(first).status === 'PASS' && laneOf(first).detail.includes('baseline'),
      laneOf(first).detail);
    check('VB3: the same version later PASSES',
      laneOf(again).status === 'PASS', laneOf(again).detail);
    check('VB4: a changed version is DRIFT',
      laneOf(moved).status === 'DRIFT' && laneOf(moved).detail.includes('1.2.3 → 1.3.0'),
      laneOf(moved).detail);
    check('VB5: drift does not silently adopt the new version — it keeps reporting',
      laneOf(stillMoved).status === 'DRIFT', laneOf(stillMoved).detail);

    // The baseline is state on disk, so a fresh process sees it.
    const reread = readBaseline(root);
    check('VB6: the baseline survives restart, because it is state and not a cache',
      reread.providers.claude?.version === '1.2.3',
      JSON.stringify(reread.providers));
    check('VB7: it is a real file under the state root',
      fs.existsSync(baselinePath(root)), baselinePath(root));

    // Unknown is never a pass, and is never recorded.
    const quietRoot = path.join(TMP, `vb-${storeSeq += 1}`);
    const quiet = await selftestLive({ ...base, stateRoot: quietRoot, versionOf: () => null });
    check('VB8: a CLI that will not report a version is SKIPPED, never PASS',
      laneOf(quiet).status === 'SKIPPED', laneOf(quiet).status);
    check('VB9: and no version is invented for it',
      Object.keys(readBaseline(quietRoot).providers).length === 0,
      JSON.stringify(readBaseline(quietRoot).providers));

    // Going quiet AFTER a baseline exists is not agreement either.
    const wentQuiet = await selftestLive({ ...base, versionOf: () => null });
    check('VB10: a provider that goes quiet after a baseline exists does not PASS',
      laneOf(wentQuiet).status === 'SKIPPED', laneOf(wentQuiet).status);
    check('VB10b: and the lane names the baseline it could no longer check',
      laneOf(wentQuiet).detail.includes('1.2.3'), laneOf(wentQuiet).detail);

    // Nothing identifying is persisted.
    check('VB11: an account-shaped token is not recorded as a version',
      normaliseVersion('claude 1.4.0 (someone@example.com)') === null,
      String(normaliseVersion('claude 1.4.0 (someone@example.com)')));
    check('VB12: a version is the first line, whitespace-collapsed and bounded',
      normaliseVersion('  1.5.0   (build 9)\nextra line\n') === '1.5.0 (build 9)',
      String(normaliseVersion('  1.5.0   (build 9)\nextra line\n')));
    check('VB13: no version at all stays null rather than becoming a string',
      normaliseVersion(null) === null && normaliseVersion('   ') === null);

    // A compare must not establish a baseline as a side effect.
    const peekRoot = path.join(TMP, `vb-${storeSeq += 1}`);
    compareVersion(readBaseline(peekRoot), 'claude', '9.9.9');
    check('VB14: asking the question does not answer it — compare writes nothing',
      !fs.existsSync(baselinePath(peekRoot)));
  }
  section('zeus status: a mission in the store is not a broken status command');
  {
    const root = path.join(TMP, 'status-demo');
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"statusdemo"}\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

    const cwd = process.cwd();
    process.chdir(root);
    let plain = -1, byMissionId = -1;
    try {
      await main(['init']);
      await main(['mission', 'create', 'a goal nobody will plan']);
      // Before the fix this threw ScopeMismatchError out of cmdStatus: the
      // primary status command was broken on any project that had ever
      // created a mission.
      plain = await main(['status']);
      byMissionId = await main(['status', 'M-0001']);
    } finally { process.chdir(cwd); }

    check('ST1: zeus status survives a store that contains missions',
      plain === 0, String(plain));
    check('ST2: a mission id passed to zeus status is refused, not crashed on',
      byMissionId === 2, String(byMissionId));
  }
  section('mission stage 3: a refused plan is readable without paying for it again');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    const proposed = [
      node(`${rec.missionId}/N-0001`, {
        slug: 'do-a-thing',
        preconditions: [{ kind: 'workingTreeClean' as any, target: '.' }],
      }),
    ];
    missions.recordPlanRejected(rec.missionId, {
      version: 1, nodes: proposed,
      findings: [{ code: 'SCHEMA_INVALID', nodeId: proposed[0].nodeId, detail: 'bad kind' }],
      retryable: true, note: 'refused',
    });
    const ev = evs(missions, rec.missionId).find((e) => e.type === 'PLAN_REJECTED')!;
    const p = ev.payload as any;

    check('PR1: the refusal records WHAT was proposed, not only that it was refused',
      Array.isArray(p.nodes) && p.nodes.length === 1
      && p.nodes[0].nodeId === proposed[0].nodeId, JSON.stringify(Object.keys(p)));
    check('PR2: the invented precondition kind is legible from the log alone',
      p.nodes[0].preconditions[0].kind === 'workingTreeClean',
      JSON.stringify(p.nodes[0].preconditions));
    check('PR3: the findings and the retryability are still recorded',
      p.findings.length === 1 && p.retryable === true && p.nodeCount === 1);
    check('PR4: a refused plan is not an accepted one',
      missions.mission(rec.missionId)!.acceptedPlan === null);
  }
  section('mission stage 3: consent applies to the plan that was reviewed');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    const oracle = { ...oracleOf([criterion('p/M-0001/C-0001')]), missionId: rec.missionId };
    missions.recordOracle(rec.missionId, oracle, 'hash', { ok: true });
    missions.acceptOracle(rec.missionId, {
      acceptanceMode: 'AUTO', acceptedBy: 'auto', modeInputs: {}, modeReasons: [],
      escalatedByCritic: false,
    } as any);
    const v1 = graphOf([node(`${rec.missionId}/N-0001`, { slug: 'first' })], 1);
    const v2 = graphOf([node(`${rec.missionId}/N-0002`, { slug: 'second' })], 2);
    missions.recordPlan(rec.missionId, v1);
    missions.recordPlanCritique(rec.missionId, {
      version: 1, findings: [{ code: 'RISK', severity: 'ADVISORY', detail: 'watch this' }],
      acceptance: 'STOP', contaminated: false,
    });
    missions.recordPlan(rec.missionId, v2);
    missions.recordPlanCritique(rec.missionId, {
      version: 2, findings: [], acceptance: 'FLOW', contaminated: false,
    });

    // Accepting by version accepts the graph that version recorded, not the
    // newest one and not a freshly generated one.
    missions.acceptPlan(rec.missionId, v1, {
      acceptedBy: 'user-confirmed', acceptedDespite: ['ADVISORY RISK: watch this'],
    });
    const after = missions.mission(rec.missionId)!;
    const accepted = missions.events.read(rec.missionId)
      .filter((e) => e.type === 'PLAN_ACCEPTED').map((e) => e.payload as any);

    check('AP1: the accepted plan is the one that was reviewed, by version',
      after.acceptedPlanVersion === 1
      && after.acceptedPlan!.nodes[0].nodeId === `${rec.missionId}/N-0001`,
      `v${after.acceptedPlanVersion}`);
    check('AP2: the findings consented over are on the record, in full',
      accepted[0].acceptedDespite.length === 1
      && String(accepted[0].acceptedDespite[0]).includes('watch this'),
      JSON.stringify(accepted[0].acceptedDespite));
    check('AP3: consent names who gave it',
      accepted[0].acceptedBy === 'user-confirmed', accepted[0].acceptedBy);
    check('AP4: and only the accepted node may spawn — the newer plan is not a mandate',
      missions.authoriseNode(rec.missionId, `${rec.missionId}/N-0001`).ok
      && !missions.authoriseNode(rec.missionId, `${rec.missionId}/N-0002`).ok);
  }
  section('live contact: Zeus scratch is not the project’s work');
  {
    check('ZA1: the dependency cache is recognised as Zeus scratch',
      isZeusArtifact('.zeus-cache/npm/_cacache/content-v2/sha512/19/16/9743')
      && isZeusArtifact('.zeus-cache') && isZeusArtifact('./.zeus-cache/x'));
    check('ZA2: so is project state, wherever it is quoted or prefixed',
      isZeusArtifact('.zeus/state/tasks/x/events.jsonl') && isZeusArtifact('"' + '.zeus/logs/a' + '"'));
    check('ZA3: files that belong to the project are not',
      !isZeusArtifact('README.md') && !isZeusArtifact('src/zeus-cache.ts')
      && !isZeusArtifact('docs/.zeusish'), 'no false positives');
    check('ZA4: the pathspec and the exclude file name the same two things',
      ZEUS_PATHSPEC_EXCLUDES.length === ZEUS_WORKTREE_EXCLUDES.length
      && ZEUS_PATHSPEC_EXCLUDES.every((p) => p.includes('.zeus')),
      ZEUS_PATHSPEC_EXCLUDES.join(' '));
  }

  section('live contact: a mission’s USD ceiling can actually bind');
  {
    const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const ev = (type: string, payload: any, seq: number): StoredEvent =>
      ({ id: `e${seq}`, taskId: 'p/M-0001', seq, ts: at(seq), type, prev: '', payload });
    const log = [
      ev('MISSION_CREATED', {}, 1),
      ev('TASK_SPAWNED', { taskId: 'p/T-0001', nodeId: 'N-1' }, 2),
      ev('TASK_SPAWNED', { taskId: 'p/T-0002', nodeId: 'N-2' }, 3),
    ];
    // What the first live run actually looked like: the mission log carries no
    // cost at all, and every dollar is on the tasks it spawned.
    const taskLogs: Record<string, StoredEvent[]> = {
      'p/T-0001': [
        { id: 'a', taskId: 'p/T-0001', seq: 1, ts: at(1), type: 'AGENT_FINISHED', prev: '',
          payload: { providerUsage: { totalCostUsd: 0.6353065 } } },
        { id: 'b', taskId: 'p/T-0001', seq: 2, ts: at(2), type: 'AGENT_FINISHED', prev: '',
          payload: { providerUsage: { usage: { input_tokens: 4 } } } },
      ],
      'p/T-0002': [
        { id: 'c', taskId: 'p/T-0002', seq: 1, ts: at(3), type: 'AGENT_FINISHED', prev: '',
          payload: { providerUsage: { totalCostUsd: 0.7461 } } },
      ],
    };
    const spendOf = (id: string) => providerSpendOf(taskLogs[id] ?? []);

    const blind = missionUsage(log, 1_700_000_010_000);
    const seeing = missionUsage(log, 1_700_000_010_000, spendOf);

    check('MC1: without reaching into the task logs the mission reports nothing spent',
      blind.costUsd === 0, String(blind.costUsd));
    // Asserted as a value, not a bit pattern: each task's total is rounded to
    // six places before the mission adds them, so the last digit is a property
    // of double rounding rather than of anything worth pinning.
    check('MC2: reaching into them recovers the real provider-reported spend',
      Math.abs(seeing.costUsd - (0.6353065 + 0.7461)) < 0.000_01
      && seeing.costUsd > 0.7461, String(seeing.costUsd));
    check('MC3: a usage block with no price is unmetered, not zero',
      seeing.unmeteredCalls === 1, String(seeing.unmeteredCalls));

    const budgets = mergeMissionBudgets({ costCeilingUsd: 1 });
    check('MC4: the ceiling could never bind before, and binds now',
      checkMissionBudgets(budgets, blind) === null
      && checkMissionBudgets(budgets, seeing)?.limit === 'costCeilingUsd',
      JSON.stringify(checkMissionBudgets(budgets, seeing)));
    check('MC5: and the breach names the unpriced call it could not add in',
      checkMissionBudgets(budgets, seeing)!.detail.includes('reported no cost'),
      checkMissionBudgets(budgets, seeing)!.detail);
  }
  section('plan scope: the BC-2 replay — a global criterion, a one-file plan');
  {
    // The shape that cost $4.87: the criterion is read over a whole directory,
    // the plan's entire write surface is one file inside it, and coverage was
    // satisfied because coverage is NOMINAL.
    const criterionId = 'p/M-0001/C-0001';
    const globalCriterion = {
      criterionId,
      texts: ['npx tsc --noEmit && rg "implicit any" src/'],
    };
    const oneFilePlan = graphOf([node('p/M-0001/N-0001', {
      affectedCriteria: [criterionId], writes: ['src/one-file.ts'],
    })]);

    const gaps = scopeMismatchFindings(oneFilePlan, [globalCriterion]);
    check('SM1: a criterion read over src/ and a plan that writes one file inside it is flagged',
      gaps.length === 1 && gaps[0].code === 'CRITERION_SCOPE_MISMATCH', JSON.stringify(gaps));
    check('SM1b: the finding names the criterion, the scope, and what the plan actually writes',
      gaps[0].detail.includes(criterionId) && gaps[0].detail.includes('src/')
      && gaps[0].detail.includes('src/one-file.ts'), gaps[0].detail);
    check('SM1c: it is NON-BLOCKING — the plan may intend partial progress',
      gaps[0].severity === 'info', gaps[0].severity);

    // Coverage passes, which is the whole point: the two questions differ.
    const validation = validatePlanForOracle(oneFilePlan, [criterionId], [globalCriterion]);
    check('SM1d: coverage is satisfied and the plan still validates',
      validation.valid
      && !validation.findings.some((f) => f.code === 'CRITERION_UNCOVERED'),
      JSON.stringify(validation.findings.map((f) => f.code)));
    check('SM1e: but the scope mismatch rides along, so a human sees it before paying',
      validation.findings.some((f) => f.code === 'CRITERION_SCOPE_MISMATCH'));
  }

  section('plan scope: conservatism — it does not guess');
  {
    const cid = 'p/M-0001/C-0001';
    const wide = graphOf([node('p/M-0001/N-0001', {
      affectedCriteria: [cid], writes: ['src/**/*.ts'],
    })]);
    check('SM2: a plan whose glob covers the scope raises nothing',
      scopeMismatchFindings(wide, [{ criterionId: cid, texts: ['rg any src/'] }]).length === 0);

    const exact = graphOf([node('p/M-0001/N-0001', {
      affectedCriteria: [cid], writes: ['src/a.ts'],
    })]);
    check('SM2b: a criterion scoped to ONE FILE that the plan writes raises nothing',
      scopeMismatchFindings(exact, [{ criterionId: cid, texts: ['tsc src/a.ts'] }]).length === 0);

    check('SM2c: an evaluator with no extractable path raises nothing — no guessing',
      scopeMismatchFindings(exact, [{ criterionId: cid, texts: ['npm run typecheck'] }]).length === 0);
    check('SM2d: a bare word is not a path, and a flag is not a path',
      extractScopes(['jest --coverage --ci']).length === 0,
      JSON.stringify(extractScopes(['jest --coverage --ci'])));
    check('SM2e: a URL is not a filesystem scope',
      extractScopes(['curl https://example.com/health']).length === 0,
      JSON.stringify(extractScopes(['curl https://example.com/health'])));
    check('SM2f: a glob collapses to the fixed text before its wildcard',
      extractScopes(['rg x modules/api/src/**/*.ts']).join(',') === 'modules/api/src/',
      JSON.stringify(extractScopes(['rg x modules/api/src/**/*.ts'])));
    // Verbatim fragments from the first real plan this check ever saw. It
    // produced nine findings quoting minified JavaScript as if it were
    // directories — the exact false signal that teaches a reader to stop
    // reading the section.
    const inlineProbe = 'node -e const r=spawnSync(process.execPath,[tsc,"-p","tsconfig.json",'
      + '"--noEmit"],{cwd:"packages/x",encoding:"utf8"});const m=l.match(/error TS(\\d+)/);return';
    check('SM2f2: an inline program yields no scope at all',
      extractScopes([inlineProbe]).length === 0,
      JSON.stringify(extractScopes([inlineProbe])));
    check('SM2f3: a regex literal is not a directory',
      extractScopes(['node -e const RE=/@ts-nocheck|@ts-ignore/;const x=1']).length === 0,
      JSON.stringify(extractScopes(['node -e const RE=/@ts-nocheck|@ts-ignore/;const x=1'])));
    check('SM2f4: a path inside code punctuation is not extracted',
      extractScopes(['p.resolve("modules/api/src");const']).length === 0,
      JSON.stringify(extractScopes(['p.resolve("modules/api/src");const'])));
    check('SM2f5: and a genuine argument vector still yields its scope',
      extractScopes(['rg --files modules/api/src/']).join(',') === 'modules/api/src/',
      JSON.stringify(extractScopes(['rg --files modules/api/src/'])));

    check('SM2g: a file scope is not a directory scope',
      isDirectoryScope('src/') && isDirectoryScope('src/engine')
      && !isDirectoryScope('src/a.ts'));

    // An uncovered criterion is CRITERION_UNCOVERED's business, not this one's.
    const elsewhere = graphOf([node('p/M-0001/N-0001', {
      affectedCriteria: ['p/M-0001/C-0009'], writes: ['docs/x.md'],
    })]);
    check('SM2h: a criterion no node claims is left to CRITERION_UNCOVERED',
      scopeMismatchFindings(elsewhere, [{ criterionId: cid, texts: ['rg any src/'] }]).length === 0);

    // A covering node that writes nothing at all cannot move a path scope.
    const noWrites = graphOf([node('p/M-0001/N-0001', { affectedCriteria: [cid], writes: [] })]);
    const nw = scopeMismatchFindings(noWrites, [{ criterionId: cid, texts: ['rg any src/'] }]);
    check('SM2i: a covering node that writes nothing is flagged, and says so plainly',
      nw.length === 1 && nw[0].detail.includes('writes nothing under'), JSON.stringify(nw));

    // Only REQUIRED criteria reach this stop.
    const optionalOnly = validatePlanForOracle(
      graphOf([node('p/M-0001/N-0001', { affectedCriteria: [cid], writes: ['src/a.ts'] })]),
      [], [{ criterionId: cid, texts: ['rg any src/'] }]);
    check('SM2j: an OPTIONAL criterion does not raise this stop',
      !optionalOnly.findings.some((f) => f.code === 'CRITERION_SCOPE_MISMATCH'),
      JSON.stringify(optionalOnly.findings.map((f) => f.code)));
  }

  section('plan scope: the critic is asked the same question in words');
  {
    const header = PLAN_CRITIQUE_HEADER;
    check('SM3: the critic prompt asks, per required criterion, whether the writes can move it',
      /FOR EACH REQUIRED CRITERION/.test(header)
      && /union of the plan/i.test(header) && /FAILED to PROVEN/.test(header), 'question present');
    check('SM3b: and names the consequence, so the answer is not academic',
      /will report FAILED after the work is paid for/.test(header));
    check('SM3c: the planner is told estimatedCost is dollars, or the budget check compares nothing',
      /US DOLLAR COST/.test(PLAN_HEADER) && /never as spend/.test(PLAN_HEADER));
  }

  section('plan budget: a plan that does not fit is a conversation');
  {
    const budgets = mergeMissionBudgets({ maxTasks: 5, costCeilingUsd: 5 });
    const nodesOf = (n: number, cost?: number) =>
      Array.from({ length: n }, () => (cost === undefined ? {} : { estimatedCost: cost }));

    const fits = negotiateBudget(nodesOf(4), budgets);
    const tooMany = negotiateBudget(nodesOf(7), budgets);
    check('BN1: a plan with room for one repair fits',
      fits.fits && fits.tasksNeeded === 5, JSON.stringify(fits.reasons));
    check('BN2: seven nodes against a budget of five does not fit',
      !tooMany.fits && tooMany.tasksNeeded === 8, JSON.stringify(tooMany.reasons));
    check('BN2b: the rendering states both numbers and the three options',
      tooMany.rendered.includes('7 task(s)') && tooMany.rendered.includes('budget is 5')
      && tooMany.rendered.includes('raise the budget')
      && tooMany.rendered.includes('re-scope') && tooMany.rendered.includes('abort'),
      tooMany.rendered);

    const pricey = negotiateBudget(nodesOf(3, 4), budgets);
    check('BN3: estimated cost over the ceiling does not fit',
      !pricey.fits && pricey.estimatedCostUsd === 12, String(pricey.estimatedCostUsd));
    check('BN3b: and it is labelled an ESTIMATE, never observed spend',
      pricey.rendered.includes('ESTIMATES') && !pricey.rendered.includes('spent'),
      pricey.rendered);

    const unpriced = negotiateBudget(nodesOf(3), budgets);
    check('BN4: with no estimates there is no cost-based stop — numbers are never invented',
      unpriced.fits && unpriced.estimatedCostUsd === null
      && unpriced.rendered.includes('no cost estimate'), unpriced.rendered);
    check('BN4b: a zero estimate is treated as absent, not as free',
      negotiateBudget([{ estimatedCost: 0 }], budgets).estimatedCostUsd === null);
  }

  section('plan budget: a raise is an event, and survives a restart');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    const base = mergeMissionBudgets({ maxTasks: 5 });
    check('BR1x: before any revision the budget is the default',
      applyBudgetRevisions(base, evs(missions, rec.missionId)).maxTasks === 5);

    missions.reviseBudget(rec.missionId, { limit: 'maxTasks', from: 5, to: 8,
      reason: 'plan v1 needs 7 nodes plus one repair', decidedBy: 'user-confirmed' });

    // Re-read from the store, which is what a restarted process would do.
    const replayed = applyBudgetRevisions(base, missions.events.read(rec.missionId));
    check('BR2x: the revision is replayed from the log, not held in memory',
      replayed.maxTasks === 8, String(replayed.maxTasks));
    const ev = evs(missions, rec.missionId).find((e) => e.type === 'MISSION_BUDGET_REVISED')!;
    check('BR3x: the event records old and new, and who decided',
      (ev.payload as any).from === 5 && (ev.payload as any).to === 8
      && (ev.payload as any).decidedBy === 'user-confirmed', JSON.stringify(ev.payload));
    check('BR4x: a revision naming an unknown limit is ignored rather than obeyed',
      applyBudgetRevisions(base, [{ ...ev, payload: { limit: 'nonsense', to: 99 } } as any])
        .maxTasks === 5);
    check('BR5x: a non-numeric revision is ignored',
      applyBudgetRevisions(base, [{ ...ev, payload: { limit: 'maxTasks', to: 'lots' } } as any])
        .maxTasks === 5);

    // And the loop reads the same revised budget.
    const negotiation = negotiateBudget(Array.from({ length: 7 }, () => ({})), replayed);
    check('BR6x: after the raise, the plan that forced it now fits',
      negotiation.fits, negotiation.rendered);
  }

  section('plan budget: what a person saw is recorded');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    missions.recordPlanStopDecision(rec.missionId, {
      version: 1,
      rendered: ['CRITERION_SCOPE_MISMATCH: src/ vs one file', '7 tasks against a budget of 5'],
      decision: 'REFUSED_BUDGET', decidedBy: 'nobody yet', deferred: true,
    });
    const ev = evs(missions, rec.missionId).find((e) => e.type === 'PLAN_STOP_DECISION')!;
    const p = ev.payload as any;
    check('PS1: the stop records the RENDERING, not only the finding codes',
      p.rendered.length === 2 && String(p.rendered[0]).includes('src/ vs one file'),
      JSON.stringify(p.rendered));
    check('PS2: it records the decision and that nobody had made one yet',
      p.decision === 'REFUSED_BUDGET' && p.decidedBy === 'nobody yet');
    check('PS3: a non-terminal session is recorded as deferred, not as consent',
      p.deferred === true);
  }
  section('cost: pre-execution spend is spend');
  {
    const missions = freshRegistry();
    const rec = missions.create('goal', 'base0');
    const oracle = { ...oracleOf([criterion(`${rec.missionId}/C-0001`)]), missionId: rec.missionId };

    // What the CLI now passes through: the compiler, critic and planner all
    // report cost, and none of them runs inside a task.
    missions.recordOracle(rec.missionId, oracle, 'h', { ok: true },
      { totalCostUsd: 0.42 });
    missions.recordCritique(rec.missionId, {
      valid: true, findings: [], modeOpinion: null, promptHash: 'p', hashes: {},
      violations: [], criticProviderId: 'codex', reconciliation: {},
      providerUsage: { totalCostUsd: 0.31 },
    });
    const plan = graphOf([node(`${rec.missionId}/N-0001`)]);
    missions.recordPlan(rec.missionId, plan, [], { totalCostUsd: 0.77 });
    missions.recordPlanCritique(rec.missionId, {
      version: 1, findings: [], acceptance: 'FLOW', contaminated: false,
      providerUsage: { totalCostUsd: 0.15 },
    });

    const usage = missionUsage(evs(missions, rec.missionId), 1_700_000_000_000);
    check('PX1: oracle, critic, planner and plan-critic spend all reach the mission budget',
      Math.abs(usage.costUsd - 1.65) < 0.000_01, String(usage.costUsd));
    check('PX2: and it is counted without any task having been spawned',
      usage.tasksSpawned === 0, String(usage.tasksSpawned));
    check('PX3: a call that reported no price is still unmetered, not zero',
      missionUsage([...evs(missions, rec.missionId),
        { id: 'x', taskId: rec.missionId, seq: 99, ts: new Date(1_700_000_000_000).toISOString(),
          type: 'ORACLE_CRITIQUED', prev: '', payload: { providerUsage: { inputTokens: 5 } } }],
      1_700_000_000_000).unmeteredCalls === 1);
  }
}
