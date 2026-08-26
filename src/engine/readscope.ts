/**
 * Where did a stage actually LOOK?
 *
 * THE RUN THIS EXISTS FOR. talkbridge/M-0032's oracle critic read the
 * talkbridge repository correctly, and then read Zeus's own source:
 * `src/mission/oracle.ts`, `compile.ts`, `reviewcontext.ts`, `test/oracle.ts`.
 * It was not being clever. The critique prompt asks for a `modeOpinion` of
 * `AUTO|OPTIONAL_CONFIRMATION|REQUIRED_CONSENT` and never says what those words
 * mean, so the model went and found the file that does. It also enumerated
 * every `events.jsonl` under `.zeus/state`, which is this mission's own log and
 * every other mission's, including previous critic verdicts.
 *
 * THAT IS THE HOLE. `ORACLE_CRITIQUE_POLICY`, the leak patterns and the
 * contaminated-payload refusal all guard what Zeus HANDS an agent. None of them
 * guards what the agent FETCHES. Independence is enforced at the prompt
 * boundary, and the agent has a shell that walks around it.
 *
 * V1 OBSERVES. This never blocks, and that is a decision rather than an
 * unfinished gate: nobody knows yet how often agents leave the repository, and
 * a gate tuned on a guess either fires constantly or never. The instruction is
 * in the prompt, this is the measurement, and the measurement comes first.
 *
 * WHAT IT READS. The provider's own transcript, and only the TOOL CALLS in it,
 * never the tool RESULTS. A `rg` that returns a hundred paths is one reach and
 * not a hundred, and a source file that merely mentions a path is not a read of
 * it. What the agent asked for is the agent's act; what came back is not.
 */

import * as path from 'path';

/* -- what the transcript says was called ---------------------------------- */

export interface ToolCall {
  /** The provider's own name for it: `shell`, `Bash`, `Read`, `Grep`. */
  tool: string;
  /** The command line or the path arguments, as the agent wrote them. */
  text: string;
}

/**
 * Stream envelopes the provider CLIs emit.
 *
 * Recognising the FORMAT is what separates "this agent called no tools" from
 * "Zeus cannot read this transcript". Without that distinction an unparseable
 * reply reads exactly like a well-behaved one, which is the same absent-versus-
 * empty confusion that once put `{clean: true}` on an uninspectable tree.
 */
const STREAM_ENVELOPES = new Set([
  // claude
  'system', 'assistant', 'user', 'result', 'stream_event', 'rate_limit_event',
  // codex
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.completed', 'item.updated', 'error',
]);

/** Tool-input keys that name something on the filesystem. */
const PATH_KEYS = ['command', 'file_path', 'filePath', 'path', 'paths',
  'notebook_path', 'pattern', 'glob', 'dir', 'cwd'];

function describeInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const key of PATH_KEYS) {
    const v = (input as any)[key];
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(...v.filter((x) => typeof x === 'string'));
  }
  return parts.join(' ');
}

/**
 * Every tool call in a provider transcript, and whether the transcript was one.
 *
 * Deduplicated by tool and text, because codex reports a command twice - once
 * at `item.started` and again at `item.completed` - and counting a reach twice
 * would inflate the only number this produces.
 */
export function toolCallsIn(raw: string): { recognised: boolean; calls: ToolCall[] } {
  let recognised = false;
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  const push = (tool: string, text: string) => {
    const t = (text ?? '').trim();
    if (!t) return;
    const key = `${tool} ${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ tool, text: t });
  };

  for (const line of (raw ?? '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const type = typeof o.type === 'string' ? o.type : '';
    if (STREAM_ENVELOPES.has(type)) recognised = true;

    // codex: {"type":"item.completed","item":{"type":"command_execution",...}}
    const item = o.item;
    if (item && typeof item === 'object' && typeof item.type === 'string') {
      recognised = true;
      if (item.type === 'command_execution') push('shell', String(item.command ?? ''));
      if (item.type === 'file_read' || item.type === 'file_change') {
        push(item.type, String(item.path ?? item.file ?? ''));
      }
      if (item.type === 'mcp_tool_call') {
        push(String(item.tool ?? 'mcp'), describeInput(item.arguments ?? item.args));
      }
    }

    // claude: the consolidated assistant message. `stream_event` carries the
    // same call as a run of partial-JSON deltas, and reassembling those would
    // be a second parser for a fact this one already has.
    if (type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const block of o.message.content) {
        if (block?.type !== 'tool_use') continue;
        push(String(block.name ?? 'tool'), describeInput(block.input));
      }
    }
  }
  return { recognised, calls };
}

/* -- what those calls named ------------------------------------------------ */

/**
 * Path-shaped tokens in a command line.
 *
 * Absolute paths, dot-relative paths, and a bare `.zeus`. The last because
 * every stage runs with the repository as its working directory, so the read
 * that matters most is written `find .zeus -maxdepth 3` with no slash in front
 * of it.
 */
const PATH_TOKEN =
  /(?:^|[\s'"`=(,[{|&;><])((?:\.{1,2}\/|\/|\.zeus(?=[/\s'"`]|$))[^\s'"`)\]}|&;><]*)/g;

/**
 * Regex machinery, which is what most path-shaped tokens on a command line
 * actually are.
 *
 * MEASURED, not guessed. Replaying every transcript on the host produced three
 * escapes, and two of them were `rg` patterns: `/from\s+[`, `/\.(js`,
 * `../mock\.js`. A signal that is two-thirds noise is not a signal, and the
 * first person to read a report full of `/month` stops reading reports.
 */
const REGEX_MACHINERY = /[\\[\]()|^$]/;

/**
 * The other half of the same finding: `/month`, `/i18n`, `/setSettingsMany`.
 *
 * All three were the closing delimiter of a regex, and none of them is a path
 * anyone reads. A single-segment absolute path is required to be rejected
 * BECAUSE the alternative is worse: nothing at that shape is a real read
 * except `ls /srv`-style directory browsing, which the next command has to
 * follow up on anyway with a two-segment path.
 *
 * KNOWN LIMIT, stated rather than hidden: an agent that reads exactly one
 * top-level directory and nothing under it is not reported.
 */
function looksLikeAPath(token: string): boolean {
  if (REGEX_MACHINERY.test(token)) return false;
  if (token.startsWith('/')) return (token.match(/\//g) ?? []).length >= 2;
  return true;
}

export function pathsIn(text: string): string[] {
  const out: string[] = [];
  // matchAll rather than a lastIndex loop. The boundary probe over src/engine
  // treats that regex method's name as a process spawn wherever it appears in
  // this directory, and it is right to be blunt: one word, one meaning, in the
  // directory where spawning is the thing being controlled.
  for (const m of (text ?? '').matchAll(PATH_TOKEN)) {
    // Trailing punctuation belongs to the sentence, not to the path.
    const token = String(m[1]).replace(/[.,:;'"`]+$/, '');
    if (!token || token === '/' || token === './' || token === '../') continue;
    if (!looksLikeAPath(token)) continue;
    out.push(token);
  }
  return [...new Set(out)];
}

/* -- classification -------------------------------------------------------- */

export type ReadScopeKind = 'MISSION_STATE' | 'ZEUS_INSTALL' | 'OUTSIDE_PROJECT';

export interface ReadReach {
  kind: ReadScopeKind;
  /** As the agent wrote it. */
  path: string;
  resolved: string;
  /** The tool call it appeared in. */
  tool: string;
  via: string;
}

export interface ScopeRoots {
  projectRoot: string;
  /** Where Zeus itself is installed. */
  zeusRoot: string;
  /** The state directory, wherever the project config put it. */
  stateRoot?: string | null;
}

/**
 * Paths that are the operating system, not somebody's source.
 *
 * `/bin/bash -lc` opens literally every codex command, and a report whose top
 * finding is the shell it ran in is a report nobody reads twice. Scratch
 * directories are here for the same reason: an agent writing a temp file has
 * not gone looking through anyone's repository.
 *
 * Applied LAST, so an install under `/usr/local/lib/node_modules` is still
 * caught as ZEUS_INSTALL rather than waved through as system plumbing.
 */
const SYSTEM_PREFIXES = [
  '/bin/', '/sbin/', '/usr/', '/lib/', '/lib64/', '/dev/', '/proc/', '/sys/',
  '/tmp/', '/var/tmp/', '/private/tmp/', '/opt/homebrew/', '/nix/store/',
];

function under(p: string, root: string): boolean {
  if (!root) return false;
  const r = root.endsWith(path.sep) ? root.slice(0, -1) : root;
  return p === r || p.startsWith(r + path.sep);
}

export function classifyPath(raw: string, roots: ScopeRoots):
Omit<ReadReach, 'tool' | 'via'> | null {
  const resolved = path.resolve(roots.projectRoot, raw);
  const missionState = path.join(roots.projectRoot, '.zeus');

  // FIRST, because it lives inside the project and would otherwise read as in
  // scope. This is the mission's own event log, every other mission's, the
  // trace blobs and the previous critiques - the exact material the review
  // context policy refuses to deliver.
  if (under(resolved, missionState)
    || (roots.stateRoot ? under(resolved, roots.stateRoot) : false)) {
    return { kind: 'MISSION_STATE', path: raw, resolved };
  }

  // WHEN ZEUS IS THE PROJECT, Zeus's source IS the work. Developing Zeus on
  // itself must not report every read as an escape, which is what a flat prefix
  // test would do.
  const zeusIsProject = under(roots.projectRoot, roots.zeusRoot)
    || under(roots.zeusRoot, roots.projectRoot);
  if (!zeusIsProject && under(resolved, roots.zeusRoot)) {
    return { kind: 'ZEUS_INSTALL', path: raw, resolved };
  }

  if (under(resolved, roots.projectRoot)) return null;
  if (SYSTEM_PREFIXES.some((p) => resolved.startsWith(p))) return null;
  return { kind: 'OUTSIDE_PROJECT', path: raw, resolved };
}

/* -- the verdict ----------------------------------------------------------- */

/**
 * Three states, for the same reason the write check has three.
 *
 * `READ_SCOPE_UNKNOWN` is not a polite way of saying "nothing found". It is the
 * recorded fact that Zeus could not read the transcript, and it must never be
 * summarised as in scope: an unreadable transcript and a well-behaved agent are
 * different facts, and only one of them is evidence.
 */
export type ReadScopeVerdict =
  | { state: 'VERIFIED_IN_SCOPE'; ms: number; toolCalls: number }
  | { state: 'ROLE_READ_ESCAPE'; ms: number; toolCalls: number;
    reaches: ReadReach[]; payload: Record<string, unknown> }
  | { state: 'READ_SCOPE_UNKNOWN'; ms: number; detail: string };

/** How many reaches ride in the event. The counts are complete; the list is not. */
const MAX_REACHES = 40;
const MAX_VIA = 300;

export function checkReadScope(raw: string, roots: ScopeRoots,
  meta: { stage: string; traceCallId: string; provider?: string | null }):
  ReadScopeVerdict {
  const began = Date.now();
  const { recognised, calls } = toolCallsIn(raw ?? '');
  if (!recognised) {
    return {
      state: 'READ_SCOPE_UNKNOWN',
      ms: Date.now() - began,
      detail: (raw ?? '').trim()
        ? 'the provider transcript is not in a form Zeus can enumerate tool calls '
          + 'from, so where this stage looked is UNKNOWN, not confirmed in scope'
        : 'the provider returned no transcript, so where this stage looked is '
          + 'UNKNOWN, not confirmed in scope',
    };
  }

  const reaches: ReadReach[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    for (const token of pathsIn(call.text)) {
      const hit = classifyPath(token, roots);
      if (!hit) continue;
      if (seen.has(hit.resolved)) continue;
      seen.add(hit.resolved);
      reaches.push({ ...hit, tool: call.tool, via: call.text.slice(0, MAX_VIA) });
    }
  }

  if (!reaches.length) {
    return { state: 'VERIFIED_IN_SCOPE', ms: Date.now() - began, toolCalls: calls.length };
  }

  const byKind: Record<string, number> = {};
  for (const r of reaches) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  return {
    state: 'ROLE_READ_ESCAPE',
    ms: Date.now() - began,
    toolCalls: calls.length,
    reaches,
    payload: {
      reasonCode: 'ROLE_READ_ESCAPE',
      stage: meta.stage,
      provider: meta.provider ?? null,
      traceCallId: meta.traceCallId,
      projectRoot: roots.projectRoot,
      toolCalls: calls.length,
      reachCount: reaches.length,
      byKind,
      reaches: reaches.slice(0, MAX_REACHES),
      truncated: reaches.length > MAX_REACHES,
      // Said in the record, because the record is what someone reads later.
      detail: 'this stage read outside the repository it was given; V1 RECORDS '
        + 'this and does not stop the stage, so the answer it gave was formed '
        + 'with whatever it found there',
      ...(byKind.MISSION_STATE ? {
        independenceRisk: "MISSION_STATE reads reach Zeus's own event log, which "
          + 'holds previous critiques and previous verdicts for this mission and '
          + 'for others. That is the material the review context policy refuses '
          + 'to deliver, and an agent that read it is no longer the independent '
          + 'second opinion its answer is being counted as: the independence is '
          + 'gone whether or not the answer changed.',
      } : {}),
    },
  };
}

/** The compact form that rides on MODEL_CALL_FINISHED beside `writeCheck`. */
export function readScopeSummary(v: ReadScopeVerdict): Record<string, unknown> {
  if (v.state === 'READ_SCOPE_UNKNOWN') {
    return { state: v.state, inspected: false, inScope: null, ms: v.ms, detail: v.detail };
  }
  if (v.state === 'VERIFIED_IN_SCOPE') {
    return { state: v.state, inspected: true, inScope: true, ms: v.ms,
      toolCalls: v.toolCalls, reachCount: 0 };
  }
  const byKind: Record<string, number> = {};
  for (const r of v.reaches) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { state: v.state, inspected: true, inScope: false, ms: v.ms,
    toolCalls: v.toolCalls, reachCount: v.reaches.length, byKind,
    sample: v.reaches.slice(0, 8).map((r) => `${r.kind} ${r.resolved}`) };
}

/**
 * V1 NEVER BLOCKS ON A READ.
 *
 * Written as a function rather than left implicit, so that the day someone
 * decides reads should gate there is one place to change and one test to flip,
 * and so that nobody reading `checkReadScope` has to guess whether its verdict
 * is load-bearing. It is not. It is evidence.
 */
export function blocksInV1(_v: ReadScopeVerdict): boolean {
  return false;
}
