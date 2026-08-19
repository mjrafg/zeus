/**
 * Execution policy — the boundary that treats the project repository and the
 * task text as potentially hostile.
 *
 * A prompt instruction is not a security boundary: the model is asked to be
 * careful, but nothing about asking makes it so. This module decides, before
 * anything is spawned, WHERE a command may run, WHAT it may read and write,
 * and WHICH environment it inherits — and the decision is made from the
 * policy object, never from the command string's good intentions.
 *
 * Deliberately not a regex blocklist. Blocklists enumerate the attacks someone
 * already thought of; this enumerates the small set of things that are allowed.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ExecutionPolicy {
  /** The project's own root. Everything is expressed relative to it. */
  projectRoot: string;
  /** The task's isolated worktree — the only place writes are expected. */
  worktreeRoot: string;
  /** Absolute paths the execution may write to. */
  writablePaths: string[];
  /** Absolute paths the execution may read. Empty means "anything readable". */
  readablePaths: string[];
  /** Environment variables passed through, by exact name. */
  envAllowlist: string[];
  /** Never passed through, even if allowlisted by pattern. */
  envDenylist: string[];
  /** May the execution reach the network? */
  network: boolean;
  /** May it run a shell at all (`sh -c`)? */
  allowShell: boolean;
}

/** Secrets that must never reach a project command, whatever it claims to need. */
const ALWAYS_DENY_ENV = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'SSH_AUTH_SOCK', 'GPG_TTY',
  'DATABASE_URL', 'PGPASSWORD', 'MYSQL_PWD', 'ZEUS_OWNER_TOKEN',
];

/** The minimum a build or test genuinely needs. */
const DEFAULT_ENV_ALLOW = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SHELL', 'USER', 'LOGNAME',
  'TMPDIR', 'NODE_OPTIONS', 'NODE_ENV', 'CI', 'FORCE_COLOR', 'NO_COLOR',
  'JAVA_HOME', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME',
  'PYTHONPATH', 'VIRTUAL_ENV', 'PNPM_HOME', 'XDG_CACHE_HOME',
];

export function defaultPolicy(projectRoot: string, worktreeRoot: string): ExecutionPolicy {
  return {
    projectRoot: path.resolve(projectRoot),
    worktreeRoot: path.resolve(worktreeRoot),
    writablePaths: [path.resolve(worktreeRoot)],
    readablePaths: [],
    envAllowlist: [...DEFAULT_ENV_ALLOW],
    envDenylist: [...ALWAYS_DENY_ENV],
    network: false,
    allowShell: true,
  };
}

export interface PolicyViolation { code: string; detail: string }

/**
 * Resolves a path the way the kernel will, then checks containment.
 *
 * `path.resolve` alone is not enough: `worktree/link -> /etc` resolves inside
 * the worktree as a string and lands in /etc when opened. Every existing
 * component is realpath'd so a symlink cannot smuggle the destination out.
 */
export function resolveWithin(base: string, candidate: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const baseReal = fs.existsSync(base) ? fs.realpathSync(base) : path.resolve(base);
  const joined = path.isAbsolute(candidate) ? candidate : path.join(baseReal, candidate);
  const resolved = path.resolve(joined);

  // Realpath the deepest existing ancestor: a not-yet-created file is fine,
  // but the directory it would be created in must not escape.
  let probe = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real: string;
  try { real = fs.existsSync(probe) ? path.join(fs.realpathSync(probe), ...tail) : resolved; }
  catch { return { ok: false, reason: `cannot resolve ${candidate}` }; }

  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    return { ok: false, reason: `path escapes ${baseReal}: ${candidate} -> ${real}` };
  }
  return { ok: true, abs: real };
}

export function isWritable(policy: ExecutionPolicy, candidate: string): boolean {
  return policy.writablePaths.some((w) => resolveWithin(w, candidate).ok);
}

/**
 * Builds the environment an execution actually receives.
 *
 * Allowlist first, denylist always wins, and anything that looks like a secret
 * by name is dropped even when someone adds it to the allowlist by mistake.
 */
export function buildEnv(policy: ExecutionPolicy, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of policy.envAllowlist) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  Object.assign(out, extra);
  const secretish = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|CREDENTIAL|_PWD)$/i;
  for (const key of Object.keys(out)) {
    if (policy.envDenylist.includes(key) || secretish.test(key)) delete out[key];
  }
  return out;
}

/**
 * Static inspection of a command before it runs.
 *
 * This is NOT the security boundary — confinement is (see IsolationBackend).
 * It is a second line that refuses the obviously destructive and the obviously
 * escaping, so that a mistake fails loudly instead of quietly succeeding.
 */
export function inspectCommand(policy: ExecutionPolicy, command: string, args: string[]): PolicyViolation[] {
  const v: PolicyViolation[] = [];

  // The executable itself is chosen by Zeus or by the project's declared
  // configuration — never by model output — and legitimate interpreters live
  // in places like ~/.nvm, /usr/local and /opt. Path-checking argv[0] only
  // rejected our own Node. What is untrusted is the ARGUMENTS, so the path
  // rules below apply to those; the binary is validated by existence instead.
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    v.push({ code: 'EXECUTABLE_NOT_FOUND', detail: command });
  }
  // Two different scopes, deliberately:
  //   pathScope    — arguments only, because argv[0] is chosen by us
  //   commandScope — the whole line, because a project's configured command
  //                  can itself be `rm -rf /`
  const pathScope = args.join(' ');
  const full = [command, ...args].join(' ');

  // Absolute paths outside the worktree, written literally in the command.
  for (const m of pathScope.matchAll(/(?:^|[\s"'=])(\/[^\s"';|&)]{2,})/g)) {
    const p = m[1];
    if (/^\/(usr|bin|sbin|lib|lib64|opt|etc\/alternatives|proc\/self|dev\/null|dev\/urandom|tmp|var\/tmp)\b/.test(p)) continue;
    if (resolveWithin(policy.worktreeRoot, p).ok) continue;
    if (policy.readablePaths.some((r) => resolveWithin(r, p).ok)) continue;
    v.push({ code: 'ABSOLUTE_PATH_OUTSIDE_POLICY', detail: p });
  }

  // Traversal that leaves the worktree.
  for (const m of pathScope.matchAll(/(?:^|[\s"'=])((?:\.\.\/){1,}[^\s"';|&)]*)/g)) {
    if (!resolveWithin(policy.worktreeRoot, m[1]).ok) {
      v.push({ code: 'PATH_TRAVERSAL', detail: m[1] });
    }
  }

  // Destructive forms that are never a legitimate build step.
  if (/\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/.test(full) && /\s\/(\s|$)|\s\/\*|\s~\/?(\s|$)|\s\$HOME/.test(full)) {
    v.push({ code: 'DESTRUCTIVE_COMMAND', detail: 'recursive delete targeting / or $HOME' });
  }
  if (/\b(mkfs|dd\s+if=.*of=\/dev\/|shutdown|reboot|halt|init\s+0)\b/.test(full)) {
    v.push({ code: 'DESTRUCTIVE_COMMAND', detail: 'host-level destructive command' });
  }
  if (/:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/.test(full)) {
    v.push({ code: 'FORK_BOMB', detail: 'shell fork bomb pattern' });
  }
  // Writing to another user's shell profile or to systemd units.
  if (/>>?\s*(~|\$HOME)\/\.(bashrc|profile|zshrc)|\/etc\/systemd|\/etc\/cron/.test(full)) {
    v.push({ code: 'PERSISTENCE_ATTEMPT', detail: 'writing outside the project to gain persistence' });
  }
  // Re-introducing credentials the policy strips.
  for (const denied of policy.envDenylist) {
    if (new RegExp(`\\b${denied}\\s*=`).test(full)) {
      v.push({ code: 'ENV_POISONING', detail: `command sets denied variable ${denied}` });
    }
  }
  if (!policy.network && /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/.test(full)) {
    v.push({ code: 'NETWORK_DENIED', detail: 'network tool invoked under a no-network policy' });
  }
  return v;
}
