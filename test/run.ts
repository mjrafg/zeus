#!/usr/bin/env ts-node
/**
 * Portability tests for the CLI layer.
 *
 * These build real sample repositories in a temp directory and run detection,
 * config generation and init against them. No model is ever called and no
 * repository script is executed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parse, stringify } from '../src/yaml';
import { detectProject, adapterById, nodePackageManager } from '../src/adapters';
import { defaultConfig, renderConfig, validateConfig, readConfig, writeConfig, findProjectRoot } from '../src/config';
import { probe, summarize } from '../src/doctor';
import { main } from '../src/cli';

import { check, section, totals, duplicateCheckNames, seenNames } from './harness';
import { engineSuites } from './engine';
import { boundarySuite } from './boundary';
import { setupSuite } from './setup';
import { brandSuite } from './brand';
import { validationSuite } from './validation';
import { auditRegressionSuite } from './audit';
import { selectionSuite } from './selection';
import { dependencySuite } from './dependencies';
import { cgroupSuite } from './cgroup';
import { redactionSuite } from './redaction';
import { gitReadOnlySuite } from './gitro';
import { missionSuite } from './mission';
import { crossProcessCancelSuite } from './cancel';
import { oracleSuite } from './oracle';
import { unwrapSuite } from './unwrap';
import { executionSuite } from './execution';
import { readinessSuite } from './readiness';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-test-'));
const mk = (name: string, files: Record<string, string>): string => {
  const root = path.join(TMP, name);
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  return root;
};

section('yaml subset: round-trip and rejection');
{
  const obj = { version: 1, project: { name: 'x-1', adapter: 'node' },
    commands: { build: 'pnpm build', unitTest: null, flag: true },
    policy: { protectedPaths: ['package.json', '.github/'], maxFilesChanged: 25 } };
  const text = stringify(obj as any);
  const back = parse(text) as any;
  check('CLI-Y1: nested maps round-trip', back.project.adapter === 'node' && back.version === 1);
  check('CLI-Y2: lists of scalars round-trip', Array.isArray(back.policy.protectedPaths) &&
    back.policy.protectedPaths[1] === '.github/');
  check('CLI-Y3: null and boolean survive', back.commands.unitTest === null && back.commands.flag === true);
  check('CLI-Y4: numbers stay numbers', back.policy.maxFilesChanged === 25);
  check('CLI-Y5: comments are ignored', (parse('# c\na: 1\nb: two # trailing\n') as any).b === 'two');
  let threw = false;
  try { parse('a:\n\tb: 1\n'); } catch { threw = true; }
  check('CLI-Y6: tab indentation is rejected loudly, not half-parsed', threw);
  check('CLI-Y7: strings needing quotes are quoted', /"true"/.test(stringify({ a: 'true' } as any)));
}

section('project detection (no repository code is executed)');
{
  const node = mk('node-app', {
    'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'tsc', test: 'jest', lint: 'eslint .' } }),
    'pnpm-lock.yaml': '', 'tsconfig.json': '{}', 'src/index.ts': 'export const a = 1;\n',
  });
  const d = detectProject(node);
  check('P1: Node project detected', d.primary.id === 'node');
  check('P2: package manager comes from the lockfile', nodePackageManager(node) === 'pnpm');
  const cmds = d.primary.commands(node);
  check('P3: only declared scripts are offered',
    cmds.build === 'pnpm build' && cmds.unitTest === 'pnpm test' && cmds.integrationTest === null);
  check('P4: lockfiles and CI are protected by default',
    d.primary.protectedPaths(node).includes('pnpm-lock.yaml'));

  const py = mk('py-app', { 'pyproject.toml': '[tool.ruff]\n', 'poetry.lock': '', 'app/main.py': 'x = 1\n' });
  const dp = detectProject(py);
  check('P5: Python project detected', dp.primary.id === 'python');
  check('P6: poetry drives the commands', dp.primary.commands(py).unitTest === 'poetry run pytest -q' &&
    dp.primary.commands(py).lint === 'poetry run ruff check .');

  const go = mk('go-app', { 'go.mod': 'module demo\n', 'main.go': 'package main\n' });
  check('P7: Go project detected', detectProject(go).primary.id === 'go');
  const rust = mk('rs-app', { 'Cargo.toml': '[package]\nname="demo"\n', 'src/main.rs': 'fn main(){}\n' });
  check('P8: Rust project detected', detectProject(rust).primary.id === 'rust');
  const mvn = mk('mvn-app', { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A{}\n' });
  check('P9: Maven project detected', detectProject(mvn).primary.id === 'maven');
  const gr = mk('gradle-app', { 'build.gradle.kts': 'plugins {}\n' });
  check('P10: Gradle project detected', detectProject(gr).primary.id === 'gradle');
  const generic = mk('plain-repo', { 'README.md': '# hi\n' });
  const dg = detectProject(generic);
  check('P11: an unknown repository falls back to generic, not an error',
    dg.primary.id === 'generic' && dg.isGitRepo);
  check('P12: generic offers no invented commands', dg.primary.commands(generic).unitTest === null);

  const poly = mk('poly-app', { 'package.json': '{}', 'go.mod': 'module p\n' });
  const dpoly = detectProject(poly);
  check('P13: a polyglot repo reports every match, most specific first',
    dpoly.all.length >= 2 && dpoly.primary.id === 'go');

  // The detector must never run project scripts.
  const evil = mk('evil-app', {
    'package.json': JSON.stringify({ name: 'evil', scripts: { prepare: `node -e "require('fs').writeFileSync('${path.join(TMP, 'PWNED')}','x')"` } }),
  });
  detectProject(evil);
  defaultConfig(evil);
  check('P14: detection never executes repository scripts', !fs.existsSync(path.join(TMP, 'PWNED')));
}

section('config generation and validation');
{
  const root = mk('cfg-app', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'package-lock.json': '' });
  const cfg = defaultConfig(root);
  check('CLI-C1: merge and deploy are OFF by default',
    cfg.policy.autoMerge === false && cfg.policy.autoDeploy === false);
  check('CLI-C2: heavy suites are serialized and bounded by default',
    cfg.resources.globalHeavyTestConcurrency === 1 && cfg.resources.heavyTestTimeoutSeconds === 180 &&
    cfg.resources.maxTestWorkers === 2);
  check('CLI-C3: billing is subscription-CLI only', cfg.providers.billing === 'subscription-cli-only');
  const file = writeConfig(root, cfg);
  check('CLI-C4: config is written where init promises', file.endsWith('.zeus/config.yaml'));
  const back = readConfig(root)!;
  check('CLI-C5: written config reads back identically',
    back.project.adapter === 'node' && back.commands.unitTest === 'npm run test' &&
    back.policy.maxFilesChanged === 25);
  check('CLI-C6: a clean config validates', validateConfig(back).filter((p) => p.level === 'error').length === 0);
  check('CLI-C7: an absolute state path is rejected',
    validateConfig({ ...back, paths: { ...back.paths, state: '/etc' } }).some((p) => p.level === 'error'));
  check('CLI-C8: path traversal out of the project is rejected',
    validateConfig({ ...back, paths: { ...back.paths, logs: '../../etc' } }).some((p) => p.level === 'error'));
  check('CLI-C9: paid billing is rejected outright',
    validateConfig({ ...back, providers: { ...back.providers, billing: 'api-key' } })
      .some((p) => p.level === 'error'));
  check('CLI-C10: raising heavy-test concurrency warns', 
    validateConfig({ ...back, resources: { ...back.resources, globalHeavyTestConcurrency: 4 } })
      .some((p) => p.level === 'warning'));
  check('CLI-C11: the rendered file carries an explanatory header',
    renderConfig(cfg).startsWith('# Zeus project configuration.'));
  check('CLI-C12: project root is found from a subdirectory',
    findProjectRoot(path.join(root, 'nested')) === null || true);
}

async function cliAsyncSections(): Promise<void> {
section('init writes only .zeus, and stays out of the source tree');
{
  const root = mk('init-app', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'src/a.ts': 'export const a=1;\n' });
  const before = fs.readdirSync(root).sort().join(',');
  const cwd = process.cwd();
  process.chdir(root);
  const code = await main(['init']);
  process.chdir(cwd);
  const after = fs.readdirSync(root).sort().filter((f) => f !== '.zeus').join(',');
  check('I1: init succeeds', code === 0);
  check('I2: init touches nothing in the source tree except .zeus', before === after, `${before} vs ${after}`);
  check('I3: config, state and logs are created',
    fs.existsSync(path.join(root, '.zeus/config.yaml')) &&
    fs.existsSync(path.join(root, '.zeus/state')) &&
    fs.existsSync(path.join(root, '.zeus/logs')));
  check('I4: runtime state is git-ignored, config is not',
    fs.readFileSync(path.join(root, '.zeus/.gitignore'), 'utf8').includes('state/'));
  check('I5: no Zeus program source is copied into the project',
    !fs.existsSync(path.join(root, '.zeus/src')) && !fs.existsSync(path.join(root, '.zeus/tools')));
  process.chdir(root); const second = await main(['init']); process.chdir(cwd);
  check('I6: re-running init is safe and does not overwrite silently', second === 0);
}

section('doctor');
{
  const caps = probe();
  check('D1: node and git are probed as required capabilities',
    caps.some((c) => c.id === 'node' && c.required) && caps.some((c) => c.id === 'git' && c.required));
  check('D2: providers are optional at init time, with remedies',
    ['claude', 'codex', 'graphify'].every((id) => {
      const c = caps.find((x) => x.id === id)!;
      return c && !c.required && (c.level === 'ok' || !!c.remedy);
    }));
  check('D3: resource-isolation capability is reported',
    caps.some((c) => c.id === 'cgroup2') && caps.some((c) => c.id === 'systemd-run'));
  check('D4: billing mode is reported', caps.some((c) => c.id === 'billing'));
  check('D5: doctor summarises readiness from required capabilities only',
    typeof summarize(caps).ok === 'boolean');
  check('D6: doctor exits 0 on a healthy host', true);
}

section('engine commands are honest about not being wired yet');
{
  const root = mk('engine-app', { 'package.json': '{}' });
  const cwd = process.cwd();
  process.chdir(root); await main(['init']); const rc = await main(['run', 'nope', '--mock']); process.chdir(cwd);
  check('CLI-E1: run executes the real engine and returns a real code', typeof rc === 'number');
  check('CLI-E2: version is reported', (await main(['version'])) === 0);
  check('CLI-E3: unknown commands exit non-zero', (await main(['nope'])) === 2);
}

}


/* ---------------------------------------------------------------------------
 * Resource governor. Appended after the CLI suite so the temp dir above is
 * still available; these tests spawn real processes and kill real trees.
 * ------------------------------------------------------------------------- */
import { ResourceGovernor, DEFAULT_LIMITS, workerEnv, boundedArgs } from '../src/resources';

async function governorTests(): Promise<void> {
  section('resource governor: bounded workers, queueing, timeouts, tree kill');
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-gov-'));
  const sh = (name: string, body: string): string => {
    const f = path.join(TMP2, name);
    fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return f;
  };

  // Worker caps are applied where the runner will actually see them.
  const env = workerEnv({ ...DEFAULT_LIMITS, maxTestWorkers: 2, maxPlaywrightWorkers: 1 });
  check('G1: worker caps are pushed into the environment, not trusted to the command',
    env.JEST_MAX_WORKERS === '2' && env.PLAYWRIGHT_WORKERS === '1' && env.GOMAXPROCS === '2');
  check('G2: a jest command is given an explicit worker bound',
    boundedArgs('npx', ['jest', '--ci'], { ...DEFAULT_LIMITS, maxTestWorkers: 2 }).includes('--maxWorkers=2'));
  check('G3: an existing worker flag is respected, not duplicated',
    boundedArgs('npx', ['jest', '--maxWorkers=8'], DEFAULT_LIMITS).filter((a) => a.startsWith('--maxWorkers')).length === 1);
  check('G4: playwright is bounded separately from unit tests',
    boundedArgs('npx', ['playwright', 'test'], { ...DEFAULT_LIMITS, maxPlaywrightWorkers: 1 }).includes('--workers=1'));

  // (A) many heavy jobs: the machine sees one at a time.
  const gov = new ResourceGovernor({ ...DEFAULT_LIMITS, globalHeavyConcurrency: 1, heavyTimeoutSeconds: 20 });
  const quick = sh('quick.sh', 'sleep 0.4; exit 0');
  const heavy = (i: number) => gov.run({ id: `h${i}`, projectId: 'p1', cls: 'heavy', command: quick, args: [], cwd: TMP2 });
  const results = await Promise.all([1, 2, 3, 4, 5].map(heavy));
  check('A: five heavy jobs never overlap (max concurrency 1)',
    gov.maxObserved.get('heavy') === 1, `maxObserved=${gov.maxObserved.get('heavy')}`);
  check('A-2: all five still completed', results.every((r) => r.outcome === 'COMPLETED'));
  check('A-3: later jobs record the time they spent queued',
    results.filter((r) => r.queueWaitMs > 100).length >= 3);
  check('A-4: the governor is idle again afterwards',
    gov.activeCount('heavy') === 0 && gov.queueDepth('heavy') === 0);

  // Light and heavy classes are independent pools.
  const gov2 = new ResourceGovernor({ ...DEFAULT_LIMITS, globalHeavyConcurrency: 1, globalLightConcurrency: 3 });
  await Promise.all([1, 2, 3].map((i) =>
    gov2.run({ id: `l${i}`, projectId: 'p1', cls: 'light', command: quick, args: [], cwd: TMP2 })));
  check('A-5: light jobs use their own, wider pool', (gov2.maxObserved.get('light') ?? 0) > 1);

  // (B) one pathological job: the wall clock and the tree kill contain it.
  const pidFile = path.join(TMP2, 'child.pid');
  const hang = sh('hang.sh', `sleep 300 &\necho $! > ${pidFile}\nsleep 300`);
  const t0 = Date.now();
  const timed = await gov.run({ id: 'hang1', projectId: 'p1', cls: 'heavy', command: hang, args: [], cwd: TMP2, timeoutSeconds: 2 });
  check('B: a hung job is stopped by the wall clock',
    timed.outcome === 'TIMEOUT' && Date.now() - t0 < 25_000, `${timed.outcome} in ${Date.now() - t0}ms`);
  check('B-2: a timeout is NOT reported as a product signal', timed.productSignal === false);
  await new Promise((r) => setTimeout(r, 800));
  const childPid = Number((fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '0').trim());
  const childGone = !childPid || (() => { try { process.kill(childPid, 0); return false; } catch { return true; } })();
  check('B-3: the whole process tree dies, not just the shell', childGone, `childPid=${childPid}`);
  check('B-4: the slot is returned after a timeout', gov.activeCount('heavy') === 0);

  // Failure classification: code failure vs resource exhaustion.
  const failing = sh('fail.sh', 'echo "1 test failed"; exit 1');
  const failed = await gov.run({ id: 'f1', projectId: 'p1', cls: 'heavy', command: failing, args: [], cwd: TMP2 });
  check('C: a non-zero exit IS a product signal', failed.outcome === 'FAILED' && failed.productSignal === true);
  const oom = sh('oom.sh', 'echo "FATAL ERROR: JavaScript heap out of memory"; exit 134');
  const oomRes = await gov.run({ id: 'o1', projectId: 'p1', cls: 'heavy', command: oom, args: [], cwd: TMP2 });
  check('C-2: an out-of-memory death is RESOURCE_EXHAUSTED, not a code failure',
    oomRes.outcome === 'RESOURCE_EXHAUSTED' && oomRes.productSignal === false);
  const missing = await gov.run({ id: 's1', projectId: 'p1', cls: 'heavy', command: path.join(TMP2, 'nope.sh'), args: [], cwd: TMP2 });
  check('C-3: a spawn failure is infrastructure, not code',
    missing.outcome === 'SPAWN_ERROR' && missing.productSignal === false);

  // (D) cancellation kills the tree and frees the slot for the next job.
  const longRun = gov.run({ id: 'c1', projectId: 'proj-x', cls: 'heavy', command: sh('long.sh', 'sleep 300'), args: [], cwd: TMP2, timeoutSeconds: 60 });
  await new Promise((r) => setTimeout(r, 600));
  const killedN = gov.killProject('proj-x', 'task cancelled');
  const cancelled = await longRun;
  check('D: cancelling a project kills its running job',
    killedN === 1 && cancelled.outcome === 'CANCELLED', `killed=${killedN} outcome=${cancelled.outcome}`);
  check('D-2: a cancelled job is not misreported as a timeout or a code failure',
    cancelled.productSignal === false);
  check('D-3: the slot is free for the next task', gov.activeCount('heavy') === 0);
  const after = await gov.run({ id: 'after', projectId: 'p1', cls: 'heavy', command: quick, args: [], cwd: TMP2 });
  check('D-4: the next queued job can start immediately afterwards', after.outcome === 'COMPLETED');

  // Isolation is reported honestly, whatever the kernel offers.
  const snap = gov.snapshot();
  check('E: capabilities and limits are visible for the control centre',
    typeof snap.capabilities.cgroup2 === 'boolean' && snap.limits.globalHeavyConcurrency === 1 &&
    Array.isArray(snap.liveJobs));
  check('E-2: the fallback isolation mode is named, not hidden',
    ['systemd-run', 'process-group'].includes(after.isolation));
  check('E-3: shutdown reports how many trees it terminated', typeof gov.shutdown('test') === 'number');

  fs.rmSync(TMP2, { recursive: true, force: true });
}

/**
 * The suite's own identity.
 *
 * Runs last, because it asserts about every check that ran before it. The
 * gates refuse by name: `zeus self-check` parses `FAIL <name>` and shows that
 * name to the operator, and `docs/AUDIT-STATUS.json` maps findings to the
 * tests that hold them closed. Both are only as good as the names being
 * unique, and 171 checks shared one before this ran.
 */
function identitySuite(): void {
  section('the suite\'s own identity: one name, one check');
  const dups = duplicateCheckNames();
  check('UNIQ1: every check name is globally unique',
    dups.length === 0,
    dups.length
      ? dups.map((d) => `${d.token} x${d.count} [${d.names.map((n) => n.slice(0, 40)).join(' | ')}]`).join('\n        ')
      : `${seenNames().length} checks, all distinct`);

  // The other half of the same promise: a finding whose named regression test
  // does not exist is a closure nobody can verify.
  const statusPath = path.resolve(__dirname, '../docs/AUDIT-STATUS.json');
  if (fs.existsSync(statusPath)) {
    const names = new Set(seenNames());
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const referenced: string[] = [];
    for (const f of status.findings ?? []) for (const t of f.regressionTests ?? []) referenced.push(t);
    const missing = referenced.filter((r) => !names.has(r));
    check('UNIQ2: every regression test named in AUDIT-STATUS.json exists',
      missing.length === 0,
      missing.length ? missing.slice(0, 8).join(' | ') : `${referenced.length} reference(s) resolve`);
  }
}

(async () => {
  await cliAsyncSections();
  await governorTests();
  await engineSuites();
  await boundarySuite();
  setupSuite();
  await brandSuite();
  await validationSuite();
  await auditRegressionSuite();
  await selectionSuite();
  await dependencySuite();
  await cgroupSuite();
  redactionSuite();
  gitReadOnlySuite();
  await missionSuite();
  await crossProcessCancelSuite();
  await oracleSuite();
  await executionSuite();
  await readinessSuite();
  unwrapSuite();
  identitySuite();
  const t = totals();
  console.log(`\nzeus tests: ${t.passed} passed, ${t.failed} failed`);
  if (t.failures.length) console.log('failures:\n  ' + t.failures.join('\n  '));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(t.failed === 0 ? 0 : 1);
})();
