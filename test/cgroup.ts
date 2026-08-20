/**
 * Tree-wide resource enforcement.
 *
 * The gap these close: `ulimit -v` bounds ONE process's address space. Six
 * workers, each comfortably inside that bound, can still exhaust a machine
 * together — and that is the shape that actually took this host down. A
 * per-process ceiling cannot honestly claim to prevent it; only a cgroup can.
 *
 * Every check here reads what the kernel did, not what the flags asked for.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { check, section } from './harness';
import { deriveBudgets } from '../src/engine/budget';
import { ProcessSupervisor } from '../src/engine/exec';
import { defaultPolicy } from '../src/engine/policy';
import {
  detectBackends, systemdScopeProbe, systemdUserEnv, userRuntimeDir, wrap,
  report as isolationReport, BackendCapability,
} from '../src/engine/isolation';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-cg-'));

const sh = (name: string, body: string): string => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return f;
};

/** Transient units this suite could have left behind. */
function zeusUnits(): string[] {
  const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', 'zeus-*'],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...systemdUserEnv() } });
  return `${r.stdout ?? ''}`.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => /^zeus-/.test(u));
}

export async function cgroupSuite(): Promise<void> {
  const backends = detectBackends();
  const scope = backends.find((b) => b.id === 'systemd-scope')!;
  const probe = systemdScopeProbe();

  // -----------------------------------------------------------------------
  section('backend detection: availability means operational capability');
  {
    check('CG1: no backend advertises an enforcement it was not probed to hold',
      backends.every((b: BackendCapability) => b.available || b.enforces.length === 0),
      backends.map((b) => `${b.id}:${b.available}/${b.enforces.length}`).join(' '));
    check('CG2: an available backend names at least one real guarantee',
      backends.every((b) => !b.available || b.enforces.length > 0));
    check('CG3: the scope backend is available only when a memory ceiling was OBSERVED',
      probe.ok === probe.enforces.includes('memory cap (cgroup)'),
      `ok=${probe.ok} enforces=[${probe.enforces.join(', ')}]`);
    check('CG4: bubblewrap still claims no memory or cpu accounting, because it has none',
      !backends.find((b) => b.id === 'bubblewrap')!.enforces.some((e) => /memory|cpu/i.test(e)));
    // The wrapper may only claim what detection found.
    const w = wrap('true', [], {
      policy: defaultPolicy(TMP, TMP), budgets: deriveBudgets(), jobId: 'claim-probe',
      confineFilesystem: false,
    }, backends);
    const allowed = new Set([...scope.enforces, 'address-space cap (rlimit)', 'process-group termination']);
    check('CG5: the wrapper claims nothing detection did not establish',
      w.enforced.every((e) => allowed.has(e)), `${w.enforced.join(', ')}`);
    check('CG6: doctor reports the same reality the wrapper acts on',
      isolationReport(backends).resourceEnforcement === (scope.available ? 'cgroup' : 'rlimit'));
    check('CG7: the runtime directory is derived, then proved — never assumed',
      userRuntimeDir() === null ? !probe.ok : true,
      `runtimeDir=${userRuntimeDir()} probe=${probe.ok}`);
  }

  if (!scope.available) {
    // DONE-WITH-LIMITATION: the aggregate case cannot be honestly tested here.
    section('tree-wide enforcement is NOT available on this host');
    check('CG8: the limitation is stated rather than papered over',
      isolationReport(backends).resourceEnforcement === 'rlimit'
      && /rlimit|no cgroup|address-space/i.test(isolationReport(backends).resourceDetail),
      isolationReport(backends).resourceDetail);
    fs.rmSync(TMP, { recursive: true, force: true });
    return;
  }

  // -----------------------------------------------------------------------
  section('the failure rlimit cannot catch: many small processes, one big total');
  {
    // Six children of ~80 MB each. No child is anywhere near the 256 MB
    // ceiling on its own; together they are at roughly 480 MB.
    const hog = sh('aggregate-hog.sh', [
      'for i in 1 2 3 4 5 6; do',
      "  node -e 'const b=[];for(let i=0;i<80;i++){b.push(Buffer.alloc(1024*1024).fill(7));}"
      + "console.error(\"child up\");setTimeout(()=>{},20000);' &",
      'done',
      'wait',
      'echo leader-finished',
    ].join('\n'));

    const budgets = deriveBudgets({
      memoryMaxMb: 256, maxProcesses: 64, heavyTimeoutSeconds: 60, globalHeavyConcurrency: 1,
    });
    const sup = new ProcessSupervisor(budgets, backends, path.join(TMP, 'state'));
    const before = zeusUnits().length;
    const t0 = Date.now();
    const res = await sup.run({
      id: 'aggregate-hog', projectId: 'cg', taskId: 'T-cg', cls: 'heavy',
      command: hog, args: [], cwd: TMP, policy: defaultPolicy(TMP, TMP),
      confineFilesystem: false, timeoutSeconds: 60,
    } as any);
    const elapsed = Date.now() - t0;

    check('CG9: the execution ran under the cgroup backend, not a weaker one',
      res.backend === 'systemd-scope' && res.isolationFallback === false, res.backend);
    // Both signatures are containment: SIGKILL when the kernel OOM killer
    // fires first, SIGTERM when systemd stops the unit first. Which one occurs
    // varies run to run, so the outcome is what is asserted, not the signal.
    check('CG10: an aggregate overrun no single process could cause is CONTAINED',
      res.outcome === 'RESOURCE_LIMIT_EXCEEDED',
      `${res.outcome} exit=${res.exitCode} signal=${res.signal} in ${elapsed}ms`);
    check('CG11: containment is not blamed on the code — no product signal',
      res.productSignal === false);
    check('CG12: it was stopped by the ceiling, not by the wall clock',
      elapsed < 55_000 && !/leader-finished/.test(res.stdout), `${elapsed}ms`);
    check('CG13: the ceiling that stopped it is the one Zeus asked for',
      res.budgets.memoryMaxMb === 256 && res.enforced.includes('memory cap (cgroup)'),
      res.enforced.join(', '));

    // The host must still be usable afterwards — that is the whole point.
    const alive = spawnSync('true', [], { timeout: 10_000 });
    const free = os.freemem() / 1e6;
    check('CG14: the host is responsive immediately afterwards',
      alive.status === 0 && free > 200, `${free.toFixed(0)} MB free`);

    // -------------------------------------------------------------------
    section('cgroup lifecycle: nothing leaks');
    check('CG15: a contained execution leaves no transient unit behind',
      zeusUnits().length <= before, zeusUnits().join(','));

    const quick = sh('quick.sh', 'exit 0');
    const ok = await sup.run({
      id: 'clean-exit', projectId: 'cg', taskId: 'T-cg', cls: 'heavy',
      command: quick, args: [], cwd: TMP, policy: defaultPolicy(TMP, TMP), confineFilesystem: false,
    } as any);
    check('CG16: normal exit — the scope is collected, not left running',
      ok.outcome === 'COMPLETED' && zeusUnits().length <= before, zeusUnits().join(','));

    const long = sh('long.sh', 'sleep 120');
    const pending = sup.run({
      id: 'killed-run', projectId: 'cg', taskId: 'T-cg-kill', cls: 'heavy',
      command: long, args: [], cwd: TMP, policy: defaultPolicy(TMP, TMP),
      confineFilesystem: false, timeoutSeconds: 120,
    } as any);
    await new Promise((r) => setTimeout(r, 1500));
    const killedN = sup.killTask('T-cg-kill', 'test');
    const killed = await pending;
    check('CG17: explicit kill — the whole scope dies and the slot is freed',
      killedN === 1 && killed.outcome === 'CANCELLED' && sup.activeCount('heavy') === 0,
      `${killed.outcome}`);
    await new Promise((r) => setTimeout(r, 1000));
    check('CG18: and its cgroup is gone, not orphaned',
      !zeusUnits().some((u) => /killed-run/.test(u)), zeusUnits().join(','));

    // Supervisor crash: a separate process is started, given a live scope, and
    // SIGKILLed. Whatever survives is reported here rather than assumed away.
    const runner = path.join(TMP, 'runner.js');
    fs.writeFileSync(runner, `
      const { ProcessSupervisor } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/exec'))});
      const { deriveBudgets } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/budget'))});
      const { defaultPolicy } = require(${JSON.stringify(path.resolve(__dirname, '../src/engine/policy'))});
      const sup = new ProcessSupervisor(deriveBudgets({ heavyTimeoutSeconds: 120 }), undefined, ${JSON.stringify(path.join(TMP, 'state'))});
      sup.run({ id: 'crash-run', projectId: 'cg', taskId: 'T-cg-crash', cls: 'heavy',
        command: ${JSON.stringify(long)}, args: [], cwd: ${JSON.stringify(TMP)},
        policy: defaultPolicy(${JSON.stringify(TMP)}, ${JSON.stringify(TMP)}),
        confineFilesystem: false, timeoutSeconds: 120 });
      setTimeout(() => { console.log('READY'); }, 2500);
      setTimeout(() => {}, 120000);
    `);
    const child = require('child_process').spawn(process.execPath,
      ['-r', 'ts-node/register/transpile-only', runner],
      { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' } });
    let sawReady = false;
    child.stdout.on('data', (d: Buffer) => { if (/READY/.test(d.toString())) sawReady = true; });
    for (let i = 0; i < 100 && !sawReady; i += 1) await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 1500));
    const { listRunRecords, registryDirFor, killRecorded } = require('../src/engine/exec');
    const orphans = listRunRecords(registryDirFor(path.join(TMP, 'state')))
      .filter((r: any) => r.taskId === 'T-cg-crash');
    check('CG19: a crashed supervisor leaves its run recorded, so another process can find it',
      sawReady && orphans.length === 1, `ready=${sawReady} records=${orphans.length}`);
    const reaped = killRecorded(path.join(TMP, 'state'), { taskId: 'T-cg-crash' }, 'recovery');
    await new Promise((r) => setTimeout(r, 1000));
    check('CG20: recovery reaps it — no cgroup survives a supervisor crash unnoticed',
      reaped.killed >= 1 && !zeusUnits().some((u) => /crash-run/.test(u)),
      `killed=${reaped.killed} units=${zeusUnits().join(',')}`);

    sup.shutdown('cgroup suite finished');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
