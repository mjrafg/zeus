/**
 * V1 isolation: capability and verification instead of a sandbox.
 *
 * The provider sandbox was the boundary AND the reason the codex critics could
 * not see the repository graph. V1 trades it for a trusted host, a role
 * instruction, and a git check after every read-only call. These are the
 * properties that trade depends on.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import {
  checkWrites, parsePorcelain, isReadOnlyStage, READ_ONLY_STAGES, violationPayload,
  verdictFor, blocks, verdictDetail,
} from '../src/engine/writecheck';
import {
  MCP_CAPABLE, GRAPH_TOOL_NAMES, graphToolIds, toolsFor, claudeProvider, codexProvider,
} from '../src/engine/providers';
import { verifyGraphEvidence, goalRequiresGraphEvidence, intelSection, repoIndex, GRAPH_FIRST }
  from '../src/graph/intel';
import {
  checkReadScope, readScopeSummary, toolCallsIn, pathsIn, classifyPath, blocksInV1,
} from '../src/engine/readscope';
import { CRITIQUE_HEADER, CRITIQUE_GLOSSARY, critiqueOracle, compileOracle }
  from '../src/mission/compile';
import { planMission, critiquePlan } from '../src/mission/planner';
import { decide } from '../src/mission/frontdoor';
import { validateOracle } from '../src/mission/oracle';
import { buildReviewPayload, ORACLE_CRITIQUE_POLICY } from '../src/engine/reviewcontext';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-v1iso-'));
let seq = 0;

/** A real git repository, because the check shells out to real git. */
function repo(): string {
  const root = path.join(TMP, `r${seq += 1}`);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'doomed.txt'), 'delete me\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-qm', 'init']);
  return root;
}

/** The argv a provider would actually run, without running it. */
function argvOf(provider: any, req: any): string[] {
  const seen: string[] = [];
  const sup = { run: async (spec: any) => { seen.push(...spec.args); return {
    outcome: 'COMPLETED', stdout: '', stderr: '', exitCode: 0, durationMs: 1 }; } };
  provider.invoke(req, sup as any);
  return seen;
}

export async function isolationV1Suite(): Promise<void> {
  section('V1: the sandbox is gone, and both providers can hold the graph');
  {
    // codex used to be excluded: its exec mode routed MCP calls through an
    // approval gate with nobody to ask, so the tools were discovered, begun
    // and failed with "user cancelled MCP tool call".
    check('V1-A1: codex can hold MCP tools now',
      MCP_CAPABLE.has('codex'), [...MCP_CAPABLE].join(','));
    check('V1-A2: and so can claude, as before',
      MCP_CAPABLE.has('claude'), [...MCP_CAPABLE].join(','));

    const graph = { command: '/bin/node', args: ['x'], logPath: null };
    const cx = argvOf(codexProvider('codex'),
      { prompt: 'p', policy: {}, readOnly: true, graph, role: 'reviewer',
        taskId: 't', projectId: 'p' });
    check('V1-A3: the codex read-only sandbox flag is gone',
      !cx.includes('--sandbox'), cx.slice(0, 6).join(' '));
    check('V1-A4: replaced by the trusted-host bypass, so MCP calls are not cancelled',
      cx.includes('--dangerously-bypass-approvals-and-sandbox'), 'bypass present');
    check('V1-A5: and the graph server is still attached per invocation, not globally',
      cx.some((a) => a.startsWith('mcp_servers.zeusgraph.command=')), 'per-call');

    const cl = argvOf(claudeProvider('claude'),
      { prompt: 'p', policy: {}, readOnly: true, graph, role: 'reviewer',
        taskId: 't', projectId: 'p' });
    // `manual` asked permission of a person who was not there.
    check('V1-A6: claude no longer asks a permission nobody can answer',
      !cl.includes('manual') && cl.includes('bypassPermissions'),
      cl[cl.indexOf('--permission-mode') + 1]);

    // B and C: the critics get the tools by name.
    for (const [id, tool] of [['V1-B1', 'graph_dependents'], ['V1-C1', 'graph_path'],
      ['V1-A7', 'graph_search']] as Array<[string, string]>) {
      check(`${id}: a read-only codex role is offered ${tool}`,
        toolsFor(true, graph as any).includes(`mcp__zeusgraph__${tool}`), tool);
    }
    check('V1-C2: all six graph tools, exactly',
      GRAPH_TOOL_NAMES.length === 6
      && graphToolIds().every((t) => toolsFor(true, graph as any).includes(t)),
      GRAPH_TOOL_NAMES.join(', '));
  }

  section('V1: a project graph is not the same fact as an agent’s access to it');
  {
    // "Graphify: UNAVAILABLE" used to cover both "this project has no graph"
    // and "this project has a good graph that YOU cannot reach". An agent told
    // the second reads it as the first and stops asking.
    const ix = repoIndex(TMP, 'abc123');
    const ready = { projectId: 'p', indexedRevision: 'abc123', currentRevision: 'abc123',
      graphPath: '/g', present: true, stale: false, nodes: 965, edges: 2659,
      indexedAt: null, indexMs: 5, fault: null, detail: 'ok' };

    const denied = intelSection({ projectId: 'p', index: ix, graph: ready as any,
      graphAvailable: false, graphifyVersion: '0.9.49',
      unavailableBecause: 'this call was not given graph tools' });
    check('V1-D1: the project graph is still reported READY',
      /PROJECT GRAPH/.test(denied) && /status: READY/.test(denied), 'project fact kept');
    check('V1-D2: with its size and revision, even though this agent cannot reach it',
      /965 node\(s\), 2659 edge\(s\)/.test(denied) && /indexed revision: abc123/.test(denied),
      'facts survive');
    check('V1-D3: access is reported separately, and says NO',
      /YOUR ACCESS TO IT/.test(denied) && /available: NO/.test(denied), 'told apart');
    check('V1-D4: with the reason for THIS call',
      /this call was not given graph tools/.test(denied), 'reason given');
    // The instruction that matters: do not conclude the repository is shapeless.
    check('V1-D5: and it says explicitly not to conclude the repo has no structure',
      /Do not conclude the repository has no structure/.test(denied), 'stated');

    const have = intelSection({ projectId: 'p', index: ix, graph: ready as any,
      graphAvailable: true, graphifyVersion: '0.9.49' });
    check('V1-D6: an agent that HAS access is told so, under the same heading',
      /YOUR ACCESS TO IT/.test(have) && /available: YES/.test(have), 'symmetric');
  }

  section('V1: the repository is checked after every read-only stage');
  {
    check('V1-E0: the read-only roles are exactly the six named',
      [...READ_ONLY_STAGES].sort().join(',')
        === 'front-door,oracle,oracle-critic,plan-critic,planner,reviewer',
      [...READ_ONLY_STAGES].sort().join(','));
    // J: the writers are absent, so their worktree edits are never a violation.
    check('V1-J1: implementer and repair are NOT read-only stages',
      !isReadOnlyStage('implementer') && !isReadOnlyStage('repair'),
      'writers excluded');
    check('V1-J2: so no write check is applied to them at all',
      !READ_ONLY_STAGES.has('implementer') && !READ_ONLY_STAGES.has('repair'),
      'their worktrees are their own');

    const clean = repo();
    const c = checkWrites(clean);
    check('V1-E1: an untouched tree passes',
      c.clean === true, JSON.stringify(c));
    check('V1-E2: and it is fast enough to sit on the normal path',
      c.durationMs < 2000, `${c.durationMs}ms`);

    // F — a modified tracked file.
    const mod = repo();
    fs.writeFileSync(path.join(mod, 'tracked.txt'), 'changed by an agent\n');
    const f = checkWrites(mod) as any;
    check('V1-F1: a modified tracked file is a violation',
      f.clean === false && f.modified.includes('tracked.txt'), JSON.stringify(f.modified));
    check('V1-F2: and the diff is collected, but only because something changed',
      /changed by an agent/.test(f.diff), f.diff.slice(0, 60));

    // G — staged.
    const stg = repo();
    fs.writeFileSync(path.join(stg, 'tracked.txt'), 'staged edit\n');
    execFileSync('git', ['-C', stg, 'add', 'tracked.txt']);
    const g = checkWrites(stg) as any;
    check('V1-G1: a STAGED modification is a violation too',
      g.clean === false && g.staged.includes('tracked.txt'), JSON.stringify(g.staged));
    check('V1-G2: and --cached is captured, which a working-tree diff would miss',
      /staged edit/.test(g.diffCached), g.diffCached.slice(0, 60));

    // H — deleted.
    const del = repo();
    fs.rmSync(path.join(del, 'doomed.txt'));
    const h = checkWrites(del) as any;
    check('V1-H1: a deleted file is a violation',
      h.clean === false && h.deleted.includes('doomed.txt'), JSON.stringify(h.deleted));

    // I — untracked.
    const nw = repo();
    fs.writeFileSync(path.join(nw, 'invented.txt'), 'the agent made this\n');
    const i = checkWrites(nw) as any;
    check('V1-I1: a NEW untracked file is a violation',
      i.clean === false && i.untracked.includes('invented.txt'), JSON.stringify(i.untracked));
    check('V1-I2: writing a new file is writing, even though nothing tracked moved',
      i.modified.length === 0 && i.untracked.length === 1, 'caught by untracked alone');

    // The payload is what someone reads later.
    const p = violationPayload({ stage: 'reviewer', traceCallId: 'TC-1',
      beforeRevision: 'aaa', check: f });
    check('V1-E3: the violation names the stage, the call and both revisions',
      p.reasonCode === 'ROLE_WRITE_VIOLATION' && p.stage === 'reviewer'
      && p.traceCallId === 'TC-1' && p.beforeRevision === 'aaa' && !!p.afterRevision,
      JSON.stringify({ s: p.stage, t: p.traceCallId }));
    // V1 observes rather than reverts, and the record says so plainly.
    check('V1-E4: and says the change was NOT reverted, so nobody assumes it was',
      /does not revert it/.test(String(p.detail)), String(p.detail).slice(0, 70));
  }

  section('V1: a check that could not run is not a check that passed');
  {
    // This returned {clean: true} for a tree it could not inspect, and the
    // comment claimed the absence was recorded elsewhere. It was not. A
    // non-repository, a missing git, or git refusing on "dubious ownership"
    // when the process runs as a different user than the repo's owner all read
    // exactly like a tree inspected and found spotless — a fail-open in the one
    // check whose entire job is catching writes.
    const notRepo = checkWrites(path.join(TMP, 'not-a-repo-at-all'));
    check('V1-U1: an uninspectable tree is NOT reported as inspected',
      notRepo.clean === true && (notRepo as any).inspected === false,
      JSON.stringify(notRepo));
    check('V1-U2: and it says the answer is unknown, not that nothing happened',
      /UNKNOWN — not confirmed clean/.test(String((notRepo as any).uninspectable)),
      String((notRepo as any).uninspectable));

    const real = repo();
    const looked = checkWrites(real);
    check('V1-U3: a real clean tree IS marked inspected, so the two differ',
      looked.clean === true && (looked as any).inspected === true,
      JSON.stringify({ clean: looked.clean, inspected: (looked as any).inspected }));

    fs.writeFileSync(path.join(real, 'tracked.txt'), 'edited\n');
    const dirty = checkWrites(real) as any;
    check('V1-U4: and a violation is inspected by definition',
      dirty.clean === false && dirty.inspected === true, JSON.stringify(dirty.inspected));
    // Three states, all distinguishable on the record.
    check('V1-U5: clean, dirty and unknown are three states, not two',
      new Set([
        `${looked.clean}/${(looked as any).inspected}`,
        `${dirty.clean}/${dirty.inspected}`,
        `${notRepo.clean}/${(notRepo as any).inspected}`,
      ]).size === 3, 'told apart');
  }

  section('V1: zeus own state is not the project source');
  {
    // The Oracle was flagged for "modifying" .zeus/config.yaml and
    // .zeus/.gitignore, which `zeus init` had just created. .zeus/ holds the
    // event log, the worktrees and the graph — written by Zeus on every
    // mission, by design — so counting it would have blocked every real run
    // for doing exactly what it is supposed to do.
    const r = repo();
    fs.mkdirSync(path.join(r, '.zeus', 'state'), { recursive: true });
    fs.writeFileSync(path.join(r, '.zeus', 'config.yaml'), 'version: 1\n');
    fs.writeFileSync(path.join(r, '.zeus', 'state', 'events.jsonl'), '{}\n');
    const z = checkWrites(r);
    check('V1-ZX1: zeus writing its own state is not a role write violation',
      z.clean === true && (z as any).inspected === true, JSON.stringify(z));

    // And the exclusion must not become a hiding place for real edits.
    fs.writeFileSync(path.join(r, 'tracked.txt'), 'a role really did edit this\n');
    const both = checkWrites(r) as any;
    check('V1-ZX2: but a real source edit alongside it still violates',
      both.clean === false && both.modified.includes('tracked.txt'),
      JSON.stringify(both.modified));
    check('V1-ZX3: and .zeus never appears in the evidence',
      !JSON.stringify(both).includes('.zeus/'), 'excluded from the record too');
  }

  section('V1: inspected:false is fail-CLOSED, not merely recorded');
  {
    // Recording "unknown" and continuing is still a fail-open: the pipeline
    // proceeds on an unverified result while the trace says the role was
    // checked. The instruction is the only thing keeping a read-only role
    // read-only in V1, and this check is the only thing confirming it held.
    const clean = verdictFor('reviewer', 'TC-1', 'aaa',
      { clean: true, inspected: true, revision: 'bbb', durationMs: 3 });
    const dirty = verdictFor('reviewer', 'TC-1', 'aaa', {
      clean: false, inspected: true, revision: 'bbb', durationMs: 9,
      modified: ['src/a.ts'], staged: [], deleted: [], untracked: [], renamed: [],
      diff: 'x', diffCached: '', porcelain: ' M src/a.ts',
    });
    const unknown = verdictFor('reviewer', 'TC-1', 'aaa',
      { clean: true, inspected: false, revision: null, durationMs: 4,
        uninspectable: 'git refused: dubious ownership' });

    check('V1-FC1: verified clean is the ONLY state that continues',
      clean.state === 'VERIFIED_CLEAN' && !blocks(clean), clean.state);
    check('V1-FC2: a violation blocks',
      dirty.state === 'ROLE_WRITE_VIOLATION' && blocks(dirty), dirty.state);
    check('V1-FC3: and an uninspectable tree blocks EXACTLY as hard',
      unknown.state === 'WRITE_CHECK_UNAVAILABLE' && blocks(unknown), unknown.state);
    check('V1-FC4: the three map one-to-one onto the required semantics',
      new Set([clean.state, dirty.state, unknown.state]).size === 3,
      [clean.state, dirty.state, unknown.state].join(' | '));
    check('V1-FC5: the unavailable reason names what git actually said',
      /dubious ownership/.test(verdictDetail(unknown)), verdictDetail(unknown));
    check('V1-FC6: and it is never phrased as a pass',
      !/clean|verified/i.test(verdictDetail(unknown).replace('WRITE_CHECK_UNAVAILABLE', '')),
      verdictDetail(unknown));

    // THE REGRESSION. Every read-only role, one at a time, with a check that
    // cannot inspect: none may proceed as if the repository were verified.
    const src = {
      compile: fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'compile.ts'), 'utf8'),
      planner: fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'planner.ts'), 'utf8'),
    };
    check('V1-FC7: every stage that can be handed a verdict acts on it',
      (src.compile.match(/if \(writeVerdict && blocks\(writeVerdict\)\)/g) ?? []).length === 2
      && (src.planner.match(/if \(writeVerdict && blocks\(writeVerdict\)\)/g) ?? []).length === 2,
      'oracle, oracle-critic, planner, plan-critic');
    // The guard has to sit BEFORE the ordinary success path, or a blocked
    // verdict is computed and then walked past.
    for (const [name, text] of Object.entries(src)) {
      check(`V1-FC8-${name}: the guard precedes the provider-failure branch`,
        text.indexOf('if (writeVerdict && blocks(writeVerdict))')
          < text.indexOf('if (!res.ok || res.infrastructureFailure'),
        'ordered before continuing');
    }
    check('V1-FC9: a blocked stage reports the verdict as its failure, not a generic one',
      /infrastructureFailure: verdictDetail\(writeVerdict\)/.test(src.compile)
      && /verdictDetail\(writeVerdict\)/.test(src.planner), 'the reason travels');

    // And the six roles are the ones that get a verifier at all.
    const ops = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'operations.ts'), 'utf8');
    check('V1-FC10: only read-only stages are given a verifier',
      /isReadOnlyStage\(stage\)\s*\n?\s*\?/.test(ops), 'gated on the role');
    for (const role of ['front-door', 'oracle', 'oracle-critic', 'planner',
      'plan-critic', 'reviewer']) {
      check(`V1-FC11-${role}: ${role} is verified after every call`,
        isReadOnlyStage(role), role);
    }
    check('V1-FC12: and the writers are still not, so their worktrees are untouched',
      !isReadOnlyStage('implementer') && !isReadOnlyStage('repair'), 'writers exempt');

    // The event an operator reads. Both blocking states get their own name.
    check('V1-FC13: the unavailable case is emitted under its own event type',
      /type: verdict\.state/.test(ops) && /WRITE_CHECK_UNAVAILABLE/.test(ops),
      'named on the log');
    check('V1-FC14: and says the stage is NOT verified, so nobody reads it as a pass',
      /this stage is NOT verified/.test(ops), 'consequence stated');
  }

  section('V1: porcelain is parsed by column, because the columns mean different things');
  {
    // X is the index, Y is the working tree. Conflating them loses whether the
    // agent had also staged the change.
    const parsed = parsePorcelain([
      ' M unstaged.ts', 'M  staged.ts', 'MM both.ts', '?? new.ts',
      ' D gone.ts', 'D  removed.ts', 'R  moved.ts',
    ].join('\n'));
    check('V1-P1: an unstaged edit is modified and not staged',
      parsed.modified.includes('unstaged.ts') && !parsed.staged.includes('unstaged.ts'),
      JSON.stringify(parsed.modified));
    check('V1-P2: a staged edit is both',
      parsed.staged.includes('staged.ts') && parsed.modified.includes('staged.ts'),
      JSON.stringify(parsed.staged));
    check('V1-P3: staged AND edited again is still one file, not two',
      parsed.modified.filter((f) => f === 'both.ts').length === 1, 'deduplicated');
    check('V1-P4: untracked is never counted as modified',
      parsed.untracked.includes('new.ts') && !parsed.modified.includes('new.ts'),
      JSON.stringify(parsed.untracked));
    check('V1-P5: deletions are caught from either column',
      parsed.deleted.includes('gone.ts') && parsed.deleted.includes('removed.ts'),
      JSON.stringify(parsed.deleted));
    check('V1-P6: and a rename is recorded as one',
      parsed.renamed.includes('moved.ts'), JSON.stringify(parsed.renamed));
  }

  section('V1: attachment is not evidence');
  {
    // The first Oracle to hold graph tools made ZERO queries. Certifying an
    // investigation from graphAttached would have certified that.
    const goal = 'Refactor localization. You MUST use the repository dependency graph '
      + 'as the primary navigation mechanism and report the blast radius.';
    check('V1-K1: a goal that demands the graph is recognised as requiring evidence',
      goalRequiresGraphEvidence(goal), 'required');
    check('V1-K2: an ordinary goal is not',
      !goalRequiresGraphEvidence('add a FAQ section to the landing page'), 'not required');

    const none = verifyGraphEvidence(goal, []);
    check('V1-K3: required + zero graph queries is NOT established',
      none.required && !none.established && none.queryCount === 0, JSON.stringify(none));
    check('V1-K4: and the reason says attachment is not evidence',
      /attachment is not evidence/.test(none.reason), none.reason);

    // Tool calls that are not graph calls do not count either.
    const wrong = verifyGraphEvidence(goal, [{ tool: 'zeus_missions' }, { tool: 'Read' }]);
    check('V1-K5: non-graph tool calls do not establish graph evidence',
      !wrong.established && wrong.queryCount === 0, JSON.stringify(wrong.distinctTools));

    const real = verifyGraphEvidence(goal,
      [{ tool: 'graph_search' }, { tool: 'graph_dependents' }, { tool: 'graph_path' }]);
    check('V1-K6: real graph queries establish it, and name the tools',
      real.established && real.queryCount === 3 && real.distinctTools.length === 3,
      real.distinctTools.join(', '));

    // Asking and finding nothing IS use. Not asking is not.
    const empty = verifyGraphEvidence(goal, [{ tool: 'graph_search' }]);
    check('V1-K7: a query that returned nothing still counts as having asked',
      empty.established, empty.reason);
  }

  /* ---------------------------------------------------------------------- *
   * Read scope: where a stage LOOKED, not just whether it wrote.
   *
   * Replayed from talkbridge/M-0032, whose oracle critic read the project
   * correctly and then read Zeus's own source and every mission's event log,
   * because the prompt asked it to answer in a vocabulary it was never given.
   * ---------------------------------------------------------------------- */

  section('V1 read scope: an unreadable transcript is not a clean one');
  {
    const meta = { stage: 'oracle-critic', traceCallId: 'TC-test', provider: 'codex' };
    const roots = { projectRoot: '/work/talkbridge',
      zeusRoot: '/opt/zeus-engine', stateRoot: null };

    const unreadable = checkReadScope('this is prose, not a transcript', roots, meta);
    check('V1-RS1: a transcript Zeus cannot parse is UNKNOWN, never in scope',
      unreadable.state === 'READ_SCOPE_UNKNOWN', unreadable.state);
    check('V1-RS2: and the summary refuses to claim it was in scope',
      readScopeSummary(unreadable).inScope === null
      && readScopeSummary(unreadable).inspected === false,
      JSON.stringify(readScopeSummary(unreadable)));

    const empty = checkReadScope('', roots, meta);
    check('V1-RS3: an absent transcript is UNKNOWN too, and says which',
      empty.state === 'READ_SCOPE_UNKNOWN'
      && /returned no transcript/.test((empty as any).detail),
      (empty as any).detail);

    // The distinction the write check had to learn: nothing found and nothing
    // readable are different facts.
    const quiet = ['{"type":"thread.started","thread_id":"x"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed"}'].join('\n');
    const q = checkReadScope(quiet, roots, meta);
    check('V1-RS4: a REAL zero — recognised transcript, no tool calls — is in scope',
      q.state === 'VERIFIED_IN_SCOPE' && (q as any).toolCalls === 0, q.state);
  }

  section('V1 read scope: what the two provider transcripts say was called');
  {
    const codex = [
      '{"type":"thread.started","thread_id":"x"}',
      JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution',
        command: '/bin/bash -lc "rg --files"' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution',
        command: '/bin/bash -lc "rg --files"' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'command_execution',
        command: '/bin/bash -lc "sed -n 1,80p app/src/pages/landing.jsx"' } }),
    ].join('\n');
    const parsedCodex = toolCallsIn(codex);
    check('V1-RS5: a codex transcript is recognised and its shell commands read',
      parsedCodex.recognised && parsedCodex.calls.length === 2,
      `${parsedCodex.calls.length} call(s)`);
    check('V1-RS6: a command reported at started AND completed counts once',
      parsedCodex.calls.filter((c) => /rg --files/.test(c.text)).length === 1);

    const claude = [
      '{"type":"system","subtype":"init","tools":["Bash","Read"]}',
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start' } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/opt/zeus-engine/src/mission/oracle.ts' } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'cat app/package.json' } },
      ] } }),
      '{"type":"result","subtype":"success"}',
    ].join('\n');
    const parsedClaude = toolCallsIn(claude);
    check('V1-RS7: a claude transcript is recognised and its tool inputs read',
      parsedClaude.recognised && parsedClaude.calls.length === 2,
      parsedClaude.calls.map((c) => c.tool).join(', '));
    check('V1-RS8: the streamed deltas of the same call are not counted again',
      parsedClaude.calls.filter((c) => c.tool === 'Read').length === 1);

    // Only the CALLS. A grep that returns a hundred paths is one reach.
    const withResults = [
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution',
        command: '/bin/bash -lc "rg zeus app/src"',
        aggregated_output: '/opt/zeus-engine/src/a.ts\n/opt/zeus-engine/src/b.ts\n' } }),
    ].join('\n');
    const res = checkReadScope(withResults, roots2(), meta2());
    check('V1-RS9: paths in tool OUTPUT are not counted as reads',
      res.state === 'VERIFIED_IN_SCOPE', JSON.stringify(readScopeSummary(res)));
  }

  section('V1 read scope: what counts as leaving the repository');
  {
    const roots = roots2();
    const cls = (p: string) => classifyPath(p, roots)?.kind ?? 'IN_SCOPE';

    check('V1-RS10: a path inside the repository is in scope',
      cls('app/src/pages/landing.jsx') === 'IN_SCOPE'
      && cls('/work/talkbridge/app/src') === 'IN_SCOPE');
    // Every codex command begins /bin/bash -lc. A report whose top finding is
    // the shell it ran in is a report nobody reads twice.
    check('V1-RS11: the shell and the OS are not escapes',
      cls('/bin/bash') === 'IN_SCOPE' && cls('/usr/bin/env') === 'IN_SCOPE'
      && cls('/tmp/scratch') === 'IN_SCOPE');
    check('V1-RS12: Zeus\'s own installation is ZEUS_INSTALL',
      cls('/opt/zeus-engine/src/mission/oracle.ts') === 'ZEUS_INSTALL');
    // Inside the project, and still not the project.
    check('V1-RS13: .zeus is MISSION_STATE even though it lives in the repo',
      cls('.zeus') === 'MISSION_STATE'
      && cls('.zeus/state/tasks/talkbridge~M-0031/events.jsonl') === 'MISSION_STATE'
      && cls('/work/talkbridge/.zeus/state') === 'MISSION_STATE');
    check('V1-RS14: another project on the same host is OUTSIDE_PROJECT',
      cls('/work/other-project/src') === 'OUTSIDE_PROJECT'
      && cls('/var/lib/agent/.claude/settings.json') === 'OUTSIDE_PROJECT');
    // Zeus developed on itself must not report every read as an escape.
    const selfHosted = { projectRoot: '/opt/zeus-engine', zeusRoot: '/opt/zeus-engine',
      stateRoot: null };
    check('V1-RS15: when Zeus IS the project, its source is the work, not an escape',
      classifyPath('src/mission/oracle.ts', selfHosted) === null
      && classifyPath('/opt/zeus-engine/src/engine/exec.ts', selfHosted) === null);
    check('V1-RS16: and its .zeus is still out of bounds even then',
      classifyPath('.zeus/state', selfHosted)?.kind === 'MISSION_STATE');

    // MEASURED AGAINST THE REAL CORPUS. Replaying every transcript on the host
    // found three escapes and two were rg patterns. A signal that is
    // two-thirds noise is not a signal, so these exact strings are pinned.
    const noise = [
      "rg -n 'from\\s+[\\'\"]([^\\'\"]+)' app/src",
      "rg -n '\\$[0-9.]+/month' app/src/mock.js",
      "rg -n '/i18n|/setSettingsMany' app/src",
      "rg -n '(mock|content)\\.js' app/src",
    ].join(' && ');
    check('V1-RS18: regex fragments on a command line are not reads',
      pathsIn(noise).length === 0, pathsIn(noise).join(', '));
    check('V1-RS19: a single-segment absolute token is a regex delimiter, not a path',
      pathsIn('rg /month app').length === 0 && pathsIn('cat /etc/hosts').length === 1);
    check('V1-RS20: and the real reads still survive the filter',
      pathsIn('sed -n 1,5p /opt/zeus-engine/src/mission/oracle.ts').length === 1
      && pathsIn('grep -rl x .zeus/state/tasks/*/events.jsonl').length === 1,
      pathsIn('grep -rl x .zeus/state/tasks/*/events.jsonl').join(', '));

    check('V1-RS17: paths are found bare, dot-relative and absolute',
      pathsIn('find .zeus -maxdepth 3').includes('.zeus')
      && pathsIn('sed -n 1,5p ./app/x.js').includes('./app/x.js')
      && pathsIn('cat /etc/hosts').includes('/etc/hosts'));
  }

  section('V1 read scope: the M-0032 transcript, replayed');
  {
    // The four commands the oracle critic actually ran, in order.
    const transcript = [
      '{"type":"thread.started","thread_id":"01a03c81"}',
      cmd('/bin/bash -lc "pwd && rg --files | sed -n 1,240p"'),
      cmd('/bin/bash -lc "sed -n 1,260p app/src/pages/landing.jsx"'),
      cmd('/bin/bash -lc "find .zeus -maxdepth 3 -type f -print | sort"'),
      cmd('/bin/bash -lc "sed -n 1,500p /opt/zeus-engine/src/mission/oracle.ts"'),
      '{"type":"turn.completed"}',
    ].join('\n');

    const v = checkReadScope(transcript, roots2(), meta2());
    check('V1-RS41: the run that caused this is caught',
      v.state === 'ROLE_READ_ESCAPE', v.state);
    const p = (v as any).payload;
    check('V1-RS42: and both kinds are named — Zeus\'s source and the event log',
      p.byKind.ZEUS_INSTALL >= 1 && p.byKind.MISSION_STATE >= 1,
      JSON.stringify(p.byKind));
    check('V1-RS43: reading the project itself did not become a finding',
      !(v as any).reaches.some((r: any) => /landing\.jsx/.test(r.resolved)),
      (v as any).reaches.map((r: any) => r.resolved).join(', '));
    check('V1-RS21: each reach carries the command it appeared in, so a human can judge',
      (v as any).reaches.every((r: any) => r.via && r.tool),
      JSON.stringify((v as any).reaches[0]));
    check('V1-RS22: a MISSION_STATE reach says what it costs — independence',
      /independence/.test(String(p.independenceRisk ?? '')), String(p.independenceRisk ?? ''));
    check('V1-RS23: the record says plainly that V1 did not stop it',
      /does not stop the stage/.test(String(p.detail)), String(p.detail));

    // Project-only work must stay silent, or the signal is worthless.
    const clean = [
      '{"type":"thread.started","thread_id":"x"}',
      cmd('/bin/bash -lc "rg --files"'),
      cmd('/bin/bash -lc "sed -n 1,260p app/src/pages/landing.jsx"'),
      cmd('/bin/bash -lc "cat app/package.json && git status --short"'),
      '{"type":"turn.completed"}',
    ].join('\n');
    const c = checkReadScope(clean, roots2(), meta2());
    check('V1-RS24: a stage that stayed in the repository reports nothing',
      c.state === 'VERIFIED_IN_SCOPE', JSON.stringify(readScopeSummary(c)));
  }

  section('V1 read scope: evidence, not a gate');
  {
    const v = checkReadScope([cmd('/bin/bash -lc "cat /opt/zeus-engine/src/x.ts"')].join('\n'),
      roots2(), meta2());
    check('V1-RS25: V1 records a read escape and does NOT stop the stage',
      v.state === 'ROLE_READ_ESCAPE' && blocksInV1(v) === false);
    check('V1-RS26: nor does it stop for an unknown one',
      blocksInV1(checkReadScope('', roots2(), meta2())) === false);

    // The write check DOES stop. The two must not be confused for each other.
    check('V1-RS27: the write check still blocks, so the two are not the same lever',
      blocks({ state: 'WRITE_CHECK_UNAVAILABLE', ms: 1, detail: 'x' })
      && !blocks({ state: 'VERIFIED_CLEAN', ms: 1 }));

    // A computed event-type name is invisible to discoverEventTypes, so the
    // redaction probe would never exercise a payload carrying verbatim command
    // lines. Both names must be literal at their emit sites.
    const ops = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'operations.ts'), 'utf8');
    check('V1-RS28: both event names are LITERAL at the emit site, so RS2 covers them',
      /type: 'ROLE_READ_ESCAPE'/.test(ops) && /type: 'READ_SCOPE_UNKNOWN'/.test(ops));
  }

  section('V1 read scope: the prompt that sent it looking');
  {
    // The critic faulted an EXTERNAL_FACT probe for not being a declared
    // command. Zeus's own validator says otherwise, and now so does the prompt.
    const ctx = { commands: { build: 'npm --prefix api run build' },
      failingChecks: [], findings: [] };
    const probe = {
      criterionId: 'p/M-0001/C-0001', type: 'EXTERNAL_FACT' as const,
      statement: 'the app workspace builds',
      evaluator: { kind: 'probe' as const, command: 'npm --prefix app run build',
        expect: 'PASSED' as const, requiresNetwork: false },
      affectedBy: [], required: true, requiresAuthority: [], derivedFrom: [],
    };
    check('V1-RS29: a probe naming an undeclared command IS valid — the M-0032 finding was wrong',
      validateOracle([probe], ctx).valid, JSON.stringify(validateOracle([probe], ctx).findings));
    check('V1-RS30: and the glossary now says so, in the prompt, before it has to guess',
      /NOT required to be a declared command/.test(CRITIQUE_GLOSSARY)
      && /CORRECT USE of the/.test(CRITIQUE_GLOSSARY));
    check('V1-RS31: the glossary defines every mode the reply is asked to choose from',
      ['AUTO', 'OPTIONAL_CONFIRMATION', 'REQUIRED_CONSENT']
        .every((m) => new RegExp(`  ${m}\\s`).test(CRITIQUE_GLOSSARY)));
    check('V1-RS32: and states what a finding costs, which is why it went looking',
      /can only RAISE/.test(CRITIQUE_GLOSSARY)
      && /ANY finding removes the automatic path/.test(CRITIQUE_GLOSSARY));
    check('V1-RS33: the glossary reaches the critic — it is in the header, not beside it',
      CRITIQUE_HEADER.includes(CRITIQUE_GLOSSARY));
  }

  section('V1 read scope: the boundary is stated where every stage sees it');
  {
    const idx = repoIndex(process.cwd(), null, { maxFiles: 10 });
    const sec = intelSection({ projectId: 'p', index: { ...idx, root: '/work/talkbridge' },
      graph: null, graphAvailable: false, graphifyVersion: null });
    check('V1-RS34: the repository root is named as the boundary',
      /WHAT IS IN SCOPE/.test(sec)
      && /boundary of this task: \/work\/talkbridge/.test(sec));
    check('V1-RS35: .zeus is named, with the reason independence depends on it',
      /\.zeus\/ inside this repository/.test(sec) && /independence/.test(sec));
    check('V1-RS36: an undefined term is to be reported, not looked up',
      /Do\s*\n?.*not go looking for its implementation/.test(sec.replace(/\n/g, ' ')));
    check('V1-RS37: and the agent is told the transcript is read afterwards',
      /records every path you named/.test(sec));

    // THE SECTION THIS ALMOST BROKE ONCE ALREADY. My last addition to the
    // repository-intelligence section tripped ORACLE_CRITIQUE_POLICY and the
    // Oracle Critic silently never ran. Prose about "previous verdicts" is
    // exactly the shape the leak scanner looks for.
    const payload = buildReviewPayload({
      taskId: 'p/M-0001', projectId: 'p', baseSha: 'a', headSha: 'a',
      policy: ORACLE_CRITIQUE_POLICY, header: CRITIQUE_HEADER,
      inputs: [{ kind: 'repository-intelligence' as any,
        label: 'the repository this contract is about', content: sec }],
    });
    check('V1-RS38: the new scope text does NOT contaminate the critique payload',
      payload.valid, payload.violations.map((v) => v.detail).join(' | '));
  }

  section('V1 read scope: the check FIRES on a real stage, not just in isolation');
  {
    // A DECLARED CAPABILITY THAT NEVER RUNS is the failure this codebase keeps
    // finding: tools attached and never called, a critic wired and never
    // reached, a check computed inside a payload literal and discarded. So the
    // stage function is driven end to end and the trace record is read back.
    // Nothing here reaches the supervisor or the policy: the fake provider
    // answers without spawning. They exist because the signature asks for them.
    const sup: any = { run: async () => ({ outcome: 'COMPLETED', stdout: '', exitCode: 0,
      durationMs: 1, productSignal: true, violations: [] }) };
    const policy: any = { worktreeRoot: TMP, network: false, allowedCommands: [] };
    const CTX = { commands: { unitTest: 'npm test' }, failingChecks: [], findings: [] };

    const transcript = [
      '{"type":"thread.started","thread_id":"t"}',
      JSON.stringify({ type: 'item.completed', item: { id: 'i1',
        type: 'command_execution', command: '/bin/bash -lc "rg --files"' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i2',
        type: 'command_execution',
        command: '/bin/bash -lc "sed -n 1,400p /opt/zeus-engine/src/mission/oracle.ts"' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i3',
        type: 'command_execution',
        command: '/bin/bash -lc "find .zeus/state/tasks -name events.jsonl"' } }),
      '{"type":"turn.completed"}',
    ].join('\n');

    const wandering = {
      id: 'wandering',
      async available() { return { ok: true, detail: 'fake' }; },
      async invoke(req: any) {
        return { ok: true, role: req.role,
          structured: { findings: [], modeOpinion: 'AUTO' } as any,
          text: '', raw: transcript,
          exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null };
      },
    };

    const events: Array<{ type: string; payload: any }> = [];
    const scopeRoots = { projectRoot: '/work/talkbridge', zeusRoot: '/opt/zeus-engine',
      stateRoot: null };

    const critique = await critiqueOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'a goal',
      criteria: [criterionForScope()], context: CTX,
      provider: wandering as any, supervisor: sup, policy, baseSha: 'sha',
      stage: 'oracle-critic',
      trace: (type, payload) => events.push({ type, payload }),
      inspectReads: (traceCallId: string, raw: string) =>
        checkReadScope(raw, scopeRoots,
          { stage: 'oracle-critic', traceCallId, provider: 'wandering' }),
    } as any);

    const finished = events.find((e) => e.type === 'MODEL_CALL_FINISHED');
    check('V1-RS44: the stage records where it looked, on the call itself',
      !!finished?.payload?.readScope, JSON.stringify(Object.keys(finished?.payload ?? {})));
    check('V1-RS45: and it caught the wandering, through the real stage function',
      finished?.payload?.readScope?.state === 'ROLE_READ_ESCAPE'
      && finished?.payload?.readScope?.inScope === false,
      JSON.stringify(finished?.payload?.readScope));
    check('V1-RS46: naming both what it read and how much',
      finished?.payload?.readScope?.byKind?.ZEUS_INSTALL === 1
      && finished?.payload?.readScope?.byKind?.MISSION_STATE === 1,
      JSON.stringify(finished?.payload?.readScope?.byKind));
    // The write check stops a stage. This one must not, or V1 stopped
    // observing and started gating without anyone deciding to.
    check('V1-RS47: and the critique still returned — a read escape does NOT block in V1',
      critique.ok === true && critique.infrastructureFailure === null,
      String(critique.infrastructureFailure));

    // The same stage, staying home: the field must be present and say so,
    // rather than being absent whenever there is nothing to report.
    const homebody = {
      id: 'homebody',
      async available() { return { ok: true, detail: 'fake' }; },
      async invoke(req: any) {
        return { ok: true, role: req.role,
          structured: { findings: [], modeOpinion: 'AUTO' } as any, text: '',
          raw: ['{"type":"thread.started","thread_id":"t"}',
            JSON.stringify({ type: 'item.completed', item: { id: 'i1',
              type: 'command_execution', command: '/bin/bash -lc "cat app/package.json"' } }),
            '{"type":"turn.completed"}'].join('\n'),
          exitCode: 0, durationMs: 1, outcome: 'COMPLETED', infrastructureFailure: null };
      },
    };
    const quiet: Array<{ type: string; payload: any }> = [];
    await critiqueOracle({
      missionId: 'p/M-0001', projectId: 'p', goal: 'a goal',
      criteria: [criterionForScope()], context: CTX,
      provider: homebody as any, supervisor: sup, policy, baseSha: 'sha',
      stage: 'oracle-critic',
      trace: (type, payload) => quiet.push({ type, payload }),
      inspectReads: (traceCallId: string, raw: string) =>
        checkReadScope(raw, scopeRoots,
          { stage: 'oracle-critic', traceCallId, provider: 'homebody' }),
    } as any);
    const ok = quiet.find((e) => e.type === 'MODEL_CALL_FINISHED');
    check('V1-RS48: a stage that stayed home records that it was CHECKED and clean',
      ok?.payload?.readScope?.state === 'VERIFIED_IN_SCOPE'
      && ok?.payload?.readScope?.inspected === true,
      JSON.stringify(ok?.payload?.readScope));
  }

  /* ---------------------------------------------------------------------- *
   * Graph-first investigation: the guidance has to REACH the agent.
   *
   * M-0033 ran its Oracle and its Oracle Critic with the graph attached and
   * made zero graph calls between them - the critic reaching its answer through
   * 316,228 input tokens of hand discovery. The tools were attached and the
   * intelligence section was delivered. What was missing was any explanation of
   * what the tools were FOR, and a prompt that told the agent it had no limit.
   *
   * These check the WORDS ARRIVE, in the prompt each stage actually sends.
   * Asserting on intelSection alone would prove only that the text exists.
   * ---------------------------------------------------------------------- */

  section('graph-first: the guidance reaches every stage that holds the tools');
  {
    const READY: any = {
      projectId: 'p', indexedRevision: 'sha', currentRevision: 'sha',
      graphPath: 'g.json', present: true, stale: false, nodes: 900, edges: 2600,
      indexedAt: null, indexMs: null, fault: null, detail: '',
    };
    const INDEX: any = { root: '/work/proj', revision: 'sha', directories: ['app', 'api'],
      manifests: [], fileCount: 139, truncated: false };
    const withGraph = intelSection({ projectId: 'p', index: INDEX, graph: READY,
      graphAvailable: true, graphifyVersion: '0.9.49' });
    const withoutGraph = intelSection({ projectId: 'p', index: INDEX, graph: READY,
      graphAvailable: false, graphifyVersion: '0.9.49' });

    check('GF1: the shared text is delivered when the tools are actually attached',
      withGraph.includes(GRAPH_FIRST));
    // Telling an agent to prefer a tool it has not got is worse than silence:
    // it reads as "you failed to use the graph" on a call that never had one.
    check('GF2: and is NOT delivered when they are not',
      !withoutGraph.includes(GRAPH_FIRST) && /available: NO/.test(withoutGraph));

    // Every stage prompt, captured from the stage function itself.
    const prompts: Record<string, string> = {};
    const capture = (id: string, reply: unknown) => ({
      id, async available() { return { ok: true, detail: 'capturing fake' }; },
      async invoke(req: any) {
        prompts[id] = req.prompt;
        return { ok: true, role: req.role, structured: reply as any, text: '',
          raw: '{"type":"turn.completed"}', exitCode: 0, durationMs: 1,
          outcome: 'COMPLETED', infrastructureFailure: null };
      },
    });
    const gsup: any = { run: async () => ({ outcome: 'COMPLETED', stdout: '', exitCode: 0,
      durationMs: 1, productSignal: true, violations: [] }) };
    const gpolicy: any = { worktreeRoot: TMP, network: false, allowedCommands: [] };
    const GCTX = { commands: { unitTest: 'npm test' }, failingChecks: [], findings: [] };
    const gcriterion: any = {
      criterionId: 'p/M-0001/C-0001', type: 'EXECUTABLE', statement: 'the suite passes',
      evaluator: { kind: 'command', command: 'npm test', expect: 'PASSED' },
      affectedBy: [], required: true, requiresAuthority: [], derivedFrom: [],
    };
    const common = { missionId: 'p/M-0001', projectId: 'p', goal: 'add a language switcher',
      context: GCTX, supervisor: gsup, policy: gpolicy, baseSha: 'sha',
      intel: withGraph, repoGraph: {} as any };

    await compileOracle({ ...common, provider: capture('oracle', { criteria: [] }) } as any);
    await critiqueOracle({ ...common, criteria: [gcriterion],
      provider: capture('oracle-critic', { findings: [], modeOpinion: 'AUTO' }) } as any);
    await planMission({ ...common, criteria: [gcriterion],
      provider: capture('planner', { nodes: [] }) } as any);
    await critiquePlan({ ...common, criteria: [gcriterion],
      graph: { missionId: 'p/M-0001', version: 1, nodes: [] } as any,
      validation: { valid: true, findings: [], roots: [], nodeCount: 0 } as any,
      provider: capture('plan-critic', { findings: [] }) } as any);
    await decide({ message: 'will changing content.js affect the signed-in app?',
      context: withGraph, provider: capture('front-door', { intent: 'QUESTION',
        confidence: 0.9, summary: 's', answer: 'a' }) as any,
      supervisor: gsup, policy: gpolicy, projectId: 'p', tools: ['Read'] } as any);

    const STAGES = ['oracle', 'oracle-critic', 'planner', 'plan-critic', 'front-door'];
    const missing = STAGES.filter((s) => !(prompts[s] ?? '').includes(GRAPH_FIRST));
    check('GF3: every graph-holding stage sends the graph-first guidance',
      missing.length === 0 && STAGES.every((s) => !!prompts[s]),
      missing.length ? `missing in ${missing.join(', ')}` : `${STAGES.length} stages`);

    // ONE TEXT, not five paraphrases. Five copies drift, and then two agents
    // are working to different rules while the tests still pass.
    const identical = STAGES.every((s) =>
      (prompts[s].match(new RegExp(GRAPH_FIRST.split('\n')[0], 'g')) ?? []).length === 1);
    check('GF4: it is the SAME text everywhere, appearing once per prompt',
      identical);

    check('GF5: no stage still tells the agent it has no limit',
      STAGES.every((s) => !/no limit on how many|as many as you need/i.test(prompts[s])),
      STAGES.filter((s) => /no limit on how many|as many as you need/i.test(prompts[s])).join(', '));
    check('GF6: each stage is told when to STOP instead',
      STAGES.every((s) => /unlikely to change|cannot change your answer/i.test(prompts[s])));
  }

  section('graph-first: it is guidance, not a quota and not a gate');
  {
    // THE FAILURE MODE THIS TEXT COULD EASILY HAVE. "Always make at least one
    // graph call" is trivially satisfiable and measures nothing; the goal is a
    // cheaper investigation, not a higher graphQueryCount.
    check('GF7: the text never demands a call be made',
      !/always (call|use|query)|at least one (graph )?(call|query)|must (call|query)/i
        .test(GRAPH_FIRST), 'no mandatory-call language');
    check('GF8: and says outright that a pointless graph call is a waste',
      /DO NOT TRAVERSE THE GRAPH FOR ITS OWN SAKE/.test(GRAPH_FIRST)
      && /cannot change your answer is the/.test(GRAPH_FIRST));
    check('GF9: it names the broad-discovery commands it is displacing',
      ['rg --files', 'find .', 'recursive', 'repository-wide grep']
        .every((c) => GRAPH_FIRST.includes(c)));
    check('GF10: it names the escapes to source, including a stale graph',
      /already know the file/.test(GRAPH_FIRST)
      && /no navigation question/.test(GRAPH_FIRST)
      && /STALE/.test(GRAPH_FIRST));
    check('GF11: the mental model is stated as two lines, not implied',
      GRAPH_FIRST.includes('USE THE GRAPH TO FIND WHERE TO LOOK.')
      && GRAPH_FIRST.includes('USE THE SOURCE TO DECIDE WHAT IS TRUE.'));
    check('GF12: and source still wins a disagreement',
      /the source wins/.test(GRAPH_FIRST));

    // Nothing here may become a correctness gate. verifyGraphEvidence is the
    // only thing that turns graph use into a requirement, and it fires only on
    // a goal that DEMANDS the graph in its own words.
    check('GF13: ordinary goals are still not required to produce graph evidence',
      !goalRequiresGraphEvidence('add a language switcher to the landing page'),
      'guidance did not become a gate');
  }

  section('graph-first: the new text is safe to deliver to a critic');
  {
    const READY2: any = {
      projectId: 'p', indexedRevision: 'sha', currentRevision: 'sha',
      graphPath: 'g.json', present: true, stale: false, nodes: 900, edges: 2600,
      indexedAt: null, indexMs: null, fault: null, detail: '',
    };
    const sec = intelSection({ projectId: 'p',
      index: { root: '/work/proj', revision: 'sha', directories: [], manifests: [],
        fileCount: 1, truncated: false } as any,
      graph: READY2, graphAvailable: true, graphifyVersion: '0.9.49' });
    // MY OWN LAST ADDITION TO THIS SECTION BROKE THIS. A repository-intelligence
    // section that trips ORACLE_CRITIQUE_POLICY does not fail loudly - the
    // critique is refused, the critic never runs, and the contract is accepted
    // with no second opinion. Checked on the graph-AVAILABLE variant, which is
    // the one carrying the new words.
    const payload = buildReviewPayload({
      taskId: 'p/M-0001', projectId: 'p', baseSha: 'a', headSha: 'a',
      policy: ORACLE_CRITIQUE_POLICY, header: CRITIQUE_HEADER,
      inputs: [{ kind: 'repository-intelligence' as any,
        label: 'the repository this contract is about', content: sec }],
    });
    check('GF14: the graph-first text does not contaminate the critique payload',
      payload.valid, payload.violations.map((v) => v.detail).join(' | '));
  }
}

/* -- fixtures for the read-scope section ---------------------------------- */

function roots2() {
  return { projectRoot: '/work/talkbridge',
    zeusRoot: '/opt/zeus-engine', stateRoot: null };
}
function meta2() {
  return { stage: 'oracle-critic', traceCallId: 'TC-test', provider: 'codex' };
}
/** One codex `command_execution` line, which is how every shell call arrives. */
function cmd(command: string): string {
  return JSON.stringify({ type: 'item.completed',
    item: { id: `i${Math.abs(hashOf(command)) % 1000}`, type: 'command_execution', command } });
}
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;

}

/** A minimal valid criterion, so the critique has something to be about. */
function criterionForScope() {
  return {
    criterionId: 'p/M-0001/C-0001', type: 'EXECUTABLE' as const,
    statement: 'the unit suite passes',
    evaluator: { kind: 'command' as const, command: 'npm test', expect: 'PASSED' as const },
    affectedBy: [], required: true, requiresAuthority: [] as any[], derivedFrom: [],
  };
}
