/**
 * Passive latency instrumentation.
 *
 * The question this exists to answer is where a task's wall clock actually
 * goes, so the instrument must not move the thing it measures. Three rules
 * follow from that, and they are why this module looks the way it does:
 *
 *   * **Monotonic only.** `process.hrtime.bigint()` throughout. Wall-clock
 *     timestamps jump when NTP corrects the host, and a negative duration in a
 *     latency report is worse than no report.
 *   * **Buffered, never streamed.** Spans accumulate in memory and are flushed
 *     as ONE event at the end. Appending an event per span would add an fsync
 *     to every measurement, so the PERSISTENCE bucket would be measuring the
 *     instrument rather than the product.
 *   * **Exclusive time.** A parent reports only the time not spent inside its
 *     children, so nesting cannot double-count. Buckets are therefore additive
 *     and the reconciliation below is an identity, not an estimate.
 *
 * The residual — time inside the task that no span claimed — is reported as
 * IDLE gap rather than distributed. That number is the point of the exercise.
 */

export type Bucket =
  | 'SETUP'
  | 'PROVIDER'
  | 'DECISION'
  | 'VALIDATION'
  | 'REVIEW'
  | 'PERSISTENCE'
  | 'IDLE';

export const BUCKETS: Bucket[] = ['SETUP', 'PROVIDER', 'DECISION', 'VALIDATION', 'REVIEW', 'PERSISTENCE', 'IDLE'];

export interface Span {
  id: number;
  parent: number | null;
  name: string;
  bucket: Bucket;
  startNs: string;
  endNs: string;
  /** Free-form detail: role, check name, byte counts. Never timing-critical. */
  attrs: Record<string, string | number | boolean>;
}

export interface BucketBreakdown {
  bucket: Bucket;
  ms: number;
  pct: number;
  /** Named sub-totals within the bucket, by span name. */
  detail: Array<{ name: string; ms: number; count: number }>;
}

export interface LatencyReport {
  totalMs: number;
  buckets: BucketBreakdown[];
  /** Time inside the task that no span accounted for. Never redistributed. */
  idleGapMs: number;
  /** Time in spans explicitly marked IDLE (queue waits, spawn waits). */
  idleExplicitMs: number;
  /** totalMs - sum(bucket ms). Must be ~0; printed so it can be checked. */
  reconciliationDeltaMs: number;
  /** Cost of the instrumentation itself, measured not estimated. */
  overheadMs: number;
  spanCount: number;
}

const NS_PER_MS = 1_000_000;
const ms = (ns: bigint): number => Number(ns) / NS_PER_MS;

/**
 * Records spans for one task.
 *
 * Not global: a recorder belongs to a task so that concurrent tasks cannot
 * interleave into one tree and produce a report that reconciles to nothing.
 */
export class SpanRecorder {
  private readonly spans: Span[] = [];
  private readonly stack: number[] = [];
  private next = 1;
  private overheadNs = 0n;
  private readonly rootStartNs: bigint;
  private endedNs: bigint | null = null;

  constructor(readonly taskId: string, start?: bigint) {
    this.rootStartNs = start ?? process.hrtime.bigint();
  }

  /** Opens a span. Returns its id, which must be passed to `end`. */
  start(name: string, bucket: Bucket, attrs: Span['attrs'] = {}): number {
    const t0 = process.hrtime.bigint();
    const id = this.next;
    this.next += 1;
    this.spans.push({
      id, parent: this.stack.length ? this.stack[this.stack.length - 1] : null,
      name, bucket, startNs: t0.toString(), endNs: '0', attrs,
    });
    this.stack.push(id);
    // Bookkeeping cost is charged to overhead, not to the span.
    this.overheadNs += process.hrtime.bigint() - t0;
    return id;
  }

  end(id: number, attrs: Span['attrs'] = {}): void {
    const t0 = process.hrtime.bigint();
    const s = this.spans.find((x) => x.id === id);
    if (s) {
      s.endNs = t0.toString();
      Object.assign(s.attrs, attrs);
    }
    // Unwind to this span even if a child was left open by a thrown error, so
    // one missing `end` cannot corrupt the whole tree's parentage.
    const at = this.stack.lastIndexOf(id);
    if (at >= 0) this.stack.length = at;
    this.overheadNs += process.hrtime.bigint() - t0;
  }

  /** Wraps synchronous work. */
  sync<T>(name: string, bucket: Bucket, fn: () => T, attrs: Span['attrs'] = {}): T {
    const id = this.start(name, bucket, attrs);
    try { return fn(); } finally { this.end(id); }
  }

  /** Wraps asynchronous work. */
  async async<T>(name: string, bucket: Bucket, fn: () => Promise<T>, attrs: Span['attrs'] = {}): Promise<T> {
    const id = this.start(name, bucket, attrs);
    try { return await fn(); } finally { this.end(id); }
  }

  /**
   * Records a span whose boundaries were measured elsewhere.
   *
   * Used for process timing: the supervisor knows when a child was spawned and
   * when its first byte arrived, and those instants are more accurate than
   * anything this module could infer from the outside.
   */
  external(name: string, bucket: Bucket, startNs: bigint, endNs: bigint, attrs: Span['attrs'] = {}): void {
    const t0 = process.hrtime.bigint();
    this.spans.push({
      id: this.next, parent: this.stack.length ? this.stack[this.stack.length - 1] : null,
      name, bucket, startNs: startNs.toString(), endNs: endNs.toString(), attrs,
    });
    this.next += 1;
    this.overheadNs += process.hrtime.bigint() - t0;
  }

  /** A child of an already-closed span, for sub-phases of a process. */
  externalUnder(parent: number | null, name: string, bucket: Bucket,
    startNs: bigint, endNs: bigint, attrs: Span['attrs'] = {}): number {
    const t0 = process.hrtime.bigint();
    const id = this.next;
    this.next += 1;
    this.spans.push({ id, parent, name, bucket, startNs: startNs.toString(), endNs: endNs.toString(), attrs });
    this.overheadNs += process.hrtime.bigint() - t0;
    return id;
  }

  /** Marks the end of the measured window. */
  finish(): void { this.endedNs = process.hrtime.bigint(); }

  raw(): Span[] { return this.spans; }

  /**
   * Computes the breakdown.
   *
   * Exclusive time is a span's duration minus the duration of its direct
   * children. Children that overlap (concurrent work under one parent) are
   * summed, which can drive a parent's exclusive time negative; that is
   * clamped to zero and surfaced through the reconciliation delta rather than
   * silently absorbed.
   */
  report(): LatencyReport {
    const total = (this.endedNs ?? process.hrtime.bigint()) - this.rootStartNs;
    const byParent = new Map<number, Span[]>();
    for (const s of this.spans) {
      if (s.parent === null) continue;
      const list = byParent.get(s.parent) ?? [];
      list.push(s);
      byParent.set(s.parent, list);
    }

    const exclusive = new Map<number, bigint>();
    for (const s of this.spans) {
      const dur = BigInt(s.endNs) - BigInt(s.startNs);
      const kids = byParent.get(s.id) ?? [];
      const kidTotal = kids.reduce((a, k) => a + (BigInt(k.endNs) - BigInt(k.startNs)), 0n);
      const excl = dur - kidTotal;
      exclusive.set(s.id, excl > 0n ? excl : 0n);
    }

    const perBucket = new Map<Bucket, bigint>();
    const perName = new Map<string, { ns: bigint; count: number; bucket: Bucket }>();
    for (const s of this.spans) {
      const excl = exclusive.get(s.id) ?? 0n;
      perBucket.set(s.bucket, (perBucket.get(s.bucket) ?? 0n) + excl);
      const key = `${s.bucket}::${s.name}`;
      const cur = perName.get(key) ?? { ns: 0n, count: 0, bucket: s.bucket };
      cur.ns += excl; cur.count += 1;
      perName.set(key, cur);
    }

    const accounted = [...perBucket.values()].reduce((a, b) => a + b, 0n);
    const gap = total - accounted;
    const idleGap = gap > 0n ? gap : 0n;
    const idleExplicit = perBucket.get('IDLE') ?? 0n;
    perBucket.set('IDLE', idleExplicit + idleGap);

    const totalMs = ms(total);
    const buckets: BucketBreakdown[] = BUCKETS.map((b) => {
      const ns = perBucket.get(b) ?? 0n;
      const detail = [...perName.entries()]
        .filter(([, v]) => v.bucket === b)
        .map(([k, v]) => ({ name: k.split('::')[1], ms: ms(v.ns), count: v.count }))
        .sort((x, y) => y.ms - x.ms);
      if (b === 'IDLE' && idleGap > 0n) {
        detail.unshift({ name: 'unattributed gap', ms: ms(idleGap), count: 1 });
      }
      return { bucket: b, ms: ms(ns), pct: totalMs > 0 ? (ms(ns) / totalMs) * 100 : 0, detail };
    });

    const summed = buckets.reduce((a, b) => a + b.ms, 0);
    return {
      totalMs,
      buckets,
      idleGapMs: ms(idleGap),
      idleExplicitMs: ms(idleExplicit),
      reconciliationDeltaMs: totalMs - summed,
      overheadMs: ms(this.overheadNs),
      spanCount: this.spans.length,
    };
  }
}

/** A recorder that costs nothing, for every code path that is not measuring. */
export class NullRecorder extends SpanRecorder {
  constructor() { super('null'); }
  start(): number { return 0; }
  end(): void { /* nothing */ }
  sync<T>(_n: string, _b: Bucket, fn: () => T): T { return fn(); }
  async async<T>(_n: string, _b: Bucket, fn: () => Promise<T>): Promise<T> { return fn(); }
  external(): void { /* nothing */ }
  externalUnder(): number { return 0; }
}

export const NO_SPANS = new NullRecorder();
