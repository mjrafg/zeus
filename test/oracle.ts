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
  AcceptanceMode, findingFamily, findingsFloor,
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
    // 59 -> 62 with the agent trace: MODEL_CALL_STARTED, MODEL_CALL_FINISHED
    // and TRACE_WRITE_FAILED. The pin exists so a new type is acknowledged
    // rather than slipped in, and it matters here because RS2 exercises every
    // DISCOVERED type against secret fixtures — a type that arrived unnoticed
    // would be a type nobody had checked for leaks.
    check('OR12: the event-type total is pinned at 65',
      discovered.length === 65, `${discovered.length} types`);
    check('OR12e: the chat events are discovered automatically, like every other family',
      ['CHAT_MESSAGE', 'CHAT_CARD_DECISION'].every((n) => discovered.includes(n)));
    check('OR12d: the budget revision and the stop decision are discovered automatically',
      ['MISSION_BUDGET_REVISED', 'PLAN_STOP_DECISION'].every((n) => discovered.includes(n)));
    check('OR12c: ORACLE_RECOMPILED is emitted and discovered automatically',
      (MISSION_EVENT_TYPES as readonly string[]).includes('ORACLE_RECOMPILED')
      && discovered.includes('ORACLE_RECOMPILED'));
    check('OR12b: ORACLE_COMPILE_REJECTED is emitted and discovered automatically',
      (MISSION_EVENT_TYPES as readonly string[]).includes('ORACLE_COMPILE_REJECTED')
      && discovered.includes('ORACLE_COMPILE_REJECTED'));
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
  section('oracle: a refused compile leaves evidence');
  {
    const store = new EventStore(path.join(TMP, 'rejected'));
    const missions = new MissionRegistry({ events: store, projectId: 'p' });
    const m = missions.create('a goal whose compile will be refused', 'sha');
    const proposed = [criterion({ evaluator: { kind: 'command', command: 'make widgets', expect: 'PASSED' } })];
    const validation = validateOracle(proposed, CTX);
    missions.recordCompileRejected(m.missionId, {
      findings: validation.findings, criteria: proposed, compilerProviderId: 'mock',
      structuredHash: 'sha256:abc',
    });
    const evs = store.read(m.missionId);
    const rejected = evs.find((e) => e.type === 'ORACLE_COMPILE_REJECTED');
    check('OR16: the refused attempt is recorded, not merely printed',
      !!rejected && (rejected.payload as any).criterionCount === 1
      && (rejected.payload as any).retryable === true);
    check('OR17: with what the compiler proposed AND why it was refused',
      Array.isArray((rejected!.payload as any).criteria)
      && (rejected!.payload as any).findings.some((f: any) => f.code === 'UNRESOLVABLE_EVALUATOR'));
    const rec = missions.mission(m.missionId)!;
    check('OR18: and the mission is still pre-oracle — a record, not a state change',
      rec.oracle === null && rec.oracleAccepted === false && rec.oracleVersion === null);
    // The redacting sink covers it like every other payload.
    const secret = 'sk-live-REJECTEDCOMPILE0123456789';
    missions.recordCompileRejected(m.missionId, {
      findings: [], criteria: [criterion({ statement: `token ${secret}` })],
      compilerProviderId: 'mock', structuredHash: 'sha256:def',
    });
    check('OR19: a secret in a refused proposal is redacted too',
      !fs.readFileSync(store.logPath(m.missionId), 'utf8').includes(secret));
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

    // The shape mismatches the first supervised compile hit. The model's
    // criteria were semantically excellent and were refused on bookkeeping.
    const slugged = normaliseCriteria('p/M-0001', [
      { criterionId: 'unit-tests-pass', type: 'EXECUTABLE',
        evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' } },
      { criterionId: 'typecheck-passes', type: 'EXECUTABLE',
        evaluator: { kind: 'command', command: 'typecheck', expect: 'PASSED' } },
    ], CTX);
    check('OR29b: a model-supplied id becomes a SLUG; the canonical id is ours',
      slugged[0].criterionId === 'p/M-0001/C-0001' && slugged[0].slug === 'unit-tests-pass'
      && slugged[1].criterionId === 'p/M-0001/C-0002' && slugged[1].slug === 'typecheck-passes',
      JSON.stringify(slugged.map((c) => [c.criterionId, c.slug])));
    check('OR29c: a bare command KEY resolves to the command line, and says so',
      (slugged[0].evaluator as any).command === CTX.commands.unitTest
      && slugged[0].resolvedFromKey === 'unitTest',
      `${(slugged[0].evaluator as any).command} (from ${slugged[0].resolvedFromKey})`);
    check('OR29d: and what the model produced now VALIDATES',
      validateOracle(slugged.map((c) => ({ ...c, required: true, affectedBy: [],
        requiresAuthority: [], derivedFrom: ['unitTest'], statement: 'the check passes' })), CTX).valid);
    const literal = normaliseCriteria('p/M-0001', [{ type: 'EXECUTABLE',
      evaluator: { kind: 'command', command: 'node -e process.exit(0)', expect: 'PASSED' } }], CTX);
    check('OR29e: a command line given literally is left alone, with no false provenance',
      (literal[0].evaluator as any).command === 'node -e process.exit(0)'
      && literal[0].resolvedFromKey === undefined);
    const unknown = normaliseCriteria('p/M-0001', [{ type: 'EXECUTABLE',
      evaluator: { kind: 'command', command: 'notAKey', expect: 'PASSED' } }], CTX);
    check('OR29f: an unknown key stays unknown and is still refused — resolution is not leniency',
      (unknown[0].evaluator as any).command === 'notAKey'
      && validateOracle(unknown.map((c) => ({ ...c, statement: 'x', required: true, affectedBy: [],
        requiresAuthority: [], derivedFrom: [] })), CTX)
        .findings.some((f) => f.code === 'UNRESOLVABLE_EVALUATOR'));
    check('OR29g: the prompt now distinguishes a command NAME from a command LINE',
      /Use\s*\n?.*the COMMAND LINE, not the name/s.test(
        fs.readFileSync(path.resolve(__dirname, '../src/mission/compile.ts'), 'utf8')));
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
  section('oracle: determinism is proven by repetition');
  {
    // A counter file makes a command behave differently on each run, which is
    // what a flaky test IS.
    const counter = path.join(TMP, 'runs.count');
    const script = (name: string, body: string): string => {
      const f = path.join(TMP, name);
      fs.writeFileSync(f, `#!/bin/bash\nn=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))\n`
        + `echo $n > ${counter}\n${body}\n`, { mode: 0o755 });
      return `bash ${f}`;
    };
    const reset = () => fs.writeFileSync(counter, '0');

    const always = script('always.sh', 'exit 0');
    const failsOnTwo = script('fails2.sh', 'if [ "$n" = "2" ]; then exit 1; fi\nexit 0');
    const hangsOnTwo = script('hangs2.sh', 'if [ "$n" = "2" ]; then sleep 30; fi\nexit 0');

    const runRepeat = async (command: string, repeat: number) => {
      const c = criterion({ criterionId: 'p/M-0001/C-0004',
        evaluator: { kind: 'command', command, expect: 'PASSED', repeat } as any });
      const o = oracleOf([c]);
      return (await evaluateCriteria({ oracle: o, ledger: acceptedCommands(o), projectId: 'p',
        worktree: TMP, supervisor: sup, policy, scope: 'full', timeoutSeconds: 5 })).results[0];
    };

    reset();
    const allPass = await runRepeat(always, 3);
    const runsOf = (r: any) => r.evidence.filter((e: string) => e.startsWith('run:'));
    check('OR120: repeat=3 with every run passing is PROVEN',
      allPass.outcome === 'PROVEN', `${allPass.outcome}: ${allPass.detail}`);
    check('OR121: and all three runs are recorded individually',
      runsOf(allPass).length === 3
      && runsOf(allPass).every((e: string, i: number) => e.startsWith(`run:${i + 1}/3:COMPLETED:`)),
      runsOf(allPass).join(' | '));
    check('OR122: each run is a SEPARATE supervised execution, so the budget sees three',
      new Set(runsOf(allPass).map((e: string) => e.split(':').pop())).size === 3
      && Number(fs.readFileSync(counter, 'utf8').trim()) === 3,
      `counter=${fs.readFileSync(counter, 'utf8').trim()}`);
    check('OR123: the durations are recorded per run and summed',
      allPass.evidence.some((e) => /^totalRunMs:\d+$/.test(e))
      && allPass.evidence.includes('runs:3/3'),
      allPass.evidence.filter((e) => !e.startsWith('run:')).join(', '));

    reset();
    const failsSecond = await runRepeat(failsOnTwo, 3);
    check('OR124: a failure on run 2 is FAILED, and names the run',
      failsSecond.outcome === 'FAILED' && /run 2 was FAILED/.test(failsSecond.detail),
      failsSecond.detail);
    check('OR125: SHORT-CIRCUIT — run 3 is never executed',
      runsOf(failsSecond).length === 2
      && failsSecond.evidence.includes('runs:2/3')
      && failsSecond.evidence.includes('notExecuted:1')
      && Number(fs.readFileSync(counter, 'utf8').trim()) === 2,
      `counter=${fs.readFileSync(counter, 'utf8').trim()}, evidence=${failsSecond.evidence.join(',')}`);
    check('OR126: and the skipped runs are stated, not left to be inferred from a count',
      /runs 3-3 not executed/.test(failsSecond.detail), failsSecond.detail);

    reset();
    const hangsSecond = await runRepeat(hangsOnTwo, 3);
    check('OR127: a TIMEOUT on run 2 is UNEVALUATED, never FAILED',
      hangsSecond.outcome === 'UNEVALUATED', `${hangsSecond.outcome}: ${hangsSecond.detail}`);
    check('OR128: the run that did not produce a verdict proves nothing, and stops the rest',
      runsOf(hangsSecond).length === 2 && /TIMEOUT/.test(runsOf(hangsSecond)[1])
      && hangsSecond.evidence.includes('notExecuted:1'),
      runsOf(hangsSecond).join(' | '));

    reset();
    const once = await runRepeat(always, 1);
    check('OR129: repeat=1 behaves exactly as before',
      once.outcome === 'PROVEN' && runsOf(once).length === 1
      && Number(fs.readFileSync(counter, 'utf8').trim()) === 1);

    // Validation: the field is bounded, and the wall it opens a door in stays.
    const repeatFindings = (repeat: unknown) => validateOracle([criterion({
      evaluator: { kind: 'command', command: 'node -e process.exit(0)', expect: 'PASSED', repeat } as any,
    })], CTX).findings.map((f) => f.code);
    check('OR130: repeat must be a whole number in 1..10',
      repeatFindings(0).includes('REPEAT_OUT_OF_RANGE')
      && repeatFindings(11).includes('REPEAT_OUT_OF_RANGE')
      && repeatFindings(-1).includes('REPEAT_OUT_OF_RANGE')
      && repeatFindings(2.5).includes('REPEAT_OUT_OF_RANGE'));
    check('OR131: and a valid repeat is accepted',
      !repeatFindings(1).includes('REPEAT_OUT_OF_RANGE')
      && !repeatFindings(10).includes('REPEAT_OUT_OF_RANGE')
      && !repeatFindings(undefined).includes('REPEAT_OUT_OF_RANGE'));
    check('OR132: a shell loop in a command string is STILL refused — the wall stays',
      validateOracle([criterion({ evaluator: { kind: 'command',
        command: 'for i in 1 2 3 4 5; do npm run test || exit 1; done', expect: 'PASSED' } })], CTX)
        .findings.some((f) => f.code === 'UNRESOLVABLE_EVALUATOR'));
    check('OR133: and repeat does not launder one — the loop is refused with repeat set too',
      validateOracle([criterion({ evaluator: { kind: 'command',
        command: 'for i in 1 2 3; do npm test; done', expect: 'PASSED', repeat: 3 } as any })], CTX)
        .findings.some((f) => f.code === 'UNRESOLVABLE_EVALUATOR'));
    check('OR134: the prompt teaches the field and forbids the loop',
      (() => { const src = fs.readFileSync(path.resolve(__dirname, '../src/mission/compile.ts'), 'utf8');
        return /"repeat": N \(1-10\)/.test(src) && /Never write shell loops/.test(src)
          && /inline verification is a probe, not a command/.test(src); })());
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
  section('oracle: a critique that cannot change the outcome is decoration');
  {
    const F = (code: string, criterionId = 'p/M-0001/C-0001') => ({ code, criterionId, detail: `${code} detail.` });

    // The M-0002 shape, replayed: seven findings and an opinion of AUTO.
    const m0002 = [F('BEYOND_GOAL', 'p/M-0001/C-0003'), F('EVALUATOR_INSUFFICIENT', 'p/M-0001/C-0003'),
      F('EVALUATOR_MISMATCH', 'p/M-0001/C-0004'), F('BEYOND_GOAL', 'p/M-0001/C-0005'),
      F('BEYOND_GOAL', 'p/M-0001/C-0006'), F('BEYOND_GOAL', 'p/M-0001/C-0007'),
      F('AUTHORITY_UNDECLARED', 'p/M-0001/C-0001')];
    const replayed = proposeAcceptance([criterion()], CTX, 'AUTO', m0002);
    check('OR140: the M-0002 shape now floors at REQUIRED_CONSENT',
      replayed.mode === 'REQUIRED_CONSENT' && replayed.floor.floor === 'REQUIRED_CONSENT',
      `${replayed.mode} (was OPTIONAL_CONFIRMATION, auto-accepted)`);
    check('OR141: an evaluator whose validity is contested is what forces it',
      replayed.floor.families['evaluator-integrity'] === 2
      && replayed.floor.forcedBy.some((f) => f.code === 'EVALUATOR_MISMATCH'),
      JSON.stringify(replayed.floor.families));
    check('OR142: the old auto-accept path is dead — this is not auto-acceptable',
      replayed.autoAcceptable === false);
    check('OR143: the critic\'s OPINION of AUTO no longer decides anything',
      replayed.escalatedByCritic === false && replayed.escalatedByFindings === true,
      'the findings escalated it, the opinion did not');

    const scopeOnly = proposeAcceptance([criterion()], CTX, 'AUTO', [F('BEYOND_GOAL')]);
    check('OR144: scope-only findings floor at OPTIONAL_CONFIRMATION',
      scopeOnly.mode === 'OPTIONAL_CONFIRMATION' && scopeOnly.floor.floor === 'OPTIONAL_CONFIRMATION');
    check('OR145: and it is a REAL stop — any finding means a human looks',
      scopeOnly.autoAcceptable === false);
    const clean = proposeAcceptance([criterion()], CTX, null, []);
    check('OR146: a findings-free critique keeps the old fast path',
      clean.mode === 'AUTO' && clean.autoAcceptable === true && clean.floor.findingCount === 0);
    check('OR147: an unrecognised code still counts — an unknown objection is not a resolved one',
      findingFamily('SOMETHING_NOBODY_ENUMERATED') === 'other'
      && proposeAcceptance([criterion()], CTX, null, [F('SOMETHING_NOBODY_ENUMERATED')])
        .autoAcceptable === false);
    check('OR148: the families are matched on shape, so the critic\'s invented codes sort correctly',
      findingFamily('EVALUATOR_DOES_NOT_PROVE_STATEMENT') === 'evaluator-integrity'
      && findingFamily('RUBRIC_TOO_WEAK') === 'evaluator-integrity'
      && findingFamily('AI_JUDGED_MECHANICALLY_PROVABLE') === 'evaluator-integrity'
      && findingFamily('UNDECLARED_AUTHORITY') === 'scope-authority');

    // Escalate-only, across the grid.
    const grid: Array<[AcceptanceMode, string[], AcceptanceMode]> = [
      ['AUTO', [], 'AUTO'],
      ['AUTO', ['BEYOND_GOAL'], 'OPTIONAL_CONFIRMATION'],
      ['AUTO', ['EVALUATOR_MISMATCH'], 'REQUIRED_CONSENT'],
      ['OPTIONAL_CONFIRMATION', [], 'OPTIONAL_CONFIRMATION'],
      ['OPTIONAL_CONFIRMATION', ['BEYOND_GOAL'], 'OPTIONAL_CONFIRMATION'],
      ['OPTIONAL_CONFIRMATION', ['EVALUATOR_MISMATCH'], 'REQUIRED_CONSENT'],
      ['REQUIRED_CONSENT', [], 'REQUIRED_CONSENT'],
      ['REQUIRED_CONSENT', ['BEYOND_GOAL'], 'REQUIRED_CONSENT'],
      ['REQUIRED_CONSENT', ['EVALUATOR_MISMATCH'], 'REQUIRED_CONSENT'],
    ];
    const wrong = grid.filter(([computed, codes, want]) =>
      applyCriticMode(computed, findingsFloor(codes.map((c) => F(c))).floor).mode !== want);
    check('OR149: floors only ever RAISE — never lower a computed mode',
      wrong.length === 0,
      wrong.map(([c, f, w]) => `${c}+${f.join()} wanted ${w}`).join(' | '));
  }

  // ---------------------------------------------------------------------
  section('oracle: the fix loop shows the compiler the critique, never the critic');
  {
    const seen: Record<string, string> = {};
    const recording = (id: string, reply: unknown) => ({
      id, async available() { return { ok: true, detail: 'recording fake' }; },
      async invoke(req: any) {
        seen[id] = req.prompt;
        return { ok: true, role: req.role, structured: reply as any, text: '', raw: '',
          exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null };
      },
    });
    const priorCriteria = [criterion()];
    const priorFindings = [{ code: 'EVALUATOR_MISMATCH', criterionId: 'p/M-0001/C-0001',
      detail: 'the probe diffs against HEAD, not the mission base.' }];

    await compileOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'a goal', context: CTX,
      provider: recording('compiler', { criteria: [] }) as any,
      supervisor: sup, policy, baseSha: 'sha',
      prior: { criteria: priorCriteria, findings: priorFindings, version: 1 },
    });
    check('OR150: the COMPILER is shown the previous attempt and the findings',
      /EVALUATOR_MISMATCH/.test(seen.compiler) && /previous attempt \(oracle v1\)/.test(seen.compiler)
      && /Answer these findings/.test(seen.compiler));

    const round2 = await critiqueOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'a goal', criteria: priorCriteria,
      context: CTX, provider: recording('critic', { findings: [], modeOpinion: null }) as any,
      supervisor: sup, policy, baseSha: 'sha',
    });
    check('OR151: the round-2 CRITIC sees no prior verdict — not the codes, not the details',
      !/EVALUATOR_MISMATCH/.test(seen.critic) && !/diffs against HEAD/.test(seen.critic)
      && round2.payload.deliveredContext.sort().join()
        === 'compiled-criteria,evidence-summary,mission-goal,project-commands');
    check('OR152: and a prior verdict offered to it is refused outright',
      (await critiqueOracle({
        missionId: 'p/M-0001', projectId: 'p', goal: 'a goal', criteria: priorCriteria,
        context: CTX, provider: recording('critic2', { findings: [] }) as any,
        supervisor: sup, policy, baseSha: 'sha',
        extraInputs: [{ kind: 'critic-verdict', label: 'ROUND 1', content: 'EVALUATOR_MISMATCH on C-0001' }],
      })).valid === false);
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
      && afterCompile.acceptedBy === 'default-policy'
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

    // ---- the stop, at the CLI ------------------------------------------
    // A mission whose oracle carries findings, seeded through the registry so
    // the CLI paths can be exercised without a scripted provider.
    const store = new EventStore(path.join(root, '.zeus/state'));
    const missions = new MissionRegistry({ events: store, projectId: 'cli' });
    const stop = missions.create('a goal whose critique objects', 'sha');
    const stopOracle: Oracle = { ...oracleOf([criterion({ criterionId: `${stop.missionId}/C-0001` })]),
      missionId: stop.missionId, acceptanceMode: 'REQUIRED_CONSENT' };
    missions.recordOracle(stop.missionId, stopOracle, 'sha256:x', { valid: true });
    missions.recordCritique(stop.missionId, {
      valid: true, modeOpinion: 'AUTO', promptHash: 'sha256:p', hashes: {}, violations: [],
      criticProviderId: 'mock', reconciliation: { consistent: true, unsupportedClaims: [] },
      findings: [
        { code: 'EVALUATOR_MISMATCH', criterionId: `${stop.missionId}/C-0001`,
          detail: 'The probe compares against HEAD, not the mission base. It passes trivially.' },
        { code: 'BEYOND_GOAL', criterionId: `${stop.missionId}/C-0001`,
          detail: 'A full project build is unrelated to this goal.' },
      ],
    });
    const stopLabel = 'M-0003';

    check('OR160: an unaccepted oracle with findings authorises no evaluation',
      (await run('mission', 'evaluate', stopLabel, '--mock')) === 1);

    // `confirm` renders the findings BEFORE accepting, and records them.
    const confirmCode = await run('mission', 'confirm', stopLabel);
    const confirmText = said();
    check('OR161: confirm renders the findings before it accepts anything',
      confirmCode === 0 && /EVALUATOR_MISMATCH/.test(confirmText) && /BEYOND_GOAL/.test(confirmText)
      && /2 finding\(s\) from the independent critique/.test(confirmText),
      confirmText.split('\n').slice(0, 4).join(' | '));
    check('OR162: and the first line of each finding is shown, not just its code',
      /passes trivially|compares against HEAD/.test(confirmText));
    check('OR163: the acceptance says it happened DESPITE the findings',
      /despite 2 finding\(s\)/.test(confirmText), confirmText.split('\n').pop() ?? '');

    const acceptedRec = missions.mission(stop.missionId)!;
    check('OR164: ORACLE_ACCEPTED carries the finding ids, so a report can show what was overridden',
      acceptedRec.oracleAccepted && acceptedRec.acceptedBy === 'user-confirmed'
      && acceptedRec.acceptedDespite.length === 2
      && acceptedRec.acceptedDespite.some((f) => f.code === 'EVALUATOR_MISMATCH'),
      JSON.stringify(acceptedRec.acceptedDespite));
    check('OR165: "accepted with seven invisible findings" is now unrepresentable',
      acceptedRec.acceptedBy !== ('consent-flag' as any));

    // ---- the recompile bound -------------------------------------------
    const bounded = missions.create('a goal recompiled too often', 'sha');
    missions.recordOracle(bounded.missionId,
      { ...oracleOf([criterion({ criterionId: `${bounded.missionId}/C-0001` })]),
        missionId: bounded.missionId }, 'sha256:y', { valid: true });
    // Through the RECORDING PATH, not a hand-built payload. This test used to
    // append an ORACLE_COMPILED carrying `findingsForwarded: true`, a shape
    // nothing in the product writes — so it passed while the real counter sat
    // at 0 and the bound below could never be reached by anything but this
    // test. A fixture that manufactures the state under test proves the
    // assertion, not the product.
    for (let i = 0; i < 2; i += 1) {
      missions.recordOracle(bounded.missionId,
        { ...oracleOf([criterion({ criterionId: `${bounded.missionId}/C-0001` })]),
          missionId: bounded.missionId, version: i + 2 }, 'sha256:y', { valid: true });
      missions.recordRecompile(bounded.missionId,
        { fromVersion: i + 1, findingsForwarded: 1, attempt: i + 1, limit: 2 });
    }
    check('OR166: the log counts how many times the critique was sent back',
      missions.mission(bounded.missionId)!.recompiles === 2,
      String(missions.mission(bounded.missionId)!.recompiles));
    const overBound = await run('mission', 'recompile', 'M-0004', '--mock');
    check('OR167: recompiling past the bound is refused, and says why',
      overBound === 1 && /limit is 2/.test(said()), said().trim().split('\n')[0]);
  }

  sup.shutdown('oracle suite finished');
  fs.rmSync(TMP, { recursive: true, force: true });
}
