/**
 * Mission Mode, stage 2: the Oracle.
 *
 * THE ONLY PROVIDER USED HERE IS THE DETERMINISTIC FAKE. These tests prove the
 * machinery — payload policy, hashing, validation, refusal paths, state
 * transitions — and prove nothing whatever about model behaviour.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { EventStore } from '../src/engine/events';
import { ProcessSupervisor } from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { defaultPolicy } from '../src/engine/policy';
import { mockProvider } from '../src/engine/providers';
import { discoverEventTypes } from '../src/engine/eventtypes';
import { ORACLE_CRITIQUE_POLICY, ORACLE_JUDGE_POLICY } from '../src/engine/reviewcontext';
import { main } from '../src/cli';
import {
  MISSION_EVENT_TYPES, RESERVED_MISSION_EVENT_NAMES, requireScope, scopeOf,
  ScopeMismatchError, isCriterionId, makeCriterionId, missionOfCriterion,
} from '../src/mission/types';
import { MissionRegistry } from '../src/mission/registry';
import {
  Criterion, Oracle, ProjectContext, validateOracle, computeAcceptanceMode,
  applyCriticMode, detectAuthority, evaluatorResolves,
} from '../src/mission/oracle';
import { compileOracle, critiqueOracle, proposeAcceptance, normaliseCriteria } from '../src/mission/compile';
import { evaluateCriteria, outcomeForExecution, achievementFrom, acceptedCommands } from '../src/mission/evaluate';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-oracle-'));
const REPO = path.resolve(__dirname, '..');
const budgets = deriveBudgets({ lightTimeoutSeconds: 60, heavyTimeoutSeconds: 60 });

const CTX: ProjectContext = {
  commands: { unitTest: 'node -e process.exit(0)', typecheck: 'node -e process.exit(0)' },
  failingChecks: ['unitTest'],
  findings: ['F-1'],
};

function criterion(over: Partial<Criterion> = {}): Criterion {
  return {
    criterionId: 'p/M-0001/C-0001', type: 'EXECUTABLE',
    statement: 'the unit suite passes',
    evaluator: { kind: 'command', command: 'node -e process.exit(0)', expect: 'PASSED' },
    affectedBy: ['src/**'], required: true, requiresAuthority: [], derivedFrom: ['unitTest'],
    ...over,
  } as Criterion;
}

const oracleOf = (criteria: Criterion[], mode: any = 'AUTO'): Oracle => ({
  missionId: 'p/M-0001', version: 1, criteria, acceptanceMode: mode,
  compiledAt: new Date().toISOString(), compilerProviderId: 'mock', criticProviderId: 'mock',
});

function repo(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return root;
}

export async function oracleSuite(): Promise<void> {
  const sup = new ProcessSupervisor(budgets, undefined, path.join(TMP, 'state'));
  const policy = defaultPolicy(TMP, TMP);

  // ---------------------------------------------------------------------
  section('oracle: criterion identity is a third scope, not a longer string');
  {
    const cid = makeCriterionId('p/M-0001', 2);
    check('OR1: criterion ids are mission-scoped and padded',
      cid === 'p/M-0001/C-0002' && isCriterionId(cid) && missionOfCriterion(cid) === 'p/M-0001');
    check('OR2: scopeOf answers CRITERION, not MISSION, for the longest form',
      scopeOf(cid) === 'CRITERION' && scopeOf('p/M-0001') === 'MISSION'
      && scopeOf('p/T-0001') === 'TASK' && scopeOf('p/X-1') === null);
    const refused = (want: any, id: string) => {
      try { requireScope(want, id); return false; }
      catch (e) { return e instanceof ScopeMismatchError; }
    };
    check('OR3: a criterion id is refused where a mission or task id belongs',
      refused('MISSION', cid) && refused('TASK', cid));
    check('OR4: and mission/task ids are refused where a criterion belongs',
      refused('CRITERION', 'p/M-0001') && refused('CRITERION', 'p/T-0001'));
    check('OR5: the refusal names what it got',
      (() => { try { requireScope('CRITERION', 'p/M-0001'); return ''; }
        catch (e: any) { return e.message; } })().includes('mission id "p/M-0001"'));
  }

  // ---------------------------------------------------------------------
  section('oracle: the event registry moved, and the probe followed');
  {
    const discovered = discoverEventTypes(REPO).map((t) => t.type);
    const moved = ['ORACLE_COMPILED', 'ORACLE_CRITIQUED', 'ORACLE_ACCEPTED',
      'ORACLE_EVALUATED', 'EVALUATOR_REVISED', 'ORACLE_SEMANTICS_REFUSED'];
    check('OR10: the oracle events are emitted, not reserved',
      moved.every((n) => (MISSION_EVENT_TYPES as readonly string[]).includes(n))
      && moved.every((n) => !(RESERVED_MISSION_EVENT_NAMES as readonly string[]).includes(n)));
    check('OR11: the inventory discovered all six without being told',
      moved.every((n) => discovered.includes(n)),
      moved.filter((n) => !discovered.includes(n)).join(', '));
    // Pinned, not assumed: the probe went stale once, and the registry fix is
    // what stops it happening again.
    check('OR12: the event-type total is pinned at 43',
      discovered.length === 43, `${discovered.length} types`);
    check('OR13: names still reserved are still not counted as events',
      RESERVED_MISSION_EVENT_NAMES.every((n) => !discovered.includes(n)));

    // A fake secret through ORACLE_COMPILED comes back redacted.
    const store = new EventStore(path.join(TMP, 'redact'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const m = missions.create('goal', 'sha');
    const secret = 'sk-live-ORACLESECRET0123456789';
    missions.recordOracle(m.missionId, oracleOf([criterion({
      statement: `the deploy token ${secret} still works` })]), 'sha256:x', { valid: true });
    const raw = fs.readFileSync(store.logPath(m.missionId), 'utf8');
    check('OR14: a secret inside a compiled oracle is redacted at the sink',
      !raw.includes(secret) && /\[redacted:api-key\]/.test(raw));
    check('OR15: and the chain still verifies over the mission log',
      store.verify(m.missionId).ok);
  }

  // ---------------------------------------------------------------------
  section('oracle: the compiler produces a claim, validation decides if it is a contract');
  {
    const good = validateOracle([criterion()], CTX);
    check('OR20: a resolvable executable criterion validates',
      good.valid && good.findings.length === 0, JSON.stringify(good.findings));

    const codes = (c: Partial<Criterion>) =>
      validateOracle([criterion(c)], CTX).findings.map((f) => f.code);
    check('OR21: UNRESOLVABLE_EVALUATOR — positive',
      codes({ evaluator: { kind: 'command', command: 'make artisanal-widgets', expect: 'PASSED' } })
        .includes('UNRESOLVABLE_EVALUATOR'));
    check('OR21b: and negative', !codes({}).includes('UNRESOLVABLE_EVALUATOR'));
    check('OR22: EVALUATOR_MISSING — a prose criterion is refused',
      codes({ statement: 'the code should be clean', evaluator: undefined as any })
        .includes('EVALUATOR_MISSING'));
    check('OR22b: and negative', !codes({}).includes('EVALUATOR_MISSING'));
    check('OR23: RUBRIC_MISSING — an AI_JUDGED criterion needs a rubric',
      codes({ type: 'AI_JUDGED', evaluator: { kind: 'rubric', rubric: '', artifacts: ['a.md'] } })
        .includes('RUBRIC_MISSING'));
    check('OR23b: and negative',
      !codes({ type: 'AI_JUDGED',
        evaluator: { kind: 'rubric', rubric: 'passes when every public function is documented', artifacts: ['a.md'] } })
        .includes('RUBRIC_MISSING'));
    check('OR24: EVALUATOR_TYPE_MISMATCH — a rubric cannot prove an EXECUTABLE claim',
      codes({ type: 'EXECUTABLE', evaluator: { kind: 'rubric', rubric: 'looks fine to me honestly', artifacts: ['x'] } })
        .includes('EVALUATOR_TYPE_MISMATCH'));
    check('OR25: DUPLICATE_CRITERION_ID',
      validateOracle([criterion(), criterion()], CTX).findings
        .some((f) => f.code === 'DUPLICATE_CRITERION_ID'));
    check('OR26: evaluatorResolves accepts a declared runner with arguments',
      evaluatorResolves('node -e process.exit(0)', CTX)
      && evaluatorResolves('node -e process.exit(0) --extra', CTX)
      && !evaluatorResolves('curl https://example.com', CTX));

    // Malformed provider output is INFRASTRUCTURE, not a failed compile.
    const junk = await compileOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'do the thing', context: CTX,
      provider: mockProvider({ planner: { notCriteria: true } }),
      supervisor: sup, policy, baseSha: 'sha',
    });
    check('OR27: malformed compiler output is infrastructure, not a failed compile',
      junk.ok === false && /no parsable/.test(junk.infrastructureFailure ?? ''),
      junk.infrastructureFailure ?? '');
    const compiled = await compileOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'make the unit suite pass', context: CTX,
      provider: mockProvider({ planner: { criteria: [{
        criterionId: 'p/M-0001/C-0001', type: 'EXECUTABLE', statement: 'the unit suite passes',
        evaluator: { kind: 'command', command: 'node -e process.exit(0)', expect: 'PASSED' },
        affectedBy: ['src/**'], required: true, requiresAuthority: [], derivedFrom: ['unitTest'],
      }] } }),
      supervisor: sup, policy, baseSha: 'sha',
    });
    check('OR28: a well-formed compile validates and is hashed',
      compiled.ok && compiled.validation.valid && compiled.criteria.length === 1
      && /^sha256:/.test(compiled.structuredHash), JSON.stringify(compiled.validation.findings));
    check('OR29: normalisation fills ids rather than throwing on a partial criterion',
      normaliseCriteria('p/M-0001', [{ type: 'EXECUTABLE' }])[0].criterionId === 'p/M-0001/C-0001');
  }

  // ---------------------------------------------------------------------
  section('oracle: the critic is independent, mechanically');
  {
    const args = {
      missionId: 'p/M-0001', projectId: 'p', goal: 'make the unit suite pass',
      criteria: [criterion()], context: CTX, supervisor: sup, policy, baseSha: 'sha',
    };
    const clean = await critiqueOracle({ ...args,
      provider: mockProvider({ reviewer: { findings: [], modeOpinion: 'AUTO', usedContext: ['mission-goal'] } }) });
    check('OR30: a clean critique delivers exactly the allowed sections',
      clean.ok && clean.valid
      && clean.payload.deliveredContext.sort().join() === 'compiled-criteria,evidence-summary,mission-goal,project-commands',
      clean.payload.deliveredContext.join());
    check('OR31: the policy forbids the compiler\'s own reasoning',
      ORACLE_CRITIQUE_POLICY.forbidden.includes('compiler-reasoning')
      && ORACLE_CRITIQUE_POLICY.forbidden.includes('compiler-transcript')
      && ORACLE_CRITIQUE_POLICY.forbidden.includes('critic-verdict'));

    const byKind = await critiqueOracle({ ...args,
      provider: mockProvider({ reviewer: { findings: [], modeOpinion: 'AUTO' } }),
      extraInputs: [{ kind: 'compiler-reasoning', label: 'WHY', content: 'I chose these because…' }] });
    check('OR32: a forbidden KIND invalidates the critique and is never delivered',
      byKind.valid === false && byKind.payload.prompt === ''
      && byKind.payload.violations.some((v) => v.kind === 'compiler-reasoning'));

    const smuggled = await critiqueOracle({ ...args,
      provider: mockProvider({ reviewer: { findings: [], modeOpinion: 'AUTO' } }),
      extraInputs: [{ kind: 'evidence-summary', label: 'EVIDENCE',
        content: 'COMPILER REASONING: I chose these criteria because they were easy' }] });
    check('OR33: forbidden material smuggled inside an ALLOWED section is caught',
      smuggled.valid === false
      && smuggled.payload.violations.some((v) => v.kind === 'content-scan'),
      JSON.stringify(smuggled.payload.violations));
    check('OR34: an invalidated critique contributes no mode opinion',
      smuggled.modeOpinion === null && byKind.modeOpinion === null);
    check('OR35: self-reported context is reconciled against what was delivered',
      (await critiqueOracle({ ...args, provider: mockProvider({ reviewer: {
        findings: [], modeOpinion: 'AUTO', usedContext: ['mission-goal', 'implementer-transcript'] } }) }))
        .reconciliation.unsupportedClaims.includes('implementer-transcript'));
  }

  // ---------------------------------------------------------------------
  section('oracle: the acceptance mode is computed, never proposed by its author');
  {
    const table: Array<[string, Criterion[], string]> = [
      ['all executable, resolvable, evidence-derived', [criterion()], 'AUTO'],
      ['one AI_JUDGED', [criterion(), criterion({ criterionId: 'p/M-0001/C-0002', type: 'AI_JUDGED',
        evaluator: { kind: 'rubric', rubric: 'passes when the docs explain why', artifacts: ['R.md'] } })],
        'OPTIONAL_CONFIRMATION'],
      ['an invented target', [criterion({ derivedFrom: [] })], 'OPTIONAL_CONFIRMATION'],
      ['an unresolvable evaluator', [criterion({
        evaluator: { kind: 'command', command: 'make widgets', expect: 'PASSED' } })], 'OPTIONAL_CONFIRMATION'],
      ['spending', [criterion({
        evaluator: { kind: 'command', command: 'node -e process.exit(0) && stripe checkout', expect: 'PASSED' } })],
        'REQUIRED_CONSENT'],
      ['credentials', [criterion({ requiresAuthority: ['CREDENTIALS'] })], 'REQUIRED_CONSENT'],
      ['publishing', [criterion({
        evaluator: { kind: 'command', command: 'node -e process.exit(0) && npm publish', expect: 'PASSED' } })],
        'REQUIRED_CONSENT'],
      ['a destructive external action', [criterion({
        evaluator: { kind: 'command', command: 'node -e process.exit(0) && terraform destroy', expect: 'PASSED' } })],
        'REQUIRED_CONSENT'],
    ];
    const wrong = table.filter(([, criteria, want]) => computeAcceptanceMode(criteria, CTX).mode !== want);
    check('OR40: the mode table holds for every row',
      wrong.length === 0,
      wrong.map(([label, c, want]) => `${label}: wanted ${want}, got ${computeAcceptanceMode(c, CTX).mode}`).join(' | '));
    check('OR41: the decision records every input it used',
      (() => { const d = computeAcceptanceMode([criterion()], CTX);
        return d.inputs.criterionCount === 1 && d.inputs.allExecutable && d.inputs.allResolvable
          && d.inputs.allDerivedFromEvidence && d.reasons.length > 0; })());
    check('OR42: authority is detected mechanically AND from the declaration',
      detectAuthority([criterion({ evaluator: { kind: 'command', command: 'git push origin main', expect: 'PASSED' } })])
        .some((a) => a.kind === 'PUBLISH')
      && detectAuthority([criterion({ requiresAuthority: ['SPEND'] })]).some((a) => a.kind === 'SPEND'));

    check('OR43: the critic can escalate the mode',
      applyCriticMode('AUTO', 'REQUIRED_CONSENT').mode === 'REQUIRED_CONSENT'
      && applyCriticMode('AUTO', 'OPTIONAL_CONFIRMATION').escalated === true);
    check('OR44: and cannot lower it, by construction',
      applyCriticMode('REQUIRED_CONSENT', 'AUTO').mode === 'REQUIRED_CONSENT'
      && applyCriticMode('OPTIONAL_CONFIRMATION', 'AUTO').mode === 'OPTIONAL_CONFIRMATION'
      && applyCriticMode('REQUIRED_CONSENT', 'AUTO').escalated === false);
    check('OR45: an absent or nonsense opinion changes nothing',
      applyCriticMode('AUTO', null).mode === 'AUTO'
      && applyCriticMode('AUTO', 'WHATEVER' as any).mode === 'AUTO');
    check('OR46: proposeAcceptance composes the two',
      proposeAcceptance([criterion()], CTX, 'REQUIRED_CONSENT').mode === 'REQUIRED_CONSENT'
      && proposeAcceptance([criterion()], CTX, null).mode === 'AUTO');
  }

  // ---------------------------------------------------------------------
  section('oracle: statements are immutable, evaluators are repairable');
  {
    const store = new EventStore(path.join(TMP, 'immutable'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const m = missions.create('goal', 'sha');
    const c = criterion({ criterionId: `${m.missionId}/C-0001` });
    const o: Oracle = { ...oracleOf([c]), missionId: m.missionId };
    missions.recordOracle(m.missionId, o, 'sha256:x', { valid: true });
    missions.acceptOracle(m.missionId, { acceptanceMode: 'AUTO', acceptedBy: 'auto',
      modeInputs: {}, modeReasons: ['test'], escalatedByCritic: false });
    check('OR50: the oracle is accepted and reconstructs',
      missions.mission(m.missionId)!.oracleAccepted
      && missions.mission(m.missionId)!.acceptanceMode === 'AUTO');

    const refusal = missions.refuseSemanticsChange(m.missionId, c.criterionId, {
      field: 'statement', from: c.statement, to: 'the unit suite mostly passes' });
    const evs = store.read(m.missionId);
    check('OR51: changing what success MEANS is refused, with a code',
      refusal.code === 'ORACLE_SEMANTICS_IMMUTABLE'
      && evs.some((e) => e.type === 'ORACLE_SEMANTICS_REFUSED'));
    check('OR52: and the refused attempt is on the record, not just rejected',
      (evs.find((e) => e.type === 'ORACLE_SEMANTICS_REFUSED')!.payload as any).to
        === 'the unit suite mostly passes');
    check('OR53: the statement itself is unchanged',
      (missions.mission(m.missionId)!.oracle as Oracle).criteria[0].statement === c.statement);

    // A command evaluator may be repaired; prior PROVEN evidence is withdrawn.
    missions.recordEvaluation(m.missionId, { oracleVersion: 1, scope: 'full',
      results: [{ criterionId: c.criterionId, outcome: 'PROVEN', evidence: ['e1'], detail: 'ok' }],
      provenRequired: 1, totalRequired: 1 });
    check('OR54: the criterion is PROVEN before the revision',
      missions.mission(m.missionId)!.criterionOutcomes[c.criterionId] === 'PROVEN');
    const rev = missions.reviseEvaluator(m.missionId, {
      criterionId: c.criterionId, oldEvaluator: c.evaluator,
      newEvaluator: { kind: 'command', command: 'node -e process.exit(0)', expect: 'TEST_FAILED' },
      reason: 'the old command passed for the wrong reason', criticVerdict: { findings: [] } });
    check('OR55: revising an evaluator invalidates what it previously proved',
      rev.ok && rev.invalidated.length === 1
      && missions.mission(m.missionId)!.criterionOutcomes[c.criterionId] === 'UNEVALUATED');
    check('OR56: back to UNEVALUATED, never FAILED — nothing was disproven',
      missions.mission(m.missionId)!.criterionOutcomes[c.criterionId] !== 'FAILED');
    check('OR57: the new evaluator is what the oracle now carries',
      ((missions.mission(m.missionId)!.oracle as Oracle).criteria[0].evaluator as any).expect === 'TEST_FAILED');

    // A rubric is what "passing" means. Revising it needs consent.
    const rubricCriterion = criterion({ criterionId: `${m.missionId}/C-0002`, type: 'AI_JUDGED',
      evaluator: { kind: 'rubric', rubric: 'passes when every public function is documented', artifacts: ['R.md'] } });
    const denied = missions.reviseEvaluator(m.missionId, {
      criterionId: rubricCriterion.criterionId, oldEvaluator: rubricCriterion.evaluator,
      newEvaluator: { kind: 'rubric', rubric: 'passes when it looks alright', artifacts: ['R.md'] },
      reason: 'the old rubric was too strict', criticVerdict: {} });
    check('OR58: loosening a rubric without consent is refused',
      denied.ok === false && denied.code === 'RUBRIC_REVISION_REQUIRES_CONSENT'
      && store.read(m.missionId).some((e) => e.type === 'ORACLE_SEMANTICS_REFUSED'
        && (e.payload as any).code === 'RUBRIC_REVISION_REQUIRES_CONSENT'));
    const allowed = missions.reviseEvaluator(m.missionId, {
      criterionId: rubricCriterion.criterionId, oldEvaluator: rubricCriterion.evaluator,
      newEvaluator: { kind: 'rubric', rubric: 'passes when it looks alright', artifacts: ['R.md'] },
      reason: 'the old rubric was too strict', criticVerdict: {}, consent: 'user-confirmed' });
    check('OR59: with explicit consent, the same revision proceeds', allowed.ok === true);
  }

  // ---------------------------------------------------------------------
  section('oracle: the accepted oracle is the ledger');
  {
    // What the mission ACCEPTED: one command.
    const accepted = oracleOf([criterion()]);
    check('OR60: the ledger is exactly the accepted evaluator set',
      acceptedCommands(accepted).has('node -e process.exit(0)')
      && acceptedCommands(accepted).size === 1);

    // What is being asked to run: a criteria set that drifted from it. This is
    // the shape that matters — a ledger derived from the same object it checks
    // would always contain what was about to run and could never refuse.
    const breach = { ...criterion({ criterionId: 'p/M-0001/C-0100' }),
      evaluator: { kind: 'command' as const,
        command: `touch ${path.join(TMP, 'zeus-ledger-breach')}`, expect: 'PASSED' as const } };
    const run = await evaluateCriteria({
      oracle: { ...accepted, criteria: [breach] },
      ledger: acceptedCommands(accepted),
      projectId: 'p', worktree: TMP, supervisor: sup, policy, scope: 'full',
    });
    check('OR61: a command outside the accepted oracle is refused',
      run.results[0].refusal === 'ORACLE_EVALUATOR_NOT_ACCEPTED'
      && run.results[0].outcome === 'UNEVALUATED', JSON.stringify(run.results[0]));
    check('OR62: refused BEFORE spawning — the command never ran',
      !fs.existsSync(path.join(TMP, 'zeus-ledger-breach')));
    check('OR63: the refusal says what was not accepted, not merely that something was refused',
      run.results[0].detail.includes('zeus-ledger-breach')
      && /not an evaluator in the accepted oracle/.test(run.results[0].detail));
    const allowed = await evaluateCriteria({
      oracle: accepted, ledger: acceptedCommands(accepted),
      projectId: 'p', worktree: TMP, supervisor: sup, policy, scope: 'full',
    });
    check('OR64: and an accepted command still runs',
      allowed.results[0].outcome === 'PROVEN', JSON.stringify(allowed.results[0]));
  }

  // ---------------------------------------------------------------------
  section('oracle: the outcome mapping keeps non-verdicts out of FAILED');
  {
    const map = (outcome: string, expect: 'PASSED' | 'TEST_FAILED' = 'PASSED') =>
      outcomeForExecution({ outcome } as any, expect);
    check('OR70: PASSED proves, TEST_FAILED disproves',
      map('COMPLETED') === 'PROVEN' && map('FAILED') === 'FAILED');
    check('OR71: an inverted expectation is honoured',
      map('FAILED', 'TEST_FAILED') === 'PROVEN' && map('COMPLETED', 'TEST_FAILED') === 'FAILED');
    const nonVerdicts = ['TIMEOUT', 'RESOURCE_LIMIT_EXCEEDED', 'POLICY_DENIED',
      'INFRASTRUCTURE_FAILURE', 'CANCELLED'];
    check('OR72: every non-verdict outcome is UNEVALUATED, never FAILED',
      nonVerdicts.every((o) => map(o) === 'UNEVALUATED'),
      nonVerdicts.filter((o) => map(o) !== 'UNEVALUATED').join(', '));
    check('OR73: CANCELLED and RESOURCE_LIMIT_EXCEEDED land in the same place',
      map('CANCELLED') === map('RESOURCE_LIMIT_EXCEEDED'));
  }

  // ---------------------------------------------------------------------
  section('oracle: the judge sees the rubric and the artifact, and nothing else');
  {
    fs.writeFileSync(path.join(TMP, 'artifact.md'), '# a document\nsome content\n');
    const judged = criterion({ criterionId: 'p/M-0001/C-0007', type: 'AI_JUDGED',
      evaluator: { kind: 'rubric', rubric: 'passes when the document has a heading', artifacts: ['artifact.md'] } });
    const o = oracleOf([judged]);
    check('OR80: the judge policy forbids implementer output and prior verdicts',
      ORACLE_JUDGE_POLICY.forbidden.includes('implementer-transcript')
      && ORACLE_JUDGE_POLICY.forbidden.includes('judge-verdict')
      && ORACLE_JUDGE_POLICY.allowed.join() === 'criterion-rubric,judged-artifact');

    const ok = await evaluateCriteria({ oracle: o, projectId: 'p', worktree: TMP,
      supervisor: sup, policy, judge: mockProvider({ reviewer: { satisfied: true,
        findings: [], evidenceSummary: 'the heading is present' } }), scope: 'full' });
    check('OR81: a clean judgment proves the criterion',
      ok.results[0].outcome === 'PROVEN', JSON.stringify(ok.results[0]));
    const no = await evaluateCriteria({ oracle: o, projectId: 'p', worktree: TMP,
      supervisor: sup, policy, judge: mockProvider({ reviewer: { satisfied: false,
        findings: ['no heading'], evidenceSummary: 'missing' } }), scope: 'full' });
    check('OR82: and a negative judgment fails it', no.results[0].outcome === 'FAILED');

    // Contamination: an artifact carrying implementer-style content.
    fs.writeFileSync(path.join(TMP, 'tainted.md'),
      '# doc\n{"type":"tool_use","name":"Edit"}\nIMPLEMENTER TRANSCRIPT follows\n');
    const tainted = criterion({ criterionId: 'p/M-0001/C-0008', type: 'AI_JUDGED',
      evaluator: { kind: 'rubric', rubric: 'passes when the document has a heading', artifacts: ['tainted.md'] } });
    const bad = await evaluateCriteria({ oracle: oracleOf([tainted]), projectId: 'p', worktree: TMP,
      supervisor: sup, policy, judge: mockProvider({ reviewer: { satisfied: true } }), scope: 'full' });
    check('OR83: a contaminated judge payload invalidates the judgment',
      bad.results[0].outcome === 'UNEVALUATED'
      && bad.results[0].refusal === 'JUDGE_CONTEXT_CONTAMINATED',
      JSON.stringify(bad.results[0]));
    check('OR84: UNEVALUATED, not FAILED — nothing about the artifact was decided',
      bad.results[0].outcome !== 'FAILED');
    const noJudge = await evaluateCriteria({ oracle: o, projectId: 'p', worktree: TMP,
      supervisor: sup, policy, scope: 'full' });
    check('OR85: no judge configured is UNEVALUATED too',
      noJudge.results[0].outcome === 'UNEVALUATED');
  }

  // ---------------------------------------------------------------------
  section('oracle: an EXTERNAL_FACT probe obeys the execution policy');
  {
    const probe = criterion({ criterionId: 'p/M-0001/C-0009', type: 'EXTERNAL_FACT',
      evaluator: { kind: 'probe', command: 'node -e process.exit(0)', expect: 'PASSED', requiresNetwork: true } });
    const noNet = await evaluateCriteria({ oracle: oracleOf([probe]), projectId: 'p', worktree: TMP,
      supervisor: sup, policy: { ...policy, network: false }, scope: 'full' });
    check('OR90: a probe needing the network under a no-network policy is UNEVALUATED',
      noNet.results[0].outcome === 'UNEVALUATED' && noNet.results[0].refusal === 'POLICY_DENIED',
      JSON.stringify(noNet.results[0]));
    check('OR91: the violation is recorded, not silently skipped',
      /policy/i.test(noNet.results[0].detail));
    const withNet = await evaluateCriteria({ oracle: oracleOf([probe]), projectId: 'p', worktree: TMP,
      supervisor: sup, policy: { ...policy, network: true }, scope: 'full' });
    check('OR92: the same probe runs when the policy grants the network',
      withNet.results[0].outcome === 'PROVEN', JSON.stringify(withNet.results[0]));
    const offline = criterion({ criterionId: 'p/M-0001/C-0010', type: 'EXTERNAL_FACT',
      evaluator: { kind: 'probe', command: 'node -e process.exit(0)', expect: 'PASSED', requiresNetwork: false } });
    const off = await evaluateCriteria({ oracle: oracleOf([offline]), projectId: 'p', worktree: TMP,
      supervisor: sup, policy: { ...policy, network: false }, scope: 'full' });
    check('OR93: a probe that needs no network is unaffected by the denial',
      off.results[0].outcome === 'PROVEN');
  }

  // ---------------------------------------------------------------------
  section('oracle: achievement distinguishes "not proven" from "not evaluated"');
  {
    const a = criterion({ criterionId: 'p/M-0001/C-0001' });
    const b = criterion({ criterionId: 'p/M-0001/C-0002' });
    const o = oracleOf([a, b]);
    const m = (pairs: Array<[string, any]>) => achievementFrom(new Map(pairs as any), o);
    check('OR100: all required proven is ACHIEVED',
      m([[a.criterionId, 'PROVEN'], [b.criterionId, 'PROVEN']]) === 'ACHIEVED');
    check('OR101: all required UNEVALUATED is UNEVALUATED, NOT none',
      m([[a.criterionId, 'UNEVALUATED'], [b.criterionId, 'UNEVALUATED']]) === 'UNEVALUATED'
      && m([]) === 'UNEVALUATED');
    check('OR102: some proven is PARTIAL',
      m([[a.criterionId, 'PROVEN'], [b.criterionId, 'FAILED']]) === 'PARTIAL'
      && m([[a.criterionId, 'PROVEN'], [b.criterionId, 'UNEVALUATED']]) === 'PARTIAL');
    check('OR103: none proven and at least one disproven is NONE',
      m([[a.criterionId, 'FAILED'], [b.criterionId, 'FAILED']]) === 'NONE'
      && m([[a.criterionId, 'FAILED'], [b.criterionId, 'UNEVALUATED']]) === 'NONE');
    check('OR104: an oracle with no required criteria cannot be ACHIEVED by default',
      achievementFrom(new Map(), oracleOf([criterion({ required: false })])) === 'UNEVALUATED');
  }

  // ---------------------------------------------------------------------
  section('oracle CLI: compile, confirm, evaluate, status');
  {
    const root = repo('cli');
    const cwd = process.cwd();
    let say: string[] = [];
    const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
    const run = async (...argv: string[]): Promise<number> => {
      say = [];
      const outW = process.stdout.write.bind(process.stdout);
      const errW = process.stderr.write.bind(process.stderr);
      const grab = (chunk: any): boolean => { say.push(String(chunk)); return true; };
      (process.stdout as any).write = grab;
      (process.stderr as any).write = grab;
      process.chdir(root);
      try { return await main(argv); }
      finally {
        process.chdir(cwd);
        (process.stdout as any).write = outW;
        (process.stderr as any).write = errW;
      }
    };
    const said = (): string => strip(say.join(''));

    await run('init');
    // A project whose declared commands really run, so the compiled contract
    // is resolvable and the evaluation is real.
    const cfgPath = path.join(root, '.zeus', 'config.yaml');
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8')
      .replace(/unitTest:.*/, 'unitTest: node -e process.exit(0)')
      .replace(/typecheck:.*/, 'typecheck: node -e process.exit(0)'));

    await run('mission', 'create', 'make the checks pass');
    const compileCode = await run('mission', 'compile', 'M-0001', '--mock');
    const compiled = said();
    check('OR110: compile produces criteria and names the acceptance mode',
      compileCode === 0 && /oracle v1/.test(compiled) && /acceptance mode/.test(compiled),
      compiled.split('\n').slice(0, 2).join(' | '));
    check('OR111: the mode is OPTIONAL_CONFIRMATION — nothing was derived from observed evidence',
      /OPTIONAL_CONFIRMATION/.test(compiled), compiled.match(/acceptance mode.*/)?.[0] ?? '');
    check('OR112: and it says WHY, not just what',
      /states a target nobody has observed/.test(compiled));

    await run('mission', 'status', 'M-0001', '--json');
    const afterCompile = JSON.parse(said());
    check('OR113: status reports the oracle and that it is accepted',
      afterCompile.oracleVersion === 1 && afterCompile.oracleAccepted === true
      && afterCompile.acceptedBy === 'consent-flag'
      && Array.isArray(afterCompile.oracle.criteria) && afterCompile.oracle.criteria.length > 0,
      JSON.stringify({ v: afterCompile.oracleVersion, a: afterCompile.oracleAccepted }));

    const evalCode = await run('mission', 'evaluate', 'M-0001', '--mock', '--json');
    const evaluated = JSON.parse(said());
    check('OR114: evaluate proves the criteria through the supervisor',
      evalCode === 0 && evaluated.scope === 'full'
      && evaluated.results.every((r: any) => r.outcome === 'PROVEN')
      && evaluated.provenRequired === evaluated.totalRequired,
      JSON.stringify(evaluated.results.map((r: any) => r.outcome)));

    await run('mission', 'status', 'M-0001');
    const status = said();
    check('OR115: status shows per-criterion outcomes and the derived achievement',
      /criteria proven \d+\/\d+ required/.test(status) && /PROVEN/.test(status)
      && /derived +ACHIEVED/.test(status), status.match(/derived.*/)?.[0] ?? status.slice(0, 120));

    // A second mission, this time reviewed rather than auto-accepted.
    await run('mission', 'create', 'a mission the operator wants to read first');
    await run('mission', 'compile', 'M-0002', '--mock', '--review-oracle');
    await run('mission', 'status', 'M-0002', '--json');
    const unaccepted = JSON.parse(said());
    check('OR116: --review-oracle leaves the oracle compiled but NOT accepted',
      unaccepted.oracleVersion === 1 && unaccepted.oracleAccepted === false);
    const blocked = await run('mission', 'evaluate', 'M-0002', '--mock');
    check('OR117: an unaccepted oracle authorises no evaluation',
      blocked === 1 && /no ACCEPTED oracle/.test(said()));
    await run('mission', 'confirm', 'M-0002');
    await run('mission', 'status', 'M-0002', '--json');
    const confirmed = JSON.parse(said());
    check('OR118: confirm records human consent and unblocks evaluation',
      confirmed.oracleAccepted === true && confirmed.acceptedBy === 'user-confirmed');
    check('OR119: and evaluation then runs',
      (await run('mission', 'evaluate', 'M-0002', '--mock')) === 0);
  }

  sup.shutdown('oracle suite finished');
  fs.rmSync(TMP, { recursive: true, force: true });
}
