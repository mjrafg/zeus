/**
 * Mission Mode, stage 1.
 *
 * Everything here is deterministic. No provider is invoked: the mock provider
 * appears only where a test needs an `Engine` INSTANCE to call `createTask`,
 * and no test in this file runs a task.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { EventStore } from '../src/engine/events';
import { Engine } from '../src/engine/orchestrator';
import { ProcessSupervisor, listRunRecords, registryDirFor } from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { defaultPolicy } from '../src/engine/policy';
import { mockProvider } from '../src/engine/providers';
import { defaultConfig, writeConfig } from '../src/config';
import { readOnlyGit, GIT_WRITE_REFUSED_READONLY } from '../src/engine/gitro';
import { discoverEventTypes } from '../src/engine/eventtypes';
import { main } from '../src/cli';
import {
  makeMissionId, isMissionId, isTaskId, scopeOf, requireScope, ScopeMismatchError,
  missionIdToDir, MISSION_EVENT_TYPES, RESERVED_MISSION_EVENT_NAMES,
  ACHIEVEMENTS, TERMINATION_REASONS, PlanGraph, TaskNode,
} from '../src/mission/types';
import { MissionRegistry, reconstructFromEvents } from '../src/mission/registry';
import { validatePlan, PlanFindingCode, globsOverlap } from '../src/mission/plan';
import {
  ratchetRef, advanceRatchet, readRatchet, deleteRatchet, reconstructRatchet, refSafeProject,
} from '../src/mission/ratchet';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-mission-'));
const REPO = path.resolve(__dirname, '..');

function makeRepo(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return root;
}

/** A minimal well-formed node, so each test varies exactly one thing. */
function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    nodeId: id, description: `do ${id}`, dependsOn: [], preconditions: [],
    reads: [], writes: [], affectedCriteria: [], predictedEffects: [],
    estimatedTier: 'FAST', estimatedCost: 1, risk: 'LOW', ...over,
  };
}
const localLabelOf = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const graph = (nodes: TaskNode[], version = 1): PlanGraph => ({ version, nodes });
const codes = (g: PlanGraph): PlanFindingCode[] => validatePlan(g).findings.map((f) => f.code);

export async function missionSuite(): Promise<void> {
  // ---------------------------------------------------------------------
  section('mission identity: an M-id and a T-id are never interchangeable');
  {
    const store = new EventStore(path.join(TMP, 'ids'));
    const missions = new MissionRegistry({ events: store, projectId: 'demo' });
    const first = missions.create('first goal', 'abc123');
    const second = missions.create('second goal', 'abc123');

    check('MI1: mission ids are project-scoped, padded and sequential',
      first.missionId === 'demo/M-0001' && second.missionId === 'demo/M-0002',
      `${first.missionId}, ${second.missionId}`);
    check('MI2: the id is filesystem-safe by the same rule task ids use',
      missionIdToDir('demo/M-0001') === 'demo~M-0001'
      && EventStore.dirName('demo/M-0001') === missionIdToDir('demo/M-0001'));
    check('MI3: scope is decided by shape, and an unknown shape is neither',
      isMissionId('demo/M-0001') && !isTaskId('demo/M-0001')
      && isTaskId('demo/T-0001') && !isMissionId('demo/T-0001')
      && scopeOf('demo/M-0001') === 'MISSION' && scopeOf('demo/T-0001') === 'TASK'
      && scopeOf('demo/X-1') === null);

    let taskApi = 'accepted';
    try {
      const root = makeRepo('id-guard');
      const cfg = defaultConfig(root);
      const engine = new Engine({
        projectRoot: root, config: cfg,
        supervisor: new ProcessSupervisor(deriveBudgets(), undefined, path.join(root, '.zeus/state')),
        providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
      });
      engine.task('demo/M-0001');
    } catch (e: any) { taskApi = e instanceof ScopeMismatchError ? 'refused' : `threw ${e?.name}`; }
    check('MI4: a mission id passed to Engine.task() fails loudly, it does not resolve',
      taskApi === 'refused', taskApi);

    let missionApi = 'accepted';
    try { missions.mission('demo/T-0001'); }
    catch (e: any) { missionApi = e instanceof ScopeMismatchError ? 'refused' : `threw ${e?.name}`; }
    check('MI5: a task id passed to a mission API fails loudly too', missionApi === 'refused', missionApi);
    check('MI6: requireScope names what it got, not just what it wanted',
      (() => { try { requireScope('MISSION', 'demo/T-0007'); return ''; }
        catch (e: any) { return String(e.message); } })().includes('task id "demo/T-0007"'));
  }

  // ---------------------------------------------------------------------
  section('mission state: reconstruction is total over every log prefix');
  {
    const store = new EventStore(path.join(TMP, 'recon'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const rec = missions.create('reconstruct me', 'sha0');
    const id = rec.missionId;
    missions.recordPlan(id, graph([node('a'), node('b', { dependsOn: ['a'] })]));
    missions.taskSpawned(id, 'p/T-0001', 'a', 1);
    missions.taskOutcome(id, 'p/T-0001', 'COMPLETED', ['CHECK_RESULT']);
    missions.checkpoint(id, 'sha1', ['unit tests pass']);
    missions.invalidatePlan(id, 'a node became impossible', 2);
    missions.recordPlan(id, graph([node('a')], 2));
    missions.checkpoint(id, 'sha2', ['unit tests pass', 'typecheck clean']);
    missions.escalate(id, { reasonCode: 'AUTHORITY_REQUIRED', blocked: 'needs a decision' });
    missions.terminate(id, 'PARTIAL', 'BLOCKED');

    const all = store.read(id);
    check('MI10: the log holds every recorded event', all.length === 10, String(all.length));

    // Every prefix is a possible crash point. None may throw, and the fields
    // that only move one way must only move one way.
    let threw = '';
    let monotone = true;
    let lastCheckpoints = 0;
    let sawTerminated = false;
    for (let i = 0; i <= all.length; i += 1) {
      const prefix = all.slice(0, i);
      let r: ReturnType<typeof reconstructFromEvents> = null;
      try { r = reconstructFromEvents(id, prefix); }
      catch (e: any) { threw = `prefix ${i}: ${e?.message}`; break; }
      if (i === 0) { if (r !== null) monotone = false; continue; }
      if (!r) { threw = `prefix ${i}: no record from a log that starts with MISSION_CREATED`; break; }
      if (r.checkpoints.length < lastCheckpoints) monotone = false;
      lastCheckpoints = r.checkpoints.length;
      if (sawTerminated && !r.terminated) monotone = false;
      sawTerminated = sawTerminated || r.terminated;
      if (r.events !== prefix.length) monotone = false;
    }
    check('MI11: no prefix of the log throws during reconstruction', threw === '', threw);
    check('MI12: and state that must only move one way does', monotone);

    const final = missions.mission(id)!;
    check('MI13: the reconstructed record is the log, not a second copy',
      final.goal === 'reconstruct me' && final.planVersion === 2
      && final.spawned.length === 1 && final.spawned[0].outcome === 'COMPLETED'
      && final.checkpoints.length === 2 && final.ratchetSha === 'sha2'
      && final.planInvalidations.length === 1 && final.escalations === 1,
      JSON.stringify({ v: final.planVersion, sp: final.spawned.length, cp: final.checkpoints.length }));

    // A payload that makes no sense must not cost the rest of the log.
    store.append({ taskId: id, type: 'PLAN_RECORDED', payload: { version: 'not-a-number', plan: 42 } });
    let survived = true;
    try { missions.mission(id); } catch { survived = false; }
    check('MI14: a malformed payload is skipped, never fatal to reconstruction',
      survived && missions.mission(id)!.planVersion === 2);

    // The property, over generated sequences rather than one hand-built log.
    // Deterministic generator: a seeded LCG, so a failure is reproducible and
    // the suite does not pass or fail by luck.
    let seed = 20260820;
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const kinds = [
      () => ({ type: 'PLAN_RECORDED', payload: { version: rand(5), plan: { version: 1, nodes: [] } } }),
      () => ({ type: 'PLAN_INVALIDATED', payload: { reason: 'r', supersededBy: rand(5) } }),
      () => ({ type: 'TASK_SPAWNED', payload: { taskId: `p/T-000${rand(4)}`, nodeId: `n${rand(3)}`, planVersion: 1 } }),
      () => ({ type: 'TASK_OUTCOME', payload: { taskId: `p/T-000${rand(4)}`, state: 'COMPLETED', evidence: [] } }),
      () => ({ type: 'MISSION_CHECKPOINT', payload: { sha: `sha${rand(9)}`, invariants: ['i'] } }),
      () => ({ type: 'MISSION_ESCALATED', payload: { reasonCode: 'BLOCKED' } }),
      () => ({ type: 'CANCEL_REQUESTED', payload: { reason: 'r' } }),
      () => ({ type: 'MISSION_TERMINATED', payload: { achievement: 'PARTIAL', terminationReason: 'BLOCKED' } }),
      // Deliberately malformed: reconstruction must survive junk, because a
      // log is append-only and a bad payload cannot be taken back.
      () => ({ type: 'MISSION_CHECKPOINT', payload: { sha: null } as any }),
      () => ({ type: 'TASK_SPAWNED', payload: {} as any }),
    ];

    let failures = '';
    for (let run = 0; run < 40 && !failures; run += 1) {
      const gen = new EventStore(path.join(TMP, `prop-${run}`));
      const gm = new MissionRegistry({ events: gen, projectId: 'p' });
      const genId = gm.create(`generated ${run}`, 'sha').missionId;
      for (let i = 0; i < 12; i += 1) {
        const e = kinds[rand(kinds.length)]();
        gen.append({ taskId: genId, type: e.type, payload: e.payload });
      }
      const seq = gen.read(genId);
      let terminatedSeen = false;
      let cps = 0;
      let ratchet: string | null = null;
      for (let i = 1; i <= seq.length && !failures; i += 1) {
        let r;
        try { r = reconstructFromEvents(genId, seq.slice(0, i)); }
        catch (e: any) { failures = `run ${run} prefix ${i} threw: ${e?.message}`; break; }
        if (!r) { failures = `run ${run} prefix ${i}: null record`; break; }
        if (r.checkpoints.length < cps) failures = `run ${run} prefix ${i}: checkpoints went backwards`;
        cps = r.checkpoints.length;
        if (terminatedSeen && !r.terminated) failures = `run ${run} prefix ${i}: un-terminated`;
        terminatedSeen = terminatedSeen || r.terminated;
        if (ratchet && r.ratchetSha === null) failures = `run ${run} prefix ${i}: ratchet forgot its position`;
        ratchet = r.ratchetSha ?? ratchet;
        if (!(ACHIEVEMENTS as readonly string[]).includes(r.achievement)) {
          failures = `run ${run} prefix ${i}: achievement "${r.achievement}" is outside the vocabulary`;
        }
      }
    }
    check('MI15: over 40 generated sequences, every prefix reconstructs and stays monotone',
      failures === '', failures);
  }

  // ---------------------------------------------------------------------
  section('mission tasks: spawned tasks carry the mission, standalone ones do not');
  {
    const root = makeRepo('spawn');
    const cfg = defaultConfig(root);
    writeConfig(root, cfg);
    const engine = new Engine({
      projectRoot: root, config: cfg,
      supervisor: new ProcessSupervisor(deriveBudgets(), undefined, path.join(root, '.zeus/state')),
      providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
    });
    const missions = new MissionRegistry({
      events: engine.events, projectId: engine.projectId, stateRoot: engine.stateRoot,
    });
    const m = missions.create('ship the thing', 'sha0');
    const spawned = engine.createTask('a task the mission owns', { missionId: m.missionId });
    const standalone = engine.createTask('a task nobody owns');

    const payloadOf = (taskId: string) =>
      engine.events.read(taskId).find((e) => e.type === 'TASK_CREATED')!.payload as any;
    check('MI20: a spawned task records the mission that owns it',
      payloadOf(spawned.taskId).missionId === m.missionId);
    check('MI21: a standalone task has no missionId key at all — not null, absent',
      !('missionId' in payloadOf(standalone.taskId)));
    check('MI22: mission and task logs coexist in one store without colliding',
      engine.events.listTasks().includes(m.missionId)
      && engine.events.listTasks().includes(spawned.taskId)
      && missions.list().length === 1);
    check('MI23: task numbering ignores missions, and mission numbering ignores tasks',
      spawned.taskId.endsWith('T-0001') && standalone.taskId.endsWith('T-0002')
      && missions.nextMissionId().endsWith('M-0002'));
    let refused = false;
    try { engine.createTask('bad owner', { missionId: 'p/T-0001' }); } catch { refused = true; }
    check('MI24: a task id cannot masquerade as the owning mission', refused);
    engine.release();
  }

  // ---------------------------------------------------------------------
  section('plan validation: every finding code, positive and negative');
  {
    const good = graph([
      node('setup', { writes: ['src/a.ts'] }),
      node('impl', { dependsOn: ['setup'], reads: ['src/a.ts'], writes: ['src/b.ts'],
        preconditions: [{ kind: 'fileExists', target: 'src/a.ts' }],
        predictedEffects: [{ kind: 'expectedCheckTransition', check: 'unit', from: 'TEST_FAILED', to: 'PASSED' }] }),
    ]);
    const v = validatePlan(good);
    check('MI30: a coherent plan is valid and reports nothing',
      v.valid && v.findings.length === 0 && v.roots.join() === 'setup' && v.nodeCount === 2,
      JSON.stringify(v.findings));

    check('MI31: DUPLICATE_NODE_ID — positive',
      codes(graph([node('a'), node('a')])).includes('DUPLICATE_NODE_ID'));
    check('MI31b: and negative', !codes(graph([node('a'), node('b')])).includes('DUPLICATE_NODE_ID'));

    check('MI32: DANGLING_DEPENDENCY — positive',
      codes(graph([node('a', { dependsOn: ['ghost'] })])).includes('DANGLING_DEPENDENCY'));
    check('MI32b: and negative', !codes(good).includes('DANGLING_DEPENDENCY'));

    const cyc = validatePlan(graph([
      node('a', { dependsOn: ['c'] }), node('b', { dependsOn: ['a'] }), node('c', { dependsOn: ['b'] })]));
    const cycle = cyc.findings.find((f) => f.code === 'CYCLE');
    check('MI33: CYCLE — positive, and the PATH is reported, not just the fact',
      !!cycle && Array.isArray(cycle.path) && cycle.path.length === 4
      && cycle.path[0] === cycle.path[cycle.path.length - 1]
      && cycle.detail.includes('->'),
      cycle ? cycle.path?.join(' -> ') : 'no cycle finding');
    check('MI33b: and negative', !codes(good).includes('CYCLE'));

    check('MI34: SCHEMA_INVALID — a prose effect is not expressible',
      codes(graph([node('a', { predictedEffects: [{ kind: 'improves things' } as any] })]))
        .includes('SCHEMA_INVALID'));
    check('MI34b: SCHEMA_INVALID — a half-typed effect is caught too',
      codes(graph([node('a', {
        predictedEffects: [{ kind: 'expectedArtifact', path: 'x' } as any] })])).includes('SCHEMA_INVALID'));
    check('MI34c: SCHEMA_INVALID — bad tier, risk, cost and precondition',
      ['estimatedTier', 'risk', 'estimatedCost', 'preconditions'].every((field) => {
        const over: any = { estimatedTier: 'TURBO' };
        if (field === 'risk') { over.estimatedTier = 'FAST'; over.risk = 'SPICY'; }
        if (field === 'estimatedCost') { over.estimatedTier = 'FAST'; over.estimatedCost = -1; }
        if (field === 'preconditions') { over.estimatedTier = 'FAST'; over.preconditions = [{ kind: 'vibes', target: 'x' }]; }
        return codes(graph([node('a', over)])).includes('SCHEMA_INVALID');
      }));
    check('MI34d: and negative', !codes(good).includes('SCHEMA_INVALID'));

    // Unreachable: a node whose only dependency is itself part of a cycle
    // detached from every root.
    const unreachable = graph([node('root'), node('x', { dependsOn: ['y'] }), node('y', { dependsOn: ['x'] })]);
    check('MI35: UNREACHABLE_NODE — positive',
      codes(unreachable).includes('UNREACHABLE_NODE'));
    check('MI35b: and negative', !codes(good).includes('UNREACHABLE_NODE'));

    const interfering = graph([
      node('p', { writes: ['src/shared.ts'] }),
      node('q', { writes: ['src/shared.ts'] }),
      node('r', { dependsOn: ['p'], reads: ['src/shared.ts'] }),
    ]);
    const iv = validatePlan(interfering);
    const inter = iv.findings.filter((f) => f.code === 'UNDECLARED_INTERFERENCE');
    check('MI36: UNDECLARED_INTERFERENCE — positive, between the unordered pair',
      inter.some((f) => [f.nodeId, f.otherNodeId].sort().join() === 'p,q'),
      inter.map((f) => `${f.nodeId}~${f.otherNodeId}`).join(' '));
    check('MI36b: it is data, not a blocker — the plan is still valid',
      iv.valid && inter.every((f) => f.severity === 'info'));
    check('MI36c: a pair ORDERED by a dependency is not interference',
      !inter.some((f) => [f.nodeId, f.otherNodeId].sort().join() === 'p,r'));
    check('MI36d: and the overlapping paths are named',
      inter[0] && Array.isArray(inter[0].overlap) && inter[0].overlap.length > 0);
    check('MI36e: glob overlap is conservative in the reporting direction',
      globsOverlap('src/*', 'src/a.ts') && globsOverlap('src/a.ts', 'src/a.ts')
      && !globsOverlap('src/a.ts', 'src/b.ts'));

    check('MI37: findings are typed, never prose-only',
      validatePlan(graph([node('a', { dependsOn: ['ghost'] })])).findings
        .every((f) => typeof f.code === 'string' && typeof f.severity === 'string' && !!f.detail));
  }

  // ---------------------------------------------------------------------
  section('terminal model: two dimensions, independent, absorbing');
  {
    const store = new EventStore(path.join(TMP, 'terminal'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });

    check('MI40: UNEVALUATED is a value, not the absence of one',
      ACHIEVEMENTS.includes('UNEVALUATED') && ACHIEVEMENTS.includes('NONE')
      && (ACHIEVEMENTS as readonly string[]).indexOf('UNEVALUATED')
        !== (ACHIEVEMENTS as readonly string[]).indexOf('NONE'));
    check('MI41: a fresh mission is UNEVALUATED, never NONE',
      missions.create('unjudged', 'sha').achievement === 'UNEVALUATED');

    // The pairs a single collapsed enum could not express.
    const pairs: Array<[typeof ACHIEVEMENTS[number], typeof TERMINATION_REASONS[number]]> = [
      ['ACHIEVED', 'COMPLETED'],
      ['PARTIAL', 'BUDGET_EXCEEDED'],
      ['NONE', 'NOT_ACHIEVABLE'],
      ['UNEVALUATED', 'AUTHORITY_REQUIRED'],
      ['PARTIAL', 'POLICY_REFUSAL'],
    ];
    const recorded = pairs.map(([a, r]) => {
      const m = missions.create(`goal ${a}/${r}`, 'sha');
      missions.terminate(m.missionId, a, r);
      const back = missions.mission(m.missionId)!;
      return back.achievement === a && back.terminationReason === r;
    });
    check('MI42: achievement and terminationReason are recorded independently',
      recorded.every(Boolean), `${recorded.filter(Boolean).length}/${pairs.length}`);

    const m = missions.create('absorbing', 'sha');
    missions.terminate(m.missionId, 'PARTIAL', 'BLOCKED');
    const second = missions.terminate(m.missionId, 'ACHIEVED', 'COMPLETED');
    const after = missions.mission(m.missionId)!;
    check('MI43: termination is absorbing — a second verdict cannot rewrite the first',
      second === false && after.achievement === 'PARTIAL' && after.terminationReason === 'BLOCKED',
      `${after.achievement}/${after.terminationReason}`);
    check('MI44: every reason in the vocabulary is expressible',
      TERMINATION_REASONS.length === 9 && TERMINATION_REASONS.includes('UNRESOLVED_JUDGMENT')
      && TERMINATION_REASONS.includes('ARCHITECTURAL_CONFLICT'));
  }

  // ---------------------------------------------------------------------
  section('mission cancel: absorbing, and it reaches live tasks across processes');
  {
    const root = makeRepo('cancel');
    const stateRoot = path.join(root, '.zeus/state');
    const store = new EventStore(stateRoot);
    const missions = new MissionRegistry({ events: store, projectId: 'p', stateRoot });
    const m = missions.create('cancel me', 'sha');
    const taskId = 'p/T-0001';
    missions.taskSpawned(m.missionId, taskId, 'a', 1);

    // A real process, registered the way a real task's execution is, so cancel
    // has something to reach — and it reaches it through the on-disk registry,
    // which is the path that works from another process.
    const sup = new ProcessSupervisor(deriveBudgets({ lightTimeoutSeconds: 120 }), undefined, stateRoot);
    const sh = path.join(TMP, 'sleep.sh');
    fs.writeFileSync(sh, '#!/bin/bash\nsleep 120\n', { mode: 0o755 });
    const running = sup.run({
      id: 'mission-task', projectId: 'p', taskId, cls: 'light',
      command: sh, args: [], cwd: TMP, policy: defaultPolicy(TMP, TMP),
      confineFilesystem: false, timeoutSeconds: 120,
    } as any);
    let live: ReturnType<typeof listRunRecords> = [];
    for (let i = 0; i < 60 && !live.length; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      live = listRunRecords(registryDirFor(stateRoot)).filter((r) => r.taskId === taskId);
    }
    check('MI50: the spawned task is live and visible in the run registry', live.length === 1);

    const result = missions.cancel(m.missionId, 'operator changed their mind');
    const outcome = await running;
    check('MI51: cancelling the mission kills its live task through the registry',
      result.cancelled && result.killed >= 1 && result.tasks.includes(taskId),
      JSON.stringify({ killed: result.killed, tasks: result.tasks }));
    // M1 observed this as `!== 'COMPLETED'`, because a registry-driven kill
    // reached the process but carried no reason, so the owner classified an
    // ordinary cancellation as RESOURCE_LIMIT_EXCEEDED. The intent now crosses
    // the process boundary, so the observation becomes an assertion.
    check('MI52: and the owner classified it CANCELLED, not a resource event',
      outcome.outcome === 'CANCELLED' && outcome.productSignal === false,
      `${outcome.outcome} signal=${outcome.signal}`);

    const after = missions.mission(m.missionId)!;
    check('MI53: the mission ends CANCELLED, with achievement left UNEVALUATED',
      after.terminated && after.terminationReason === 'CANCELLED'
      && after.achievement === 'UNEVALUATED' && after.cancelRequested);
    check('MI54: the spawned task is recorded CANCELLED too, not left RUNNING',
      after.spawned[0].outcome === 'CANCELLED');
    const again = missions.cancel(m.missionId, 'again');
    const settled = missions.mission(m.missionId)!;
    check('MI55: cancellation is absorbing — nothing advances a cancelled mission',
      again.cancelled === false
      && missions.terminate(m.missionId, 'ACHIEVED', 'COMPLETED') === false
      && settled.terminationReason === 'CANCELLED' && settled.achievement === 'UNEVALUATED');
    sup.shutdown('mission cancel test finished');
  }

  // ---------------------------------------------------------------------
  section('ratchet: the event is the truth, the ref is a pointer');
  {
    const root = makeRepo('ratchet');
    const store = new EventStore(path.join(root, '.zeus/state'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const m = missions.create('ratchet me', 'sha');
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    check('MI60: the ref is namespaced under zeus/ AND scoped by project',
      ratchetRef(m.missionId) === 'refs/zeus/mission/p/M-0001/green'
      && !ratchetRef(m.missionId).startsWith('refs/heads/'), ratchetRef(m.missionId));
    // git's ref-name rules are stricter than the filesystem's, so the ref name
    // is checked by git rather than by our reading of the rules.
    const legal = (ref: string): boolean => {
      try {
        execFileSync('git', ['check-ref-format', ref], { stdio: 'ignore' });
        return true;
      } catch { return false; }
    };
    check('MI60b: the generated ref is one git will actually accept',
      legal(ratchetRef(m.missionId)));
    // Directory sanitisation cannot be reused: it maps unsafe characters to
    // `~`, which is one of the characters git forbids in a ref.
    check('MI60c: a project id needing sanitisation still yields a legal ref',
      ['a b/M-0001', 'weird~name/M-0001', 'has:colon/M-0001', 'dot.name/M-0001', '../M-0001']
        .every((id) => legal(ratchetRef(id))),
      ['a b/M-0001', 'weird~name/M-0001', 'has:colon/M-0001', 'dot.name/M-0001', '../M-0001']
        .filter((id) => !legal(ratchetRef(id))).map((id) => ratchetRef(id)).join(', '));
    check('MI60d: sanitisation stays injective — two ids that collapse alike stay distinct',
      refSafeProject('a b') !== refSafeProject('a-b')
      && refSafeProject('a:b') !== refSafeProject('a b')
      && refSafeProject('plain') === 'plain',
      `${refSafeProject('a b')} vs ${refSafeProject('a-b')}`);

    check('MI61: nothing has advanced it yet', missions.mission(m.missionId)!.ratchetSha === null
      && readRatchet(root, m.missionId) === null);

    // A test-only driver: stage 1 provides the mechanism, the integration loop
    // that would call it is stage 3.
    missions.checkpoint(m.missionId, head, ['unit tests pass', 'typecheck clean']);
    advanceRatchet(root, m.missionId, head);
    check('MI62: a checkpoint advances the log and the ref together',
      missions.mission(m.missionId)!.ratchetSha === head && readRatchet(root, m.missionId) === head);
    check('MI63: the ref does not appear among the branches',
      !execFileSync('git', ['-C', root, 'branch', '--list'], { encoding: 'utf8' }).includes('M-0001'));

    deleteRatchet(root, m.missionId);
    check('MI64: the ref can be lost without the mission losing anything',
      readRatchet(root, m.missionId) === null
      && missions.mission(m.missionId)!.ratchetSha === head);
    const r = reconstructRatchet(root, missions.mission(m.missionId)!);
    check('MI65: reconstruction restores it byte-identically from the log',
      r.action === 'created' && r.after === head && readRatchet(root, m.missionId) === head,
      JSON.stringify(r));

    // Forged forward: the ref is not authoritative, so reconstruction pulls it
    // back to what the events actually prove.
    execFileSync('git', ['-C', root, 'update-ref', ratchetRef(m.missionId),
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]);
    const noCheckpoint = new EventStore(path.join(root, '.zeus/state2'));
    const m2 = new MissionRegistry({ events: noCheckpoint, projectId: 'p' });
    const other = m2.create('never checkpointed', 'sha');
    const rr = reconstructRatchet(root, m2.mission(other.missionId)!);
    check('MI66: a mission with no checkpoint has nothing to restore, and says so',
      rr.action === 'nothing-to-restore' && rr.expected === null);

    // Two projects in ONE repository, both with an M-0001. This is the
    // collision the scoping exists to prevent, so it is exercised rather than
    // argued: both refs live, both reconstruct, neither sees the other.
    const alphaStore = new EventStore(path.join(root, '.zeus/state-alpha'));
    const betaStore = new EventStore(path.join(root, '.zeus/state-beta'));
    const alpha = new MissionRegistry({ events: alphaStore, projectId: 'alpha' });
    const beta = new MissionRegistry({ events: betaStore, projectId: 'beta' });
    const am = alpha.create('alpha goal', 'sha');
    const bm = beta.create('beta goal', 'sha');
    check('MI69: two projects can both hold an M-0001',
      localLabelOf(am.missionId) === localLabelOf(bm.missionId)
      && am.missionId !== bm.missionId, `${am.missionId} / ${bm.missionId}`);
    check('MI69b: and their ratchet refs are distinct',
      ratchetRef(am.missionId) !== ratchetRef(bm.missionId)
      && ratchetRef(am.missionId) === 'refs/zeus/mission/alpha/M-0001/green'
      && ratchetRef(bm.missionId) === 'refs/zeus/mission/beta/M-0001/green');
    const second = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    alpha.checkpoint(am.missionId, second, ['alpha invariant']);
    beta.checkpoint(bm.missionId, second, ['beta invariant']);
    reconstructRatchet(root, alpha.mission(am.missionId)!);
    reconstructRatchet(root, beta.mission(bm.missionId)!);
    check('MI69c: each reconstructs from its OWN log, into its own ref',
      readRatchet(root, am.missionId) === second && readRatchet(root, bm.missionId) === second
      && alpha.mission(am.missionId)!.checkpoints[0].invariants[0] === 'alpha invariant'
      && beta.mission(bm.missionId)!.checkpoints[0].invariants[0] === 'beta invariant');
    deleteRatchet(root, am.missionId);
    check('MI69d: deleting one project\'s ratchet leaves the other untouched',
      readRatchet(root, am.missionId) === null && readRatchet(root, bm.missionId) === second);

    // G-U2: moving a ref is a repository WRITE.
    const ro = readOnlyGit(root);
    const attempts = [
      ['update-ref', ratchetRef(m.missionId), head],
      ['update-ref', '-d', ratchetRef(m.missionId)],
      ['push', 'origin', `${ratchetRef(m.missionId)}:${ratchetRef(m.missionId)}`],
    ];
    const refused = attempts.map((argv) => {
      try { ro(argv); return null; } catch (e: any) { return e?.code; }
    });
    check('MI67: read-only git refuses every zeus/mission ref write, before spawning',
      refused.every((c) => c === GIT_WRITE_REFUSED_READONLY), JSON.stringify(refused));
    check('MI68: and the ref really did not move',
      readRatchet(root, m.missionId) === head);
  }

  // ---------------------------------------------------------------------
  section('mission events go through the same sink and the same chain');
  {
    const store = new EventStore(path.join(TMP, 'redact'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const secret = 'sk-live-MISSIONGOALSECRET0123456789';
    const m = missions.create(`fix the deploy, the token is ${secret}`, 'sha');
    const raw = fs.readFileSync(store.logPath(m.missionId), 'utf8');
    check('MI70: a secret in a goal is redacted before it is written',
      !raw.includes(secret) && /\[redacted:api-key\]/.test(raw));
    check('MI71: and the reconstructed goal shows the redaction, not the secret',
      !missions.mission(m.missionId)!.goal.includes(secret));
    missions.checkpoint(m.missionId, 'deadbeef', ['x']);
    missions.terminate(m.missionId, 'ACHIEVED', 'COMPLETED');
    const report = store.verify(m.missionId);
    check('MI72: the hash chain verifies over a mission log',
      report.ok && report.events === 3, JSON.stringify(report.problems));

    // The inventory has to find these on its own; a probe that needs updating
    // by hand for every new family of events is a probe that goes stale.
    const discovered = discoverEventTypes(REPO).map((t) => t.type);
    const missing = MISSION_EVENT_TYPES.filter((t) => !discovered.includes(t));
    check('MI73: the event-type inventory discovers the mission events automatically',
      missing.length === 0, missing.join(', '));
    check('MI74: and reserved names are NOT counted as events that exist',
      RESERVED_MISSION_EVENT_NAMES.every((n) => !discovered.includes(n)),
      RESERVED_MISSION_EVENT_NAMES.filter((n) => discovered.includes(n)).join(', '));
  }

  // ---------------------------------------------------------------------
  section('mission CLI: create, status, list, cancel');
  {
    const root = makeRepo('cli');
    const cwd = process.cwd();
    let say: string[] = [];
    const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
    /**
     * Captures ONLY what the CLI call writes.
     *
     * An earlier version replaced console.log for the whole section, which
     * swallowed the harness's own check lines and mixed them into the JSON
     * the next assertion tried to parse.
     */
    const run = async (...argv: string[]): Promise<number> => {
      say = [];
      // The CLI writes to the streams directly, not through console — that is
      // what makes its output usable in a pipe — so the streams are what a
      // test has to capture.
      const outW = process.stdout.write.bind(process.stdout);
      const errW = process.stderr.write.bind(process.stderr);
      const grab = (chunk: any): boolean => { say.push(String(chunk)); return true; };
      (process.stdout as any).write = grab;
      (process.stderr as any).write = grab;
      process.chdir(root);
      try { return await main(argv); }
      finally {
        process.chdir(cwd);
        (process.stdout as any).write = outW;
        (process.stderr as any).write = errW;
      }
    };
    const said = (): string => strip(say.join(''));

    await run('init');

    const createCode = await run('mission', 'create', 'make the flaky test deterministic');
    const created = said();
    check('MI80: create records a mission and prints its id',
      createCode === 0 && /M-0001/.test(created) && /make the flaky test deterministic/.test(created),
      created.split('\n')[0]);
    check('MI81: create does not plan — it says so rather than implying one exists',
      /no plan yet/.test(created));

    const statusCode = await run('mission', 'status', 'M-0001');
    const status = said();
    check('MI82: status reconstructs the mission from its log',
      statusCode === 0 && /goal /.test(status) && /plan +none/.test(status)
      && /achievement +UNEVALUATED/.test(status) && /ratchet +not advanced/.test(status),
      status.split('\n').slice(0, 3).join(' | '));

    await run('mission', 'status', 'M-0001', '--json');
    const parsed = JSON.parse(said());
    check('MI83: --json emits the typed record, and it parses',
      parsed.missionId.endsWith('/M-0001') && parsed.achievement === 'UNEVALUATED'
      && parsed.terminationReason === null && parsed.planVersion === null
      && Array.isArray(parsed.spawned) && Array.isArray(parsed.checkpoints)
      && parsed.ratchetRef === ratchetRef(parsed.missionId) && parsed.ratchetRefSha === null
      && /^refs\/zeus\/mission\/.+\/M-0001\/green$/.test(parsed.ratchetRef),
      JSON.stringify({ id: parsed.missionId, a: parsed.achievement }));

    await run('mission', 'create', 'a second mission');
    await run('mission', 'list');
    const listed = said();
    check('MI84: list shows every mission in the project with its state',
      /M-0001/.test(listed) && /M-0002/.test(listed) && /ACTIVE/.test(listed), listed.trim());

    const cancelCode = await run('mission', 'cancel', 'M-0001', '--reason', 'changed my mind');
    const cancelled = said();
    check('MI85: cancel terminates the mission and reports what it reached',
      cancelCode === 0 && /CANCELLED/.test(cancelled), cancelled.trim());
    await run('mission', 'status', 'M-0001', '--json');
    const afterJson = JSON.parse(said());
    check('MI86: and the reconstructed record agrees',
      afterJson.terminated === true && afterJson.terminationReason === 'CANCELLED'
      && afterJson.achievement === 'UNEVALUATED');
    const again = await run('mission', 'cancel', 'M-0001');
    check('MI87: cancelling a terminated mission is refused, not repeated', again === 1);

    const bad = await run('mission', 'status', 'T-0001');
    const badText = said();
    check('MI88: a task id is refused by the mission CLI, by name',
      bad === 2 && /mission id expected/.test(badText), `${bad}: ${badText.trim()}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
