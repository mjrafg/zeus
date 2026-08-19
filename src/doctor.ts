/**
 * Capability detection.
 *
 * `zeus doctor` answers one question honestly: what can this machine
 * actually do right now? Every probe is read-only and bounded, and a missing
 * optional capability is reported as a degraded mode rather than an error —
 * the engine is designed to keep working without Graphify, without systemd and
 * without cgroups.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { RealProbe } from './setup/probe';
import { PROVIDERS, ProviderId, providerStatus, RoleAssignment, DEFAULT_ROLES, roleOf } from './setup/providers';

export type Level = 'ok' | 'warn' | 'missing';

export interface Capability {
  id: string;
  label: string;
  level: Level;
  detail: string;
  /** A required capability failing means `run` cannot work at all. */
  required: boolean;
  remedy?: string;
  /** Structured provider facts, so the report is not just prose. */
  provider?: {
    installed: boolean;
    version: string | null;
    authenticated: boolean;
    authMethod: string | null;
    role: 'developer' | 'reviewer' | 'unused';
  };
}

function which(bin: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8', timeout: 5_000 });
  const out = (r.stdout ?? '').trim();
  return out || null;
}

function version(bin: string, args: string[] = ['--version']): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 });
  return ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n')[0] ?? '';
}

export function probe(roles: RoleAssignment = DEFAULT_ROLES): Capability[] {
  const caps: Capability[] = [];
  const add = (c: Capability) => caps.push(c);

  const node = process.version;
  const major = Number(node.replace(/^v/, '').split('.')[0]);
  add({ id: 'node', label: 'Node.js', required: true,
    level: major >= 18 ? 'ok' : 'missing',
    detail: `${node}${major >= 18 ? '' : ' (18+ required)'}`,
    remedy: major >= 18 ? undefined : 'Install Node.js 18 or newer.' });

  const git = which('git');
  add({ id: 'git', label: 'Git', required: true, level: git ? 'ok' : 'missing',
    detail: git ? version('git') : 'not found', remedy: git ? undefined : 'Install git.' });

  // Providers. Absence is actionable, not fatal at init time.
  //
  // Auth is read from each vendor's own status command rather than guessed
  // from the presence of a dotfile: a stale ~/.claude directory is not a
  // session, and reporting it as one is how a "ready" machine fails on the
  // first real task.
  const sp = new RealProbe();
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const spec = PROVIDERS[id];
    const st = providerStatus(sp, id);
    const role = roleOf(roles, id);
    const used = role !== 'none';
    const authed = st.auth === 'AUTHENTICATED';
    const level: Level = !st.installed
      ? (used ? 'missing' : 'warn')
      : authed ? 'ok' : (used ? 'missing' : 'warn');
    add({
      id, label: spec.label, required: false, level,
      detail: [
        `installed: ${st.installed ? 'yes' : 'no'}`,
        st.version ? `version: ${st.version}` : 'version: unknown',
        `authenticated: ${authed ? 'yes' : 'no'}${st.authMethod ? ` (${st.authMethod})` : ''}`,
        `role: ${used ? role : 'unused'}`,
      ].join(' · '),
      remedy: !st.installed
        ? `npm install -g ${spec.npmPackage}   (or: zeus setup providers)`
        : authed ? undefined
          : `${spec.bin} ${spec.loginArgs.join(' ')}   (or: zeus setup providers)`,
      provider: {
        installed: st.installed, version: st.version, authenticated: authed,
        authMethod: st.authMethod, role: used ? (role as 'developer' | 'reviewer') : 'unused',
      },
    });
  }

  const graphify = process.env.ZEUS_GRAPHIFY_BIN || which('graphify');
  add({ id: 'graphify', label: 'Graphify (optional)', required: false,
    level: graphify ? 'ok' : 'warn',
    detail: graphify ? version(graphify) : 'not found — structural navigation disabled, source review unaffected',
    remedy: graphify ? undefined : 'Optional: pip install graphifyy in a venv for structural navigation.' });

  // Sandboxing for the reviewer.
  const bwrap = which('bwrap');
  let bwrapLevel: Level = bwrap ? 'ok' : 'warn';
  let bwrapDetail = bwrap ? 'available' : 'not found — Codex sandboxing may be unavailable';
  if (bwrap) {
    const t = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', 'true'],
      { encoding: 'utf8', timeout: 10_000 });
    if (t.status !== 0) {
      bwrapLevel = 'warn';
      bwrapDetail = `present but cannot create a user namespace: ${((t.stderr ?? '').trim().split('\n')[0] || 'unknown')}`;
    }
  }
  add({ id: 'bwrap', label: 'bubblewrap sandbox', required: false, level: bwrapLevel, detail: bwrapDetail,
    remedy: bwrapLevel === 'ok' ? undefined
      : 'On Ubuntu 24.04 unprivileged user namespaces are restricted; allow them for /usr/bin/bwrap via AppArmor.' });

  // Resource governance capabilities.
  const cgroup2 = fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
  add({ id: 'cgroup2', label: 'cgroup v2 (resource limits)', required: false,
    level: cgroup2 ? 'ok' : 'warn',
    detail: cgroup2 ? 'available' : 'not available — falling back to process-group limits only',
    remedy: cgroup2 ? undefined : 'Optional: cgroup v2 lets Zeus cap CPU/memory per task.' });
  const systemdRun = which('systemd-run');
  add({ id: 'systemd-run', label: 'systemd-run (isolation)', required: false,
    level: systemdRun ? 'ok' : 'warn',
    detail: systemdRun ? 'available' : 'not available — tasks run as plain process groups' });

  add({ id: 'cpu', label: 'CPU / memory', required: false, level: 'ok',
    detail: `${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, load ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}` });

  // Paid keys must not be present: billing is subscription-CLI only.
  const paid = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => (process.env[k] ?? '').trim());
  add({ id: 'billing', label: 'Billing mode', required: false,
    level: paid.length ? 'warn' : 'ok',
    detail: paid.length ? `paid API key(s) present in the environment: ${paid.join(', ')}` : 'subscription CLI only (no paid API keys)',
    remedy: paid.length ? 'Zeus never uses paid API fallback; unset these to avoid accidental spend by other tools.' : undefined });

  return caps;
}

export function summarize(caps: Capability[]): { ok: boolean; blocking: Capability[] } {
  const blocking = caps.filter((c) => c.required && c.level === 'missing');
  return { ok: blocking.length === 0, blocking };
}
