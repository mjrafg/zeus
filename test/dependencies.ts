/**
 * Dependency preparation.
 *
 * The finding these cover: Zeus created a worktree per task and never
 * installed anything into it, so on a real Node project the first check died
 * with `Cannot find module` — a validation outcome that says nothing about the
 * code. DEP8 is that finding, reproduced and then fixed inside one test.
 *
 * Everything here runs offline. The fixture's only dependency is a tarball
 * this file builds, so no registry is contacted and the suite is not
 * service-dependent.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { deriveBudgets } from '../src/engine/budget';
import { ProcessSupervisor, listRunRecords, registryDirFor, killRecorded } from '../src/engine/exec';
import { defaultPolicy, resolveWithin } from '../src/engine/policy';
import { Engine } from '../src/engine/orchestrator';
import { mockProvider } from '../src/engine/providers';
import { defaultConfig, writeConfig } from '../src/config';
import {
  prepareDependencies, planDependencies, depsCacheRoot, isCompleteCache, cacheKey,
  findEscapingLink, cleanDependencyCache, describeDependencyState, declaresDependencies,
  installArgvFor, canHardlink, CACHE_SCHEMA, MARKER,
} from '../src/engine/dependencies';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-deps-'));
const budgets = deriveBudgets({ heavyTimeoutSeconds: 120, lightTimeoutSeconds: 60, globalHeavyConcurrency: 2 });

/**
 * Gives a fixture project the package manager the host already has.
 *
 * `pnpm` and `yarn` are corepack shims on most Node installs, and preparation
 * points COREPACK_HOME at the project's dependency cache. Seeding that cache
 * from the host's own is what keeps this suite offline: without it corepack
 * would resolve "latest" over the network on the first run.
 */
function seedCorepack(project: string): boolean {
  const host = process.env.COREPACK_HOME || path.join(os.homedir(), '.cache', 'node', 'corepack');
  if (!fs.existsSync(host)) return false;
  const dest = path.join(project, '.zeus', 'deps', 'corepack');
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(host, dest, { recursive: true });
  return true;
}

/** A real installable package, built once, so nothing ever reaches a registry. */
function buildTarball(): string {
  const src = path.join(TMP, 'tinydep-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'),
    JSON.stringify({ name: 'tinydep', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(src, 'index.js'), 'module.exports = 42;\n');
  execFileSync('npm', ['pack', '--pack-destination', TMP], { cwd: src, encoding: 'utf8', timeout: 120_000 });
  return path.join(TMP, 'tinydep-1.0.0.tgz');
}

const TARBALL = buildTarball();

/**
 * A project directory with a manifest, a real lockfile and no node_modules.
 *
 * The dependency is a tarball INSIDE the project, referenced relatively. Both
 * halves matter: confined executions get a private `/tmp`, so a fixture that
 * kept its tarball in the system temp directory would be invisible to the very
 * install being tested — and a relative specifier keeps the lockfile
 * byte-identical between two projects, which is what DEP3 is about.
 */
function makeProject(name: string, pm: 'npm' | 'pnpm', deps = true): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
  fs.copyFileSync(TARBALL, path.join(root, 'vendor', 'tinydep-1.0.0.tgz'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture', version: '1.0.0', private: true,
    ...(deps ? { dependencies: { tinydep: 'file:./vendor/tinydep-1.0.0.tgz' } } : {}),
  }, null, 1)}\n`);
  const store = path.join(TMP, 'fixture-pnpm-store');
  if (pm === 'pnpm') seedCorepack(root);
  if (pm === 'npm') {
    execFileSync('npm', ['install', '--package-lock-only', '--offline', '--no-audit', '--no-fund'],
      { cwd: root, encoding: 'utf8', timeout: 300_000 });
  } else {
    execFileSync('pnpm', ['install', '--lockfile-only', '--store-dir', store],
      { cwd: root, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  return root;
}

/** Everything a checkout carries, minus what a checkout never carries. */
const CHECKOUT_SKIP = new Set(['node_modules', '.zeus', '.git']);

function copyCheckout(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (CHECKOUT_SKIP.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyCheckout(s, d); else fs.copyFileSync(s, d);
  }
}

/** A worktree is a copy of the manifest set — what `git worktree add` produces. */
function makeWorktree(project: string, name: string): string {
  const wt = path.join(TMP, name);
  copyCheckout(project, wt);
  return wt;
}

function prep(project: string, worktree: string, sup: ProcessSupervisor, extra: Record<string, unknown> = {}) {
  return prepareDependencies({
    projectRoot: project, worktree, taskId: `T-${path.basename(worktree)}`, projectId: path.basename(project),
    installCommand: null, supervisor: sup, policy: defaultPolicy(project, worktree),
    cacheRoot: depsCacheRoot(project), timeoutSeconds: 180, ...extra,
  } as any);
}

export async function dependencySuite(): Promise<void> {
  const sup = new ProcessSupervisor(budgets, undefined, path.join(TMP, 'state'));

  // -----------------------------------------------------------------------
  section('dependency preparation: prepare once per lockfile, reuse after');
  {
    const project = makeProject('proj-npm', 'npm');
    const wt1 = makeWorktree(project, 'wt-npm-1');
    const first = await prep(project, wt1, sup);
    check('DEP1a: the first task prepares, and names the method that ran',
      first.ok && first.prepared && first.method === 'install' && first.reused === false,
      `${first.method} reused=${first.reused} ${first.detail}`);
    check('DEP1b: preparation publishes a cache keyed by the lockfile hash',
      !!first.lockfileHash && isCompleteCache(path.join(depsCacheRoot(project),
        cacheKey('npm', first.lockfileHash!))));

    const wt2 = makeWorktree(project, 'wt-npm-2');
    const second = await prep(project, wt2, sup);
    check('DEP1c: the second task reuses instead of installing',
      second.ok && second.reused === true && second.method !== 'install',
      `${second.method} reused=${second.reused}`);
    check('DEP1d: reuse ran no install at all',
      !second.attempts.some((a) => a.method === 'install'),
      second.attempts.map((a) => a.method).join(','));
    check('DEP1e: reuse is materially cheaper than preparation',
      second.durationMs * 2 < first.durationMs,
      `first ${first.durationMs}ms, reused ${second.durationMs}ms`);
    check('DEP1f: the reused worktree really has the dependency',
      fs.existsSync(path.join(wt2, 'node_modules', 'tinydep', 'index.js')));

    // -------------------------------------------------------------------
    section('dependency preparation: containment, identity and honesty');

    // 4 — inside the worktree, no symlink escaping it.
    const nm = path.join(wt2, 'node_modules');
    check('DEP4a: node_modules is a real directory in the worktree, not a symlink',
      fs.lstatSync(nm).isDirectory() && !fs.lstatSync(nm).isSymbolicLink());
    check('DEP4b: no symlink under node_modules leaves the worktree',
      findEscapingLink(nm, wt2) === null, JSON.stringify(findEscapingLink(nm, wt2)));
    check('DEP4c: resolveWithin holds over the materialised result',
      resolveWithin(wt2, fs.realpathSync(nm)).ok);
    // The rule is enforced, not merely observed: a link out of the worktree is
    // refused when it is created.
    const escapeDir = path.join(TMP, 'escape-src', 'node_modules');
    fs.mkdirSync(escapeDir, { recursive: true });
    fs.symlinkSync('/etc', path.join(escapeDir, 'evil'));
    const escapeWt = path.join(TMP, 'escape-wt');
    fs.mkdirSync(escapeWt, { recursive: true });
    let refused = false;
    try {
      const { replicateTree } = require('../src/engine/dependencies');
      replicateTree(escapeDir, path.join(escapeWt, 'node_modules'), 'copy', escapeWt);
    } catch (e: any) { refused = /escapes the worktree/.test(String(e?.message)); }
    check('DEP4d: a symlink whose target leaves the worktree is refused, not created', refused);

    // 2 — a changed lockfile is a different cache.
    const wt3 = makeWorktree(project, 'wt-npm-3');
    const lock = path.join(wt3, 'package-lock.json');
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8'));
    parsed.zeusFixtureSalt = 'changed';           // different bytes, same install result
    fs.writeFileSync(lock, `${JSON.stringify(parsed, null, 2)}\n`);
    const changed = await prep(project, wt3, sup);
    check('DEP2a: a changed lockfile prepares afresh rather than reusing',
      changed.ok && changed.reused === false && changed.method === 'install',
      `${changed.method} reused=${changed.reused}`);
    check('DEP2b: it is a different cache key, so the old cache was never consulted',
      changed.lockfileHash !== first.lockfileHash
      && isCompleteCache(path.join(depsCacheRoot(project), cacheKey('npm', first.lockfileHash!)))
      && isCompleteCache(path.join(depsCacheRoot(project), cacheKey('npm', changed.lockfileHash!))));

    // 3 — identical lockfiles in two projects do not share.
    const projectB = path.join(TMP, 'proj-npm-twin');
    copyCheckout(project, projectB);
    const wtB = makeWorktree(projectB, 'wt-twin-1');
    const planA = planDependencies({ projectRoot: project, worktree: wt2, installCommand: null });
    const planB = planDependencies({ projectRoot: projectB, worktree: wtB, installCommand: null });
    check('DEP3a: two projects with byte-identical lockfiles agree on the hash',
      planA.lockfileHash === planB.lockfileHash && !!planA.lockfileHash);
    check('DEP3b: and still do not share a cache directory',
      planA.cacheDir !== planB.cacheDir
      && planA.cacheDir!.startsWith(project) && planB.cacheDir!.startsWith(projectB));
    check('DEP3c: the second project starts cold despite the identical lockfile',
      planA.cached === true && planB.cached === false);
    const twin = await prep(projectB, wtB, sup);
    check('DEP3d: so it prepares its own',
      twin.ok && twin.reused === false && isCompleteCache(planB.cacheDir!));

    // 7 — nothing to do costs nothing.
    const docs = path.join(TMP, 'proj-docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'README.md'), '# docs only\n');
    const docsWt = makeWorktree(docs, 'wt-docs');
    const execs: string[] = [];
    const none = await prep(docs, docsWt, sup, { onExec: (c: string) => execs.push(c) });
    check('DEP7a: a docs-only repository records method none',
      none.ok && none.method === 'none' && none.prepared === false, none.detail);
    check('DEP7b: and pays nothing — no process was executed at all',
      execs.length === 0 && none.durationMs < 500, `${execs.length} exec(s), ${none.durationMs}ms`);
    const noDeps = makeProject('proj-nodeps', 'npm', false);
    const noDepsWt = makeWorktree(noDeps, 'wt-nodeps');
    const execs2: string[] = [];
    const nothing = await prep(noDeps, noDepsWt, sup, { onExec: (c: string) => execs2.push(c) });
    check('DEP7c: a lockfile beside a manifest declaring no dependencies is also none',
      nothing.method === 'none' && execs2.length === 0 && !declaresDependencies(noDepsWt), nothing.detail);

    // ---- clean and doctor ------------------------------------------------
    const state = describeDependencyState(project, null, depsCacheRoot(project));
    check('DEP-DOC1: doctor reports the package manager, lockfile hash and cache state',
      state.packageManager === 'npm' && !!state.lockfileHash && state.caches === 2
      && state.cacheBytes > 0, JSON.stringify(state));
    check('DEP-DOC2: and names the method the next task would actually use',
      state.wouldUse === (canHardlink(depsCacheRoot(project), depsCacheRoot(project)).ok
        ? 'hardlink' : 'copy'), state.wouldUse);
    const cleaned = cleanDependencyCache(depsCacheRoot(project));
    check('DEP-CLEAN1: clean --deps removes Zeus dependency artifacts',
      cleaned.removed.length === 2 && cleaned.removed.every((n) => n.startsWith(`${CACHE_SCHEMA}-`)));
    check('DEP-CLEAN2: and leaves the project alone',
      fs.existsSync(path.join(project, 'package.json')) && fs.existsSync(path.join(wt2, 'node_modules')));
  }

  // -----------------------------------------------------------------------
  section('dependency preparation: failure is infrastructure, never a verdict');
  {
    const project = makeProject('proj-broken', 'npm');
    const wt = makeWorktree(project, 'wt-broken');
    // A lockfile the manifest disagrees with: `npm ci` refuses, as it should.
    const lock = JSON.parse(fs.readFileSync(path.join(wt, 'package-lock.json'), 'utf8'));
    lock.packages[''].dependencies = { 'a-package-that-is-not-in-the-lock': '^9.9.9' };
    fs.writeFileSync(path.join(wt, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    const pkg = JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8'));
    pkg.dependencies = { 'a-package-that-is-not-in-the-lock': '^9.9.9' };
    fs.writeFileSync(path.join(wt, 'package.json'), `${JSON.stringify(pkg, null, 1)}\n`);

    const failed = await prep(project, wt, sup);
    check('DEP5a: a failing install is reported as a failure, with its output',
      failed.ok === false && !!failed.output && failed.output!.length > 0,
      `ok=${failed.ok} output=${(failed.output ?? '').slice(0, 80)}`);
    check('DEP5b: nothing half-built is left behind as a reusable cache',
      !isCompleteCache(path.join(depsCacheRoot(project), cacheKey('npm', failed.lockfileHash!))));
    const debris = fs.existsSync(depsCacheRoot(project))
      ? fs.readdirSync(depsCacheRoot(project)).filter((n) => n.startsWith('.tmp-')) : [];
    check('DEP5c: the temporary preparation directory is removed, so nothing can be mistaken for a cache',
      debris.length === 0, debris.join(','));

    // And the engine turns that into INFRASTRUCTURE_FAILURE, not TEST_FAILED.
    const repo = path.join(TMP, 'engine-broken');
    copyCheckout(wt, repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    const cfg = defaultConfig(repo);
    cfg.commands.unitTest = 'node -e process.exit(0)';
    cfg.commands.typecheck = null;
    writeConfig(repo, cfg);
    const engine = new Engine({
      projectRoot: repo, config: cfg, supervisor: sup,
      providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
    });
    engine.acquire();
    const rec = engine.createTask('a task whose dependencies cannot be installed');
    const final = await engine.run(rec.taskId);
    const evs = engine.events.read(rec.taskId);
    const depFail = evs.find((e) => e.type === 'DEPENDENCIES_FAILED');
    check('DEP5d: the engine escalates rather than running checks that cannot pass',
      final === 'NEEDS_RECONCILIATION' && !evs.some((e) => e.type === 'CHECK_RESULT'), String(final));
    check('DEP5e: it is classified INFRASTRUCTURE_FAILURE, never TEST_FAILED',
      !!depFail && (depFail.payload as any).outcome === 'INFRASTRUCTURE_FAILURE'
      && !evs.some((e) => e.type === 'CHECK_RESULT' && (e.payload as any).outcome === 'TEST_FAILED'));
    check('DEP5f: the install output travels with the escalation',
      !!depFail && String((depFail.payload as any).installOutput ?? '').length > 0);
    const esc = evs.find((e) => e.type === 'ESCALATION');
    check('DEP5g: and the escalation is complete enough to act on',
      !!esc && ((esc.payload as any).problems ?? []).length === 0
      && (esc.payload as any).reasonCode === 'MISSING_ENVIRONMENT');
    engine.release();
  }

  // -----------------------------------------------------------------------
  section('dependency preparation: governed, bounded, killable');
  {
    const project = path.join(TMP, 'proj-slow');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'Makefile'), 'all:\n\ttrue\n');
    const wt = makeWorktree(project, 'wt-slow');
    const stateRoot = path.join(TMP, 'state');
    const taskId = 'T-slow-0001';

    const running = prepareDependencies({
      projectRoot: project, worktree: wt, taskId, projectId: 'proj-slow',
      installCommand: 'sleep 60', supervisor: sup, policy: defaultPolicy(project, wt),
      cacheRoot: depsCacheRoot(project), timeoutSeconds: 120,
    });
    let seen: ReturnType<typeof listRunRecords> = [];
    for (let i = 0; i < 60 && !seen.length; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      seen = listRunRecords(registryDirFor(stateRoot)).filter((r) => r.taskId === taskId);
    }
    check('DEP6a: preparation is visible in the run registry while it is live',
      seen.length === 1 && seen[0].pgid > 0, `${seen.length} record(s)`);
    check('DEP6b: the registry records what is running, so another process can find it',
      /sleep/.test(seen[0]?.command ?? ''), seen[0]?.command);
    const killed = killRecorded(stateRoot, { taskId }, 'test cancel');
    check('DEP6c: zeus cancel kills it — the same path the CLI uses',
      killed.killed >= 1, `killed=${killed.killed}`);
    const outcome = await running;
    check('DEP6d: a killed preparation fails rather than reporting success',
      outcome.ok === false, `${outcome.method} ok=${outcome.ok}`);
    check('DEP6e: and the registry is clean afterwards',
      listRunRecords(registryDirFor(stateRoot)).filter((r) => r.taskId === taskId).length === 0);

    // Bounded: a preparation that never ends is stopped by the wall clock.
    const wt2 = makeWorktree(project, 'wt-slow-2');
    const t0 = Date.now();
    const timed = await prepareDependencies({
      projectRoot: project, worktree: wt2, taskId: 'T-slow-0002', projectId: 'proj-slow',
      installCommand: 'sleep 60', supervisor: sup, policy: defaultPolicy(project, wt2),
      cacheRoot: depsCacheRoot(project), timeoutSeconds: 3,
    });
    check('DEP6f: preparation is bounded by a timeout, not left to run',
      timed.ok === false && Date.now() - t0 < 30_000,
      `${Date.now() - t0}ms, ${timed.attempts.map((a) => a.detail).join(';')}`);
  }

  // -----------------------------------------------------------------------
  section('the original finding: a check that could not run, now runs');
  {
    const project = makeProject('proj-verdict', 'npm');
    const wt = makeWorktree(project, 'wt-verdict');
    const policy = defaultPolicy(project, wt);
    const runCheck = (id: string) => sup.run({
      id, projectId: 'proj-verdict', taskId: 'T-verdict', cls: 'light',
      command: 'node', args: ['-e', 'process.exit(require("tinydep") === 42 ? 0 : 1)'],
      cwd: wt, policy, confineFilesystem: true, timeoutSeconds: 60,
    });

    const before = await runCheck('verdict-before');
    check('DEP8a: BEFORE preparation the check dies with Cannot find module',
      before.outcome === 'FAILED' && /Cannot find module/.test(before.stdout),
      `${before.outcome}: ${before.stdout.slice(0, 90).replace(/\n/g, ' ')}`);

    const done = await prep(project, wt, sup);
    const after = await runCheck('verdict-after');
    check('DEP8b: AFTER preparation the same check produces a real verdict',
      done.ok && after.outcome === 'COMPLETED' && after.exitCode === 0,
      `${after.outcome} exit=${after.exitCode}: ${after.stdout.slice(0, 90)}`);
    check('DEP8c: and the verdict is about the code — a product signal, not infrastructure',
      after.productSignal === true && after.violations.length === 0
      // The before-state was ALSO a product signal, which is the danger: an
      // absent dependency was indistinguishable from a failing test.
      && before.productSignal === true,
      `before=${before.productSignal} after=${after.productSignal}`);
  }

  // -----------------------------------------------------------------------
  section('dependency preparation: per-package-manager paths');
  {
    // pnpm: its store IS the reuse mechanism, so a pnpm project must use it.
    const pnpmProject = makeProject('proj-pnpm', 'pnpm');
    check('DEP9-seed: the host provides a package manager this suite can use offline',
      fs.existsSync(path.join(pnpmProject, '.zeus/deps/corepack')),
      'no corepack cache on this host — the pnpm path cannot be exercised without a network fetch');
    check('DEP9a: the lockfile decides the package manager and the install argv',
      planDependencies({ projectRoot: pnpmProject, worktree: pnpmProject, installCommand: null })
        .packageManager === 'pnpm'
      && installArgvFor('pnpm', null).join(' ') === 'pnpm install --frozen-lockfile'
      && installArgvFor('npm', 'npm ci').join(' ') === 'npm ci'
      // A configured command for a DIFFERENT manager is not honoured.
      && installArgvFor('pnpm', 'npm ci').join(' ') === 'pnpm install --frozen-lockfile');
    const p1 = makeWorktree(pnpmProject, 'wt-pnpm-1');
    const pFirst = await prep(pnpmProject, p1, sup);
    check('DEP9b: a pnpm project prepares and publishes a store',
      pFirst.ok && fs.existsSync(path.join(pFirst.lockfileHash
        ? path.join(depsCacheRoot(pnpmProject), cacheKey('pnpm', pFirst.lockfileHash)) : '', 'store')),
      pFirst.detail);
    const p2 = makeWorktree(pnpmProject, 'wt-pnpm-2');
    const pSecond = await prep(pnpmProject, p2, sup);
    check('DEP9c: and the second worktree reuses through the pnpm store',
      pSecond.ok && pSecond.reused && pSecond.method === 'pnpm-store',
      `${pSecond.method}: ${pSecond.attempts.map((a) => `${a.method}=${a.ok}`).join(',')}`);
    check('DEP9d: pnpm\'s own symlinks stay inside the worktree',
      findEscapingLink(path.join(p2, 'node_modules'), p2) === null
      && fs.existsSync(path.join(p2, 'node_modules', 'tinydep', 'index.js')));

    // npm: no store, so reuse is a hardlink of the prepared tree.
    const npmProject = makeProject('proj-npm-method', 'npm');
    const n1 = makeWorktree(npmProject, 'wt-npmm-1');
    await prep(npmProject, n1, sup);
    const n2 = makeWorktree(npmProject, 'wt-npmm-2');
    const nSecond = await prep(npmProject, n2, sup);
    const linkable = canHardlink(depsCacheRoot(npmProject), npmProject).ok;
    check('DEP9e: an npm project reuses by hardlink where the filesystem allows it',
      nSecond.reused && nSecond.method === (linkable ? 'hardlink' : 'copy'),
      `${nSecond.method}, hardlink available=${linkable}`);
    check('DEP9f: hardlink means the same inode, not a second copy on disk',
      !linkable || fs.statSync(path.join(n2, 'node_modules/tinydep/index.js')).nlink > 1);

    // The method reaches the WORKTREE event, which is where a human reads it.
    const repo = path.join(TMP, 'engine-method');
    copyCheckout(npmProject, repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    const cfg = defaultConfig(repo);
    cfg.commands.unitTest = 'node -e process.exit(0)';
    cfg.commands.typecheck = null;
    writeConfig(repo, cfg);
    const engine = new Engine({
      projectRoot: repo, config: cfg, supervisor: sup,
      providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
    });
    engine.acquire();
    const rec = engine.createTask('a task in a project with real dependencies');
    await engine.run(rec.taskId);
    const wtEvent = engine.events.read(rec.taskId).find((e) => e.type === 'WORKTREE');
    const p = (wtEvent?.payload ?? {}) as any;
    check('DEP9g: the WORKTREE event carries prepared, method, lockfileHash, reused and durationMs',
      !!wtEvent && p.prepared === true && typeof p.method === 'string' && p.method !== 'none'
      && typeof p.lockfileHash === 'string' && typeof p.reused === 'boolean'
      && typeof p.durationMs === 'number',
      JSON.stringify({ prepared: p.prepared, method: p.method, reused: p.reused, durationMs: p.durationMs }));
    check('DEP9h: and it describes what happened rather than what was intended',
      p.attempts.some((a: any) => a.method === p.method && a.ok === true),
      JSON.stringify(p.attempts?.map((a: any) => `${a.method}=${a.ok}`)));
    check('DEP9i: the marker file is what makes a cache reusable',
      fs.existsSync(path.join(depsCacheRoot(npmProject),
        cacheKey('npm', planDependencies({ projectRoot: npmProject, worktree: n1, installCommand: null })
          .lockfileHash!), MARKER)));
    engine.release();
  }

  sup.shutdown('dependency suite finished');
  fs.rmSync(TMP, { recursive: true, force: true });
}
