/**
 * The mission ratchet.
 *
 * A named git ref that only ever moves to a commit the mission has PROVEN
 * green. Two rules make it safe:
 *
 *   * **The event is the truth, the ref is a pointer.** A ratchet position
 *     exists because a `MISSION_CHECKPOINT` was recorded, not because a ref
 *     happens to point somewhere. Anyone can delete, move or forge the ref;
 *     none of that changes what the mission proved, and `reconstructRatchet`
 *     puts it back from the log.
 *   * **It lives under `refs/zeus/`.** Not `refs/heads/`, so it can never
 *     collide with a user's branch, never appear in `git branch`, and never be
 *     pushed by a plain `git push`.
 *
 * Writing a ref is a repository WRITE. It therefore goes through ordinary git,
 * and the read-only context from finding G-U2 refuses it — `update-ref` is not
 * on the allowlist, so an inspection path cannot move a ratchet even by
 * mistake. That is asserted, not assumed.
 */

import { execFileSync } from 'child_process';
import { MissionRecord, localLabel, requireScope } from './types';

/** `proj/M-0007` → `refs/zeus/mission/M-0007/green`. */
export function ratchetRef(missionId: string): string {
  requireScope('MISSION', missionId);
  return `refs/zeus/mission/${localLabel(missionId)}/green`;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Where the ref currently points, or null when it does not exist. */
export function readRatchet(repoRoot: string, missionId: string): string | null {
  try { return git(repoRoot, ['rev-parse', '--verify', '--quiet', ratchetRef(missionId)]) || null; }
  catch { return null; }
}

/**
 * Moves the ref.
 *
 * Never called on its own: the caller records a `MISSION_CHECKPOINT` and then
 * points the ref at what the event already says. `advanceRatchet` exists so
 * that the git write has one home, not so that the ref can be set
 * independently of the log.
 */
export function advanceRatchet(repoRoot: string, missionId: string, sha: string): void {
  git(repoRoot, ['update-ref', ratchetRef(missionId), sha]);
}

export function deleteRatchet(repoRoot: string, missionId: string): void {
  try { git(repoRoot, ['update-ref', '-d', ratchetRef(missionId)]); } catch { /* already absent */ }
}

export interface RatchetReconstruction {
  ref: string;
  /** What the log says the position is. */
  expected: string | null;
  /** What the ref said before this ran. */
  before: string | null;
  after: string | null;
  action: 'created' | 'moved' | 'unchanged' | 'nothing-to-restore';
}

/**
 * Rebuilds the ref from the mission's log.
 *
 * The recovery story for the ratchet is not "restore it from a backup", it is
 * "the log already contains it". A mission whose ref was deleted, garbage
 * collected or clobbered by a stray script is not damaged.
 */
export function reconstructRatchet(repoRoot: string, rec: MissionRecord): RatchetReconstruction {
  const ref = ratchetRef(rec.missionId);
  const before = readRatchet(repoRoot, rec.missionId);
  const expected = rec.ratchetSha;

  if (!expected) return { ref, expected, before, after: before, action: 'nothing-to-restore' };
  if (before === expected) return { ref, expected, before, after: before, action: 'unchanged' };
  advanceRatchet(repoRoot, rec.missionId, expected);
  return {
    ref, expected, before, after: readRatchet(repoRoot, rec.missionId),
    action: before === null ? 'created' : 'moved',
  };
}
