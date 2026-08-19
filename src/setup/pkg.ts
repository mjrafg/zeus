/**
 * System package installation — always with consent, never silently.
 *
 * The installer knows how to ask a package manager for a package, and it will
 * happily print the exact command; what it will not do is run `sudo` because
 * it decided that was convenient. Every privileged action is shown in full and
 * executed only after an explicit yes.
 */

import { SystemProbe } from './probe';

export interface PackageManager {
  id: 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'brew';
  bin: string;
  /** Argv for installing packages, excluding the package names. */
  installArgs: string[];
  /** brew must not run under sudo; the rest need root. */
  needsRoot: boolean;
}

const MANAGERS: PackageManager[] = [
  { id: 'apt', bin: 'apt-get', installArgs: ['install', '-y'], needsRoot: true },
  { id: 'dnf', bin: 'dnf', installArgs: ['install', '-y'], needsRoot: true },
  { id: 'yum', bin: 'yum', installArgs: ['install', '-y'], needsRoot: true },
  { id: 'pacman', bin: 'pacman', installArgs: ['-S', '--noconfirm'], needsRoot: true },
  { id: 'zypper', bin: 'zypper', installArgs: ['install', '-y'], needsRoot: true },
  { id: 'apk', bin: 'apk', installArgs: ['add'], needsRoot: true },
  { id: 'brew', bin: 'brew', installArgs: ['install'], needsRoot: false },
];

export function detectPackageManager(probe: SystemProbe): PackageManager | null {
  for (const m of MANAGERS) if (probe.which(m.bin)) return m;
  return null;
}

export interface PrivilegeContext {
  isRoot: boolean;
  sudoAvailable: boolean;
  /** True when sudo will not prompt (cached or NOPASSWD). Informational only. */
  sudoNonInteractive: boolean;
}

export function privileges(probe: SystemProbe): PrivilegeContext {
  const isRoot = probe.user() === 'root';
  const sudoAvailable = !!probe.which('sudo');
  let sudoNonInteractive = false;
  if (!isRoot && sudoAvailable) {
    const r = probe.run('sudo', ['-n', 'true'], { timeoutMs: 10_000 });
    sudoNonInteractive = r.code === 0;
  }
  return { isRoot, sudoAvailable, sudoNonInteractive };
}

/** The exact command line a user would type. Shown before anything runs. */
export function installCommand(pm: PackageManager, packages: string[], priv: PrivilegeContext):
  { argv: string[]; display: string; requiresSudo: boolean } {
  const base = [pm.bin, ...pm.installArgs, ...packages];
  const requiresSudo = pm.needsRoot && !priv.isRoot;
  const argv = requiresSudo ? ['sudo', ...base] : base;
  return { argv, display: argv.join(' '), requiresSudo };
}

export type InstallCode =
  | 'INSTALLED' | 'DEPENDENCY_INSTALL_FAILED' | 'PERMISSION_REQUIRED' | 'NO_PACKAGE_MANAGER';

export interface InstallOutcome {
  code: InstallCode;
  command: string;
  detail: string;
  /** What the user should run themselves when we could not. */
  manualCommand?: string;
}

/**
 * Installs system packages after consent has already been obtained.
 *
 * When privilege is unavailable this returns PERMISSION_REQUIRED with the exact
 * command to run by hand — a setup wizard that cannot elevate should say so and
 * carry on, not fail the whole run.
 */
export function installSystemPackages(probe: SystemProbe, packages: string[]): InstallOutcome {
  const pm = detectPackageManager(probe);
  if (!pm) {
    return { code: 'NO_PACKAGE_MANAGER', command: '', detail: 'no supported package manager found',
      manualCommand: `install manually: ${packages.join(' ')}` };
  }
  const priv = privileges(probe);
  const cmd = installCommand(pm, packages, priv);
  if (cmd.requiresSudo && !priv.sudoAvailable) {
    return { code: 'PERMISSION_REQUIRED', command: cmd.display,
      detail: 'root privileges are required and sudo is not available',
      manualCommand: cmd.display };
  }
  const r = probe.run(cmd.argv[0], cmd.argv.slice(1), { timeoutMs: 10 * 60_000 });
  if (r.code === 0) return { code: 'INSTALLED', command: cmd.display, detail: 'installed' };
  const why = `${r.stderr || r.stdout}`.trim().split('\n').slice(-2).join(' ').slice(0, 200);
  // A sudo password prompt in a non-interactive context looks like a failure;
  // saying so precisely is more useful than "install failed".
  const permission = /password is required|a terminal is required|not in the sudoers/i.test(why);
  return {
    code: permission ? 'PERMISSION_REQUIRED' : 'DEPENDENCY_INSTALL_FAILED',
    command: cmd.display, detail: why || `exit ${r.code}`, manualCommand: cmd.display,
  };
}

/**
 * Installs an npm package into the USER prefix.
 *
 * Never `sudo npm install -g`: running a package manager's arbitrary install
 * scripts as root is exactly the pattern this wizard exists to avoid. If the
 * global prefix is not writable we reconfigure the user's own prefix instead
 * and tell them what changed.
 */
export function installNpmGlobal(probe: SystemProbe, pkg: string):
  InstallOutcome & { prefixChanged?: string } {
  const display = `npm install -g ${pkg}`;
  let r = probe.run('npm', ['install', '-g', pkg], { timeoutMs: 10 * 60_000 });
  if (r.code === 0) return { code: 'INSTALLED', command: display, detail: 'installed' };

  const err = `${r.stderr}${r.stdout}`;
  const permissionProblem = /EACCES|permission denied|EPERM/i.test(err);
  if (!permissionProblem) {
    return { code: 'DEPENDENCY_INSTALL_FAILED', command: display,
      detail: err.trim().split('\n').slice(-2).join(' ').slice(0, 200), manualCommand: display };
  }
  // Fall back to a user-owned prefix rather than escalating.
  const prefix = `${probe.homedir()}/.local`;
  const setPrefix = probe.run('npm', ['config', 'set', 'prefix', prefix], { timeoutMs: 60_000 });
  if (setPrefix.code !== 0) {
    return { code: 'PERMISSION_REQUIRED', command: display,
      detail: 'the global npm prefix is not writable and could not be redirected',
      manualCommand: `npm config set prefix "${prefix}" && ${display}` };
  }
  r = probe.run('npm', ['install', '-g', pkg], { timeoutMs: 10 * 60_000 });
  if (r.code === 0) {
    return { code: 'INSTALLED', command: `npm config set prefix ${prefix} && ${display}`,
      detail: `installed into ${prefix}`, prefixChanged: prefix };
  }
  return { code: 'DEPENDENCY_INSTALL_FAILED', command: display,
    detail: `${r.stderr}`.trim().slice(0, 200), manualCommand: display };
}
