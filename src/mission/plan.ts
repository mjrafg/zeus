/**
 * Deterministic plan validation.
 *
 * A pure function over the graph: no filesystem, no git, no model. Everything
 * here is a fact about the structure the planner produced, which means it can
 * run before anything is spawned and its answer cannot vary between runs.
 *
 * The AI critic — "is this plan a good idea?" — is a later stage and a
 * different question. This half answers "is this plan coherent?", and a plan
 * that fails here is not worth asking anyone's opinion about.
 */

import {
  PlanGraph, TaskNode, Precondition, PredictedEffect,
  EFFECT_KINDS, PRECONDITION_KINDS, TIERS, RISKS,
} from './types';

export type PlanFindingCode =
  | 'DUPLICATE_NODE_ID'
  | 'DANGLING_DEPENDENCY'
  | 'CYCLE'
  | 'SCHEMA_INVALID'
  | 'UNREACHABLE_NODE'
  | 'UNDECLARED_INTERFERENCE'
  | 'CRITERION_UNCOVERED'
  | 'CRITERION_SCOPE_MISMATCH';

export interface PlanFinding {
  code: PlanFindingCode;
  /**
   * `error` blocks the plan. `info` is data for later stages — undeclared
   * interference is a fact the scheduler and the critic need, not a reason to
   * refuse a plan in stage 1.
   */
  severity: 'error' | 'info';
  /** The node the finding is about, when it is about one. */
  nodeId?: string;
  /** The second node, for findings that are about a pair. */
  otherNodeId?: string;
  /** The cycle, in order, so a reader can see it rather than go looking. */
  path?: string[];
  /** Overlapping globs, for interference findings. */
  overlap?: string[];
  /** Human-readable diagnosis. Never the only content of a finding. */
  detail: string;
}

export interface PlanValidation {
  valid: boolean;
  findings: PlanFinding[];
  /** Nodes with no dependencies: where execution could start. */
  roots: string[];
  nodeCount: number;
}

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

function schemaFindings(node: TaskNode, index: number): PlanFinding[] {
  const out: PlanFinding[] = [];
  const at = node?.nodeId ?? `#${index}`;
  const bad = (detail: string) => out.push({ code: 'SCHEMA_INVALID', severity: 'error', nodeId: at, detail });

  if (typeof node?.nodeId !== 'string' || !node.nodeId.trim()) bad('nodeId must be a non-empty string');
  if (typeof node?.description !== 'string' || !node.description.trim()) bad('description must be a non-empty string');
  for (const key of ['dependsOn', 'reads', 'writes', 'affectedCriteria'] as const) {
    if (!isStringArray((node as any)?.[key])) bad(`${key} must be an array of strings`);
  }
  if (!Array.isArray(node?.preconditions)) bad('preconditions must be an array');
  else {
    node.preconditions.forEach((p: Precondition, i) => {
      if (!p || !PRECONDITION_KINDS.includes(p.kind)) {
        bad(`preconditions[${i}].kind must be one of ${PRECONDITION_KINDS.join(', ')}`);
      } else if (typeof p.target !== 'string' || !p.target) {
        bad(`preconditions[${i}].target must be a non-empty string`);
      } else if (p.kind === 'criterionState' && typeof p.value !== 'string') {
        bad(`preconditions[${i}] of kind criterionState requires a value`);
      }
    });
  }
  if (!Array.isArray(node?.predictedEffects)) bad('predictedEffects must be an array');
  else {
    node.predictedEffects.forEach((e: PredictedEffect, i) => {
      // Typed effects only: an effect exists to be compared against what
      // actually happened, and prose cannot be compared to anything.
      if (!e || !EFFECT_KINDS.includes((e as any).kind)) {
        bad(`predictedEffects[${i}].kind must be one of ${EFFECT_KINDS.join(', ')}`);
        return;
      }
      if (e.kind === 'expectedCheckTransition'
        && (typeof e.check !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string')) {
        bad(`predictedEffects[${i}] (expectedCheckTransition) needs check, from and to`);
      }
      if (e.kind === 'expectedArtifact' && (typeof e.path !== 'string' || typeof e.exists !== 'boolean')) {
        bad(`predictedEffects[${i}] (expectedArtifact) needs path and exists`);
      }
      if (e.kind === 'expectedStateFact' && (typeof e.fact !== 'string' || typeof e.value !== 'string')) {
        bad(`predictedEffects[${i}] (expectedStateFact) needs fact and value`);
      }
    });
  }
  if (!TIERS.includes(node?.estimatedTier)) bad(`estimatedTier must be one of ${TIERS.join(', ')}`);
  if (!RISKS.includes(node?.risk)) bad(`risk must be one of ${RISKS.join(', ')}`);
  if (typeof node?.estimatedCost !== 'number' || !Number.isFinite(node.estimatedCost) || node.estimatedCost < 0) {
    bad('estimatedCost must be a finite number >= 0');
  }
  return out;
}

/**
 * Every cycle, each reported as the path around it.
 *
 * "A cycle exists" is not actionable on a graph of forty nodes. The colouring
 * walk keeps the current stack so the reported path is the loop itself.
 */
function findCycles(nodes: Map<string, TaskNode>): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const walk = (id: string): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'open') {
      const from = stack.lastIndexOf(id);
      const cycle = [...stack.slice(from), id];
      const key = [...cycle].sort().join('>');
      if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      return;
    }
    state.set(id, 'open');
    stack.push(id);
    for (const dep of nodes.get(id)?.dependsOn ?? []) if (nodes.has(dep)) walk(dep);
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of nodes.keys()) walk(id);
  return cycles;
}

/**
 * Whether two glob-ish path patterns could name the same file.
 *
 * Deliberately conservative: this decides whether to REPORT possible
 * interference, so a false positive costs a reader one line and a false
 * negative hides a real conflict from the scheduler.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = (g: string) => {
    const star = g.indexOf('*');
    return star === -1 ? g : g.slice(0, star);
  };
  const [pa, pb] = [prefix(a), prefix(b)];
  const wildA = a.includes('*');
  const wildB = b.includes('*');
  if (!wildA && !wildB) return false;                 // two exact paths, already compared
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Nodes reachable from `from` by following dependents (reverse dependsOn). */
function reachable(nodes: Map<string, TaskNode>, roots: string[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const n of nodes.values()) {
    for (const dep of n.dependsOn) {
      if (!nodes.has(dep)) continue;
      dependents.set(dep, [...(dependents.get(dep) ?? []), n.nodeId]);
    }
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependents.get(id) ?? []) queue.push(next);
  }
  return seen;
}

/** True when `a` and `b` are ordered by any dependency path, either direction. */
function ordered(nodes: Map<string, TaskNode>, a: string, b: string): boolean {
  const dependsPath = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const id = queue.shift()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id)?.dependsOn ?? []) queue.push(dep);
    }
    return false;
  };
  return dependsPath(a, b) || dependsPath(b, a);
}

/**
 * Every required criterion must be somebody's job.
 *
 * A plan that leaves a required criterion untouched cannot achieve the
 * mission, and no amount of critique will notice it as reliably as counting
 * will. Deterministic, and it runs BEFORE the critic — there is no point
 * asking a model's opinion of a plan that provably cannot succeed.
 */
export function coverageFindings(graph: PlanGraph,
  requiredCriteria: string[]): PlanFinding[] {
  const covered = new Set<string>();
  for (const n of graph?.nodes ?? []) {
    for (const c of n?.affectedCriteria ?? []) covered.add(c);
  }
  return requiredCriteria
    .filter((c) => !covered.has(c))
    .map((criterionId) => ({
      code: 'CRITERION_UNCOVERED' as const, severity: 'error' as const,
      detail: `no node claims to affect "${criterionId}", so this plan cannot prove it`,
      nodeId: undefined, otherNodeId: criterionId,
    }));
}


/* ------------------------------------------------------------------------ *
 * Scope: does the plan write over as much ground as the criterion reads?
 * ------------------------------------------------------------------------ */

/**
 * The scope-bearing text of one criterion's evaluator.
 *
 * Deliberately a plain shape rather than an `Oracle` import: this file knows
 * about plans and stays free of the contract layer, and the caller is the one
 * that already holds both.
 */
export interface CriterionScopeInput {
  criterionId: string;
  /** Evaluator text only — command lines, probe commands, rubric artifacts. */
  texts: string[];
}

/**
 * Text that is a PROGRAM rather than an argument vector.
 *
 * An evaluator may be `node -e '<a whole script>'`. Source code is dense with
 * slashes — regex literals, division, path fragments inside string literals —
 * and none of them is an argument naming a scope. The first real plan this
 * check ever saw was exactly this shape, and it produced nine findings quoting
 * fragments of minified JavaScript as if they were directories. A false signal
 * here is worse than no signal: it teaches the reader to skip the section.
 *
 * So an inline program yields NO scope at all. That is the conservatism
 * boundary working, not a gap in it.
 */
function looksLikeProgram(text: string): boolean {
  return /\brequire\s*\(|=>|\bconst\s|\blet\s|\bfunction\b|spawnSync|execFileSync|;\s*const|\$\{/.test(text);
}

/** Path-shaped, in the way a shell argument is. */
const PATH_TOKEN = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]*)+\/?$/;

/** A trailing-slash-normalised directory prefix, or null if not a scope. */
function asPrefix(token: string): string | null {
  let t = token.trim().replace(/^['"]|['"]$/g, '');
  if (!t || t.startsWith('-')) return null;
  // A glob collapses to the fixed text before its first wildcard.
  const star = t.indexOf('*');
  if (star !== -1) t = t.slice(0, star);
  t = t.replace(/^\.\//, '');
  if (!t || !t.includes('/')) return null;            // a bare word is not a path
  if (/^https?:\/\//.test(t)) return null;
  // Anything carrying punctuation a path does not carry is code, not a path.
  if (/[()[\]{}<>;=,|&$!`\\"']/.test(t)) return null;
  if (!PATH_TOKEN.test(t)) return null;
  return t;
}

/**
 * Path scopes an evaluator provably reads over.
 *
 * CONSERVATIVE BY CONSTRUCTION. Only tokens that are literally paths in the
 * evaluator's own text count. `npm run typecheck` yields nothing, because what
 * that script covers is a fact about the project's package.json and not about
 * this string — and inferring it would be guessing with an authoritative
 * voice. A criterion whose scope cannot be read off its evaluator produces no
 * finding at all, which is the correct failure direction: this signal exists
 * to make a human look, and a false one teaches people to stop looking.
 */
export function extractScopes(texts: string[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    // An inline program's scope is a property of what the code DOES, which is
    // not a question this or any tokeniser can answer.
    if (looksLikeProgram(raw)) continue;
    for (const token of raw.split(/\s+/)) {
      const p = asPrefix(token);
      if (p) out.add(p);
    }
  }
  return [...out].sort();
}

/** Whether `scope` names a directory rather than one specific file. */
export function isDirectoryScope(scope: string): boolean {
  if (scope.endsWith('/')) return true;
  const last = scope.slice(scope.lastIndexOf('/') + 1);
  return last.length > 0 && !last.includes('.');
}

/** Whether a declared write covers everything under `scope`. */
function writeCoversScope(write: string, scope: string): boolean {
  const w = write.trim().replace(/^\.\//, '');
  const star = w.indexOf('*');
  const wPrefix = star === -1 ? w : w.slice(0, star);
  const dir = scope.endsWith('/') ? scope : `${scope}/`;
  if (star === -1) {
    // An exact path covers a scope only when it IS the scope.
    return w === scope || `${w}/` === dir;
  }
  // A glob covers the scope when its fixed prefix reaches no further in.
  return dir.startsWith(wPrefix) || wPrefix === '' ;
}

/**
 * The BC-2 finding: a criterion read over a directory, a plan that writes one
 * file inside it.
 *
 * Coverage was already checked, and passed, because coverage is NOMINAL — some
 * node names the criterion. That is not the same question as whether the work
 * is large enough to move it. A criterion evaluated across `src/` and a plan
 * whose entire write surface is `src/one-file.ts` will honestly report FAILED,
 * and the mismatch was visible in the plan before any task ran.
 *
 * NON-BLOCKING on purpose. A plan may legitimately intend partial progress —
 * one cluster now, more later — and that is a decision for a person. What must
 * not happen is paying for it without being told.
 */
export function scopeMismatchFindings(graph: PlanGraph,
  criteria: CriterionScopeInput[]): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

  for (const c of criteria) {
    const scopes = extractScopes(c.texts).filter(isDirectoryScope);
    if (!scopes.length) continue;                     // not mechanically extractable

    const covering = nodes.filter((n) => (n.affectedCriteria ?? []).includes(c.criterionId));
    if (!covering.length) continue;                   // CRITERION_UNCOVERED already said this
    const writes = covering.flatMap((n) => n.writes ?? []).filter(Boolean);

    for (const scope of scopes) {
      // Writes that land anywhere inside the scope. Writes elsewhere are not
      // evidence about this scope in either direction.
      const inside = writes.filter((w) => {
        const wp = w.replace(/^\.\//, '');
        const dir = scope.endsWith('/') ? scope : `${scope}/`;
        return wp === scope || wp.startsWith(dir) || writeCoversScope(w, scope);
      });
      if (inside.some((w) => writeCoversScope(w, scope))) continue;   // a glob covers it

      const gap = inside.length === 0
        ? `the plan writes nothing under "${scope}"`
        : `the plan writes only ${inside.map((w) => `"${w}"`).join(', ')} under "${scope}"`;
      findings.push({
        code: 'CRITERION_SCOPE_MISMATCH', severity: 'info',
        detail: `"${c.criterionId}" is evaluated over "${scope}", and ${gap}`
          + ' — this plan can move it partway at best, and the criterion will report FAILED',
        nodeId: covering[0]?.nodeId,
        otherNodeId: c.criterionId,
      });
    }
  }
  return findings;
}

/**
 * The full deterministic gate for a plan compiled against an oracle.
 *
 * Structure first, then coverage. Both are facts about the plan, so both are
 * answered before anyone is asked for an opinion about it.
 */
export function validatePlanForOracle(graph: PlanGraph, requiredCriteria: string[],
  scopes: CriterionScopeInput[] = []): PlanValidation {
  const base = validatePlan(graph);
  const coverage = coverageFindings(graph, requiredCriteria);
  // Scope is asked only of REQUIRED criteria: an optional criterion the plan
  // moves partway is a smaller conversation, and this stop is expensive
  // enough that it must be reserved for what the mission is judged on.
  const required = new Set(requiredCriteria);
  const scopeGaps = scopeMismatchFindings(graph, scopes.filter((s) => required.has(s.criterionId)));
  const findings = [...base.findings, ...coverage, ...scopeGaps];
  return { ...base, findings, valid: !findings.some((f) => f.severity === 'error') };
}

export function validatePlan(graph: PlanGraph): PlanValidation {
  const findings: PlanFinding[] = [];
  const list: TaskNode[] = Array.isArray(graph?.nodes) ? graph.nodes : [];

  // ---- schema, per node -------------------------------------------------
  list.forEach((n, i) => findings.push(...schemaFindings(n, i)));

  // ---- unique ids -------------------------------------------------------
  const byId = new Map<string, TaskNode>();
  const counts = new Map<string, number>();
  for (const n of list) {
    if (typeof n?.nodeId !== 'string') continue;
    counts.set(n.nodeId, (counts.get(n.nodeId) ?? 0) + 1);
    if (!byId.has(n.nodeId)) byId.set(n.nodeId, n);
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      findings.push({ code: 'DUPLICATE_NODE_ID', severity: 'error', nodeId: id,
        detail: `${count} nodes share the id "${id}"; a plan addresses nodes by id, so this is ambiguous` });
    }
  }

  // ---- dependencies resolve --------------------------------------------
  for (const n of byId.values()) {
    for (const dep of n.dependsOn ?? []) {
      if (!byId.has(dep)) {
        findings.push({ code: 'DANGLING_DEPENDENCY', severity: 'error', nodeId: n.nodeId, otherNodeId: dep,
          detail: `"${n.nodeId}" depends on "${dep}", which is not a node in this plan` });
      }
    }
  }

  // ---- cycles, with the path -------------------------------------------
  for (const cycle of findCycles(byId)) {
    findings.push({ code: 'CYCLE', severity: 'error', nodeId: cycle[0], path: cycle,
      detail: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  // ---- reachability -----------------------------------------------------
  const roots = [...byId.values()]
    .filter((n) => (n.dependsOn ?? []).filter((d) => byId.has(d)).length === 0)
    .map((n) => n.nodeId);
  const seen = reachable(byId, roots);
  for (const id of byId.keys()) {
    if (!seen.has(id)) {
      findings.push({ code: 'UNREACHABLE_NODE', severity: 'error', nodeId: id,
        detail: `"${id}" is not reachable from any root; nothing could ever start it` });
    }
  }

  // ---- undeclared interference -----------------------------------------
  // Two nodes that touch the same paths and are NOT ordered by a dependency
  // path could run concurrently and collide. Reported as data for the
  // scheduler and the critic, never as a blocker in this stage.
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [a, b] = [byId.get(ids[i])!, byId.get(ids[j])!];
      if (ordered(byId, a.nodeId, b.nodeId)) continue;
      const overlaps: string[] = [];
      for (const w of a.writes ?? []) {
        for (const other of [...(b.writes ?? []), ...(b.reads ?? [])]) {
          if (globsOverlap(w, other)) overlaps.push(`${a.nodeId}:writes ${w} ~ ${b.nodeId}:${(b.writes ?? []).includes(other) ? 'writes' : 'reads'} ${other}`);
        }
      }
      for (const w of b.writes ?? []) {
        for (const other of a.reads ?? []) {
          if (globsOverlap(w, other)) overlaps.push(`${b.nodeId}:writes ${w} ~ ${a.nodeId}:reads ${other}`);
        }
      }
      if (overlaps.length) {
        findings.push({ code: 'UNDECLARED_INTERFERENCE', severity: 'info',
          nodeId: a.nodeId, otherNodeId: b.nodeId, overlap: [...new Set(overlaps)],
          detail: `"${a.nodeId}" and "${b.nodeId}" touch the same paths but are not ordered by any dependency` });
      }
    }
  }

  return {
    valid: !findings.some((f) => f.severity === 'error'),
    findings,
    roots,
    nodeCount: byId.size,
  };
}
