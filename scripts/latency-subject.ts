/**
 * The subject repository for latency measurement.
 *
 * Purpose-built, and reported as such rather than dressed up as a third-party
 * codebase. Two reasons Zeus itself could not be the subject:
 *
 *   * three of Zeus's own tests spawn separate OS processes to prove lease and
 *     cancellation behaviour, and those spawns fail inside Zeus's own
 *     confinement — a self-hosted run therefore always stops at VERIFY, and
 *     the REVIEW bucket is never reached at all;
 *   * Zeus is a CLI with no stylesheet and no session module, so the T2 and T4
 *     task shapes have no surface to land on and would not produce the tiers
 *     they exist to exercise.
 *
 * This app has the four surfaces the task shapes need — documentation,
 * presentation, application, session — real TypeScript that really typechecks,
 * and a real test runner. It deliberately has no third-party dependencies: the
 * measurement host has no network inside the confinement, so an `npm install`
 * would measure the registry rather than the product.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=lat@zeus', '-c', 'user.name=lat', ...args],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const TEST_RUNNER = `import { strict as assert } from 'node:assert';
import { toCents, formatCents } from '../dist/app/money.js';
import { isExpired, remainingSeconds } from '../dist/lib/session.js';
import { rowClass } from '../dist/components/Row.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(\`  ok   \${name}\`); };

t('money: converts to cents', () => assert.equal(toCents(12.34), 1234));
t('money: formats positives', () => assert.equal(formatCents(1234), '12.34'));
t('money: formats negatives', () => assert.equal(formatCents(-505), '-5.05'));
t('money: pads the minor unit', () => assert.equal(formatCents(5), '0.05'));

t('session: fresh session is not expired', () =>
  assert.equal(isExpired({ id: 'a', issuedAt: 1000, ttlSeconds: 60 }, 2000), false));
t('session: old session is expired', () =>
  assert.equal(isExpired({ id: 'a', issuedAt: 1000, ttlSeconds: 60 }, 100000), true));
t('session: remaining never goes negative', () =>
  assert.equal(remainingSeconds({ id: 'a', issuedAt: 0, ttlSeconds: 1 }, 999999), 0));
t('session: remaining counts down', () =>
  assert.equal(remainingSeconds({ id: 'a', issuedAt: 0, ttlSeconds: 60 }, 10000), 50));

t('row: negative rows carry the modifier class', () =>
  assert.equal(rowClass(-1), 'ledger-row ledger-row--negative'));
t('row: positive rows do not', () => assert.equal(rowClass(1), 'ledger-row'));

console.log(\`\\nsample tests: \${passed} passed, 0 failed\`);
`;

export const SUBJECT_FILES: Record<string, string> = {
  'README.md': [
    '# Ledger',
    '',
    'A small sample application used as a latency measurement subject.',
    '',
    'It has a session layer, a presentation layer and a handful of pure functions.',
    '',
  ].join('\n'),

  'package.json': `${JSON.stringify({
    name: 'ledger-sample',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      // Compiles then runs: normal for a TypeScript project, and it makes the
      // compile-vs-assert split in Q4 visible instead of hidden.
      test: 'tsc -p tsconfig.json && node test/run.mjs',
      lint: 'node -e 0',
    },
  }, null, 2)}\n`,

  'tsconfig.json': `${JSON.stringify({
    compilerOptions: {
      target: 'ES2021',
      module: 'ES2022',
      moduleResolution: 'node',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`,

  'src/lib/session.ts': [
    '/** Session handling for the sample app. */',
    'export interface Session { id: string; issuedAt: number; ttlSeconds: number }',
    '',
    'export function isExpired(s: Session, nowMs: number): boolean {',
    '  return nowMs - s.issuedAt > s.ttlSeconds * 1000;',
    '}',
    '',
    'export function remainingSeconds(s: Session, nowMs: number): number {',
    '  const left = s.ttlSeconds - (nowMs - s.issuedAt) / 1000;',
    '  return left > 0 ? Math.floor(left) : 0;',
    '}',
    '',
  ].join('\n'),

  'src/app/money.ts': [
    '/** Pure money helpers. */',
    'export function toCents(amount: number): number {',
    '  return Math.round(amount * 100);',
    '}',
    '',
    'export function formatCents(cents: number): string {',
    '  const sign = cents < 0 ? \'-\' : \'\';',
    '  const abs = Math.abs(cents);',
    '  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, \'0\')}`;',
    '}',
    '',
  ].join('\n'),

  'src/components/styles.css': [
    '.ledger-row { padding: 4px 8px; font-family: monospace; }',
    '.ledger-row--negative { color: #b00020; }',
    '.ledger-total { font-weight: 600; }',
    '',
  ].join('\n'),

  'src/components/Row.ts': [
    '/** Presentation helpers for a ledger row. */',
    'export function rowClass(cents: number): string {',
    '  return cents < 0 ? \'ledger-row ledger-row--negative\' : \'ledger-row\';',
    '}',
    '',
  ].join('\n'),

  'test/run.mjs': TEST_RUNNER,
};

/** Creates the subject repository and returns its commit SHA. */
export function createSubject(dir: string): string {
  for (const [rel, body] of Object.entries(SUBJECT_FILES)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  // No trailing slash on node_modules: the toolchain is linked in as a SYMLINK,
  // and `node_modules/` only matches a directory. Without this the symlink shows
  // up as the single changed file in every task, and every diff classifies as
  // one unrecognised path — which is exactly what the first measurement run did.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\n.zeus\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'ledger sample: latency measurement subject']);
  return git(dir, ['rev-parse', 'HEAD']);
}
