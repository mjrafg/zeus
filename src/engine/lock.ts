/**
 * Project ownership lease (P0-3).
 *
 * Two orchestrators writing the same project's event log would interleave
 * sequence numbers and break the hash chain that the whole evidence model
 * rests on. An in-process mutex does not help: the second process is a
 * different process, often on a different machine.
 *
 * The lease is therefore a file created with O_EXCL — the one operation the
 * filesystem makes atomic across processes — carrying the owner's identity and
 * a heartbeat. A crashed owner's lease is reclaimed only after it demonstrably
 * stops beating, and a same-host owner is additionally checked by PID so a
 * crash is noticed immediately instead of after a timeout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Lease {
  instanceId: string;
  pid: number;
  hostname: string;
  projectId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** Seconds without a heartbeat after which another instance may take over. */
  ttlSeconds: number;
}

export interface AcquireResult {
  ok: boolean;
  lease?: Lease;
  /** Populated when someone else holds it, so the error can be specific. */
  heldBy?: Lease;
  reason?: string;
}

const DEFAULT_TTL = 60;

export class ProjectLock {
  readonly file: string;
  readonly instanceId: string;
  // Typed structurally so the engine needs no @types/node dependency.
  private timer: ReturnType<typeof setInterval> | null = null;
  private held = false;

  constructor(readonly stateDir: string, readonly projectId: string,
    readonly ttlSeconds: number = DEFAULT_TTL) {
    this.file = path.join(stateDir, 'project.lock');
    this.instanceId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  }

  private read(): Lease | null {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Lease; } catch { return null; }
  }

  private write(lease: Lease): void {
    // Atomic replace so a reader never sees a half-written lease.
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(lease));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  private makeLease(now = Date.now()): Lease {
    return {
      instanceId: this.instanceId, pid: process.pid, hostname: os.hostname(),
      projectId: this.projectId,
      acquiredAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
      ttlSeconds: this.ttlSeconds,
    };
  }

  /** A lease is dead if it expired, or if its same-host process is gone. */
  private isDead(lease: Lease, now = Date.now()): boolean {
    if (lease.hostname === os.hostname()) {
      try { process.kill(lease.pid, 0); } catch { return true; }
    }
    return Date.parse(lease.expiresAt) <= now;
  }

  acquire(): AcquireResult {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const lease = this.makeLease();
    try {
      // O_EXCL: exactly one process can win this, even across machines on a
      // filesystem with working exclusive create.
      const fd = fs.openSync(this.file, 'wx');
      try { fs.writeSync(fd, JSON.stringify(lease)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.held = true;
      this.startHeartbeat();
      return { ok: true, lease };
    } catch {
      const existing = this.read();
      if (!existing) {
        // The file exists but is unreadable/corrupt: treat as stale, once.
        try { fs.rmSync(this.file, { force: true }); } catch { /* raced */ }
        return this.acquire();
      }
      if (existing.instanceId === this.instanceId) {
        this.held = true; this.startHeartbeat();
        return { ok: true, lease: existing };
      }
      if (this.isDead(existing)) {
        // Reclaim, but re-verify after the delete to lose races safely: if
        // another instance got there first we simply report it as the holder.
        try { fs.rmSync(this.file, { force: true }); } catch { /* raced */ }
        const retry = this.acquire();
        if (retry.ok) return { ...retry, reason: `reclaimed a stale lease from ${existing.instanceId}` };
        return retry;
      }
      return {
        ok: false, heldBy: existing,
        reason: `project is owned by ${existing.instanceId} (pid ${existing.pid} on ${existing.hostname}), `
          + `last heartbeat ${existing.heartbeatAt}. Only one Zeus instance may run a project at a time.`,
      };
    }
  }

  /** Extends the lease. Refuses if we silently lost ownership. */
  heartbeat(): boolean {
    if (!this.held) return false;
    const cur = this.read();
    if (!cur || cur.instanceId !== this.instanceId) { this.held = false; return false; }
    this.write({ ...cur, heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString() });
    return true;
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.heartbeat(); }, Math.max(1000, (this.ttlSeconds * 1000) / 3));
    // Never hold the process open just to keep a lease warm.
    // Never hold the process open just to keep a lease warm. Cast because the
    // engine intentionally ships without @types/node.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  release(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const cur = this.read();
    if (cur && cur.instanceId === this.instanceId) {
      try { fs.rmSync(this.file, { force: true }); } catch { /* already gone */ }
    }
    this.held = false;
  }

  isHeld(): boolean { return this.held; }
  current(): Lease | null { return this.read(); }
}
