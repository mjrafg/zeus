/**
 * Trusted-autonomy hardening tests.
 *
 * These are the cases where an unattended run could produce a confident,
 * green, dishonest result. Each one is a bypass path that has to stay closed,
 * so the assertions are about refusal as much as about behaviour: what Zeus
 * declines to do is the product.
 *
 * Everything here is deterministic. No model is called, no network is touched,
 * and the git access revalidation needs is injected.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { check, section } from './harness';
import { classifyPath } from '../src/validation/surface';
import { parseDiff, isCommentOnly } from '../src/validation/diff';
import {
  resolveTier, planFor, escalate, maxTier, impactConfidence, DEFAULT_HARDENING, Tier,
} from '../src/validation/tier';
import {
  designContract, inspectIntegrity, evidenceCoupledFiles, accountForTests, pathsReferencedBy,
} from '../src/validation/integrity';
import {
  attribute, attributeByRetry, reliabilityFindings, RetryAttempt,
} from '../src/validation/attribution';
import {
  assessConcreteness, evaluateExpansion, applyExpansion, unproductiveExpansion, ExpansionState,
} from '../src/validation/expansion';
import { revalidateForIntegration, overlapBetween, GitAccess } from '../src/validation/revalidate';
import { validateEscalation, escalation, renderEscalation, isComplete } from '../src/validation/escalation';
import { taskTelemetry, zeroTouchCleanRate, formatZeroTouch } from '../src/validation/telemetry';
import { validateConfig, defaultConfig } from '../src/config';
import { StoredEvent } from '../src/engine/events';

// ---------------------------------------------------------------------------
// Diff fixtures. Written as real unified diffs so the parser is exercised too.
// ---------------------------------------------------------------------------

function diffFor(files: Array<{ path: string; added?: string[]; removed?: string[]; status?: string; oldPath?: string }>): string {
  return files.map((f) => {
    const head = [`diff --git a/${f.oldPath ?? f.path} b/${f.path}`];
    if (f.status === 'added') head.push('new file mode 100644');
    if (f.status === 'deleted') head.push('deleted file mode 100644');
    if (f.status === 'renamed') head.push(`rename from ${f.oldPath}`, `rename to ${f.path}`);
    head.push(`--- a/${f.oldPath ?? f.path}`, `+++ b/${f.path}`, '@@ -1,4 +1,4 @@');
    return [
      ...head,
      ...(f.removed ?? []).map((l) => `-${l}`),
      ...(f.added ?? []).map((l) => `+${l}`),
    ].join('\n');
  }).join('\n');
}

const TIERS = (t: Tier) => t;

function ev(taskId: string, type: string, payload: Record<string, unknown>, ts: string): StoredEvent {
  return { seq: 0, id: `${type}-${ts}`, prev: '', hash: '', ts, taskId, type, payload } as unknown as StoredEvent;
}

// ---------------------------------------------------------------------------

export async function validationSuite(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-validation-'));

  section('surface classification: what a path is, and how far it reaches');
  {
    check('VAL-V1: a session helper is high risk, whatever else it looks like',
      classifyPath('src/lib/session-store.ts').highRisk);
    check('VAL-V2: AUTHORS.md is documentation, not authentication',
      classifyPath('AUTHORS.md').surface === 'documentation' && !classifyPath('AUTHORS.md').highRisk);
    check('VAL-V3: a lockfile is a dependency manifest and high risk',
      classifyPath('pnpm-lock.yaml').surface === 'dependency-manifest' && classifyPath('pnpm-lock.yaml').highRisk);
    check('VAL-V4: a test for auth is BOTH a test surface and high risk',
      classifyPath('test/auth.spec.ts').testSurface && classifyPath('test/auth.spec.ts').highRisk);
    check('VAL-V5: a snapshot is a test surface', classifyPath('src/__snapshots__/a.snap').testSurface);
    check('V6: CI configuration is high risk', classifyPath('.github/workflows/ci.yml').highRisk);
    check('V7: an unrecognised path is unknown, not assumed harmless',
      classifyPath('weird/thing.qqq').surface === 'unknown');
  }

  section('Q. mixed diff: a text label and a session helper');
  {
    const diff = parseDiff(diffFor([
      { path: 'src/components/Header.tsx', removed: ['  <span>Sign in</span>'], added: ['  <span>Log in</span>'] },
      { path: 'src/lib/session.ts', removed: ['  const ttl = 3600;'], added: ['  const ttl = 86400;'] },
    ]));
    const d = resolveTier({ diff, adapterId: 'node', confidence: 'KNOWN' });
    check('VAL-Q1: the tier is DEEP — the maximum, not the average', d.tier === 'DEEP');
    check('VAL-Q2: FAST is refused because not every hunk qualified', d.fastEligible === false);
    check('VAL-Q3: per-hunk classification is recorded for both surfaces',
      d.perHunk.length === 2 &&
      d.perHunk.some((h) => h.file === 'src/components/Header.tsx' && h.tier === 'FAST') &&
      d.perHunk.some((h) => h.file === 'src/lib/session.ts' && h.tier === 'DEEP'));
    check('VAL-Q4: the decision names the hunk that set the tier',
      d.reasons.some((r) => r.includes('src/lib/session.ts')));
    check('VAL-Q5: a label change on its own really would be FAST',
      resolveTier({
        diff: parseDiff(diffFor([{ path: 'src/components/Header.tsx', removed: ['  <span>Sign in</span>'], added: ['  <span>Log in</span>'] }])),
        adapterId: 'node', confidence: 'KNOWN',
      }).tier === 'FAST');
    check('VAL-Q6: bundling cannot lower a tier — only raise it',
      maxTier('FAST', 'DEEP') === 'DEEP' && maxTier('DEEP', 'FAST') === 'DEEP');
  }

  section('§2. any test-surface change is at least NORMAL');
  {
    const diff = parseDiff(diffFor([
      { path: 'docs/readme-extra.md', added: ['a line of prose'] },
      { path: 'test/util.spec.ts', added: ["  expect(sum(1,2)).toBe(3);"] },
    ]));
    const d = resolveTier({ diff, adapterId: 'node', confidence: 'KNOWN' });
    check('TS1: a docs change plus a test change is NORMAL, never FAST', d.tier === 'NORMAL');
    check('TS2: the escalation names the rule and the file',
      d.escalations.some((e) => e.rule === 'testSurfaceRisk') || d.perHunk.some((h) => h.testSurface));
    check('TS3: the changed test files are listed for the reviewer',
      d.testSurfaceFiles.includes('test/util.spec.ts'));
    check('TS4: the rule cannot be switched off',
      resolveTier({ diff, adapterId: 'node', confidence: 'KNOWN',
        hardening: { testSurfaceRisk: false, mixedDiffMaxTier: false } }).tier === 'NORMAL');
  }

  section('R. a failing test is deleted with no justification');
  {
    const diff = parseDiff(diffFor([
      { path: 'test/payments.spec.ts', status: 'deleted', removed: ["  it('refunds on cancel', () => { expect(refund()).toBe(true); });"] },
      { path: 'src/payments.ts', added: ['  // simplified'] },
    ]));
    const contract = designContract({ requiredTests: ['npm test'], plan: 'fix refunds' });
    const r = inspectIntegrity(diff, contract);
    check('VAL-R1: deleting a test with no justification is a blocking finding',
      r.blocking.some((f) => f.code === 'TEST_DELETED_WITHOUT_JUSTIFICATION'));
    check('VAL-R2: the finding names the file and quotes the evidence',
      r.blocking[0].file === 'test/payments.spec.ts' && r.blocking[0].evidence.length > 0);
    check('VAL-R3: the removed test is recorded by name',
      r.testsRemoved.some((t) => t.includes('refunds on cancel')));

    const justified = inspectIntegrity(diff, designContract({
      requiredTests: ['npm test'],
      testChangeJustifications: [{ path: 'test/payments.spec.ts', reason: 'the refund flow was removed from the product in this task' }],
    }));
    check('VAL-R4: an explicit, per-path justification in the design clears it',
      !justified.blocking.some((f) => f.code === 'TEST_DELETED_WITHOUT_JUSTIFICATION'));
    check('VAL-R5: a justification for a DIFFERENT file does not clear it',
      inspectIntegrity(diff, designContract({
        requiredTests: ['npm test'],
        testChangeJustifications: [{ path: 'test/other.spec.ts', reason: 'unrelated cleanup of an obsolete suite' }],
      })).blocking.length > 0);
    check('VAL-R6: a one-word "justification" is not a justification',
      designContract({ testChangeJustifications: [{ path: 'test/a.ts', reason: 'cleanup' }] }).testChangeJustifications.length === 0);
  }

  section('S. .skip is added to a previously passing test');
  {
    const diff = parseDiff(diffFor([{
      path: 'test/checkout.spec.ts',
      removed: ["  it('charges the card', async () => {"],
      added: ["  it.skip('charges the card', async () => {"],
    }]));
    const r = inspectIntegrity(diff, designContract({ requiredTests: ['npm test'] }));
    check('VAL-S1: the skip is detected and surfaced', r.testsDisabled.length === 1);
    check('VAL-S2: the annotation and the test name are both captured',
      r.testsDisabled[0].annotation === '.skip' && r.testsDisabled[0].name === 'charges the card');
    check('VAL-S3: it is raised for the reviewer explicitly',
      r.findings.some((f) => f.code === 'TEST_DISABLED' && f.severity === 'REVIEW'));
    check('VAL-S4: the change also marks the test surface as changed',
      r.findings.some((f) => f.code === 'TEST_SURFACE_CHANGED'));

    const other = parseDiff(diffFor([
      { path: 'test/a.spec.ts', added: ['  xit("later", () => {});'] },
      { path: 'tests/b_test.py', added: ['@pytest.mark.skip'] },
      { path: 'pkg/c_test.go', added: ['\tt.Skip("flaky")'] },
    ]));
    const r2 = inspectIntegrity(other, designContract({}));
    check('VAL-S5: xit, pytest skip marks and t.Skip are all recognised',
      r2.testsDisabled.length === 3);
  }

  section('T. the implementer renames a required test');
  {
    const contract = designContract({ requiredTests: ['npx jest tests/auth.spec.ts', 'npm run typecheck'] });
    check('T1: paths are extracted from the required-test command',
      pathsReferencedBy('npx jest tests/auth.spec.ts').includes('tests/auth.spec.ts'));

    const renamed = parseDiff(diffFor([{
      path: 'tests/auth.old.spec.ts', oldPath: 'tests/auth.spec.ts', status: 'renamed', added: [], removed: [],
    }]));
    const r = inspectIntegrity(renamed, contract);
    check('T2: renaming a required test is REQUIRED_TEST_TAMPERED',
      r.blocking.some((f) => f.code === 'REQUIRED_TEST_TAMPERED'));
    check('T3: the finding quotes the required-test command it breaks',
      r.blocking[0].evidence.some((e) => e.includes('tests/auth.spec.ts')));

    const deleted = parseDiff(diffFor([{ path: 'tests/auth.spec.ts', status: 'deleted', removed: ['  it("x", () => {});'] }]));
    check('T4: deleting a required test is the same refusal',
      inspectIntegrity(deleted, contract).blocking.some((f) => f.code === 'REQUIRED_TEST_TAMPERED'));
    check('T5: a justification does NOT clear required-test tampering — the contract is immutable',
      inspectIntegrity(deleted, designContract({
        requiredTests: ['npx jest tests/auth.spec.ts'],
        testChangeJustifications: [{ path: 'tests/auth.spec.ts', reason: 'I decided this test was no longer useful' }],
      })).blocking.some((f) => f.code === 'REQUIRED_TEST_TAMPERED'));
    check('T6: touching a file the required tests depend on is flagged for review',
      evidenceCoupledFiles(parseDiff(diffFor([{ path: 'tests/auth.spec.ts', added: ['  // note'] }])), contract)
        .includes('tests/auth.spec.ts'));
  }

  section('assertions weakened without justification');
  {
    const diff = parseDiff(diffFor([{
      path: 'test/order.spec.ts',
      removed: ['    expect(total).toBe(42);', '    expect(tax).toBe(7);'],
      added: ['    expect(total).toBeDefined();'],
    }]));
    const r = inspectIntegrity(diff, designContract({ requiredTests: ['npm test'] }));
    check('W1: removing more assertions than are added is blocking',
      r.blocking.some((f) => f.code === 'ASSERTION_WEAKENED_WITHOUT_JUSTIFICATION'));
    check('W2: a brand-new test file is not accused of weakening anything',
      !inspectIntegrity(parseDiff(diffFor([{ path: 'test/new.spec.ts', status: 'added', added: ['  expect(1).toBe(1);'] }])),
        designContract({})).blocking.length);
  }

  section('U. UNKNOWN confidence with a lockfile change');
  {
    const diff = parseDiff(diffFor([{ path: 'pnpm-lock.yaml', added: ['  lodash: 4.17.21'] }]));
    const d = resolveTier({ diff, adapterId: 'node', confidence: 'UNKNOWN' });
    check('U1: it goes straight to DEEP', d.tier === 'DEEP');
    check('U2: the escalation says it was direct, not gradual',
      d.escalations.some((e) => e.rule === 'unknownPlusRiskDirectDeep' && /directly/.test(e.detail))
      || d.perHunk.every((h) => h.tier === 'DEEP'));
    check('U3: UNKNOWN on a harmless surface is NOT escalated to DEEP',
      resolveTier({ diff: parseDiff(diffFor([{ path: 'docs/guide.md', added: ['prose'] }])),
        adapterId: 'node', confidence: 'UNKNOWN' }).tier !== 'DEEP');
    check('U4: a generic adapter can never report KNOWN confidence',
      impactConfidence(diff, 'generic') === 'UNKNOWN');
    check('U5: an unparseable diff is UNKNOWN and validated at DEEP',
      impactConfidence({ files: [], unparsed: true }, 'node') === 'UNKNOWN' &&
      resolveTier({ diff: { files: [], unparsed: true }, adapterId: 'node', confidence: 'UNKNOWN' }).tier === 'DEEP');
  }

  section('V. a checkpoint failure that does not reproduce');
  {
    const intermittent: RetryAttempt[] = [
      { attempt: 1, passed: false, conclusive: true, detail: 'failed' },
      { attempt: 2, passed: true, conclusive: true, detail: 'passed' },
    ];
    const flake = attribute({ taskId: 'p/T-0001', checkName: 'unit-test', originalFailure: 'assert', attempts: intermittent });
    check('VAL-V1-2: intermittent is SUSPECTED_FLAKE, not VALIDATION_MISS',
      flake.attribution === 'SUSPECTED_FLAKE');
    check('VAL-V2-2: a flake is recorded against the test, not the task',
      flake.attributedToTask === false);
    check('VAL-V3-2: a flake may never tune the impact analyzer',
      flake.influencesImpactAnalyzer === false);

    const consistent: RetryAttempt[] = [
      { attempt: 1, passed: false, conclusive: true, detail: 'failed' },
      { attempt: 2, passed: false, conclusive: true, detail: 'failed' },
    ];
    const miss = attribute({ taskId: 'p/T-0001', checkName: 'unit-test', originalFailure: 'assert', attempts: consistent });
    check('VAL-V4-2: consistent failure is VALIDATION_MISS and stays attributed',
      miss.attribution === 'VALIDATION_MISS' && miss.attributedToTask && miss.influencesImpactAnalyzer);
    check('VAL-V5-2: a flake verdict cannot suppress a real miss — they are different inputs',
      miss.attribution !== flake.attribution && miss.attributedToTask !== flake.attributedToTask);

    const inconclusive = attribute({ taskId: 'p/T-0001', checkName: 'unit-test', originalFailure: 'oom',
      attempts: [{ attempt: 1, passed: false, conclusive: false, detail: 'infrastructure failure' }] });
    check('V6-2: an infrastructure failure during retry proves nothing and the failure stays attributed',
      inconclusive.attribution === 'INCONCLUSIVE' && inconclusive.attributedToTask);

    let runs = 0;
    const byRetry = await attributeByRetry(
      { taskId: 'p/T-0002', checkName: 'e2e', originalFailure: 'timeout' },
      async (n) => { runs += 1; return { passed: n === 2, conclusive: true, detail: `attempt ${n}` }; },
      4,
    );
    check('V7-2: the retry loop stops as soon as intermittency is proven',
      byRetry.attribution === 'SUSPECTED_FLAKE' && runs === 2);

    const records = ['e2e', 'e2e', 'e2e', 'unit'].map((c, i) => ({ checkName: c, taskId: `p/T-000${i}`, at: '2026-01-01' }));
    const rel = reliabilityFindings(records);
    check('V8: a repeatedly flaky test surfaces TEST_RELIABILITY',
      rel.length === 1 && rel[0].checkName === 'e2e' && rel[0].occurrences === 3);
  }

  section('W. the generic adapter cannot claim FAST');
  {
    const code = parseDiff(diffFor([{ path: 'app/thing.rb', removed: ['  x = 1'], added: ['  x = 2'] }]));
    const d = resolveTier({ diff: code, adapterId: 'generic', confidence: 'UNKNOWN' });
    check('W1-2: a small code change under the generic adapter is NORMAL, not FAST', d.tier === 'NORMAL');
    check('W2-2: the reason names the adapter, so it is not mistaken for a path rule',
      d.escalations.some((e) => e.rule === 'genericAdapterFloor'));

    const docs = parseDiff(diffFor([{ path: 'docs/intro.md', added: ['prose'] }]));
    check('W3: documentation-only under the generic adapter may still be FAST',
      resolveTier({ diff: docs, adapterId: 'generic', confidence: 'UNKNOWN' }).tier === 'FAST');

    const comments = parseDiff(diffFor([{ path: 'app/thing.rb', removed: ['  # old note'], added: ['  # new note'] }]));
    check('W4: a comment-only diff under the generic adapter may still be FAST',
      resolveTier({ diff: comments, adapterId: 'generic', confidence: 'UNKNOWN' }).tier === 'FAST');
    check('W5: an ecosystem adapter keeps full FAST capability',
      resolveTier({ diff: parseDiff(diffFor([{ path: 'src/pages/About.tsx', removed: ['  <p>a</p>'], added: ['  <p>b</p>'] }])),
        adapterId: 'node', confidence: 'KNOWN' }).tier === 'FAST');
    check('W6: comment detection refuses to guess in an unknown language',
      !isCommentOnly('thing.qqq', ['# maybe a comment']));
  }

  section('X/Y. the reviewer asks for more validation');
  {
    const state: ExpansionState = { granted: 0, budget: 2, findingsPerExpansion: [] };

    const vague = evaluateExpansion({ behavior: 'run everything to be safe' }, state);
    check('VAL-X1: a request naming no behaviour is rejected',
      !vague.accepted && vague.code === 'REVIEW_EXPANSION_VAGUE');
    check('VAL-X2: the rejection is recorded with the request itself',
      vague.request.behavior === 'run everything to be safe' && vague.detail.length > 20);
    check('VAL-X3: the rejection explains what a good request looks like',
      /session refresh|name the behaviour/i.test(vague.detail));
    check('VAL-X4: "not sure, just run the full suite" is also rejected',
      !evaluateExpansion({ behavior: 'not sure what this affects, full regression please' }, state).accepted);

    const concrete = evaluateExpansion({ behavior: 'session refresh may break for expired tokens' }, state);
    check('VAL-Y1: a request naming a concrete behaviour is accepted',
      concrete.accepted && concrete.code === 'REVIEW_EXPANSION_ACCEPTED');
    check('VAL-Y2: it counts against the budget', /1\/2/.test(concrete.detail));

    const d = resolveTier({ diff: parseDiff(diffFor([{ path: 'src/pages/A.tsx', added: ['<p>x</p>'] }])), adapterId: 'node', confidence: 'KNOWN' });
    check('VAL-Y3: an accepted expansion escalates the tier',
      applyExpansion(d, { behavior: 'session refresh may break' }).tier === escalate(d.tier));

    const spent: ExpansionState = { granted: 2, budget: 2, findingsPerExpansion: [0, 0] };
    const over = evaluateExpansion({ behavior: 'token refresh may double-charge on retry' }, spent);
    check('VAL-Y4: past the budget it is refused, not silently honoured',
      !over.accepted && over.code === 'REVIEW_EXPANSION_BUDGET_EXHAUSTED');
    check('VAL-Y5: the refusal is still recorded', over.request.behavior.length > 0);
    check('VAL-Y6: repeated expansion with no findings is reported as unproductive',
      unproductiveExpansion(spent)?.code === 'REVIEW_EXPANSION_UNPRODUCTIVE');
    check('VAL-Y7: productive expansions are not reported as unproductive',
      unproductiveExpansion({ granted: 2, budget: 2, findingsPerExpansion: [1, 0] }) === null);
    check('Y8: a wordy request with a real identifier still counts as concrete',
      assessConcreteness({ behavior: 'run everything, because the sessionRefresh path may be affected' }).concrete);
  }

  section('Z. the integration target moved under a verified task');
  {
    const rebasedDiff = diffFor([
      { path: 'src/lib/session.ts', added: ['  const ttl = 86400;'] },
      { path: 'src/pages/Home.tsx', added: ['  <p>hi</p>'] },
    ]);
    const git = (intervening: string[], conflicts: string[] = []): GitAccess => ({
      headOf: () => 'yyyyyyyyyyyy',
      filesChangedBetween: () => intervening,
      rebase: () => (conflicts.length
        ? { ok: false, conflicts, detail: 'conflict' }
        : { ok: true, conflicts: [], detail: 'rebased' }),
      diffAgainst: () => rebasedDiff,
    });
    const common = {
      integrationRef: 'main', verifiedAgainst: 'xxxxxxxxxxxx',
      originalTier: TIERS('NORMAL'), adapterId: 'node', confidence: 'KNOWN' as const,
      commands: { typecheck: 'tsc', unitTest: 'jest', lint: 'eslint', build: 'tsc -b', integrationTest: 'jest --i' },
    };

    const overlapping = revalidateForIntegration({ ...common, git: git(['src/lib/session.ts', 'README.md']) });
    check('Z1: the overlap is identified precisely',
      overlapping.overlap.length === 1 && overlapping.overlap[0] === 'src/lib/session.ts');
    check('Z2: impact is recomputed on the REBASED diff, not the original',
      overlapping.decision !== null && overlapping.decision!.perHunk.length === 2);
    check('Z3: overlap escalates exactly one tier before integration',
      overlapping.escalated && overlapping.tier === 'DEEP');
    check('Z4: the plan says what must rerun, floor included',
      overlapping.plan!.floor.includes('unit-test') && overlapping.plan!.additional.includes('integration-test'));

    const disjoint = revalidateForIntegration({ ...common, git: git(['docs/other.md']) });
    check('Z5: no overlap means revalidation but no escalation',
      disjoint.code === 'REVALIDATION_REQUIRED' && !disjoint.escalated && disjoint.overlap.length === 0);
    check('Z6: the floor still reruns even with no overlap', disjoint.plan!.floor.length > 0);

    const unmoved: GitAccess = { ...git([]), headOf: () => 'xxxxxxxxxxxx' };
    check('Z7: an unmoved target needs no revalidation',
      revalidateForIntegration({ ...common, git: unmoved }).code === 'REVALIDATION_NOT_NEEDED');

    const conflicted = revalidateForIntegration({ ...common, git: git(['src/lib/session.ts'], ['src/lib/session.ts']) });
    check('Z8: a rebase conflict is a human decision, not something to validate around',
      conflicted.code === 'REVALIDATION_CONFLICT' && conflicted.conflicts.length === 1 && conflicted.plan === null);
    check('Z9: overlap is computed path-wise and conservatively',
      overlapBetween(parseDiff(rebasedDiff), ['src/lib/session.ts']).length === 1);
  }

  section('AA. zero-touch telemetry');
  {
    const clean = [
      ev('p/T-1', 'TASK_CREATED', { description: 'x' }, '2026-01-01T00:00:00.000Z'),
      ev('p/T-1', 'VALIDATION_PLAN', { tier: 'FAST' }, '2026-01-01T00:00:01.000Z'),
      ev('p/T-1', 'STATE_CHANGED', { to: 'COMPLETED' }, '2026-01-01T00:05:00.000Z'),
    ];
    const t1 = taskTelemetry('p/T-1', clean);
    check('AA1: a task with no interventions and no regressions is zero-touch clean',
      t1.zeroTouchClean && t1.humanInterventionCount === 0 && t1.attributedRegressions === 0);
    check('AA2: wall clock is measured start to finish', t1.wallClockMs === 300_000);
    check('AA3: the tier it was validated at is recorded', t1.validationTier === 'FAST');

    const touched = [
      ev('p/T-2', 'TASK_CREATED', { description: 'y' }, '2026-01-01T00:00:00.000Z'),
      ev('p/T-2', 'STATE_CHANGED', { to: 'AWAITING_HUMAN', reason: 'MISSING_CREDENTIAL: needs DATABASE_URL' }, '2026-01-01T00:01:00.000Z'),
      ev('p/T-2', 'STATE_CHANGED', { to: 'COMPLETED' }, '2026-01-01T00:09:00.000Z'),
    ];
    const t2 = taskTelemetry('p/T-2', touched);
    check('AA4: entering a human-attention state counts as an intervention, even without an explicit event',
      t2.humanInterventionCount === 1 && !t2.zeroTouchClean);
    check('AA5: the reason is captured for the metric breakdown',
      t2.interventionReasons[0].startsWith('MISSING_CREDENTIAL'));

    const regressed = [
      ev('p/T-3', 'TASK_CREATED', { description: 'z' }, '2026-01-01T00:00:00.000Z'),
      ev('p/T-3', 'STATE_CHANGED', { to: 'COMPLETED' }, '2026-01-01T00:04:00.000Z'),
      ev('p/T-3', 'REGRESSION_ATTRIBUTED', { attribution: 'VALIDATION_MISS', checkName: 'e2e' }, '2026-01-02T00:00:00.000Z'),
    ];
    const t3 = taskTelemetry('p/T-3', regressed);
    check('AA6: an untouched task that later caused a regression is NOT clean',
      t3.humanInterventionCount === 0 && t3.attributedRegressions === 1 && !t3.zeroTouchClean);

    const flaked = [
      ev('p/T-4', 'TASK_CREATED', { description: 'f' }, '2026-01-01T00:00:00.000Z'),
      ev('p/T-4', 'STATE_CHANGED', { to: 'COMPLETED' }, '2026-01-01T00:03:00.000Z'),
      ev('p/T-4', 'REGRESSION_ATTRIBUTED', { attribution: 'SUSPECTED_FLAKE', checkName: 'e2e' }, '2026-01-02T00:00:00.000Z'),
    ];
    const t4 = taskTelemetry('p/T-4', flaked);
    check('AA7: a flake does not cost a task its clean record',
      t4.suspectedFlakes === 1 && t4.attributedRegressions === 0 && t4.zeroTouchClean);

    const m = zeroTouchCleanRate([t1, t2, t3, t4]);
    check('AA8: the rate counts only completed tasks with 0 interventions and 0 regressions',
      m.completed === 4 && m.clean === 2 && m.rate === 0.5);
    check('AA9: the breakdown says which half of the metric was lost',
      m.withIntervention === 1 && m.withRegression === 1);
    check('AA10: intervention reasons are grouped by code for action',
      m.topInterventionReasons[0].reason === 'MISSING_CREDENTIAL');
    check('AA11: with no completed tasks the rate is "not yet", never 0%',
      zeroTouchCleanRate([]).rate === null && /n\/a/.test(formatZeroTouch(zeroTouchCleanRate([]))));
    check('AA12: the formatted metric states both halves of the claim',
      /0 interventions, 0 attributed regressions/.test(formatZeroTouch(m)));
  }

  section('AB. escalation payload completeness');
  {
    check('AB1: a bare "needs attention" is a failure, not a message',
      validateEscalation({ taskId: 'p/T-1', reasonCode: 'MISSING_CREDENTIAL', blocked: 'Task needs attention.' })
        .some((p) => p.field === 'blocked'));
    check('AB2: an empty payload fails on every required field',
      validateEscalation({}).length >= 6);

    const { payload, problems } = escalation({
      taskId: 'p/T-0042', reasonCode: 'MISSING_CREDENTIAL',
      blocked: 'the migration cannot run because the staging database URL is not available in this environment',
      tried: ['environment discovery', 'adapter configuration', 'the project .env file'],
      evidence: [
        { kind: 'check', id: 'migrate', detail: 'exited 1: could not connect' },
        { kind: 'event', id: 'CHECK_RESULT', detail: 'command and output tail' },
      ],
      needed: {
        kind: 'credential',
        description: 'the staging DATABASE_URL',
        how: 'set it in the environment Zeus runs in',
        example: 'postgres://user:pass@host:5432/db',
      },
      resumeBehavior: 'validation resumes automatically from the migration step',
    });
    check('AB3: a complete payload validates', problems.length === 0 && isComplete(payload));

    const rendered = renderEscalation(payload);
    check('AB4: the rendered form names the task, the block and the specific need',
      rendered.includes('p/T-0042') && /staging database URL/.test(rendered) && /Needed: the staging DATABASE_URL/.test(rendered));
    check('AB5: it says what happens on receipt, so the human knows the cost',
      /On receipt: validation resumes automatically/.test(rendered));
    check('AB6: it carries the machine-readable reason code',
      /Reason code: MISSING_CREDENTIAL/.test(rendered));
    check('AB7: it lists what was already tried, so nobody repeats it',
      /Tried: environment discovery; adapter configuration/.test(rendered));
    check('AB8: it is short enough to act on from a phone',
      rendered.split('\n').length <= 8);
    check('AB9: no example value is mistaken for a real credential',
      !isComplete({ ...payload, needed: { kind: 'credential', description: '' } }));
    check('AB10: evidence is required — an escalation with nothing to look at is refused',
      validateEscalation({ ...payload, evidence: [] }).some((p) => p.field === 'evidence'));
  }

  section('configuration: the anti-gaming rules are not preferences');
  {
    const cfg: any = defaultConfig(TMP);
    check('VAL-C1: a new project gets the fastest-safe profile',
      cfg.validation.strategy === 'fastest-safe' && cfg.validation.hardening.reviewerExpansionBudget === 2);
    check('VAL-C2: the defaults enable every hardening rule',
      cfg.validation.hardening.mixedDiffMaxTier && cfg.validation.hardening.testSurfaceRisk
      && cfg.validation.hardening.unknownPlusRiskDirectDeep);
    check('VAL-C3: the generic-adapter floor defaults to normal',
      cfg.validation.hardening.genericAdapterFloor === 'normal');

    const disabled = JSON.parse(JSON.stringify(cfg));
    disabled.validation.hardening.mixedDiffMaxTier = false;
    check('VAL-C4: trying to disable mixed-diff resolution is a config ERROR, not a silent no-op',
      validateConfig(disabled).some((p) => p.level === 'error' && /mixedDiffMaxTier/.test(p.message)));
    disabled.validation.hardening.mixedDiffMaxTier = true;
    disabled.validation.hardening.testSurfaceRisk = false;
    check('VAL-C5: the same for test-surface risk',
      validateConfig(disabled).some((p) => p.level === 'error' && /testSurfaceRisk/.test(p.message)));

    const fastFloor = JSON.parse(JSON.stringify(cfg));
    fastFloor.validation.hardening.genericAdapterFloor = 'fast';
    check('VAL-C6: the generic adapter may not be given a FAST floor',
      validateConfig(fastFloor).some((p) => p.level === 'error' && /genericAdapterFloor/.test(p.message)));

    const badStrategy = JSON.parse(JSON.stringify(cfg));
    badStrategy.validation.strategy = 'yolo';
    check('VAL-C7: an unknown validation strategy is rejected',
      validateConfig(badStrategy).some((p) => p.level === 'error' && /validation\.strategy/.test(p.message)));

    const bigBudget = JSON.parse(JSON.stringify(cfg));
    bigBudget.validation.hardening.reviewerExpansionBudget = 9;
    check('VAL-C8: a very large expansion budget is warned about, not silently accepted',
      validateConfig(bigBudget).some((p) => p.level === 'warning' && /reviewerExpansionBudget/.test(p.message)));
  }

  section('the deterministic floor stays authoritative at every tier');
  {
    const cmds = { typecheck: 'tsc', unitTest: 'jest', lint: 'eslint', build: 'tsc -b', integrationTest: 'jest --i' };
    const fast = planFor('FAST', cmds);
    const deep = planFor('DEEP', cmds);
    check('F1: FAST still runs the whole required floor',
      fast.floor.includes('typecheck') && fast.floor.includes('unit-test'));
    check('F2: FAST adds nothing on top', fast.additional.length === 0);
    check('F3: DEEP adds to the floor, it does not replace it',
      deep.floor.join() === fast.floor.join() && deep.additional.includes('integration-test'));
    check('F4: a tier can never shrink the floor',
      (['FAST', 'NORMAL', 'DEEP'] as Tier[]).every((t) => planFor(t, cmds).floor.length === fast.floor.length));

    check('F5: the honest accounting keeps modified tests separate from untouched ones',
      accountForTests([{ name: 'unit-test', outcome: 'PASSED' }], ['test/a.spec.ts']).modifiedThenPassed.length === 1);
    check('F6: with no test-surface change everything is simply "passed"',
      accountForTests([{ name: 'unit-test', outcome: 'PASSED' }], []).passed.length === 1);
    check('F7: the summary never folds the two categories together',
      /passed after this task modified the test surface/
        .test(accountForTests([{ name: 'unit-test', outcome: 'PASSED' }], ['test/a.spec.ts']).summary));
    check('F8: a failing check is in neither category',
      accountForTests([{ name: 'unit-test', outcome: 'TEST_FAILED' }], []).passed.length === 0);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
