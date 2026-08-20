/**
 * Which node runs next, and whether the world still looks like the plan said
 * it would.
 *
 * STRICTLY SERIAL. One node is in flight at a time, and the next is chosen
 * only after the previous one has integrated or failed. Parallel execution is
 * a real want and an explicit non-goal here: the plan's `reads`/`writes`
 * declarations are a MODEL of interference, and running two nodes at once on
 * the strength of a model nothing has yet checked is how two correct changes
 * produce one broken tree. Serial execution is the version whose failure modes
 * are already understood.
 */

import { PlanGraph, Precondition, TaskNode } from './types';

/* ------------------------------------------------------------------------ *
 * Order
 * ------------------------------------------------------------------------ */

export interface TopoResult {
  order: string[];
  /** Nodes that could not be ordered because they sit on or behind a cycle. */
  unordered: string[];
}

/**
 * Dependency order, with ties broken by the node id.
 *
 * The tie-break is not cosmetic: two runs of the same plan must schedule the
 * same way, or a mission that failed becomes a mission nobody can reproduce.
 */
export function topoOrder(graph: PlanGraph): TopoResult {
  const byId = new Map(graph.nodes.map((n) => [n.nodeId, n]));
  const indegree = new Map<string, number>();
  for (const n of graph.nodes) {
    indegree.set(n.nodeId, n.dependsOn.filter((d) => byId.has(d)).length);
  }
  const order: string[] = [];
  const ready = () => [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  for (;;) {
    const next = ready()[0];
    if (next === undefined) break;
    order.push(next);
    indegree.delete(next);
    for (const n of graph.nodes) {
      if (n.dependsOn.includes(next) && indegree.has(n.nodeId)) {
        indegree.set(n.nodeId, Math.max(0, indegree.get(n.nodeId)! - 1));
      }
    }
  }
  return { order, unordered: [...indegree.keys()].sort() };
}

/** The nodes that name this one as a dependency. */
export function dependentsOf(graph: PlanGraph, nodeId: string): string[] {
  return graph.nodes.filter((n) => n.dependsOn.includes(nodeId)).map((n) => n.nodeId).sort();
}

export interface ScheduleState {
  /** Nodes that integrated green. */
  done: Set<string>;
  /** Nodes that will not be retried in this plan version. */
  abandoned: Set<string>;
}

/**
 * The next node to spawn, or null when there is nothing runnable.
 *
 * A node behind an abandoned dependency is not runnable and never becomes
 * runnable — reporting it as "waiting" would keep a dead mission looking
 * alive.
 */
export function nextNode(graph: PlanGraph, state: ScheduleState): TaskNode | null {
  const { order } = topoOrder(graph);
  const byId = new Map(graph.nodes.map((n) => [n.nodeId, n]));
  for (const id of order) {
    if (state.done.has(id) || state.abandoned.has(id)) continue;
    const node = byId.get(id)!;
    const deps = node.dependsOn.filter((d) => byId.has(d));
    if (deps.some((d) => state.abandoned.has(d))) continue;
    if (deps.every((d) => state.done.has(d))) return node;
  }
  return null;
}

/** Nodes that can never run because something they need was abandoned. */
export function unreachableNow(graph: PlanGraph, state: ScheduleState): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.nodeId, n]));
  const dead = new Set(state.abandoned);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of graph.nodes) {
      if (dead.has(n.nodeId)) continue;
      if (n.dependsOn.some((d) => byId.has(d) && dead.has(d))) { dead.add(n.nodeId); grew = true; }
    }
  }
  return [...dead].filter((id) => !state.abandoned.has(id)).sort();
}

/* ------------------------------------------------------------------------ *
 * Preconditions
 * ------------------------------------------------------------------------ */

/**
 * How a precondition is answered.
 *
 * Every method is a deterministic observation of the world as it is NOW. None
 * of them asks a model, and none of them reads a cached claim from when the
 * plan was written — the entire point of re-checking immediately before spawn
 * is that the plan was written against a world that has since moved.
 */
export interface PreconditionProbe {
  fileExists(path: string): boolean;
  /** The outcome last recorded for a check, or null if it has not been run. */
  checkOutcome(name: string): string | null;
  /** The current state of a criterion. `UNEVALUATED` when nobody has judged it. */
  criterionState(criterionId: string): string;
}

export interface PreconditionFailure {
  precondition: Precondition;
  observed: string;
  detail: string;
}

export interface PreconditionVerdict {
  ok: boolean;
  failures: PreconditionFailure[];
}

/**
 * Checks a node's preconditions immediately before it is spawned.
 *
 * A precondition nobody can answer FAILS. `checkFailing` against a check that
 * has never been run is not satisfied — it is unknown, and treating unknown as
 * satisfied is the same error as treating REQUIRED_TEST_NOT_RUN as a pass.
 */
export function checkPreconditions(node: TaskNode, probe: PreconditionProbe): PreconditionVerdict {
  const failures: PreconditionFailure[] = [];
  for (const pre of node.preconditions ?? []) {
    switch (pre.kind) {
      case 'fileExists': {
        const seen = probe.fileExists(pre.target);
        if (!seen) failures.push({ precondition: pre, observed: 'absent', detail: `${pre.target} does not exist` });
        break;
      }
      case 'fileAbsent': {
        const seen = probe.fileExists(pre.target);
        if (seen) failures.push({ precondition: pre, observed: 'present', detail: `${pre.target} exists` });
        break;
      }
      case 'checkPassing': {
        const outcome = probe.checkOutcome(pre.target);
        if (outcome !== 'PASSED') {
          failures.push({
            precondition: pre, observed: outcome ?? 'NOT_RUN',
            detail: outcome === null
              ? `check "${pre.target}" has never been run, so nobody can say it passes`
              : `check "${pre.target}" is ${outcome}`,
          });
        }
        break;
      }
      case 'checkFailing': {
        const outcome = probe.checkOutcome(pre.target);
        if (outcome === null || outcome === 'PASSED') {
          failures.push({
            precondition: pre, observed: outcome ?? 'NOT_RUN',
            detail: outcome === null
              ? `check "${pre.target}" has never been run, so nobody can say it fails`
              : `check "${pre.target}" passes`,
          });
        }
        break;
      }
      case 'criterionState': {
        const want = pre.value ?? 'PROVEN';
        const have = probe.criterionState(pre.target);
        if (have !== want) {
          failures.push({
            precondition: pre, observed: have,
            detail: `criterion ${pre.target} is ${have}, the node needs ${want}`,
          });
        }
        break;
      }
      default: {
        failures.push({
          precondition: pre, observed: 'UNKNOWN_KIND',
          detail: `precondition kind "${(pre as Precondition).kind}" is not one this build can check`,
        });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** How a precondition divergence is described when it invalidates the plan. */
export function divergenceDetail(node: TaskNode, verdict: PreconditionVerdict): string {
  return `${node.nodeId}: ${verdict.failures.map((f) => f.detail).join('; ')}`;
}
