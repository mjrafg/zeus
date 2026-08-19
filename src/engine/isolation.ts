/**
 * Isolation backends.
 *
 * Ordered by how much they actually enforce, not by how modern they sound. The
 * selected backend is always reported honestly: claiming "sandboxed" while
 * running with nothing but a process group is worse than admitting the
 * fallback, because it invites the operator to trust something that is not true.
 */

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { ExecutionPolicy } from './policy';
import { Budgets } from './budget';

export type BackendId = 'systemd-scope' | 'bubblewrap' | 'process-group';

export interface BackendCapability {
  id: BackendId;
  available: boolean;
  detail: string;
  /** What this backend actually enforces, for doctor output. */
  enforces: string[];
}

export interface WrappedCommand {
  command: string;
  args: string[];
  backend: BackendId;
  /** True when the selected backend is weaker than the strongest requested. */
  fallback: boolean;
  enforced: string[];
  /** Name of the transient unit, when one is used, so it can be stopped. */
  unit: string | null;
}

function has(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5_000 }).stdout.trim().length > 0;
}

/** cgroup v2 with a delegated user hierarchy is what makes limits enforceable. */
function cgroup2Available(): boolean {
  return fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
}

function systemdUserAvailable(): boolean {
  if (!has('systemd-run')) return false;
  // A user manager must actually be running, or --user scopes fail at spawn.
  const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8', timeout: 8_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return r.status === 0 || /running|degraded|starting/.test(out);
}

function bubblewrapUsable(): { ok: boolean; detail: string } {
  if (!has('bwrap')) return { ok: false, detail: 'bwrap not installed' };
  const t = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--dev', '/dev', 'true'],
    { encoding: 'utf8', timeout: 10_000 });
  if (t.status === 0) return { ok: true, detail: 'user namespaces available' };
  const why = (t.stderr ?? '').trim().split('\n')[0] || 'unknown error';
  return { ok: false, detail: `present but unusable: ${why}` };
}

export function detectBackends(): BackendCapability[] {
  const cg = cgroup2Available();
  const sysd = systemdUserAvailable();
  const bw = bubblewrapUsable();
  return [
    {
      id: 'systemd-scope', available: sysd && cg,
      detail: sysd ? (cg ? 'systemd --user + cgroup v2' : 'systemd-run present but cgroup v2 missing')
                   : 'no systemd user manager',
      enforces: ['memory cap', 'cpu quota', 'process cap', 'cgroup kill of the whole tree'],
    },
    {
      id: 'bubblewrap', available: bw.ok, detail: bw.detail,
      enforces: ['filesystem confinement', 'read-only host', 'network namespace'],
    },
    {
      id: 'process-group', available: true, detail: 'always available',
      enforces: ['process-group termination'],
    },
  ];
}

export interface IsolationRequest {
  policy: ExecutionPolicy;
  budgets: Budgets;
  jobId: string;
  /** Ask for filesystem confinement in addition to resource caps. */
  confineFilesystem: boolean;
}

/**
 * Picks the strongest practical backend and wraps the command.
 *
 * systemd scopes give real resource enforcement (memory, CPU, PID caps) and a
 * cgroup kill that cannot leak children. bubblewrap gives filesystem and
 * network confinement. They compose — a scope can run bwrap — so when both are
 * available we use both.
 */
export function wrap(cmd: string, args: string[], req: IsolationRequest,
  backends = detectBackends()): WrappedCommand {
  const avail = new Map(backends.map((b) => [b.id, b]));
  const useScope = !!avail.get('systemd-scope')?.available;
  const useBwrap = req.confineFilesystem && !!avail.get('bubblewrap')?.available;

  let outCmd = cmd;
  let outArgs = [...args];
  const enforced: string[] = [];
  let unit: string | null = null;

  if (useBwrap) {
    // Read-only host, writable only where the policy says, private /tmp, and
    // no network unless the policy grants it.
    const bw: string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
    for (const w of req.policy.writablePaths) bw.push('--bind', w, w);
    if (!req.policy.network) bw.push('--unshare-net');
    bw.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', req.policy.worktreeRoot);
    outArgs = [...bw, '--', outCmd, ...outArgs];
    outCmd = 'bwrap';
    enforced.push('filesystem confinement', ...(req.policy.network ? [] : ['no network']));
  }

  if (useScope) {
    unit = `zeus-${req.jobId}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 90);
    const props = [
      '--user', '--scope', '--collect', '--quiet', `--unit=${unit}`,
      `--property=MemoryMax=${req.budgets.memoryMaxMb}M`,
      `--property=CPUQuota=${req.budgets.cpuQuotaPercent}%`,
      `--property=TasksMax=${req.budgets.maxProcesses}`,
      // Kill the whole cgroup, not just the leader, when the scope stops.
      '--property=KillMode=control-group',
    ];
    outArgs = [...props, outCmd, ...outArgs];
    outCmd = 'systemd-run';
    enforced.push('memory cap', 'cpu quota', 'process cap', 'cgroup tree kill');
  }

  const backend: BackendId = useScope ? 'systemd-scope' : useBwrap ? 'bubblewrap' : 'process-group';
  if (backend === 'process-group') enforced.push('process-group termination');

  return {
    command: outCmd, args: outArgs, backend,
    // Fallback means: we are weaker than the strongest thing this host offers.
    fallback: backend === 'process-group',
    enforced, unit,
  };
}

export interface IsolationReport {
  backends: BackendCapability[];
  selected: BackendId;
  fallbackMode: boolean;
  enforces: string[];
}

/** What `zeus doctor` prints. Never claims more than is enforced. */
export function report(backends = detectBackends()): IsolationReport {
  const scope = backends.find((b) => b.id === 'systemd-scope')!;
  const bw = backends.find((b) => b.id === 'bubblewrap')!;
  const selected: BackendId = scope.available ? 'systemd-scope' : bw.available ? 'bubblewrap' : 'process-group';
  const enforces = backends.filter((b) => b.available && b.id !== 'process-group').flatMap((b) => b.enforces);
  return {
    backends, selected,
    fallbackMode: selected === 'process-group',
    enforces: enforces.length ? [...new Set(enforces)] : ['process-group termination'],
  };
}
