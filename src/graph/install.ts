/**
 * Zeus provisioning graphify, because a required dependency the user has to go
 * and find is not a required dependency — it is a footnote.
 *
 * The distribution is `graphifyy`; the command it installs is `graphify`. That
 * asymmetry is the single most likely way an install attempt fails silently,
 * so it is named in one place and used from there.
 *
 * A VENV, not a system pip install. Debian's python3 refuses `pip install`
 * into the system environment (PEP 668, externally-managed-environment), and
 * --break-system-packages is exactly the thing its name says. Zeus owns a
 * directory, installs into it, and links the one command it needs — graphify
 * belongs to Zeus's infrastructure, not to the user's application dependencies
 * and not to their operating system.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { GRAPHIFY_DIST, GRAPHIFY_MIN, health, atLeast, type Health } from './graphify';

export interface InstallOutcome {
  ok: boolean;
  action: 'already-present' | 'installed' | 'upgraded' | 'failed' | 'skipped';
  version: string | null;
  bin: string | null;
  detail: string;
}

export function venvDir(home = process.env.HOME ?? ''): string {
  return path.join(home, '.local', 'graphify-venv');
}
export function linkPath(home = process.env.HOME ?? ''): string {
  return path.join(home, '.local', 'bin', 'graphify');
}

function run(cmd: string, args: string[], timeout = 900_000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? String(r.error?.message ?? ''), code: r.status };
}

/**
 * Ensures a working graphify, and proves it by running it.
 *
 * A compatible one already on PATH is REUSED — reinstalling over a working
 * tool to satisfy a checkbox is how a setup step becomes something people skip.
 */
export function ensureInstalled(opts: {
  home?: string; python?: string; allowInstall?: boolean;
} = {}): InstallOutcome {
  const before: Health = health();
  if (before.ok) {
    return { ok: true, action: 'already-present', version: before.version,
      bin: before.bin, detail: `graphify ${before.version} is already installed` };
  }
  if (opts.allowInstall === false) {
    return { ok: false, action: 'skipped', version: before.version, bin: before.bin,
      detail: before.detail };
  }

  const home = opts.home ?? process.env.HOME ?? '';
  const venv = venvDir(home);
  const py = opts.python ?? 'python3';
  const upgrading = before.fault === 'GRAPHIFY_VERSION_INCOMPATIBLE';

  if (!fs.existsSync(path.join(venv, 'bin', 'pip'))) {
    const v = run(py, ['-m', 'venv', venv], 300_000);
    if (!v.ok) {
      return { ok: false, action: 'failed', version: null, bin: null,
        detail: `could not create a virtualenv at ${venv}: ${(v.err || v.out).slice(0, 200)}` };
    }
  }
  const pip = path.join(venv, 'bin', 'pip');
  const i = run(pip, ['install', '--quiet', '--upgrade', GRAPHIFY_DIST]);
  if (!i.ok) {
    return { ok: false, action: 'failed', version: null, bin: null,
      detail: `pip install ${GRAPHIFY_DIST} failed: ${(i.err || i.out).slice(0, 300)}` };
  }

  const installed = path.join(venv, 'bin', 'graphify');
  if (!fs.existsSync(installed)) {
    return { ok: false, action: 'failed', version: null, bin: null,
      detail: `${GRAPHIFY_DIST} installed but provided no \`graphify\` command at ${installed}` };
  }
  try {
    fs.mkdirSync(path.dirname(linkPath(home)), { recursive: true });
    fs.rmSync(linkPath(home), { force: true });
    fs.symlinkSync(installed, linkPath(home));
  } catch { /* the venv path still works; PATH is a convenience */ }

  // Proven by RUNNING it. A file existing where a file was expected is not
  // health, and reporting Ready on that basis is how an operator finds out
  // during a mission instead of during setup.
  const after = health(installed);
  if (!after.ok) {
    return { ok: false, action: 'failed', version: after.version, bin: installed,
      detail: `installed, but it does not work: ${after.detail}` };
  }
  if (!atLeast(after.version!, GRAPHIFY_MIN)) {
    return { ok: false, action: 'failed', version: after.version, bin: installed,
      detail: `installed graphify ${after.version}, which is older than ${GRAPHIFY_MIN}` };
  }
  return { ok: true, action: upgrading ? 'upgraded' : 'installed',
    version: after.version, bin: installed,
    detail: `graphify ${after.version} installed at ${installed}` };
}
