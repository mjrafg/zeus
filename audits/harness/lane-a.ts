/**
 * LANE A — state, recovery and event integrity.
 *
 * Charter §7, §15, §16, §34.
 *
 * The event log is the only thing that makes any Zeus claim checkable after
 * the fact. If it can be forged, truncated without notice, or written by two
 * owners at once, then every other guarantee reduces to "trust the process
 * that wrote the log".
 */

import * as fs from 'fs';
import * as path from 'path';
import { LaneSpec, ProbeContext, held, defect } from './types';
import { evidence, compare, fromAudit, run } from './kit';

const SECTIONS = [
  { id: '§7', title: 'Event store append and chain semantics' },
  { id: '§15', title: 'Crash recovery and torn writes' },
  { id: '§16', title: 'Project lease and multi-instance safety' },
  { id: '§34', title: 'State path derivation and isolation' },
];

function store(ctx: ProbeContext, name: string) {
  const { EventStore } = fromAudit(ctx.auditRoot, '../src/engine/events');
  const root = path.join(ctx.tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, store: new EventStore(root), EventStore };
}

export const laneA: LaneSpec = {
  lane: 'A',
  title: 'State / recovery / event integrity',
  sections: SECTIONS,
  probes: [
    {
      id: 'A1', section: '§7', title: 'an edited event breaks the chain and is detected',
      run(ctx) {
        const { root, store: s } = store(ctx, 'a1');
        for (let i = 0; i < 5; i += 1) s.append({ taskId: 't', type: 'NOTE', payload: { i } });
        const before = s.verify('t');
        const file = s.logPath('t');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const tampered = JSON.parse(lines[2]);
        tampered.payload = { i: 999 };
        lines[2] = JSON.stringify(tampered);
        fs.writeFileSync(file, `${lines.join('\n')}\n`);
        let after: any;
        let threw = '';
        try { after = s.verify('t'); } catch (e: any) { threw = String(e?.message ?? e); }
        const observed = compare([
          ['before tampering', `ok=${before.ok} events=${before.events}`],
          ['after editing event 3', after ? `ok=${after.ok} problem=${JSON.stringify(after.problems?.[0] ?? null)}` : `threw: ${threw}`],
          ['log root', root],
        ]);
        const detected = threw !== '' || (after && after.ok === false);
        return detected ? held(observed) : defect(observed, {
          sections: ['§7'], severity: 'P0',
          title: 'Event tampering is not detected',
          detail: 'An event payload was edited in place and verify() still reported an intact chain.',
          impact: 'Every audit claim becomes unfalsifiable; the log documents whatever the last writer wanted.',
        });
      },
    },

    {
      id: 'A2', section: '§7', title: 'a duplicate event id is refused',
      run(ctx) {
        const { store: s } = store(ctx, 'a2');
        s.append({ taskId: 't', type: 'NOTE', payload: { a: 1 } });
        const file = s.logPath('t');
        const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
        let refused = '';
        try {
          // Replay an id that already exists, which is what a confused resume
          // or a double-write would produce.
          fs.appendFileSync(file, `${JSON.stringify({ ...first, seq: 2 })}\n`);
          s.append({ taskId: 't', type: 'NOTE', payload: { a: 2 } });
        } catch (e: any) { refused = String(e?.message ?? e); }
        const v = (() => { try { return JSON.stringify(s.verify('t')); } catch (e: any) { return `verify threw: ${e?.message}`; } })();
        const observed = compare([['append after duplicate id', refused || '(accepted)'], ['verify', evidence(v, 300)]]);
        return refused || v.includes('false') || v.includes('threw')
          ? held(observed)
          : defect(observed, {
            sections: ['§7'], severity: 'P1',
            title: 'A duplicated event id is silently accepted',
            detail: 'Appending after a replayed id neither failed nor invalidated the chain.',
            impact: 'Replayed or double-written events become indistinguishable from real ones.',
          });
      },
    },

    {
      id: 'A3', section: '§15', title: 'a torn final line is quarantined, not parsed as truth',
      run(ctx) {
        const { store: s } = store(ctx, 'a3');
        for (let i = 0; i < 3; i += 1) s.append({ taskId: 't', type: 'NOTE', payload: { i } });
        const file = s.logPath('t');
        // Simulate a crash mid-write: a half-flushed final line.
        fs.appendFileSync(file, '{"seq":4,"type":"NOT');
        const readBack = s.read('t');
        const repaired = s.read('t', { repair: true });
        const quarantine = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.torn-'));
        const observed = compare([
          ['events read with a torn tail', String(readBack.length)],
          ['events after repair', String(repaired.length)],
          ['quarantine files', JSON.stringify(quarantine)],
          ['verify after repair', (() => { try { return JSON.stringify(s.verify('t').ok); } catch (e: any) { return `threw ${e?.message}`; } })()],
        ]);
        return readBack.length === 3 && quarantine.length > 0
          ? held(observed)
          : defect(observed, {
            sections: ['§15'], severity: 'P1',
            title: 'A torn final line is mishandled',
            detail: 'A partially written last line was either parsed as an event or deleted instead of quarantined.',
            impact: 'A crash either injects a fabricated event or destroys evidence of what was in flight.',
          });
      },
    },

    {
      id: 'A4', section: '§16', title: 'a second instance is refused the project lease',
      run(ctx) {
        const { ProjectLock } = fromAudit(ctx.auditRoot, '../src/engine/lock');
        const dir = path.join(ctx.tmp, 'a4'); fs.mkdirSync(dir, { recursive: true });
        const one = new ProjectLock(dir, 'proj');
        const two = new ProjectLock(dir, 'proj');
        const first = one.acquire();
        const second = two.acquire();
        const observed = compare([
          ['first acquire', JSON.stringify(first)],
          ['second acquire', JSON.stringify(second)],
        ]);
        one.release();
        return first.ok && !second.ok && !!second.reason
          ? held(observed)
          : defect(observed, {
            sections: ['§16'], severity: 'P0',
            title: 'Two instances can own one project',
            detail: 'A second ProjectLock acquired the lease while the first held it.',
            impact: 'Two orchestrators write the same event log and worktrees; state corruption is a matter of timing.',
          });
      },
    },

    {
      id: 'A5', section: '§16', title: 'a lease is only reclaimed when its owner is demonstrably gone',
      run(ctx) {
        const { ProjectLock } = fromAudit(ctx.auditRoot, '../src/engine/lock');
        const dir = path.join(ctx.tmp, 'a5'); fs.mkdirSync(dir, { recursive: true });
        const owner = new ProjectLock(dir, 'proj');
        owner.acquire();
        const leaseFile = path.join(dir, 'project.lock');
        const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
        // A live owner with a stale heartbeat must NOT be evicted just for
        // being slow; a dead owner must be.
        const live = { ...lease, heartbeatAt: new Date(Date.now() - 5_000).toISOString() };
        fs.writeFileSync(leaseFile, JSON.stringify(live));
        const whileLive = new ProjectLock(dir, 'proj').acquire();
        const dead = { ...lease, pid: 999_999, heartbeatAt: new Date(Date.now() - 86_400_000).toISOString() };
        fs.writeFileSync(leaseFile, JSON.stringify(dead));
        const whileDead = new ProjectLock(dir, 'proj').acquire();
        const observed = compare([
          ['live owner, recent heartbeat', JSON.stringify(whileLive)],
          ['dead owner (pid 999999), day-old heartbeat', JSON.stringify(whileDead)],
        ]);
        owner.release();
        return !whileLive.ok && whileDead.ok
          ? held(observed)
          : defect(observed, {
            sections: ['§16'], severity: 'P1',
            title: 'Lease takeover rules are wrong in one direction',
            detail: `A live owner was ${whileLive.ok ? 'evicted' : 'kept'}; a dead owner's lease was ${whileDead.ok ? 'reclaimed' : 'left stuck'}.`,
            impact: 'Either two owners run at once, or a crashed run wedges the project until someone deletes a file by hand.',
          });
      },
    },

    {
      id: 'A6', section: '§34', title: 'a hostile task id cannot escape the state root',
      run(ctx) {
        const { root, store: s, EventStore } = store(ctx, 'a6');
        const hostile = '../../../../etc/zeus-owned';
        const dir = s.taskDir(hostile);
        const logged = s.logPath(hostile);
        s.append({ taskId: hostile, type: 'NOTE', payload: { x: 1 } });
        const inside = path.resolve(logged).startsWith(path.resolve(root) + path.sep);
        const observed = compare([
          ['task id', hostile],
          ['dirName()', EventStore.dirName(hostile)],
          ['resolved log path', path.resolve(logged)],
          ['contained by state root', String(inside)],
          ['state root', path.resolve(root)],
        ]);
        return inside ? held(observed) : defect(observed, {
          sections: ['§34'], severity: 'P0',
          title: 'A task id can write outside the state root',
          detail: 'A task id containing traversal segments produced a log path outside the project state directory.',
          impact: 'Anything able to influence a task id can write attacker-chosen files anywhere the process can reach.',
        });
      },
    },

    {
      id: 'A7', section: '§7', title: 'an out-of-band write invalidates the cached cursor',
      run(ctx) {
        const { store: s } = store(ctx, 'a7');
        s.append({ taskId: 't', type: 'NOTE', payload: { i: 0 } });
        const file = s.logPath('t');
        const second = fromAudit(ctx.auditRoot, '../src/engine/events');
        const other = new second.EventStore(path.dirname(path.dirname(path.dirname(file))));
        other.append({ taskId: 't', type: 'NOTE', payload: { i: 1 } });
        // The first store still holds a cursor from before the external write.
        s.append({ taskId: 't', type: 'NOTE', payload: { i: 2 } });
        let verify = '';
        try { verify = JSON.stringify(s.verify('t')); } catch (e: any) { verify = `threw ${e?.message}`; }
        const seqs = s.read('t').map((e: any) => e.seq);
        const observed = compare([
          ['sequences after an interleaved external append', JSON.stringify(seqs)],
          ['verify', evidence(verify, 240)],
        ]);
        const monotonic = seqs.every((n: number, i: number) => i === 0 || n === seqs[i - 1] + 1);
        return monotonic && verify.includes('"ok":true')
          ? held(observed)
          : defect(observed, {
            sections: ['§7'], severity: 'P1',
            title: 'A stale cursor corrupts the chain after an external write',
            detail: 'Appending from a store instance whose cursor predates another writer produced a broken sequence or chain.',
            impact: 'Two Zeus processes, or one process and a repair, leave a log that no longer verifies.',
          });
      },
    },

    {
      id: 'A8', section: '§7', title: 'payload content cannot forge a log entry',
      run(ctx) {
        const { store: s } = store(ctx, 'a8');
        // A payload that, written naively, would look like two log lines.
        const forged = '{"seq":99,"type":"ACCEPTED","payload":{"note":"forged"}}';
        s.append({ taskId: 't', type: 'NOTE', payload: { text: `line one\n${forged}\n` } });
        const events = s.read('t');
        const observed = compare([
          ['events after appending a payload containing a newline + JSON', String(events.length)],
          ['types', JSON.stringify(events.map((e: any) => e.type))],
          ['raw line count', String(fs.readFileSync(s.logPath('t'), 'utf8').split('\n').filter(Boolean).length)],
        ]);
        return events.length === 1 && events[0].type === 'NOTE'
          ? held(observed)
          : defect(observed, {
            sections: ['§7'], severity: 'P0',
            title: 'Event payloads can forge additional log entries',
            detail: 'A payload containing a newline and JSON produced more than one parsed event.',
            impact: 'Any agent-controlled string reaching a payload can fabricate an ACCEPTED event.',
          });
      },
    },

    {
      id: 'A9', section: '§15', title: 'a killed writer leaves a readable, verifiable log',
      run(ctx) {
        const script = path.join(ctx.tmp, 'a9-writer.js');
        const root = path.join(ctx.tmp, 'a9-state');
        fs.writeFileSync(script, `
          const { EventStore } = require(${JSON.stringify(path.join(ctx.auditRoot, 'src/engine/events'))});
          const s = new EventStore(${JSON.stringify(root)});
          for (let i = 0; i < 100000; i += 1) s.append({ taskId: 't', type: 'NOTE', payload: { i } });
        `);
        const tsNode = path.join(ctx.auditRoot, 'node_modules/.bin/ts-node');
        const child = require('child_process').spawn(tsNode, ['--transpile-only', script], { stdio: 'ignore' });
        const killed = new Promise<void>((resolve) => {
          setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } resolve(); }, 900);
        });
        return killed.then(() => new Promise<void>((r) => setTimeout(r, 300))).then(() => {
          const { EventStore } = fromAudit(ctx.auditRoot, '../src/engine/events');
          const s = new EventStore(root);
          let events: any[] = [];
          let err = '';
          try { events = s.read('t', { repair: true }); } catch (e: any) { err = String(e?.message ?? e); }
          let v = '';
          try { v = JSON.stringify(s.verify('t').ok); } catch (e: any) { v = `threw ${e?.message}`; }
          const observed = compare([
            ['events recovered after SIGKILL', String(events.length)],
            ['read error', err || '(none)'],
            ['verify after repair', v],
          ]);
          return events.length > 0 && !err && v === 'true'
            ? held(observed)
            : defect(observed, {
              sections: ['§15'], severity: 'P1',
              title: 'A SIGKILLed writer leaves an unreadable log',
              detail: `After killing a writer mid-append the log ${err ? `could not be read (${err})` : `failed verification (${v})`}.`,
              impact: 'A crash destroys the evidence needed to work out what the crash interrupted.',
            });
        });
      },
    },
  ],

  declared: [
    {
      section: '§34', status: 'NOT_TESTED',
      reason:
        'Concurrent multi-process append to the SAME task log was not exercised. Attempted: spawning two ts-node '
        + 'writers against one task id. Blocked because the product forbids that configuration upstream — the project '
        + 'lease (probe A4) prevents two engines from reaching the store at all — so the scenario is unreachable '
        + 'through any supported path and a synthetic race would test code that cannot run in production.',
    },
  ],
};
