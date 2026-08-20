/**
 * The process supervisor — the one and only place this product spawns anything.
 *
 *   ExecutionRequest → ExecutionPolicy → ResourceGovernor → IsolationBackend
 *                    → ProcessSupervisor → actual process
 *
 * Every stage can refuse. Nothing downstream can re-grant what an earlier stage
 * denied, and no module may call child_process itself: `test/no-bypass` walks
 * the engine sources and fails the build if one does. That rule is the only
 * reason the guarantees here mean anything.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionPolicy, buildEnv, inspectCommand, resolveWithin, PolicyViolation } from './policy';
import { Budgets, deriveBudgets } from './budget';
import { wrap, detectBackends, BackendCapability, BackendId, systemdUserEnv } from './isolation';

export type ExecClass = 'light' | 'heavy' | 'agent';

export type ExecOutcome =
  | 'COMPLETED'
  | 'FAILED'                  // ran, non-zero exit: a statement about the code
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RESOURCE_LIMIT_EXCEEDED' // OOM / PID cap / cgroup kill
  | 'POLICY_DENIED'           // refused before spawning
  | 'INFRASTRUCTURE_FAILURE'; // could not spawn at all

export interface ExecutionRequest {
  id: string;
  projectId: string;
  taskId?: string;
  cls: ExecClass;
  command: string;
  args: string[];
  /** Relative to the policy's worktree unless absolute and inside it. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  policy: ExecutionPolicy;
  /** Ask for filesystem confinement (project commands: yes; our own git: no). */
  confineFilesystem?: boolean;
  /**
   * Static inspection of the arguments. On by default. Turned off only for
   * argv WE author (agent prompts contain prose that is not a command), where
   * containment still comes from cwd, env filtering, isolation and the
   * governor.
   */
  inspectArgs?: boolean;
  onOutput?: (chunk: string) => void;
}

export interface ExecutionResult {
  id: string;
  outcome: ExecOutcome;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  queueWaitMs: number;
  durationMs: number;
  pid: number | null;
  pgid: number | null;
  backend: BackendId;
  isolationFallback: boolean;
  enforced: string[];
  violations: PolicyViolation[];
  /** True only when the outcome says something about the code under test. */
  productSignal: boolean;
  budgets: { memoryMaxMb: number; cpuQuotaPercent: number; maxProcesses: number; testWorkers: number };
  /**
   * Monotonic instants around the child process, for latency measurement.
   *
   * Passive: these are read from the clock at moments the supervisor already
   * passes through, and nothing branches on them. `firstOutputNs` is the
   * closest observable proxy for "the program finished starting up and began
   * doing work" — for a test runner that is compilation and collection, for a
   * model CLI it is connection and first token. Absent when the process
   * produced no output at all.
   */
  timing?: {
    requestedNs: string;
    spawnedNs: string;
    firstOutputNs: string | null;
    exitedNs: string;
  };
}

interface LiveJob { pgid: number; unit: string | null; projectId: string; taskId?: string; cancelled: boolean }

/**
 * On-disk registry of running process groups.
 *
 * `zeus cancel` is a DIFFERENT PROCESS from `zeus run`, so an
 * in-memory map cannot cancel anything: the first version reported "cancelled"
 * while the test suite kept running. Every spawn therefore records its process
 * group where another process can find it, and removes it on exit.
 */
export interface RunRecord {
  jobId: string; pgid: number; pid: number; unit: string | null;
  projectId: string; taskId: string | null; hostname: string; startedAt: string; command: string;
  /**
   * The kernel's start time for this pid, in clock ticks since boot
   * (/proc/<pid>/stat field 22). A pid number is reusable; a pid PLUS its
   * start time is not, which is what makes it safe to signal later.
   */
  startTicks?: number | null;
}

/** Reads a process's start time, so a recycled pid can be told apart. */
export function processStartTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parentheses, so parse after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch { return null; }
}

export function registryDirFor(stateRoot: string): string { return path.join(stateRoot, 'running'); }

/**
 * Cancellation intent, written where another OS process can see it.
 *
 * `zeus cancel` is a DIFFERENT PROCESS from the one that owns the execution.
 * It can signal the process group — that is what the run registry is for — but
 * a signal carries no reason. The owning supervisor saw SIGTERM and had no way
 * to tell "a human cancelled this" from "the cgroup stopped the unit", so it
 * classified an ordinary `zeus cancel` as RESOURCE_LIMIT_EXCEEDED. That is a
 * lie in the permanent record, and telemetry, attribution and any later
 * convergence logic all read it.
 *
 * A tombstone beside the run record carries the intent across the process
 * boundary.
 *
 * ORDERING GUARANTEE, and it is the whole design: the marker is written
 * **before the first signal is sent**, and fsynced. The owner cannot observe
 * the death before the intent exists, because the death has not been caused
 * yet. Writing it afterwards would race — the child can die and `close` can
 * fire while the killer is still between `kill()` and `writeFileSync`, and the
 * owner would classify from an empty directory.
 *
 * The marker names the process group AND its kernel start time, so a stale
 * tombstone cannot be adopted by a later execution that happens to reuse the
 * job id or the pid: identity has to match, not just the name.
 */
export interface CancelMarker {
  jobId: string;
  pgid: number;
  startTicks: number | null;
  reason: string;
  at: string;
  /** The pid that asked for the cancellation, for the record. */
  by: number;
}

function cancelMarkerPath(dir: string, jobId: string): string {
  return path.join(dir, `${jobId.replace(/[^A-Za-z0-9_.-]/g, '~')}.cancel`);
}

export function writeCancelMarker(dir: string, rec: RunRecord, reason: string): void {
  const marker: CancelMarker = {
    jobId: rec.jobId, pgid: rec.pgid, startTicks: rec.startTicks ?? null,
    reason, at: new Date().toISOString(), by: process.pid,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = cancelMarkerPath(dir, rec.jobId);
    const fd = fs.openSync(file, 'w');
    try { fs.writeSync(fd, `${JSON.stringify(marker)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch { /* best effort: a missing marker degrades to the old behaviour */ }
}

/**
 * Whether THIS execution was cancelled by another process.
 *
 * Identity is checked, not just the id: a marker for a different process group
 * belongs to a different execution and is ignored.
 */
export function readCancelMarker(dir: string, jobId: string, pgid: number): CancelMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(cancelMarkerPath(dir, jobId), 'utf8')) as CancelMarker;
    return m && m.pgid === pgid ? m : null;
  } catch { return null; }
}

export function clearCancelMarker(dir: string, jobId: string): void {
  try { fs.unlinkSync(cancelMarkerPath(dir, jobId)); } catch { /* never existed */ }
}

function writeRunRecord(dir: string, rec: RunRecord): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${rec.jobId.replace(/[^A-Za-z0-9_.-]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(rec));
  } catch { /* the registry is best-effort; in-memory kill still applies */ }
}

function removeRunRecord(dir: string, jobId: string): void {
  try { fs.rmSync(path.join(dir, `${jobId.replace(/[^A-Za-z0-9_.-]/g, '-')}.json`), { force: true }); }
  catch { /* already gone */ }
}

export function listRunRecords(dir: string): RunRecord[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RunRecord; } catch { return null; }
    }).filter((x): x is RunRecord => !!x);
  } catch { return []; }
}

/**
 * How runtimes say they ran out of memory.
 *
 * Deliberately specific. Matching a bare "out of memory" would reclassify any
 * test that merely asserts on that string, and calling a real failure a
 * resource breach misleads in the opposite direction — both are wrong, so each
 * pattern names a runtime's actual fatal message.
 */
const OUT_OF_MEMORY = new RegExp([
  'JavaScript heap out of memory',
  'Fatal process OOM',
  'FATAL ERROR:[^\\n]*(heap out of memory|Reached heap limit)',
  'Failed to reserve virtual memory',
  'std::bad_alloc',
  'Cannot allocate memory',
  'OutOfMemoryError',
  'MemoryError:',
  'fork: retry',
  'Resource temporarily unavailable',
  'Killed process',
  'Out of memory: Killed',
].join('|'), 'i');

/** Is this recorded group still alive? Used to prune after a crash. */
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

/**
 * Is the live process wearing this pid actually the one we recorded?
 *
 * Pid numbers recycle, and quickly under load — which is exactly when stale
 * records pile up after crashed runs. Signalling on the strength of a number
 * alone means `zeus cancel` can kill somebody else's process tree and report
 * it as having cancelled the task. Comparing the kernel's start time settles
 * it. Where that is unavailable (non-Linux), a record is trusted only while it
 * is young enough that reuse is implausible.
 */
const REUSE_SAFE_AGE_MS = 60 * 60_000;

export function stillOurProcess(rec: RunRecord): { ours: boolean; reason: string } {
  const now = processStartTicks(rec.pid);
  if (rec.startTicks != null && now != null) {
    return now === rec.startTicks
      ? { ours: true, reason: 'kernel start time matches the recorded value' }
      : { ours: false, reason: `pid ${rec.pid} has been recycled (start time ${now} != recorded ${rec.startTicks})` };
  }
  const ageMs = Date.now() - Date.parse(rec.startedAt);
  if (!Number.isFinite(ageMs)) return { ours: false, reason: 'record has no usable start time and cannot be verified' };
  return ageMs < REUSE_SAFE_AGE_MS
    ? { ours: true, reason: `start time unavailable; record is ${Math.round(ageMs / 1000)}s old, within the reuse-safe window` }
    : { ours: false, reason: `start time unavailable and the record is ${Math.round(ageMs / 60000)} minutes old; refusing to signal a possibly recycled pid` };
}

/**
 * Kills recorded process groups from ANY process — this is what makes
 * `zeus cancel` work against a task started by a different invocation.
 */
export function killRecorded(stateRoot: string, filter: { taskId?: string; projectId?: string }, reason: string):
  { killed: number; pruned: number; records: RunRecord[]; unverified: Array<{ jobId: string; pid: number; reason: string }> } {
  const dir = registryDirFor(stateRoot);
  let killed = 0, pruned = 0;
  const hit: RunRecord[] = [];
  // Records that named a live pid we could not prove was ours. Reported rather
  // than silently dropped: "we declined to kill something" is information.
  const unverified: Array<{ jobId: string; pid: number; reason: string }> = [];
  for (const rec of listRunRecords(dir)) {
    if (filter.taskId && rec.taskId !== filter.taskId) continue;
    if (filter.projectId && rec.projectId !== filter.projectId) continue;
    if (!groupAlive(rec.pgid)) {
      removeRunRecord(dir, rec.jobId); clearCancelMarker(dir, rec.jobId); pruned += 1; continue;
    }
    // Alive is not the same as ours.
    const identity = stillOurProcess(rec);
    if (!identity.ours) {
      unverified.push({ jobId: rec.jobId, pid: rec.pid, reason: identity.reason });
      removeRunRecord(dir, rec.jobId); clearCancelMarker(dir, rec.jobId); pruned += 1; continue;
    }
    // Intent first, then the signal. See writeCancelMarker for why the order
    // is the design and not a detail: after the signal there is a window in
    // which the owner has already classified.
    writeCancelMarker(dir, rec, reason);
    if (rec.unit) spawnSync('systemctl', ['--user', 'stop', rec.unit], { timeout: 10_000 });
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try { if (rec.pgid > 1) process.kill(-rec.pgid, sig); } catch { /* raced */ }
    }
    removeRunRecord(dir, rec.jobId);
    hit.push(rec); killed += 1;
  }
  return { killed, pruned, records: hit, unverified };
}

/**
 * Resolves the executable the way the kernel will.
 *
 * A missing toolchain must be diagnosed BEFORE the isolation wrapper runs:
 * bwrap reports `execvp go: No such file` by exiting 1, which is
 * indistinguishable from a failing test unless we check first. "The compiler
 * is not installed" and "your code is wrong" are not the same finding.
 */
export function resolveExecutable(command: string, env: Record<string, string>): { ok: boolean; detail: string } {
  if (command.includes('/')) {
    return fs.existsSync(command)
      ? { ok: true, detail: command }
      : { ok: false, detail: `executable not found: ${command}` };
  }
  const dirs = (env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const candidate = path.join(d, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return { ok: true, detail: candidate }; }
    catch { /* keep looking */ }
  }
  return { ok: false, detail: `executable not found on PATH: ${command}` };
}

/** Worker caps applied to the environment so a project's own script is bounded. */
export function workerEnv(b: Budgets): Record<string, string> {
  const w = String(Math.max(1, b.maxTestWorkers));
  return {
    JEST_MAX_WORKERS: w, VITEST_MAX_THREADS: w, VITEST_MIN_THREADS: '1',
    PLAYWRIGHT_WORKERS: String(Math.max(1, b.maxPlaywrightWorkers)),
    GOMAXPROCS: w, CARGO_BUILD_JOBS: w, MAKEFLAGS: `-j${w}`,
    MAVEN_OPTS: `-Dsurefire.forkCount=${w}`, UV_THREADPOOL_SIZE: w,
  };
}

/** Adds an explicit worker bound when the runner is recognised. */
export function boundedArgs(command: string, args: string[], b: Budgets): string[] {
  const joined = `${command} ${args.join(' ')}`;
  const w = Math.max(1, b.maxTestWorkers);
  const has = (flag: string) => args.some((a) => a.startsWith(flag));
  if (/\bjest\b/.test(joined) && !has('--maxWorkers') && !has('-w')) return [...args, `--maxWorkers=${w}`];
  if (/\bvitest\b/.test(joined) && !has('--maxWorkers')) return [...args, `--maxWorkers=${w}`];
  if (/\bplaywright\b/.test(joined) && !has('--workers')) return [...args, `--workers=${Math.max(1, b.maxPlaywrightWorkers)}`];
  if (/\bgo\b/.test(joined) && /\btest\b/.test(joined) && !has('-p')) return [...args, `-p=${w}`];
  if (/\bmvn\b/.test(joined) && !has('-T')) return [...args, `-T${w}`];
  return args;
}

export class ProcessSupervisor {
  private running = new Map<ExecClass, number>([['light', 0], ['heavy', 0], ['agent', 0]]);
  private queues = new Map<ExecClass, Array<() => void>>([['light', []], ['heavy', []], ['agent', []]]);
  private live = new Map<string, LiveJob>();
  readonly backends: BackendCapability[];
  maxObserved = new Map<ExecClass, number>([['light', 0], ['heavy', 0], ['agent', 0]]);

  /** Where run records are written so another process can cancel them. */
  readonly registryDir: string | null;

  constructor(readonly budgets: Budgets = deriveBudgets(), backends?: BackendCapability[], stateRoot?: string) {
    this.backends = backends ?? detectBackends();
    this.registryDir = stateRoot ? registryDirFor(stateRoot) : null;
    process.on('exit', () => this.shutdown('supervisor exit'));
  }

  private cap(cls: ExecClass): number {
    if (cls === 'heavy') return this.budgets.globalHeavyConcurrency;
    if (cls === 'agent') return Math.max(1, this.budgets.globalHeavyConcurrency + 1);
    return this.budgets.globalLightConcurrency;
  }

  queueDepth(cls: ExecClass): number { return this.queues.get(cls)!.length; }
  activeCount(cls: ExecClass): number { return this.running.get(cls)!; }

  private async acquire(cls: ExecClass, onQueued?: (d: number) => void): Promise<number> {
    const t0 = Date.now();
    if (this.running.get(cls)! >= this.cap(cls)) {
      onQueued?.(this.queueDepth(cls) + 1);
      await new Promise<void>((res) => this.queues.get(cls)!.push(res));
    }
    const n = this.running.get(cls)! + 1;
    this.running.set(cls, n);
    this.maxObserved.set(cls, Math.max(this.maxObserved.get(cls)!, n));
    return Date.now() - t0;
  }

  private release(cls: ExecClass): void {
    this.running.set(cls, Math.max(0, this.running.get(cls)! - 1));
    const next = this.queues.get(cls)!.shift();
    if (next) next();
  }

  /** The only spawn in the product. */
  async run(req: ExecutionRequest, onQueued?: (d: number) => void): Promise<ExecutionResult> {
    const budgets = this.budgets;
    const base = {
      id: req.id, queueWaitMs: 0, durationMs: 0, pid: null, pgid: null,
      backend: 'process-group' as BackendId, isolationFallback: true, enforced: [] as string[],
      productSignal: false,
      budgets: { memoryMaxMb: budgets.memoryMaxMb, cpuQuotaPercent: budgets.cpuQuotaPercent,
        maxProcesses: budgets.maxProcesses, testWorkers: budgets.maxTestWorkers },
    };

    // ---- policy: refuse before anything is spawned -------------------------
    const violations = (req.inspectArgs === false)
      ? [] : inspectCommand(req.policy, req.command, req.args);
    const cwdCheck = resolveWithin(req.policy.worktreeRoot, req.cwd ?? '.');
    if (!cwdCheck.ok) violations.push({ code: 'CWD_OUTSIDE_WORKTREE', detail: cwdCheck.reason });
    if (violations.length) {
      return { ...base, outcome: 'POLICY_DENIED', exitCode: null, signal: null, violations,
        stdout: `refused by execution policy:\n${violations.map((v) => `  ${v.code}: ${v.detail}`).join('\n')}` };
    }
    const cwd = (cwdCheck as { ok: true; abs: string }).abs;

    // ---- governor: wait for a slot ----------------------------------------
    const queueWaitMs = await this.acquire(req.cls, onQueued);
    const startedAt = Date.now();

    // ---- isolation: strongest practical backend ----------------------------
    const bounded = boundedArgs(req.command, req.args, budgets);
    const wrapped = wrap(req.command, bounded, {
      policy: req.policy, budgets, jobId: req.id,
      confineFilesystem: req.confineFilesystem ?? false,
    }, this.backends);

    // Confined toolchains need somewhere writable to cache, or `go`, `cargo`
    // and `npm` fail against a read-only HOME and it looks like the project's
    // fault. This redirection applies ONLY to confined project commands:
    // agent CLIs authenticate out of the real HOME, and moving it away from
    // them silently logs them out.
    const confined = req.confineFilesystem ?? false;
    let cacheEnv: Record<string, string> = {};
    if (confined) {
      const cacheDir = path.join(req.policy.worktreeRoot, '.zeus-cache');
      try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* best effort */ }
      cacheEnv = {
        HOME: cacheDir, XDG_CACHE_HOME: cacheDir,
        GOCACHE: path.join(cacheDir, 'go-build'), GOMODCACHE: path.join(cacheDir, 'go-mod'),
        CARGO_HOME: path.join(cacheDir, 'cargo'), npm_config_cache: path.join(cacheDir, 'npm'),
      };
    }
    // The wrapper's own environment is applied AFTER the policy allowlist:
    // XDG_RUNTIME_DIR is Zeus's, not the project's, and `systemd-run --user`
    // cannot find its bus without it. Filtering it through the project's
    // allowlist would silently disable cgroup enforcement.
    const env = { ...buildEnv(req.policy, { ...workerEnv(budgets), ...cacheEnv, ...(req.env ?? {}) }),
      ...(wrapped.env ?? {}) };

    // Diagnose a missing toolchain before any wrapper can disguise it.
    const exe = resolveExecutable(req.command, env);
    if (!exe.ok) {
      this.release(req.cls);
      return {
        ...base, outcome: 'INFRASTRUCTURE_FAILURE', exitCode: null, signal: null, violations: [],
        stdout: exe.detail, queueWaitMs,
      };
    }
    const timeoutMs = 1000 * (req.timeoutSeconds
      ?? (req.cls === 'light' ? budgets.lightTimeoutSeconds : budgets.heavyTimeoutSeconds));

    const requestedNs = process.hrtime.bigint();
    return await new Promise<ExecutionResult>((resolve) => {
      let settled = false;
      let spawnedNs = requestedNs;
      let firstOutputNs: bigint | null = null;
      let child;
      try {
        child = spawn(wrapped.command, wrapped.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        spawnedNs = process.hrtime.bigint();
      } catch (e: any) {
        this.release(req.cls);
        return resolve({ ...base, outcome: 'INFRASTRUCTURE_FAILURE', exitCode: null, signal: null,
          violations: [], stdout: `spawn failed: ${e?.message ?? e}`, queueWaitMs,
          backend: wrapped.backend, isolationFallback: wrapped.fallback, enforced: wrapped.enforced });
      }
      const pgid = child.pid ?? 0;
      if (pgid) {
        this.live.set(req.id, { pgid, unit: wrapped.unit, projectId: req.projectId, taskId: req.taskId, cancelled: false });
        if (this.registryDir) {
          writeRunRecord(this.registryDir, {
            jobId: req.id, pgid, pid: child.pid ?? 0, unit: wrapped.unit,
            projectId: req.projectId, taskId: req.taskId ?? null, hostname: require('os').hostname(),
            startedAt: new Date().toISOString(), command: `${req.command} ${req.args.join(' ')}`.slice(0, 300),
            // Captured now, while we know the pid is ours.
            startTicks: processStartTicks(child.pid ?? 0),
          });
        }
      }

      let out = '';
      const cap = (d: Buffer) => {
        if (firstOutputNs === null) firstOutputNs = process.hrtime.bigint();
        const s = d.toString('utf8');
        if (out.length < 8 * 1024 * 1024) out += s;
        req.onOutput?.(s);
      };
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.kill(req.id, 'wall-clock timeout'); }, timeoutMs);

      const finish = (outcome: ExecOutcome, code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill(req.id, 'cleanup');
        this.live.delete(req.id);
        if (this.registryDir) {
          removeRunRecord(this.registryDir, req.id);
          // The tombstone has done its job; leaving it would outlive the
          // execution it describes.
          clearCancelMarker(this.registryDir, req.id);
        }
        this.release(req.cls);
        resolve({
          ...base, outcome, exitCode: code, signal, stdout: out, queueWaitMs,
          durationMs: Date.now() - startedAt, pid: child.pid ?? null, pgid: pgid || null,
          backend: wrapped.backend, isolationFallback: wrapped.fallback, enforced: wrapped.enforced,
          violations: [],
          productSignal: outcome === 'COMPLETED' || outcome === 'FAILED',
          timing: {
            requestedNs: requestedNs.toString(),
            spawnedNs: spawnedNs.toString(),
            firstOutputNs: firstOutputNs === null ? null : (firstOutputNs as bigint).toString(),
            exitedNs: process.hrtime.bigint().toString(),
          },
        });
      };

      child.on('error', (e) => { out += `\nspawn error: ${e.message}`; finish('INFRASTRUCTURE_FAILURE', null, null); });
      child.on('close', (code, signal) => {
        const job = this.live.get(req.id);
        if (job?.cancelled) return finish('CANCELLED', code, signal ?? null);
        // Cancellation from ANOTHER process. The signal shape is identical to
        // a scope stop — SIGTERM, no exit code — so without the intent the
        // rules below would classify an ordinary `zeus cancel` as a resource
        // event. Checked before the wall clock too: if a human cancelled it,
        // that is what happened, whatever else was also true.
        if (this.registryDir && pgid) {
          const marker = readCancelMarker(this.registryDir, req.id, pgid);
          if (marker) return finish('CANCELLED', code, signal ?? null);
        }
        if (timedOut) return finish('TIMEOUT', null, signal ?? null);
        // A cgroup kill, an OOM exit or the classic heap message are the
        // machine running out of room — never a verdict about the code.
        if (signal === 'SIGKILL' || code === 137 || code === 139) return finish('RESOURCE_LIMIT_EXCEEDED', code, signal ?? null);
        // Under a systemd scope, the whole tree being terminated is a resource
        // event by elimination. Cancellation and the wall clock are both
        // checked above, so if neither of those stopped it and the unit went
        // down as a unit, the actor left is the resource policy.
        //
        // Measured: the same 256 MB aggregate overrun was contained twice with
        // different signatures — SIGKILL when the kernel OOM killer fired
        // first, SIGTERM when systemd stopped the unit first. Classifying on
        // SIGKILL alone made containment look like a failing test roughly half
        // the time.
        //
        // A SIGNAL, and only a signal. An exit CODE is the program's own
        // statement, and `exit 143` is a number a test suite is free to
        // choose; a signal on our direct child is something done TO it. The
        // first version of this rule also matched `code === 143` and therefore
        // classified a project that exited 143 as a resource event — Zeus
        // refusing to believe a test result the test had stated plainly.
        //
        // Nothing is lost by dropping it: `OOMPolicy=kill` takes the whole
        // scope down together, so real containment kills our direct child too
        // and arrives as SIGKILL or SIGTERM with a null code. A 128+N exit code
        // with no signal means a shell SURVIVED to report a child's death,
        // which is not the tree being stopped. (`code === 137` above is a
        // different case and stays: it is the rlimit path's OOM signature,
        // where the kernel kills the runaway and its shell parent lives to
        // report it. Measured on all four backend combinations.)
        if (wrapped.backend === 'systemd-scope' && signal === 'SIGTERM') {
          return finish('RESOURCE_LIMIT_EXCEEDED', code, signal ?? null);
        }
        // Runtimes announce exhaustion in their own words and then die by a
        // signal that on its own means nothing. A probe against the rlimit
        // ceiling exited on SIGTRAP saying "Fatal process OOM in Failed to
        // reserve virtual memory" and was classified FAILED — Zeus blaming the
        // change for the machine running out of room. These are the specific
        // phrasings; the signal alone is never enough to conclude exhaustion.
        if (OUT_OF_MEMORY.test(out)) {
          return finish('RESOURCE_LIMIT_EXCEEDED', code, signal ?? null);
        }
        // The sandbox or the scope could not start the inner command:
        // infrastructure, not code.
        //
        // `Unit ... already exists` belongs here for the reason the whole
        // outcome vocabulary exists. A transient unit name that collides means
        // the command NEVER RAN — systemd refused to create the scope — and
        // reporting that as FAILED is Zeus telling a person their code is
        // broken because two runs picked the same name. Found when an
        // orphaned scope from an interrupted run made the next execution exit
        // 1 instantly, and it read as a failing test.
        if (/bwrap: execvp .*: No such file|systemd-run: .*not found|execvp: No such file/i.test(out)
          || /Unit .* already exists|Failed to (start|create) transient (scope|service)/i.test(out)) {
          return finish('INFRASTRUCTURE_FAILURE', code, signal ?? null);
        }
        finish(code === 0 ? 'COMPLETED' : 'FAILED', code, signal ?? null);
      });
    });
  }

  /** Kills one execution's whole tree, including its systemd scope. */
  kill(id: string, reason: string, markCancelled = false): boolean {
    const job = this.live.get(id);
    if (!job) return false;
    if (this.registryDir) removeRunRecord(this.registryDir, id);
    if (markCancelled) job.cancelled = true;
    if (job.unit) {
      spawnSync('systemctl', ['--user', 'stop', job.unit],
        { timeout: 10_000, env: { ...process.env, ...systemdUserEnv() } });
    }
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try { if (job.pgid > 1) process.kill(-job.pgid, sig); } catch { /* already gone */ }
    }
    void reason;
    return true;
  }

  /** Cancellation: every execution owned by one task. */
  killTask(taskId: string, reason: string): number {
    let n = 0;
    for (const [id, job] of [...this.live]) {
      if (job.taskId !== taskId) continue;
      if (this.kill(id, reason, true)) n += 1;
    }
    return n;
  }

  killProject(projectId: string, reason: string): number {
    let n = 0;
    for (const [id, job] of [...this.live]) {
      if (job.projectId !== projectId) continue;
      if (this.kill(id, reason, true)) n += 1;
    }
    return n;
  }

  shutdown(reason = 'shutdown'): number {
    let n = 0;
    for (const [id] of [...this.live]) { if (this.kill(id, reason, true)) n += 1; }
    return n;
  }

  snapshot() {
    return {
      budgets: this.budgets,
      backends: this.backends,
      running: Object.fromEntries([...this.running]),
      queued: Object.fromEntries([...this.queues].map(([k, v]) => [k, v.length])),
      maxObserved: Object.fromEntries([...this.maxObserved]),
      live: [...this.live.keys()],
    };
  }
}
