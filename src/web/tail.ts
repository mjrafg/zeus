/**
 * Following the event log, so the stream can be resumed rather than trusted.
 *
 * THE LOG IS THE TRUTH, NOT THE SOCKET. A client that reconnects sends the
 * last id it saw and the server replays from the log — so a dropped
 * connection, a suspended laptop or a server restart costs a reader nothing.
 * The alternative, treating the socket as the record, means every disconnect
 * is a silent hole in what an operator believes they watched.
 */

import * as fs from 'fs';
import { EventStore, StoredEvent } from '../engine/events';

/**
 * The SSE event name every frame carries.
 *
 * ONE channel, always the same name — and the real event type travels inside
 * `data.type`, where it already was. The first version named each frame after
 * its own type (`event: TASK_SPAWNED`), which is expressive and was silently
 * fatal: per the SSE spec a named frame does NOT dispatch to `onmessage`, so a
 * client written the obvious way received nothing at all. Every frame crossed
 * the wire correctly and the browser discarded all of them.
 *
 * A single name also means the client cannot fall behind the vocabulary. With
 * per-type names, every new event type needs a new `addEventListener` or it is
 * invisible — a listener list that has to be kept in sync with an enum is a
 * listener list that will not be.
 *
 * Exported so the server and the UI cannot disagree about it: they both read
 * this constant, and a test asserts the frames actually dispatch here.
 */
export const SSE_CHANNEL = 'zeus';

/** `<taskId>#<seq>` — an id a client can hand back verbatim. */
export function eventId(e: StoredEvent): string { return `${e.taskId}#${e.seq}`; }

export function parseEventId(raw: string | null): { taskId: string; seq: number } | null {
  if (!raw) return null;
  const hash = raw.lastIndexOf('#');
  if (hash <= 0) return null;
  const seq = Number(raw.slice(hash + 1));
  if (!Number.isFinite(seq)) return null;
  return { taskId: raw.slice(0, hash), seq };
}

export interface TailCursor { [taskId: string]: number }

/**
 * Reads everything after the cursor, in a deterministic order.
 *
 * Ordered by task, then by sequence. Two logs advancing at once have no global
 * order to discover, and inventing one from wall-clock timestamps would make
 * replay differ from live — the one thing resume must never do.
 */
export function since(store: EventStore, cursor: TailCursor, ids?: string[]): StoredEvent[] {
  const tasks = (ids ?? store.listTasks()).slice().sort();
  const out: StoredEvent[] = [];
  for (const taskId of tasks) {
    const from = cursor[taskId] ?? 0;
    let events: StoredEvent[];
    try { events = store.read(taskId); } catch { continue; }
    for (const e of events) if (e.seq > from) out.push(e);
  }
  return out;
}

/** Advances a cursor past everything in `events`. */
export function advance(cursor: TailCursor, events: StoredEvent[]): TailCursor {
  const next = { ...cursor };
  for (const e of events) next[e.taskId] = Math.max(next[e.taskId] ?? 0, e.seq);
  return next;
}

/** A cursor positioned exactly at a client's Last-Event-ID. */
export function cursorFromLastId(store: EventStore, lastId: string | null): TailCursor {
  const parsed = parseEventId(lastId);
  if (!parsed) return {};
  // Every OTHER task starts from its current end: the client is resuming, not
  // asking for the history of logs it was never watching.
  const cursor: TailCursor = {};
  for (const taskId of store.listTasks()) {
    if (taskId === parsed.taskId) { cursor[taskId] = parsed.seq; continue; }
    try {
      const events = store.read(taskId);
      cursor[taskId] = events.length ? events[events.length - 1].seq : 0;
    } catch { cursor[taskId] = 0; }
  }
  cursor[parsed.taskId] = parsed.seq;
  return cursor;
}

export interface TailerOptions {
  store: EventStore;
  onEvents: (events: StoredEvent[]) => void;
  /** Safety tick, for filesystems where watch does not fire. */
  intervalMs?: number;
}

/**
 * Watches the log directory and reports new events.
 *
 * `fs.watch` is stdlib and event-driven, so the common case costs nothing. The
 * interval behind it is a safety net for filesystems where watch is
 * unreliable (network mounts, some containers) — not the primary mechanism,
 * and slow enough to be cheap when it is never needed.
 */
export class EventTailer {
  private cursor: TailCursor = {};
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: TailerOptions) {}

  /** Positions at the current end without emitting anything. */
  seekToEnd(): void { this.cursor = advance({}, since(this.opts.store, {})); }

  seek(cursor: TailCursor): void { this.cursor = { ...cursor }; }

  drain(): StoredEvent[] {
    const fresh = since(this.opts.store, this.cursor);
    if (fresh.length) this.cursor = advance(this.cursor, fresh);
    return fresh;
  }

  private pump = (): void => {
    if (this.stopped) return;
    const fresh = this.drain();
    if (fresh.length) this.opts.onEvents(fresh);
  };

  start(): void {
    const root = (this.opts.store as unknown as { root: string }).root;
    try {
      fs.mkdirSync(root, { recursive: true });
      this.watcher = fs.watch(root, { recursive: true }, () => this.pump());
    } catch { this.watcher = null; }
    this.timer = setInterval(this.pump, this.opts.intervalMs ?? 1_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    try { this.watcher?.close(); } catch { /* already gone */ }
    if (this.timer) clearInterval(this.timer);
    this.watcher = null;
    this.timer = null;
  }
}
