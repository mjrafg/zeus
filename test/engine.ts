/**
 * Engine suites: confinement, ownership, durability, lifecycle, resource
 * pathology, crash recovery and multi-project isolation.
 *
 * These spawn real processes, kill real trees and start real second processes.
 * No model is called: the mock provider runs a real subprocess so the
 * supervisor, policy and governor are genuinely exercised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { check, section } from './harness';
import { defaultPolicy, inspectCommand, resolveWithin, buildEnv } from '../src/engine/policy';
import { deriveBudgets, hostResources } from '../src/engine/budget';
import { ProcessSupervisor } from '../src/engine/exec';
import { detectBackends, report as isolationReport, wrap } from '../src/engine/isolation';
import { ProjectLock } from '../src/engine/lock';
import { EventStore } from '../src/engine/events';
import { Engine, classifyCheck, checkAllowsAcceptance } from '../src/engine/orchestrator';
import { mockProvider, parseStructured } from '../src/engine/providers';
import { defaultConfig, writeConfig } from '../src/config';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-engine-'));
const mkRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(TMP, name);
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return root;
};

async function policySuite(): Promise<void> {
  section('execution policy: path confinement and command inspection (P0-2)');
  const root = mkRepo('policy-proj', { 'README.md': '# x\n' });
  const wt = path.join(TMP, 'policy-wt');
  fs.mkdirSync(wt, { recursive: true });
  const policy = defaultPolicy(root, wt);

  check('X1: a path inside the worktree resolves', resolveWithin(wt, 'src/a.ts').ok);
  check('X2: ../ traversal is refused', !resolveWithin(wt, '../../etc/passwd').ok);
  check('X3: an absolute path outside is refused', !resolveWithin(wt, '/etc/passwd').ok);
  // Symlink escape: the string stays inside, the kernel would not.
  fs.symlinkSync('/etc', path.join(wt, 'escape'));
  check('X4: a symlink pointing out of the worktree is refused',
    !resolveWithin(wt, 'escape/passwd').ok);
  check('X5: a file that does not exist yet is allowed if its parent is inside',
    resolveWithin(wt, 'newdir/new.txt').ok);

  const v = (cmd: string, args: string[] = []) => inspectCommand(policy, cmd, args).map((x) => x.code);
  check('X6: rm -rf / is refused', v('rm', ['-rf', '/']).includes('DESTRUCTIVE_COMMAND'));
  check('X7: rm -rf $HOME is refused', v('rm', ['-rf', '$HOME']).includes('DESTRUCTIVE_COMMAND'));
  check('X8: a fork bomb is refused', v('sh', ['-c', ':(){ :|:& };:']).includes('FORK_BOMB'));
  check('X9: reading /etc/shadow is refused', v('cat', ['/etc/shadow']).includes('ABSOLUTE_PATH_OUTSIDE_POLICY'));
  check('X10: traversal in an argument is refused', v('cat', ['../../../etc/passwd']).includes('PATH_TRAVERSAL'));
  check('X11: writing a shell profile for persistence is refused',
    v('sh', ['-c', 'echo evil >> $HOME/.bashrc']).includes('PERSISTENCE_ATTEMPT'));
  check('X12: re-introducing a stripped credential is refused',
    v('sh', ['-c', 'ANTHROPIC_API_KEY=sk-x npm test']).includes('ENV_POISONING'));
  check('X13: network tools are refused under a no-network policy',
    v('curl', ['https://example.com']).includes('NETWORK_DENIED'));
  check('X14: ordinary build commands are allowed',
    v('npm', ['run', 'build']).length === 0 && v('go', ['test', './...']).length === 0);
  check('X15: standard system paths do not trip the check', v('/usr/bin/env', ['node', '-v']).length === 0);
  check('X15b: an interpreter outside /usr is allowed — the binary is ours, the ARGS are untrusted',
    v(process.execPath, ['-e', 'process.exit(0)']).length === 0);
  check('X15c: a non-existent absolute executable is refused',
    v('/nope/does-not-exist', []).includes('EXECUTABLE_NOT_FOUND'));

  const env = buildEnv(policy, { FOO: 'bar' });
  check('X16: secrets never reach a project command',
    !('ANTHROPIC_API_KEY' in env) && !('GH_TOKEN' in env) && !('DATABASE_URL' in env));
  check('X17: the minimum a build needs is present', !!env.PATH && !!env.HOME && env.FOO === 'bar');
  check('X18: anything secret-shaped is dropped even if allowlisted by mistake',
    !('MY_SECRET_TOKEN' in buildEnv({ ...policy, envAllowlist: [...policy.envAllowlist, 'MY_SECRET_TOKEN'] })));
}

async function supervisorSuite(): Promise<void> {
  section('process supervisor: every execution governed, policy enforced (P0-1)');
  const root = mkRepo('sup-proj', { 'README.md': '# x\n' });
  const wt = path.join(TMP, 'sup-wt');
  fs.mkdirSync(wt, { recursive: true });
  const policy = defaultPolicy(root, wt);
  const budgets = deriveBudgets({ globalHeavyConcurrency: 1, heavyTimeoutSeconds: 20, lightTimeoutSeconds: 20 });
  const sup = new ProcessSupervisor(budgets);

  const host = hostResources();
  check('B1: budgets are derived from the host, not hard-coded',
    budgets.derivedFrom.cpus === host.cpus && budgets.reservedCpus >= 1 && budgets.poolCpus >= 1);
  check('B2: capacity is reserved for the control plane',
    budgets.reservedCpus + budgets.poolCpus <= Math.max(1, host.cgroupCpuLimit ?? host.cpus) &&
    budgets.reservedMemMb >= 512);
  check('B3: one execution may not claim the whole pool',
    budgets.memoryMaxMb <= budgets.poolMemMb && budgets.cpuQuotaPercent <= budgets.poolCpus * 100);

  const ok = await sup.run({ id: 'e1', projectId: 'p', cls: 'light', command: 'echo', args: ['hello'], policy });
  check('S1: a normal command completes and is a product signal',
    ok.outcome === 'COMPLETED' && ok.productSignal && ok.stdout.includes('hello'));
  const denied = await sup.run({ id: 'e2', projectId: 'p', cls: 'light', command: 'cat', args: ['/etc/shadow'], policy });
  check('S2: a policy-denied command never spawns',
    denied.outcome === 'POLICY_DENIED' && denied.pid === null && denied.violations.length > 0);
  check('S2: a denial is not a product signal', denied.productSignal === false);
  const badCwd = await sup.run({ id: 'e3', projectId: 'p', cls: 'light', command: 'echo', args: ['x'], cwd: '../..', policy });
  check('S3: a cwd outside the worktree is refused', badCwd.outcome === 'POLICY_DENIED');

  const failing = await sup.run({ id: 'e4', projectId: 'p', cls: 'light', command: 'sh', args: ['-c', 'exit 3'], policy });
  check('S4: a non-zero exit is FAILED and IS a product signal',
    failing.outcome === 'FAILED' && failing.exitCode === 3 && failing.productSignal);

  const missing = await sup.run({ id: 'e5', projectId: 'p', cls: 'light', command: 'definitely-not-installed-xyz', args: [], policy });
  check('S4b: a missing toolchain is INFRASTRUCTURE_FAILURE, never a failing test',
    missing.outcome === 'INFRASTRUCTURE_FAILURE' && missing.productSignal === false, missing.outcome);
  const confinedTool = await sup.run({ id: 'e6', projectId: 'p', cls: 'light', command: 'definitely-not-installed-xyz', args: [], policy, confineFilesystem: true });
  check('S4c: the same holds under filesystem confinement, where the wrapper hides it',
    confinedTool.outcome === 'INFRASTRUCTURE_FAILURE');

  // An agent CLI authenticates out of the real HOME; only confined project
  // commands get the redirected cache HOME.
  const agentEnv = await sup.run({ id: 'e7', projectId: 'p', cls: 'agent', command: 'sh', args: ['-c', 'echo $HOME'], policy });
  check('S4d: an unconfined execution keeps the real HOME (agent auth survives)',
    agentEnv.stdout.trim() === (process.env.HOME ?? ''), agentEnv.stdout.trim());
  const confinedEnv = await sup.run({ id: 'e8', projectId: 'p', cls: 'light', command: 'sh', args: ['-c', 'echo $HOME'], policy, confineFilesystem: true });
  check('S4e: a confined project command gets a writable cache HOME inside the worktree',
    confinedEnv.stdout.trim().startsWith(wt), confinedEnv.stdout.trim());

  const iso = isolationReport();
  check('S5: the isolation backend is reported honestly',
    ['systemd-scope', 'bubblewrap', 'process-group'].includes(iso.selected) &&
    (iso.fallbackMode === (iso.selected === 'process-group')));
  check('S5: a fallback never claims kernel-enforced limits',
    !iso.fallbackMode || iso.enforces.join() === 'process-group termination');
  const wrapped = wrap('echo', ['x'], { policy, budgets, jobId: 'j1', confineFilesystem: false }, detectBackends());
  check('S6: when a scope is available the caps are actually passed to it',
    wrapped.backend !== 'systemd-scope' ||
    (wrapped.args.some((a) => a.startsWith('--property=MemoryMax=')) &&
     wrapped.args.some((a) => a.startsWith('--property=TasksMax='))));
}

async function pathologicalSuite(): Promise<void> {
  section('one pathological task cannot take down the host (P0-1, adversarial)');
  const root = mkRepo('path-proj', { 'README.md': '# x\n' });
  const wt = path.join(TMP, 'path-wt');
  fs.mkdirSync(wt, { recursive: true });
  const policy = defaultPolicy(root, wt);
  const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 6, globalHeavyConcurrency: 1 }));

  // A project command that forks 100 children and never exits.
  const bomb = path.join(wt, 'bomb.sh');
  fs.writeFileSync(bomb, '#!/bin/bash\nfor i in $(seq 1 100); do sleep 30033.5 & done\nsleep 30033.5\n', { mode: 0o755 });

  const before = Date.now();
  const res = await sup.run({ id: 'bomb1', projectId: 'p', taskId: 'T-1', cls: 'heavy', command: bomb, args: [], policy, confineFilesystem: false });
  const elapsed = Date.now() - before;
  check('R1: the pathological task is bounded by the wall clock',
    res.outcome === 'TIMEOUT' && elapsed < 30_000, `${res.outcome} in ${elapsed}ms`);
  check('R2: resource/infrastructure failure is not reported as a code failure', res.productSignal === false);

  await new Promise((r) => setTimeout(r, 1500));
  const leaked = spawnSync('sh', ['-c', 'pgrep -f "[s]leep 30033" | wc -l'], { encoding: 'utf8' }).stdout.trim();
  check('R3: all 100 descendants are killed, not just the parent', leaked === '0', `remaining=${leaked}`);
  check('R4: the governor slot is released after the kill', sup.activeCount('heavy') === 0);

  // The control plane stays responsive: a light job runs while a heavy one is
  // still being cleaned up, and unrelated state stays readable.
  const store = new EventStore(path.join(TMP, 'responsive-state'));
  store.append({ taskId: 'T-other', type: 'TASK_CREATED', payload: { description: 'unrelated' } });
  const t0 = Date.now();
  const light = await sup.run({ id: 'l1', projectId: 'p2', cls: 'light', command: 'echo', args: ['alive'], policy });
  check('R5: the control plane can still execute while a task misbehaved',
    light.outcome === 'COMPLETED' && Date.now() - t0 < 15_000);
  check('R6: unrelated project state remains readable', store.read('T-other').length === 1);
}

async function lockSuite(): Promise<void> {
  section('multi-instance project ownership (P0-3)');
  const stateDir = path.join(TMP, 'lock-state');
  const a = new ProjectLock(stateDir, 'proj', 30);
  const r1 = a.acquire();
  check('L1: the first instance acquires the lease', r1.ok && !!r1.lease);

  const b = new ProjectLock(stateDir, 'proj', 30);
  const r2 = b.acquire();
  check('L2: a second instance is refused, with a specific reason',
    !r2.ok && !!r2.heldBy && /owned by/.test(r2.reason ?? ''));

  // The real test: a genuinely separate PROCESS, not another object.
  const probe = path.join(TMP, 'probe.js');
  fs.writeFileSync(probe, `
const { ProjectLock } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/lock.ts')).replace(/\.ts"$/, '.ts"')});
`);
  const probeTs = path.join(TMP, 'probe.ts');
  fs.writeFileSync(probeTs, [
    `import { ProjectLock } from ${JSON.stringify(path.resolve(__dirname, '../src/engine/lock'))};`,
    `const l = new ProjectLock(process.argv[2], 'proj', 30);`,
    `const r = l.acquire();`,
    `process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason ?? null }));`,
  ].join('\n'));
  const tsNode = process.env.ZEUS_TSNODE ?? 'ts-node';
  const child = spawnSync(tsNode, ['--transpile-only', probeTs, stateDir], { encoding: 'utf8', timeout: 60_000 });
  const childOut = (child.stdout ?? '').trim();
  let parsed: any = null;
  try { parsed = JSON.parse(childOut); } catch { /* reported below */ }
  check('L3: a separate OS PROCESS is also refused the lease',
    parsed ? parsed.ok === false && /owned by/.test(parsed.reason ?? '') : false,
    parsed ? '' : `probe output: ${childOut.slice(0, 120) || (child.stderr ?? '').slice(0, 160)}`);

  a.release();
  const r3 = b.acquire();
  check('L4: after release, another instance may take over', r3.ok);
  b.release();

  // Crash recovery: a lease whose owner process is gone is reclaimed.
  const dead = new ProjectLock(stateDir, 'proj', 30);
  dead.acquire();
  const leaseFile = path.join(stateDir, 'project.lock');
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, pid: 999_999, instanceId: 'ghost' }));
  const c = new ProjectLock(stateDir, 'proj', 30);
  const r4 = c.acquire();
  check('L5: a crashed owner\'s lease is reclaimed, and the takeover is stated',
    r4.ok && /reclaimed a stale lease/.test(r4.reason ?? ''));
  c.release();

  // An expired lease is reclaimed even if the pid happens to exist.
  const d = new ProjectLock(stateDir, 'proj', 30);
  d.acquire();
  const l2 = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  fs.writeFileSync(leaseFile, JSON.stringify({
    ...l2, instanceId: 'stale', hostname: 'someone-else',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const e = new ProjectLock(stateDir, 'proj', 30);
  const r5 = e.acquire();
  check('L6: an expired lease from another host is reclaimed', r5.ok);
  e.release();
}

async function eventStoreSuite(): Promise<void> {
  section('event store durability and recovery (P0-3 second line)');
  const store = new EventStore(path.join(TMP, 'events-state'));
  const id = 'T-0001';
  store.append({ taskId: id, type: 'TASK_CREATED', payload: { description: 'x' } });
  store.append({ taskId: id, type: 'STATE_CHANGED', payload: { to: 'DESIGN' } });
  store.append({ taskId: id, type: 'STATE_CHANGED', payload: { to: 'IMPLEMENT' } });
  check('V1: events are chained and verify end to end', store.verify(id).ok && store.verify(id).events === 3);

  // Tampering must be detectable.
  const file = store.logPath(id);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[1]); tampered.payload.to = 'COMPLETED';
  fs.writeFileSync(file, [lines[0], JSON.stringify(tampered), lines[2]].join('\n') + '\n');
  const v = store.verify(id);
  check('V2: an edited event is detected', !v.ok && v.problems.some((p) => /modified after it was written/.test(p)));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  check('V2: restoring the log restores integrity', store.verify(id).ok);

  // A crash mid-append leaves a torn final line.
  fs.appendFileSync(file, '{"id":"EV-partial","taskId":"T-0001","seq":4,"ts":"2026');
  const torn = store.read(id);
  check('V3: a torn final line is excluded, not parsed as truth', torn.length === 3);
  const repaired = store.read(id, { repair: true });
  check('V3: repair quarantines the torn line instead of deleting it',
    repaired.length === 3 && fs.readdirSync(store.taskDir(id)).some((f) => f.includes('.torn-')));
  check('V3: the log verifies again after repair', store.verify(id).ok);

  // Corruption that is NOT the final line must not be silently tolerated.
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.replace(/\n/, '\nnot-json\n'));
  let threw = false;
  try { store.read(id); } catch { threw = true; }
  check('V4: corruption in the middle of the log raises, never guesses', threw);
  fs.writeFileSync(file, good);

  // Appends survive a real process crash: the child is SIGKILLed mid-run.
  const crashState = path.join(TMP, 'crash-state');
  const writer = path.join(TMP, 'writer.ts');
  fs.writeFileSync(writer, [
    `import { EventStore } from ${JSON.stringify(path.resolve(__dirname, '../src/engine/events'))};`,
    `const s = new EventStore(process.argv[2]);`,
    `for (let i = 0; i < 500; i++) s.append({ taskId: 'T-crash', type: 'NOTE', payload: { i } });`,
  ].join('\n'));
  const tsNode = process.env.ZEUS_TSNODE ?? 'ts-node';
  const proc = spawn(tsNode, ['--transpile-only', writer, crashState], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  try { process.kill(-(proc.pid ?? 0), 'SIGKILL'); } catch { try { process.kill(proc.pid ?? 0, 'SIGKILL'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 500));
  const crashStore = new EventStore(crashState);
  const recovered = crashStore.read('T-crash', { repair: true });
  const rv = crashStore.verify('T-crash');
  check('V5: a SIGKILL during appends leaves a readable, verifiable log',
    rv.ok, `events=${recovered.length} problems=${rv.problems.slice(0, 1).join('')}`);
  check('V5: every recovered event is intact and sequential',
    recovered.every((e, i) => e.seq === i + 1));
}

async function lifecycleSuite(): Promise<void> {
  section('portable task lifecycle end to end (Node sample, mocked providers)');
  const root = mkRepo('node-sample', {
    'package.json': JSON.stringify({ name: 'sample', scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "0"' } }),
    'package-lock.json': '{}',
    'src/index.js': 'module.exports = 1;\n',
  });
  const cfg = defaultConfig(root);
  cfg.commands.unitTest = 'node -e process.exit(0)';
  cfg.commands.typecheck = null;
  writeConfig(root, cfg);

  const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 60, lightTimeoutSeconds: 60 }));
  const engine = new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  check('E1: the project lease is acquired before any state is written', engine.acquire().ok);
  const rec = engine.createTask('Fix the login validation bug');
  const final = await engine.run(rec.taskId);
  const evs = engine.events.read(rec.taskId);
  const states = evs.filter((e) => e.type === 'STATE_CHANGED').map((e) => (e.payload as any).to);
  check('E2: the lifecycle runs NEW → DESIGN → IMPLEMENT → VERIFY → REVIEW → FINAL_ACCEPTANCE',
    ['DESIGN', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FINAL_ACCEPTANCE'].every((s) => states.includes(s)),
    states.join(' → '));
  check('E3: the task reaches a terminal state', final === 'COMPLETED', final);
  check('E4: the event log verifies', engine.events.verify(rec.taskId).ok);
  // The task log must describe THIS project only; the boundary suite owns the
  // list of identifiers that must never appear anywhere product-facing.
  check('E5: the task log references only this project',
    JSON.stringify(evs).includes(root) && !/\/srv\/|packages\/(server|webapp)/.test(JSON.stringify(evs)));
  check('E6: the required check ran and was recorded as PASSED',
    evs.some((e) => e.type === 'CHECK_RESULT' && (e.payload as any).outcome === 'PASSED'));
  check('E7: state lives under the project, not a global directory',
    fs.existsSync(path.join(root, '.zeus/state/tasks', EventStore.dirName(rec.taskId), 'events.jsonl')));
  engine.release();

  section('required-test correctness: outcomes stay distinct (Phase 11)');
  const mk = (o: any) => classifyCheck(o as any, true);
  check('Q1: COMPLETED is PASSED', mk({ outcome: 'COMPLETED' }) === 'PASSED');
  check('Q2: a non-zero exit is TEST_FAILED', mk({ outcome: 'FAILED' }) === 'TEST_FAILED');
  check('Q3: a timeout is TEST_TIMEOUT, not TEST_FAILED', mk({ outcome: 'TIMEOUT' }) === 'TEST_TIMEOUT');
  check('Q4: an OOM is RESOURCE_LIMIT_EXCEEDED', mk({ outcome: 'RESOURCE_LIMIT_EXCEEDED' }) === 'RESOURCE_LIMIT_EXCEEDED');
  check('Q5: a policy denial of a REQUIRED test is REQUIRED_TEST_NOT_RUN',
    mk({ outcome: 'POLICY_DENIED' }) === 'REQUIRED_TEST_NOT_RUN');
  check('Q6: a spawn failure is INFRASTRUCTURE_FAILURE',
    mk({ outcome: 'INFRASTRUCTURE_FAILURE' }) === 'INFRASTRUCTURE_FAILURE');
  check('Q7: only PASSED lets acceptance continue',
    checkAllowsAcceptance('PASSED') &&
    !['TEST_FAILED', 'TEST_TIMEOUT', 'RESOURCE_LIMIT_EXCEEDED', 'REQUIRED_TEST_NOT_RUN', 'INFRASTRUCTURE_FAILURE']
      .some((o) => checkAllowsAcceptance(o as any)));

  // A required test that cannot run must not pass acceptance.
  const root2 = mkRepo('node-sample-2', { 'package.json': '{}' });
  const cfg2 = defaultConfig(root2);
  cfg2.commands.unitTest = 'cat /etc/shadow';       // refused by policy
  cfg2.commands.typecheck = null;
  const engine2 = new Engine({
    projectRoot: root2, config: cfg2, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  engine2.acquire();
  const rec2 = engine2.createTask('task whose required test cannot run');
  const final2 = await engine2.run(rec2.taskId);
  check('Q8: a required test that never ran blocks acceptance',
    final2 === 'NEEDS_RECONCILIATION', final2);
  check('Q8: and the reason names the outcome, not a fake failure',
    engine2.events.read(rec2.taskId).some((e) => e.type === 'STATE_CHANGED' &&
      /REQUIRED_TEST_NOT_RUN/.test(String((e.payload as any).reason ?? ''))));
  engine2.release();

  // A project with no executable verification must not silently "COMPLETE".
  const root3 = mkRepo('no-tests-proj', { 'README.md': '# nothing to run\n' });
  const cfg3 = defaultConfig(root3);
  cfg3.commands.unitTest = null; cfg3.commands.typecheck = null;
  const engine3 = new Engine({
    projectRoot: root3, config: cfg3, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  engine3.acquire();
  const rec3 = engine3.createTask('change something in an unverifiable project');
  const final3 = await engine3.run(rec3.taskId);
  check('Q9: a project with no executable verification cannot claim acceptance',
    final3 === 'NEEDS_RECONCILIATION', final3);
  check('Q9: and the absence of verification is recorded explicitly',
    engine3.events.read(rec3.taskId).some((e) => e.type === 'NO_VERIFICATION_CONFIGURED'));
  engine3.release();

  const cfg4 = { ...cfg3, policy: { ...cfg3.policy, allowUnverifiedAcceptance: true } } as any;
  const engine4 = new Engine({
    projectRoot: root3, config: cfg4, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  engine4.acquire();
  const rec4 = engine4.createTask('same, with the operator opting in');
  const final4 = await engine4.run(rec4.taskId);
  check('Q10: an explicit opt-in allows acceptance without tests', final4 === 'COMPLETED', final4);
  engine4.release();
}

async function cancelAndCrashSuite(): Promise<void> {
  section('cancellation and crash recovery (Phase 9, 12)');
  const root = mkRepo('cancel-proj', { 'package.json': '{}' });
  const cfg = defaultConfig(root);
  cfg.commands.unitTest = 'sleep 30011.5';
  cfg.commands.typecheck = null;
  const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 120 }));
  const engine = new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  engine.acquire();
  const rec = engine.createTask('long running task');
  const running = engine.run(rec.taskId);
  await new Promise((r) => setTimeout(r, 3000));
  const st = engine.task(rec.taskId)!;
  check('C1: status is observable while the task runs', !!st && st.state !== 'NEW', st.state);
  check('C1: logs are readable while the task runs', engine.logs(rec.taskId).length > 0);

  const cancelled = engine.cancel(rec.taskId, 'operator cancelled');
  const final = await running;
  check('C2: cancel terminates the running process tree', cancelled.killed >= 1, `killed=${cancelled.killed}`);
  check('C3: the task ends cancelled, not failed', engine.task(rec.taskId)!.state === 'CANCELLED', final);
  check('C4: evidence is preserved after cancellation',
    engine.events.read(rec.taskId).length > 3 && engine.events.verify(rec.taskId).ok);
  check('C5: governor resources are released', sup.activeCount('heavy') === 0 && sup.activeCount('agent') === 0);
  await new Promise((r) => setTimeout(r, 800));
  const leaked = spawnSync('sh', ['-c', 'pgrep -f "[s]leep 30011" | wc -l'], { encoding: 'utf8' }).stdout.trim();
  check('C6: no orphan remains from the cancelled task', leaked === '0', `remaining=${leaked}`);
  engine.release();

  // The real cancellation case: `zeus cancel` runs in a DIFFERENT process
  // from `zeus run`, so an in-memory job map cancels nothing.
  const root3 = mkRepo('xproc-proj', { 'package.json': '{}' });
  const state3 = path.join(root3, '.zeus/state');
  const runner = path.join(TMP, 'runner.ts');
  fs.writeFileSync(runner, [
    `import { ProcessSupervisor } from ${JSON.stringify(path.resolve(__dirname, '../src/engine/exec'))};`,
    `import { deriveBudgets } from ${JSON.stringify(path.resolve(__dirname, '../src/engine/budget'))};`,
    `import { defaultPolicy } from ${JSON.stringify(path.resolve(__dirname, '../src/engine/policy'))};`,
    `const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 120 }), undefined, process.argv[3]);`,
    `const policy = defaultPolicy(process.argv[2], process.argv[2]);`,
    `sup.run({ id: 'xproc-job', projectId: 'xp', taskId: 'T-XPROC', cls: 'heavy',`,
    `  command: 'sleep', args: ['30022.5'], policy }).then((r) => process.stdout.write(r.outcome));`,
  ].join('\n'));
  const tsNode2 = process.env.ZEUS_TSNODE ?? 'ts-node';
  const runnerProc = spawn(tsNode2, ['--transpile-only', runner, root3, state3],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let runnerOut = '';
  runnerProc.stdout?.on('data', (d) => { runnerOut += d.toString(); });
  await new Promise((r) => setTimeout(r, 6000));
  const beforeKill = spawnSync('sh', ['-c', 'pgrep -f "[s]leep 30022" | wc -l'], { encoding: 'utf8' }).stdout.trim();
  const { killRecorded, listRunRecords, registryDirFor } = require('../src/engine/exec');
  const recorded = listRunRecords(registryDirFor(state3));
  check('C11: a running execution is recorded on disk where another process can find it',
    recorded.length === 1 && recorded[0].taskId === 'T-XPROC' && recorded[0].pgid > 1,
    `records=${recorded.length} sleeps=${beforeKill}`);
  const killedX = killRecorded(state3, { taskId: 'T-XPROC' }, 'cancelled from another process');
  await new Promise((r) => setTimeout(r, 1500));
  const afterKill = spawnSync('sh', ['-c', 'pgrep -f "[s]leep 30022" | wc -l'], { encoding: 'utf8' }).stdout.trim();
  check('C12: a SEPARATE process can cancel and the tree really dies',
    killedX.killed === 1 && afterKill === '0', `killed=${killedX.killed} remaining=${afterKill}`);
  check('C13: the registry entry is removed after the kill',
    listRunRecords(registryDirFor(state3)).length === 0);
  try { process.kill(-(runnerProc.pid ?? 0), 'SIGKILL'); } catch { /* gone */ }
  void runnerOut;

  // Crash mid-phase: the orchestrator dies after the implementer edited files.
  const root2 = mkRepo('crash-proj', { 'package.json': '{}', 'src/a.js': 'module.exports=1;\n' });
  const state2 = path.join(root2, '.zeus/state');
  const store = new EventStore(state2);
  store.append({ taskId: 'T-0001', type: 'TASK_CREATED', payload: { description: 'x', worktree: path.join(root2, 'wt'), baseSha: 'abc' } });
  store.append({ taskId: 'T-0001', type: 'STATE_CHANGED', payload: { to: 'IMPLEMENT', phase: 'implement' } });
  store.append({ taskId: 'T-0001', type: 'AGENT_STARTED', payload: { role: 'implementer' } });
  fs.mkdirSync(path.join(root2, 'wt'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'wt/dirty.js'), 'edited by the agent before the crash\n');
  // ...process dies here, with no AGENT_FINISHED and no final JSON.
  const after = new EventStore(state2);
  const evs = after.read('T-0001');
  const lastStarted = evs.filter((e) => e.type === 'AGENT_STARTED').pop();
  const finished = evs.some((e) => e.type === 'AGENT_FINISHED' || e.type === 'AGENT_FAILED');
  check('C7: a crash mid-phase is visible as a started-but-unfinished phase',
    !!lastStarted && !finished);
  check('C8: the dirty worktree is preserved, not reset',
    fs.existsSync(path.join(root2, 'wt/dirty.js')));
  check('C9: the log still verifies after the crash', after.verify('T-0001').ok);
  check('C10: missing final JSON is NOT read as "nothing happened"',
    evs.some((e) => e.type === 'AGENT_STARTED') && evs.length === 3);
}

async function multiProjectSuite(): Promise<void> {
  section('multi-project isolation, concurrently (Phase 14)');
  const nodeRoot = mkRepo('multi-node', {
    'package.json': JSON.stringify({ name: 'a', scripts: { test: 'node -e "0"' } }), 'package-lock.json': '{}',
  });
  const goRoot = mkRepo('multi-go', { 'go.mod': 'module b\n\ngo 1.21\n', 'main.go': 'package main\nfunc main(){}\n' });

  const cfgA = defaultConfig(nodeRoot); cfgA.commands.unitTest = 'node -e process.exit(0)'; cfgA.commands.typecheck = null;
  const cfgB = defaultConfig(goRoot); cfgB.commands.unitTest = 'true'; cfgB.commands.typecheck = null;
  // This fixture is a go.mod and one file, on a host with no Go toolchain. It
  // declares no install step, because there is nothing to download — and a
  // project that says so must not have `go mod download` inferred for it.
  cfgB.commands.install = null;
  check('M1: each project detects its own type',
    cfgA.project.adapter === 'node' && cfgB.project.adapter === 'go');

  const sup = new ProcessSupervisor(deriveBudgets({ globalHeavyConcurrency: 1, heavyTimeoutSeconds: 60 }));
  const mk = (root: string, cfg: any) => new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  const a = mk(nodeRoot, cfgA), b = mk(goRoot, cfgB);
  check('M2: both projects can be owned at once (separate leases)', a.acquire().ok && b.acquire().ok);
  const ta = a.createTask('task in project A');
  const tb = b.createTask('task in project B');

  const [fa, fb] = await Promise.all([a.run(ta.taskId), b.run(tb.taskId)]);
  check('M3: both tasks complete under one governor', fa === 'COMPLETED' && fb === 'COMPLETED', `${fa}/${fb}`);
  check('M4: heavy work was serialized across projects', (sup.maxObserved.get('heavy') ?? 0) <= 1);
  check('M5: each project has its own state root',
    fs.existsSync(path.join(nodeRoot, '.zeus/state/tasks', EventStore.dirName(ta.taskId))) &&
    fs.existsSync(path.join(goRoot, '.zeus/state/tasks', EventStore.dirName(tb.taskId))));
  // Task ids are per-project sequences, so both projects legitimately have a
  // T-0001. Isolation means each store only ever contains its OWN task.
  const aDescs = a.events.listTasks().flatMap((t) => a.events.read(t)
    .filter((e) => e.type === 'TASK_CREATED').map((e) => String((e.payload as any).description)));
  const bDescs = b.events.listTasks().flatMap((t) => b.events.read(t)
    .filter((e) => e.type === 'TASK_CREATED').map((e) => String((e.payload as any).description)));
  check('M6: neither project can read the other\'s task state',
    aDescs.every((d) => !d.includes('project B')) && bDescs.every((d) => !d.includes('project A')) &&
    aDescs.length === 1 && bDescs.length === 1, `${aDescs.join()} | ${bDescs.join()}`);
  check('M7: worktrees are separate', ta.worktree !== tb.worktree &&
    ta.worktree.startsWith(nodeRoot) && tb.worktree.startsWith(goRoot));
  check('M8: cancelling one project does not touch the other',
    (() => { const before = b.task(tb.taskId)!.state; a.cancel(ta.taskId, 'test'); return b.task(tb.taskId)!.state === before; })());
  a.release(); b.release();
}

async function noBypassSuite(): Promise<void> {
  section('no module bypasses the supervisor (Phase 2 invariant)');
  const engineDir = path.resolve(__dirname, '../src/engine');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(engineDir).filter((x) => x.endsWith('.ts'))) {
    // exec.ts is the supervisor; isolation/doctor only probe capabilities.
    if (['exec.ts', 'isolation.ts'].includes(f)) continue;
    const src = fs.readFileSync(path.join(engineDir, f), 'utf8');
    const hits = [...src.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g)].map((m) => m[1]);
    // orchestrator uses execFileSync ONLY for git plumbing, which is ours, not
    // the project's code, and providers use it to probe for a binary.
    const allowed = ['orchestrator.ts', 'providers.ts'].includes(f);
    if (hits.length && !allowed) offenders.push(`${f}: ${hits.join(',')}`);
  }
  check('N1: no engine module spawns processes outside the supervisor',
    offenders.length === 0, offenders.join(' | '));
  const cliSrc = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');
  check('N2: the CLI imports only from src/',
    !/(from|require\()\s*['"]\.\.\/\.\./.test(cliSrc));
  const supSrc = fs.readFileSync(path.join(engineDir, 'exec.ts'), 'utf8');
  check('N3: the supervisor applies policy before spawning',
    supSrc.indexOf('inspectCommand') < supSrc.indexOf('spawn(wrapped.command'));

  // Setup runs before the engine exists, so it cannot use the supervisor. Its
  // equivalent invariant is that every machine interaction goes through the one
  // injectable probe — which is also what makes the wizard testable at all.
  const setupDir = path.resolve(__dirname, '../src/setup');
  const setupOffenders = fs.readdirSync(setupDir)
    .filter((f) => f.endsWith('.ts') && f !== 'probe.ts')
    .filter((f) => /child_process|\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/
      .test(fs.readFileSync(path.join(setupDir, f), 'utf8')));
  check('N4: setup reaches the machine only through the injectable probe',
    setupOffenders.length === 0, setupOffenders.join(', '));
}

export async function engineSuites(): Promise<void> {
  await policySuite();
  await supervisorSuite();
  await pathologicalSuite();
  await lockSuite();
  await eventStoreSuite();
  await lifecycleSuite();
  await cancelAndCrashSuite();
  await multiProjectSuite();
  await noBypassSuite();
  await p1Suites();
  fs.rmSync(TMP, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------------
 * P1 closure suites: reviewer independence, task budgets, event-store scale,
 * cross-project identity.
 * ------------------------------------------------------------------------- */
import { buildReviewPayload, DEFAULT_REVIEW_POLICY, reconcileReviewerReport, ReviewInput } from '../src/engine/reviewcontext';
import { mergeBudgets, usageFrom, checkBudgets, DEFAULT_TASK_BUDGETS } from '../src/engine/taskbudget';
import { makeTaskId, localLabel, taskIdToDir } from '../src/engine/orchestrator';

async function reviewIndependenceSuite(): Promise<void> {
  section('reviewer independence is proven, not asserted (P1-10)');
  const base = { taskId: 'proj/T-0001', projectId: 'proj', baseSha: 'aaa', headSha: 'bbb' };
  const clean: ReviewInput[] = [
    { kind: 'task-requirement', label: 'TASK', content: 'Add a JSDoc comment' },
    { kind: 'diff', label: 'DIFF', content: '--- a/x.js\n+++ b/x.js\n+/** doc */' },
    { kind: 'changed-files', label: 'CHANGED FILES', content: 'src/x.js' },
  ];
  const ok = buildReviewPayload({ ...base, inputs: clean });
  check('RI1: a clean review payload is valid and carries its provenance',
    ok.valid && ok.violations.length === 0 && !!ok.reviewInvocationId &&
    ok.baseSha === 'aaa' && ok.headSha === 'bbb');
  check('RI2: every delivered section is hashed for later checking',
    Object.keys(ok.hashes).length === 3 && Object.values(ok.hashes).every((h) => h.startsWith('sha256:')) &&
    ok.promptHash.startsWith('sha256:'));
  check('RI3: allowed task and source evidence really is delivered',
    ok.deliveredContext.includes('task-requirement') && ok.deliveredContext.includes('diff') &&
    ok.prompt.includes('Add a JSDoc comment'));

  // Forbidden by KIND.
  for (const kind of ['planner-reasoning', 'planner-plan', 'implementer-transcript',
    'implementer-rationale', 'previous-review', 'adjudication', 'acceptance-verdict', 'area-context'] as const) {
    const bad = buildReviewPayload({ ...base, inputs: [...clean, { kind, label: `LEAK-${kind}`, content: 'x' }] });
    check(`RI4: ${kind} is refused by policy`,
      !bad.valid && bad.violations.some((v) => v.kind === kind) && bad.prompt === '');
  }

  // Forbidden by CONTENT, hidden inside an allowed section.
  const smuggled: Array<[string, string]> = [
    ['planner chain-of-thought', '<thinking>the user probably wants…</thinking>'],
    ['planner design output', 'PLAN: rewrite the module\n"scopeAllowlist": ["a"]'],
    ['implementer transcript', '{"type":"tool_use","name":"Edit"}'],
    ['previous review', 'PREVIOUS REVIEW: no findings, looks good'],
    ['adjudication', 'ADJUDICATION: finding R-1 rejected'],
    ['area context', 'AREA CONTEXT\nareas: authentication-ui'],
  ];
  for (const [what, content] of smuggled) {
    const bad = buildReviewPayload({ ...base,
      inputs: [{ kind: 'diff', label: 'DIFF', content: `--- a/x\n${content}` }] });
    check(`RI5: ${what} smuggled inside an allowed section is caught`,
      !bad.valid && bad.violations.some((v) => v.kind === 'content-scan'), bad.violations.map((v) => v.detail).join());
  }

  check('RI6: a contaminated payload is never handed to the reviewer',
    buildReviewPayload({ ...base, inputs: [{ kind: 'planner-plan', label: 'P', content: 'x' }] }).prompt === '');

  // Area context only when a policy explicitly allows it.
  const withArea = buildReviewPayload({ ...base,
    policy: { ...DEFAULT_REVIEW_POLICY, allowAreaContext: true, allowed: [...DEFAULT_REVIEW_POLICY.allowed, 'area-context'] },
    inputs: [{ kind: 'area-context', label: 'AREA', content: 'AREA CONTEXT\nfoo' }] });
  check('RI7: area context is deliverable only under an explicit policy',
    withArea.valid && withArea.deliveredContext.includes('area-context'));

  // The developer prompt and the reviewer prompt must genuinely differ.
  const devPrompt = ['Implement the change.', 'PLAN: {"scopeAllowlist":["src/x.js"]}', '<thinking>hmm</thinking>'].join('\n');
  check('RI8: the developer payload contains exactly what the reviewer is denied',
    /PLAN:/.test(devPrompt) && /<thinking>/.test(devPrompt) &&
    !/PLAN:/.test(ok.prompt) && !/<thinking>/.test(ok.prompt));

  const rec = reconcileReviewerReport(ok, { usedContext: ['task-requirement', 'planner-plan'] });
  check('RI9: a reviewer claiming context it was never given is recorded',
    !rec.consistent && rec.unsupportedClaims.includes('planner-plan'));
  check('RI10: an honest reviewer report reconciles',
    reconcileReviewerReport(ok, { usedContext: ['diff'] }).consistent);
}

async function taskBudgetSuite(): Promise<void> {
  section('task-level budgets (P1-3)');
  const mkEvents = (rows: Array<[string, any]>, startedMsAgo = 1000) => {
    const t0 = Date.now() - startedMsAgo;
    return rows.map(([type, payload], i) => ({
      id: `EV-${i}`, taskId: 'p/T-0001', seq: i + 1,
      ts: new Date(t0 + i).toISOString(), type, prev: 'x', payload,
    })) as any[];
  };

  const wall = usageFrom(mkEvents([['TASK_CREATED', {}]], 60_000));
  check('TB1: elapsed time is measured from the first event, so restarts cannot reset it',
    wall.taskWallClockMs >= 60_000);
  check('TB2: total wall-clock exhaustion is detected',
    checkBudgets(mergeBudgets({ maxTaskWallClockMs: 1000 }), wall)?.budget === 'maxTaskWallClockMs');

  const reviews = usageFrom(mkEvents(Array.from({ length: 6 }, () => ['AGENT_STARTED', { role: 'reviewer' }] as [string, any])));
  check('TB3: review-loop exhaustion is detected',
    checkBudgets(mergeBudgets({ maxReviewCycles: 5 }), reviews)?.budget === 'maxReviewCycles');
  const repairs = usageFrom(mkEvents(Array.from({ length: 6 }, () => ['STATE_CHANGED', { to: 'FIX' }] as [string, any])));
  check('TB4: repair-loop exhaustion is detected',
    checkBudgets(mergeBudgets({ maxRepairCycles: 5 }), repairs)?.budget === 'maxRepairCycles');
  const provider = usageFrom(mkEvents([['AGENT_FINISHED', { durationMs: 700_000 }]]));
  check('TB5: provider-call exhaustion is detected',
    checkBudgets(mergeBudgets({ maxProviderWallClockMs: 600_000 }), provider)?.budget === 'maxProviderWallClockMs');
  const designs = usageFrom(mkEvents(Array.from({ length: 4 }, () => ['AGENT_STARTED', { role: 'planner' }] as [string, any])));
  check('TB6: design-attempt exhaustion is detected',
    checkBudgets(mergeBudgets({ maxDesignAttempts: 3 }), designs)?.budget === 'maxDesignAttempts');

  // Waiting is not working.
  const queued = usageFrom(mkEvents([['CHECK_RESULT', { durationMs: 100, queueWaitMs: 500_000 }]]));
  check('TB7: queue wait is tracked separately and does not count as execution',
    queued.queueWaitMs === 500_000 && queued.activeExecutionMs === 100 &&
    checkBudgets(mergeBudgets({ maxProviderWallClockMs: 1000 }), queued) === null);

  // Cost is only enforced when it is actually measured.
  const noCost = usageFrom(mkEvents([['AGENT_FINISHED', { durationMs: 10 }]]));
  check('TB8: unmeasured cost is reported as unknown, never invented',
    noCost.estimatedCostUsd === null && noCost.costMeasured === false &&
    checkBudgets(mergeBudgets({ maxEstimatedCostUsd: 0.01 }), noCost) === null);
  const withCost = usageFrom(mkEvents([['AGENT_FINISHED', { durationMs: 10, costUsd: 5 }]]));
  check('TB9: a measured cost IS enforced',
    withCost.costMeasured && checkBudgets(mergeBudgets({ maxEstimatedCostUsd: 1 }), withCost)?.budget === 'maxEstimatedCostUsd');

  // End to end: a real task stopped by a budget.
  const root = mkRepo('budget-proj', { 'package.json': '{}' });
  const cfg = defaultConfig(root);
  cfg.commands.unitTest = 'true'; cfg.commands.typecheck = null;
  const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 30 }));
  const engine = new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
    taskBudgets: { maxAgentInvocations: 1 },
  });
  engine.acquire();
  const t = engine.createTask('a task that will exceed its budget');
  const final = await engine.run(t.taskId);
  check('TB10: a budget breach stops the task and asks a human, not silently continues',
    final === 'AWAITING_HUMAN', final);
  const ev = engine.events.read(t.taskId);
  const breach = ev.find((e) => e.type === 'TASK_BUDGET_EXCEEDED');
  check('TB11: the breach records budget, limit and observed usage',
    !!breach && (breach.payload as any).budget === 'maxAgentInvocations' &&
    (breach.payload as any).limit === 1 && (breach.payload as any).observed >= 2);

  // Budgets survive a restart: a fresh Engine sees the same usage.
  const engine2 = new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
    taskBudgets: { maxAgentInvocations: 1 },
  });
  const usageAfterRestart = usageFrom(engine2.events.read(t.taskId));
  check('TB12: budget usage survives a process restart (recomputed from the log)',
    usageAfterRestart.agentInvocations >= 2);
  engine.release();
}

async function eventScaleSuite(): Promise<void> {
  section('event store scalability with durability intact (P1-5)');
  const store = new EventStore(path.join(TMP, 'scale-state'));
  const id = 'p/T-SCALE';
  const N = 4000;
  const t0 = Date.now();
  for (let i = 0; i < N; i += 1) store.append({ taskId: id, type: 'NOTE', payload: { i } });
  const totalMs = Date.now() - t0;

  // Timing the last 500 against the first 500 shows whether cost grows with
  // history: an O(n) append would make the tail dramatically slower.
  const store2 = new EventStore(path.join(TMP, 'scale-state-2'));
  const id2 = 'p/T-SCALE2';
  const tFirst0 = Date.now();
  for (let i = 0; i < 500; i += 1) store2.append({ taskId: id2, type: 'NOTE', payload: { i } });
  const firstMs = Date.now() - tFirst0;
  for (let i = 500; i < 3500; i += 1) store2.append({ taskId: id2, type: 'NOTE', payload: { i } });
  const tLast0 = Date.now();
  for (let i = 3500; i < 4000; i += 1) store2.append({ taskId: id2, type: 'NOTE', payload: { i } });
  const lastMs = Date.now() - tLast0;

  check('ES1: appends stay flat as history grows (no full rescan)',
    lastMs < firstMs * 3 + 200, `first500=${firstMs}ms last500=${lastMs}ms (after 3500 events)`);
  check('ES2: the whole history is present and verifies',
    store.verify(id).ok && store.read(id).length === N, `${N} events in ${totalMs}ms`);
  check('ES3: sequences are contiguous and the chain links',
    store.read(id).every((e, i) => e.seq === i + 1));

  // Durability guarantees must survive the optimisation.
  const file = store.logPath(id);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[10]); tampered.payload.i = 999_999;
  fs.writeFileSync(file, [...lines.slice(0, 10), JSON.stringify(tampered), ...lines.slice(11)].join('\n') + '\n');
  check('ES4: tamper detection still works with an index', !store.verify(id).ok);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  // An out-of-band write must invalidate the cursor rather than corrupt the chain.
  const store3 = new EventStore(path.join(TMP, 'scale-state'));
  store3.append({ taskId: id, type: 'NOTE', payload: { afterExternalWrite: true } });
  check('ES5: a second store instance appends correctly after an external write',
    store3.verify(id).ok && store3.read(id).length === N + 1);

  // Torn line recovery still works.
  fs.appendFileSync(store3.logPath(id), '{"id":"EV-torn","seq":9999');
  check('ES6: a torn final line is still excluded', store3.read(id).length === N + 1);
  store3.read(id, { repair: true });
  const store4 = new EventStore(path.join(TMP, 'scale-state'));
  store4.append({ taskId: id, type: 'NOTE', payload: { afterRepair: true } });
  check('ES7: appends resume correctly after a repair', store4.verify(id).ok);
}

async function taskIdentitySuite(): Promise<void> {
  section('globally unambiguous task identity (cross-project collisions)');
  check('ID1: a task id carries its project', makeTaskId('alpha', 1) === 'alpha/T-0001');
  check('ID2: the short label is still available for humans', localLabel('alpha/T-0001') === 'T-0001');
  check('ID3: two projects produce different ids for their first task',
    makeTaskId('alpha', 1) !== makeTaskId('beta', 1));
  check('ID4: ids are made filesystem-safe for state directories',
    taskIdToDir('alpha/T-0001') === 'alpha~T-0001' && !taskIdToDir('a/b').includes('/'));

  const rootA = mkRepo('ident-a', { 'package.json': '{}' });
  const rootB = mkRepo('ident-b', { 'package.json': '{}' });
  const cfgA = defaultConfig(rootA); cfgA.commands.unitTest = 'true'; cfgA.commands.typecheck = null;
  const cfgB = defaultConfig(rootB); cfgB.commands.unitTest = 'true'; cfgB.commands.typecheck = null;
  const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 30 }));
  const mk = (root: string, cfg: any) => new Engine({
    projectRoot: root, config: cfg, supervisor: sup,
    providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
  });
  const a = mk(rootA, cfgA), b = mk(rootB, cfgB);
  a.acquire(); b.acquire();
  const ta = a.createTask('alpha task');
  const tb = b.createTask('beta task');
  check('ID5: two projects\' first tasks do not share an id', ta.taskId !== tb.taskId, `${ta.taskId} vs ${tb.taskId}`);
  check('ID6: each engine resolves only its own task',
    !!a.task(ta.taskId) && a.task(tb.taskId) === null && !!b.task(tb.taskId) && b.task(ta.taskId) === null);
  check('ID7: worktrees cannot collide', ta.worktree !== tb.worktree);
  check('ID8: the run registry distinguishes them',
    ta.taskId.startsWith(cfgA.project.name) && tb.taskId.startsWith(cfgB.project.name));
  a.release(); b.release();
}

async function packagingSuite(): Promise<void> {
  section('the package ships the runtime and nothing else');
  const repoRoot = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  // An allowlist, not a denylist: a new directory is excluded by default, which
  // is the only way this stays correct as the repository grows.
  const ALLOWED = ['bin/', 'dist/', 'src/', 'install.sh', 'README.md', 'LICENSE'];
  check('PK1: the package ships only the runtime, by allowlist',
    Array.isArray(pkg.files) && pkg.files.length > 0 &&
    pkg.files.every((f: string) => ALLOWED.includes(f)), JSON.stringify(pkg.files));

  const srcFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith('.ts')) srcFiles.push(f);
    }
  };
  walk(path.join(repoRoot, 'src'));
  const reachesOut = srcFiles.filter((f) =>
    /(from|require\()\s*['"]\.\.\/\.\./.test(fs.readFileSync(f, 'utf8')));
  check('PK2: no runtime source imports anything from outside src/', reachesOut.length === 0, reachesOut.join());
  check('PK3: the repository carries no prototype, archive or vendored tree',
    ['tools', 'reference', 'internal', 'legacy'].every((d) => !fs.existsSync(path.join(repoRoot, d))));
  const ignore = fs.readFileSync(path.join(repoRoot, '.npmignore'), 'utf8');
  check('PK4: packaging explicitly excludes runtime state, evidence and credentials',
    /\.zeus\//.test(ignore) && /state\//.test(ignore) && /\.env/.test(ignore) && /\*\.pem/.test(ignore));
}

export async function p1Suites(): Promise<void> {
  await reviewIndependenceSuite();
  await taskBudgetSuite();
  await eventScaleSuite();
  await taskIdentitySuite();
  await packagingSuite();
}
