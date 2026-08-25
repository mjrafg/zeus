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

  return {
    state, index, fault: null, graphifyVersion: h.version, logPath: opts.logPath,
    access: {
      command: opts.execPath,
      args: [opts.cliPath, 'graph-mcp', '--graph', state.graphPath,
        ...(opts.logPath ? ['--log', opts.logPath] : [])],
      logPath: opts.logPath,
    },
    section: intelSection({ projectId: opts.projectId, index, graph: state,
      graphAvailable: true, graphifyVersion: h.version }),
  };
}

/** Where one call's evidence log lives, named so two calls never share one. */
export function evidenceLogPath(stateRoot: string, traceCallId: string): string {
  return path.join(stateRoot, 'graph', 'evidence', `${traceCallId}.jsonl`);
}
