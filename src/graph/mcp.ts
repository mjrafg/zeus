/**
 * The graph as tools an agent calls, over MCP stdio.
 *
 * WHY A SERVER AND NOT A LONGER PROMPT. The requirement is repeated, self-
 * directed investigation: query, read, learn something, query again. Text in a
 * prompt cannot do that — it is one shot, decided before the agent knows what
 * it wants. Both provider CLIs already speak MCP (`claude --mcp-config`,
 * `codex -c mcp_servers…`), so a stdio server is the one place a tool can live
 * and be called in a loop.
 *
 * WHY IT IS READ-ONLY BY CONSTRUCTION. This process opens graph.json and a
 * log file and nothing else. There is no code path here that writes to the
 * repository, so handing these tools to a critic cannot widen what the critic
 * can do — the permission boundary is a property of the binary, not of a flag
 * someone remembered to pass.
 *
 * EVIDENCE. Every answered call is appended to ZEUS_GRAPH_LOG as one JSON
 * line. That file is how Zeus learns what an agent actually inspected. A model
 * saying "I examined landing.jsx" is a claim; a line written by the process
 * that served the query is a fact, and only one of them belongs in an evidence
 * manifest.
 *
 * Zero dependencies: newline-delimited JSON-RPC on stdin/stdout, which is what
 * MCP stdio is.
 */

import * as fs from 'fs';
import { loadGraph } from './graphify';
import * as q from './query';
import type { Graph } from './query';

export const PROTOCOL = '2024-11-05';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const term = (d: string) => ({
  type: 'object',
  properties: { term: { type: 'string', description: d } },
  required: ['term'],
});

/**
 * Named for the question each answers, not for graphify's command surface.
 *
 * graph_dependencies has no CLI equivalent at all — graphify's `affected`
 * walks edges in reverse only — so an agent asking the most ordinary question
 * about a file would have got nothing back through the CLI.
 */
export const TOOLS: ToolSpec[] = [
  { name: 'graph_search',
    description: 'Find files, symbols and modules in this repository by name or concept. '
      + 'Start here when you do not yet know which files matter.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'A name, path fragment or concept, e.g. "landing page"' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['term'],
    } },
  { name: 'graph_dependencies',
    description: 'What this file or symbol depends on — what it imports, calls or uses.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string' },
        depth: { type: 'number', description: 'Hops to follow (default 1)' },
      },
      required: ['term'],
    } },
  { name: 'graph_dependents',
    description: 'What depends on this — what would be affected if you changed it.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' }, depth: { type: 'number' } },
      required: ['term'],
    } },
  { name: 'graph_neighbors',
    description: 'Everything one hop away in either direction, including structure.',
    inputSchema: term('A file or symbol') },
  { name: 'graph_references',
    description: 'The files and lines where this is referenced, so you know what to Read next.',
    inputSchema: term('A file or symbol') },
  { name: 'graph_path',
    description: 'How two things are connected, as a chain of relations.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    } },
];

export interface Answer { ok: boolean; text: string; results: number; truncated: boolean }

/**
 * Runs one tool against the graph.
 *
 * An empty result says so in words. "[]" reads to a model as "nothing depends
 * on this", which is a finding; "no node matched" is an instruction to search
 * differently, and the difference decides whether the agent keeps looking.
 */
export function callTool(graph: Graph, name: string, args: Record<string, any>): Answer {
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const depth = Math.max(1, Math.min(6, Number(args.depth) || 1));
  const t = String(args.term ?? '');
  let payload: unknown;
  switch (name) {
    case 'graph_search': payload = q.search(graph, t, Math.min(limit, Number(args.limit) || 20)); break;
    case 'graph_dependencies': payload = q.dependencies(graph, t, depth, limit); break;
    case 'graph_dependents': payload = q.dependents(graph, t, depth, limit); break;
    case 'graph_neighbors': payload = q.neighbors(graph, t, limit); break;
    case 'graph_references': payload = q.references(graph, t, limit); break;
    case 'graph_path': {
      const p = q.path(graph, String(args.from ?? ''), String(args.to ?? ''));
      if (!p) {
        return { ok: true, results: 0, truncated: false,
          text: `No path found between "${args.from}" and "${args.to}" in the graph. `
            + 'They may be unconnected, or one of the names may not match a node — '
            + 'try graph_search first.' };
      }
      payload = p;
      break;
    }
    default:
      return { ok: false, results: 0, truncated: false, text: `unknown tool ${name}` };
  }
  const arr = payload as unknown[];
  if (Array.isArray(arr) && arr.length === 0) {
    return { ok: true, results: 0, truncated: false,
      text: `No node matched "${t}". This means the graph has no such name — not that `
        + 'nothing exists. Try a different term with graph_search, or use Grep/Glob '
        + 'against the source, which is the source of truth.' };
  }
  const results = Array.isArray(arr) ? arr.length : 1;
  return { ok: true, results, truncated: results >= limit,
    text: JSON.stringify(payload, null, 1) };
}

interface Req { id?: unknown; method?: string; params?: any }

/**
 * The stdio loop. Framing is one JSON object per line, which is MCP stdio.
 */
export function serve(opts: {
  graphPath: string; logPath?: string | null;
  stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream;
  now?: () => string;
}): void {
  const out = opts.stdout ?? process.stdout;
  const inp = opts.stdin ?? process.stdin;
  const send = (o: unknown) => out.write(`${JSON.stringify(o)}\n`);
  const graph = loadGraph(opts.graphPath);

  const record = (entry: Record<string, unknown>) => {
    if (!opts.logPath) return;
    // Best effort: an unwritable evidence log must not take down the tool the
    // agent is mid-investigation with. Zeus notices the absence separately.
    try { fs.appendFileSync(opts.logPath, `${JSON.stringify(entry)}\n`); } catch { /* noted by its absence */ }
  };

  let buf = '';
  inp.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      let req: Req;
      try { req = JSON.parse(line); } catch { continue; }
      handle(req);
    }
  });

  function handle(req: Req): void {
    const id = req.id;
    const reply = (result: unknown) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
    const fail = (code: number, message: string) => {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } });
    };

    if (req.method === 'initialize') {
      reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: 'zeus-graph', version: '1' } });
      return;
    }
    if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') return;
    if (req.method === 'ping') { reply({}); return; }
    if (req.method === 'tools/list') { reply({ tools: TOOLS }); return; }
    if (req.method === 'tools/call') {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments ?? {}) as Record<string, any>;
      const at = opts.now ? opts.now() : new Date().toISOString();
      const started = Date.now();
      if (!graph) {
        // Fail closed and say so IN the answer. Returning an empty list would
        // let an agent conclude the repository has no such code, and then
        // report that conclusion as evidence.
        record({ at, tool: name, args, ok: false, results: 0, ms: 0,
          fault: 'GRAPHIFY_QUERY_FAILED' });
        reply({ isError: true, content: [{ type: 'text',
          text: 'The repository graph could not be read. Repository intelligence is '
            + 'UNAVAILABLE for this call. Do not assume anything about repository '
            + 'structure; use Read/Grep/Glob and say what you could not verify.' }] });
        return;
      }
      const a = callTool(graph, name, args);
      record({ at, tool: name, args, ok: a.ok, results: a.results,
        truncated: a.truncated, ms: Date.now() - started });
      if (!a.ok) { fail(-32601, a.text); return; }
      reply({ content: [{ type: 'text', text: a.text }] });
      return;
    }
    fail(-32601, `unknown method ${req.method}`);
  }
}
