/**
 * How much of a model call is kept, and for how long.
 *
 * Three levels, and the difference between them is CONTENT, never structure.
 * Every level records the same skeleton — who was asked, what was asked of
 * them, which model answered, how it went — because that skeleton is the audit
 * trail and it has to survive whatever the content policy says. What changes is
 * whether the words themselves are kept beside it.
 *
 * Content lives in blobs, not in the event log. The log is hash-chained and
 * read in full on every derivation; a 376KB provider reply inline would make
 * every read of every mission slower for data almost nobody opens. Blobs are
 * content-addressed, so two calls that were given the identical criteria store
 * them once — safe precisely BECAUSE they are immutable: a later edit writes a
 * new hash rather than altering what a historical call received.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { redactPayload } from './engine/redact';

export const TRACE_LEVELS = ['normal', 'audit', 'debug'] as const;
export type TraceLevel = typeof TRACE_LEVELS[number];

export function isTraceLevel(v: unknown): v is TraceLevel {
  return typeof v === 'string' && (TRACE_LEVELS as readonly string[]).includes(v);
}

export type TraceSource = 'mission' | 'project' | 'global' | 'zeus-default';

export interface EffectiveTrace {
  level: TraceLevel;
  source: TraceSource;
}

/**
 * Mission over project over global over the shipped default.
 *
 * The source travels with the level everywhere it is shown, because "Debug"
 * and "Debug, because this mission was switched to it an hour ago" are
 * different things to an operator deciding whether to switch it back.
 */
export function resolveTraceLevel(input: {
  mission?: TraceLevel | null;
  project?: TraceLevel | null;
  global?: TraceLevel | null;
}): EffectiveTrace {
  if (isTraceLevel(input.mission)) return { level: input.mission, source: 'mission' };
  if (isTraceLevel(input.project)) return { level: input.project, source: 'project' };
  if (isTraceLevel(input.global)) return { level: input.global, source: 'global' };
  // Normal in production, always. Debug must never arrive by inheritance.
  return { level: 'normal', source: 'zeus-default' };
}

/** What each level keeps, stated once so no caller has to remember it. */
export function retains(level: TraceLevel): {
  prompt: boolean; response: boolean; redacted: boolean; defaultTtlHours: number | null;
} {
  switch (level) {
    case 'debug':
      return { prompt: true, response: true, redacted: false, defaultTtlHours: 72 };
    case 'audit':
      return { prompt: true, response: true, redacted: true, defaultTtlHours: 30 * 24 };
    default:
      return { prompt: false, response: false, redacted: true, defaultTtlHours: null };
  }
}

export const DEBUG_WARNING =
  'Debug traces may contain source code, secrets, credentials, personal data, '
  + 'prompts and raw model responses. They are stored unredacted and expire in 72 hours.';

/* ------------------------------------------------------------------------ *
 * The blob store
 * ------------------------------------------------------------------------ */

export interface BlobRef {
  hash: string;
  bytes: number;
  storedBytes: number;
  /** True when the content was cut to fit the cap; never silent. */
  truncated: boolean;
  redacted: boolean;
  expiresAt: string | null;
}

/** A single blob larger than this is cut, and says so. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

export class TraceStore {
  readonly root: string;

  constructor(stateRoot: string) {
    this.root = path.join(stateRoot, 'trace', 'blobs');
  }

  private pathFor(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), `${hash}.gz`);
  }

  /**
   * Stores content and returns a reference, or null when the level keeps none.
   *
   * REDACTION HAPPENS HERE, before the bytes reach disk — not in a viewer.
   * A redacting UI over a raw store is not redaction; it is a filter in front
   * of a leak. Audit is written already-redacted, and the flag on the ref says
   * which it is so nobody has to infer it from the level later.
   */
  put(content: string, level: TraceLevel, ttlHours?: number | null): BlobRef | null {
    const policy = retains(level);
    if (!policy.prompt && !policy.response) return null;

    let text = content;
    let redacted = false;
    if (policy.redacted) {
      const r = redactPayload({ t: text }) as { payload: { t: string }; redactions: number };
      text = r.payload.t;
      redacted = true;
    }

    const originalBytes = Buffer.byteLength(text);
    let truncated = false;
    if (originalBytes > MAX_BLOB_BYTES) {
      text = `${text.slice(0, MAX_BLOB_BYTES)}\n[truncated by Zeus: `
        + `${originalBytes} bytes stored as ${MAX_BLOB_BYTES}]`;
      truncated = true;
    }

    const hash = createHash('sha256').update(text).digest('hex');
    const file = this.pathFor(hash);
    const packed = zlib.gzipSync(Buffer.from(text, 'utf8'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Content-addressed: an identical body is already there and identical.
    if (!fs.existsSync(file)) fs.writeFileSync(file, packed);

    const hours = ttlHours === undefined ? policy.defaultTtlHours : ttlHours;
    return {
      hash: `sha256:${hash}`,
      bytes: originalBytes,
      storedBytes: packed.length,
      truncated,
      redacted,
      expiresAt: hours === null ? null
        : new Date(Date.now() + hours * 3600_000).toISOString(),
    };
  }

  /** The content, or null when it expired or was never kept. */
  get(ref: BlobRef | null | undefined): string | null {
    if (!ref) return null;
    const hash = ref.hash.replace(/^sha256:/, '');
    try { return zlib.gunzipSync(fs.readFileSync(this.pathFor(hash))).toString('utf8'); }
    catch { return null; }
  }

  /**
   * Deletes what has expired, and REALLY deletes it.
   *
   * Hiding expired content from a viewer while the bytes stay on disk is the
   * same defect as redacting in the viewer: the promise made to the operator
   * was that it would be gone. Structural metadata lives in the event log and
   * is untouched, so the audit trail survives its content expiring.
   */
  sweep(now = Date.now()): { removed: number; freedBytes: number } {
    let removed = 0; let freedBytes = 0;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs + this.ttlWindowMs < now) {
            freedBytes += st.size;
            fs.unlinkSync(p);
            removed += 1;
          }
        } catch { /* a file that vanished under us is already gone */ }
      }
    };
    walk(this.root);
    return { removed, freedBytes };
  }

  /**
   * How long an unreferenced blob may sit before a sweep takes it.
   *
   * Deliberately the DEBUG window: a blob written under audit is referenced by
   * an event that records its own expiresAt, and the sweep is the backstop for
   * anything whose reference was lost.
   */
  ttlWindowMs = 72 * 3600_000;
}
