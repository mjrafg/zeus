/**
 * Repository intelligence: the graph, the tools over it, and the rule that a
 * stale or missing graph must never be dressed up as knowledge.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import * as q from '../src/graph/query';
import type { Graph } from '../src/graph/query';
import { atLeast, graphDirFor, readState, loadGraph, GRAPHIFY_DIST } from '../src/graph/graphify';
import { TOOLS, callTool, PROTOCOL } from '../src/graph/mcp';
import { repoIndex, intelSection, readGraphOps, renderEvidence } from '../src/graph/intel';
import { bootstrapArgv, probe } from '../src/graph/access';
import { toolsFor, graphToolIds, MCP_CAPABLE } from '../src/engine/providers';
import { assemble } from '../src/mission/context';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-graph-'));

/** The fixture from the requirement: a frontend in app/, a backend in api/. */
const FIXTURE: Graph = {
  nodes: [
    { id: 'app_src_landing', label: 'landing.jsx', source_file: 'app/src/landing.jsx', source_location: 'L1' },
    { id: 'app_src_landing_landing', label: 'Landing()', source_file: 'app/src/landing.jsx', source_location: 'L3' },
    { id: 'app_src_shell', label: 'shell.jsx', source_file: 'app/src/shell.jsx', source_location: 'L1' },
    { id: 'app_src_content', label: 'content.js', source_file: 'app/src/content.js', source_location: 'L1' },
    { id: 'app_pkg', label: 'app/package.json', source_file: 'app/package.json', source_location: 'L1' },
    { id: 'app_pkg_build', label: 'build', source_file: 'app/package.json', source_location: 'L1' },
    { id: 'api_src_server', label: 'server.js', source_file: 'api/src/server.js', source_location: 'L1' },
    { id: 'api_pkg_test', label: 'test', source_file: 'api/package.json', source_location: 'L1' },
  ],
  edges: [
    { source: 'app_src_landing', target: 'app_src_shell', relation: 'imports_from',
      confidence: 'EXTRACTED', source_file: 'app/src/landing.jsx', source_location: 'L1' },
    { source: 'app_src_landing', target: 'app_src_content', relation: 'imports_from',
      confidence: 'EXTRACTED', source_file: 'app/src/landing.jsx', source_location: 'L2' },
    { source: 'app_src_landing', target: 'app_src_landing_landing', relation: 'contains',
      confidence: 'EXTRACTED', source_file: 'app/src/landing.jsx', source_location: 'L3' },
    { source: 'app_pkg', target: 'app_pkg_build', relation: 'contains', confidence: 'EXTRACTED',
      source_file: 'app/package.json', source_location: 'L1' },
  ],
};

export async function graphSuite(): Promise<void> {
  section('graph queries: the six questions, answered from the artifact');
  {
    check('GQ1: a concept finds the file, not just an exact id',
      q.search(FIXTURE, 'landing page').some((h) => h.file === 'app/src/landing.jsx'),
      JSON.stringify(q.search(FIXTURE, 'landing page').slice(0, 2)));
    check('GQ2: dependencies walk FORWARD — the question graphify cannot answer',
      q.dependencies(FIXTURE, 'landing.jsx').map((h) => h.label).sort().join(',')
        === 'content.js,shell.jsx',
      JSON.stringify(q.dependencies(FIXTURE, 'landing.jsx')));
    check('GQ3: dependents walk BACK',
      q.dependents(FIXTURE, 'shell.jsx').map((h) => h.label).join(',') === 'landing.jsx',
      JSON.stringify(q.dependents(FIXTURE, 'shell.jsx')));
    // `contains` is structure, not dependency. A file does not depend on its
    // own functions, and letting it through makes every file look like it has
    // as many dependencies as it has symbols.
    check('GQ4: containment is NOT a dependency',
      !q.dependencies(FIXTURE, 'landing.jsx').some((h) => h.label === 'Landing()'),
      'contains is excluded from reach');
    check('GQ5: but containment IS a neighbour',
      q.neighbors(FIXTURE, 'landing.jsx').some((h) => h.label === 'Landing()'),
      'neighbours include structure');
    check('GQ6: references carry file AND line, so the agent knows what to Read',
      q.references(FIXTURE, 'shell.jsx')[0]?.location === 'L1'
      && q.references(FIXTURE, 'shell.jsx')[0]?.file === 'app/src/landing.jsx',
      JSON.stringify(q.references(FIXTURE, 'shell.jsx')));
    check('GQ7: a path is a chain of named relations, not a bare node list',
      q.path(FIXTURE, 'landing.jsx', 'shell.jsx')?.[0]?.relation === 'imports_from',
      JSON.stringify(q.path(FIXTURE, 'landing.jsx', 'shell.jsx')));
    check('GQ8: an unconnected pair is null, not an empty path',
      q.path(FIXTURE, 'landing.jsx', 'nothing-like-this-exists') === null, 'null for no route');
    check('GQ9: confidence survives, so INFERRED can be weighed against EXTRACTED',
      q.dependencies(FIXTURE, 'landing.jsx').every((h) => h.confidence === 'EXTRACTED'),
      'confidence carried');
  }

  section('graph tools: an empty answer must not read as a finding');
  {
    check('GT1: every tool the prompt advertises actually exists',
      ['graph_search', 'graph_dependencies', 'graph_dependents', 'graph_neighbors',
        'graph_references', 'graph_path'].every((n) => TOOLS.some((t) => t.name === n)),
      TOOLS.map((t) => t.name).join(','));
    check('GT2: each declares a schema, or the CLI cannot offer it',
      TOOLS.every((t) => !!(t.inputSchema as any).properties), 'schemas present');

    // "[]" reads to a model as "nothing depends on this" — a finding. "No node
    // matched" is an instruction to look differently. The difference decides
    // whether the agent keeps investigating or reports a false conclusion.
    const miss = callTool(FIXTURE, 'graph_search', { term: 'zzz-not-here' });
    check('GT3: a miss SAYS it is a miss rather than returning an empty list',
      miss.results === 0 && /not that\s+nothing exists/.test(miss.text)
      && /Grep\/Glob/.test(miss.text), miss.text.slice(0, 120));
    check('GT4: and it points at the source, which is the source of truth',
      /source of truth/.test(miss.text), 'source named');
    const hit = callTool(FIXTURE, 'graph_search', { term: 'landing' });
    check('GT5: a hit returns JSON an agent can parse, not prose',
      hit.results > 0 && Array.isArray(JSON.parse(hit.text)), 'parseable');
    const nopath = callTool(FIXTURE, 'graph_path', { from: 'landing.jsx', to: 'server.js' });
    check('GT6: an absent path explains itself too',
      /No path found/.test(nopath.text) && /graph_search first/.test(nopath.text),
      nopath.text.slice(0, 80));
    check('GT7: an unknown tool is refused, not silently empty',
      callTool(FIXTURE, 'graph_invented', {}).ok === false, 'refused');
    check('GT8: the protocol version is pinned, not improvised',
      /^\d{4}-\d{2}-\d{2}$/.test(PROTOCOL), PROTOCOL);
  }

  section('graph permissions: read-only stays read-only');
  {
    // Adding a tool must not widen what a critic can do. This is safe by
    // construction — the MCP server opens graph.json and a log and has no
    // path that writes — but the flag has to agree with the construction.
    const ro = toolsFor(true, { command: 'node', args: [], logPath: null });
    const rw = toolsFor(false, { command: 'node', args: [], logPath: null });
    check('GP1: a read-only role gains graph tools',
      graphToolIds().every((t) => ro.includes(t)), ro.join(' '));
    check('GP2: and gains NO write tools with them',
      !ro.includes('Edit') && !ro.includes('Write'), ro.join(' '));
    check('GP3: a writing role keeps its write tools',
      rw.includes('Edit') && rw.includes('Write'), rw.join(' '));
    check('GP4: with no graph, no graph tools are offered at all',
      toolsFor(true, null).every((t) => !t.startsWith('mcp__')),
      toolsFor(true, null).join(' '));
  }

  section('graph isolation: one graph per project AND per revision');
  {
    const root = path.join(TMP, 'state');
    const a1 = graphDirFor(root, 'alpha', 'aaaaaaaaaaaa');
    const b1 = graphDirFor(root, 'beta', 'aaaaaaaaaaaa');
    const a2 = graphDirFor(root, 'alpha', 'bbbbbbbbbbbb');
    check('GI1: two projects at the same revision do not share a graph',
      a1 !== b1, `${a1} vs ${b1}`);
    check('GI2: one project at two revisions does not share a graph either',
      a1 !== a2, `${a1} vs ${a2}`);
    // A reviewer reads a task worktree while a planner reads the mission base.
    // A single graph per project would hand one of them a map of the other's
    // code with nothing in the answer revealing which.
    check('GI3: the revision is IN the path, so the wrong graph is unreachable',
      a1.includes('aaaaaaaaaaaa') && a2.includes('bbbbbbbbbbbb'), a1);
    // The property is containment, not the absence of dots: "..~..~etc" is a
    // single harmless directory NAME. What actually escapes is a segment that
    // IS "..", and a character class permitting dots passes it through whole.
    const under = (id: string, rev: string) => {
      const resolved = path.resolve(graphDirFor(root, id, rev));
      return resolved.startsWith(path.resolve(root) + path.sep);
    };
    check('GI4: a project id with separators cannot leave the state root',
      under('../../etc', 'aaaaaaaaaaaa'), graphDirFor(root, '../../etc', 'aaaaaaaaaaaa'));
    check('GI5: nor can one that is nothing but dots',
      under('..', 'aaaaaaaaaaaa') && under('.', 'aaaaaaaaaaaa'),
      graphDirFor(root, '..', 'aaaaaaaaaaaa'));
    check('GI6: nor can a revision that is nothing but dots',
      under('p', '..') && under('p', '.'), graphDirFor(root, 'p', '..'));
  }

  section('graph staleness: the caller names the revision it needs');
  {
    const root = path.join(TMP, 'stale');
    const rev = 'cccccccccccc';
    const dir = graphDirFor(root, 'p', rev);
    fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify(FIXTURE));

    fs.writeFileSync(path.join(dir, 'zeus-index.json'),
      JSON.stringify({ revision: rev, nodes: 8, edges: 4, at: '2026-01-01T00:00:00Z', ms: 12 }));
    const fresh = readState(root, 'p', rev, rev);
    check('GS1: a graph built for this revision is current',
      fresh.present && !fresh.stale && fresh.fault === null, JSON.stringify(fresh));

    fs.writeFileSync(path.join(dir, 'zeus-index.json'),
      JSON.stringify({ revision: 'dddddddddddd', nodes: 8, edges: 4, at: '2026-01-01T00:00:00Z', ms: 12 }));
    const stale = readState(root, 'p', rev, rev);
    check('GS2: a graph built for another revision is STALE and says which',
      stale.stale && stale.fault === 'GRAPHIFY_GRAPH_STALE'
      && stale.detail.includes('dddddddddddd'), JSON.stringify(stale));
    check('GS3: an absent graph is absent, not empty',
      !readState(root, 'p', 'eeeeeeeeeeee', 'eeeeeeeeeeee').present, 'no graph yet');
    check('GS4: a corrupt graph.json loads as null rather than as an empty graph',
      loadGraph(path.join(TMP, 'nope.json')) === null, 'null not {nodes:[],edges:[]}');
  }

  section('repository index: orientation that costs no model call');
  {
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(path.join(repo, 'app', 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'api', 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'package.json'),
      JSON.stringify({ name: 'app', scripts: { build: 'vite build' } }));
    fs.writeFileSync(path.join(repo, 'api', 'package.json'),
      JSON.stringify({ name: 'api', scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(repo, 'app', 'src', 'landing.jsx'), 'export const L = 1;\n');
    fs.writeFileSync(path.join(repo, 'node_modules', 'junk', 'index.js'), 'module.exports=1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '-qm', 'init']);

    const ix = repoIndex(repo, 'abc123');
    check('RIX1: both top-level packages are found',
      ix.directories.includes('app') && ix.directories.includes('api'),
      ix.directories.join(','));
    // node_modules is not the repository. A tree that drowns app/src in
    // dependency paths orients nobody.
    check('RIX2: untracked dependency trees are not the repository',
      !ix.directories.includes('node_modules'), ix.directories.join(','));
    check('RIX3: the manifests carry their SCRIPTS — which is where build commands live',
      ix.manifests.find((m) => m.file === 'app/package.json')?.scripts?.build === 'vite build',
      JSON.stringify(ix.manifests));
    check('RIX4: and the api scripts are told apart from the app ones',
      ix.manifests.find((m) => m.file === 'api/package.json')?.scripts?.test === 'jest',
      JSON.stringify(ix.manifests));
  }

  section('the prompt may not claim intelligence it does not have');
  {
    const ix = repoIndex(TMP, 'abc123');
    const ready = intelSection({ projectId: 'p', index: ix, graphAvailable: true,
      graphifyVersion: '0.9.49',
      graph: { projectId: 'p', indexedRevision: 'abc123', currentRevision: 'abc123',
        graphPath: '/g', present: true, stale: false, nodes: 9, edges: 4,
        indexedAt: null, indexMs: 5, fault: null, detail: 'ok' } });
    check('IS1: a ready graph is announced with its revision and size',
      /Graphify: AVAILABLE/.test(ready) && /Graph status: READY/.test(ready)
      && /Indexed revision: abc123/.test(ready), 'announced');
    check('IS2: the source-of-truth rule is stated, not implied',
      /SOURCE OF\s*\n?TRUTH/.test(ready) && /trust the source/.test(ready),
      'rule present');
    check('IS3: repeated exploration is explicitly permitted',
      /repeatedly/.test(ready) && /no limit/i.test(ready), 'no arbitrary cap implied');
    check('IS4: and bounded by budget rather than by a turn count',
      /cost and time budget/.test(ready) && !/maximum \d+ (queries|calls)/i.test(ready),
      'budget-bounded');

    const blind = intelSection({ projectId: 'p', index: ix, graphAvailable: false,
      graphifyVersion: null,
      graph: { projectId: 'p', indexedRevision: null, currentRevision: 'abc123',
        graphPath: '', present: false, stale: true, nodes: 0, edges: 0,
        indexedAt: null, indexMs: null, fault: 'GRAPHIFY_INDEX_FAILED',
        detail: 'extract exited 1' } });
    // A prompt announcing repository intelligence over a graph that is not
    // attached teaches the model to trust a tool that answers emptily.
    check('IS5: with no graph the prompt says UNAVAILABLE',
      /Graphify: UNAVAILABLE/.test(blind) && !/Graphify: AVAILABLE/.test(blind), 'honest');
    check('IS6: it names the fault rather than going quiet',
      /GRAPHIFY_INDEX_FAILED/.test(blind), 'fault named');
    check('IS7: and it does NOT advertise tools the call does not hold',
      !/graph_search /.test(blind), 'no phantom tools');
    check('IS8: it tells the agent to say what it could not verify',
      /could not verify/.test(blind), 'admission required');
  }

  section('evidence is derived from what ran, not from what was claimed');
  {
    const log = path.join(TMP, 'ev.jsonl');
    fs.writeFileSync(log, [
      JSON.stringify({ at: '2026-01-01T00:00:00Z', tool: 'graph_search',
        args: { term: 'landing page' }, ok: true, results: 3, ms: 8 }),
      JSON.stringify({ at: '2026-01-01T00:00:01Z', tool: 'graph_dependencies',
        args: { term: 'landing.jsx' }, ok: true, results: 2, ms: 4 }),
      '{ this line is torn',
    ].join('\n') + '\n');
    const ops = readGraphOps(log);
    check('EV1: the manifest comes from the server’s log',
      ops.length === 2 && ops[0].tool === 'graph_search', JSON.stringify(ops));
    check('EV2: a torn line is skipped rather than believed',
      ops.every((o) => !!o.tool), 'no partial record survives');
    check('EV3: no log means no evidence — never assumed evidence',
      readGraphOps(path.join(TMP, 'absent.jsonl')).length === 0
      && readGraphOps(null).length === 0, 'absence is not evidence');
    const rendered = renderEvidence({ graphQueries: ops, filesRead: ['app/src/landing.jsx'],
      grepQueries: ['i18n'], revision: 'abc123', graphAttached: true }).join('\n');
    check('EV4: the rendered manifest shows the query, its size and its cost',
      /graph_search "landing page" — 3 result\(s\), 8ms/.test(rendered), rendered);
    check('EV5: and the revision it all applies to',
      /Repository revision: abc123/.test(rendered), rendered);
  }

  section('the behaviour that motivated all of this');
  {
    // talkbridge/M-0016 compiled a contract for "add multi language feature to
    // landing page" and attached an api/ typecheck to a frontend change,
    // because the api command was the only verification it had been handed.
    // The graph makes the frontend discoverable BEFORE the contract is written.
    const found = q.search(FIXTURE, 'landing page');
    check('M16-1: the goal’s subject resolves to the frontend package',
      found[0]?.file?.startsWith('app/'), JSON.stringify(found[0]));
    check('M16-2: and NOT to the backend that happened to own the known command',
      !found.some((h) => h.file?.startsWith('api/')), JSON.stringify(found));

    const deps = q.dependencies(FIXTURE, 'landing.jsx');
    check('M16-3: its real dependencies are reachable in one hop',
      deps.some((d) => d.label === 'shell.jsx') && deps.some((d) => d.label === 'content.js'),
      JSON.stringify(deps));

    const repo = path.join(TMP, 'repo');
    const ix = repoIndex(repo, 'abc123');
    const appBuild = ix.manifests.find((m) => m.file === 'app/package.json')?.scripts?.build;
    const apiTest = ix.manifests.find((m) => m.file === 'api/package.json')?.scripts?.test;
    check('M16-4: the frontend’s OWN verification command is discoverable',
      appBuild === 'vite build', String(appBuild));
    check('M16-5: told apart from the backend’s, which is the mistake M-0016 made',
      apiTest === 'jest' && appBuild !== apiTest, `${appBuild} vs ${apiTest}`);

    // The package-script VALUE is not in the graph — graphify records the key
    // as a node and stops there. So "which command verifies the frontend" is
    // answerable only by reading the manifest, which is exactly why the graph
    // is navigation and the source is truth.
    check('M16-6: the graph names the script but not its command — source is truth',
      FIXTURE.nodes.some((n) => n.label === 'build')
      && !FIXTURE.nodes.some((n) => n.label === 'vite build'),
      'the graph points; the file answers');
  }

  section('the wiring: every repo-aware stage goes through one door');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'operations.ts'), 'utf8');
    const comp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'compile.ts'), 'utf8');
    const acc = fs.readFileSync(path.join(__dirname, '..', 'src', 'graph', 'access.ts'), 'utf8');

    // Wiring seven stages in seven places means forgetting one, and the one
    // forgotten is a stage quietly reasoning about a repository it cannot see.
    check('GW1: the graph is attached inside route(), the one door every stage uses',
      /const r = engine\.routeFor\(stage\);[\s\S]{0,900}?attach\(\{/.test(src),
      'attached at the chokepoint');
    check('GW2: and only for stages that reason about the repository',
      /REPO_AWARE\.has\(stage\)/.test(src), 'gated on REPO_AWARE');
    check('GW3: all seven pipeline stages are repository-aware',
      ['oracle', 'oracle-critic', 'planner', 'plan-critic', 'implementer',
        'reviewer', 'repair'].every((st) => acc.includes(`'${st}'`)),
      'every stage listed');

    check('GW4: the Oracle is handed the tools, not just told about them',
      /graph: input\.repoGraph \?\? null,/.test(comp), 'provider request carries it');
    check('GW5: orientation is delivered BEFORE the goal',
      comp.indexOf("kind: 'repository-intelligence'")
        < comp.indexOf("kind: 'mission-goal'"), 'intel precedes the goal');
    // A critic that could only see what the compiler chose to inspect reviews
    // the compiler's reading rather than the repository.
    check('GW6: the critic gets its OWN access, not the compiler’s leftovers',
      (comp.match(/graph: input\.repoGraph \?\? null,/g) ?? []).length === 2,
      'both compiler and critic');
    check('GW7: and the same deterministic index, so a disagreement is about the repo',
      /label: 'the repository this contract is about'/.test(comp), 'critic oriented too');
    check('GW8: the trace records whether the call HELD tools at all',
      (comp.match(/graphAttached: !!input\.repoGraph,/g) ?? []).length === 2,
      'asked-nothing is distinguishable from had-nothing-to-ask-with');
    check('GW9: and the ops come from the server log, never from the reply',
      /readGraphOps\(input\.graphLogPath!\)/.test(comp)
      && !/graphOps: res\./.test(comp), 'derived, not claimed');

    // ts-node puts ts-node in argv[1]; spawning that as an MCP server starts a
    // second REPL instead of a tool.
    check('GW10: the MCP server is spawned from Zeus’s entry point, not from argv',
      /ZEUS_CLI_PATH = require\('path'\)\.resolve\(__dirname/.test(src),
      'resolved from the module');
  }

  section('a declared tool that never answers is worse than no tool');
  {
    // Found live. node cannot parse a .ts file, so `node src/cli.ts graph-mcp`
    // exited instantly with a SyntaxError; the provider had a tool that never
    // answered, the trace recorded graphAttached: true, and an Oracle spent a
    // full call believing it had repository intelligence it did not have —
    // exactly the failure this feature exists to prevent.
    const tsEntry = path.join(TMP, 'cli.ts');
    const jsEntry = path.join(TMP, 'cli.js');
    check('BP1: under ts-node the loader is reused, not replaced by bare node',
      bootstrapArgv(tsEntry).args.some((a) => /ts-node/.test(a)),
      JSON.stringify(bootstrapArgv(tsEntry)));
    check('BP2: compiled JS needs no loader',
      bootstrapArgv(jsEntry).args.join(' ') === jsEntry,
      JSON.stringify(bootstrapArgv(jsEntry)));
    check('BP3: and the interpreter is this process’s own',
      bootstrapArgv(jsEntry).command === process.execPath, 'same node');

    // The claim has to be EARNED by a real handshake, not assumed from a file
    // existing on disk.
    const dead = probe(process.execPath, ['-e', 'process.exit(1)'], 8_000);
    check('BP4: a server that dies is reported as failed, not as attached',
      !dead.ok && /did not answer tools\/list/.test(dead.detail), dead.detail);
    const mute = probe(process.execPath, ['-e', 'setTimeout(()=>{},50)'], 4_000);
    check('BP5: a server that answers nothing is failed too',
      !mute.ok, mute.detail);
    check('BP6: and the detail names what went wrong rather than going quiet',
      dead.detail.length > 20, dead.detail);
  }

  section('a provider that cannot use a tool is not told it has one');
  {
    // MEASURED against codex 0.147.0: it discovers the tools, begins the call,
    // then fails it with "user cancelled MCP tool call". The documented ways
    // past that gate — --approve-for-me (workspace-write sandbox) and
    // --dangerously-bypass-approvals-and-sandbox (no sandbox) — both hand a
    // READ-ONLY critic the ability to write.
    check('MCP1: claude is known to use MCP tools non-interactively',
      MCP_CAPABLE.has('claude'), [...MCP_CAPABLE].join(','));
    check('MCP2: codex is not, so it is not offered them',
      !MCP_CAPABLE.has('codex'), [...MCP_CAPABLE].join(','));

    const blind = intelSection({ projectId: 'p', index: repoIndex(path.join(TMP, 'repo'), 'abc123'),
      graph: null, graphAvailable: false, graphifyVersion: '0.9.49',
      unavailableBecause: 'the codex CLI cancels MCP tool calls in non-interactive runs' });
    check('MCP3: the prompt says WHY, not just that it is unavailable',
      /cancels MCP tool calls/.test(blind), 'reason stated');
    check('MCP4: and offers no tool it cannot honour',
      !/graph_search {2,}find/.test(blind), 'no phantom tools');
    // The deterministic index is the larger half of the fix and costs nothing,
    // so it is delivered either way.
    check('MCP5: but the deterministic repository index is still delivered',
      /Tracked files:/.test(blind) && /Top-level directories|Package manifests/.test(blind),
      'orientation survives');
    check('MCP6: including the source-of-truth instruction',
      /could not verify/.test(blind), 'still told to verify');
  }

  section('the order of an instruction is part of the instruction');
  {
    const comp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'compile.ts'), 'utf8');
    // The first Oracle to hold graph tools made ZERO queries. The tools were
    // attached, the intelligence section was delivered, and "Reply with ONLY a
    // JSON object" — the second line of the header — had already told it to
    // answer immediately. A permission buried a page later does not survive a
    // constraint stated at the top.
    check('OH1: with tools attached, investigation is demanded FIRST',
      /INVESTIGATE THE REPOSITORY FIRST, THEN ANSWER\./.test(comp), 'directive present');
    // Source order is not prompt order: COMPILE_HEADER is declared near the top
    // of the file and composed near the bottom. Assemble a real prompt and read
    // the thing the model actually receives.
    const composed = assemble([
      'INVESTIGATE THE REPOSITORY FIRST, THEN ANSWER.', '',
      'The "reply with ONLY a JSON object" rule below governs your FINAL MESSAGE.',
      '', 'Compile this mission goal into a CONTRACT: Reply with ONLY a JSON object:',
    ].join('\n'), [{ kind: 'mission-goal', label: 'mission goal', content: 'g' }]);
    check('OH2: and it precedes the only-JSON rule in the assembled prompt',
      composed.prompt.indexOf('INVESTIGATE THE REPOSITORY FIRST')
        < composed.prompt.indexOf('Reply with ONLY a JSON object'),
      'ordered in what the model receives');
    // The constraint is about the final message, not about whether to explore,
    // and that has to be said in the same breath as the constraint.
    check('OH3: the only-JSON rule is scoped to the FINAL MESSAGE',
      /governs your FINAL MESSAGE/.test(comp)
      && /Tool calls are not your final message/.test(comp), 'scoped');
    check('OH4: it names the failure it exists to prevent',
      /attach the wrong verification/.test(comp), 'the reason is stated');
    // Without tools the directive would be a lie.
    check('OH5: with no tools attached, the header is unchanged',
      /: COMPILE_HEADER;/.test(comp), 'conditional on repoGraph');
  }

  section('installation: Zeus owns graphify, and proves it works');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'graph', 'install.ts'), 'utf8');
    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

    // The distribution is graphifyy; the command is graphify. That asymmetry is
    // the likeliest way an install silently does nothing.
    check('GIN1: the distribution name is used for install, not the command name',
      /install'.*GRAPHIFY_DIST|GRAPHIFY_DIST\)/.test(src) && GRAPHIFY_DIST === 'graphifyy',
      GRAPHIFY_DIST);
    check('GIN2: a compatible existing install is REUSED, not reinstalled over',
      /action: 'already-present'/.test(src)
      && src.indexOf("action: 'already-present'") < src.indexOf('venv'),
      'reuse comes first');
    // Debian's python3 refuses pip install into the system environment, and
    // --break-system-packages is exactly what its name says.
    // The flag is NAMED in a comment explaining why it is not used, so the
    // check has to look at the command being run rather than at the file.
    const pipArgs = (src.match(/run\(pip, \[[^\]]*\]/) ?? [''])[0];
    check('GIN3: it installs into a venv Zeus owns, not the system python',
      /'-m', 'venv'/.test(src) && !/break-system-packages/.test(pipArgs),
      pipArgs);
    check('GIN4: and not into the project — graphify is Zeus infrastructure',
      !/package\.json/.test(src), 'nothing added to the project');
    // A file existing where a file was expected is not health.
    check('GIN5: health is proven by RUNNING it after installing',
      /const after = health\(installed\)/.test(src)
      && /installed, but it does not work/.test(src), 'ran, not assumed');
    check('GIN6: a too-old version installed is still a failure',
      /older than \$\{GRAPHIFY_MIN\}/.test(src), 'version verified after install');
    check('GIN7: failure is never reported as Ready',
      /action: 'failed'/.test(src) && !/ok: true[\s\S]{0,60}action: 'failed'/.test(src),
      'no false Ready');

    check('GIN8: setup can install it',
      /--graphify/.test(cli) && /ensureGraphify\(/.test(cli), 'zeus setup --graphify');
    check('GIN9: doctor reports it beside the providers, not in a footnote',
      /Repository intelligence/.test(cli) && /graphHealth\(\)/.test(cli), 'in doctor');
    check('GIN10: and reports the project graph’s revision and staleness',
      /STALE — repository is at/.test(cli), 'staleness surfaced');
  }

  section('the trace shows the exploration, not a claim about it');
  {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'ui.ts'), 'utf8');
    const vw = fs.readFileSync(path.join(__dirname, '..', 'src', 'views.ts'), 'utf8');
    const pl = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'planner.ts'), 'utf8');

    check('GTR1: graph ops are correlated onto the model call they belong to',
      /call\.graphOps = Array\.isArray\(p\.graphOps\)/.test(vw), 'carried onto the call');
    check('GTR2: the console renders the queries with results and timing',
      /Repository exploration/.test(ui) && /result\(s\)/.test(ui) && /op\.ms/.test(ui),
      'rendered');
    // Two different facts. A call with tools and no queries chose not to ask —
    // which was a real bug once, and invisible if the view conflates it with
    // having had nothing to ask with.
    check('GTR3: "held tools and asked nothing" is shown as its own state',
      /Repository tools were attached; this call made/.test(ui), 'told apart');
    check('GTR4: truncation and failure are shown rather than smoothed over',
      /truncated/.test(ui) && /FAILED/.test(ui), 'both surfaced');

    // The planner needed the same ordering fix as the compiler, for the same
    // reason: a plan written without looking guesses which files a change
    // touches, and every node inherits the guess.
    check('GTR5: the planner investigates before planning',
      /INVESTIGATE THE REPOSITORY FIRST, THEN PLAN\./.test(pl), 'planner directive');
    check('GTR6: the planner and its critic both hold their own access',
      (pl.match(/graph: input\.repoGraph \?\? null,/g) ?? []).length === 2,
      'planner and plan-critic');
    check('GTR7: and both record whether they held tools',
      (pl.match(/graphAttached: !!input\.repoGraph,/g) ?? []).length === 2, 'both traced');
  }

  section('version compatibility is compared, not string-matched');
  {
    check('GV1: a newer patch satisfies a minimum', atLeast('0.9.49', '0.9.0'));
    check('GV2: an older minor does not', !atLeast('0.8.99', '0.9.0'));
    check('GV3: equal satisfies', atLeast('0.9.0', '0.9.0'));
    check('GV4: a longer version is compared numerically, not lexically',
      atLeast('0.10.0', '0.9.0'), '0.10.0 > 0.9.0');
  }
}
