/**
 * The gate on Zeus's own commits.
 *
 * Evidence: commit `e93cbbd` landed carrying two boundary-check violations,
 * because the suite was not re-run before committing. The merge that followed
 * was clean; the commit was not. Nothing refused it, because "run the tests
 * before you commit" was a habit rather than a boundary.
 *
 * Documentation and audit commits are the ones that historically skip
 * verification — they feel like they cannot break anything — and `e93cbbd` was
 * exactly that: a documentation commit. So this gate makes no exception for
 * them.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GateFailure {
  /** The check as the suite named it, e.g. "PB5" or "R-D1". */
  check: string;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  passed: number;
  failed: number;
  failures: GateFailure[];
  durationMs: number;
  /** Set when the gate could not run at all — never treated as a pass. */
  inconclusive: string | null;
}

const SUMMARY = /zeus tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/;

/**
 * The suite must not inherit git's hook environment.
 *
 * `git commit` exports GIT_DIR, GIT_INDEX_FILE and friends to its hooks. Zeus's
 * own tests build throwaway repositories and run git inside them, and with
 * those variables inherited every one of those calls silently retargets the
 * Zeus repository instead — the suite collapses, and the gate reports that it
 * could not verify. Which is what happened the first time this gate ran for
 * real: it refused a commit whose suite passes cleanly on its own.
 *
 * Stripping them is what makes the gate usable from the hook it exists for.
 */
export function cleanGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('GIT_')) continue;
    out[k] = v;
  }
  return out;
}
const FAIL_LINE = /^\s*FAIL\s+([A-Za-z0-9_.-]+):?\s*(.*)$/;

/**
 * Runs the non-service suite and reports what failed.
 *
 * The suite is Zeus's own, which starts no database, server or browser — it is
 * classified UNIT/INTEGRATION throughout — so this gate never violates the rule
 * it exists to protect.
 */
export function runSelfCheck(repoRoot: string, opts: { timeoutMs?: number } = {}): GateResult {
  const started = Date.now();
  const runner = path.join(repoRoot, 'node_modules', '.bin', 'ts-node');
  const entry = path.join(repoRoot, 'test', 'run.ts');

  if (!fs.existsSync(entry)) {
    return {
      ok: false, passed: 0, failed: 0, failures: [], durationMs: 0,
      inconclusive: `no test suite at ${path.relative(repoRoot, entry)} — cannot verify this commit`,
    };
  }
  if (!fs.existsSync(runner)) {
    return {
      ok: false, passed: 0, failed: 0, failures: [], durationMs: 0,
      inconclusive: 'ts-node is not installed; run npm install so the commit gate can run',
    };
  }

  const r = spawnSync(runner, ['--transpile-only', entry], {
    cwd: repoRoot, encoding: 'utf8',
    timeout: opts.timeoutMs ?? 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: cleanGitEnv(process.env),
  });

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const durationMs = Date.now() - started;
  const summary = SUMMARY.exec(out);

  if (!summary) {
    // No summary line means the suite did not finish. That is not a pass.
    const tail = out.trim().split('\n').slice(-12).join('\n');
    return {
      ok: false, passed: 0, failed: 0, failures: [], durationMs,
      inconclusive: (r.signal
        ? `the suite was killed by ${r.signal} before reporting`
        : `the suite exited ${r.status} without a summary line`)
        + (tail ? `\n\n  last output:\n${tail.split('\n').map((l) => `    ${l}`).join('\n')}` : ''),
    };
  }

  const passed = Number(summary[1]);
  const failed = Number(summary[2]);
  const failures: GateFailure[] = [];
  for (const line of out.split('\n')) {
    const m = FAIL_LINE.exec(line);
    if (m) failures.push({ check: m[1], detail: m[2].trim() });
  }

  return {
    ok: failed === 0 && r.status === 0,
    passed, failed, failures, durationMs, inconclusive: null,
  };
}

/** The message a refused commit prints. Names the checks, not just a count. */
export function renderRefusal(g: GateResult): string {
  const lines: string[] = [];
  if (g.inconclusive) {
    lines.push('commit refused: the verification gate could not run.');
    lines.push(`  ${g.inconclusive}`);
    lines.push('  A commit is refused rather than allowed when its verification is unknown.');
    return lines.join('\n');
  }
  lines.push(`commit refused: ${g.failed} check(s) failing.`);
  for (const f of g.failures.slice(0, 10)) {
    lines.push(`  ✗ ${f.check}${f.detail ? `: ${f.detail}` : ''}`);
  }
  if (g.failures.length > 10) lines.push(`  … and ${g.failures.length - 10} more`);
  lines.push('');
  lines.push(`  ${g.passed} passed, ${g.failed} failed in ${Math.round(g.durationMs / 1000)}s.`);
  lines.push('  Documentation and audit commits are gated too: the commit that made this');
  lines.push('  gate necessary was a documentation commit.');
  return lines.join('\n');
}
