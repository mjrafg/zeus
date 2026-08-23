/**
 * Unwrapping a vendor CLI's stream.
 *
 * Found by the first real-provider contact, and it was a transport bug wearing
 * a semantics bug's clothes. Both CLIs emit newline-delimited JSON EVENTS, and
 * the model's text lives inside a string field of one of them. `parseStructured`
 * brace-matches raw text and correctly skips braces inside strings — so the
 * payload object was invisible, and the last parseable object was a stream
 * wrapper with no `criteria` in it. Zeus then said, accurately and uselessly,
 * "compiler returned no parsable object".
 *
 * Measured shapes, captured with Zeus's own argv on this host:
 *
 *   claude  system:init, system:status, rate_limit_event, stream_event ×N
 *           (partial deltas), assistant, result:success. The final text is in
 *           `result.result` as a JSON STRING, and also in
 *           `assistant.message.content[].text`.
 *
 *   codex   thread.started, turn.started, item.completed (item.type
 *           "agent_message", text in `item.text`), turn.completed (usage).
 *
 * `parseStructured` is untouched: it is correct for plain text, and the bug was
 * feeding it wrapped text.
 */

export interface ProviderUsage {
  /** Provider-reported cost. Never computed here — Zeus invents no pricing. */
  totalCostUsd?: number;
  usage?: Record<string, unknown>;
  durationApiMs?: number;
  ttftMs?: number;
  numTurns?: number;
  permissionDenials?: unknown[];
}

export interface RateLimitNote {
  status: string;
  rateLimitType?: string;
  /** Unix seconds, as the CLI reports it. */
  resetsAt?: number;
  resetsAtIso?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  /**
   * True when the account is limited in some way — either the window is not
   * `allowed`, or overage is rejected. "Quota exhausted until 09:00" is a
   * different human action from "the provider is broken", and the two used to
   * be the same sentence.
   */
  constrained: boolean;
}

export type UnwrapSource =
  | 'result-event' | 'assistant-events' | 'agent-message-items' | 'plain-text';

export interface StreamExtraction {
  /** The model's final text, unwrapped. */
  text: string;
  source: UnwrapSource;
  /** NDJSON events successfully parsed. */
  events: number;
  /**
   * Lines that were not JSON. Expected and harmless: the supervisor merges
   * stderr into the captured output, and the CLIs write human warnings there.
   */
  nonJsonLines: number;
  usage: ProviderUsage | null;
  rateLimit: RateLimitNote | null;
  /**
   * The CLI's own terminal event, kept separately so the provider-error check
   * still reads the wrapper's `is_error`/`subtype`/`permission_denials` rather
   * than the model's payload, which knows nothing about them.
   */
  controlEvent: Record<string, unknown> | null;
  /** What the provider says about ITSELF: model, session, tools, timing. */
  identity: ProviderIdentity | null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parseLines(raw: string): { events: Record<string, unknown>[]; nonJsonLines: number } {
  const events: Record<string, unknown>[] = [];
  let nonJsonLines = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t[0] !== '{') { nonJsonLines += 1; continue; }
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) events.push(o as Record<string, unknown>);
      else nonJsonLines += 1;
    } catch { nonJsonLines += 1; }
  }
  return { events, nonJsonLines };
}

function rateLimitOf(events: Record<string, unknown>[]): RateLimitNote | null {
  const e = [...events].reverse().find((x) => x.type === 'rate_limit_event');
  const info = (e?.rate_limit_info ?? null) as Record<string, unknown> | null;
  if (!info) return null;
  const status = typeof info.status === 'string' ? info.status : 'unknown';
  const overageStatus = typeof info.overageStatus === 'string' ? info.overageStatus : undefined;
  const resetsAt = num(info.resetsAt);
  return {
    status,
    rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
    resetsAt,
    resetsAtIso: resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined,
    overageStatus,
    overageDisabledReason: typeof info.overageDisabledReason === 'string'
      ? info.overageDisabledReason : undefined,
    constrained: status !== 'allowed' || overageStatus === 'rejected',
  };
}

/**
 * What the provider says about ITSELF — the model that answered, the session it
 * ran in, the tools it had, and how long the parts took.
 *
 * All of this was already arriving on every call and being dropped at the door.
 * `unwrapProviderStream` read four things out of the stream: the text, the
 * result event, the rate-limit event and codex agent messages. So a mission
 * could not say which model wrote its plan, even though the answer was sitting
 * in the first line of the stream it had just parsed.
 *
 * Kept SEPARATE from what Zeus configured. If Zeus asked for one model and a
 * provider alias, router or fallback resolved it to another, that discrepancy
 * is the interesting fact and collapsing the two fields would erase it.
 */
export interface ProviderIdentity {
  /** The model the provider reports actually handled the call. */
  model?: string;
  /** Per-model usage, when the provider breaks it down that way. */
  modelUsage?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  clientVersion?: string;
  permissionMode?: string;
  /** Tool names the provider made available for this call. */
  toolsAvailable?: string[];
  /** Tools the model actually invoked, in order. */
  toolsUsed?: string[];
  ttftMs?: number;
  ttftStreamMs?: number;
  timeToRequestMs?: number;
  durationMs?: number;
  durationApiMs?: number;
  stopReason?: string;
}

function firstString(events: Record<string, unknown>[], key: string): string | undefined {
  for (const e of events) {
    const v = e[key];
    if (typeof v === 'string' && v) return v;
    const m = e.message as Record<string, unknown> | undefined;
    if (m && typeof m === 'object' && typeof m[key] === 'string' && m[key]) {
      return m[key] as string;
    }
  }
  return undefined;
}

export function identityOf(events: Record<string, unknown>[]): ProviderIdentity | null {
  const out: ProviderIdentity = {};
  const result = [...events].reverse().find((e) => e.type === 'result') ?? null;
  const system = events.find((e) => e.type === 'system') ?? null;

  // The model can be reported on the result, on the init event, or inside an
  // assistant message. Any of the three is the provider's own word for it.
  const model = firstString(events, 'model');
  if (model) out.model = model;
  if (result && result.modelUsage && typeof result.modelUsage === 'object') {
    out.modelUsage = result.modelUsage as Record<string, unknown>;
  }
  const sid = firstString(events, 'session_id'); if (sid) out.sessionId = sid;
  const rid = firstString(events, 'request_id'); if (rid) out.requestId = rid;
  const ver = firstString(events, 'claude_code_version'); if (ver) out.clientVersion = ver;
  const pm = firstString(events, 'permissionMode'); if (pm) out.permissionMode = pm;
  const stop = firstString(events, 'stop_reason'); if (stop) out.stopReason = stop;

  if (system && Array.isArray(system.tools)) {
    out.toolsAvailable = (system.tools as unknown[]).map(String);
  }

  // Tool CALLS, distinct from tools merely offered. This is the difference
  // between "the model said it checked something" and "a check ran".
  const used: string[] = [];
  for (const e of events) {
    const m = e.message as Record<string, unknown> | undefined;
    const content = (m?.content ?? e.content) as unknown[] | undefined;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const part = c as Record<string, unknown>;
      if (part?.type === 'tool_use' && typeof part.name === 'string') used.push(part.name);
    }
  }
  if (used.length) out.toolsUsed = used;

  const r = result ?? {};
  for (const [k, key] of [['ttftMs', 'ttft_ms'], ['ttftStreamMs', 'ttft_stream_ms'],
    ['timeToRequestMs', 'time_to_request_ms'], ['durationMs', 'duration_ms'],
    ['durationApiMs', 'duration_api_ms']] as const) {
    const v = num(r[key]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function usageFromResult(r: Record<string, unknown> | null): ProviderUsage | null {
  if (!r) return null;
  const out: ProviderUsage = {};
  // Absent stays absent. A zero would be a claim, and an invented one.
  if (num(r.total_cost_usd) !== undefined) out.totalCostUsd = num(r.total_cost_usd);
  if (r.usage && typeof r.usage === 'object') out.usage = r.usage as Record<string, unknown>;
  if (num(r.duration_api_ms) !== undefined) out.durationApiMs = num(r.duration_api_ms);
  if (num(r.ttft_ms) !== undefined) out.ttftMs = num(r.ttft_ms);
  if (num(r.num_turns) !== undefined) out.numTurns = num(r.num_turns);
  if (Array.isArray(r.permission_denials)) out.permissionDenials = r.permission_denials;
  return Object.keys(out).length ? out : null;
}

/** claude: text from the result event, else the assistant events. */
function extractClaude(events: Record<string, unknown>[]): { text: string; source: UnwrapSource } | null {
  const result = [...events].reverse().find((e) => e.type === 'result');
  if (result && typeof result.result === 'string' && result.result.trim()) {
    // The CLI's own summary of the final text. Preferred because it is what
    // the CLI itself considers the answer, deltas already reconciled.
    return { text: result.result, source: 'result-event' };
  }
  const chunks: string[] = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = (e.message as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.length ? { text: chunks.join(''), source: 'assistant-events' } : null;
}

/** codex: text from the completed agent_message items. */
function extractCodex(events: Record<string, unknown>[]): { text: string; source: UnwrapSource } | null {
  const chunks: string[] = [];
  for (const e of events) {
    if (e.type !== 'item.completed') continue;
    const item = e.item as any;
    if (item && item.type === 'agent_message' && typeof item.text === 'string') chunks.push(item.text);
  }
  return chunks.length ? { text: chunks.join('\n'), source: 'agent-message-items' } : null;
}

/**
 * Extracts the model's text from a vendor stream.
 *
 * Falls back to the raw output when no events parsed at all, so a future CLI
 * format change degrades to the previous behaviour rather than to a crash.
 *
 * Note on the fallback rule: it keys on "no events parsed", NOT on "a non-JSON
 * line appeared". The supervisor merges stderr into the captured output and
 * the claude CLI writes a stdin warning there, so a stream containing one
 * human-readable line is the NORMAL case on this host — treating that as a
 * format change would have defeated the fix in exactly the situation that
 * motivated it.
 */
export function unwrapProviderStream(providerId: string, raw: string): StreamExtraction {
  const { events, nonJsonLines } = parseLines(raw);
  const rateLimit = rateLimitOf(events);
  const identity = identityOf(events);
  const control = [...events].reverse().find((e) => e.type === 'result' || e.type === 'turn.completed')
    ?? null;
  const usage = providerId === 'codex'
    ? (control && control.usage && typeof control.usage === 'object'
      ? { usage: control.usage as Record<string, unknown> } : null)
    : usageFromResult(control);

  if (!events.length) {
    return { text: raw, source: 'plain-text', events: 0, nonJsonLines, usage: null,
      rateLimit: null, controlEvent: null, identity: null };
  }
  const extracted = providerId === 'codex' ? extractCodex(events) : extractClaude(events);
  if (!extracted) {
    return { text: raw, source: 'plain-text', events: events.length, nonJsonLines, usage,
      rateLimit, controlEvent: control, identity };
  }
  return { text: extracted.text, source: extracted.source, events: events.length, nonJsonLines,
    usage, rateLimit, controlEvent: control, identity };
}
