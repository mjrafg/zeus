/**
 * Did a read-only role write anything?
 *
 * V1 REMOVED THE SANDBOX ON PURPOSE. The provider sandbox was what made a
 * read-only role read-only, and it was also what cancelled every MCP tool call
 * in a non-interactive codex run — so the price of the boundary was that the
 * critics could not see the repository graph they were supposed to check
 * claims against. A critic that cannot look can only check a claim against the
 * claim.
 *
 * So the boundary moves from PREVENTION to VERIFICATION. The role is told not
 * to modify source, and Zeus looks afterwards. That is weaker, and deliberately
 * so: anyone who needs a real boundary runs Zeus inside a container, a VM or a
 * disposable host, which is stronger than the sandbox ever was and costs no
 * agent its tools.
 *
 * FAST ON THE NORMAL PATH. `git status --porcelain` on a clean tree is a few
 * milliseconds and returns nothing. Diffs are collected ONLY when something
 * changed, because the expensive evidence is worth gathering exactly when
 * there is something to explain.
 *
 * NO AUTO-REVERT IN V1. A violation stops and escalates so we can find out how
 * often agents actually ignore the instruction. Quietly undoing it would erase
 * the only evidence of how well instruction-as-boundary works.
 */

import { readOnlyGit } from './gitro';

export interface WriteCheckClean {
  clean: true;
  /** The tree was actually looked at. False means the answer is unknown. */
  inspected: boolean;
  /** Set only when inspected is false: why Zeus could not look. */
  uninspectable?: string;
  revision: string | null;
  durationMs: number;
}

export interface WriteCheckViolation {
  clean: false;
  inspected: true;
  revision: string | null;
  durationMs: number;
  /** Tracked files whose contents differ in the working tree. */
  modified: string[];
  /** Files added to the index. */
  staged: string[];
  deleted: string[];
  /** Files git has never seen. */
  untracked: string[];
  renamed: string[];
  /** Collected only because something changed. */
  diff: string;
  diffCached: string;
  porcelain: string;
}

export type WriteCheck = WriteCheckClean | WriteCheckViolation;

const MAX_DIFF_BYTES = 64 * 1024;

/**
 * Through the READ-ONLY git path, not a fresh spawn of its own.
 *
 * Every command this needs — rev-parse, status, diff — is already on that
 * path's allowlist, and it refuses anything outside it BEFORE spawning. A
 * second spawn site here would be a second place for a write to become
 * possible, which is a strange thing to build into the module whose whole job
 * is noticing writes.
 */
function git(args: string[], cwd: string, timeout = 20_000):
{ ok: boolean; out: string } {
  try {
    // raw: porcelain's first column is meaningful whitespace, and trimming it
    // turns an unstaged edit into a staged one and shifts the filename by a
    // character.
    const run = readOnlyGit(cwd, { timeoutMs: timeout, raw: true });
    return { ok: true, out: run(args) };
  } catch {
    // Not a repository, git missing, or a form the allowlist refuses. Reported
    // as a failed read rather than thrown: the caller treats an uninspectable
    // tree as clean and records that it could not look.
    return { ok: false, out: '' };
  }
}

export function revisionOf(cwd: string): string | null {
  const r = git(['rev-parse', 'HEAD'], cwd, 10_000);
  return r.ok ? r.out.trim() || null : null;
}

/**
 * Parses porcelain v1, which encodes the index and the worktree separately.
 *
 * Two columns: XY. X is the index, Y is the working tree. A staged edit is
 * "M " and an unstaged one is " M", and conflating them would report a
 * violation without saying whether the agent had also staged it — which is the
 * difference between a stray write and a deliberate commit-in-progress.
 */
export function parsePorcelain(text: string): {
  modified: string[]; staged: string[]; deleted: string[];
  untracked: string[]; renamed: string[];
} {
  const modified: string[] = []; const staged: string[] = [];
  const deleted: string[] = []; const untracked: string[] = [];
  const renamed: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const x = raw[0]; const y = raw[1];
    const name = raw.slice(3).trim();
    if (!name) continue;
    if (x === '?' && y === '?') { untracked.push(name); continue; }
    if (x === 'R' || y === 'R') { renamed.push(name); }
    if (x === 'D' || y === 'D') { deleted.push(name); }
    // The index column being anything but space or ? means it was staged.
    if (x !== ' ' && x !== '?') staged.push(name);
    if (y === 'M' || y === 'T') modified.push(name);
    else if (x === 'M' || x === 'T') modified.push(name);
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return { modified: uniq(modified), staged: uniq(staged), deleted: uniq(deleted),
    untracked: uniq(untracked), renamed: uniq(renamed) };
}

/**
 * Looks at a tree and says whether anything changed.
 *
 * `--untracked-files=all` because a role that writes a NEW file has written to
 * the repository just as surely as one that edits a tracked one, and the
 * default mode collapses a whole new directory into one line.
 */
export function checkWrites(cwd: string): WriteCheck {
  const began = Date.now();
  const revision = revisionOf(cwd);
  const st = git(['status', '--porcelain', '--untracked-files=all'], cwd);
  const porcelain = st.out;
  if (!st.ok) {
    // A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT PASSED.
    //
    // This returned {clean: true} and the comment claimed the absence was
    // recorded elsewhere. It was not. A tree Zeus cannot inspect — not a
    // repository, git missing, or git refusing on `dubious ownership` when the
    // process runs as a different user than the repo's owner — read exactly
    // like a tree that was inspected and found spotless.
    //
    // That is a fail-open in the one check whose entire job is catching
    // writes, and the ownership case is not hypothetical: it is one deployment
    // change away.
    return {
      clean: true, inspected: false, revision, durationMs: Date.now() - began,
      uninspectable: 'git could not report the status of this tree, so whether '
        + 'the role wrote anything is UNKNOWN — not confirmed clean',
    };
  }
  if (!porcelain.trim()) {
    return { clean: true, inspected: true, revision, durationMs: Date.now() - began };
  }

  // Only now, and only because something changed.
  const parsed = parsePorcelain(porcelain);
  const diff = git(['diff'], cwd).out.slice(0, MAX_DIFF_BYTES);
  const diffCached = git(['diff', '--cached'], cwd).out.slice(0, MAX_DIFF_BYTES);
  return {
    clean: false, inspected: true, revision, durationMs: Date.now() - began,
    ...parsed, diff, diffCached, porcelain: porcelain.slice(0, MAX_DIFF_BYTES),
  };
}

/** The roles told not to modify source. Implementer and Repair are absent. */
export const READ_ONLY_STAGES = new Set([
  'front-door', 'oracle', 'oracle-critic', 'planner', 'plan-critic', 'reviewer',
]);

export function isReadOnlyStage(stage: string | null | undefined): boolean {
  return !!stage && READ_ONLY_STAGES.has(stage);
}

/** The event payload for a stage that wrote when it was told not to. */
export function violationPayload(input: {
  stage: string; role?: string | null; traceCallId: string;
  beforeRevision: string | null; check: WriteCheckViolation;
}): Record<string, unknown> {
  return {
    reasonCode: 'ROLE_WRITE_VIOLATION',
    stage: input.stage,
    role: input.role ?? null,
    traceCallId: input.traceCallId,
    beforeRevision: input.beforeRevision,
    afterRevision: input.check.revision,
    changedFiles: input.check.modified,
    addedFiles: input.check.untracked,
    deletedFiles: input.check.deleted,
    stagedFiles: input.check.staged,
    renamedFiles: input.check.renamed,
    porcelain: input.check.porcelain,
    diff: input.check.diff,
    diffCached: input.check.diffCached,
    checkMs: input.check.durationMs,
    // Said in the record, because the record is what someone reads later: V1
    // observes rather than reverts, so the tree is still dirty right now.
    detail: 'a read-only role modified the repository; V1 records this and does '
      + 'not revert it, so the change is still present in the working tree',
  };
}
