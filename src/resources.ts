/**
 * Resource governor.
 *
 * Two different failure modes have to be prevented, and a concurrency limit
 * only prevents the first:
 *
 *   A. several heavy tasks running at once;
 *   B. ONE task that spawns a hundred workers.
 *
 * (B) is what actually took the control plane down: five test suites, each
 * defaulting to one worker per core. So the controls here live outside the
 * model and outside the agent's command string — the agent cannot opt out of
 * them by writing a different command, because the caps are applied to the
 * environment and argv we spawn, and enforced again by a wall clock and a
 * process-group kill.
 *
 * Everything degrades safely: if cgroups and systemd-run are unavailable we
 * still get queueing, worker caps, timeouts and process-tree termination.
 */

import * as fs from 'fs';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';

export type JobClass = 'light' | 'heavy';

export interface GovernorLimits {
  /** Heavy jobs (integration/E2E suites) allowed to run at once, globally. */
  globalHeavyConcurrency: number;
  /** Light jobs (typecheck, lint, unit) allowed at once. */
  globalLightConcurrency: number;
  /** Worker cap handed to test runners, so one job cannot fan out per-core. */
  maxTestWorkers: number;
  maxPlaywrightWorkers: number;
  /** Wall clock per job. */
  heavyTimeoutSeconds: number;
  lightTimeoutSeconds: number;
  /** Optional per-job caps, applied only when the kernel supports them. */
  memoryMaxMb?: number;
  cpuQuotaPercent?: number;
}

export const DEFAULT_LIMITS: GovernorLimits = {
  globalHeavyConcurrency: 1,
  globalLightConcurrency: Math.max(1, Math.min(3, os.cpus().length - 1)),
  maxTestWorkers: 2,
  maxPlaywrightWorkers: 1,
  heavyTimeoutSeconds: 180,
  lightTimeoutSeconds: 120,
  memoryMaxMb: undefined,
  cpuQuotaPercent: undefined,
};

/** Why a job ended. Resource exhaustion is never reported as a code failure. */
export type JobOutcome =
  | 'COMPLETED'
  | 'FAILED'              // the command ran and returned non-zero: a product signal
  | 'TIMEOUT'             // wall clock exceeded — infrastructure, not code
  | 'CANCELLED'
  | 'RESOURCE_EXHAUSTED'  // OOM-killed or refused for lack of capacity
  | 'SPAWN_ERROR';

export interface JobResult {
  outcome: JobOutcome;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  queueWaitMs: number;
  durationMs: number;
  pid: number | null;
  pgid: number | null;
  isolation: 'systemd-run' | 'process-group';
  workersApplied: number | null;
  /** True only for outcomes that say something about the code under test. */
  productSignal: boolean;
}

export interface JobSpec {
  id: string;
  projectId: string;
  cls: JobClass;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface Capabilities { cgroup2: boolean; systemdRun: boolean }

export function detectCapabilities(): Capabilities {
  const cgroup2 = fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
  const systemdRun = spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8', timeout: 5_000 })
    .stdout.trim().length > 0;
  return { cgroup2, systemdRun };
}

/**
 * Worker caps, applied to the environment rather than trusted to the command.
 *
 * Jest, Vitest, Playwright, Go, Cargo and Maven all read a worker/parallelism
 * setting from the environment. Setting them here means a project's own
 * `npm test` script is bounded without rewriting it.
 */
export function workerEnv(limits: GovernorLimits): Record<string, string> {
  const w = String(Math.max(1, limits.maxTestWorkers));
  return {
    JEST_MAX_WORKERS: w,
    VITEST_MAX_THREADS: w,
    VITEST_MIN_THREADS: '1',
    PLAYWRIGHT_WORKERS: String(Math.max(1, limits.maxPlaywrightWorkers)),
    GOMAXPROCS: w,
    CARGO_BUILD_JOBS: w,
    MAVEN_OPTS: `-Dsurefire.forkCount=${w}`,
    // Node's own thread pool, which several runners inherit.
    UV_THREADPOOL_SIZE: w,
  };
}

/** Appends an explicit worker flag when we recognise the runner. */
/**
 * Same rule, same hole: matching a joined argv means matching payload text.
 * See the note on the copy in engine/exec.ts — a prompt mentioning playwright
 * appended --workers to a provider CLI and silently disabled the plan critic.
 */
const MAX_MATCHABLE_ARG = 256;

export function boundedArgs(command: string, args: string[], limits: GovernorLimits): string[] {
  const joined = `${command} ${args.filter((a) => a.length <= MAX_MATCHABLE_ARG).join(' ')}`;
  const w = Math.max(1, limits.maxTestWorkers);
  const has = (flag: string) => args.some((a) => a.startsWith(flag));
  if (/\bjest\b/.test(joined) && !has('--maxWorkers') && !has('-w')) return [...args, `--maxWorkers=${w}`];
  if (/\bvitest\b/.test(joined) && !has('--maxWorkers')) return [...args, `--maxWorkers=${w}`];
  if (/\bplaywright\b/.test(joined) && !has('--workers')) return [...args, `--workers=${Math.max(1, limits.maxPlaywrightWorkers)}`];
  if (/\bgo\b/.test(joined) && /\btest\b/.test(joined) && !has('-p')) return [...args, `-p=${w}`];
  return args;
}

interface Waiter { resolve: () => void; spec: JobSpec; queuedAt: number }

/**
 * Global scheduler. One per orchestrator process; jobs from every project queue
 * through it, because the resource being protected is the machine, not a
 * project.
 */
export class ResourceGovernor {
  private running = new Map<JobClass, number>([['light', 0], ['heavy', 0]]);
  private queues = new Map<JobClass, Waiter[]>([['light', []], ['heavy', []]]);
  private live = new Map<string, { pgid: number; unit: string | null; projectId: string }>();
  /** Jobs an operator killed, so their death is not misreported as a timeout. */
  private cancelled = new Set<string>();
  readonly capabilities: Capabilities;
  maxObserved = new Map<JobClass, number>([['light', 0], ['heavy', 0]]);

  constructor(readonly limits: GovernorLimits = DEFAULT_LIMITS, caps?: Capabilities) {
    this.capabilities = caps ?? detectCapabilities();
  }

  private cap(cls: JobClass): number {
    return cls === 'heavy' ? this.limits.globalHeavyConcurrency : this.limits.globalLightConcurrency;
  }

  queueDepth(cls: JobClass): number { return this.queues.get(cls)!.length; }
  activeCount(cls: JobClass): number { return this.running.get(cls)!; }

  private async acquire(spec: JobSpec, onQueued?: (depth: number) => void): Promise<number> {
    const cls = spec.cls;
    const queuedAt = Date.now();
    if (this.running.get(cls)! >= this.cap(cls)) {
      onQueued?.(this.queueDepth(cls) + 1);
      await new Promise<void>((resolve) => this.queues.get(cls)!.push({ resolve, spec, queuedAt }));
    }
    const n = this.running.get(cls)! + 1;
    this.running.set(cls, n);
    this.maxObserved.set(cls, Math.max(this.maxObserved.get(cls)!, n));
    return Date.now() - queuedAt;
  }

  private release(cls: JobClass): void {
    this.running.set(cls, Math.max(0, this.running.get(cls)! - 1));
    const next = this.queues.get(cls)!.shift();
    if (next) next.resolve();
  }

  /**
   * Runs one job under the governor. The command is spawned in its own process
   * group so the whole tree can be killed; when systemd-run is available the
   * job additionally gets a transient scope with memory/CPU caps.
   */
  async run(spec: JobSpec, onQueued?: (depth: number) => void): Promise<JobResult> {
    const timeoutMs = 1000 * (spec.timeoutSeconds
      ?? (spec.cls === 'heavy' ? this.limits.heavyTimeoutSeconds : this.limits.lightTimeoutSeconds));
    const queueWaitMs = await this.acquire(spec, onQueued);
    const startedAt = Date.now();

    let cmd = spec.command;
    let args = boundedArgs(spec.command, spec.args, this.limits);
    const workersApplied = this.limits.maxTestWorkers;
    let isolation: JobResult['isolation'] = 'process-group';
    let unit: string | null = null;

    // Kernel-level caps when the platform offers them; otherwise we still have
    // queueing, worker caps, a wall clock and a group kill.
    if (this.capabilities.systemdRun && this.capabilities.cgroup2
        && (this.limits.memoryMaxMb || this.limits.cpuQuotaPercent)) {
      unit = `zeus-${spec.projectId}-${spec.id}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
      const props: string[] = ['--user', '--scope', '--collect', `--unit=${unit}`, '--quiet'];
      if (this.limits.memoryMaxMb) props.push(`--property=MemoryMax=${this.limits.memoryMaxMb}M`);
      if (this.limits.cpuQuotaPercent) props.push(`--property=CPUQuota=${this.limits.cpuQuotaPercent}%`);
      args = [...props, cmd, ...args];
      cmd = 'systemd-run';
      isolation = 'systemd-run';
    }

    return await new Promise<JobResult>((resolve) => {
      let settled = false;
      const child = spawn(cmd, args, {
        cwd: spec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...workerEnv(this.limits), ...(spec.env ?? {}) },
      });
      const pgid = child.pid ?? 0;
      if (pgid) this.live.set(spec.id, { pgid, unit, projectId: spec.projectId });

      let out = '';
      const cap = (d: Buffer) => { if (out.length < 4 * 1024 * 1024) out += d.toString('utf8'); };
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);

      this.cancelled.delete(spec.id);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill(spec.id, 'wall-clock timeout');
      }, timeoutMs);

      const finish = (outcome: JobOutcome, exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill(spec.id, 'cleanup');           // belt and braces on every path
        this.live.delete(spec.id);
        this.release(spec.cls);
        resolve({
          outcome, exitCode, signal, stdout: out, queueWaitMs,
          durationMs: Date.now() - startedAt, pid: child.pid ?? null, pgid: pgid || null,
          isolation, workersApplied,
          // Only a real exit says anything about the code under test.
          productSignal: outcome === 'COMPLETED' || outcome === 'FAILED',
        });
      };

      child.on('error', (e) => { out += `\nspawn error: ${e.message}`; finish('SPAWN_ERROR', null, null); });
      child.on('close', (code, signal) => {
        if (this.cancelled.has(spec.id)) { this.cancelled.delete(spec.id); return finish('CANCELLED', code, signal ?? null); }
        if (timedOut) return finish('TIMEOUT', null, signal ?? null);
        // SIGKILL with no exit code, or a Linux OOM exit, is the machine
        // running out of room — not the code being wrong.
        if (signal === 'SIGKILL' || code === 137) return finish('RESOURCE_EXHAUSTED', code, signal ?? null);
        if (/JavaScript heap out of memory|Killed process|Cannot allocate memory/i.test(out)) {
          return finish('RESOURCE_EXHAUSTED', code, signal ?? null);
        }
        finish(code === 0 ? 'COMPLETED' : 'FAILED', code, signal ?? null);
      });
    });
  }

  /** Kills one job's whole process tree (and its scope, if it has one). */
  kill(jobId: string, reason: string): boolean {
    const rec = this.live.get(jobId);
    if (!rec) return false;
    if (rec.unit) spawnSync('systemctl', ['--user', 'stop', rec.unit], { timeout: 10_000 });
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try { if (rec.pgid > 1) process.kill(-rec.pgid, sig); } catch { /* already gone */ }
    }
    void reason;
    return true;
  }

  /**
   * Kills every job belonging to one project — used by cancellation.
   * Matches on the project recorded when the job started, never on the job id:
   * ids are opaque, and guessing at them killed nothing at all.
   */
  killProject(projectId: string, reason: string): number {
    let n = 0;
    for (const [id, rec] of [...this.live]) {
      if (rec.projectId !== projectId) continue;
      this.cancelled.add(id);
      if (this.kill(id, reason)) { this.live.delete(id); n += 1; }
    }
    return n;
  }

  /** Kills everything. Called on orchestrator shutdown. */
  shutdown(reason = 'shutdown'): number {
    let n = 0;
    for (const [id] of [...this.live]) { if (this.kill(id, reason)) { this.live.delete(id); n += 1; } }
    return n;
  }

  snapshot() {
    return {
      capabilities: this.capabilities,
      limits: this.limits,
      running: { light: this.activeCount('light'), heavy: this.activeCount('heavy') },
      queued: { light: this.queueDepth('light'), heavy: this.queueDepth('heavy') },
      maxObserved: { light: this.maxObserved.get('light'), heavy: this.maxObserved.get('heavy') },
      liveJobs: [...this.live.keys()],
    };
  }
}
