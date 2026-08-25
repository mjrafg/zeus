/**
 * Turning "this stage wants the repository" into a graph the agent can call,
 * or into a stated reason there is none.
 *
 * THE SNAPSHOT RULE, which is the whole point of this file. A reviewer reasons
 * about a task worktree; a planner reasons about the mission base. Those are
 * different trees. Handing either of them a graph built from the other is not
 * a stale cache — it is a map of code the agent is not looking at, and nothing
 * in its answer would reveal which one it had. So the graph is keyed by the
 * revision AND built from the directory the agent is actually working in, and
 * a mismatch produces a fault rather than a best effort.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ensure, health, type GraphState, type GraphFault } from './graphify';
import { repoIndex, intelSection, type RepoIndex } from './intel';
import type { GraphAccess } from '../engine/providers';

/** Stages that reason about the repository. All of them, in practice. */
export const REPO_AWARE = new Set([
  'oracle', 'oracle-critic', 'planner', 'plan-critic',
  'implementer', 'reviewer', 'repair',
]);

export interface Attached {
  access: GraphAccess | null;
  state: GraphState | null;
  index: RepoIndex;
  section: string;
  fault: GraphFault | null;
  graphifyVersion: string | null;
  logPath: string | null;
}

/**
 * The argv that re-runs Zeus's own CLI, reconstructed from how it was started.
 *
 * `process.execPath` plus the script path is wrong under ts-node, which is how
 * Zeus runs in production: node cannot parse a .ts file, so the MCP server
 * exited instantly with a SyntaxError. Nothing surfaced. The provider simply
 * had a tool that never answered, the trace recorded graphAttached: true, and
 * an Oracle spent a full call believing it had repository intelligence it did
 * not have — precisely the failure this whole feature exists to prevent.
 */
export function bootstrapArgv(cliPath: string): { command: string; args: string[] } {
  const underTs = /\.ts$/.test(cliPath);
  if (!underTs) return { command: process.execPath, args: [cliPath] };
  // Reuse the loader THIS process was started with rather than guessing at one.
  const loader = process.argv[1] ?? '';
  if (/ts-node/.test(loader)) {
    return { command: process.execPath, args: [loader, '--transpile-only', cliPath] };
  }
  const guess = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
  return { command: process.execPath, args: [guess, '--transpile-only', cliPath] };
}

/**
 * Starts the server and asks it for its tools before promising an agent it has any.
 *
 * A declared tool that never answers is worse than no tool: the prompt says
 * the repository is understood, the agent asks nothing because asking hangs,
 * and the answer it produces looks exactly like an informed one. So the claim
 * is EARNED — one real handshake against the real graph — not assumed from the
 * binary being on disk.
 */
export function probe(command: string, args: string[], timeoutMs = 20_000):
{ ok: boolean; tools: number; detail: string } {
  const req = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zeus-probe', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n';
  const r = spawnSync(command, args, { input: req, encoding: 'utf8', timeout: timeoutMs });
  const out = r.stdout ?? '';
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 2 && Array.isArray(m.result?.tools)) {
        return { ok: m.result.tools.length > 0, tools: m.result.tools.length,
          detail: `${m.result.tools.length} tool(s)` };
      }
    } catch { /* not a JSON-RPC line */ }
  }
  return { ok: false, tools: 0,
    detail: `the graph tool server did not answer tools/list: `
      + `${(r.stderr || r.error?.message || out || 'no output').slice(0, 200)}` };
}

export function revisionOf(dir: string): string | null {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() || null : null;
}

/**
 * Prepares repository intelligence for one call.
 *
 * `sourceDir` is the tree the agent will actually read — a worktree for a task,
 * the project root otherwise — and everything else follows from it.
 */
export function attach(opts: {
  projectId: string;
  sourceDir: string;
  stateRoot: string;
  /** Where the MCP server appends what it answered, for the evidence manifest. */
  logPath: string | null;
  /** argv[0] and the script path Zeus itself was started with. */
  execPath: string;
  cliPath: string;
  revision?: string | null;
  now?: () => string;
}): Attached {
  const revision = opts.revision ?? revisionOf(opts.sourceDir);
  const index = repoIndex(opts.sourceDir, revision);
  const h = health();

  if (!h.ok || !revision) {
    const state: GraphState | null = null;
    const fault: GraphFault = h.ok ? 'GRAPHIFY_INDEX_FAILED' : h.fault!;
    return {
      access: null, state, index, fault, graphifyVersion: h.version, logPath: null,
      section: intelSection({ projectId: opts.projectId, index, graph: null,
        graphAvailable: false, graphifyVersion: h.version }),
    };
  }

  const { state } = ensure({ bin: h.bin, sourceDir: opts.sourceDir,
    stateRoot: opts.stateRoot, projectId: opts.projectId, revision, now: opts.now });

  if (state.fault) {
    return {
      access: null, state, index, fault: state.fault, graphifyVersion: h.version,
      logPath: null,
      section: intelSection({ projectId: opts.projectId, index, graph: state,
        graphAvailable: false, graphifyVersion: h.version }),
    };
  }

  const boot = bootstrapArgv(opts.cliPath);
  const serverArgs = [...boot.args, 'graph-mcp', '--graph', state.graphPath,
    ...(opts.logPath ? ['--log', opts.logPath] : [])];

  // Handshake against the REAL graph before promising anything.
  const p = probe(boot.command, [...boot.args, 'graph-mcp', '--graph', state.graphPath]);
  if (!p.ok) {
    return {
      access: null, state, index, fault: 'GRAPHIFY_QUERY_FAILED',
      graphifyVersion: h.version, logPath: null,
      section: intelSection({ projectId: opts.projectId, index,
        graph: { ...state, fault: 'GRAPHIFY_QUERY_FAILED', detail: p.detail },
        graphAvailable: false, graphifyVersion: h.version }),
    };
  }

  if (opts.logPath) fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  return {
    state, index, fault: null, graphifyVersion: h.version, logPath: opts.logPath,
    access: { command: boot.command, args: serverArgs, logPath: opts.logPath },
    section: intelSection({ projectId: opts.projectId, index, graph: state,
      graphAvailable: true, graphifyVersion: h.version }),
  };
}

/** Where one call's evidence log lives, named so two calls never share one. */
export function evidenceLogPath(stateRoot: string, traceCallId: string): string {
  return path.join(stateRoot, 'graph', 'evidence', `${traceCallId}.jsonl`);
}
