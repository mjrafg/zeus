/**
 * Vendor stream unwrapping.
 *
 * The fixtures are REAL captures, taken with Zeus's own argv, with every
 * session id, uuid, message id, request id and home path synthesized — the
 * boundary checks are right to refuse the real values, and a hand-written
 * imitation would only prove that the imitation matches the parser.
 */
import * as fs from 'fs';
import * as path from 'path';
import { check, section } from './harness';
import { parseStructured } from '../src/engine/providers';
import { unwrapProviderStream } from '../src/engine/unwrap';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const claudeStream = fs.readFileSync(path.join(FIXTURES, 'claude-stream.ndjson'), 'utf8');
const codexStream = fs.readFileSync(path.join(FIXTURES, 'codex-stream.ndjson'), 'utf8');

export function unwrapSuite(): void {
  // ---------------------------------------------------------------------
  section('provider streams: the bug, and the fix, against a real capture');
  {
    // The bug, reproduced. parseStructured is correct — it skips braces inside
    // strings — so the payload is invisible and the last parseable object is a
    // stream wrapper.
    const beforeFix = parseStructured(claudeStream);
    check('UW1: the raw stream parses to a WRAPPER, which is the whole bug',
      !!beforeFix && !('criteria' in (beforeFix as any)) && 'total_cost_usd' in (beforeFix as any),
      Object.keys(beforeFix ?? {}).slice(0, 4).join(','));

    const unwrapped = unwrapProviderStream('claude', claudeStream);
    check('UW2: unwrapping prefers the CLI\'s own final result event',
      unwrapped.source === 'result-event' && unwrapped.events === 15,
      `${unwrapped.source}, ${unwrapped.events} events`);
    const parsed = parseStructured(unwrapped.text);
    check('UW3: and the embedded payload is then visible',
      !!parsed && Array.isArray((parsed as any).criteria)
      && (parsed as any).criteria[0].id === 'C-1',
      JSON.stringify(parsed));
    check('UW4: parseStructured itself was not the problem and is unchanged',
      JSON.stringify(parseStructured('{"criteria":[{"id":"C-1","ok":true}]}'))
        === JSON.stringify(parsed));
  }

  // ---------------------------------------------------------------------
  section('provider streams: extraction order and fallbacks');
  {
    // Partial deltas plus a final result: the result wins, not a partial.
    const withDeltas = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"criteria":[' } } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"partial":true}' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '{"criteria":[{"id":"FINAL"}]}' }),
    ].join('\n');
    const r = unwrapProviderStream('claude', withDeltas);
    check('UW5: with deltas AND a result event, the result event wins',
      r.source === 'result-event'
      && (parseStructured(r.text) as any).criteria[0].id === 'FINAL', r.text);

    // Assistant events but no result event: fallback 2.
    const noResult = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"criteria":' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '[{"id":"JOINED"}]}' }] } }),
    ].join('\n');
    const j = unwrapProviderStream('claude', noResult);
    check('UW6: with no result event, assistant text is concatenated in order',
      j.source === 'assistant-events'
      && (parseStructured(j.text) as any).criteria[0].id === 'JOINED', j.text);

    // Plain output — the fake provider's shape — must still work.
    const plain = '{"criteria":[{"id":"PLAIN"}]}';
    const p = unwrapProviderStream('claude', plain);
    // It parses as one JSON object, so it counts as an event — it simply is
    // not a stream event and yields no text, which is what sends it down the
    // plain-text path with the output intact.
    check('UW7: plain non-stream output is passed through untouched',
      p.source === 'plain-text' && p.text === plain
      && (parseStructured(p.text) as any).criteria[0].id === 'PLAIN',
      `${p.source}, ${p.events} event(s)`);

    // Garbage and truncation degrade to plain text, never to a crash.
    const truncated = claudeStream.slice(0, 900);
    const t = unwrapProviderStream('claude', truncated);
    check('UW8: a truncated stream does not throw, and yields no payload',
      parseStructured(t.text) === null || !('criteria' in (parseStructured(t.text) as any)),
      `${t.source}, ${t.events} events`);
    check('UW9: total garbage falls back to plain text',
      unwrapProviderStream('claude', 'not json at all\nnor this').source === 'plain-text');
    check('UW10: an unknown event type is skipped, not fatal',
      unwrapProviderStream('claude', [
        JSON.stringify({ type: 'some_future_event', payload: { x: 1 } }),
        JSON.stringify({ type: 'result', result: '{"ok":true}' }),
      ].join('\n')).source === 'result-event');

    // The rule keys on "no events parsed", not "a non-JSON line appeared":
    // the supervisor merges stderr in, and the CLI writes a warning there.
    const withStderr = `Warning: no stdin data received in 3s, proceeding without it.\n${claudeStream}`;
    const w = unwrapProviderStream('claude', withStderr);
    check('UW11: a human warning merged from stderr does not defeat the unwrapper',
      w.source === 'result-event' && w.nonJsonLines === 1
      && Array.isArray((parseStructured(w.text) as any).criteria),
      `${w.source}, ${w.nonJsonLines} non-JSON line(s)`);
  }

  // ---------------------------------------------------------------------
  section('provider streams: codex has the same bug in a different shape');
  {
    const before = parseStructured(codexStream);
    check('UW20: codex raw also parses to a wrapper, not the payload',
      !!before && !('criteria' in (before as any)) && 'usage' in (before as any),
      Object.keys(before ?? {}).join(','));
    const u = unwrapProviderStream('codex', codexStream);
    check('UW21: codex text comes from its completed agent_message items',
      u.source === 'agent-message-items' && u.events === 4, `${u.source}, ${u.events}`);
    check('UW22: and the payload round-trips',
      (parseStructured(u.text) as any).criteria[0].id === 'C-1', u.text);
    check('UW23: codex usage is carried, and it reports no cost field',
      !!u.usage && !!u.usage.usage && u.usage.totalCostUsd === undefined,
      JSON.stringify(u.usage));
  }

  // ---------------------------------------------------------------------
  section('provider streams: provider-reported cost, never invented');
  {
    const u = unwrapProviderStream('claude', claudeStream);
    check('UW30: cost and usage come from the provider\'s own result event',
      !!u.usage && typeof u.usage.totalCostUsd === 'number' && u.usage.totalCostUsd > 0
      && !!u.usage.usage && typeof (u.usage.usage as any).input_tokens === 'number',
      JSON.stringify({ cost: u.usage?.totalCostUsd, turns: u.usage?.numTurns }));
    check('UW31: timing fields are carried when present',
      typeof u.usage?.durationApiMs === 'number' && typeof u.usage?.ttftMs === 'number');
    // Absent stays absent. A zero would be a claim, and an invented one.
    const noUsage = unwrapProviderStream('claude',
      JSON.stringify({ type: 'result', result: '{"ok":true}' }));
    check('UW32: a stream without cost fields yields NO usage, not zeros',
      noUsage.usage === null, JSON.stringify(noUsage.usage));
    // Look for pricing ARITHMETIC rather than the word "rate", which appears
    // legitimately in rateLimitType and matched the first version of this.
    const unwrapSrc = fs.readFileSync(path.resolve(__dirname, '../src/engine/unwrap.ts'), 'utf8');
    check('UW33: nothing here computes a price — only provider numbers are carried',
      !/(tokens?|input|output)\s*[*/]\s*[\d.]/i.test(unwrapSrc)
      && !/per[_ ]?token|pricePer|costPer|USD_PER/i.test(unwrapSrc)
      && /total_cost_usd/.test(unwrapSrc));
  }

  // ---------------------------------------------------------------------
  section('provider streams: quota is a different sentence from "broken"');
  {
    const u = unwrapProviderStream('claude', claudeStream);
    check('UW40: the real capture carries a rate_limit_event',
      !!u.rateLimit && u.rateLimit.status === 'allowed', JSON.stringify(u.rateLimit));
    check('UW41: overage rejection is surfaced as a constraint, with resetsAt',
      u.rateLimit!.overageStatus === 'rejected'
      && u.rateLimit!.overageDisabledReason === 'out_of_credits'
      && u.rateLimit!.constrained === true
      && typeof u.rateLimit!.resetsAtIso === 'string'
      && /\dT\d/.test(u.rateLimit!.resetsAtIso!),
      `${u.rateLimit!.overageDisabledReason}, resets ${u.rateLimit!.resetsAtIso}`);
    const blocked = unwrapProviderStream('claude', [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {
        status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1787260800 } }),
      JSON.stringify({ type: 'result', result: 'nope' }),
    ].join('\n'));
    check('UW42: a non-allowed status is constrained too',
      blocked.rateLimit!.status === 'rejected' && blocked.rateLimit!.constrained === true
      && blocked.rateLimit!.resetsAtIso === new Date(1787260800 * 1000).toISOString(),
      blocked.rateLimit!.resetsAtIso);
    check('UW43: a stream with no rate-limit event reports none, rather than guessing',
      unwrapProviderStream('claude',
        JSON.stringify({ type: 'result', result: 'x' })).rateLimit === null);
  }

  // ---------------------------------------------------------------------
  section('provider streams: what the provider says about itself');
  {
    // All of this was arriving on every call and being dropped at the door.
    // A mission could not say which model wrote its plan, though the answer
    // was in the first line of the stream it had just parsed.
    const claude = unwrapProviderStream('claude', claudeStream);
    const id = claude.identity!;
    check('UW60: the model that actually answered is read from the stream',
      typeof id.model === 'string' && id.model.length > 0, String(id.model));
    check('UW61: with the session and request it ran under',
      typeof id.sessionId === 'string' && typeof id.requestId === 'string',
      `${id.sessionId} / ${id.requestId}`);
    check('UW62: and the client version, so an old CLI is diagnosable',
      typeof id.clientVersion === 'string', String(id.clientVersion));
    check('UW63: timing is carried apart from usage — TTFT is not a token count',
      typeof id.ttftMs === 'number' && typeof id.durationApiMs === 'number',
      `ttft ${id.ttftMs}ms api ${id.durationApiMs}ms`);
    check('UW64: the tools the provider OFFERED are listed',
      Array.isArray(id.toolsAvailable) && id.toolsAvailable!.length > 0,
      `${id.toolsAvailable?.length} tool(s)`);
    check('UW65: tools USED is separate from tools offered — said is not did',
      id.toolsUsed === undefined || Array.isArray(id.toolsUsed),
      JSON.stringify(id.toolsUsed ?? 'none used in this capture'));

    // Codex reports no model in its stream. That absence must stay an absence.
    const codex = unwrapProviderStream('codex', codexStream);
    check('UW66: a provider that reports no model yields no model, not a guess',
      !codex.identity || codex.identity.model === undefined,
      JSON.stringify(codex.identity ?? null));

    check('UW67: a stream with nothing to say about itself reports null',
      unwrapProviderStream('claude', 'not json at all').identity === null,
      'null, not an empty object');

    const orch = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'orchestrator.ts'), 'utf8');
    check('UW68: configured and actual are recorded as SEPARATE fields',
      /configuredModel: route\.model/.test(orch) && /identity: res\.identity/.test(orch),
      'never one ambiguous field');
    check('UW69: and a mismatch between them is recorded as a discrepancy',
      /modelDiscrepancy: \{ configured: route\.model, actual: res\.identity\.model \}/.test(orch),
      'a fallback cannot look like the configured model succeeded');
  }

  section('provider streams: the fixture is a real capture, safely synthesized');
  {
    check('UW50: the fixture carries no real home path',
      !/\/home\/(?!fixture-user)/.test(claudeStream) && !/\/home\/(?!fixture-user)/.test(codexStream));
    const realish = claudeStream.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    check('UW51: every uuid in the fixture is synthetic',
      realish.every((u) => u.startsWith('00000000-0000-4000-8000-')),
      realish.filter((u) => !u.startsWith('00000000-')).slice(0, 2).join(','));
    check('UW52: and it is still a real capture — the wrapper shape is intact',
      /"type":"stream_event"/.test(claudeStream) && /"type":"rate_limit_event"/.test(claudeStream)
      && /"subtype":"success"/.test(claudeStream) && /"cache_read_input_tokens"/.test(claudeStream));
  }
}
