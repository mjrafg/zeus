/**
 * LANE B — process, resource and concurrency behaviour.
 *
 * Charter §3, §4, §5, §6, §18, §32, §33.
 *
 * Zeus runs other people's code on a machine somebody is using. The invariants
 * here are the ones that keep a misbehaving task from taking the host with it,
 * and keep a cancel from reaching further than it should.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { LaneSpec, held, defect } from './types';
import { compare, evidence, fromAudit, run } from './kit';

const SECTIONS = [
  { id: '§3', title: 'Single spawn point' },
  { id: '§4', title: 'Host-derived resource budgets' },
  { id: '§5', title: 'Process-group termination' },
  { id: '§6', title: 'Wall-clock enforcement' },
  { id: '§18', title: 'Run registry and cross-process cancellation' },
  { id: '§32', title: 'Concurrency limits' },
  { id: '§33', title: 'Orphan and leak prevention' },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export const laneB: LaneSpec = {
  lane: 'B',
  title: 'Process / resource / concurrency',
  sections: SECTIONS,
  probes: [
    {
      id: 'B1', section: '§3', title: 'no engine module spawns outside the supervisor',
      run(ctx) {
        const dir = path.join(ctx.auditRoot, 'src/engine');
        const allowed = ['exec.ts', 'isolation.ts', 'orchestrator.ts', 'providers.ts'];
        const offenders: string[] = [];
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
          if (allowed.includes(f)) continue;
          const src = fs.readFileSync(path.join(dir, f), 'utf8');
          const hits = [...src.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g)].map((m) => m[1]);
          if (hits.length) offenders.push(`${f}: ${hits.join(',')}`);
        }
        const setupDir = path.join(ctx.auditRoot, 'src/setup');
        const setupOffenders = fs.readdirSync(setupDir).filter((f) => f.endsWith('.ts') && f !== 'probe.ts')
          .filter((f) => /child_process/.test(fs.readFileSync(path.join(setupDir, f), 'utf8')));
        const observed = compare([
          ['engine modules spawning directly', offenders.join(' | ') || '(none)'],
          ['setup modules bypassing the probe', setupOffenders.join(', ') || '(none)'],
        ]);
        return !offenders.length && !setupOffenders.length
          ? held(observed)
          : defect(observed, {
            sections: ['§3'], severity: 'P1',
            title: 'A module spawns processes outside the supervisor',
            detail: `Direct process creation found in: ${[...offenders, ...setupOffenders].join(', ')}`,
            impact: 'That path escapes policy, budgets, isolation and the run registry, so cancel cannot reach it.',
          });
      },
    },

    {
      id: 'B2', section: '§5', title: 'terminating a job kills the whole process tree',
      async run(ctx) {
        const { ProcessSupervisor } = fromAudit(ctx.auditRoot, '../src/engine/exec');
        const { deriveBudgets } = fromAudit(ctx.auditRoot, '../src/engine/budget');
        const { defaultPolicy } = fromAudit(ctx.auditRoot, '../src/engine/policy');
        const wt = path.join(ctx.tmp, 'b2'); fs.mkdirSync(wt, { recursive: true });
        const sup = new ProcessSupervisor(deriveBudgets(), undefined, path.join(ctx.tmp, 'b2-state'));
        const marker = 'zeus-audit-b2-30251';
        const p = sup.run({
          id: 'b2', projectId: 'p', taskId: 't', cls: 'light',
          command: 'sh', args: ['-c', `sleep ${'3025'}1 & sleep ${'3025'}1 & wait`],
          cwd: wt, policy: defaultPolicy(wt, wt), timeoutSeconds: 60,
        });
        await sleep(1200);
        const before = run('sh', ['-c', `pgrep -f "[s]leep 30251" | wc -l`]).stdout.trim();
        sup.killTask('t', 'audit');
        await sleep(900);
        const after = run('sh', ['-c', `pgrep -f "[s]leep 30251" | wc -l`]).stdout.trim();
        await p.catch(() => undefined);
        const observed = compare([['children before kill', before], ['children after kill', after], ['marker', marker]]);
        return Number(before) >= 2 && Number(after) === 0
          ? held(observed)
          : defect(observed, {
            sections: ['§5', '§33'], severity: 'P0',
            title: 'Killing a job leaves descendants running',
            detail: `${after} descendant process(es) survived termination.`,
            impact: 'A cancelled or timed-out task keeps consuming the host, and the operator is told it stopped.',
          });
      },
    },

    {
      id: 'B3', section: '§6', title: 'a hung command is stopped by its wall clock',
      async run(ctx) {
        const { ProcessSupervisor } = fromAudit(ctx.auditRoot, '../src/engine/exec');
        const { deriveBudgets } = fromAudit(ctx.auditRoot, '../src/engine/budget');
        const { defaultPolicy } = fromAudit(ctx.auditRoot, '../src/engine/policy');
        const wt = path.join(ctx.tmp, 'b3'); fs.mkdirSync(wt, { recursive: true });
        const sup = new ProcessSupervisor(deriveBudgets(), undefined, path.join(ctx.tmp, 'b3-state'));
        const started = Date.now();
        const res = await sup.run({
          id: 'b3', projectId: 'p', taskId: 't3', cls: 'light',
          command: 'sh', args: ['-c', 'sleep 30252'], cwd: wt,
          // The request field is timeoutSeconds. An earlier version of this
          // probe passed `timeoutMs` — which the supervisor ignores — and
          // reported the resulting 300s default as a missing wall clock. The
          // finding was wrong; the probe was.
          policy: defaultPolicy(wt, wt), timeoutSeconds: 2,
        });
        const elapsed = Date.now() - started;
        await sleep(500);
        const leaked = run('sh', ['-c', 'pgrep -f "[s]leep 30252" | wc -l']).stdout.trim();
        const observed = compare([
          ['outcome', String(res.outcome)], ['elapsed ms', String(elapsed)],
          ['processes left behind', leaked],
        ]);
        return res.outcome === 'TIMEOUT' && elapsed < 15_000 && leaked === '0'
          ? held(observed)
          : defect(observed, {
            sections: ['§6'], severity: 'P0',
            title: 'The wall clock does not stop a hung command',
            detail: `outcome=${res.outcome} after ${elapsed}ms with ${leaked} process(es) still running.`,
            impact: 'A single hung test blocks the queue indefinitely and holds resources nobody can reclaim.',
          });
      },
    },

    {
      id: 'B4', section: '§4', title: 'budgets are derived from the host and reserve control-plane capacity',
      run(ctx) {
        const { deriveBudgets } = fromAudit(ctx.auditRoot, '../src/engine/budget');
        const os = require('os');
        const b = deriveBudgets();
        const observed = compare([
          ['host', `${os.cpus().length} cpus, ${Math.round(os.totalmem() / 2 ** 20)} MB`],
          ['derivedFrom', JSON.stringify(b.derivedFrom)],
          ['reserved', `${b.reservedCpus} cpu, ${b.reservedMemMb} MB`],
          ['per execution', `${b.cpuQuotaPercent}% cpu, ${b.memoryMaxMb} MB, ${b.maxProcesses} procs`],
        ]);
        const sane = b.reservedCpus >= 1 && b.reservedMemMb > 0
          && b.memoryMaxMb < b.derivedFrom.totalMemMb && b.maxProcesses > 0;
        return sane ? held(observed) : defect(observed, {
          sections: ['§4'], severity: 'P1',
          title: 'Resource budgets do not reserve capacity for the control plane',
          detail: 'Derived budgets allowed a single execution to claim the whole host.',
          impact: 'A heavy task can starve the orchestrator, so nothing is left to record or stop it.',
        });
      },
    },

    {
      id: 'B5', section: '§18', title: 'cancel reaches only the recorded task',
      async run(ctx) {
        const { killRecorded, registryDirFor } = fromAudit(ctx.auditRoot, '../src/engine/exec');
        const stateRoot = path.join(ctx.tmp, 'b5-state');
        const dir = registryDirFor(stateRoot);
        fs.mkdirSync(dir, { recursive: true });
        const mine = spawn('sh', ['-c', 'sleep 30253'], { detached: true, stdio: 'ignore' });
        const theirs = spawn('sh', ['-c', 'sleep 30254'], { detached: true, stdio: 'ignore' });
        await sleep(400);
        const rec = (jobId: string, taskId: string, pid: number) => fs.writeFileSync(
          path.join(dir, `${jobId}.json`),
          JSON.stringify({ jobId, pgid: pid, pid, unit: null, projectId: 'p', taskId, hostname: 'h', startedAt: new Date().toISOString(), command: 'sh' }));
        rec('j-mine', 'T-1', mine.pid!);
        rec('j-theirs', 'T-2', theirs.pid!);
        const r = killRecorded(stateRoot, { taskId: 'T-1' }, 'audit');
        await sleep(500);
        const observed = compare([
          ['killed', String(r.killed)],
          ['T-1 process alive after cancel', String(alive(mine.pid!))],
          ['T-2 process alive after cancel', String(alive(theirs.pid!))],
          ['T-2 record still present', String(fs.existsSync(path.join(dir, 'j-theirs.json')))],
        ]);
        const ok = r.killed === 1 && !alive(mine.pid!) && alive(theirs.pid!);
        try { process.kill(-theirs.pid!, 'SIGKILL'); } catch { /* fine */ }
        try { process.kill(-mine.pid!, 'SIGKILL'); } catch { /* fine */ }
        return ok ? held(observed) : defect(observed, {
          sections: ['§18'], severity: 'P0',
          title: 'Cancel affects tasks it was not asked to cancel',
          detail: 'Cancelling one task killed another task\'s process group, or failed to kill its own.',
          impact: 'One cancel can take down unrelated concurrent work with no record that it did.',
        });
      },
    },

    {
      id: 'B6', section: '§18', title: 'a recycled process group is not killed on the strength of its number alone',
      async run(ctx) {
        const { killRecorded, registryDirFor } = fromAudit(ctx.auditRoot, '../src/engine/exec');
        const stateRoot = path.join(ctx.tmp, 'b6-state');
        const dir = registryDirFor(stateRoot);
        fs.mkdirSync(dir, { recursive: true });
        // A process Zeus never started, standing in for whatever inherited the
        // pgid after the real job exited and the number was recycled.
        const bystander = spawn('sh', ['-c', 'sleep 30255'], { detached: true, stdio: 'ignore' });
        await sleep(400);
        fs.writeFileSync(path.join(dir, 'j-stale.json'), JSON.stringify({
          jobId: 'j-stale', pgid: bystander.pid, pid: bystander.pid, unit: null,
          projectId: 'p', taskId: 'T-9', hostname: 'h',
          startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
          command: 'jest', // the record says jest; the live group is `sh -c sleep`
        }));
        const r = killRecorded(stateRoot, { taskId: 'T-9' }, 'audit');
        await sleep(500);
        const survived = alive(bystander.pid!);
        const observed = compare([
          ['recorded command', 'jest'],
          ['live process with that pgid', 'sh -c sleep 30255 (started by something else)'],
          ['record age', '3 hours'],
          ['killRecorded result', JSON.stringify({ killed: r.killed, pruned: r.pruned })],
          ['bystander still alive', String(survived)],
        ]);
        try { process.kill(-bystander.pid!, 'SIGKILL'); } catch { /* fine */ }
        return survived ? held(observed) : defect(observed, {
          sections: ['§18', '§33'], severity: 'P1',
          title: 'Cancel kills any process group whose number matches a stale record',
          detail:
            'killRecorded() checks only that the recorded pgid is alive (`kill(-pgid, 0)`) before signalling it. '
            + 'It does not verify that the live group is still the job it recorded — not by command, not by start '
            + 'time, not by any handle that survives PID reuse. A record left behind by a crashed run therefore '
            + 'points at whatever process group later inherits that number.',
          impact:
            'On a busy or long-lived host, `zeus cancel` (and cancel-on-crash cleanup) can SIGKILL an unrelated '
            + 'process tree belonging to the user or another service, and will report it as having cancelled the task. '
            + 'PID space is small and recycles quickly under load, which is exactly when stale records accumulate.',
        });
      },
    },

    {
      id: 'B7', section: '§32', title: 'heavy executions are serialised',
      run(ctx) {
        const { deriveBudgets } = fromAudit(ctx.auditRoot, '../src/engine/budget');
        const b = deriveBudgets();
        const observed = compare([
          ['globalHeavyConcurrency', String(b.globalHeavyConcurrency)],
          ['globalLightConcurrency', String(b.globalLightConcurrency)],
          ['maxTestWorkers', String(b.maxTestWorkers)],
        ]);
        return b.globalHeavyConcurrency >= 1 && b.globalHeavyConcurrency <= 2 && b.globalLightConcurrency >= b.globalHeavyConcurrency
          ? held(observed)
          : defect(observed, {
            sections: ['§32'], severity: 'P2',
            title: 'Heavy concurrency is not bounded conservatively',
            detail: `globalHeavyConcurrency=${b.globalHeavyConcurrency}`,
            impact: 'Concurrent heavy suites starve the host, which is how timing evidence becomes meaningless.',
          });
      },
    },

    {
      id: 'B8', section: '§33', title: 'the audit itself leaves no processes behind',
      async run(ctx) {
        await sleep(300);
        const leaked = run('sh', ['-c', 'pgrep -f "[s]leep 3025" | wc -l']).stdout.trim();
        const observed = compare([['audit-marker processes still running', leaked]]);
        return leaked === '0' ? held(observed) : defect(observed, {
          sections: ['§33'], severity: 'P2',
          title: 'The audit harness leaks processes',
          detail: `${leaked} marker process(es) survived the lane.`,
          impact: 'A harness that leaks cannot be trusted to report on leaks.',
        });
      },
    },
  ],

  declared: [
    {
      section: '§4', status: 'NOT_TESTED',
      reason:
        'Kernel enforcement of the memory cap was not verified. Attempted: allocating past memoryMaxMb inside a '
        + 'supervised execution to observe a cgroup OOM kill. Blocked because this host selects the bubblewrap '
        + 'backend (no systemd user manager, confirmed by `zeus doctor`), and bubblewrap provides filesystem and '
        + 'network confinement but not memory accounting — so the limit is advisory here and a passing probe would '
        + 'have proved nothing about a host where it is enforced.',
    },
  ],
};
