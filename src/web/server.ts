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
import {
  answerFromLog, chatHistory, classifyMessage, draftCard, recordCardDecision,
  recordChatMessage, wantsTightening, MissionCard,
} from '../mission/chat';
import { EventTailer, cursorFromLastId, eventId, SSE_CHANNEL } from './tail';
import { UI_HTML } from './ui';
import { listProjects, freeSlug, slugForUrl, slugify, isProject } from '../projects';
import { routeFor, carriesCredentials, draftCreationCard, CreationCard } from '../create';
import { extractZip, DEFAULT_ZIP_LIMITS } from '../zip';

export interface WebServerOptions {
  projectRoot: string;
  stateRoot: string;
  projectId: string;
  port?: number;
  host?: string;
  /** Injected so tests drive the server without a real engine or CLI. */
  spawnRun?: (missionId: string) => { ok: boolean; pid: number | null; detail: string };
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
        send(res, 200, { projectId: opts.projectId, events: chatHistory(store, opts.projectId) });
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
            // One channel name for every frame; the type is in the payload.
            res.write(`id: ${eventId(e)}\nevent: ${SSE_CHANNEL}\n`
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

  /** zeus init, then doctor — the same two steps every path ends with. */
  async function initialise(
    run: NonNullable<WebServerOptions['createRunner']>, target: string,
  ): Promise<{ ok: boolean; detail: string; isProject: boolean }> {
    const out = await run({ kind: 'init', cwd: target, args: ['init'] });
    return { ok: out.ok, detail: out.detail, isProject: isProject(target) };
  }

  /** The one place a mission is created. Chat calls this; so does the route. */
  function createMission(goal: string) {
    const head = (() => {
      try {
        return require('child_process').execFileSync('git',
          ['-C', opts.projectRoot, 'rev-parse', 'HEAD'],
          { encoding: 'utf8', timeout: 15_000 }).trim();
      } catch { return 'unknown'; }
    })();
    return missions.create(goal, head);
  }

  async function handleWrite(url: URL, body: any, res: http.ServerResponse): Promise<void> {
    if (url.pathname === '/api/missions') {
      const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
      if (!goal) { send(res, 400, { error: 'GOAL_REQUIRED' }); return; }
      const rec = createMission(goal);
      send(res, 201, missionStatusView(missions, opts.projectRoot, rec.missionId));
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
        // Through the supervisor: bounded, killable, in the run registry.
        const cloned = await run({ kind: 'clone', cwd: opts.projectsRoot,
          args: ['clone', '--depth', '1', card.source, card.targetSlug] });
        if (!cloned.ok) {
          fs.rmSync(target, { recursive: true, force: true });
          send(res, 502, { error: 'CLONE_FAILED', detail: cloned.detail });
          return;
        }
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
        // ZERO provider calls on this path, by construction: the resolver only
        // reads the log. A chat that quietly bills for answering "what is the
        // status" is a chat nobody trusts to be asked twice.
        const answer = answerFromLog(missions, message);
        recordChatMessage(store, opts.projectId, {
          message, classification, led: answer.answered ? 'ANSWERED' : 'UNANSWERABLE',
        });
        send(res, 200, { intent: classification.intent, classification, answer, card: null });
        return;
      }

      const card = draftCard({ intent: classification.intent, message });
      recordChatMessage(store, opts.projectId, {
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
      const fresh = draftCard({
        intent: card.intent, message: card.originalGoal,
        proposedGoal: card.proposedGoal, proposalCostUsd: card.proposalCostUsd,
      });
      if (fresh.digest !== digest || card.digest !== digest) {
        recordCardDecision(store, opts.projectId, {
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
        const answer = answerFromLog(missions, card.originalGoal);
        recordCardDecision(store, opts.projectId, {
          cardDigest: digest, decision: 'ANSWERED_INSTEAD', missionId: null,
        });
        send(res, 200, { decision: 'answer', answer, missionId: null });
        return;
      }
      if (decision !== 'create') {
        recordCardDecision(store, opts.projectId, {
          cardDigest: digest, decision: 'CANCELLED', missionId: null,
        });
        send(res, 200, { decision, missionId: null });
        return;
      }

      const goal = (typeof body?.goal === 'string' && body.goal.trim())
        ? body.goal.trim() : (card.proposedGoal ?? card.originalGoal);
      // THE SAME create path W1b built. Chat has no private route to a mission.
      const rec = createMission(goal);
      recordCardDecision(store, opts.projectId, {
        cardDigest: digest, decision: 'CREATED', missionId: rec.missionId,
      });
      send(res, 201, { decision: 'create', missionId: rec.missionId,
        mission: missionStatusView(missions, opts.projectRoot, rec.missionId) });
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
