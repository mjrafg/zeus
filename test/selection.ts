/**
 * Regression tests for the validation-selection defect.
 *
 * The shape being prevented: a phase acquiring checks by its own route, so that
 * a change cleared at FAST picks up a database-starting suite later. Each test
 * fails against the behaviour that existed before this fix — selection by
 * `planFor` directly, with no notion of what a suite starts and no constraint
 * enforcement — and passes against the single selection path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { check, section } from './harness';
import { classifyCheck, classifyAll } from '../src/validation/testclass';
import { parseConstraints, checkViolations, diffViolations } from '../src/validation/constraints';
import { selectChecks, DEFAULT_COST_RATIO, approvalKey } from '../src/validation/selection';
import { ProcessSupervisor } from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { defaultPolicy } from '../src/engine/policy';
import { runSelfCheck, renderRefusal, cleanGitEnv } from '../src/selfaudit/commitgate';

/** A project whose integration suite really does start a database. */
function serviceProject(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'svc', scripts: {
      typecheck: 'tsc --noEmit',
      test: 'jest --selectProjects unit',
      'test:integration': 'docker compose up -d postgres && jest --config jest.integration.js',
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'jest.config.js'), 'module.exports = { testEnvironment: "node" };\n');
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  postgres:\n    image: postgres:16\n');
}

const NO_CONSTRAINTS = parseConstraints('');

function classificationsFor(commands: Record<string, string>, root: string) {
  return classifyAll(
    Object.entries(commands).map(([name, command]) => ({ name, command })),
    root,
  );
}

export async function selectionSuite(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-selection-'));
  const proj = path.join(TMP, 'svc');
  serviceProject(proj);

  const COMMANDS = {
    typecheck: 'tsc --noEmit',
    unitTest: 'jest --selectProjects unit',
    integrationTest: 'docker compose up -d postgres && jest --config jest.integration.js',
    lint: 'eslint .',
    build: 'tsc -b',
  };
  const CLASSES = classificationsFor({
    typecheck: COMMANDS.typecheck,
    'unit-test': COMMANDS.unitTest,
    'integration-test': COMMANDS.integrationTest,
    lint: COMMANDS.lint,
    build: COMMANDS.build,
  }, proj);

  // -----------------------------------------------------------------------
  section('test 3/4: what a suite starts is classified, and the unknown is not assumed cheap');
  {
    const integration = CLASSES.find((c) => c.check === 'integration-test')!;
    check('SEL-S3: a suite that starts a database is SERVICE_DEPENDENT',
      integration.klass === 'SERVICE_DEPENDENT', `${integration.klass} — ${integration.signals.join('; ')}`);
    check('S3b: the verdict cites the signal it found',
      integration.signals.some((s) => /container runtime|database/i.test(s)));

    const e2e = classifyCheck('e2e', 'playwright test', proj);
    check('S3c: a browser-driving suite is E2E', e2e.klass === 'E2E');

    const mystery = classifyCheck('custom', 'make verify-everything', proj);
    check('SEL-S4: an unclassifiable suite is UNKNOWN, never UNIT',
      mystery.klass === 'UNKNOWN', mystery.klass);
    check('SEL-S4b: and selection treats UNKNOWN as service-dependent',
      mystery.treatAsService === true);

    const unit = CLASSES.find((c) => c.check === 'unit-test')!;
    check('SEL-S4c: a plain runner with no service signal is UNIT',
      unit.klass === 'UNIT', `${unit.klass} — ${unit.signals.join('; ')}`);
  }

  // -----------------------------------------------------------------------
  section('test 1/2: FAST never acquires a heavy suite, and every phase selects identically');
  {
    const base = {
      tier: 'FAST' as const, commands: COMMANDS, classifications: CLASSES,
      constraints: NO_CONSTRAINTS, affectedSurfaces: [] as string[],
    };
    const verify = selectChecks({ ...base, phase: 'VERIFY' });
    const final = selectChecks({ ...base, phase: 'FINAL_ACCEPTANCE' });
    const expansion = selectChecks({ ...base, phase: 'REVIEW_EXPANSION' });

    const names = (l: typeof verify) => l.selected.map((c) => c.name).sort().join(',');

    check('SEL-S1: a FAST task selects no integration suite',
      !verify.selected.some((c) => c.name === 'integration-test'),
      `selected: ${names(verify) || '(none)'}`);
    check('S1b: the deterministic floor still runs at FAST',
      verify.selected.some((c) => c.name === 'typecheck' && c.required)
      && verify.selected.some((c) => c.name === 'unit-test' && c.required));
    check('SEL-S2: VERIFY and FINAL_ACCEPTANCE select identically for the same diff and tier',
      names(verify) === names(final), `${names(verify)} vs ${names(final)}`);
    check('S2b: REVIEW_EXPANSION selects identically too — one path, not three',
      names(verify) === names(expansion));

    // The reported incident's shape: FAST tier, and something asks for the heavy suite.
    const deep = selectChecks({ ...base, phase: 'FINAL_ACCEPTANCE', tier: 'DEEP', affectedSurfaces: ['src/db/tx.ts'] });
    check('S1c: DEEP with a named affected surface may select it — the exclusion is a rule, not a ban',
      deep.selected.some((c) => c.name === 'integration-test'));
    const normalNoSurface = selectChecks({ ...base, phase: 'VERIFY', tier: 'NORMAL' });
    check('S1d: NORMAL does not reach for the integration suite at all',
      !normalNoSurface.selected.some((c) => c.name === 'integration-test'));

    // The NORMAL rule bites on a service-dependent check that IS in the NORMAL
    // plan. `build` is, so give this project one that starts a container.
    const dockerBuild = { ...COMMANDS, build: 'docker compose run --rm builder tsc -b' };
    const dockerClasses = classificationsFor({
      typecheck: dockerBuild.typecheck, 'unit-test': dockerBuild.unitTest,
      'integration-test': dockerBuild.integrationTest, lint: dockerBuild.lint, build: dockerBuild.build,
    }, proj);
    const noSurface = selectChecks({
      phase: 'VERIFY', tier: 'NORMAL', commands: dockerBuild, classifications: dockerClasses,
      constraints: NO_CONSTRAINTS, affectedSurfaces: [],
    });
    check('S1e: NORMAL refuses a service-dependent check when no surface is named',
      !noSurface.selected.some((c) => c.name === 'build')
      && noSurface.refused.some((r) => r.name === 'build' && r.code === 'TIER_EXCLUDES_SERVICE'),
      noSurface.refused.map((r) => `${r.name}:${r.code}`).join(', ') || '(nothing refused)');
    const withSurface = selectChecks({
      phase: 'VERIFY', tier: 'NORMAL', commands: dockerBuild, classifications: dockerClasses,
      constraints: NO_CONSTRAINTS, affectedSurfaces: ['src/db/tx.ts'],
    });
    check('S1f: naming a concrete affected surface lets it through at NORMAL',
      withSurface.selected.some((c) => c.name === 'build'));
  }

  // -----------------------------------------------------------------------
  section('test 5/6: task constraints are enforced, and a conflict is never resolved silently');
  {
    const text = 'Change the aria-label on the submit button. '
      + 'Do not run Playwright or E2E tests. '
      + 'Do not start frontend/backend/database services. '
      + 'Use lightweight static or targeted checks only.';
    const set = parseConstraints(text);
    check('SEL-S5: the prose becomes structured constraints',
      set.has('NO_SERVICE_DEPENDENT') && set.has('NO_E2E'),
      set.constraints.map((c) => c.kind).join(', '));

    const ledger = selectChecks({
      phase: 'FINAL_ACCEPTANCE', tier: 'DEEP', commands: COMMANDS,
      classifications: CLASSES, constraints: set, affectedSurfaces: ['src/db/tx.ts'],
    });
    const refusal = ledger.refused.find((r) => r.name === 'integration-test');
    check('S5b: a violating check is REFUSED before execution, even at DEEP',
      !!refusal && refusal.code === 'CONSTRAINT_VIOLATION', refusal?.detail ?? 'not refused');
    check('S5c: the refusal quotes the sentence it came from',
      !!refusal?.violations?.[0]?.constraint.source.match(/do not start/i));
    check('S5d: the refusal is recorded, not silently dropped',
      ledger.refused.length > 0 && ledger.reasons.some((r) => /refused before execution/.test(r)));

    // A required check that the task forbids: both were asked for.
    const svcRequired = {
      typecheck: 'tsc --noEmit',
      unitTest: 'docker compose up -d postgres && jest',
    };
    const svcClasses = classificationsFor(
      { typecheck: svcRequired.typecheck, 'unit-test': svcRequired.unitTest }, proj);
    const conflicted = selectChecks({
      phase: 'VERIFY', tier: 'FAST', commands: svcRequired,
      classifications: svcClasses, constraints: set, affectedSurfaces: [],
    });
    check('SEL-S6: a required test forbidden by the task produces a conflict state',
      conflicted.conflict?.code === 'REQUIRED_TEST_CONSTRAINT_CONFLICT',
      conflicted.conflict?.detail ?? 'no conflict raised');
    check('S6b: the conflict names the check and says Zeus will not choose',
      !!conflicted.conflict?.detail.includes('unit-test')
      && /will not choose between them silently/.test(conflicted.conflict?.detail ?? ''));
    check('S6c: the required check is NOT silently dropped',
      conflicted.selected.some((c) => c.name === 'unit-test' && c.required));
  }

  // -----------------------------------------------------------------------
  section('test 7: cost disproportion reduces to the floor rather than proceeding');
  {
    const base = {
      phase: 'VERIFY' as const, tier: 'NORMAL' as const, commands: COMMANDS,
      classifications: CLASSES, constraints: NO_CONSTRAINTS,
      affectedSurfaces: ['src/db/tx.ts'],
    };
    // The reported incident numbers exactly: a 4-line change implemented in 30
    // seconds, and a suite observed to take 55 minutes. Ratio ~110:1.
    const disproportionate = selectChecks({
      ...base, tier: 'DEEP',
      cost: {
        implementMs: 30_000, filesChanged: 1, hunks: 1,
        observedMs: { 'integration-test': 55 * 60_000 },
      },
    });
    check('SEL-S7: the real incident ratio (~110:1) is flagged',
      disproportionate.cost?.disproportionate === true,
      disproportionate.cost?.detail ?? 'no cost assessment');
    check('S7b: it drops to the justified minimum rather than running',
      disproportionate.selected.every((c) => c.required)
      && disproportionate.refused.some((r) => r.code === 'COST_DISPROPORTION'));
    check('S7c: the deterministic floor survives the reduction',
      disproportionate.selected.some((c) => c.name === 'typecheck' && c.required)
      && disproportionate.selected.some((c) => c.name === 'unit-test' && c.required));
    check('S7d: the reason is recorded with the ratio',
      /ratio/.test(disproportionate.cost?.detail ?? ''));

    const proportionate = selectChecks({
      ...base, tier: 'DEEP',
      cost: {
        implementMs: 45 * 60_000, filesChanged: 40, hunks: 120,
        observedMs: { 'integration-test': 55 * 60_000 },
      },
    });
    check('S7e: proportionate work keeps its tier-added checks',
      proportionate.cost?.disproportionate === false && proportionate.selected.length >= 2);
    check('S7f: the threshold is stated, not hidden',
      proportionate.cost?.threshold === DEFAULT_COST_RATIO);
  }

  // -----------------------------------------------------------------------
  section('test 8: a runaway allocation is confined and never blamed on the code');
  {
    const wt = path.join(TMP, 'mem');
    fs.mkdirSync(wt, { recursive: true });
    const budgets = { ...deriveBudgets(), memoryMaxMb: 256 };
    const sup = new ProcessSupervisor(budgets as any, undefined, path.join(wt, 'state'));
    const freeBefore = os.freemem();
    const res = await sup.run({
      id: 'runaway', projectId: 'p', taskId: 't', cls: 'light',
      command: 'node',
      args: ['-e', 'const a=[];for(;;){a.push(Buffer.alloc(64*1024*1024));}'],
      cwd: wt, policy: defaultPolicy(wt, wt), timeoutSeconds: 60,
    } as any);
    const freeAfter = os.freemem();
    const consumedMb = Math.round((freeBefore - freeAfter) / 2 ** 20);

    check('SEL-S8: the runaway is classified RESOURCE_LIMIT_EXCEEDED',
      res.outcome === 'RESOURCE_LIMIT_EXCEEDED', `${res.outcome} (signal ${res.signal}, code ${res.exitCode})`);
    check('S8b: it is NOT reported as a verdict about the code',
      res.productSignal === false);
    check('S8c: a memory ceiling was actually applied',
      res.enforced.some((e: string) => /rlimit|memory cap/.test(e)), res.enforced.join(' | '));
    check('S8d: the host was not consumed', consumedMb < 2048, `${consumedMb} MB swing during the probe`);
  }

  // -----------------------------------------------------------------------
  section('test 9: a Zeus commit that fails a check is refused');
  {
    // A stand-in repository whose suite reports a boundary failure. The gate is
    // exercised end to end: it runs the runner, parses the summary, and refuses.
    const repo = path.join(TMP, 'gate-red');
    fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'test/run.ts'), '// stand-in\n');
    const shim = path.join(repo, 'node_modules/.bin/ts-node');
    fs.writeFileSync(shim, '#!/bin/sh\n'
      + 'echo "  ok   PB4: configuration defaults name no specific project"\n'
      + 'echo " FAIL  PB5: no file hard-codes a machine-specific absolute path"\n'
      + 'echo "zeus tests: 517 passed, 1 failed"\n'
      + 'exit 1\n');
    fs.chmodSync(shim, 0o755);

    const red = runSelfCheck(repo);
    check('SEL-S9: the gate refuses a commit whose suite is failing',
      red.ok === false && red.failed === 1);
    check('S9b: the refusal names the failing check, not just a count',
      red.failures.some((f) => f.check === 'PB5'), JSON.stringify(red.failures));
    check('S9c: the rendered message quotes it',
      /PB5/.test(renderRefusal(red)) && /commit refused/.test(renderRefusal(red)));

    const green = path.join(TMP, 'gate-green');
    fs.mkdirSync(path.join(green, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(green, 'test'), { recursive: true });
    fs.writeFileSync(path.join(green, 'test/run.ts'), '// stand-in\n');
    const gshim = path.join(green, 'node_modules/.bin/ts-node');
    fs.writeFileSync(gshim, '#!/bin/sh\necho "zeus tests: 519 passed, 0 failed"\nexit 0\n');
    fs.chmodSync(gshim, 0o755);
    check('S9d: a green suite is allowed through', runSelfCheck(green).ok === true);

    // Verification that cannot run is never a pass.
    const broken = path.join(TMP, 'gate-broken');
    fs.mkdirSync(path.join(broken, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(broken, 'test'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'test/run.ts'), '// stand-in\n');
    const bshim = path.join(broken, 'node_modules/.bin/ts-node');
    fs.writeFileSync(bshim, '#!/bin/sh\necho "exploded"\nexit 3\n');
    fs.chmodSync(bshim, 0o755);
    const inconclusive = runSelfCheck(broken);
    check('S9e: a suite that never reports is refused, not assumed green',
      inconclusive.ok === false && !!inconclusive.inconclusive);
    // The first real run of this gate refused a commit whose suite was green:
    // `git commit` exports GIT_DIR to its hooks, the suite's throwaway-repo git
    // calls inherited it, and every one of them retargeted the Zeus repository.
    const cleaned = cleanGitEnv({ PATH: '/usr/bin', GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index', HOME: '/home/x' } as any);
    check('S9g: the gate strips git\'s hook environment before running the suite',
      cleaned.GIT_DIR === undefined && cleaned.GIT_INDEX_FILE === undefined
      && cleaned.PATH === '/usr/bin' && cleaned.HOME === '/home/x');

    check('S9f: the gate is wired into the repository as a hook',
      fs.existsSync(path.resolve(__dirname, '../.githooks/pre-commit'))
      && /self-check/.test(fs.readFileSync(path.resolve(__dirname, '../.githooks/pre-commit'), 'utf8')));
  }

  // -----------------------------------------------------------------------
  section('test 9 (merge): a merge commit failing a check is refused too');
  {
    const hooksDir = path.resolve(__dirname, '../.githooks');
    const hook = path.join(hooksDir, 'pre-merge-commit');
    check('SEL-S10: the merge gate exists and is executable',
      fs.existsSync(hook) && (fs.statSync(hook).mode & 0o111) !== 0);
    const hookText = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '';
    check('S10b: it runs the same gate as pre-commit',
      /self-check/.test(hookText) && /boundary checks \+ non-service suite/.test(hookText));
    check('S10c: it refuses rather than merging when the gate cannot run',
      /refusing rather than merging unverified/.test(hookText));

    // End to end against real git: a merge whose hook fails must not produce a
    // merge commit. `git merge` never fires pre-commit, which is exactly how a
    // merge commit reached main without passing the gate.
    const repo = path.join(TMP, 'merge-gate');
    const hooks = path.join(repo, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const git = (...args: string[]) => require('child_process').spawnSync('git',
      ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    git('init', '-q', '-b', 'main');
    git('config', 'core.hooksPath', 'hooks');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'feature\n');
    git('add', '-A'); git('commit', '-qm', 'feature work');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'main moves\n');
    git('add', '-A'); git('commit', '-qm', 'main work');
    const before = git('rev-parse', 'HEAD').stdout.trim();

    // A gate that reports a failing boundary check, in the shape ours does.
    fs.writeFileSync(path.join(hooks, 'pre-merge-commit'),
      '#!/bin/sh\necho "commit refused: 1 check(s) failing." >&2\n'
      + 'echo "  x PB5: no file hard-codes a machine-specific absolute path" >&2\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-merge-commit'), 0o755);

    const refused = git('merge', '--no-ff', '--no-edit', 'feature');
    const afterRefused = git('rev-parse', 'HEAD').stdout.trim();
    check('S10d: a merge whose gate fails is refused',
      refused.status !== 0, `git merge exited ${refused.status}`);
    check('S10e: no merge commit is created',
      afterRefused === before, `HEAD ${before.slice(0, 8)} -> ${afterRefused.slice(0, 8)}`);
    check('S10f: the refusal reaches the operator, naming the check',
      /PB5/.test(`${refused.stdout}${refused.stderr}`));

    // And a passing gate lets the same merge through, so the hook is a gate
    // rather than a wall.
    git('merge', '--abort');
    fs.writeFileSync(path.join(hooks, 'pre-merge-commit'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(hooks, 'pre-merge-commit'), 0o755);
    const allowed = git('merge', '--no-ff', '--no-edit', 'feature');
    const afterAllowed = git('rev-parse', 'HEAD').stdout.trim();
    check('S10g: a green gate allows the merge',
      allowed.status === 0 && afterAllowed !== before);
    check('S10h: and it really is a merge commit',
      git('rev-list', '--merges', '--count', 'HEAD').stdout.trim() === '1');
  }

  // -----------------------------------------------------------------------
  section('test 10 (push): publication is gated too');
  {
    const hooksDir = path.resolve(__dirname, '../.githooks');
    const hook = path.join(hooksDir, 'pre-push');
    check('PG1: the push gate exists and is executable',
      fs.existsSync(hook) && (fs.statSync(hook).mode & 0o111) !== 0);
    const hookText = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '';
    check('PG2: it runs both gates — the suite and the audit lanes',
      /self-check/.test(hookText) && /self-audit/.test(hookText));
    check('PG3: it refuses rather than publishing when the gate cannot run',
      /refusing rather than publishing unverified/.test(hookText));

    // End to end against real git with a real remote: a commit reached
    // origin/main while the release gate was refusing, because nothing runs
    // between a green commit and publication.
    const repo = path.join(TMP, 'push-gate');
    const remote = path.join(TMP, 'push-gate-remote.git');
    const hooks = path.join(repo, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const cp = require('child_process');
    const git = (...args: string[]) => cp.spawnSync('git',
      ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const remoteHead = () => cp.spawnSync('git', ['-C', remote, 'rev-parse', 'refs/heads/main'],
      { encoding: 'utf8' }).stdout.trim();

    cp.spawnSync('git', ['init', '-q', '--bare', remote]);
    git('init', '-q', '-b', 'main');
    git('config', 'core.hooksPath', 'hooks');
    git('remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('push', '-q', 'origin', 'main');
    const published = remoteHead();

    fs.writeFileSync(path.join(repo, 'a.txt'), 'a change that fails its audit\n');
    git('add', '-A'); git('commit', '-qm', 'work');
    const local = git('rev-parse', 'HEAD').stdout.trim();

    // A gate that reports an open finding, in the shape ours does.
    fs.writeFileSync(path.join(hooks, 'pre-push'),
      '#!/bin/sh\ncat >/dev/null\necho "pre-push: REFUSED - the self-audit reported open findings." >&2\n'
      + 'echo "  C-C5: a recorded command reached the event store unredacted" >&2\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);

    const refused = git('push', 'origin', 'main');
    check('PG4: a push whose gate fails is refused',
      refused.status !== 0, `git push exited ${refused.status}`);
    check('PG5: nothing reaches the remote',
      remoteHead() === published,
      `remote at ${remoteHead().slice(0, 8)}, local at ${local.slice(0, 8)}`);
    check('PG6: the refusal reaches the operator, naming the finding',
      /C-C5/.test(`${refused.stdout}${refused.stderr}`));

    fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
    const allowed = git('push', 'origin', 'main');
    check('PG7: a green gate allows the push',
      allowed.status === 0 && remoteHead() === local,
      `exited ${allowed.status}, remote at ${remoteHead().slice(0, 8)}`);

    // The real hook's own branching, exercised without running the suite it
    // would otherwise invoke: with no ts-node in this throwaway repo, every
    // path that reaches the gate refuses, and every path that returns before
    // the gate does so for a stated reason. That is the decision logic.
    const zero = '0'.repeat(40);
    const runHook = (stdin: string) => cp.spawnSync('sh', [hook],
      { cwd: repo, input: stdin, encoding: 'utf8' });

    const deleting = runHook(`(delete) ${zero} refs/heads/gone ${local}\n`);
    check('PG8: deleting a remote ref publishes nothing and is not gated',
      deleting.status === 0, `exited ${deleting.status}: ${deleting.stderr.trim()}`);

    const wrongRef = runHook(`refs/heads/side ${published} refs/heads/side ${zero}\n`);
    check('PG9: a ref that is not HEAD is refused, not silently blessed',
      wrongRef.status !== 0 && /audits HEAD/.test(wrongRef.stderr),
      wrongRef.stderr.trim().split('\n')[0]);

    const atHead = runHook(`refs/heads/main ${local} refs/heads/main ${published}\n`);
    check('PG10: a gate that cannot run refuses the push',
      atHead.status !== 0 && /refusing rather than publishing unverified/.test(atHead.stderr));

    check('PG11: the hook worked in the pushing repository, not this one',
      !fs.existsSync(path.resolve(__dirname, `../audits/cycles/prepush-${local.slice(0, 12)}`)));
  }

  // -----------------------------------------------------------------------
  section('the ledger is what the supervisor enforces against');
  {
    const ledger = selectChecks({
      phase: 'VERIFY', tier: 'FAST', commands: COMMANDS, classifications: CLASSES,
      constraints: NO_CONSTRAINTS, affectedSurfaces: [],
    });
    const approved = new Set(ledger.selected.map((c) => approvalKey(c.name, c.command)));
    check('SEL-L1: the approved set keys on name AND command',
      approved.has(approvalKey('typecheck', COMMANDS.typecheck)));
    check('SEL-L2: a check that was refused is not in the approved set',
      !approved.has(approvalKey('integration-test', COMMANDS.integrationTest)));
    const orch = fs.readFileSync(path.resolve(__dirname, '../src/engine/orchestrator.ts'), 'utf8');
    check('SEL-L3: runCheck refuses anything absent from the ledger',
      /this\.approved\.has\(approvalKey/.test(orch) && /NOT_IN_SELECTION/.test(orch));
    check('SEL-L4: the orchestrator no longer reaches for commands itself',
      !/planFor\(/.test(orch), 'planFor is called only inside selectChecks()');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
