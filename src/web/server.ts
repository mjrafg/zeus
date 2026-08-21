/**
 * The Control Center's HTTP surface.
 *
 * THE WEB IS A CLIENT OF THE ENGINE. Every route below is a thin call into the
 * same Engine, EventStore, MissionRegistry and views the CLI uses. Nothing here
 * reimplements a decision, and nothing here holds authority: an API response is
 * a projection of the event log, and a permission is a fact derived from it.
 *
 * Stdlib only, because `dependencies: {}` is a public claim about this package
 * and a web console is not a good enough reason to stop it being true.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import { spawn } from 'child_process';
import { EventStore, StoredEvent } from '../engine/events';
import { MissionRegistry } from '../mission/registry';
import { isMissionId, isTaskId, scopeOf } from '../mission/types';
import {
  missionListView, missionReportView, missionStatusView, missionPhase,
  costBreakdown, integrationLine,
} from '../views';
import { ensureToken, offeredToken, tokenMatches } from './token';
import {
  ConsentRequest, consentSubject, evaluateConsent,
} from '../mission/consent';
import { CompileResult, PlanOperationResult, OperationContext } from '../mission/operations';
import { EventTailer, cursorFromLastId, eventId } from './tail';
import { UI_HTML } from './ui';

export interface WebServerOptions {
  projectRoot: string;
  stateRoot: string;
  projectId: string;
  port?: number;
  host?: string;
  /** Injected so tests drive the server without a real engine or CLI. */
  spawnRun?: (missionId: string) => { ok: boolean; pid: number | null; detail: string };
  /** Injected reader for git diffs, so the route is testable and read-only. */
  diff?: (from: string, to: string, cwd: string) => string;
  /**
   * The engine operations the write routes call.
   *
   * Injected rather than constructed here so the server cannot grow its own
   * copy: whatever is passed is the same function the CLI invokes.
   */
  operations?: {
    compile(missionId: string): Promise<CompileResult>;
    plan(missionId: string): Promise<PlanOperationResult>;
    evaluate(missionId: string, opts: { full: boolean }): Promise<unknown>;
  };
  onLog?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  address: string;
  port: number;
  token: string;
  tokenCreated: boolean;
  close(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Routes that exist. Nothing outside this table is reachable. */
export const READ_ROUTES = [
  'GET /api/project',
  'GET /api/missions',
  'GET /api/missions/:id',
  'GET /api/missions/:id/events',
  'GET /api/missions/:id/report',
  'GET /api/tasks/:id',
  'GET /api/files/diff',
  'GET /api/missions/:id/consent',
  'GET /api/events/stream',
] as const;

export const WRITE_ROUTES = [
  'POST /api/missions',
  'POST /api/missions/:id/compile',
  'POST /api/missions/:id/plan',
  'POST /api/missions/:id/run',
  'POST /api/missions/:id/cancel',
  'POST /api/missions/:id/confirm',
  'POST /api/missions/:id/evaluate',
] as const;

/**
 * Every route this server serves.
 *
 * Exported so a test can assert what is NOT here — specifically that no route
 * writes project file content. The web reads the repository and never edits
 * it; editing is what missions are for, under the gates.
 */
export function routeTable(): string[] {
  return [...READ_ROUTES, ...WRITE_ROUTES];
}

/** Reads a JSON body, bounded. An unbounded body is a denial of service. */
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { resolve({}); return; }
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 1);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function gitDiff(from: string, to: string, cwd: string): string {
  try {
    return require('child_process').execFileSync('git',
      ['-C', cwd, 'diff', '--stat', '-p', `${from}..${to}`, '--'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] }) as string;
  } catch { return ''; }
}

/**
 * Spawns `zeus mission run` as a DETACHED process.
 *
 * Never in the server process. A mission outlives the console by design: the
 * server can be restarted, upgraded or killed and the work continues, and the
 * console reattaches by reading the log — which is the whole reason the log is
 * the truth. Running it inline would make an operator closing a laptop into a
 * cancelled mission.
 */
export function defaultSpawnRun(projectRoot: string, missionId: string):
  { ok: boolean; pid: number | null; detail: string } {
  const cli = path.resolve(__dirname, '..', 'cli.ts');
  const useTs = fs.existsSync(cli);
  const entry = useTs ? cli : path.resolve(__dirname, '..', 'cli.js');
  const args = useTs
    ? [path.resolve(projectRoot, 'node_modules/.bin/ts-node'), '--transpile-only', entry]
    : [entry];
  try {
    const child = spawn(process.execPath, [...args, 'mission', 'run', missionId], {
      cwd: projectRoot, detached: true, stdio: 'ignore',
    });
    child.unref();
    return { ok: true, pid: child.pid ?? null, detail: `spawned pid ${child.pid}` };
  } catch (e: any) {
    return { ok: false, pid: null, detail: e?.message ?? String(e) };
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const store = new EventStore(opts.stateRoot);
  const missions = new MissionRegistry({
    events: store, projectId: opts.projectId, stateRoot: opts.stateRoot,
  });
  const { token, created } = ensureToken(opts.stateRoot);
  const diff = opts.diff ?? gitDiff;
  const say = opts.onLog ?? (() => {});
  const streams = new Set<{ res: http.ServerResponse; tailer: EventTailer }>();

  const resolveId = (raw: string): string =>
    (raw.includes('/') ? raw : `${opts.projectId}/${raw}`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase();

    // AUTH FIRST, on every path including the stream and the UI's data. The
    // only thing served without it is the HTML shell, which contains no data.
    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(token, offeredToken(req.headers as Record<string, unknown>, url))) {
        send(res, 401, { error: 'UNAUTHORIZED', detail: 'a bearer token is required' });
        return;
      }
    }

    try {
      if (method === 'GET' && url.pathname === '/') {
        const body = UI_HTML;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/project') {
        send(res, 200, {
          projectId: opts.projectId, root: opts.projectRoot,
          missions: missions.list().length,
          routes: routeTable(),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/missions') {
        const recs = missionListView(missions);
        send(res, 200, recs.map((r) => ({
          ...r, phase: missionPhase(store.read(r.missionId)),
        })));
        return;
      }

      const missionMatch = /^\/api\/missions\/([^/]+)(\/(events|report))?$/.exec(url.pathname);
      if (method === 'GET' && missionMatch) {
        const id = resolveId(decodeURIComponent(missionMatch[1]));
        if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
        const sub = missionMatch[3];

        if (sub === 'events') {
          const events = store.read(id);
          const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
          const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 1000);
          // Served exactly as stored: the redacting sink already ran at append
          // time, so there is nothing left to strip and nothing to re-decide.
          send(res, 200, { total: events.length, offset, limit,
            events: events.slice(offset, offset + limit) });
          return;
        }
        if (sub === 'report') {
          const view = missionReportView(missions, id);
          if (!view) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
          send(res, 200, view);
          return;
        }
        const view = missionStatusView(missions, opts.projectRoot, id);
        if (!view) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
        send(res, 200, {
          ...view,
          phase: missionPhase(store.read(id)),
          cost: costBreakdown(missions, id),
        });
        return;
      }

      const consentMatch = /^\/api\/missions\/([^/]+)\/consent$/.exec(url.pathname);
      if (method === 'GET' && consentMatch) {
        const id = resolveId(decodeURIComponent(consentMatch[1]));
        if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
        const oracle = consentSubject(missions, id, 'oracle');
        const plan = consentSubject(missions, id, 'plan');
        if (!oracle) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
        send(res, 200, { missionId: id, oracle, plan });
        return;
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && taskMatch) {
        const id = resolveId(decodeURIComponent(taskMatch[1]));
        if (!isTaskId(id)) { send(res, 400, { error: 'NOT_A_TASK_ID', id }); return; }
        let events: StoredEvent[] = [];
        try { events = store.read(id); } catch { events = []; }
        if (!events.length) { send(res, 404, { error: 'NO_SUCH_TASK', id }); return; }
        send(res, 200, { taskId: id, events });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/files/diff') {
        const task = url.searchParams.get('task');
        const mission = url.searchParams.get('mission');
        if (task) {
          const id = resolveId(task);
          if (!isTaskId(id)) { send(res, 400, { error: 'NOT_A_TASK_ID', id }); return; }
          const created = store.read(id).find((e) => e.type === 'TASK_CREATED');
          const worktree = (created?.payload as any)?.worktree ?? opts.projectRoot;
          const base = (created?.payload as any)?.baseSha ?? 'HEAD';
          send(res, 200, { taskId: id, from: base, to: 'HEAD',
            diff: diff(base, 'HEAD', worktree) });
          return;
        }
        if (mission) {
          const id = resolveId(mission);
          const rec = missions.mission(id);
          if (!rec) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
          const line = integrationLine(rec);
          send(res, 200, { missionId: id, ...line,
            diff: diff(line.from, line.to, opts.projectRoot) });
          return;
        }
        send(res, 400, { error: 'TASK_OR_MISSION_REQUIRED' });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/events/stream') {
        const lastId = (req.headers['last-event-id'] as string | undefined)
          ?? url.searchParams.get('lastEventId');
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        const write = (events: StoredEvent[]) => {
          for (const e of events) {
            res.write(`id: ${eventId(e)}\nevent: ${e.type}\n`
              + `data: ${JSON.stringify(e)}\n\n`);
          }
        };
        const tailer = new EventTailer({ store, onEvents: write });
        // Replay from the LOG at the client's cursor, then stream. A resuming
        // client misses nothing, because the socket was never the record.
        if (lastId) tailer.seek(cursorFromLastId(store, lastId));
        else tailer.seekToEnd();
        write(tailer.drain());
        res.write(': connected\n\n');
        tailer.start();
        const entry = { res, tailer };
        streams.add(entry);
        req.on('close', () => { tailer.stop(); streams.delete(entry); });
        return;
      }

      if (method === 'POST' && url.pathname.startsWith('/api/')) {
        void readBody(req).then(async (body) => {
          try { await handleWrite(url, body, res); }
          catch (e: any) { send(res, 500, { error: 'INTERNAL', detail: String(e?.message ?? e) }); }
        });
        return;
      }

      send(res, 404, { error: 'NO_SUCH_ROUTE', path: url.pathname });
    } catch (e: any) {
      say(`route error: ${e?.message ?? e}`);
      send(res, 500, { error: 'INTERNAL', detail: String(e?.message ?? e) });
    }
  });

  async function handleWrite(url: URL, body: any, res: http.ServerResponse): Promise<void> {
    if (url.pathname === '/api/missions') {
      const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
      if (!goal) { send(res, 400, { error: 'GOAL_REQUIRED' }); return; }
      const head = (() => {
        try {
          return require('child_process').execFileSync('git',
            ['-C', opts.projectRoot, 'rev-parse', 'HEAD'],
            { encoding: 'utf8', timeout: 15_000 }).trim();
        } catch { return 'unknown'; }
      })();
      const rec = missions.create(goal, head);
      send(res, 201, missionStatusView(missions, opts.projectRoot, rec.missionId));
      return;
    }

    const m = /^\/api\/missions\/([^/]+)\/(compile|plan|run|cancel|confirm|evaluate)$/
      .exec(url.pathname);
    if (!m) { send(res, 404, { error: 'NO_SUCH_ROUTE', path: url.pathname }); return; }
    const id = resolveId(decodeURIComponent(m[1]));
    if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
    if (!missions.mission(id)) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
    const action = m[2];

    if (action === 'compile' || action === 'plan' || action === 'evaluate') {
      if (!opts.operations) {
        send(res, 503, { error: 'OPERATIONS_UNAVAILABLE',
          detail: 'this server was started without engine operations' });
        return;
      }
      const result = action === 'compile' ? await opts.operations.compile(id)
        : action === 'plan' ? await opts.operations.plan(id)
          : await opts.operations.evaluate(id, { full: body?.full === true });
      // Whatever the operation decided, decided. The route reports it and adds
      // nothing: an HTTP layer that could turn a stop into an acceptance would
      // be a second engine with a different opinion.
      send(res, 200, result);
      return;
    }

    if (action === 'run') {
      const spawnRun = opts.spawnRun;
      if (!spawnRun) { send(res, 503, { error: 'SPAWN_UNAVAILABLE' }); return; }
      // DETACHED, always. A mission outlives the console by design.
      const spawned = spawnRun(id);
      send(res, spawned.ok ? 202 : 500, { missionId: id, ...spawned });
      return;
    }

    if (action === 'cancel') {
      const reason = typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim() : 'cancelled from the control center';
      // The same cross-process path `zeus cancel` uses: the spawned mission is
      // a different OS process, and the run registry is how it is reached.
      const outcome = missions.cancel(id, reason);
      send(res, 200, { missionId: id, ...outcome });
      return;
    }

    // ---- confirm: the consent boundary ------------------------------------
    const req: ConsentRequest = {
      kind: body?.kind, version: Number(body?.version),
      findingsDigest: String(body?.findingsDigest ?? ''),
      decision: body?.decision,
    };
    const verdict = evaluateConsent(missions, id, req);
    if (!verdict.ok) {
      // 409, and the CURRENT findings come back: a refusal that does not say
      // what to read next just makes the operator guess.
      send(res, verdict.code === 'BAD_REQUEST' ? 400 : 409, {
        error: verdict.code, detail: verdict.message, current: verdict.current,
      });
      return;
    }
    const subject = verdict.subject;
    const rendered = subject.findings.map((f: any) =>
      `${f?.severity ?? f?.code ?? 'finding'}: ${f?.detail ?? JSON.stringify(f)}`);

    if (req.decision === 'REFUSE') {
      missions.recordPlanStopDecision(id, {
        version: subject.version, rendered,
        decision: subject.kind === 'plan' ? 'REFUSED_NO_CONSENT' : 'ORACLE_REFUSED',
        decidedBy: 'user-confirmed', deferred: false,
      });
      send(res, 200, { missionId: id, decision: 'REFUSE', kind: subject.kind,
        version: subject.version });
      return;
    }

    if (subject.kind === 'oracle') {
      const rec = missions.mission(id)!;
      const oracle = rec.oracle as any;
      missions.acceptOracle(id, {
        acceptanceMode: oracle?.acceptanceMode ?? 'REQUIRED_CONSENT',
        acceptedBy: 'user-confirmed',
        modeInputs: { confirmedFromWeb: true, findingsDigest: subject.digest },
        modeReasons: [`a human confirmed this oracle with ${subject.findings.length} finding(s) standing`],
        escalatedByCritic: false,
        acceptedDespite: subject.findings as Array<{ code: string; criterionId?: string }>,
      });
    } else {
      const recorded = [...missions.events.read(id)].reverse()
        .find((e) => e.type === 'PLAN_RECORDED'
          && (e.payload as any)?.version === subject.version)!;
      const graph = (recorded.payload as any).plan;
      missions.acceptPlan(id, graph, {
        acceptedBy: 'user-confirmed', acceptedDespite: rendered,
      });
    }
    missions.recordPlanStopDecision(id, {
      version: subject.version, rendered, decision: 'ACCEPTED',
      decidedBy: 'user-confirmed', deferred: false,
    });
    send(res, 200, {
      missionId: id, decision: 'ACCEPT', kind: subject.kind, version: subject.version,
      findingsDigest: subject.digest, acceptedDespite: subject.findings.length,
    });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://${addr.address === '::1' ? '[::1]' : addr.address}:${addr.port}`,
    address: addr.address,
    port: addr.port,
    token,
    tokenCreated: created,
    close: () => new Promise<void>((resolve) => {
      for (const s of streams) { try { s.tailer.stop(); s.res.end(); } catch { /* gone */ } }
      streams.clear();
      server.close(() => resolve());
    }),
  };
}
