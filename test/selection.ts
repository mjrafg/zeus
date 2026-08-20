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
    check('S3: a suite that starts a database is SERVICE_DEPENDENT',
      integration.klass === 'SERVICE_DEPENDENT', `${integration.klass} — ${integration.signals.join('; ')}`);
    check('S3b: the verdict cites the signal it found',
      integration.signals.some((s) => /container runtime|database/i.test(s)));

    const e2e = classifyCheck('e2e', 'playwright test', proj);
    check('S3c: a browser-driving suite is E2E', e2e.klass === 'E2E');

    const mystery = classifyCheck('custom', 'make verify-everything', proj);
    check('S4: an unclassifiable suite is UNKNOWN, never UNIT',
      mystery.klass === 'UNKNOWN', mystery.klass);
    check('S4b: and selection treats UNKNOWN as service-dependent',
      mystery.treatAsService === true);

    const unit = CLASSES.find((c) => c.check === 'unit-test')!;
    check('S4c: a plain runner with no service signal is UNIT',
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

    check('S1: a FAST task selects no integration suite',
      !verify.selected.some((c) => c.name === 'integration-test'),
      `selected: ${names(verify) || '(none)'}`);
    check('S1b: the deterministic floor still runs at FAST',
      verify.selected.some((c) => c.name === 'typecheck' && c.required)
      && verify.selected.some((c) => c.name === 'unit-test' && c.required));
    check('S2: VERIFY and FINAL_ACCEPTANCE select identically for the same diff and tier',
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
    check('S5: the prose becomes structured constraints',
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
    check('S6: a required test forbidden by the task produces a conflict state',
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
    check('S7: the real incident ratio (~110:1) is flagged',
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

    check('S8: the runaway is classified RESOURCE_LIMIT_EXCEEDED',
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
    check('S9: the gate refuses a commit whose suite is failing',
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
  section('the ledger is what the supervisor enforces against');
  {
    const ledger = selectChecks({
      phase: 'VERIFY', tier: 'FAST', commands: COMMANDS, classifications: CLASSES,
      constraints: NO_CONSTRAINTS, affectedSurfaces: [],
    });
    const approved = new Set(ledger.selected.map((c) => approvalKey(c.name, c.command)));
    check('L1: the approved set keys on name AND command',
      approved.has(approvalKey('typecheck', COMMANDS.typecheck)));
    check('L2: a check that was refused is not in the approved set',
      !approved.has(approvalKey('integration-test', COMMANDS.integrationTest)));
    const orch = fs.readFileSync(path.resolve(__dirname, '../src/engine/orchestrator.ts'), 'utf8');
    check('L3: runCheck refuses anything absent from the ledger',
      /this\.approved\.has\(approvalKey/.test(orch) && /NOT_IN_SELECTION/.test(orch));
    check('L4: the orchestrator no longer reaches for commands itself',
      !/planFor\(/.test(orch), 'planFor is called only inside selectChecks()');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
