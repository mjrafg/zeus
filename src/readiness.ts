/**
 * Whether a MISSION could actually run on THIS project, right now.
 *
 * `zeus doctor` answered a different question — what can this machine do in
 * general — and answered it honestly. That was not enough. On one real project
 * doctor reported healthy and the first mission died in under a minute because
 * the host had no `pnpm` and the project is a pnpm workspace: dependency
 * preparation could never have run. Nothing had checked what THIS project's
 * mission path needs.
 *
 * That is the third time the same shape has cost something: a provider
 * reported "authenticated" while every call returned 401, isolation reported
 * capabilities from configuration rather than probes, and now project health
 * without project-toolchain probes. The rule those three produced is the rule
 * here — NEVER REPORT HEALTH THAT WAS NOT PROBED.
 *
 * So every check below performs the operation. The package manager is executed,
 * not looked up. Command executables are resolved through the same function the
 * supervisor uses, against the same environment it would build. Hardlink
 * support is established by making a link. Nothing here installs, fetches or
 * writes: probing is read-only, and offering to install remains setup's job.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ProjectConfig } from './config';
import { nodePackageManager } from './adapters';
import { buildEnv, defaultPolicy } from './engine/policy';
import { resolveExecutable } from './engine/exec';
import { PrepMethod, describeDependencyState, splitCommand } from './engine/dependencies';

export type ProbeStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED';

export interface ReadinessProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  /** A required probe that FAILs makes the whole verdict not-ready. */
  required: boolean;
  detail: string;
  /** Never empty when SKIPPED: an unexplained skip is an unanswered question. */
  reason?: string;
  remedy?: string;
  /** Typed facts, so the report is not prose that a reader has to parse. */
  facts?: Record<string, unknown>;
}

export interface ReadinessReport {
  ok: boolean;
  probes: ReadinessProbe[];
  /** The method a mission WOULD use, or null when nothing needs preparing. */
  wouldPrepareVia: PrepMethod | null;
  /** The commands a mission would have to be able to run. */
  floor: string[];
  /** Floor commands this project never declared. Not a failure; a narrowing. */
  undeclaredFloor: string[];
  /**
   * The contract line. If this reads green, a mission must not die on any of
   * the preconditions probed above.
   */
  summary: string;
}

/**
 * The commands whose absence stops a mission rather than degrading it.
 *
 * A mission proves criteria by running checks. Without a typecheck and a unit
 * test there is nothing to prove anything with, so an unresolvable one is a
 * refusal. Everything else is a narrower mission, not an impossible one.
 */
export const REQUIRED_FLOOR = ['typecheck', 'unitTest'] as const;

const OPTIONAL_COMMANDS = ['install', 'build', 'lint', 'integrationTest'] as const;

/** Runs a binary purely to see whether it runs. Bounded, read-only, no shell. */
function executes(bin: string, args: string[], timeoutMs = 20_000):
  { ok: boolean; output: string; detail: string } {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error) return { ok: false, output, detail: (r.error as Error).message };
    if (r.signal) return { ok: false, output, detail: `killed by ${r.signal}` };
    if (r.status !== 0) return { ok: false, output, detail: `exited ${r.status}` };
    return { ok: true, output, detail: output.split('\n')[0] ?? '' };
  } catch (e: any) {
    return { ok: false, output: '', detail: e?.message ?? String(e) };
  }
}

/** The environment the supervisor would build for a project command. */
export function supervisorEnv(root: string): Record<string, string> {
  return buildEnv(defaultPolicy(root, root));
}

/**
 * Probe 1 — the package manager exists AND runs.
 *
 * Existing on PATH is not the question. A corepack shim is a real file at a
 * real path that may still fail to execute, because it resolves and downloads
 * its manager on first use and that can fail offline, behind a proxy, or with
 * no writable cache. "A shim is present" is an assumption; "the shim printed a
 * version" is a probe result, and only the second is worth reporting.
 */
export function probePackageManager(root: string, env: Record<string, string>): ReadinessProbe {
  const isNode = fs.existsSync(path.join(root, 'package.json'));
  if (!isNode) {
    return {
      id: 'package-manager', label: 'Package manager', required: false, status: 'SKIPPED',
      detail: 'no package.json, so no node package manager is involved',
      reason: 'not a node project',
    };
  }
  const pm = nodePackageManager(root);
  const resolved = resolveExecutable(pm, env);
  if (!resolved.ok) {
    return {
      id: 'package-manager', label: 'Package manager', required: true, status: 'FAIL',
      detail: `${pm} is the package manager this project's lockfile names, and it is not on PATH`,
      remedy: `Install ${pm}, or enable it through corepack, on the host Zeus runs on.`,
      facts: { manager: pm, resolvedPath: null, version: null, executes: false },
    };
  }
  // The resolved PATH, not the bare name: `spawnSync('pnpm', …)` would search
  // the ambient environment and could answer about a different file than the
  // one this probe just located.
  const run = executes(resolved.detail, ['--version']);
  if (!run.ok || !run.output) {
    return {
      id: 'package-manager', label: 'Package manager', required: true, status: 'FAIL',
      // The distinction is the whole point: a present-but-non-executing shim
      // reads as installed to anything that only looks at PATH.
      detail: `${pm} is present at ${resolved.detail} but did not execute: ${run.detail || 'it printed no version'}`
        + ' — a shim that resolves its manager on first use is not the same as an installed manager',
      remedy: `Run \`${pm} --version\` on the host and fix what it reports.`,
      facts: { manager: pm, resolvedPath: resolved.detail, version: null, executes: false },
    };
  }
  return {
    id: 'package-manager', label: 'Package manager', required: true, status: 'PASS',
    detail: `${pm} ${run.output.split('\n')[0]} at ${resolved.detail}`,
    facts: { manager: pm, resolvedPath: resolved.detail, version: run.output.split('\n')[0], executes: true },
  };
}

/**
 * Probe 2 — every declared command's executable resolves.
 *
 * Through `resolveExecutable`, against `supervisorEnv`, because a command that
 * resolves in the operator's shell and not in the supervisor's environment is
 * exactly the failure this exists to catch.
 */
export function probeCommands(cfg: ProjectConfig, env: Record<string, string>): ReadinessProbe[] {
  const commands = (cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>;
  const names = [...REQUIRED_FLOOR, ...OPTIONAL_COMMANDS];
  const out: ReadinessProbe[] = [];
  for (const name of names) {
    const required = (REQUIRED_FLOOR as readonly string[]).includes(name);
    const line = commands[name];
    if (!line) {
      out.push({
        id: `command:${name}`, label: `Command ${name}`, required, status: 'SKIPPED',
        detail: `${name} is not declared for this project`,
        reason: 'not declared',
        facts: { command: null },
      });
      continue;
    }
    const argv = splitCommand(line);
    const exe = argv[0] ?? '';
    const resolved = resolveExecutable(exe, env);
    if (resolved.ok) {
      out.push({
        id: `command:${name}`, label: `Command ${name}`, required, status: 'PASS',
        detail: `${line} → ${resolved.detail}`,
        facts: { command: line, executable: exe, resolvedPath: resolved.detail },
      });
      continue;
    }
    // Same wording either way. A missing optional tool is not a smaller truth
    // than a missing required one; it is the same fact with a smaller
    // consequence, and dressing it differently would hide the fact.
    out.push({
      id: `command:${name}`, label: `Command ${name}`, required,
      status: required ? 'FAIL' : 'WARN',
      detail: `${line} — ${resolved.detail}`,
      remedy: `Install ${exe}, or correct commands.${name} in .zeus/config.yaml.`,
      facts: { command: line, executable: exe, resolvedPath: null },
    });
  }
  return out;
}

/**
 * Probe 3 — preparation could run, without running any of it.
 *
 * Reuses `describeDependencyState`, which is the same read-only planner the
 * engine's `zeus deps` reporting uses and which predicts the method by the same
 * order `materialize()` actually tries. Predicting a method the engine would
 * not choose is worse than predicting nothing.
 */
export function probePreparation(root: string, cfg: ProjectConfig, env: Record<string, string>):
  { probe: ReadinessProbe; wouldUse: PrepMethod | null } {
  const install = (cfg.commands?.install ?? null) as string | null;
  let state: ReturnType<typeof describeDependencyState>;
  try {
    state = describeDependencyState(root, install);
  } catch (e: any) {
    return {
      wouldUse: null,
      probe: {
        id: 'preparation', label: 'Dependency preparation', required: true, status: 'FAIL',
        detail: `the preparation plan could not be computed: ${e?.message ?? e}`,
      },
    };
  }

  if (state.ecosystem === 'none') {
    return {
      wouldUse: 'none',
      probe: {
        id: 'preparation', label: 'Dependency preparation', required: false, status: 'SKIPPED',
        detail: state.detail, reason: 'nothing to prepare',
        facts: { ecosystem: state.ecosystem, wouldUse: 'none' },
      },
    };
  }

  const problems: string[] = [];

  // The lockfile has to be readable, and its hash has to be computable —
  // that hash IS the cache key, so an unreadable lockfile is not a slow
  // preparation but an impossible one.
  if (state.lockfile) {
    const lockPath = path.join(root, state.lockfile);
    try { fs.accessSync(lockPath, fs.constants.R_OK); }
    catch { problems.push(`${state.lockfile} is present but not readable`); }
    if (!state.lockfileHash) problems.push(`${state.lockfile} could not be hashed`);
  }

  // Writability is asked of the nearest directory that EXISTS. Creating the
  // cache root to find out whether it can be created would be a write, and
  // doctor does not write.
  const cacheRoot = describeCacheRoot(root, state.cacheDir);
  if (cacheRoot.writable === false) problems.push(`the dependency cache root is not writable (${cacheRoot.probed})`);

  // The chosen method's mechanism has to exist. pnpm-store needs pnpm to run;
  // hardlink support was already established by making a link inside
  // describeDependencyState.
  if (state.wouldUse === 'pnpm-store' || (state.packageManager === 'pnpm' && state.wouldUse === 'install')) {
    const pm = resolveExecutable('pnpm', env);
    if (!pm.ok) problems.push('pnpm is required to prepare this workspace and is not on PATH');
  }

  if (problems.length) {
    return {
      wouldUse: state.wouldUse,
      probe: {
        id: 'preparation', label: 'Dependency preparation', required: true, status: 'FAIL',
        detail: problems.join('; '),
        facts: { ecosystem: state.ecosystem, packageManager: state.packageManager,
          lockfile: state.lockfile, wouldUse: state.wouldUse, cached: state.cached },
      },
    };
  }

  return {
    wouldUse: state.wouldUse,
    probe: {
      id: 'preparation', label: 'Dependency preparation', required: true, status: 'PASS',
      detail: `would prepare via ${state.wouldUse} — ${state.detail}`,
      facts: { ecosystem: state.ecosystem, packageManager: state.packageManager,
        lockfile: state.lockfile, lockfileHash: state.lockfileHash,
        wouldUse: state.wouldUse, cached: state.cached, caches: state.caches },
    },
  };
}

/** Writability of the cache root, asked without creating anything. */
function describeCacheRoot(root: string, cacheDir: string | null): { probed: string; writable: boolean | null } {
  let dir = cacheDir ? path.dirname(cacheDir) : path.join(root, '.zeus', 'cache');
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(dir)) {
      try { fs.accessSync(dir, fs.constants.W_OK); return { probed: dir, writable: true }; }
      catch { return { probed: dir, writable: false }; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { probed: dir, writable: null };
}

/**
 * The whole readiness question, answered once.
 *
 * ONE IMPLEMENTATION. `zeus doctor` and `zeus mission run` both call this and
 * neither has its own copy — the selection-ledger principle applied to health:
 * two paths that decide separately will eventually disagree, and the one that
 * disagrees quietly is the one that lets a mission start.
 */
export function projectReadiness(input: { root: string; cfg: ProjectConfig }): ReadinessReport {
  const env = supervisorEnv(input.root);
  const probes: ReadinessProbe[] = [];

  probes.push(probePackageManager(input.root, env));
  probes.push(...probeCommands(input.cfg, env));
  const prep = probePreparation(input.root, input.cfg, env);
  probes.push(prep.probe);

  const failed = probes.filter((p) => p.required && p.status === 'FAIL');
  const ok = failed.length === 0;
  const floor = probes
    .filter((p) => p.id.startsWith('command:') && p.status === 'PASS')
    .map((p) => p.id.slice('command:'.length))
    .filter((n) => (REQUIRED_FLOOR as readonly string[]).includes(n));

  // A floor command nobody declared is not a failure — but it narrows what any
  // mission here can ever prove, and a contract line that silently lists a
  // shorter floor invites the reader to assume the missing one just passed.
  const undeclared = REQUIRED_FLOOR.filter((n) =>
    probes.some((p) => p.id === `command:${n}` && p.status === 'SKIPPED'));

  const summary = ok
    ? `a mission on this project would: prepare via ${prep.wouldUse ?? 'nothing'}, `
      + `run floor [${floor.join(', ') || 'nothing — no floor command resolved'}]`
      + (undeclared.length
        ? ` — ${undeclared.join(' and ')} ${undeclared.length > 1 ? 'are' : 'is'} not declared, `
          + 'so nothing here can prove a criterion that needs it'
        : '')
    : `a mission on this project would fail: ${failed[0].detail}`;

  return { ok, probes, wouldPrepareVia: prep.wouldUse, floor, summary, undeclaredFloor: [...undeclared] };
}
