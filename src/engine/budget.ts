/**
 * Resource budgets, derived from the host rather than hard-coded.
 *
 * The numbers that mattered on an 8-core/32 GB box are wrong on a 2-core CI
 * runner and wasteful on a 64-core server. Everything here is computed from
 * what the machine actually has, with an explicit reservation for the control
 * plane: the orchestrator must keep answering while a task is misbehaving,
 * because an unreachable control plane cannot cancel the task that is eating
 * the machine.
 */

import * as fs from 'fs';
import * as os from 'os';

export interface HostResources {
  cpus: number;
  totalMemMb: number;
  availableMemMb: number;
  /** cgroup limits, when the process is itself containerised. */
  cgroupCpuLimit: number | null;
  cgroupMemLimitMb: number | null;
}

export interface Budgets {
  /** Left for the orchestrator, the API and the OS. Never handed to tasks. */
  reservedCpus: number;
  reservedMemMb: number;
  /** Everything tasks may share. */
  poolCpus: number;
  poolMemMb: number;
  /** Per execution. */
  maxTestWorkers: number;
  maxPlaywrightWorkers: number;
  memoryMaxMb: number;
  cpuQuotaPercent: number;
  maxProcesses: number;
  heavyTimeoutSeconds: number;
  lightTimeoutSeconds: number;
  /** How many heavy/light executions may run at once, across all projects. */
  globalHeavyConcurrency: number;
  globalLightConcurrency: number;
  derivedFrom: HostResources;
}

function readNum(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const n = Number(raw.split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Reads the cgroup v2 limits that apply to THIS process, if any. */
function cgroupLimits(): { cpu: number | null; memMb: number | null } {
  const memMax = readNum('/sys/fs/cgroup/memory.max');
  const cpuMaxRaw = (() => {
    try { return fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(); } catch { return ''; }
  })();
  let cpu: number | null = null;
  if (cpuMaxRaw && !cpuMaxRaw.startsWith('max')) {
    const [quota, period] = cpuMaxRaw.split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cpu = quota / period;
  }
  return { cpu, memMb: memMax ? Math.floor(memMax / 1024 / 1024) : null };
}

export function hostResources(): HostResources {
  const cg = cgroupLimits();
  return {
    cpus: os.cpus().length || 1,
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
    availableMemMb: Math.floor(os.freemem() / 1024 / 1024),
    cgroupCpuLimit: cg.cpu,
    cgroupMemLimitMb: cg.memMb,
  };
}

export interface BudgetOverrides {
  maxTestWorkers?: number;
  maxPlaywrightWorkers?: number;
  memoryMaxMb?: number;
  cpuQuotaPercent?: number;
  maxProcesses?: number;
  heavyTimeoutSeconds?: number;
  lightTimeoutSeconds?: number;
  globalHeavyConcurrency?: number;
  globalLightConcurrency?: number;
}

/**
 * Derives budgets from the host.
 *
 * Shape of the reasoning:
 *   effective cpus/memory  (respecting any cgroup we already live in)
 *     → reserve a slice for the control plane
 *     → the rest is the task pool
 *     → one execution gets a bounded share of that pool
 *
 * The reservation is proportional but never less than one CPU and 512 MB,
 * because a 2-core box still needs a responsive orchestrator.
 */
export function deriveBudgets(overrides: BudgetOverrides = {}, host = hostResources()): Budgets {
  const effCpus = Math.max(1, Math.floor(host.cgroupCpuLimit ?? host.cpus));
  const effMemMb = Math.max(512, host.cgroupMemLimitMb ?? host.totalMemMb);

  // Control-plane reservation: ~25% of CPU and memory, with floors.
  const reservedCpus = Math.max(1, Math.floor(effCpus * 0.25));
  const reservedMemMb = Math.max(512, Math.floor(effMemMb * 0.25));

  const poolCpus = Math.max(1, effCpus - reservedCpus);
  const poolMemMb = Math.max(512, effMemMb - reservedMemMb);

  // One execution may use at most half the pool, so a second task always fits.
  const perExecCpus = Math.max(1, Math.floor(poolCpus / 2));
  const perExecMemMb = Math.max(512, Math.floor(poolMemMb / 2));

  const heavyConc = Math.max(1, Math.min(2, Math.floor(poolCpus / 2)));
  const lightConc = Math.max(1, Math.min(4, poolCpus));

  return {
    reservedCpus, reservedMemMb, poolCpus, poolMemMb,
    maxTestWorkers: overrides.maxTestWorkers ?? Math.max(1, Math.min(4, perExecCpus)),
    maxPlaywrightWorkers: overrides.maxPlaywrightWorkers ?? Math.max(1, Math.min(2, Math.floor(perExecCpus / 2) || 1)),
    memoryMaxMb: overrides.memoryMaxMb ?? perExecMemMb,
    // CPUQuota is expressed per 100% = one core.
    cpuQuotaPercent: overrides.cpuQuotaPercent ?? perExecCpus * 100,
    // A task legitimately needs a shell, a runner and its workers — not 100.
    maxProcesses: overrides.maxProcesses ?? Math.max(64, perExecCpus * 32),
    heavyTimeoutSeconds: overrides.heavyTimeoutSeconds ?? 900,
    lightTimeoutSeconds: overrides.lightTimeoutSeconds ?? 300,
    globalHeavyConcurrency: overrides.globalHeavyConcurrency ?? heavyConc,
    globalLightConcurrency: overrides.globalLightConcurrency ?? lightConc,
    derivedFrom: host,
  };
}
