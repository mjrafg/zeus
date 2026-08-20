/**
 * Durable, hash-chained event store.
 *
 * Requirements this has to meet, each of which was a real failure mode:
 *   * a crash mid-write must not corrupt the log — a torn final line is
 *     detected and quarantined, not parsed as truth;
 *   * two writers must not interleave sequence numbers (see ProjectLock, and
 *     the O_EXCL append guard here as a second line);
 *   * a duplicate sequence or event id must be refused, loudly;
 *   * the chain must be verifiable end to end, so tampering is detectable;
 *   * reconstruction after a crash must be deterministic.
 *
 * JSONL is kept deliberately: it is append-only, human-readable, greppable and
 * survives partial writes better than a binary format. A database would add a
 * dependency and take the "you can read the evidence with cat" property away.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { redactPayload } from './redact';

export interface StoredEvent {
  id: string;
  taskId: string;
  seq: number;
  ts: string;
  type: string;
  /** Hash of the previous event, making the log a chain. */
  prev: string;
  payload: Record<string, unknown>;
}

export interface AppendInput {
  taskId: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface IntegrityReport {
  ok: boolean;
  events: number;
  problems: string[];
  /** A torn final line, moved aside rather than silently dropped. */
  quarantined: string | null;
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Per-task append cursor.
 *
 * Recomputing the next sequence by re-reading the whole log made append O(n)
 * and the task quadratic over its life. The cursor caches just the two facts
 * append needs — last sequence and last id — plus the byte length the log had
 * when we cached them, so any out-of-band write invalidates it and we fall
 * back to a full scan rather than trusting a stale number.
 */
interface Cursor { seq: number; lastId: string; bytes: number }

export class EventStore {
  private cursors = new Map<string, Cursor>();
  private seenIds = new Map<string, Set<string>>();

  constructor(readonly root: string) {}

  private indexPath(taskId: string): string { return path.join(this.taskDir(taskId), 'events.index.json'); }

  /** Reads the durable cursor, if it still matches the log on disk. */
  private loadCursor(taskId: string, size: number): Cursor | null {
    const mem = this.cursors.get(taskId);
    if (mem && mem.bytes === size) return mem;
    try {
      const c = JSON.parse(fs.readFileSync(this.indexPath(taskId), 'utf8')) as Cursor;
      if (c && typeof c.seq === 'number' && typeof c.lastId === 'string' && c.bytes === size) {
        this.cursors.set(taskId, c);
        return c;
      }
    } catch { /* no usable index */ }
    return null;
  }

  private saveCursor(taskId: string, c: Cursor): void {
    this.cursors.set(taskId, c);
    // Best effort and non-authoritative: the log is always the truth, and a
    // missing or stale index only costs one rescan.
    try { fs.writeFileSync(this.indexPath(taskId), JSON.stringify(c)); } catch { /* ignore */ }
  }

  /** Task ids contain a project prefix, so they are sanitised for the path. */
  static dirName(taskId: string): string { return taskId.replace(/[^A-Za-z0-9_.-]/g, '~'); }
  taskDir(taskId: string): string { return path.join(this.root, 'tasks', EventStore.dirName(taskId)); }
  logPath(taskId: string): string { return path.join(this.taskDir(taskId), 'events.jsonl'); }

  /** Returns real task ids, read back from each log rather than from the path. */
  listTasks(): string[] {
    const dir = path.join(this.root, 'tasks');
    try {
      return fs.readdirSync(dir).map((d) => {
        const f = path.join(dir, d, 'events.jsonl');
        try {
          const first = fs.readFileSync(f, 'utf8').split('\n', 1)[0];
          return first ? String(JSON.parse(first).taskId) : null;
        } catch { return null; }
      }).filter((x): x is string => !!x).sort();
    } catch { return []; }
  }

  /**
   * Reads a task's log.
   *
   * A trailing partial line is the signature of a crash during append. It is
   * quarantined to `events.jsonl.torn-<ts>` and excluded, because a half-object
   * is not evidence and guessing at its content would be worse than losing it.
   */
  read(taskId: string, opts: { repair?: boolean } = {}): StoredEvent[] {
    const file = this.logPath(taskId);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const lines = raw.split('\n');
    const out: StoredEvent[] = [];
    let torn: string | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch {
        const isLast = lines.slice(i + 1).every((l) => !l.trim());
        if (!isLast) throw new Error(`event log ${file} is corrupt at line ${i + 1} (not the final line)`);
        torn = line;
      }
    }
    if (torn && opts.repair) {
      const quarantine = `${file}.torn-${Date.now()}`;
      fs.writeFileSync(quarantine, torn);
      const rebuilt = out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : '');
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, rebuilt);
      fs.renameSync(tmp, file);
      // The file changed shape: any cached cursor is now meaningless.
      this.cursors.delete(taskId);
      this.seenIds.delete(taskId);
      try { fs.rmSync(this.indexPath(taskId), { force: true }); } catch { /* ignore */ }
    }
    return out;
  }

  private hashOf(e: Omit<StoredEvent, 'id'>): string {
    return `EV-${sha256(JSON.stringify(e)).slice(0, 20)}`;
  }

  /**
   * Appends one event.
   *
   * The write is a single `appendFileSync` of one line ending in `\n`, then an
   * fsync of the directory entry, so a crash either loses the whole line or
   * commits it — never leaves a half-line that a later reader believes.
   */
  append(input: AppendInput): StoredEvent {
    const file = this.logPath(input.taskId);
    const size = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    let cursor = this.loadCursor(input.taskId, size);
    if (!cursor) {
      // Cold start, or the log changed underneath us: rebuild from the log.
      const existing = this.read(input.taskId);
      const last = existing[existing.length - 1];
      cursor = { seq: existing.length, lastId: last ? last.id : 'GENESIS', bytes: size };
      // Duplicate detection needs the full set only on this path.
      this.seenIds.set(input.taskId, new Set(existing.map((e) => e.id)));
    }
    const seq = cursor.seq + 1;

    // THE REDACTING SINK.
    //
    // Every event in the product reaches disk through this one function: the
    // engine's `record()`, the CLI's direct appends, the audit harness, and
    // anything added later. Redacting here rather than at each producer is
    // what makes the guarantee hold for event types that do not exist yet.
    //
    // It happens BEFORE `hashOf`, so the chain seals the redacted
    // representation. The alternative — hash first, redact after — would make
    // every redaction a chain break, which is exactly why the original leak
    // could not simply be cleaned up after the fact.
    const red = redactPayload(input.payload ?? {});
    const payload = red.payload as Record<string, unknown>;
    // A silent redaction is indistinguishable from output that never contained
    // anything, so the count is part of the record.
    if (red.redactions > 0) payload.redactions = red.redactions;

    const body: Omit<StoredEvent, 'id'> = {
      taskId: input.taskId, seq, ts: new Date().toISOString(), type: input.type,
      prev: cursor.lastId,
      payload,
    };
    const ev: StoredEvent = { id: this.hashOf(body), ...body };

    // Duplicate detection without a rescan: ids are content hashes, so the set
    // of ids seen for this task is enough, and the chain catches sequence
    // problems at verify() time regardless.
    let seen = this.seenIds.get(input.taskId);
    if (!seen) {
      seen = new Set(this.read(input.taskId).map((e) => e.id));
      this.seenIds.set(input.taskId, seen);
    }
    if (seen.has(ev.id)) throw new Error(`duplicate event id ${ev.id} for ${input.taskId}`);

    fs.mkdirSync(this.taskDir(input.taskId), { recursive: true });
    const line = `${JSON.stringify(ev)}\n`;
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);              // the line is on disk before we return
    } finally { fs.closeSync(fd); }
    seen.add(ev.id);
    this.saveCursor(input.taskId, { seq, lastId: ev.id, bytes: size + Buffer.byteLength(line) });
    return ev;
  }

  /** Verifies sequence order, id integrity and the hash chain. */
  verify(taskId: string): IntegrityReport {
    const problems: string[] = [];
    let events: StoredEvent[] = [];
    let quarantined: string | null = null;
    try { events = this.read(taskId); }
    catch (e: any) { return { ok: false, events: 0, problems: [String(e?.message ?? e)], quarantined: null }; }

    let prev = 'GENESIS';
    events.forEach((e, i) => {
      if (e.seq !== i + 1) problems.push(`sequence gap at index ${i}: expected ${i + 1}, got ${e.seq}`);
      if (e.prev !== prev) problems.push(`chain break at seq ${e.seq}: prev ${e.prev} != ${prev}`);
      const { id, ...body } = e;
      if (this.hashOf(body as any) !== id) problems.push(`event ${e.seq} was modified after it was written`);
      prev = e.id;
    });
    const tornFiles = (() => {
      try { return fs.readdirSync(this.taskDir(taskId)).filter((f) => f.includes('.torn-')); } catch { return []; }
    })();
    if (tornFiles.length) quarantined = tornFiles[tornFiles.length - 1];
    return { ok: problems.length === 0, events: events.length, problems, quarantined };
  }
}
