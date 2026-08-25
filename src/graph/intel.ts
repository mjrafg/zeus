/**
 * What an agent is told about the repository before it spends anything, and
 * what Zeus can prove it looked at afterwards.
 *
 * THE PROBLEM THIS EXISTS FOR. talkbridge/M-0016 compiled a contract for "add
 * multi language feature to landing page" while knowing nothing about the
 * repository: not that the frontend is a Preact app under app/, not that
 * app/src/engine/languages.js already existed, not which build command
 * verifies the frontend. It attached the only verification it had been handed
 * externally — an api/ typecheck — to a frontend change. A model with maximum
 * reasoning cannot recover facts it was never given.
 *
 * The orientation below costs no model call. It is git and the filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { GraphState } from './graphify';

export interface RepoIndex {
  root: string;
  revision: string | null;
  /** Top-level directories, which is how people describe where things live. */
  directories: string[];
  /** Every manifest found, with the scripts it declares. */
  manifests: Array<{ file: string; name?: string; scripts?: Record<string, string> }>;
  fileCount: number;
  truncated: boolean;
}

const MANIFESTS = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'Gemfile', 'composer.json', 'requirements.txt',
];

/**
 * The repository as git sees it — tracked files only.
 *
 * Tracked, not walked: node_modules and build output are not the repository,
 * and a file tree that drowns app/src in 40k dependency paths orients nobody.
 */
export function repoIndex(root: string, revision: string | null,
  opts: { maxFiles?: number } = {}): RepoIndex {
  const max = opts.maxFiles ?? 4000;
  let files: string[] = [];
  const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) files = (r.stdout ?? '').split('\n').filter(Boolean);
  const truncated = files.length > max;

  const dirs = new Set<string>();
  for (const f of files) {
    const seg = f.split('/')[0];
    if (seg && f.includes('/')) dirs.add(seg);
  }

  const manifests: RepoIndex['manifests'] = [];
  for (const f of files) {
    const base = path.basename(f);
    if (!MANIFESTS.includes(base)) continue;
    // Only shallow ones: a manifest six directories down is a fixture or a
    // vendored copy, not how the project is organised.
    if (f.split('/').length > 3) continue;
    const entry: RepoIndex['manifests'][number] = { file: f };
    if (base === 'package.json') {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
        if (typeof j.name === 'string') entry.name = j.name;
        if (j.scripts && typeof j.scripts === 'object') {
          entry.scripts = {};
          for (const [k, v] of Object.entries(j.scripts)) {
            if (typeof v === 'string') entry.scripts[k] = v.slice(0, 200);
          }
        }
      } catch { /* an unreadable manifest is still a manifest that exists */ }
    }
    manifests.push(entry);
  }

  return {
    root,
    revision,
    directories: [...dirs].sort(),
    manifests,
    fileCount: files.length,
    truncated,
  };
}

/**
 * The capabilities section handed to a repository-aware call.
 *
 * Written so it cannot claim more than is true: when the graph is unavailable
 * the section SAYS so and names what the agent must do instead. A prompt that
 * announces repository intelligence over a graph that is not attached teaches
 * the model to trust a tool that will answer emptily.
 */
export function intelSection(opts: {
  projectId: string;
  index: RepoIndex;
  graph: GraphState | null;
  graphAvailable: boolean;
  graphifyVersion: string | null;
  /** Said plainly when the reason is not a fault of the graph itself. */
  unavailableBecause?: string;
}): string {
  const L: string[] = [];
  const g = opts.graph;
  L.push('--- REPOSITORY INTELLIGENCE ---');
  L.push(`Project: ${opts.projectId}`);
  L.push(`Repository root: ${opts.index.root}`);
  L.push(`Repository revision: ${opts.index.revision ?? 'unknown'}`);
  L.push('');

  if (opts.graphAvailable && g && !g.fault) {
    L.push(`Graphify: AVAILABLE${opts.graphifyVersion ? ` (${opts.graphifyVersion})` : ''}`);
    L.push(`Graph status: READY — ${g.nodes} node(s), ${g.edges} edge(s)`);
    L.push(`Indexed revision: ${g.indexedRevision}`);
    L.push('');
    L.push('Repository tools available to you:');
    L.push('  graph_search        find files/symbols by name or concept');
    L.push('  graph_dependencies  what a file or symbol depends on');
    L.push('  graph_dependents    what depends on it — what a change would affect');
    L.push('  graph_neighbors     everything one hop away');
    L.push('  graph_references    the files and lines that reference it');
    L.push('  graph_path          how two things are connected');
    L.push('  Read, Grep, Glob    the source itself');
  } else {
    L.push('Graphify: UNAVAILABLE');
    L.push(`Graph status: ${opts.unavailableBecause
      ?? `${g?.fault ?? 'GRAPHIFY_UNAVAILABLE'}${g?.detail ? ` — ${g.detail}` : ''}`}`);
    L.push('');
    L.push('You have NO graph tools for this call. Use Read, Grep and Glob, and');
    L.push('state plainly in your answer which repository facts you could not verify.');
  }

  L.push('');
  L.push(`Tracked files: ${opts.index.fileCount}`
    + `${opts.index.truncated ? ' (large repository)' : ''}`);
  if (opts.index.directories.length) {
    L.push(`Top-level directories: ${opts.index.directories.join(', ')}`);
  }
  if (opts.index.manifests.length) {
    L.push('Package manifests found:');
    for (const m of opts.index.manifests) {
      L.push(`  ${m.file}${m.name ? ` (${m.name})` : ''}`);
      for (const [k, v] of Object.entries(m.scripts ?? {})) L.push(`      ${k}: ${v}`);
    }
  }

  L.push('');
  L.push('HOW TO USE THIS');
  L.push('You may call repository tools repeatedly, in as many rounds as you need.');
  L.push('There is no limit on how many queries or reads you may make; you are bounded');
  L.push('only by this mission’s cost and time budget.');
  L.push('');
  L.push('The graph tells you WHERE TO LOOK. Current source files are the SOURCE OF');
  L.push('TRUTH. If the graph says A depends on B and the source shows otherwise,');
  L.push('trust the source and say that the graph disagreed.');
  L.push('');
  L.push('Do not assume the framework, routes, dependencies, tests, build commands or');
  L.push('structure of this repository. Verify what you rely on.');
  L.push('');
  L.push('Continue investigating until further inspection is unlikely to materially');
  L.push('change your decision. If something you find contradicts an earlier assumption,');
  L.push('revise your understanding before you answer.');
  return L.join('\n');
}

/* -- evidence, derived from what ran -------------------------------------- */

export interface GraphOp {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  results: number;
  truncated?: boolean;
  ms: number;
  fault?: string;
}

export interface Evidence {
  graphQueries: GraphOp[];
  filesRead: string[];
  grepQueries: string[];
  revision: string | null;
  /** True when the call had graph tools attached at all. */
  graphAttached: boolean;
}

/**
 * What the call actually inspected, read from the MCP server's own log and
 * from the provider's tool stream.
 *
 * NOT from the model's answer. A model can write "I inspected landing.jsx" in
 * its reply and be wrong or lying, and an evidence manifest built from that
 * sentence would launder the claim into the permanent record. These lines were
 * written by the processes that served the calls.
 */
export function readGraphOps(logPath: string | null): GraphOp[] {
  if (!logPath) return [];
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  const ops: GraphOp[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { ops.push(JSON.parse(line) as GraphOp); } catch { /* a torn line is not evidence */ }
  }
  return ops;
}

/** Renders the manifest for a human reading the trace. */
export function renderEvidence(e: Evidence): string[] {
  const L: string[] = [];
  if (e.graphQueries.length) {
    L.push('Graph queries:');
    for (const op of e.graphQueries) {
      const arg = op.args?.term ?? `${op.args?.from ?? ''} -> ${op.args?.to ?? ''}`;
      L.push(`  ${op.ok ? '✓' : '✗'} ${op.tool} ${JSON.stringify(arg)}`
        + ` — ${op.results} result(s), ${op.ms}ms`
        + `${op.truncated ? ', truncated' : ''}`);
    }
  }
  if (e.filesRead.length) {
    L.push('Files read:');
    for (const f of e.filesRead) L.push(`  ✓ ${f}`);
  }
  if (e.grepQueries.length) {
    L.push('Grep queries:');
    for (const g of e.grepQueries) L.push(`  ✓ ${g}`);
  }
  L.push(`Repository revision: ${e.revision ?? 'unknown'}`);
  return L;
}
