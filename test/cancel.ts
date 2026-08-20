/**
 * Cross-process cancellation.
 *
 * `zeus cancel` runs in a DIFFERENT OS process from the one that owns the
 * execution. It reaches the work through the on-disk run registry and signals
 * the process group — but a signal carries no reason, so the owning supervisor
 * saw SIGTERM and classified an ordinary human cancellation as
 * RESOURCE_LIMIT_EXCEEDED. That is a lie in a permanent, hash-chained record,
 * and everything downstream reads it.
 *
 * These tests use two real OS processes, because a same-process test cannot
 * observe the thing that was broken.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { check, section } from './harness';
import {
  ProcessSupervisor, listRunRecords, registryDirFor, killRecorded,
  writeCancelMarker, readCancelMarker, clearCancelMarker,
} from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { defaultPolicy } from '../src/engine/policy';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-cancel-'));
const REPO = path.resolve(__dirname, '..');

/**
 * Job ids are unique per RUN, not per test.
 *
 * The isolation backend derives a transient systemd unit name from the job id,
 * so a fixed id means a fixed unit name — and a scope orphaned by an earlier
 * run makes the next `systemd-run` exit 1 instantly, before anything is
 * registered. That produced an intermittent FAILED here that looked like the
 * cancellation fix misbehaving and was actually two runs colliding.
 */
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const jobId = (name: string): string => `xc-${name}-${RUN}`;

/** An owner process: starts one long execution and prints how it ended. */
function ownerScript(stateRoot: string, taskId: string, jobId: string, sleeper: string): string {
  const file = path.join(TMP, `owner-${jobId}.js`);
  fs.writeFileSync(file, `
    const { ProcessSupervisor } = require(${JSON.stringify(path.join(REPO, 'src/engine/exec'))});
    const { deriveBudgets } = require(${JSON.stringify(path.join(REPO, 'src/engine/budget'))});
    const { defaultPolicy } = require(${JSON.stringify(path.join(REPO, 'src/engine/policy'))});
    const sup = new ProcessSupervisor(deriveBudgets({ lightTimeoutSeconds: 90 }), undefined, ${JSON.stringify(stateRoot)});
    sup.run({
      id: ${JSON.stringify(jobId)}, projectId: 'p', taskId: ${JSON.stringify(taskId)}, cls: 'light',
      command: ${JSON.stringify(sleeper)}, args: [], cwd: ${JSON.stringify(TMP)},
      policy: defaultPolicy(${JSON.stringify(TMP)}, ${JSON.stringify(TMP)}),
      confineFilesystem: false, timeoutSeconds: 90,
    }).then((r) => {
      process.stdout.write('RESULT ' + JSON.stringify({
        outcome: r.outcome, signal: r.signal, exitCode: r.exitCode,
        productSignal: r.productSignal, backend: r.backend,
      }) + '\\n');
      process.exit(0);
    });
  `);
  return file;
}

interface OwnerRun { result: Record<string, unknown> | null; pgid: number }

/** Starts an owner, waits for its execution to appear in the registry. */
async function startOwner(stateRoot: string, taskId: string, jobId: string, sleeper: string):
  Promise<{ child: ReturnType<typeof spawn>; done: Promise<OwnerRun>; pgid: number }> {
  const script = ownerScript(stateRoot, taskId, jobId, sleeper);
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', script],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' } });
  let text = '';
  child.stdout.on('data', (d: Buffer) => { text += d.toString(); });
  child.stderr.on('data', () => { /* the owner's own diagnostics */ });

  // The close listener is attached BEFORE the registry poll, and that ordering
  // is the point. Attaching it afterwards loses the event when the owner exits
  // during the poll — the promise then never settles, the event loop empties,
  // and node exits 0 in the middle of the suite with no error and no summary.
  // A silent exit-zero is the worst failure a test harness can have.
  let live: ReturnType<typeof listRunRecords> = [];
  const done = new Promise<OwnerRun>((resolve) => {
    child.on('close', () => {
      const m = /RESULT (\{.*\})/.exec(text);
      resolve({ result: m ? JSON.parse(m[1]) : null, pgid: live[0]?.pgid ?? 0 });
    });
  });

  live = listRunRecords(registryDirFor(stateRoot)).filter((r) => r.jobId === jobId);
  for (let i = 0; i < 150 && !live.length; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    live = listRunRecords(registryDirFor(stateRoot)).filter((r) => r.jobId === jobId);
  }
  return { child, done, pgid: live[0]?.pgid ?? 0 };
}

export async function crossProcessCancelSuite(): Promise<void> {
  const sleeper = path.join(TMP, 'sleep.sh');
  fs.writeFileSync(sleeper, '#!/bin/bash\nsleep 90\n', { mode: 0o755 });
  const quick = path.join(TMP, 'quick.sh');
  fs.writeFileSync(quick, '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  // ---------------------------------------------------------------------
  section('cross-process cancel: intent survives the process boundary');
  {
    const stateRoot = path.join(TMP, 'state-1');
    const owner = await startOwner(stateRoot, 'p/T-0001', jobId('cancel'), sleeper);
    check('XC1: the owner registered its execution where another process can find it',
      owner.pgid > 0, `pgid=${owner.pgid}`);

    // This is `zeus cancel`: a different OS process, reaching the work through
    // the registry and nothing else.
    const killed = killRecorded(stateRoot, { taskId: 'p/T-0001' }, 'operator cancelled the task');
    const ended = await owner.done;
    check('XC2: the kill reached it', killed.killed === 1, JSON.stringify({ killed: killed.killed }));
    check('XC3: and the OWNER classified it CANCELLED, not a resource event',
      ended.result?.outcome === 'CANCELLED', JSON.stringify(ended.result));
    check('XC4: productSignal stays false — a cancelled execution is not a verdict',
      ended.result?.productSignal === false);
    check('XC5: the tombstone does not outlive the execution it describes',
      !fs.existsSync(path.join(registryDirFor(stateRoot), `${jobId('cancel')}.cancel`)),
      fs.existsSync(registryDirFor(stateRoot))
        ? fs.readdirSync(registryDirFor(stateRoot)).join(',') : '(no registry dir)');
  }

  // ---------------------------------------------------------------------
  section('cross-process cancel: intent is what distinguishes it, not the signal');
  {
    // The same signal, the same shape, no intent recorded. This is what a
    // scope stop or an external SIGTERM looks like, and it must NOT become a
    // cancellation just because the fix exists.
    const stateRoot = path.join(TMP, 'state-2');
    const owner = await startOwner(stateRoot, 'p/T-0002', jobId('nointent'), sleeper);
    check('XC6: the execution is live', owner.pgid > 0);
    try { process.kill(-owner.pgid, 'SIGTERM'); } catch { /* raced */ }
    const ended = await owner.done;
    check('XC7: an identical signal with NO intent is not classified CANCELLED',
      ended.result?.outcome !== 'CANCELLED', JSON.stringify(ended.result));
    check('XC8: it is still reported as a non-verdict, whatever it was',
      ended.result?.productSignal === false, JSON.stringify(ended.result));
  }

  // ---------------------------------------------------------------------
  section('cross-process cancel: the ordering guarantee, exercised not asserted');
  {
    // The race the ordering exists to close: a process that dies the instant
    // it is signalled. If the marker were written AFTER the kill, the owner's
    // close handler could run first and classify from an empty directory.
    // Repeated, because a race that fires one time in five is still a race.
    const outcomes: string[] = [];
    const detail: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const stateRoot = path.join(TMP, `state-race-${i}`);
      const owner = await startOwner(stateRoot, `p/T-100${i}`, jobId(`race-${i}`), sleeper);
      const killed = killRecorded(stateRoot, { taskId: `p/T-100${i}` }, 'race probe');
      const markerSeen = fs.existsSync(path.join(registryDirFor(stateRoot), `${jobId(`race-${i}`)}.cancel`));
      const ended = await owner.done;
      outcomes.push(String(ended.result?.outcome));
      detail.push(`${i}:${ended.result?.outcome}/code=${ended.result?.exitCode}/sig=${ended.result?.signal}`
        + `/killed=${killed.killed}/markerAtKill=${markerSeen}`);
    }
    check('XC9: every one of 5 immediate-death cancellations classified CANCELLED',
      outcomes.every((o) => o === 'CANCELLED'), detail.join(' | '));

    // And the ordering itself, so a later edit cannot quietly invert it.
    const src = fs.readFileSync(path.join(REPO, 'src/engine/exec.ts'), 'utf8');
    const kill = src.indexOf('export function killRecorded');
    const marker = src.indexOf('writeCancelMarker(dir, rec, reason)', kill);
    const signal = src.indexOf('process.kill(-rec.pgid, sig)', kill);
    check('XC10: intent is recorded BEFORE the first signal is sent',
      marker > kill && signal > marker, `marker@${marker} signal@${signal}`);
  }

  // ---------------------------------------------------------------------
  section('cross-process cancel: a tombstone belongs to one execution');
  {
    const stateRoot = path.join(TMP, 'state-3');
    const dir = registryDirFor(stateRoot);
    const sup = new ProcessSupervisor(deriveBudgets({ lightTimeoutSeconds: 60 }), undefined, stateRoot);
    // A marker left behind by an execution that is long gone, naming a process
    // group this run does not have.
    writeCancelMarker(dir, {
      jobId: 'xc-stale', pgid: 999_999, pid: 999_999, unit: null, projectId: 'p',
      taskId: 'p/T-0003', hostname: 'h', startedAt: new Date().toISOString(),
      command: 'gone', startTicks: 1,
    }, 'a cancellation from another era');
    const res = await sup.run({
      id: 'xc-stale', projectId: 'p', taskId: 'p/T-0003', cls: 'light',
      command: quick, args: [], cwd: TMP, policy: defaultPolicy(TMP, TMP), confineFilesystem: false,
    } as any);
    check('XC11: a stale tombstone naming another process group is ignored',
      res.outcome === 'COMPLETED', `${res.outcome}`);
    check('XC12: a finished execution clears the tombstone that named its id',
      readCancelMarker(dir, 'xc-stale', 999_999) === null,
      'the run above cleared it on the way out, which is the cleanup path');

    // The identity check itself, with no run to clean up underneath it.
    writeCancelMarker(dir, {
      jobId: 'xc-identity', pgid: 4242, pid: 4242, unit: null, projectId: 'p',
      taskId: 'p/T-0004', hostname: 'h', startedAt: new Date().toISOString(),
      command: 'x', startTicks: 7,
    }, 'identity probe');
    check('XC12b: a tombstone is read only by the process group it names',
      readCancelMarker(dir, 'xc-identity', 4242) !== null
      && readCancelMarker(dir, 'xc-identity', 999_999) === null
      && readCancelMarker(dir, 'no-such-job', 4242) === null);
    clearCancelMarker(dir, 'xc-identity');
    check('XC13: clearing a marker that never existed is not an error',
      (() => { clearCancelMarker(dir, 'never-here'); return true; })());
    sup.shutdown('cancel suite finished');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
