/**
 * LANE D — validation, false-green paths, reviewer independence.
 *
 * Charter §8–§13, §31, §35.
 *
 * This lane asks one question in many forms: can a change reach COMPLETED
 * without the platform having actually looked at it? Every other safeguard in
 * Zeus assumes the diff it classifies is the change that happened. If that
 * assumption can be broken, the tier system, the anti-gaming rules and the
 * reviewer are all reasoning about a fiction.
 */

import * as path from 'path';
import { LaneSpec, ProbeContext, held, defect } from './types';
import { git, repo, write, run, evidence, compare, fromAudit } from './kit';

const SECTIONS = [
  { id: '§8', title: 'Validation tier selection integrity' },
  { id: '§9', title: 'Deterministic floor authority' },
  { id: '§10', title: 'Change visibility — what actually gets validated' },
  { id: '§11', title: 'Evidence-chain integrity (anti-gaming)' },
  { id: '§12', title: 'Reviewer independence enforcement' },
  { id: '§13', title: 'Acceptance semantics and outcome vocabulary' },
  { id: '§31', title: 'Telemetry honesty' },
  { id: '§35', title: 'Escalation completeness' },
];

export const laneD: LaneSpec = {
  lane: 'D',
  title: 'Validation / false-green / review independence',
  sections: SECTIONS,
  probes: [
    // ---------------------------------------------------------------------
    {
      id: 'D1', section: '§10',
      title: 'a newly added file is visible to the classifier',
      run(ctx: ProbeContext) {
        const root = repo(path.join(ctx.tmp, 'd1'), { 'a.ts': 'export const a = 1;\n' });
        const wt = path.join(ctx.tmp, 'd1-wt');
        git(root, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
        // An implementer adds a new module and a new test. Nothing is staged,
        // which is exactly what "the agent edited the worktree" looks like.
        write(path.join(wt, 'src/session.ts'), 'export const ttl = 86400;\n');
        write(path.join(wt, 'test/new.spec.ts'), 'it.skip("critical", () => {});\n');

        const seenByDiff = git(wt, ['diff', '--stat', '-p']);
        const seenByStatus = git(wt, ['status', '--porcelain']);
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { resolveTier } = fromAudit(ctx.auditRoot, 'validation/tier');
        const decision = resolveTier({ diff: parseDiff(seenByDiff), adapterId: 'node', confidence: 'KNOWN' });

        const observed = compare([
          ['files on disk', 'src/session.ts (auth-session), test/new.spec.ts (test surface, .skip)'],
          ['git status --porcelain', JSON.stringify(seenByStatus.trim())],
          ['git diff (what Engine.diff() returns)', JSON.stringify(seenByDiff.trim())],
          ['hunks classified', String(decision.perHunk.length)],
          ['resolved tier', decision.tier],
          ['testSurfaceFiles', JSON.stringify(decision.testSurfaceFiles)],
        ]);

        if (decision.perHunk.length > 0) return held(observed);
        return defect(observed, {
          sections: ['§10', '§8', '§11'],
          severity: 'P0',
          title: 'Added files are invisible to validation, integrity and review',
          detail:
            'Engine.diff() runs `git diff`, which reports tracked, unstaged modifications only. '
            + 'A file the implementer CREATES is untracked, so it appears in changedFiles() (git status --porcelain) '
            + 'but contributes nothing to the parsed diff. The tier is therefore resolved over zero hunks, '
            + 'inspectIntegrity() sees no test-surface change, and the reviewer receives a diff that omits the new code entirely.',
          impact:
            'Every anti-gaming protection is bypassed by putting the change in a new file: a new auth module is never '
            + 'classified high-risk, a new test arriving pre-skipped is never surfaced, and the independent reviewer '
            + 'reviews an empty diff while reporting on the task. This is the false-green mode the hardening work exists to prevent.',
        });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D2', section: '§10',
      title: 'work the implementer committed is still validated',
      run(ctx: ProbeContext) {
        const root = repo(path.join(ctx.tmp, 'd2'), { 'a.ts': 'export const a = 1;\n' });
        const wt = path.join(ctx.tmp, 'd2-wt');
        git(root, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
        write(path.join(wt, 'a.ts'), 'export const a = 2;\n');
        write(path.join(wt, 'src/auth.ts'), 'export const bypass = true;\n');
        git(wt, ['add', '-A']);
        git(wt, ['commit', '-qm', 'agent work']);

        const seenByDiff = git(wt, ['diff', '--stat', '-p']);
        const seenByStatus = git(wt, ['status', '--porcelain']);
        const truth = git(wt, ['diff', '--name-only', 'HEAD~1']).trim().split('\n').filter(Boolean);
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { resolveTier } = fromAudit(ctx.auditRoot, 'validation/tier');
        const { inspectIntegrity, designContract } = fromAudit(ctx.auditRoot, 'validation/integrity');
        const parsed = parseDiff(seenByDiff);
        const decision = resolveTier({ diff: parsed, adapterId: 'node', confidence: 'KNOWN' });
        const integrity = inspectIntegrity(parsed, designContract({ requiredTests: ['npm test'] }));

        const observed = compare([
          ['files actually changed', JSON.stringify(truth)],
          ['git status --porcelain (changedFiles)', JSON.stringify(seenByStatus.trim())],
          ['git diff (Engine.diff)', JSON.stringify(seenByDiff.trim())],
          ['hunks classified', String(decision.perHunk.length)],
          ['tier', decision.tier],
          ['integrity findings', String(integrity.findings.length)],
        ]);

        if (decision.perHunk.length > 0) return held(observed);
        return defect(observed, {
          sections: ['§10', '§8', '§11', '§12'],
          severity: 'P0',
          title: 'A committing implementer makes the entire change invisible',
          detail:
            'If the implementation agent commits its work in the task worktree — normal agent behaviour — then '
            + 'both `git status --porcelain` and `git diff` are empty. CODE_CHANGE records zero files changed, '
            + 'VALIDATION_PLAN classifies zero hunks, EVIDENCE_INTEGRITY inspects nothing, and the reviewer is '
            + 'handed an empty diff. The task can then reach COMPLETED having validated a change nobody looked at.',
          impact:
            'This is a complete bypass of adaptive validation, all anti-gaming protections and reviewer '
            + 'independence, triggered by an action agents take routinely. A deleted required test would go '
            + 'undetected. It is the highest-severity class of defect in the product: a confident, green, dishonest result.',
        });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D3', section: '§12',
      title: 'the reviewer is told when its diff was truncated',
      run(ctx: ProbeContext) {
        const src = fromAudit<string>(ctx.auditRoot, '../src/engine/orchestrator') && '';
        void src;
        const fs2 = require('fs');
        const text: string = fs2.readFileSync(path.join(ctx.auditRoot, 'src/engine/orchestrator.ts'), 'utf8');
        const m = /content:\s*diff\.slice\(0,\s*(\d+)\)/.exec(text);
        const limit = m ? Number(m[1]) : null;
        const announced = /truncat/i.test(text);

        const observed = compare([
          ['reviewer diff section', m ? `diff.slice(0, ${limit})` : 'not truncated'],
          ['truncation announced to the reviewer', String(announced)],
        ]);

        if (!m || announced) return held(observed);
        return defect(observed, {
          sections: ['§12', '§10'],
          severity: 'P1',
          title: 'The reviewer\'s diff is silently truncated',
          detail:
            `The review payload contains diff.slice(0, ${limit}) with no marker saying the diff was cut. `
            + 'A change larger than that limit is reviewed on its first portion only, and the reviewer has no '
            + 'way to know it is looking at a fragment.',
          impact:
            'On any large change the reviewer can report "no findings" having seen a fraction of it, and that '
            + 'verdict is recorded as an independent review of the whole change. Reviewer independence is preserved '
            + 'while reviewer sufficiency is not, which is arguably worse: the result looks corroborated.',
        });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D4', section: '§8',
      title: 'the tier is the maximum over hunks, and bundling cannot lower it',
      run(ctx: ProbeContext) {
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { resolveTier } = fromAudit(ctx.auditRoot, 'validation/tier');
        const mixed = [
          'diff --git a/src/components/H.tsx b/src/components/H.tsx',
          '--- a/src/components/H.tsx', '+++ b/src/components/H.tsx', '@@ -1 +1 @@',
          '-<span>Sign in</span>', '+<span>Log in</span>',
          'diff --git a/src/lib/session.ts b/src/lib/session.ts',
          '--- a/src/lib/session.ts', '+++ b/src/lib/session.ts', '@@ -1 +1 @@',
          '-const ttl = 3600;', '+const ttl = 86400;',
        ].join('\n');
        const d = resolveTier({ diff: parseDiff(mixed), adapterId: 'node', confidence: 'KNOWN' });
        const observed = compare([
          ['tier', d.tier], ['fastEligible', String(d.fastEligible)],
          ['per-hunk', d.perHunk.map((h: any) => `${h.file}=${h.tier}`).join(', ')],
        ]);
        return d.tier === 'DEEP' && !d.fastEligible
          ? held(observed)
          : defect(observed, {
            sections: ['§8'], severity: 'P0',
            title: 'Mixed-diff maximum not enforced',
            detail: 'A diff containing a high-risk hunk resolved below DEEP.',
            impact: 'An agent can buy a cheap validation path by bundling risky changes with harmless ones.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D5', section: '§8',
      title: 'moving a risky file into a docs path does not launder it',
      run(ctx: ProbeContext) {
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { resolveTier } = fromAudit(ctx.auditRoot, 'validation/tier');
        const laundering = [
          'diff --git a/src/lib/session.ts b/docs/session.md',
          'rename from src/lib/session.ts', 'rename to docs/session.md',
          '--- a/src/lib/session.ts', '+++ b/docs/session.md', '@@ -1 +1 @@',
          '-const ttl = 3600;', '+const ttl = 86400;',
        ].join('\n');
        const d = resolveTier({ diff: parseDiff(laundering), adapterId: 'node', confidence: 'KNOWN' });
        const observed = compare([['tier', d.tier], ['highRiskFiles', JSON.stringify(d.highRiskFiles)]]);
        return d.tier === 'DEEP'
          ? held(observed)
          : defect(observed, {
            sections: ['§8'], severity: 'P1',
            title: 'A rename into a documentation path lowers the tier',
            detail: 'Classification considered only the destination path, so moving a session module to docs/ made it cheap.',
            impact: 'Renaming is a one-line way to move any high-risk file onto the fast path.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D6', section: '§9',
      title: 'no tier can shrink the deterministic floor',
      run(ctx: ProbeContext) {
        const { planFor } = fromAudit(ctx.auditRoot, 'validation/tier');
        const cmds = { typecheck: 'tsc', unitTest: 'jest', lint: 'eslint', build: 'b', integrationTest: 'i' };
        const plans = ['FAST', 'NORMAL', 'DEEP'].map((t) => [t, planFor(t, cmds)] as const);
        const observed = plans.map(([t, p]) => `  ${t.padEnd(6)} floor=${JSON.stringify(p.floor)} additional=${JSON.stringify(p.additional)}`).join('\n');
        const floors = plans.map(([, p]) => p.floor.join(','));
        return new Set(floors).size === 1 && floors[0].includes('unit-test')
          ? held(observed)
          : defect(observed, {
            sections: ['§9'], severity: 'P0',
            title: 'The required floor varies by tier',
            detail: 'planFor produced different required checks at different tiers.',
            impact: 'A cheap tier could skip a required test, which is the definition of unearned confidence.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D7', section: '§11',
      title: 'required tests are immutable, and no justification clears tampering',
      run(ctx: ProbeContext) {
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { inspectIntegrity, designContract } = fromAudit(ctx.auditRoot, 'validation/integrity');
        const del = parseDiff([
          'diff --git a/tests/auth.spec.ts b/tests/auth.spec.ts',
          'deleted file mode 100644',
          '--- a/tests/auth.spec.ts', '+++ /dev/null', '@@ -1 +0,0 @@',
          '-it("rejects expired tokens", () => {});',
        ].join('\n'));
        const contract = designContract({
          requiredTests: ['npx jest tests/auth.spec.ts'],
          testChangeJustifications: [{ path: 'tests/auth.spec.ts', reason: 'I decided this test was no longer useful to keep' }],
        });
        const r = inspectIntegrity(del, contract);
        const tampered = r.blocking.filter((f: any) => f.code === 'REQUIRED_TEST_TAMPERED');
        const observed = compare([
          ['blocking findings', r.blocking.map((f: any) => f.code).join(', ') || '(none)'],
          ['REQUIRED_TEST_TAMPERED despite justification', String(tampered.length > 0)],
        ]);
        return tampered.length > 0
          ? held(observed)
          : defect(observed, {
            sections: ['§11'], severity: 'P0',
            title: 'A justification can dissolve the required-test contract',
            detail: 'Deleting a declared required test was cleared by a self-written justification.',
            impact: 'The implementer can retire any inconvenient required test by explaining itself.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D8', section: '§11',
      title: 'a justification for one test does not cover a different one',
      run(ctx: ProbeContext) {
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { inspectIntegrity, designContract } = fromAudit(ctx.auditRoot, 'validation/integrity');
        const d = parseDiff([
          'diff --git a/test/payments.spec.ts b/test/payments.spec.ts',
          'deleted file mode 100644',
          '--- a/test/payments.spec.ts', '+++ /dev/null', '@@ -1 +0,0 @@',
          '-it("refunds", () => {});',
        ].join('\n'));
        const wrongPath = inspectIntegrity(d, designContract({
          requiredTests: [],
          testChangeJustifications: [{ path: 'test/orders.spec.ts', reason: 'the orders suite was replaced by a broader one' }],
        }));
        const bareName = inspectIntegrity(d, designContract({
          requiredTests: [],
          testChangeJustifications: [{ path: 'spec.ts', reason: 'a deliberately loose path that should not match everything' }],
        }));
        const observed = compare([
          ['justification names a different file → blocking', String(wrongPath.blocking.length > 0)],
          ['justification is a bare suffix "spec.ts" → blocking', String(bareName.blocking.length > 0)],
        ]);
        return wrongPath.blocking.length > 0 && bareName.blocking.length > 0
          ? held(observed)
          : defect(observed, {
            sections: ['§11'], severity: 'P1',
            title: 'Justification path matching is too permissive',
            detail: 'A justification naming another file, or a bare suffix, cleared an unrelated test deletion.',
            impact: 'One vague justification licenses removing any test, which empties the rule of meaning.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D9', section: '§12',
      title: 'forbidden material smuggled inside an allowed section is refused',
      run(ctx: ProbeContext) {
        const { buildReviewPayload, DEFAULT_REVIEW_POLICY } = fromAudit(ctx.auditRoot, '../src/engine/reviewcontext');
        const p = buildReviewPayload({
          taskId: 't', projectId: 'p', baseSha: 'a', headSha: 'b',
          policy: DEFAULT_REVIEW_POLICY, header: 'review this',
          inputs: [
            { kind: 'task-requirement', label: 'TASK', content: 'do the thing' },
            // The planner's own output, hidden in a section labelled as a diff.
            { kind: 'diff', label: 'DIFF', content: '+ const x = 1;\n"scopeAllowlist": ["src/"]\n' },
          ],
        });
        const observed = compare([
          ['payload valid', String(p.valid)],
          ['violations', p.violations.map((v: any) => `${v.kind}: ${v.detail}`).join(' | ') || '(none)'],
          ['prompt withheld', String(p.valid === false)],
        ]);
        return !p.valid && p.violations.length > 0
          ? held(observed)
          : defect(observed, {
            sections: ['§12'], severity: 'P0',
            title: 'Planner output can be smuggled into the reviewer prompt',
            detail: 'A diff section carrying the planner design output passed the content scan.',
            impact: 'The reviewer becomes an echo of the planner while still reporting as independent.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D10', section: '§13',
      title: 'only a real PASSED verdict allows acceptance',
      run(ctx: ProbeContext) {
        const { checkAllowsAcceptance } = fromAudit(ctx.auditRoot, '../src/engine/orchestrator');
        const outcomes = ['PASSED', 'TEST_FAILED', 'TEST_TIMEOUT', 'RESOURCE_LIMIT_EXCEEDED', 'REQUIRED_TEST_NOT_RUN', 'INFRASTRUCTURE_FAILURE'];
        const table = outcomes.map((o) => `  ${o.padEnd(26)} ${checkAllowsAcceptance(o)}`).join('\n');
        const onlyPassed = outcomes.every((o) => checkAllowsAcceptance(o) === (o === 'PASSED'));
        return onlyPassed
          ? held(table)
          : defect(table, {
            sections: ['§13'], severity: 'P0',
            title: 'A non-verdict outcome allows acceptance',
            detail: 'An outcome other than PASSED was treated as permission to accept.',
            impact: 'A missing toolchain or a timeout becomes a green result.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D11', section: '§31',
      title: 'a flake can never suppress a real validation miss',
      run(ctx: ProbeContext) {
        const { attribute } = fromAudit(ctx.auditRoot, 'validation/attribution');
        const miss = attribute({ taskId: 't', checkName: 'c', originalFailure: 'x',
          attempts: [{ attempt: 1, passed: false, conclusive: true, detail: '' }, { attempt: 2, passed: false, conclusive: true, detail: '' }] });
        const flake = attribute({ taskId: 't', checkName: 'c', originalFailure: 'x',
          attempts: [{ attempt: 1, passed: false, conclusive: true, detail: '' }, { attempt: 2, passed: true, conclusive: true, detail: '' }] });
        const inconclusive = attribute({ taskId: 't', checkName: 'c', originalFailure: 'x',
          attempts: [{ attempt: 1, passed: false, conclusive: false, detail: 'infra' }] });
        const observed = compare([
          ['consistent failure', `${miss.attribution} attributed=${miss.attributedToTask} tunes=${miss.influencesImpactAnalyzer}`],
          ['intermittent', `${flake.attribution} attributed=${flake.attributedToTask} tunes=${flake.influencesImpactAnalyzer}`],
          ['inconclusive retry', `${inconclusive.attribution} attributed=${inconclusive.attributedToTask}`],
        ]);
        const ok = miss.attribution === 'VALIDATION_MISS' && miss.attributedToTask
          && flake.attribution === 'SUSPECTED_FLAKE' && !flake.attributedToTask && !flake.influencesImpactAnalyzer
          && inconclusive.attributedToTask;
        return ok ? held(observed) : defect(observed, {
          sections: ['§31'], severity: 'P1',
          title: 'Attribution separation is broken',
          detail: 'A flake was attributed to the task, a miss was not, or an inconclusive retry cleared the attribution.',
          impact: 'Telemetry stops describing reality, and the fix queue is aimed at the wrong things.',
        });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D12', section: '§35',
      title: 'a bare "needs attention" escalation is refused',
      run(ctx: ProbeContext) {
        const { validateEscalation } = fromAudit(ctx.auditRoot, 'validation/escalation');
        const bare = validateEscalation({ taskId: 't', reasonCode: 'MISSING_CREDENTIAL', blocked: 'Task needs attention.' });
        const empty = validateEscalation({});
        const observed = compare([
          ['bare payload problems', bare.map((p: any) => p.field).join(', ')],
          ['empty payload problems', String(empty.length)],
        ]);
        return bare.some((p: any) => p.field === 'blocked') && empty.length >= 6
          ? held(observed)
          : defect(observed, {
            sections: ['§35'], severity: 'P2',
            title: 'Incomplete escalations are accepted',
            detail: 'A placeholder escalation passed validation.',
            impact: 'Interruptions cost the human an afternoon instead of two minutes, which destroys the autonomy budget.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D13', section: '§11',
      title: 'disabling annotations are detected across test dialects',
      run(ctx: ProbeContext) {
        const { parseDiff } = fromAudit(ctx.auditRoot, 'validation/diff');
        const { inspectIntegrity, designContract } = fromAudit(ctx.auditRoot, 'validation/integrity');
        const dialects = [
          ['test/a.spec.ts', '  it.skip("x", () => {});'],
          ['test/b.spec.ts', '  xdescribe("y", () => {});'],
          ['tests/c_test.py', '@pytest.mark.skip'],
          ['pkg/d_test.go', '\tt.Skip("flaky")'],
          ['src/e.rs', '#[ignore]'],
          ['src/FTest.java', '@Disabled'],
        ];
        const text = dialects.map(([f, line]) => [
          `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1,2 @@', ` keep`, `+${line}`,
        ].join('\n')).join('\n');
        const r = inspectIntegrity(parseDiff(text), designContract({}));
        const found = r.testsDisabled.map((d: any) => `${d.file}:${d.annotation}`);
        const observed = `  detected ${found.length}/${dialects.length}\n  ${found.join('\n  ')}`;
        return found.length >= 4
          ? held(observed)
          : defect(observed, {
            sections: ['§11'], severity: 'P2',
            title: 'Skip annotations go undetected in common dialects',
            detail: `Only ${found.length} of ${dialects.length} disabling annotations were recognised.`,
            impact: 'A test can be switched off in an unrecognised dialect without the reviewer being told.',
          });
      },
    },

    // ---------------------------------------------------------------------
    {
      id: 'D14', section: '§8',
      title: 'an unreadable diff is validated at maximum depth, not skipped',
      run(ctx: ProbeContext) {
        const { resolveTier } = fromAudit(ctx.auditRoot, 'validation/tier');
        const unparsed = resolveTier({ diff: { files: [], unparsed: true }, adapterId: 'node', confidence: 'UNKNOWN' });
        const emptyDiff = resolveTier({ diff: { files: [], unparsed: false }, adapterId: 'node', confidence: 'UNKNOWN' });
        const observed = compare([
          ['unparseable diff → tier', unparsed.tier],
          ['empty diff → tier', emptyDiff.tier],
          ['empty diff fastEligible', String(emptyDiff.fastEligible)],
        ]);
        return unparsed.tier === 'DEEP' && emptyDiff.tier !== 'FAST'
          ? held(observed)
          : defect(observed, {
            sections: ['§8'], severity: 'P1',
            title: 'An unreadable or empty diff takes the fast path',
            detail: 'A diff that could not be parsed was treated as a small change.',
            impact: '"We could not read it" becomes "there was nothing to read", which is the wrong default entirely.',
          });
      },
    },
  ],

  declared: [
    {
      section: '§31', status: 'NOT_TESTED',
      reason:
        'End-to-end attribution of a post-acceptance regression could not be exercised: nothing in the product '
        + 'emits REGRESSION_ATTRIBUTED yet (there is no checkpoint runner), so there is no code path to drive. '
        + 'The attribution logic itself is covered by probe D11; the missing producer is recorded as a known '
        + 'limitation rather than tested against a stub, which would have proved only that the stub works.',
    },
  ],
};
