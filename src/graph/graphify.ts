/**
 * Zeus's ownership of graphify: where it is, whether it works, and whether the
 * graph in front of an agent describes the code that agent is reasoning about.
 *
 * WHAT GRAPHIFY ACTUALLY IS, having read it rather than assumed it. A uv-
 * installed Python tool (distribution `graphifyy`, command `graphify`) that
 * writes `graphify-out/graph.json` under a directory you name. Indexing splits
 * in two, and the split is the whole reason this is affordable:
 *
 *   extract <path> --code-only   AST only. No API key, no LLM, no network.
 *   update <path>                incremental re-extract. Its own help says
 *                                "no LLM needed".
 *
 * The LLM-backed parts — `label`, `cluster-only`, plain `extract` without
 * --code-only — exist to name communities for humans reading a report. Zeus
 * never calls them. A repository index that costs a model call would be a
 * worse version of the problem it was meant to solve.
 *
 * MEASURED, not hoped: a six-file fixture indexed in 0.2s and produced 17
 * nodes and 18 edges including the imports_from edges that answer "what does
 * the landing page pull in".
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { Graph } from './query';

/** The distribution is graphifyy; the command it installs is graphify. */
export const GRAPHIFY_DIST = 'graphifyy';
export const GRAPHIFY_MIN = '0.9.0';

/**
 * Why a graph cannot be used, named rather than implied.
 *
 * Every one of these is a reason an agent would otherwise be handed silence
 * and left to reason from nothing while a prompt told it the repository was
 * understood. Naming them is what lets a stage refuse instead of pretend.
 */
export type GraphFault =
  | 'GRAPHIFY_UNAVAILABLE'
  | 'GRAPHIFY_VERSION_INCOMPATIBLE'
  | 'GRAPHIFY_INDEX_FAILED'
  | 'GRAPHIFY_GRAPH_STALE'
  | 'GRAPHIFY_QUERY_FAILED';

export interface Health {
  ok: boolean;
  bin: string | null;
  version: string | null;
  fault: GraphFault | null;
  detail: string;
}

function run(bin: string, args: string[], cwd?: string, timeout = 600_000):
{ ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, cwd,
    maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    out: r.stdout ?? '',
    err: r.stderr ?? (r.error ? String(r.error.message) : ''),
    code: r.status,
  };
}

export function whichGraphify(explicit?: string): string | null {
  const bin = explicit ?? process.env.ZEUS_GRAPHIFY_BIN ?? null;
  if (bin) return fs.existsSync(bin) ? bin : null;
  const r = spawnSync('sh', ['-c', 'command -v graphify'], { encoding: 'utf8', timeout: 5_000 });
  const found = (r.stdout ?? '').trim();
  if (found) return found;
  // uv installs tools outside the default PATH of a service unit often enough
  // that not looking there means reporting "not installed" about something
  // plainly installed — the same class of bug as the runner's missing npm.
  for (const c of [
    path.join(process.env.HOME ?? '', '.local', 'bin', 'graphify'),
    '/usr/local/bin/graphify',
  ]) if (fs.existsSync(c)) return c;
  return null;
}

/** Compares dotted versions without pulling in a dependency to do it. */
export function atLeast(have: string, want: string): boolean {
  const a = have.split('.').map((n) => parseInt(n, 10) || 0);
  const b = want.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * Whether graphify is really there, asked by running it.
 *
 * `command -v` finding a file proves a file exists. A broken venv, a partial
 * uv install and a shim pointing at a deleted interpreter all pass that test
 * and fail the first real call — reported to the operator as Ready right up
 * until a mission needed it.
 */
export function health(explicit?: string): Health {
  const bin = whichGraphify(explicit);
  if (!bin) {
    return { ok: false, bin: null, version: null, fault: 'GRAPHIFY_UNAVAILABLE',
      detail: 'graphify is not installed on this host' };
  }
  const r = run(bin, ['version'], undefined, 30_000);
  const version = (r.out.match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null;
  if (!r.ok || !version) {
    return { ok: false, bin, version: null, fault: 'GRAPHIFY_UNAVAILABLE',
      detail: `graphify at ${bin} did not answer \`version\`: ${(r.err || r.out).slice(0, 200)}` };
  }
  if (!atLeast(version, GRAPHIFY_MIN)) {
    return { ok: false, bin, version, fault: 'GRAPHIFY_VERSION_INCOMPATIBLE',
      detail: `graphify ${version} is older than the ${GRAPHIFY_MIN} Zeus requires` };
  }
  return { ok: true, bin, version, fault: null, detail: `graphify ${version} at ${bin}` };
}

/* -- where a project's graph lives ----------------------------------------- */

/**
 * One graph per project AND per revision, never one shared graph.
 *
 * The revision is in the path on purpose. A reviewer reasons about a task
 * worktree while the planner reasons about the mission base, and those are
 * different trees; a single graph.json per project would hand one of them a
 * map of the other's code and nothing anywhere would say so. Keying by
 * revision makes the wrong graph unreachable rather than merely discouraged.
 */
export function graphDirFor(stateRoot: string, projectId: string, revision: string): string {
  // Replacing separators is not enough on its own: a project id of exactly
  // "." or ".." survives a character class that permits dots, and joins to a
  // directory ABOVE the state root. Neutralise the segment, not just its
  // punctuation.
  const cleaned = projectId.replace(/[^A-Za-z0-9_.-]/g, '~');
  const safe = /^\.+$/.test(cleaned) ? `~${cleaned}` : cleaned;
  const revClean = /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 12)
    : revision.replace(/[^A-Za-z0-9_.-]/g, '~').slice(0, 24);
  const rev = /^\.+$/.test(revClean) ? `~${revClean}` : (revClean || '~empty');
  return path.join(stateRoot, 'graph', safe, rev);
}

export function graphJsonPath(dir: string): string {
  return path.join(dir, 'graphify-out', 'graph.json');
}

export interface GraphState {
  projectId: string;
  /** The revision this graph describes — NOT necessarily the project's HEAD. */
  indexedRevision: string | null;
  currentRevision: string | null;
  graphPath: string;
  present: boolean;
  stale: boolean;
  nodes: number;
  edges: number;
  indexedAt: string | null;
  indexMs: number | null;
  fault: GraphFault | null;
  detail: string;
}

const stampPath = (dir: string) => path.join(dir, 'zeus-index.json');

export function readState(stateRoot: string, projectId: string,
  revision: string, currentRevision: string | null): GraphState {
  const dir = graphDirFor(stateRoot, projectId, revision);
  const gp = graphJsonPath(dir);
  const base: GraphState = {
    projectId, indexedRevision: null, currentRevision, graphPath: gp,
    present: false, stale: true, nodes: 0, edges: 0, indexedAt: null,
    indexMs: null, fault: null, detail: 'no graph for this revision yet',
  };
  if (!fs.existsSync(gp)) return base;
  let stamp: any = {};
  try { stamp = JSON.parse(fs.readFileSync(stampPath(dir), 'utf8')); } catch { stamp = {}; }
  const indexed = typeof stamp.revision === 'string' ? stamp.revision : revision;
  // Staleness is asked of the revision the CALLER needs, not of HEAD. A task
  // worktree that is deliberately behind main is not a stale graph.
  const stale = indexed !== revision;
  return {
    ...base,
    present: true,
    indexedRevision: indexed,
    stale,
    nodes: Number(stamp.nodes ?? 0),
    edges: Number(stamp.edges ?? 0),
    indexedAt: typeof stamp.at === 'string' ? stamp.at : null,
    indexMs: typeof stamp.ms === 'number' ? stamp.ms : null,
    fault: stale ? 'GRAPHIFY_GRAPH_STALE' : null,
    detail: stale
      ? `graph describes ${indexed}, the caller needs ${revision}`
      : `graph is current for ${revision}`,
  };
}

/**
 * Builds or refreshes the graph for one snapshot of one project.
 *
 * `--code-only` and `--no-cluster` are not tuning. They are what keeps this
 * deterministic: clustering and labelling are the LLM-backed parts, and an
 * index that costs a model call to produce cannot honestly be described as
 * cheaper than asking the model directly.
 */
export function index(opts: {
  bin: string; sourceDir: string; stateRoot: string; projectId: string;
  revision: string; timeoutMs?: number; now?: () => string;
}): GraphState {
  const dir = graphDirFor(opts.stateRoot, opts.projectId, opts.revision);
  const gp = graphJsonPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  // --out writes <DIR>/graphify-out/, so the graph lands under Zeus state and
  // never inside the user's repository. A tool that litters the tree it is
  // indexing shows up in the diff of the very change it was helping with.
  const r = run(opts.bin, ['extract', opts.sourceDir, '--code-only', '--no-cluster',
    '--out', dir], opts.sourceDir, opts.timeoutMs ?? 600_000);
  const ms = Date.now() - started;
  if (!r.ok || !fs.existsSync(gp)) {
    return {
      projectId: opts.projectId, indexedRevision: null, currentRevision: opts.revision,
      graphPath: gp, present: false, stale: true, nodes: 0, edges: 0,
      indexedAt: null, indexMs: ms, fault: 'GRAPHIFY_INDEX_FAILED',
      detail: `graphify extract failed (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`,
    };
  }
  let g: Graph = { nodes: [], edges: [] };
  try { g = JSON.parse(fs.readFileSync(gp, 'utf8')); } catch { /* counted as empty */ }
  const at = opts.now ? opts.now() : new Date().toISOString();
  fs.writeFileSync(stampPath(dir), `${JSON.stringify({
    revision: opts.revision, nodes: g.nodes?.length ?? 0, edges: g.edges?.length ?? 0,
    at, ms, source: opts.sourceDir,
  })}\n`);
  return {
    projectId: opts.projectId, indexedRevision: opts.revision,
    currentRevision: opts.revision, graphPath: gp, present: true, stale: false,
    nodes: g.nodes?.length ?? 0, edges: g.edges?.length ?? 0, indexedAt: at,
    indexMs: ms, fault: null, detail: `indexed ${g.nodes?.length ?? 0} node(s) in ${ms}ms`,
  };
}

export function loadGraph(graphPath: string): Graph | null {
  try {
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    if (!Array.isArray(g?.nodes) || !Array.isArray(g?.edges)) return null;
    return g as Graph;
  } catch { return null; }
}

/**
 * The graph an agent may use for a given snapshot, or the reason there is none.
 *
 * Indexes on demand and re-indexes a stale one. Fails CLOSED: the caller gets
 * a fault, never an empty graph dressed as an answer, because "0 results"
 * reads to a model as "nothing depends on this" rather than "ask again".
 */
export function ensure(opts: {
  bin: string | null; sourceDir: string; stateRoot: string; projectId: string;
  revision: string; now?: () => string;
}): { state: GraphState; graph: Graph | null } {
  if (!opts.bin) {
    return { state: { projectId: opts.projectId, indexedRevision: null,
      currentRevision: opts.revision, graphPath: '', present: false, stale: true,
      nodes: 0, edges: 0, indexedAt: null, indexMs: null,
      fault: 'GRAPHIFY_UNAVAILABLE', detail: 'graphify is not installed on this host' },
    graph: null };
  }
  let state = readState(opts.stateRoot, opts.projectId, opts.revision, opts.revision);
  if (!state.present || state.stale) {
    state = index({ bin: opts.bin, sourceDir: opts.sourceDir, stateRoot: opts.stateRoot,
      projectId: opts.projectId, revision: opts.revision, now: opts.now });
  }
  if (state.fault) return { state, graph: null };
  const graph = loadGraph(state.graphPath);
  if (!graph) {
    return { state: { ...state, fault: 'GRAPHIFY_INDEX_FAILED', present: false,
      detail: `graph.json at ${state.graphPath} is missing or unreadable` }, graph: null };
  }
  return { state, graph };
}
