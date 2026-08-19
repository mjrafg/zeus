/**
 * Migration from the pre-rename layout.
 *
 * Development installs used `.autopilot/` in the project and
 * `~/.local/share/ai-autopilot/` for per-user runtime state. Those directories
 * hold configuration, task state and hash-chained evidence, so they are never
 * deleted, never overwritten and never silently rewritten: migration moves a
 * directory only when the destination does not exist, and otherwise reports the
 * conflict and leaves both sides untouched.
 *
 * Everything here is idempotent. Running it twice is a no-op, and running it
 * on a project that was never on the old layout does nothing at all.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROJECT_DIR, LEGACY_PROJECT_DIR, userDataDir } from './config';

export const LEGACY_DATA_DIRNAME = 'ai-autopilot';
export { LEGACY_PROJECT_DIR };

export type MigrationKind = 'project' | 'user-data';

export interface MigrationStep {
  kind: MigrationKind;
  from: string;
  to: string;
  /** What is actually in the legacy directory, for an honest prompt. */
  contains: string[];
  /** Blocked steps are reported, never forced. */
  status: 'ready' | 'conflict';
  reason?: string;
}

export interface MigrationPlan {
  steps: MigrationStep[];
  /** True when there is legacy data that a user should be asked about. */
  needed: boolean;
}

/** Where per-user runtime state used to live. */
export function legacyUserDataDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    LEGACY_DATA_DIRNAME,
  );
}

function summarise(dir: string): string[] {
  const interesting = ['config.yaml', 'state', 'logs', 'worktrees', 'setup-state.json', 'versions', 'runtime'];
  try {
    return fs.readdirSync(dir).filter((e) => interesting.includes(e));
  } catch { return []; }
}

function step(kind: MigrationKind, from: string, to: string): MigrationStep | null {
  let fromExists = false;
  try { fromExists = fs.statSync(from).isDirectory(); } catch { /* absent */ }
  if (!fromExists) return null;
  // A symlink from the old name to the new one is already a migration someone
  // performed by hand; treat it as done rather than moving a directory onto
  // itself.
  try { if (fs.realpathSync(from) === fs.realpathSync(to)) return null; } catch { /* to may not exist */ }

  const contains = summarise(from);
  if (fs.existsSync(to)) {
    return {
      kind, from, to, contains, status: 'conflict',
      reason: `${path.basename(to)} already exists; nothing was moved, and neither copy was changed`,
    };
  }
  return { kind, from, to, contains, status: 'ready' };
}

/** Looks for legacy data. Read-only: this never changes anything. */
export function planMigration(projectRoot?: string | null): MigrationPlan {
  const steps: MigrationStep[] = [];
  if (projectRoot) {
    const s = step('project',
      path.join(projectRoot, LEGACY_PROJECT_DIR),
      path.join(projectRoot, PROJECT_DIR));
    if (s) steps.push(s);
  }
  const u = step('user-data', legacyUserDataDir(), userDataDir());
  if (u) steps.push(u);
  return { steps, needed: steps.length > 0 };
}

export interface MigrationResult {
  step: MigrationStep;
  moved: boolean;
  detail: string;
}

/**
 * Rewrites the `paths:` entries a legacy config recorded.
 *
 * Deliberately a targeted text substitution rather than a parse-and-reserialise:
 * a user's comments and hand edits survive, and a config this code does not
 * fully understand is not silently reformatted.
 */
export function rewriteConfigPaths(configFile: string): boolean {
  let text: string;
  try { text = fs.readFileSync(configFile, 'utf8'); } catch { return false; }
  const next = text.replace(
    new RegExp(`(^|[\\s:'"])\\${LEGACY_PROJECT_DIR}/`, 'g'),
    `$1${PROJECT_DIR}/`,
  );
  if (next === text) return false;
  const tmp = `${configFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, configFile);
  return true;
}

/**
 * Performs the plan.
 *
 * Each step is a single directory rename, which is atomic on one filesystem and
 * cannot leave half the evidence behind. A step whose destination exists is
 * skipped and reported; this function never merges, never overwrites and never
 * deletes.
 */
export function applyMigration(plan: MigrationPlan, opts: { dryRun?: boolean } = {}): MigrationResult[] {
  const results: MigrationResult[] = [];
  for (const s of plan.steps) {
    if (s.status === 'conflict') {
      results.push({ step: s, moved: false, detail: s.reason ?? 'skipped' });
      continue;
    }
    if (opts.dryRun) {
      results.push({ step: s, moved: false, detail: `would move ${s.from} → ${s.to}` });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(s.to), { recursive: true });
      fs.renameSync(s.from, s.to);
    } catch (e: any) {
      results.push({ step: s, moved: false, detail: `could not move: ${e?.message ?? e}` });
      continue;
    }
    let detail = `moved ${s.from} → ${s.to}`;
    if (s.kind === 'project') {
      const cfg = path.join(s.to, 'config.yaml');
      if (rewriteConfigPaths(cfg)) detail += '; config paths updated';
    }
    results.push({ step: s, moved: true, detail });
  }
  return results;
}
