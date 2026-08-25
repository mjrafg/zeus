/**
 * The six repository questions, answered from graphify's own artifact.
 *
 * WHY THE ARTIFACT AND NOT THE CLI. graphify ships query/path/explain/affected,
 * and every one of them prints prose for a model to read — `NODE x [src=… ]`,
 * `EDGE a --rel--> b`. Passing --json to `query` does not error; it is silently
 * ignored and the prose comes back anyway, which is the worst kind of no. A
 * tool an agent calls in a loop has to return data, so Zeus reads graph.json,
 * which is the contract graphify actually keeps stable.
 *
 * It also buys a capability the CLI does not have. `affected` traverses edges
 * in REVERSE (dependents) and there is no forward equivalent, so "what does
 * this file depend on" — the first question anyone asks about a landing page —
 * is unanswerable through the CLI and trivial over the edge list.
 *
 * Everything here is pure: a parsed graph in, results out. No spawning, no
 * disk, no network. That is what makes the tool layer testable without an
 * indexer and what keeps a read-only role read-only by construction.
 */

export interface GraphNode {
  id: string;
  label: string;
  source_file?: string;
  source_location?: string;
  file_type?: string;
  _origin?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  /** EXTRACTED — read off the AST. INFERRED — guessed. AMBIGUOUS — unsure. */
  confidence?: string;
  source_file?: string;
  source_location?: string;
}

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

/**
 * Relations that mean "A reaches B", as opposed to "A encloses B".
 *
 * `contains` is graphify's structural edge — a file contains its symbols. It
 * belongs in neighbours and nowhere near dependencies: a file does not depend
 * on its own functions, and letting `contains` through makes every file look
 * like it has as many dependencies as it has lines.
 */
export const REACHES = new Set([
  'imports', 'imports_from', 'calls', 'indirect_call', 'references',
  'dynamic_import', 're_exports', 'inherits', 'extends', 'implements',
  'uses', 'mixes_in', 'embeds', 'requires',
]);

export interface Hit {
  id: string;
  label: string;
  file: string | null;
  location: string | null;
  /** Why this node came back, so an agent can weigh it without guessing. */
  via?: string;
  confidence?: string;
}

const hit = (n: GraphNode, via?: string, confidence?: string): Hit => ({
  id: n.id,
  label: n.label,
  file: n.source_file ?? null,
  location: n.source_location ?? null,
  ...(via ? { via } : {}),
  ...(confidence ? { confidence } : {}),
});

export function indexOf(g: Graph): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const n of g.nodes) m.set(n.id, n);
  return m;
}

/**
 * Resolves what an agent typed to what the graph calls it.
 *
 * Agents name things the way people do — "landing page", "Landing", the path
 * — and graphify's ids are slugs. Matching on id alone would answer "no such
 * node" to a question the graph can plainly answer, and an agent that gets a
 * confident empty result stops looking. Exact id wins, then exact label, then
 * substring across label and path.
 */
export function resolve(g: Graph, term: string, limit = 20): GraphNode[] {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const byId = g.nodes.find((n) => n.id.toLowerCase() === q);
  if (byId) return [byId];
  const exact = g.nodes.filter((n) => n.label.toLowerCase() === q);
  if (exact.length) return exact.slice(0, limit);
  const parts = q.split(/[\s_/.-]+/).filter(Boolean);
  const scored = g.nodes.map((n) => {
    const hay = `${n.label} ${n.source_file ?? ''} ${n.id}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 10;
    for (const p of parts) if (hay.includes(p)) score += 1;
    return { n, score };
  }).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.n.id.localeCompare(b.n.id));
  return scored.slice(0, limit).map((s) => s.n);
}

export function search(g: Graph, term: string, limit = 20): Hit[] {
  return resolve(g, term, limit).map((n) => hit(n));
}

/** Everything one hop away, in both directions, structural edges included. */
export function neighbors(g: Graph, term: string, limit = 50): Hit[] {
  const seeds = new Set(resolve(g, term, 5).map((n) => n.id));
  if (!seeds.size) return [];
  const idx = indexOf(g);
  const out: Hit[] = [];
  const seen = new Set<string>();
  for (const e of g.edges) {
    const forward = seeds.has(e.source);
    const back = seeds.has(e.target);
    if (!forward && !back) continue;
    const otherId = forward ? e.target : e.source;
    const key = `${otherId}:${e.relation}:${forward ? 'out' : 'in'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = idx.get(otherId);
    if (n) out.push(hit(n, `${forward ? '' : '<-'}${e.relation}`, e.confidence));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Forward reach: what this depends on. The CLI cannot answer this at all.
 */
export function dependencies(g: Graph, term: string, depth = 1, limit = 50): Hit[] {
  return walk(g, term, depth, limit, 'out');
}

/** Reverse reach: what depends on this. graphify calls this `affected`. */
export function dependents(g: Graph, term: string, depth = 1, limit = 50): Hit[] {
  return walk(g, term, depth, limit, 'in');
}

function walk(g: Graph, term: string, depth: number, limit: number,
  dir: 'in' | 'out'): Hit[] {
  const idx = indexOf(g);
  let frontier = new Set(resolve(g, term, 5).map((n) => n.id));
  if (!frontier.size) return [];
  const origin = new Set(frontier);
  const seen = new Set(frontier);
  const out: Hit[] = [];
  for (let d = 0; d < Math.max(1, depth); d += 1) {
    const next = new Set<string>();
    for (const e of g.edges) {
      if (!REACHES.has(e.relation)) continue;
      const from = dir === 'out' ? e.source : e.target;
      const to = dir === 'out' ? e.target : e.source;
      if (!frontier.has(from) || seen.has(to)) continue;
      seen.add(to);
      next.add(to);
      const n = idx.get(to);
      if (n) out.push(hit(n, e.relation, e.confidence));
      if (out.length >= limit) return out;
    }
    if (!next.size) break;
    frontier = next;
  }
  void origin;
  return out;
}

/**
 * Where a thing is actually mentioned, with file and line.
 *
 * Distinct from dependents: this answers "take me to the lines" rather than
 * "what breaks if I change it", and the answer is what the agent then Reads.
 */
export function references(g: Graph, term: string, limit = 50):
Array<{ file: string; location: string | null; relation: string;
  from: string; confidence?: string }> {
  const seeds = new Set(resolve(g, term, 5).map((n) => n.id));
  if (!seeds.size) return [];
  const idx = indexOf(g);
  const out: Array<{ file: string; location: string | null; relation: string;
    from: string; confidence?: string }> = [];
  for (const e of g.edges) {
    if (!seeds.has(e.target)) continue;
    const from = idx.get(e.source);
    if (!e.source_file) continue;
    out.push({
      file: e.source_file,
      location: e.source_location ?? null,
      relation: e.relation,
      from: from ? from.label : e.source,
      ...(e.confidence ? { confidence: e.confidence } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Shortest route between two things, so "how do these connect" has an answer. */
export function path(g: Graph, fromTerm: string, toTerm: string, maxHops = 6):
Array<{ from: string; relation: string; to: string; confidence?: string }> | null {
  const starts = resolve(g, fromTerm, 3).map((n) => n.id);
  const goals = new Set(resolve(g, toTerm, 3).map((n) => n.id));
  if (!starts.length || !goals.size) return null;
  const idx = indexOf(g);
  const adj = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    for (const k of [e.source, e.target]) {
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k)!.push(e);
    }
  }
  const prev = new Map<string, { via: GraphEdge; from: string }>();
  const seen = new Set(starts);
  let frontier = [...starts];
  for (let d = 0; d < maxHops && frontier.length; d += 1) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur) ?? []) {
        const to = e.source === cur ? e.target : e.source;
        if (seen.has(to)) continue;
        seen.add(to);
        prev.set(to, { via: e, from: cur });
        if (goals.has(to)) return rebuild(idx, prev, to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return null;
}

function rebuild(idx: Map<string, GraphNode>,
  prev: Map<string, { via: GraphEdge; from: string }>, end: string):
Array<{ from: string; relation: string; to: string; confidence?: string }> {
  const steps: Array<{ from: string; relation: string; to: string;
    confidence?: string }> = [];
  let cur = end;
  while (prev.has(cur)) {
    const { via, from } = prev.get(cur)!;
    steps.unshift({
      from: idx.get(from)?.label ?? from,
      relation: via.relation,
      to: idx.get(cur)?.label ?? cur,
      ...(via.confidence ? { confidence: via.confidence } : {}),
    });
    cur = from;
  }
  return steps;
}
