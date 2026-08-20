/**
 * The redacting sink.
 *
 * Zeus strips credentials on the way INTO a project command and then wrote
 * whatever came back out into an append-only, hash-chained log. A test that
 * echoes a token, a failing assertion printing a connection string, a debug
 * logger — any of them made the secret permanent, because redacting later
 * would break the chain.
 *
 * That was fixed once, at the call site that recorded command output. Then a
 * new event path was added months later, recorded a command line verbatim, and
 * reopened the same hole — green suite, both commit gates held, and the leak
 * reached a public remote. The defect was never "someone forgot a call". It
 * was that forgetting was possible: redaction lived at each producer, so the
 * safe behaviour was opt-in and the number of places that had to opt in grew
 * with every event type.
 *
 * So redaction lives at the boundary instead. `EventStore.append()` is the one
 * place through which every event reaches disk — the engine's own `record()`,
 * the CLI's direct appends, the audit harness, anything added later — and the
 * payload is redacted there, before the event is hashed. An event type
 * invented six months from now is redacted by default, by an author who never
 * read this file.
 *
 * This is a net, not a guarantee: it catches recognisable shapes. Anything it
 * misses is still a reason to keep project output out of evidence bundles.
 */

/** Secret-shaped substrings, removed before anything is written to the log. */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, '[redacted:credentialed-url]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL))\s*[=:]\s*\S+/g, '$1=[redacted]'],
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const [re, replacement] of SECRET_SHAPES) {
    out = out.replace(re, (...args) => {
      redactions += 1;
      return replacement.includes('$1') ? replacement.replace('$1', String(args[1])) : replacement;
    });
  }
  return { text: out, redactions };
}

/** Deep enough for any event payload; a guard against a pathological structure. */
const MAX_DEPTH = 24;

/**
 * Redacts every string anywhere in an event payload.
 *
 * Whole-payload rather than per-field: the leak that motivated this was a
 * field nobody thought of as output — a command line — and the next one will
 * be a field nobody has invented yet. Values are walked, keys are not: a key
 * is a name the author chose, not text that came back from a project.
 *
 * Returns a NEW structure. Mutating the caller's payload would edit an
 * object the producer may still be using, and a redaction that changes what
 * the engine sees is a different bug from the one this prevents.
 */
export function redactPayload(payload: unknown): { payload: unknown; redactions: number } {
  let redactions = 0;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      redactions += r.redactions;
      return r.text;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return v;
    if (seen.has(v as object)) return v;      // a cycle: leave it to JSON.stringify to reject
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
    return out;
  };

  return { payload: walk(payload, 0), redactions };
}
