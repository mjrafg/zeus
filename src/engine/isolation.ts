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

/** How resource ceilings are enforced for this execution, if at all. */
export type ResourceEnforcement = 'cgroup' | 'rlimit' | 'none';

export interface WrappedCommand {
  command: string;
  args: string[];
  backend: BackendId;
  /** True when the selected backend is weaker than the strongest requested. */
  fallback: boolean;
  enforced: string[];
  /** Name of the transient unit, when one is used, so it can be stopped. */
  unit: string | null;
  /**
   * How resource ceilings are actually enforced. Separate from `fallback`
   * because a run can be filesystem-confined and still have no memory
   * accounting, and one boolean hid that distinction.
   */
  resourceEnforcement: ResourceEnforcement;
  /**
   * Environment the WRAPPER needs, not the command. `systemd-run --user` talks
   * to a per-user bus and cannot find it without XDG_RUNTIME_DIR, which is
   * absent under `su`, cron and most service managers. This is Zeus's own
   * environment, so it is applied after the policy's allowlist rather than
   * through it.
   */
  env?: Record<string, string>;
}

function has(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5_000 }).stdout.trim().length > 0;
}

/** cgroup v2 with a delegated user hierarchy is what makes limits enforceable. */
function cgroup2Available(): boolean {
  return fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
}

/**
 * Where this user's systemd bus lives.
 *
 * pam_systemd exports XDG_RUNTIME_DIR for interactive logins and for nothing
 * else. Zeus is normally started by a service manager, a cron entry or `su`,
 * none of which set it — so a host with a perfectly good user manager reported
 * "no systemd" purely because of how the process was launched. Deriving the
 * path does not assume it works; the probe below still has to succeed.
 */
export function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return null;
  const guess = `/run/user/${uid}`;
  try { return fs.statSync(guess).isDirectory() ? guess : null; } catch { return null; }
}

/** The environment a `--user` systemd command needs to reach its own bus. */
export function systemdUserEnv(): Record<string, string> {
  const dir = userRuntimeDir();
  if (!dir) return {};
  return {
    XDG_RUNTIME_DIR: dir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${dir}/bus`,
  };
}

export interface ScopeProbe {
  ok: boolean;
  detail: string;
  /** Ceilings this host was OBSERVED to apply, read from inside a real scope. */
  enforces: string[];
}

/**
 * Whether a systemd user scope actually enforces anything here.
 *
 * The previous check asked whether a user manager was running and concluded
 * that memory, CPU and process caps were therefore in force. Those are
 * different questions: delegation can be partial, a controller can be absent
 * from the subtree, and a scope can be created successfully while enforcing
 * nothing at all.
 *
 * So this probe creates a real scope with real properties and has it read its
 * OWN cgroup files back. A ceiling is claimed only when the kernel was seen
 * holding it.
 */
function probeSystemdScope(): ScopeProbe {
  if (!has('systemd-run')) return { ok: false, detail: 'systemd-run not installed', enforces: [] };
  const env = systemdUserEnv();
  if (!env.XDG_RUNTIME_DIR) {
    return { ok: false, detail: 'no XDG_RUNTIME_DIR and no /run/user/<uid> — no user bus to reach', enforces: [] };
  }
  const MEM = 64 * 1024 * 1024;
  const TASKS = 32;
  const script = 'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); '
    + 'printf "MEM=%s PIDS=%s CPU=%s KILL=%s\n" '
    + '"$(cat $cg/memory.max 2>/dev/null)" "$(cat $cg/pids.max 2>/dev/null)" '
    + '"$(cat $cg/cpu.max 2>/dev/null)" "$(test -e $cg/cgroup.kill && echo yes || echo no)"';
  const r = spawnSync('systemd-run', [
    '--user', '--scope', '--quiet', '--collect',
    `--unit=zeus-probe-${process.pid}-${Date.now()}`,
    `--property=MemoryMax=${MEM}`, `--property=TasksMax=${TASKS}`, '--property=CPUQuota=50%',
    'sh', '-c', script,
  ], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env } });

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const why = out.trim().split('\n').filter(Boolean).pop() ?? `exit ${r.status}`;
    return { ok: false, detail: `user scope could not be created: ${why}`, enforces: [] };
  }
  const enforces: string[] = [];
  const memOk = new RegExp(`MEM=${MEM}\\b`).test(out);
  const pidsOk = new RegExp(`PIDS=${TASKS}\\b`).test(out);
  const cpuOk = /CPU=50000 \d+/.test(out);
  const killOk = /KILL=yes/.test(out);
  if (memOk) enforces.push('memory cap (cgroup)');
  if (cpuOk) enforces.push('cpu quota (cgroup)');
  if (pidsOk) enforces.push('process cap (cgroup)');
  if (killOk) enforces.push('cgroup kill of the whole tree');
  if (!memOk) {
    // A scope with no memory ceiling is the dangerous case: it looks like
    // containment and is not. Refuse the backend rather than advertise it.
    return {
      ok: false, enforces: [],
      detail: `scope created but MemoryMax was not applied (${out.trim().split('\n').pop()})`,
    };
  }
  return { ok: true, detail: `verified inside a live scope: ${enforces.join(', ')}`, enforces };
}

/**
 * Memoised: the probe spawns a process, and detection is called per supervisor
 * and by `doctor`. Capability does not change inside one process's lifetime.
 */
let scopeProbeCache: ScopeProbe | null = null;
export function systemdScopeProbe(force = false): ScopeProbe {
  if (force || !scopeProbeCache) scopeProbeCache = probeSystemdScope();
  return scopeProbeCache;
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
  const scope = cg ? systemdScopeProbe() : { ok: false, detail: 'cgroup v2 not mounted', enforces: [] };
  const bw = bubblewrapUsable();
  return [
    {
      id: 'systemd-scope', available: scope.ok,
      detail: scope.detail,
      // `enforces` is the list the probe OBSERVED the kernel holding, not the
      // list the mechanism supports. Availability means operational capability:
      // a backend that was never successfully probed advertises nothing, and a
      // scope that came up without a memory ceiling is not available at all.
      enforces: scope.enforces,
    },
    {
      id: 'bubblewrap', available: bw.ok, detail: bw.detail,
      // Deliberately does NOT list memory or cpu: bubblewrap has no resource
      // accounting at all. Saying otherwise is what let a runaway suite take
      // the host down while the report claimed the task was confined.
      enforces: bw.ok ? ['filesystem confinement', 'read-only host', 'network namespace'] : [],
    },
    {
      id: 'process-group', available: true, detail: 'always available',
      enforces: ['process-group termination'],
    },
  ];
}

/**
 * A last-resort resource ceiling that needs no cgroup.
 *
 * When systemd scopes are unavailable there is nothing bounding memory: this
 * host selects bubblewrap, which confines the filesystem and the network and
 * accounts for neither memory nor CPU. That is exactly how one suite consumed
 * the machine.
 *
 * `ulimit` is weaker than a cgroup and the difference is worth stating: it
 * bounds a process's ADDRESS SPACE rather than its resident set, and it applies
 * per process rather than to the tree as a whole. It stops the single runaway
 * allocation, which is the common case; it does not stop many processes
 * exhausting memory together.
 *
 * Only RLIMIT_AS is set. RLIMIT_NPROC (`ulimit -u`) is deliberately NOT used:
 * on Linux it counts every process belonging to the real UID, not the
 * descendants of this command, so capping it at the per-task process budget
 * would start failing forks for unrelated work on a busy host — causing the
 * class of outage this ceiling exists to prevent. Process-count capping needs a
 * cgroup, and where there is no cgroup Zeus says so rather than pretending.
 *
 * Arguments are passed positionally so nothing in a command line is ever
 * interpreted by the shell.
 */
export function rlimitWrap(cmd: string, args: string[], budgets: Budgets): { command: string; args: string[] } {
  const kb = Math.max(256 * 1024, budgets.memoryMaxMb * 1024);
  const script = `ulimit -v ${kb} 2>/dev/null || true; exec "$@"`;
  return { command: 'sh', args: ['-c', script, 'zeus-rlimit', cmd, ...args] };
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
  let scopeEnv: Record<string, string> = {};

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
      // When the kernel OOM-kills ANY member, take the whole tree down.
      //
      // Measured, not assumed: a six-process hog inside a 256 MB scope was
      // contained either way, but the default policy stops the unit with
      // SIGTERM and the leader exits 143 — indistinguishable from an ordinary
      // termination, which the supervisor would classify as a failing test.
      // With this policy the leader dies by SIGKILL (137), so containment is
      // reported as RESOURCE_LIMIT_EXCEEDED rather than blamed on the code.
      '--property=OOMPolicy=kill',
    ];
    outArgs = [...props, outCmd, ...outArgs];
    outCmd = 'systemd-run';
    // What the probe saw the kernel hold, not what the flags asked for.
    enforced.push(...(avail.get('systemd-scope')?.enforces ?? []));
    scopeEnv = systemdUserEnv();
  }

  // No cgroup means no memory ceiling, so apply the portable one. Outermost, so
  // it bounds the wrapper and everything it execs.
  let resourceEnforcement: ResourceEnforcement = 'cgroup';
  if (!useScope) {
    const limited = rlimitWrap(outCmd, outArgs, req.budgets);
    outCmd = limited.command;
    outArgs = limited.args;
    resourceEnforcement = 'rlimit';
    enforced.push('address-space cap (rlimit)');
  }

  const backend: BackendId = useScope ? 'systemd-scope' : useBwrap ? 'bubblewrap' : 'process-group';
  if (backend === 'process-group') enforced.push('process-group termination');

  return {
    command: outCmd, args: outArgs, backend, env: scopeEnv,
    // Fallback means: weaker than the strongest thing this host offers.
    fallback: backend === 'process-group',
    // Reported separately, because a run can be filesystem-confined and still
    // have no cgroup accounting — bubblewrap is precisely that case, and
    // collapsing the two into one boolean is what made the weaker mode invisible.
    resourceEnforcement,
    enforced, unit,
  };
}

export interface IsolationReport {
  backends: BackendCapability[];
  selected: BackendId;
  fallbackMode: boolean;
  /** How memory and CPU ceilings are actually applied on this host. */
  resourceEnforcement: ResourceEnforcement;
  /** Plain-language statement of what that does and does not cover. */
  resourceDetail: string;
  enforces: string[];
}

/** What `zeus doctor` prints. Never claims more than is enforced. */
export function report(backends = detectBackends()): IsolationReport {
  const scope = backends.find((b) => b.id === 'systemd-scope')!;
  const bw = backends.find((b) => b.id === 'bubblewrap')!;
  const selected: BackendId = scope.available ? 'systemd-scope' : bw.available ? 'bubblewrap' : 'process-group';
  const enforces = backends.filter((b) => b.available && b.id !== 'process-group').flatMap((b) => b.enforces);

  // Resource ceilings come from the cgroup when there is one and from rlimits
  // when there is not. Reported separately from filesystem confinement, because
  // this host has the second and not the first, and a single "isolated: yes"
  // read as though it had both.
  const resourceEnforcement: ResourceEnforcement = scope.available ? 'cgroup' : 'rlimit';
  const resourceDetail = scope.available
    ? 'cgroup v2 via a transient systemd scope: memory, CPU and PID ceilings on the whole tree, killed as a unit'
    : 'no cgroup available, so the only ceiling is a per-process address-space rlimit. '
      + 'It bounds a single runaway allocation, not many processes exhausting memory together, '
      + 'and it caps address space rather than resident set. Process-count capping needs a cgroup '
      + 'and is NOT in force here.';

  return {
    backends, selected,
    fallbackMode: selected === 'process-group',
    resourceEnforcement,
    resourceDetail,
    enforces: [
      ...(enforces.length ? [...new Set(enforces)] : ['process-group termination']),
      ...(scope.available ? [] : ['address-space cap (rlimit)']),
    ],
  };
}
