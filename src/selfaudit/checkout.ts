/**
 * The disposable audit checkout.
 *
 * Rule zero of self-hosting: the running Zeus is never the Zeus under audit.
 * If the audit could modify, restart or replace the runtime executing it, a
 * defect in the candidate could disable the very checks meant to catch it.
 *
 * So every cycle gets its own checkout of the commit being audited, created
 * with `git worktree` (cheap, isolated, and removable), and every probe reads
 * the candidate's code from there.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readOnlyGit } from '../engine/gitro';

export interface RuntimeState {
  repoRoot: string;
  branch: string;
  head: string;
  version: string;
  dirty: boolean;
  pid: number;
  /** The directory the live runtime is executing from. Never audited in place. */
  runtimeRoot: string;
}

/**
 * Mutating git, for the one thing this module legitimately creates.
 *
 * `createAuditCheckout` adds a worktree; that is construction, not inspection,
 * and it stays on this path deliberately.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Inspection of the repository under audit, which must not be modified by the
 * act of auditing it.
 *
 * Finding G-U2 was exactly this path: a phase declared read-only fetched into
 * a temporary ref and imported fourteen commits. The declaration is now a
 * boundary — an allowlist that refuses before spawning.
 */
function inspect(cwd: string, args: string[]): string {
  return readOnlyGit(cwd)(args);
}

/** Establishes what is running, before anything is created or changed. */
export function runtimeState(repoRoot: string): RuntimeState {
  let head = 'unknown'; let branch = 'unknown'; let dirty = false;
  try { head = inspect(repoRoot, ['rev-parse', 'HEAD']); } catch { /* not a repo */ }
  try { branch = inspect(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* detached */ }
  try { dirty = inspect(repoRoot, ['status', '--porcelain']).length > 0; } catch { /* ignore */ }
  let version = '0.0.0-unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  return {
    repoRoot, branch, head, version, dirty,
    pid: process.pid,
    runtimeRoot: path.resolve(__dirname, '..', '..'),
  };
}

export interface AuditCheckout {
  root: string;
  head: string;
  cycleId: string;
  dispose(): void;
}

/**
 * Creates a throwaway checkout of the current HEAD.
 *
 * node_modules is symlinked rather than installed: the audit inspects the
 * candidate's SOURCE, and reinstalling several hundred packages per cycle
 * would make the harness too slow to gate a release with — which is how
 * gating quietly gets switched off.
 */
export function createAuditCheckout(repoRoot: string, cycleId: string): AuditCheckout {
  const state = runtimeState(repoRoot);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `zeus-audit-${cycleId}-`));
  const root = path.join(base, 'candidate');

  let created = false;
  try {
    git(repoRoot, ['worktree', 'add', '-q', '--detach', root, state.head]);
    created = true;
  } catch {
    // A repository with no commits, or a git too old for this, still deserves
    // an audit — copy the tracked tree instead.
    fs.mkdirSync(root, { recursive: true });
    execFileSync('sh', ['-c', `cp -a "${repoRoot}/." "${root}/"`], { timeout: 300_000 });
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  }

  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm) && fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(repoRoot, 'node_modules'), nm, 'dir'); } catch { /* probes that need it will say so */ }
  }

  return {
    root, head: state.head, cycleId,
    dispose() {
      try { fs.rmSync(nm, { force: true }); } catch { /* symlink may be gone */ }
      if (created) { try { git(repoRoot, ['worktree', 'remove', '--force', root]); } catch { /* fall through */ } }
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
