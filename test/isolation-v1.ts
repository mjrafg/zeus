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
} from '../src/engine/writecheck';
import {
  MCP_CAPABLE, GRAPH_TOOL_NAMES, graphToolIds, toolsFor, claudeProvider, codexProvider,
} from '../src/engine/providers';
import { verifyGraphEvidence, goalRequiresGraphEvidence, intelSection, repoIndex }
  from '../src/graph/intel';

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
}
