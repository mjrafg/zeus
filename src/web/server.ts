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
import { readConfig, writeConfig } from '../config';
import { MissionRegistry } from '../mission/registry';
import { isMissionId, isTaskId, scopeOf } from '../mission/types';
import {
  missionListView, missionReportView, missionStatusView, missionPhase,
  costBreakdown, integrationLine, spendReader,
} from '../views';
import { ensureToken, offeredToken, tokenMatches } from './token';
import {
  ConsentRequest, consentSubject, evaluateConsent, pendingDecision, awaitingHuman,
} from '../mission/consent';
import {
  CompileResult, PlanOperationResult, OperationContext, budgetsFor, liveRun,
} from '../mission/operations';
import { missionUsage, MissionBudgets } from '../mission/progress';
import {
  answerFromLog, chatHistory, classifyMessage, draftCard, recordCardDecision,
  recordChatMessage, wantsTightening, MissionCard, sanitiseCeiling,
} from '../mission/chat';
import { EventTailer, cursorFromLastId, eventId, SSE_CHANNEL } from './tail';
import { UI_HTML } from './ui';
import {
  listProjects, freeSlug, slugForUrl, slugify, isProject, scopeFor, ProjectScope,
} from '../projects';
import { routeFor, carriesCredentials, draftCreationCard, CreationCard } from '../create';
import { extractZip, DEFAULT_ZIP_LIMITS } from '../zip';

/**
 * The project a write acts on.
 *
 * Every capability that can spend money, spawn a process or accept a contract
 * takes one of these. It is a parameter and not a closure on purpose: the
 * console showed one project and compiled another, because `operations` was
 * built once around the directory the SERVER was started in and the request
 * scope never reached it. A capability bound to one project is a capability
 * that acts on the wrong one as soon as a second project exists.
 */
export interface ProjectTarget {
  projectId: string;
  root: string;
  stateRoot: string;
}

export interface WebServerOptions {
  projectRoot: string;
  stateRoot: string;
  projectId: string;
  port?: number;
  host?: string;
  /** Injected so tests drive the server without a real engine or CLI. */
  spawnRun?: (missionId: string, target: ProjectTarget)
  => { ok: boolean; pid: number | null; detail: string };
  /**
   * A directory of Zeus projects. Absent means the Projects home is off and
   * the server serves only the project it was started in.
   */
  projectsRoot?: string;
  /**
   * Runs a creation step (clone, init, doctor) through the supervisor.
   *
   * Injected so tests exercise the route without a network, and so the server
   * cannot acquire its own way of running commands.
   */
  createRunner?: (spec: { kind: 'clone' | 'init'; args: string[]; cwd: string })
  => Promise<{ ok: boolean; detail: string }>;
  /** Injected reader for git diffs, so the route is testable and read-only. */
  diff?: (from: string, to: string, cwd: string) => string;
  /**
   * The engine operations the write routes call.
   *
   * Injected rather than constructed here so the server cannot grow its own
   * copy: whatever is passed is the same function the CLI invokes.
   */
  operations?: {
    compile(missionId: string, target: ProjectTarget): Promise<CompileResult>;
    plan(missionId: string, target: ProjectTarget): Promise<PlanOperationResult>;
    evaluate(missionId: string, opts: { full: boolean }, target: ProjectTarget):
    Promise<unknown>;
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
  'GET /api/chat',
  'GET /api/projects',
  'GET /api/events/stream',
] as const;

export const WRITE_ROUTES = [
  'POST /api/missions',
  'POST /api/missions/:id/compile',
  'POST /api/missions/:id/plan',
  'POST /api/missions/:id/run',
  'POST /api/missions/:id/cancel',
  'POST /api/missions/:id/confirm',
  'POST /api/missions/:id/budget',
  'POST /api/missions/:id/evaluate',
  'POST /api/chat',
  'POST /api/chat/decide',
  'POST /api/projects/draft',
  'POST /api/projects/decide',
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
/**
 * How to invoke this CLI as a child process.
 *
 * Running from source means the entry point is TypeScript, which bare `node`
 * cannot execute — it dies on the first `import` with a SyntaxError. That is
 * not hypothetical: the project-creation path spawned `node …/cli.ts init`,
 * every `zeus init` failed silently, and cloned projects were left on disk
 * with no .zeus/ and no explanation. One helper now, so no caller has to
 * remember which of the two shapes it is in.
 *
 * TAKES NO ROOT. It used to resolve the runner against the project being
 * worked on, so `ts-node` was looked for in that project's node_modules —
 * which meant `mission run` worked in exactly one project, the one Zeus is
 * installed in, and died with MODULE_NOT_FOUND in every other. The runner is
 * Zeus's own dependency and comes from Zeus's own installation; the parameter
 * existed only to be passed the wrong value, so it is gone.
 */
export function zeusCliArgv(): string[] {
  const ts = path.resolve(__dirname, '..', 'cli.ts');
  if (fs.existsSync(ts)) {
    // __dirname is <zeus>/src/web, so two levels up is the installation.
    const zeusRoot = path.resolve(__dirname, '..', '..');
    return [path.resolve(zeusRoot, 'node_modules/.bin/ts-node'), '--transpile-only', ts];
  }
  return [path.resolve(__dirname, '..', 'cli.js')];
}

export function defaultSpawnRun(projectRoot: string, missionId: string):
  { ok: boolean; pid: number | null; detail: string } {
  const args = zeusCliArgv();
  // stdio was 'ignore'. A run that died in its first second reported "spawned
  // pid 65960" to the console and then simply never happened: no events, no
  // process, and nothing written down anywhere to say why. The console cannot
  // hold the pipes — the child outlives it by design — so they go to a file
  // under the project's own log directory, which is where an operator (or the
  // next question about a mission that did nothing) will look.
  const logDir = path.join(projectRoot, '.zeus', 'logs');
  let out: number | 'ignore' = 'ignore';
  let logFile: string | null = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `mission-run-${missionId.split('/').pop()}.log`);
    out = fs.openSync(logFile, 'a');
  } catch { out = 'ignore'; logFile = null; }
  try {
    const child = spawn(process.execPath, [...args, 'mission', 'run', missionId], {
      cwd: projectRoot, detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    if (typeof out === 'number') fs.closeSync(out);
    return { ok: true, pid: child.pid ?? null,
      detail: `spawned pid ${child.pid}${logFile ? `; output at ${logFile}` : ''}` };
  } catch (e: any) {
    if (typeof out === 'number') { try { fs.closeSync(out); } catch { /* already gone */ } }
    return { ok: false, pid: null, detail: e?.message ?? String(e) };
  }
}

/**
 * What stands between this mission and its next step, when nothing is pending.
 *
 * Three ways a mission reaches PLAN_CONSENT with no decision to take: the
 * critic REJECTED the plan (not decidable — a rejected plan cannot be accepted
 * by consent), the plan-recompile budget is spent, or a person already refused
 * and the next move is a fresh attempt. The console showed the same button for
 * all three, and it could only work in the last one.
 */
export function blockedBy(missions: MissionRegistry, missionId: string): {
  reason: string; detail: string; findings: unknown[]; options: string[];
} | null {
  const rec = missions.mission(missionId);
  if (!rec || rec.terminated) return null;
  const log = missions.events.read(missionId);
  const recorded = [...log].reverse().find((e) => e.type === 'PLAN_RECORDED');
  if (!recorded) return null;
  const version = (recorded.payload as any)?.version;
  const critique = [...log].reverse().find((e) => e.type === 'PLAN_CRITIQUED'
    && (e.payload as any)?.version === version);
  const cp = (critique?.payload ?? {}) as any;
  if (rec.acceptedPlanVersion === version) return null;

  const budgets = budgetsFor(missions, missionId);
  const usage = missionUsage(log, Date.now(), spendReader(missions));
  const exhausted = usage.planRecompiles >= budgets.maxPlanRecompiles;

  if (cp.acceptance === 'REJECT') {
    return {
      reason: exhausted ? 'REJECTED_AND_EXHAUSTED' : 'PLAN_REJECTED',
      detail: exhausted
        ? `the critic rejected plan v${version}, and ${usage.planRecompiles} of `
          + `${budgets.maxPlanRecompiles} plan attempts are spent`
        : `the critic rejected plan v${version}; a rejected plan cannot be accepted by consent`,
      findings: (cp.findings ?? []),
      options: exhausted
        ? ['raise maxPlanRecompiles and plan again', 'narrow the goal', 'cancel the mission']
        : ['plan again', 'narrow the goal', 'cancel the mission'],
    };
  }
  if (exhausted) {
    return {
      reason: 'PLAN_BUDGET_EXHAUSTED',
      detail: `${usage.planRecompiles} of ${budgets.maxPlanRecompiles} plan attempts are spent`,
      findings: (cp.findings ?? []),
      options: ['raise maxPlanRecompiles and plan again', 'narrow the goal', 'cancel the mission'],
    };
  }
  return null;
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
  /**
   * Operations running right now, by mission.
   *
   * compile and plan are minutes long. Answering them synchronously behind a
   * proxy that gives up at 100 seconds meant the console reported a failure
   * for work that had succeeded — and the operator, told it had failed, did it
   * again. The request now returns 202 and this is what says it is still going.
   */
  const inFlight = new Map<string, { kind: string; since: string }>();

  /**
   * The project a request is about.
   *
   * `?project=<slug>` selects one from the projects root; without it the
   * server answers about the project it was started in, which is what every
   * caller did before switching existed. Resolved per request from the
   * filesystem — a server that cached this would keep serving a project that
   * had been removed.
   */
  const scoped = (url: URL): { store: EventStore; missions: MissionRegistry;
    projectId: string; root: string; stateRoot: string } | null => {
    const slug = url.searchParams.get('project');
    if (!slug) {
      return { store, missions, projectId: opts.projectId,
        root: opts.projectRoot, stateRoot: opts.stateRoot };
    }
    if (!opts.projectsRoot) return null;
    const sc: ProjectScope | null = scopeFor(opts.projectsRoot, slug);
    if (!sc) return null;
    const s2 = new EventStore(sc.stateRoot);
    return {
      store: s2,
      missions: new MissionRegistry({ events: s2, projectId: sc.projectId, stateRoot: sc.stateRoot }),
      projectId: sc.projectId, root: sc.root, stateRoot: sc.stateRoot,
    };
  };

  /** The scope of a request, as the thing a capability is allowed to act on. */
  const targetOf = (sc: { projectId: string; root: string; stateRoot: string }):
  ProjectTarget => ({ projectId: sc.projectId, root: sc.root, stateRoot: sc.stateRoot });

  const resolveId = (raw: string, projectId: string): string =>
    (raw.includes('/') ? raw : `${projectId}/${raw}`);

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
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        const recs = missionListView(sc.missions);
        send(res, 200, recs.map((r) => ({
          ...r, projectSlug: url.searchParams.get('project') ?? null,
          phase: missionPhase(sc.store.read(r.missionId)),
          // Same predicate the detail view uses. One implementation, two views:
          // a list that disagreed with the page it links to would be worse
          // than a list with no marker at all.
          awaitingHuman: awaitingHuman(sc.missions, r.missionId),
        })));
        return;
      }

      const missionMatch = /^\/api\/missions\/([^/]+)(\/(events|report))?$/.exec(url.pathname);
      if (method === 'GET' && missionMatch) {
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        const id = resolveId(decodeURIComponent(missionMatch[1]), sc.projectId);
        if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
        const sub = missionMatch[3];

        if (sub === 'events') {
          const events = sc.store.read(id);
          const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
          const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 1000);
          // Served exactly as stored: the redacting sink already ran at append
          // time, so there is nothing left to strip and nothing to re-decide.
          send(res, 200, { total: events.length, offset, limit,
            events: events.slice(offset, offset + limit) });
          return;
        }
        if (sub === 'report') {
          const view = missionReportView(sc.missions, id);
          if (!view) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
          send(res, 200, view);
          return;
        }
        const view = missionStatusView(sc.missions, sc.root, id);
        if (!view) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
        send(res, 200, {
          ...view,
          phase: missionPhase(sc.store.read(id)),
          cost: costBreakdown(sc.missions, id),
          // `budgets` rides in the view itself, because it is part of the
          // record. Usage is a LIVE READING — it carries elapsed wall-clock —
          // so it is a decoration like phase and cost, and it is exactly what
          // checkMissionBudgets is handed. The gauge on the page therefore
          // cannot disagree with the limit that binds.
          usage: missionUsage(sc.store.read(id), Date.now(), spendReader(sc.missions)),
          // What is happening to this mission RIGHT NOW, so a button can refuse
          // to be pressed twice. A run is another process and is derived from
          // the log; compile and plan are this one, and are held in memory.
          running: (() => {
            const busy = inFlight.get(id);
            if (busy) return { kind: busy.kind, since: busy.since, pid: null };
            const held = liveRun(sc.missions, id);
            return held && held.alive
              ? { kind: 'run', since: held.startedAt, pid: held.pid } : null;
          })(),
          // Reconstructed, not remembered. A refresh, a reconnect or arriving
          // an hour later all show the same thing, because it comes from the
          // log rather than from the moment the stop happened.
          pendingDecision: pendingDecision(sc.missions, id),
          // Why there is no next step, when there is none.
          //
          // A plan the critic REJECTED is not decidable by consent, so the
          // pending block is null — and the console filled that silence with a
          // "plan again" button. The findings that actually stand were on the
          // log and on no screen. A dead end has to say what it is.
          blockedBy: blockedBy(sc.missions, id),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/projects') {
        if (!opts.projectsRoot) {
          send(res, 200, { projectsRoot: null, projects: [],
            detail: 'this server was started inside a single project; no projects root is configured' });
          return;
        }
        send(res, 200, { projectsRoot: opts.projectsRoot, projects: listProjects(opts.projectsRoot) });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/chat') {
        // History IS the log. Nothing is stored anywhere else, which is what
        // makes it survive a restart and sit beside the missions it created.
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        send(res, 200, { projectId: sc.projectId, events: chatHistory(sc.store, sc.projectId) });
        return;
      }

      const consentMatch = /^\/api\/missions\/([^/]+)\/consent$/.exec(url.pathname);
      if (method === 'GET' && consentMatch) {
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        const id = resolveId(decodeURIComponent(consentMatch[1]), sc.projectId);
        if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
        const oracle = consentSubject(sc.missions, id, 'oracle');
        const plan = consentSubject(sc.missions, id, 'plan');
        if (!oracle) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
        send(res, 200, { missionId: id, oracle, plan });
        return;
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && taskMatch) {
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        const id = resolveId(decodeURIComponent(taskMatch[1]), sc.projectId);
        if (!isTaskId(id)) { send(res, 400, { error: 'NOT_A_TASK_ID', id }); return; }
        let events: StoredEvent[] = [];
        try { events = sc.store.read(id); } catch { events = []; }
        if (!events.length) { send(res, 404, { error: 'NO_SUCH_TASK', id }); return; }
        send(res, 200, { taskId: id, events });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/files/diff') {
        const sc = scoped(url);
        if (!sc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
        const task = url.searchParams.get('task');
        const mission = url.searchParams.get('mission');
        if (task) {
          const id = resolveId(task, sc.projectId);
          if (!isTaskId(id)) { send(res, 400, { error: 'NOT_A_TASK_ID', id }); return; }
          const created = sc.store.read(id).find((e) => e.type === 'TASK_CREATED');
          const worktree = (created?.payload as any)?.worktree ?? sc.root;
          const base = (created?.payload as any)?.baseSha ?? 'HEAD';
          send(res, 200, { taskId: id, from: base, to: 'HEAD',
            diff: diff(base, 'HEAD', worktree) });
          return;
        }
        if (mission) {
          const id = resolveId(mission, sc.projectId);
          const rec = sc.missions.mission(id);
          if (!rec) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
          const line = integrationLine(rec);
          send(res, 200, { missionId: id, ...line,
            diff: diff(line.from, line.to, sc.root) });
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
            // One channel name for every frame; the type is in the payload.
            res.write(`id: ${eventId(e)}\nevent: ${SSE_CHANNEL}\n`
              + `data: ${JSON.stringify(e)}\n\n`);
          }
        };
        const sc = scoped(url) ?? { store, missions, projectId: opts.projectId, root: opts.projectRoot };
        const tailer = new EventTailer({ store: sc.store, onEvents: write });
        // Replay from the LOG at the client's cursor, then stream. A resuming
        // client misses nothing, because the socket was never the record.
        if (lastId) tailer.seek(cursorFromLastId(sc.store, lastId));
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

  /** zeus init, then doctor — the same two steps every path ends with. */
  async function initialise(
    run: NonNullable<WebServerOptions['createRunner']>, target: string,
  ): Promise<{ ok: boolean; detail: string; isProject: boolean }> {
    const out = await run({ kind: 'init', cwd: target, args: ['init'] });
    return { ok: out.ok, detail: out.detail, isProject: isProject(target) };
  }

  /** The one place a mission is created. Chat calls this; so does the route. */
  function createMission(goal: string,
    sc: { missions: MissionRegistry; root: string },
    budgets: Partial<MissionBudgets> = {}) {
    const head = (() => {
      try {
        return require('child_process').execFileSync('git',
          ['-C', sc.root, 'rev-parse', 'HEAD'],
          { encoding: 'utf8', timeout: 15_000 }).trim();
      } catch { return 'unknown'; }
    })();
    return sc.missions.create(goal, head, budgets);
  }

  async function handleWrite(url: URL, body: any, res: http.ServerResponse): Promise<void> {
    // The project a write is about, exactly like a read. Scoping only the read
    // routes meant the console showed one project and wrote to another: a
    // mission created from a freshly cloned project's chat landed in the
    // project the SERVER happened to sit in, and the page that asked for it
    // stayed empty. A view and a write that disagree about their subject is
    // the worst kind of working.
    const wsc = scoped(url);
    if (!wsc) { send(res, 404, { error: 'NO_SUCH_PROJECT' }); return; }
    if (url.pathname === '/api/missions') {
      const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
      if (!goal) { send(res, 400, { error: 'GOAL_REQUIRED' }); return; }
      const rec = createMission(goal, wsc, body?.costCeilingUsd === undefined
        ? {} : { costCeilingUsd: sanitiseCeiling(body.costCeilingUsd) });
      send(res, 201, missionStatusView(wsc.missions, wsc.root, rec.missionId));
      return;
    }

    if (url.pathname === '/api/projects/draft') {
      if (!opts.projectsRoot) { send(res, 503, { error: 'NO_PROJECTS_ROOT' }); return; }
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      const hasAttachment = body?.hasAttachment === true;
      const decision = routeFor({ message, hasAttachment });
      const desired = decision.route === 'CLONE' ? slugForUrl(message)
        : decision.route === 'ZIP' ? slugify(String(body?.filename ?? 'upload').replace(/\.zip$/i, ''))
          : slugify(message.split(/\s+/).slice(0, 4).join('-'));
      const card = draftCreationCard({
        route: decision.route, source: message || String(body?.filename ?? 'upload'),
        projectsRoot: opts.projectsRoot,
        targetSlug: freeSlug(opts.projectsRoot, desired),
        limits: DEFAULT_ZIP_LIMITS,
      });
      // A card is a PROPOSAL. Nothing is created on this path, ever.
      send(res, 200, { route: decision.route, decision, card });
      return;
    }

    if (url.pathname === '/api/projects/decide') {
      if (!opts.projectsRoot) { send(res, 503, { error: 'NO_PROJECTS_ROOT' }); return; }
      const card = body?.card as CreationCard | undefined;
      const digest = String(body?.cardDigest ?? '');
      const decisionId = String(body?.decision ?? '');
      if (!card || !digest || !decisionId) {
        send(res, 400, { error: 'CARD_DECISION_INCOMPLETE' }); return;
      }
      const fresh = draftCreationCard({
        route: card.route, source: card.source, projectsRoot: opts.projectsRoot,
        targetSlug: card.targetSlug, limits: DEFAULT_ZIP_LIMITS,
      });
      // The confirm-with-hash rule, fourth deployment.
      if (fresh.digest !== digest || card.digest !== digest) {
        send(res, 409, {
          error: 'CARD_DIGEST_MISMATCH',
          detail: 'the card changed since it was rendered to you — read it again before deciding',
          current: fresh,
        });
        return;
      }
      if (decisionId === 'cancel') { send(res, 200, { decision: 'cancel', created: null }); return; }

      // A credentialed URL never reaches a command line.
      if (card.route === 'CLONE' && carriesCredentials(card.source)) {
        send(res, 400, {
          error: 'CREDENTIALED_URL_REFUSED',
          detail: 'this URL carries a credential. Use an SSH agent or a public URL — '
            + 'a secret in a URL reaches process listings and the run registry.',
        });
        return;
      }

      const target = path.join(opts.projectsRoot, card.targetSlug);
      if (fs.existsSync(target)) { send(res, 409, { error: 'TARGET_EXISTS', target }); return; }
      const run = opts.createRunner;
      if (!run) { send(res, 503, { error: 'CREATE_RUNNER_UNAVAILABLE' }); return; }

      if (card.route === 'CLONE') {
        // Temp-and-rename, like the archive path. A clone that succeeds and an
        // init that fails used to leave a complete checkout with no .zeus/ —
        // an orphan that looks like a project to a human and like nothing to
        // Zeus. Either the whole thing lands or none of it does.
        const staging = `${target}.incoming-${process.pid}`;
        fs.rmSync(staging, { recursive: true, force: true });
        const cloned = await run({ kind: 'clone', cwd: opts.projectsRoot,
          args: ['clone', '--depth', '1', card.source, path.basename(staging)] });
        if (!cloned.ok) {
          fs.rmSync(staging, { recursive: true, force: true });
          send(res, 502, { error: 'CLONE_FAILED', detail: cloned.detail });
          return;
        }
        const started = await initialise(run, staging);
        if (!started.ok || !started.isProject) {
          fs.rmSync(staging, { recursive: true, force: true });
          send(res, 502, {
            error: 'INIT_FAILED',
            detail: `the clone succeeded but zeus init did not: ${started.detail}`,
            cleanedUp: true,
          });
          return;
        }
        // `zeus init` derived the project name from the directory it ran in,
        // which was the staging name — so every project created this way was
        // called "<slug>.incoming-<pid>" for the rest of its life. Correct it
        // to the name the operator was shown on the card, before it lands.
        try {
          const cfg = readConfig(staging);
          if (cfg && cfg.project && cfg.project.name !== card.targetSlug) {
            cfg.project.name = card.targetSlug;
            writeConfig(staging, cfg);
          }
        } catch { /* a config we cannot read is caught by isProject below */ }
        fs.renameSync(staging, target);
        send(res, 201, { decision: 'create', route: 'CLONE', slug: card.targetSlug,
          target, initialised: { ...started, isProject: isProject(target) } });
        return;
      } else if (card.route === 'ZIP') {
        const raw = typeof body?.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!raw) { send(res, 400, { error: 'ARCHIVE_REQUIRED' }); return; }
        const result = extractZip(Buffer.from(raw, 'base64'), target, DEFAULT_ZIP_LIMITS);
        if (!result.ok) { send(res, 400, { error: 'ARCHIVE_REFUSED', detail: result.refusal, result }); return; }
        send(res, 201, { decision: 'create', route: 'ZIP', slug: card.targetSlug,
          target, extraction: result, initialised: await initialise(run, target) });
        return;
      } else {
        // DESCRIPTION: an empty project. Building the thing is a mission, and
        // a mission is what the next card is for — there is no scaffold path.
        fs.mkdirSync(target, { recursive: true });
        await run({ kind: 'clone', cwd: target, args: ['init', '-q', '-b', 'main', '.'] });
      }

      const initialised = await initialise(run, target);
      const payload: Record<string, unknown> = {
        decision: 'create', route: card.route, slug: card.targetSlug, target, initialised,
      };
      if (card.route === 'DESCRIPTION') {
        // Hand off to the SAME mission card W1c built, goal prefilled.
        payload.missionCard = draftCard({ intent: 'WORK', message: card.source });
        payload.handoff = 'the project is empty; accept the mission card to build it';
      }
      send(res, 201, payload);
      return;
    }

    if (url.pathname === '/api/chat') {
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) { send(res, 400, { error: 'MESSAGE_REQUIRED' }); return; }
      const classification = classifyMessage(message);

      if (classification.intent === 'QUESTION') {
        // eslint-disable-next-line no-unused-vars
        // ZERO provider calls on this path, by construction: the resolver only
        // reads the log. A chat that quietly bills for answering "what is the
        // status" is a chat nobody trusts to be asked twice.
        const answer = answerFromLog(wsc.missions, message);
        recordChatMessage(wsc.store, wsc.projectId, {
          message, classification, led: answer.answered ? 'ANSWERED' : 'UNANSWERABLE',
        });
        send(res, 200, { intent: classification.intent, classification, answer, card: null });
        return;
      }

      const card = draftCard({ intent: classification.intent, message,
        costCeilingUsd: body?.costCeilingUsd ?? null });
      recordChatMessage(wsc.store, wsc.projectId, {
        message, classification, led: 'CARD_DRAFTED', cardDigest: card.digest,
      });
      // A card is a PROPOSAL. Nothing is created here, in any branch.
      send(res, 200, {
        intent: classification.intent, classification, card, answer: null,
        tighteningOffered: wantsTightening(message),
      });
      return;
    }

    if (url.pathname === '/api/chat/decide') {
      const card = body?.card as MissionCard | undefined;
      const digest = String(body?.cardDigest ?? '');
      const decision = String(body?.decision ?? '');
      if (!card || !digest || !decision) {
        send(res, 400, { error: 'CARD_DECISION_INCOMPLETE' }); return;
      }
      // The confirm-with-hash rule, third deployment. The card the user
      // answered must be the card that exists; a re-drafted card is a
      // different proposal and answering the old one approves nothing.
      // Re-drafted from the CARD's own budget, not from anything the request
      // sent alongside it. That is what makes the ceiling part of what was
      // confirmed: a budget raised between rendering and approval produces a
      // different digest, and this refuses it.
      const fresh = draftCard({
        intent: card.intent, message: card.originalGoal,
        proposedGoal: card.proposedGoal, proposalCostUsd: card.proposalCostUsd,
        costCeilingUsd: card.budget ? card.budget.costCeilingUsd : null,
      });
      if (fresh.digest !== digest || card.digest !== digest) {
        recordCardDecision(wsc.store, wsc.projectId, {
          cardDigest: digest, decision: 'REFUSED_DIGEST_MISMATCH', missionId: null,
          detail: 'the card changed since it was rendered',
        });
        send(res, 409, {
          error: 'CARD_DIGEST_MISMATCH',
          detail: 'the card changed since it was rendered to you — read it again before deciding',
          current: fresh,
        });
        return;
      }

      if (decision === 'answer') {
        const answer = answerFromLog(wsc.missions, card.originalGoal);
        recordCardDecision(wsc.store, wsc.projectId, {
          cardDigest: digest, decision: 'ANSWERED_INSTEAD', missionId: null,
        });
        send(res, 200, { decision: 'answer', answer, missionId: null });
        return;
      }
      if (decision !== 'create') {
        recordCardDecision(wsc.store, wsc.projectId, {
          cardDigest: digest, decision: 'CANCELLED', missionId: null,
        });
        send(res, 200, { decision, missionId: null });
        return;
      }

      const goal = (typeof body?.goal === 'string' && body.goal.trim())
        ? body.goal.trim() : (card.proposedGoal ?? card.originalGoal);
      // THE SAME create path W1b built. Chat has no private route to a mission.
      const rec = createMission(goal, wsc,
        { costCeilingUsd: card.budget.costCeilingUsd });
      recordCardDecision(wsc.store, wsc.projectId, {
        cardDigest: digest, decision: 'CREATED', missionId: rec.missionId,
      });
      send(res, 201, { decision: 'create', missionId: rec.missionId,
        mission: missionStatusView(wsc.missions, wsc.root, rec.missionId) });
      return;
    }

    const m = /^\/api\/missions\/([^/]+)\/(compile|plan|run|cancel|confirm|evaluate|budget)$/
      .exec(url.pathname);
    if (!m) { send(res, 404, { error: 'NO_SUCH_ROUTE', path: url.pathname }); return; }
    const id = resolveId(decodeURIComponent(m[1]), wsc.projectId);
    if (!isMissionId(id)) { send(res, 400, { error: 'NOT_A_MISSION_ID', id }); return; }
    if (!wsc.missions.mission(id)) { send(res, 404, { error: 'NO_SUCH_MISSION', id }); return; }
    const action = m[2];

    if (action === 'compile' || action === 'plan' || action === 'evaluate') {
      if (!opts.operations) {
        send(res, 503, { error: 'OPERATIONS_UNAVAILABLE',
          detail: 'this server was started without engine operations' });
        return;
      }
      const t = targetOf(wsc);
      const busy = inFlight.get(id);
      if (busy) {
        send(res, 409, { error: 'ALREADY_RUNNING', missionId: id, kind: busy.kind,
          since: busy.since,
          detail: `${busy.kind} has been running on this mission since ${busy.since}` });
        return;
      }
      const started = new Date().toISOString();
      inFlight.set(id, { kind: action, since: started });
      const ops = opts.operations;
      // DETACHED FROM THE REQUEST, not from the process: the operation runs to
      // completion here, and its result goes to the LOG. The response says
      // only that it started, because that is the only thing true yet.
      void (async () => {
        try {
          const result: any = action === 'compile' ? await ops.compile(id, t)
            : action === 'plan' ? await ops.plan(id, t)
              : await ops.evaluate(id, { full: body?.full === true }, t);
          // Refusals the operation already recorded stay its own account of
          // itself. This adds the ones that reach no event at all — a budget
          // stop, a provider outage — so the page is never left guessing.
          if (result && result.ok === false) {
            wsc.missions.recordOperation(id, { kind: action, ok: false,
              detail: `${result.kind}: ${result.detail ?? ''}`.trim() });
          } else {
            wsc.missions.recordOperation(id, { kind: action, ok: true, detail: 'completed' });
          }
        } catch (e: any) {
          wsc.missions.recordOperation(id, { kind: action, ok: false,
            detail: `THREW: ${e?.message ?? e}` });
        } finally {
          inFlight.delete(id);
        }
      })();
      send(res, 202, { missionId: id, kind: action, started,
        detail: 'it runs on the server; the mission page is rebuilt from the log' });
      return;
    }

    if (action === 'run') {
      const spawnRun = opts.spawnRun;
      if (!spawnRun) { send(res, 503, { error: 'SPAWN_UNAVAILABLE' }); return; }
      // The console spawned a runner on every click and never asked whether one
      // was already going. Two clicks, two processes, one mission: the same
      // node built twice, paid for twice, and an integration written into a
      // mission the other process had terminated.
      const held = liveRun(wsc.missions, id);
      if (held && held.alive) {
        send(res, 409, { error: 'ALREADY_RUNNING', missionId: id,
          pid: held.pid, startedAt: held.startedAt,
          detail: `pid ${held.pid} has been running this mission since ${held.startedAt}` });
        return;
      }
      // DETACHED, always. A mission outlives the console by design.
      const spawned = spawnRun(id, targetOf(wsc));
      send(res, spawned.ok ? 202 : 500, { missionId: id, ...spawned });
      return;
    }

    // ---- budget: raising or lowering a limit, on the record ---------------
    //
    // The only way to change a budget was `zeus mission confirm --raise-budget`,
    // which raises the ceiling to exactly the planner's estimate. A console
    // that can spend money and cannot say how much is allowed to leaves the
    // one decision that bounds the spending in a terminal.
    if (action === 'budget') {
      const limit = String(body?.limit ?? 'costCeilingUsd');
      const before = budgetsFor(wsc.missions, id) as unknown as Record<string, number>;
      if (!(limit in before) || typeof before[limit] !== 'number') {
        send(res, 400, { error: 'NO_SUCH_LIMIT', limit,
          detail: `not a mission budget; known limits are ${Object.keys(before).join(', ')}` });
        return;
      }
      const to = Number(body?.to);
      if (!Number.isFinite(to) || to <= 0) {
        send(res, 400, { error: 'BAD_LIMIT',
          detail: 'a limit must be a positive, finite number' });
        return;
      }
      const reason = typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim() : 'revised from the control center';
      if (to === before[limit]) {
        send(res, 200, { missionId: id, limit, unchanged: true, budgets: before });
        return;
      }
      wsc.missions.reviseBudget(id, {
        limit, from: before[limit], to, reason, decidedBy: 'user-confirmed',
      });
      send(res, 200, { missionId: id, limit, from: before[limit], to,
        budgets: budgetsFor(wsc.missions, id) });
      return;
    }

    if (action === 'cancel') {
      const reason = typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim() : 'cancelled from the control center';
      // The same cross-process path `zeus cancel` uses: the spawned mission is
      // a different OS process, and the run registry is how it is reached.
      const outcome = wsc.missions.cancel(id, reason);
      send(res, 200, { missionId: id, ...outcome });
      return;
    }

    // ---- confirm: the consent boundary ------------------------------------
    const req: ConsentRequest = {
      kind: body?.kind, version: Number(body?.version),
      findingsDigest: String(body?.findingsDigest ?? ''),
      decision: body?.decision,
    };
    const verdict = evaluateConsent(wsc.missions, id, req);
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

    if (req.decision === 'ABORT') {
      // Cancelling is a decision, and it goes through the same cross-process
      // path `zeus cancel` uses so a live run is actually reached.
      const outcome = wsc.missions.cancel(id, `cancelled at the ${subject.kind} consent stop`);
      wsc.missions.recordPlanStopDecision(id, {
        version: subject.version, rendered, findingsDigest: subject.digest,
        decision: 'ABORTED', decidedBy: 'user-confirmed', deferred: false,
      });
      send(res, 200, { missionId: id, decision: 'ABORT', kind: subject.kind,
        version: subject.version, ...outcome });
      return;
    }

    if (req.decision === 'REFUSE') {
      wsc.missions.recordPlanStopDecision(id, {
        version: subject.version, rendered, findingsDigest: subject.digest,
        decision: subject.kind === 'plan' ? 'REFUSED_NO_CONSENT' : 'ORACLE_REFUSED',
        decidedBy: 'user-confirmed', deferred: false,
      });
      send(res, 200, { missionId: id, decision: 'REFUSE', kind: subject.kind,
        version: subject.version });
      return;
    }

    if (subject.kind === 'oracle') {
      const rec = wsc.missions.mission(id)!;
      const oracle = rec.oracle as any;
      wsc.missions.acceptOracle(id, {
        acceptanceMode: oracle?.acceptanceMode ?? 'REQUIRED_CONSENT',
        acceptedBy: 'user-confirmed',
        modeInputs: { confirmedFromWeb: true, findingsDigest: subject.digest },
        modeReasons: [`a human confirmed this oracle with ${subject.findings.length} finding(s) standing`],
        escalatedByCritic: false,
        acceptedDespite: subject.findings as Array<{ code: string; criterionId?: string }>,
      });
    } else {
      const recorded = [...wsc.missions.events.read(id)].reverse()
        .find((e) => e.type === 'PLAN_RECORDED'
          && (e.payload as any)?.version === subject.version)!;
      const graph = (recorded.payload as any).plan;
      wsc.missions.acceptPlan(id, graph, {
        acceptedBy: 'user-confirmed', acceptedDespite: rendered,
      });
    }
    wsc.missions.recordPlanStopDecision(id, {
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
