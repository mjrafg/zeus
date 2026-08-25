/**
 * Control Center, stage W1a: the read API and the live stream.
 *
 * No real provider is called and no mission runs here. The point of these
 * tests is the HTTP boundary itself — that it authenticates, that it binds
 * where it says, that it never grew a second serializer, and above all that a
 * reconnecting client misses nothing because the LOG is the record and the
 * socket is not.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { EventStore } from '../src/engine/events';
import { MissionRegistry } from '../src/mission/registry';
import {
  startWebServer, RunningServer, routeTable, READ_ROUTES, WRITE_ROUTES, zeusCliArgv,
  blockedBy,
} from '../src/web/server';
import { ensureToken, tokenMatches, tokenPath } from '../src/web/token';
import {
  eventId, parseEventId, cursorFromLastId, since, advance, SSE_CHANNEL,
} from '../src/web/tail';
import { UI_HTML } from '../src/web/ui';
import {
  missionStatusView, missionReportView, missionBundle, missionTrace, compareCalls,
} from '../src/views';
import {
  findingsDigest, pendingDecision, awaitingHuman, consentSubject,
} from '../src/mission/consent';
import {
  compileMissionOracle, recompileMissionOracle, MAX_ORACLE_RECOMPILES,
} from '../src/mission/operations';
import { answerFromLog,
  draftCard, wantsTightening, chatHistory,
  sanitiseCeiling, MAX_CARD_CEILING_USD,
} from '../src/mission/chat';
import { scopeOf, TaskNode } from '../src/mission/types';
const node = (id: string): TaskNode => ({ nodeId: id, description: 'd', dependsOn: [],
  preconditions: [], reads: [], writes: [], affectedCriteria: [], predictedEffects: [],
  estimatedTier: 'FAST', estimatedCost: 1, risk: 'LOW' });
import { routeFor, carriesCredentials, draftCreationCard } from '../src/create';
import { extractZip } from '../src/zip';
import { readConfig } from '../src/config';
import { assemble, checklist } from '../src/mission/context';
import {
  resolveTraceLevel, retains, TraceStore, MAX_BLOB_BYTES,
} from '../src/trace';
import { traceLevelFor } from '../src/mission/operations';
import { detectProject, nodePackageDirs } from '../src/adapters';
import {
  PIPELINE_STAGES, STAGE_ROLE, ZEUS_DEFAULT_ROUTING, resolveRouting,
  validateRouting, codexCapability,
} from '../src/routing';
import { ZEUS_WORKTREE_EXCLUDES, ZEUS_PATHSPEC_EXCLUDES } from '../src/engine/orchestrator';
import { splitCommand } from '../src/engine/dependencies';
import {
  budgetsFor, preflightBudget, planMissionGraph, liveRun, priorPlanFor, autoReplanState,
} from '../src/mission/operations';
import { planDelta } from '../src/mission/planner';
import { classifyInfrastructure } from '../src/engine/providers';
import {
  mergeMissionBudgets, checkMissionBudgets, autoReplansExhausted, missionUsage,
} from '../src/mission/progress';
import { probePackageManager } from '../src/readiness';
import {
  listProjects, projectBySlug, slugForUrl, slugify, freeSlug, scopeFor,
} from '../src/projects';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-web-'));
let seq = 0;

interface Fixture { root: string; state: string; store: EventStore; missions: MissionRegistry }

function fixture(): Fixture {
  const root = path.join(TMP, `p${seq += 1}`);
  const state = path.join(root, '.zeus', 'state');
  fs.mkdirSync(state, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const store = new EventStore(state);
  return { root, state, store, missions: new MissionRegistry({ events: store, projectId: 'p', stateRoot: state }) };
}

/** A tiny stdlib client, so the tests add no dependency either. */
function get(url: string, headers: Record<string, string> = {}):
  Promise<{ status: number; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
    }).on('error', reject);
  });
}

function post(server: RunningServer, p: string, body: unknown):
  Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const u = new URL(server.url + p);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { authorization: `Bearer ${server.token}`,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Opens an SSE stream and collects event ids until `want` arrive. */
function stream(url: string, want: number, timeoutMs = 8_000):
  Promise<{ ids: string[]; types: string[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const ids: string[] = [];
    const types: string[] = [];
    const req = http.get(url, (res) => {
      let buf = '';
      const done = () => { try { req.destroy(); } catch { /* gone */ } resolve({ ids, types, close: () => req.destroy() }); };
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          if (id) { ids.push(id); types.push(type ?? ''); }
        }
        if (ids.length >= want) done();
      });
      res.on('end', done);
    });
    req.on('error', reject);
    setTimeout(() => { try { req.destroy(); } catch { /* gone */ } resolve({ ids, types, close: () => {} }); }, timeoutMs);
  });
}

export async function webSuite(): Promise<void> {
  section('control center: the token is required, and it is a real secret');
  {
    const fx = fixture();
    const first = ensureToken(fx.state);
    const again = ensureToken(fx.state);
    check('WT1: a token is generated on first use and reused after',
      first.created && !again.created && first.token === again.token, first.token.slice(0, 8));
    check('WT2: it is long enough to be worth having',
      first.token.length >= 32, String(first.token.length));
    const mode = fs.statSync(tokenPath(fx.state)).mode & 0o777;
    check('WT3: it is stored owner-only', mode === 0o600, mode.toString(8));
    check('WT4: comparison is constant-time and length-safe',
      tokenMatches(first.token, first.token)
      && !tokenMatches(first.token, first.token.slice(0, -1))
      && !tokenMatches(first.token, null));

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const auth = { authorization: `Bearer ${server.token}` };
      const noTok = await get(`${server.url}/api/project`);
      const badTok = await get(`${server.url}/api/project`, { authorization: 'Bearer wrong' });
      const okTok = await get(`${server.url}/api/project`, auth);
      const streamNoTok = await get(`${server.url}/api/events/stream`);

      check('WA1: no token is 401', noTok.status === 401, String(noTok.status));
      check('WA2: a wrong token is 401', badTok.status === 401, String(badTok.status));
      check('WA3: the right token is 200', okTok.status === 200, String(okTok.status));
      check('WA4: the SSE stream is authenticated too — no unguarded firehose',
        streamNoTok.status === 401, String(streamNoTok.status));

      check('WB1: the default bind is loopback, asserted from the socket',
        server.address === '127.0.0.1', server.address);
    } finally { await server?.close(); }
  }

  section('control center: read routes are views of the log');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal', 'base0');
    fx.missions.recordPlan(rec.missionId, { version: 1, nodes: [] } as any);

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        diff: () => 'DIFF-FIXTURE',
      });
      const auth = { authorization: `Bearer ${server.token}` };
      const list = await get(`${server.url}/api/missions`, auth);
      const one = await get(`${server.url}/api/missions/M-0001`, auth);
      const events = await get(`${server.url}/api/missions/M-0001/events`, auth);
      const report = await get(`${server.url}/api/missions/M-0001/report`, auth);
      const missing = await get(`${server.url}/api/missions/M-0099`, auth);
      const notMission = await get(`${server.url}/api/missions/T-0001`, auth);

      check('WR1: the mission list is served', list.status === 200 && list.json.length === 1,
        JSON.stringify(list.json?.length));
      check('WR2: a short label resolves against the project id',
        one.status === 200 && one.json.missionId === rec.missionId, one.json?.missionId);
      check('WR3: events are served as stored, with paging',
        events.status === 200 && events.json.total === 2
        && events.json.events.length === 2, JSON.stringify(events.json?.total));
      check('WR4: the report route returns the claim ledger',
        report.status === 200 && report.json.mission.missionId === rec.missionId
        && Array.isArray(report.json.integrations));
      check('WR5: an unknown mission is 404, not an empty success',
        missing.status === 404, String(missing.status));
      check('WR6: a task id on the mission route is refused by scope, not guessed',
        notMission.status === 400 && notMission.json.error === 'NOT_A_MISSION_ID',
        JSON.stringify(notMission.json));

      // SERIALIZER REUSE: the API must not have grown its own shape.
      const view = missionStatusView(fx.missions, fx.root, rec.missionId)!;
      const apiCore = { ...one.json };
      // Only LIVE READINGS are deleted. `budgets` is not among them: it is
      // derived purely from the log and rides inside the view, so the CLI and
      // the console read one object rather than two that could drift.
      delete apiCore.phase; delete apiCore.cost; delete apiCore.pendingDecision;
      delete apiCore.usage; delete apiCore.running; delete apiCore.blockedBy;
      delete apiCore.abandonedRun; delete apiCore.trace;
      check('WS1: the API mission record deep-equals the CLI view — one serializer',
        JSON.stringify(apiCore) === JSON.stringify(JSON.parse(JSON.stringify(view))),
        'shapes identical');
      const repView = missionReportView(fx.missions, rec.missionId)!;
      check('WS2: and so does the report',
        JSON.stringify(report.json.mission) === JSON.stringify(JSON.parse(JSON.stringify(repView.mission))));

      const diff = await get(`${server.url}/api/files/diff?mission=M-0001`, auth);
      check('WF1: the diff route reads the mission integration line',
        diff.status === 200 && diff.json.diff === 'DIFF-FIXTURE'
        && diff.json.from === 'base0', JSON.stringify({ f: diff.json?.from }));
    } finally { await server?.close(); }
  }

  section('the console is the application, so it is never cached');
  {
    // A tab left open across a deploy ran yesterday's JavaScript against
    // today's API, with a dead event stream, and looked broken in ways nothing
    // on the server could explain. The response carried no cache directive at
    // all, which leaves browsers free to cache it heuristically.
    const srv = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'server.ts'), 'utf8');
    check('NC1: the console HTML is served no-store',
      /'cache-control': 'no-store, must-revalidate'/.test(srv), 'no-store present');
    const at = srv.indexOf("'cache-control'");
    const ui = srv.indexOf('const body = UI_HTML;');
    check('NC2: on the page itself, where the inline script lives',
      at > ui && at < ui + 600, 'on the / response');
  }

  section('control center: there is no write route for file content');
  {
    const table = routeTable();
    const writes = table.filter((r) => r.startsWith('POST'));
    check('WF2: no route writes project file content',
      !table.some((r) => /files/.test(r) && r.startsWith('POST')),
      table.filter((r) => /files/.test(r)).join(', '));
    check('WF3: the only file route is a GET',
      table.filter((r) => /files/.test(r)).every((r) => r.startsWith('GET ')));
    check('WF4: no route offers a consent bypass',
      !table.some((r) => /yes|force|skip/i.test(r)), writes.join(', '));
    check('WF5: read and write tables are declared separately, so a reviewer can see the split',
      READ_ROUTES.length === 15 && WRITE_ROUTES.length === 14,
      `${READ_ROUTES.length}/${WRITE_ROUTES.length}`);
  }

  section('control center: the log is the record, not the socket');
  {
    const fx = fixture();
    const rec = fx.missions.create('goal', 'base0');
    for (let i = 0; i < 5; i += 1) fx.missions.escalate(rec.missionId, { kind: `E${i}` });
    const all = fx.store.read(rec.missionId);

    check('WE1: an event id round-trips',
      parseEventId(eventId(all[2]))!.seq === all[2].seq
      && parseEventId(eventId(all[2]))!.taskId === rec.missionId);
    check('WE1b: a malformed id is rejected rather than guessed',
      parseEventId(null) === null && parseEventId('nonsense') === null
      && parseEventId('#3') === null);

    // Replay from an arbitrary point, over and over: no gaps, no duplicates.
    let clean = true;
    let detail = '';
    for (let cut = 0; cut <= all.length; cut += 1) {
      const cursor = cut === 0 ? {} : cursorFromLastId(fx.store, eventId(all[cut - 1]));
      const replayed = since(fx.store, cursor, [rec.missionId]);
      const expect = all.slice(cut).map((e) => e.seq);
      if (JSON.stringify(replayed.map((e) => e.seq)) !== JSON.stringify(expect)) {
        clean = false; detail = `cut ${cut}: ${replayed.map((e) => e.seq)} vs ${expect}`; break;
      }
    }
    check('WE2: replay from every possible disconnect point is exact — no gaps, no duplicates',
      clean, detail || `${all.length} cut points`);

    const cursor = advance({}, all);
    check('WE3: a cursor at the end yields nothing until something new is appended',
      since(fx.store, cursor, [rec.missionId]).length === 0);
    fx.missions.escalate(rec.missionId, { kind: 'later' });
    check('WE3b: and yields exactly the new event afterwards',
      since(fx.store, cursor, [rec.missionId]).length === 1);

    // A resuming client does not get the history of logs it never watched.
    const other = fx.missions.create('another', 'base0');
    fx.missions.escalate(other.missionId, { kind: 'unrelated' });
    const resumed = cursorFromLastId(fx.store, eventId(all[1]));
    check('WE4: resume replays the watched log, not every other log from the start',
      since(fx.store, resumed, [other.missionId]).length === 0,
      JSON.stringify(resumed));
  }

  section('control center: the live stream replays then continues');
  {
    const fx = fixture();
    const rec = fx.missions.create('goal', 'base0');
    fx.missions.escalate(rec.missionId, { kind: 'first' });
    const before = fx.store.read(rec.missionId);

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      // Resume from the very first event: everything after it must arrive.
      const resumeFrom = eventId(before[0]);
      const pending = stream(
        `${server.url}/api/events/stream?token=${encodeURIComponent(server.token)}`
        + `&lastEventId=${encodeURIComponent(resumeFrom)}`, 3, 6_000);
      // Appended AFTER the stream opened: these must arrive live, not by replay.
      await new Promise((r) => setTimeout(r, 200));
      fx.missions.escalate(rec.missionId, { kind: 'live-1' });
      fx.missions.escalate(rec.missionId, { kind: 'live-2' });
      const got = await pending;

      check('WV1: the replayed portion starts immediately after the client cursor',
        got.ids[0] === eventId(before[1]), got.ids[0] ?? '(nothing)');
      check('WV2: live events follow the replay, in order, with no duplicates',
        got.ids.length >= 3 && new Set(got.ids).size === got.ids.length
        && got.ids.length === got.ids.filter(Boolean).length,
        got.ids.join(' '));
      // This assertion used to require `event: MISSION_ESCALATED` — it asserted
      // the defect. A frame named after its own type never reaches onmessage,
      // so the browser received every event and rendered none. The contract is
      // one stable channel; the type travels in the payload.
      check('WV3: every frame is on the one channel a client can subscribe to',
        got.types.length > 0 && got.types.every((t) => t === SSE_CHANNEL),
        [...new Set(got.types)].join(','));
    } finally { await server?.close(); }
  }

  section('control center: the route table is closed');
  {
    const fx = fixture();
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const unknownWrite = await post(server, '/api/missions/M-0001/deploy', {});
      const unknownRead = await get(`${server.url}/api/anything`,
        { authorization: `Bearer ${server.token}` });
      check('WW1: a POST outside the route table is 404, never a default action',
        unknownWrite.status === 404, String(unknownWrite.status));
      check('WW2: and so is an unknown GET',
        unknownRead.status === 404, String(unknownRead.status));
      check('WW3: an unauthenticated write is refused before it is routed',
        (await new Promise<number>((resolve) => {
          const req = http.request(`${server!.url}/api/missions`, { method: 'POST' },
            (res) => { res.resume(); resolve(res.statusCode ?? 0); });
          req.end('{"goal":"x"}');
        })) === 401);
      check('WW4: and nothing was created by it',
        fx.missions.list().length === 0, String(fx.missions.list().length));
    } finally { await server?.close(); }
  }
  section('control center: the API is a client, not a second engine');
  {
    // TWIN FIXTURES. The same operation is driven once by the CLI and once by
    // the API, and the resulting event logs must agree. This is the test that
    // stops the web quietly growing its own opinion about when a contract is
    // accepted — the most important assertion in this file.
    const cliFx = fixture();
    const apiFx = fixture();
    const goal = 'a goal for the twins';

    const cliRec = cliFx.missions.create(goal, 'base0');

    let server: RunningServer | null = null;
    let created: any = null;
    try {
      server = await startWebServer({
        projectRoot: apiFx.root, stateRoot: apiFx.state, projectId: 'p', port: 0,
      });
      created = await post(server, '/api/missions', { goal });
    } finally { await server?.close(); }

    const cliEvents = cliFx.store.read(cliRec.missionId);
    const apiEvents = apiFx.store.read(created.json.missionId);
    const strip = (e: any) => ({ type: e.type, ...JSON.parse(JSON.stringify(e.payload)) });
    const norm = (e: any) => {
      const o = strip(e);
      delete o.createdAt; delete o.baseSha;   // clock and repo head differ by construction
      return o;
    };

    check('WC1: create through the API produces the same event types as the CLI',
      cliEvents.map((e) => e.type).join(',') === apiEvents.map((e) => e.type).join(','),
      `${cliEvents.map((e) => e.type)} vs ${apiEvents.map((e) => e.type)}`);
    check('WC2: and the same payloads, modulo the clock and the repository head',
      JSON.stringify(cliEvents.map(norm)) === JSON.stringify(apiEvents.map(norm)),
      JSON.stringify(apiEvents.map(norm)));
    check('WC3: the API returns the same record shape the CLI would print',
      created.status === 201 && created.json.missionId === 'p/M-0001'
      && created.json.goal === goal, JSON.stringify(created.json?.missionId));
    check('WC4: a create with no goal is refused rather than inventing one',
      true, 'checked below');
  }

  section('control center: consent over HTTP refuses what it cannot verify');
  {
    const fx = fixture();
    const rec = fx.missions.create('goal', 'base0');
    const oracle = {
      missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
      compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
      criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
        evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
        affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
    };
    fx.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
    const findings = [{ code: 'BEYOND_GOAL', criterionId: `${rec.missionId}/C-0001`, detail: 'too broad' }];
    fx.missions.recordCritique(rec.missionId, {
      valid: true, findings, modeOpinion: null, promptHash: 'p', hashes: {},
      violations: [], criticProviderId: 'mock', reconciliation: {},
    });

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const auth = { authorization: `Bearer ${server.token}` };
      const subject = await get(`${server.url}/api/missions/M-0001/consent`, auth);
      const digest = subject.json.oracle.digest;

      check('WD1: the consent route renders what a human must read, with a digest',
        subject.status === 200 && subject.json.oracle.findings.length === 1
        && typeof digest === 'string' && digest.length >= 16, JSON.stringify(digest));
      check('WD1b: the digest is stable across recomputation',
        digest === findingsDigest(findings), digest);
      check('WD1c: and changes when the findings change',
        findingsDigest(findings) !== findingsDigest([...findings, { code: 'X', detail: 'y' }]));

      const stale = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: 'deadbeefdeadbeefdeadbeefdeadbeef', decision: 'ACCEPT' });
      check('WD2: a stale digest is REFUSED',
        stale.status === 409 && stale.json.error === 'DIGEST_MISMATCH', JSON.stringify(stale.json?.error));
      check('WD2b: and the refusal returns the CURRENT findings to render',
        stale.json.current.findings.length === 1
        && stale.json.current.digest === digest, JSON.stringify(stale.json?.current?.digest));
      check('WD2c: nothing was accepted by the refused confirm',
        !fx.missions.mission(rec.missionId)!.oracleAccepted);

      const drifted = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 7, findingsDigest: digest, decision: 'ACCEPT' });
      check('WD3: a version the log does not hold is refused as drift, distinctly',
        drifted.status === 409 && drifted.json.error === 'VERSION_DRIFT',
        JSON.stringify(drifted.json?.error));

      const ok = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: digest, decision: 'ACCEPT' });
      check('WD4: the correct digest is accepted',
        ok.status === 200 && ok.json.decision === 'ACCEPT', JSON.stringify(ok.json));
      const after = fx.missions.mission(rec.missionId)!;
      check('WD4b: and it is recorded as user-confirmed, with the findings it stood despite',
        after.oracleAccepted && after.acceptedBy === 'user-confirmed'
        && after.acceptedDespite.length === 1, JSON.stringify(after.acceptedDespite));
      const stops = fx.store.read(rec.missionId).filter((e) => e.type === 'PLAN_STOP_DECISION');
      check('WD4c: the rendering the human saw is on the log, in the CLI shape',
        stops.length === 1 && (stops[0].payload as any).decision === 'ACCEPTED'
        && (stops[0].payload as any).rendered.length === 1,
        JSON.stringify((stops[0]?.payload as any)?.rendered));

      const again = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: digest, decision: 'ACCEPT' });
      check('WD5: confirming an already-accepted oracle is refused, not repeated',
        again.status === 409 && again.json.error === 'NOTHING_TO_CONFIRM',
        JSON.stringify(again.json?.error));

      const noPlan = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'plan', version: 1, findingsDigest: digest, decision: 'ACCEPT' });
      check('WD6: a plan with no critique on the log cannot be consented to',
        noPlan.status === 409 && noPlan.json.error === 'NOTHING_TO_CONFIRM',
        JSON.stringify(noPlan.json?.detail));

      const bad = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'nonsense', version: 1, findingsDigest: digest, decision: 'ACCEPT' });
      check('WD7: a malformed consent request is a 400, never a shrug',
        bad.status === 400 && bad.json.error === 'BAD_REQUEST', JSON.stringify(bad.json?.error));

      const noGoal = await post(server, '/api/missions', {});
      check('WC4b: a create with no goal is refused rather than inventing one',
        noGoal.status === 400 && noGoal.json.error === 'GOAL_REQUIRED', JSON.stringify(noGoal.json));
    } finally { await server?.close(); }
  }

  section('control center: run is detached, cancel is the cross-process path');
  {
    const fx = fixture();
    const rec = fx.missions.create('goal', 'base0');
    let server: RunningServer | null = null;
    const spawned: string[] = [];
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        spawnRun: (missionId) => { spawned.push(missionId); return { ok: true, pid: 4242, detail: 'spawned' }; },
      });
      const run = await post(server, '/api/missions/M-0001/run', {});
      check('WX1: run answers 202 — accepted for execution elsewhere, not completed here',
        run.status === 202 && run.json.pid === 4242, JSON.stringify(run.json));
      check('WX2: it spawned the mission rather than running it in the server process',
        spawned.join(',') === rec.missionId, spawned.join(','));

      const cancel = await post(server, '/api/missions/M-0001/cancel', { reason: 'from the console' });
      check('WX3: cancel goes through the registry path the CLI uses',
        cancel.status === 200 && cancel.json.cancelled === true, JSON.stringify(cancel.json));
      const after = fx.missions.mission(rec.missionId)!;
      check('WX4: and classifies CANCELLED, never a resource limit',
        after.terminated && after.terminationReason === 'CANCELLED',
        `${after.terminationReason}`);
      const types = fx.store.read(rec.missionId).map((e) => e.type);
      check('WX5: the cancel produced the same events the CLI cancel does',
        types.includes('CANCEL_REQUESTED') && types.includes('MISSION_TERMINATED'),
        types.join(','));

      const opless = await post(server, '/api/missions/M-0001/compile', {});
      check('WX6: an operation the server was not given is 503, not a stub success',
        opless.status === 503, String(opless.status));
    } finally { await server?.close(); }
  }
  section('chat: a card is a proposal, and only an accepted card creates');
  {
    const fx = fixture();
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        // The endpoint calls a provider now, so the server is given the same
        // injected operation the CLI supplies. Scripted here so what is under
        // test is Zeus's handling of a decision, not a model's ability to make
        // one.
        operations: {
          compile: async () => ({}) as any,
          plan: async () => ({}) as any,
          evaluate: async () => ({}),
          frontDoor: async (message: string) => ({
            intent: 'WORK_REQUEST' as const, confidence: 0.9,
            summary: 'asks for the failing tests to be fixed',
            evidenceUsed: [], answer: null, readings: null, degraded: null,
            proposedWork: { goal: message, orientation: null },
          }),
        },
      });
      const auth = { authorization: `Bearer ${server.token}` };
      const work = await post(server, '/api/chat', { message: 'fix the failing unit tests' });

      check('CC1: a work message produces a card',
        work.status === 200 && work.json.intent === 'WORK_REQUEST' && !!work.json.card,
        JSON.stringify(work.json?.intent));
      check('CC2: and creates NOTHING',
        fx.missions.list().length === 0, String(fx.missions.list().length));
      check('CC3: the card keeps the user’s own words, unrewritten',
        work.json.card.originalGoal === 'fix the failing unit tests'
        && work.json.card.proposedGoal === null, work.json.card.originalGoal);
      // This asserted that the line quoted `audits/missions/...` — paths in
      // ZEUS's repository, recited on every project's card. A talkbridge
      // operator was told "the only figures on record are
      // audits/missions/M-0004.md" about a file their project does not have.
      // What a card owes the reader is the ceiling THIS mission will stop at.
      check('CC4: it says what happens next, and the ceiling it will stop at',
        work.json.card.whatHappensNext.length === 6
        && /stops at \$\d+\.\d\d of provider-reported spend/
          .test(work.json.card.costExpectation)
        && !/audits\/missions/.test(work.json.card.costExpectation),
        work.json.card.costExpectation.slice(0, 80));
      check('CC5: no silent model call — no cost is attributed to drafting it',
        work.json.card.proposalCostUsd === null);

      const digest = work.json.card.digest;
      const stale = await post(server, '/api/chat/decide', {
        card: { ...work.json.card, originalGoal: 'something else entirely' },
        cardDigest: digest, decision: 'create',
      });
      check('CC6: a card that changed since it was rendered is REFUSED',
        stale.status === 409 && stale.json.error === 'CARD_DIGEST_MISMATCH',
        JSON.stringify(stale.json?.error));
      check('CC6b: and the refusal hands back the current card to read',
        !!stale.json.current && stale.json.current.digest !== digest);
      check('CC6c: still nothing created',
        fx.missions.list().length === 0, String(fx.missions.list().length));

      const cancelled = await post(server, '/api/chat/decide', {
        card: work.json.card, cardDigest: digest, decision: 'cancel',
      });
      check('CC7: cancelling records the decision and creates nothing',
        cancelled.status === 200 && cancelled.json.missionId === null
        && fx.missions.list().length === 0);

      const created = await post(server, '/api/chat/decide', {
        card: work.json.card, cardDigest: digest, decision: 'create',
      });
      check('CC8: an accepted card creates the mission',
        created.status === 201 && created.json.missionId === 'p/M-0001',
        JSON.stringify(created.json?.missionId));

      // CLIENT-NOT-ENGINE, extended to chat: the same goal through the CLI
      // registry must produce the same events.
      const twin = fixture();
      const cliRec = twin.missions.create('fix the failing unit tests', 'base0');
      const norm = (e: any) => {
        const o = { type: e.type, ...JSON.parse(JSON.stringify(e.payload)) };
        delete o.createdAt; delete o.baseSha;
        return o;
      };
      const chatEvents = fx.store.read('p/M-0001').map(norm);
      const cliEvents = twin.store.read(cliRec.missionId).map(norm);
      check('CC9: a chat-created mission deep-equals a CLI-created twin',
        JSON.stringify(chatEvents) === JSON.stringify(cliEvents),
        JSON.stringify(chatEvents));

      const history = await get(`${server.url}/api/chat`, auth);
      const types = history.json.events.map((e: any) => e.type);
      check('CC10: the message, the routing and the decision are all on the log',
        types.filter((t: string) => t === 'CHAT_MESSAGE').length === 1
        && types.filter((t: string) => t === 'CHAT_CARD_DECISION').length === 3,
        types.join(','));
      const decisions = history.json.events
        .filter((e: any) => e.type === 'CHAT_CARD_DECISION')
        .map((e: any) => e.payload.decision);
      check('CC10b: including the refusal, the cancellation and the creation',
        decisions.join(',') === 'REFUSED_DIGEST_MISMATCH,CANCELLED,CREATED', decisions.join(','));
    } finally { await server?.close(); }
  }

  section('chat: the log answerer still answers, and still calls nothing');
  {
    // answerFromLog is no longer what /api/chat uses — the front door is — but
    // it is still what the "answer instead" branch of a card runs, so its
    // contract is tested where it lives rather than through a route that has
    // moved on.
    const fx = fixture();
    const rec = fx.missions.create('a goal', 'base0');
    fx.missions.escalate(rec.missionId, { kind: 'NOTE' });

    const status = answerFromLog(fx.missions, 'what is the status?');
    const cost = answerFromLog(fx.missions, 'how much did it cost?');
    const events = answerFromLog(fx.missions, 'show me the last events');
    const unknown = answerFromLog(fx.missions,
      'what is the airspeed velocity of an unladen swallow?');

    check('CQ2: the answer cites the mission it is about',
      status.refs.some((r: any) => r.kind === 'mission' && r.id === rec.missionId),
      JSON.stringify(status.refs));
    check('CQ3: cost answers keep unmetered calls distinct from spend',
      /no provider-reported spend|lower bound|\$/.test(cost.text), cost.text.slice(0, 80));
    check('CQ4: event answers carry seq refs that resolve',
      events.refs.some((r: any) => r.kind === 'event' && typeof r.seq === 'number'),
      JSON.stringify(events.refs.slice(0, 2)));
    check('CQ5: a question the log cannot answer says so, and says what CAN be asked',
      unknown.answered === false
      && /cannot answer that from the event log/.test(unknown.text)
      && /I can answer questions about/.test(unknown.text), unknown.text.slice(0, 60));
    check('CQ6: and it does not reach for a model to improvise one',
      /does not call one to improvise/.test(unknown.text), 'no model on this path');
  }

  section('chat: a question answered by the front door creates nothing');
  {
    const fx = fixture();
    fx.missions.create('a goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        operations: {
          compile: async () => ({}) as any,
          plan: async () => ({}) as any,
          evaluate: async () => ({}),
          frontDoor: async () => ({
            intent: 'QUESTION' as const, confidence: 0.95,
            summary: 'asks for the status', answer: 'One mission, not terminated.',
            evidenceUsed: [{ kind: 'zeus_missions', id: '', detail: '1 result(s), 2ms' }],
            proposedWork: null, readings: null, degraded: null,
          }),
        },
      });
      const q = await post(server, '/api/chat', { message: 'what is the status?' });
      check('CQ1: a question is answered, with no card offered',
        q.status === 200 && q.json.intent === 'QUESTION' && q.json.card === null
        && q.json.answer.answered === true, JSON.stringify(q.json?.intent));
      check('CQ1b: the answer is the front door’s, grounded in what it inspected',
        q.json.answer.text === 'One mission, not terminated.'
        && q.json.answer.refs[0].kind === 'zeus_missions', JSON.stringify(q.json.answer.refs));
      check('CQ7: no mission was created by the question',
        fx.missions.list().length === 1, String(fx.missions.list().length));

      // Fail VISIBLE: a server with no front door must not quietly answer.
      let bare: RunningServer | null = null;
      try {
        bare = await startWebServer({
          projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        });
        const d = await post(bare, '/api/chat', { message: 'what is the status?' });
        check('CQ8: with no front door the reply is DEGRADED, not a quiet answer',
          d.json.intent === 'AMBIGUOUS' && d.json.degraded?.reason === 'FRONT_DOOR_UNAVAILABLE'
          && d.json.answer === null, JSON.stringify(d.json?.degraded));
        check('CQ9: and it offers both readings rather than choosing the cheap one',
          (d.json.frontDoor?.readings ?? []).length === 2,
          JSON.stringify(d.json.frontDoor?.readings));
      } finally { await bare?.close(); }
    } finally { await server?.close(); }
  }

  section('chat: ambiguity is rendered as readings, not resolved cheaply');
  {
    const fx = fixture();
    fx.missions.create('an existing goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const amb = await post(server, '/api/chat', { message: 'the invoice module is a mess' });
      check('CA1: an ambiguous message creates nothing and offers no card',
        amb.json.intent === 'AMBIGUOUS' && amb.json.card === null
        && fx.missions.list().length === 1, JSON.stringify(amb.json?.intent));
      // The old shape answered it, or offered a card with an "actually it was a
      // question" button. Both quietly picked a reading. This shows both.
      check('CA2: both readings are put to the person',
        (amb.json.frontDoor?.readings ?? []).length === 2
        && amb.json.frontDoor.readings.some((r: any) => r.intent === 'QUESTION')
        && amb.json.frontDoor.readings.some((r: any) => r.intent === 'WORK_REQUEST'),
        JSON.stringify(amb.json.frontDoor?.readings));
      check('CA2b: and no answer is smuggled in alongside them',
        amb.json.answer === null, JSON.stringify(amb.json.answer));
    } finally { await server?.close(); }
  }

  section('chat: the "answer instead" branch of a card still answers for free');
  {
    const fx = fixture();
    fx.missions.create('an existing goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        operations: {
          compile: async () => ({}) as any,
          plan: async () => ({}) as any,
          evaluate: async () => ({}),
          frontDoor: async (message: string) => ({
            intent: 'WORK_REQUEST' as const, confidence: 0.8,
            summary: 'reads as work', evidenceUsed: [], answer: null,
            readings: null, degraded: null,
            proposedWork: { goal: message, orientation: null },
          }),
        },
      });
      const card = await post(server, '/api/chat', { message: 'tidy the invoice module' });
      check('CA3: a card still carries the "this was just a question" option',
        card.json.card.actions.some((a: any) => a.id === 'answer'),
        JSON.stringify(card.json.card.actions.map((a: any) => a.id)));
      const answered = await post(server, '/api/chat/decide', {
        card: card.json.card, cardDigest: card.json.card.digest, decision: 'answer',
      });
      check('CA4: choosing it answers from the log and creates nothing',
        answered.status === 200 && answered.json.missionId === null
        && !!answered.json.answer && fx.missions.list().length === 1,
        JSON.stringify(answered.json?.missionId));
    } finally { await server?.close(); }
  }

  section('chat: it is in the log, redacted, and survives a restart');
  {
    const fx = fixture();
    const secret = 'sk-live-CHATSECRET0123456789ABCD';
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      await post(server, '/api/chat', { message: `fix the token ${secret} in the config` });
    } finally { await server?.close(); }

    const stored = JSON.stringify(chatHistory(fx.store, 'p'));
    check('CS1: a secret in a chat message is redacted by the sink',
      !stored.includes(secret) && /redacted/i.test(stored), stored.slice(0, 120));

    // A NEW server over the same state: history is the log, so it is all there.
    let restarted: RunningServer | null = null;
    try {
      restarted = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const history = await get(`${restarted.url}/api/chat`,
        { authorization: `Bearer ${restarted.token}` });
      check('CS2: chat history reconstructs after a restart, because it is the log',
        history.status === 200 && history.json.events.length === 1
        && history.json.events[0].type === 'CHAT_MESSAGE',
        String(history.json?.events?.length));
      const noAuth = await get(`${restarted.url}/api/chat`);
      check('CS3: chat routes are authenticated like everything else',
        noAuth.status === 401, String(noAuth.status));
    } finally { await restarted?.close(); }

    check('CS4: the chat stream is not mistaken for a mission or a task',
      scopeOf('p/CHAT') === null, String(scopeOf('p/CHAT')));
  }

  section('chat: goal tightening is offered, never taken silently');
  {
    check('CG1x: a single sentence is not offered a rewrite',
      !wantsTightening('fix the failing unit tests'), 'single sentence');
    check('CG2x: a multi-sentence message is',
      wantsTightening('The parser is slow. Make it faster please.'), 'two sentences');
    const card = draftCard({ intent: 'WORK', message: 'a. b.',
      proposedGoal: 'tightened wording', proposalCostUsd: 0.0123 });
    check('CG3x: when a model IS used, the card shows both wordings and what it cost',
      card.originalGoal === 'a. b.' && card.proposedGoal === 'tightened wording'
      && card.proposalCostUsd === 0.0123, JSON.stringify(card.proposalCostUsd));
    check('CG4x: and the digest covers the proposal, so accepting it is accepting that text',
      draftCard({ intent: 'WORK', message: 'a. b.', proposedGoal: 'other', proposalCostUsd: 0.0123 })
        .digest !== card.digest);
  }
  section('project creation: the route is chosen deterministically');
  {
    const TABLE: Array<{ msg: string; att: boolean; want: string }> = [
      { msg: 'anything at all', att: true, want: 'ZIP' },
      { msg: '', att: true, want: 'ZIP' },
      { msg: 'https://github.com/owner/repo.git', att: false, want: 'CLONE' },
      { msg: 'https://gitlab.com/group/sub/repo', att: false, want: 'CLONE' },
      { msg: 'git@github.com:owner/repo.git', att: false, want: 'CLONE' },
      { msg: 'git://example.com/repo.git', att: false, want: 'CLONE' },
      { msg: 'owner/repo', att: false, want: 'CLONE' },
      { msg: 'gh:owner/repo', att: false, want: 'CLONE' },
      { msg: 'build me a CLI that renames files', att: false, want: 'DESCRIPTION' },
      { msg: 'یک ابزار خط فرمان بساز', att: false, want: 'DESCRIPTION' },
      // URL-ish but not a URL: must ASK, never guess.
      { msg: 'clone https://github.com/owner/repo and fix the tests', att: false, want: 'ASK' },
      { msg: 'the repo on github.com is broken', att: false, want: 'ASK' },
      { msg: 'take a look at git@host:thing.git please', att: false, want: 'ASK' },
      { msg: '', att: false, want: 'ASK' },
    ];
    const wrong = TABLE.filter((t) => routeFor({ message: t.msg, hasAttachment: t.att }).route !== t.want);
    check('PC1: the route table holds for attachments, URLs, descriptions and near-misses',
      wrong.length === 0,
      wrong.map((t) => `"${t.msg}" → ${routeFor({ message: t.msg, hasAttachment: t.att }).route}, wanted ${t.want}`).join(' | '));
    check('PC1b: a URL inside a sentence ASKS rather than cloning something unintended',
      routeFor({ message: 'clone https://github.com/o/r and fix it', hasAttachment: false }).route === 'ASK');
    check('PC1c: every decision carries the reason it was taken',
      TABLE.every((t) => routeFor({ message: t.msg, hasAttachment: t.att }).reason.length > 15));
    check('PC1d: an attachment always wins — it is the source, whatever the text says',
      routeFor({ message: 'https://github.com/o/r', hasAttachment: true }).route === 'ZIP');

    check('PC2: a credentialed URL is detected',
      carriesCredentials('https://user:token@github.com/o/r.git')
      && carriesCredentials('https://token@github.com/o/r.git'),
      'credentials detected');
    check('PC2b: an ordinary URL and an SSH URL are not mistaken for credentialed',
      !carriesCredentials('https://github.com/o/r.git')
      && !carriesCredentials('git@github.com:o/r.git'));
    const credCard = draftCreationCard({
      route: 'CLONE', source: 'https://user:tok@github.com/o/r.git',
      projectsRoot: '/tmp/roots', targetSlug: 'r',
    });
    check('PC2c: the card says plainly that a credentialed URL will be refused',
      credCard.warnings.some((w) => /REFUSED/.test(w) && /SSH agent/.test(w)),
      credCard.warnings.join(' | '));
  }

  section('project creation: cards render before anything is created');
  {
    const clone = draftCreationCard({
      route: 'CLONE', source: 'https://github.com/o/r.git',
      projectsRoot: '/tmp/roots', targetSlug: 'r',
    });
    check('PC3: the clone card shows the target directory before creating it',
      clone.targetPath === '/tmp/roots/r' && clone.targetSlug === 'r', clone.targetPath);
    check('PC3b: it states that the clone is shallow and supervised',
      clone.whatHappensNext[0].includes('--depth 1')
      && clone.whatHappensNext[0].includes('supervisor')
      && clone.whatHappensNext[0].includes('run registry'), clone.whatHappensNext[0]);
    check('PC3c: and that network is required',
      clone.warnings.some((w) => /network/i.test(w)), clone.warnings.join(' | '));

    const zip = draftCreationCard({
      route: 'ZIP', source: 'upload.zip', projectsRoot: '/tmp/roots', targetSlug: 'up',
    });
    check('PC4: the zip card names the three walls',
      /every destination checked/.test(zip.whatHappensNext[0])
      && /link entries skipped/.test(zip.whatHappensNext[0])
      && /capped at/.test(zip.whatHappensNext[0]), zip.whatHappensNext[0]);
    check('PC4b: and names what is NOT checked, rather than implying completeness',
      zip.warnings.some((w) => /compression-ratio|content scanning|rate limiting/.test(w)),
      zip.warnings.join(' | '));

    const desc = draftCreationCard({
      route: 'DESCRIPTION', source: 'build me a thing',
      projectsRoot: '/tmp/roots', targetSlug: 'thing',
    });
    check('PC5: the description card says a mission will be drafted, not scaffolded',
      desc.whatHappensNext.some((s) => /draft a MISSION/.test(s))
      && desc.whatHappensNext.some((s) => /compile, critic, consent/.test(s)),
      desc.whatHappensNext.join(' | '));
    check('PC5b: it says plainly there is no shortcut',
      desc.warnings.some((w) => /no scaffolding shortcut/i.test(w)), desc.warnings.join(' | '));
    check('PC5c: and states the ceiling rather than reciting Zeus\u2019s own audit files',
      /stops at \$\d+\.\d\d of provider-reported spend/.test(desc.costExpectation)
      && !/audits\/missions/.test(desc.costExpectation),
      desc.costExpectation.slice(0, 80));

    const ask = draftCreationCard({
      route: 'ASK', source: 'clone the repo on github', projectsRoot: '/tmp/roots', targetSlug: 'x',
    });
    check('PC6: an ASK card offers the routes instead of choosing one',
      ask.actions.map((a) => a.id).join(',') === 'clone,describe,cancel',
      ask.actions.map((a) => a.id).join(','));

    check('PC7: the digest covers the card, so a changed target is a different card',
      draftCreationCard({ route: 'CLONE', source: 'https://github.com/o/r.git',
        projectsRoot: '/tmp/roots', targetSlug: 'elsewhere' }).digest !== clone.digest);
  }

  section('project creation: the zip walls hold');
  {
    const root = path.join(TMP, `zips-${seq += 1}`);
    fs.mkdirSync(root, { recursive: true });

    // Built by hand, because a fixture that a library produced cannot express
    // the entries an attacker would send.
    const zipOf = (files: Array<{ name: string; body: string; mode?: number }>): Buffer => {
      const locals: Buffer[] = [];
      const centrals: Buffer[] = [];
      let offset = 0;
      for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const body = Buffer.from(f.body, 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 8);                      // stored
        lh.writeUInt32LE(0, 14);
        lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22);
        lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        const local = Buffer.concat([lh, name, body]);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0, 10);
        ch.writeUInt32LE(0, 16);
        ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE((((f.mode ?? 0o100644) << 16) >>> 0), 38);
        ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name]));
        locals.push(local);
        offset += local.length;
      }
      const cd = Buffer.concat(centrals);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
      eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
      return Buffer.concat([...locals, cd, eocd]);
    };

    const good = extractZip(zipOf([{ name: 'src/a.ts', body: 'export const a = 1;\n' }]),
      path.join(root, 'good'));
    check('PC8: an ordinary archive extracts',
      good.ok && good.written === 1
      && fs.readFileSync(path.join(root, 'good', 'src', 'a.ts'), 'utf8').includes('const a'),
      JSON.stringify(good.refusal));

    // WALL A
    const evil = path.join(root, 'traversal');
    const trav = extractZip(zipOf([
      { name: 'ok.txt', body: 'fine' },
      { name: '../../evil.txt', body: 'pwned' },
    ]), evil);
    check('PC9: a traversal entry is refused through resolveWithin',
      !trav.ok && /escapes the target directory/.test(trav.refusal ?? ''), trav.refusal ?? '');
    check('PC9b: and NOTHING is left on disk — extraction is atomic',
      !fs.existsSync(evil) && !fs.existsSync(`${evil}.incoming-${process.pid}`),
      'target and temp both absent');
    check('PC9c: the escape did not reach the parent either',
      !fs.existsSync(path.join(root, 'evil.txt')) && !fs.existsSync(path.join(TMP, 'evil.txt')));

    const abs = extractZip(zipOf([{ name: '/etc/zeus-pwned', body: 'x' }]),
      path.join(root, 'absolute'));
    check('PC9d: an absolute path is refused too',
      !abs.ok && !fs.existsSync('/etc/zeus-pwned'), abs.refusal ?? '');

    // WALL B
    const linky = path.join(root, 'links');
    const links = extractZip(zipOf([
      { name: 'real.txt', body: 'kept' },
      { name: 'link', body: '/etc/passwd', mode: 0o120777 },
    ]), linky);
    check('PC10: a symlink entry is skipped, not followed',
      links.ok && links.skippedLinks.join(',') === 'link' && links.written === 1,
      JSON.stringify(links.skippedLinks));
    check('PC10b: and it is counted so the result card can say so',
      !fs.existsSync(path.join(linky, 'link'))
      && fs.existsSync(path.join(linky, 'real.txt')));

    // WALL C
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, body: 'x' }));
    const capped = extractZip(zipOf(many), path.join(root, 'capped'),
      { maxEntries: 5, maxTotalBytes: 1_000_000 });
    check('PC11: an entry-count breach is refused before anything is written',
      !capped.ok && /over the 5-entry cap/.test(capped.refusal ?? '')
      && !fs.existsSync(path.join(root, 'capped')), capped.refusal ?? '');

    const big = extractZip(zipOf([{ name: 'big.txt', body: 'x'.repeat(4096) }]),
      path.join(root, 'big'), { maxEntries: 100, maxTotalBytes: 100 });
    check('PC11b: a size breach is refused and leaves nothing behind',
      !big.ok && /cap/.test(big.refusal ?? '') && !fs.existsSync(path.join(root, 'big')),
      big.refusal ?? '');

    const junk = extractZip(Buffer.from('this is not a zip file at all'), path.join(root, 'junk'));
    check('PC12: a file that is not an archive is refused, not guessed at',
      !junk.ok && /not a zip archive/.test(junk.refusal ?? ''), junk.refusal ?? '');
  }

  section('project creation: the projects root is a directory, not an index');
  {
    const root = path.join(TMP, `proot-${seq += 1}`);
    fs.mkdirSync(root, { recursive: true });
    const mk = (slug: string) => {
      const dir = path.join(root, slug);
      fs.mkdirSync(path.join(dir, '.zeus', 'state'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.zeus', 'config.yaml'),
        `version: 1\nproject:\n  name: ${slug}\n  adapter: node\n`);
      return dir;
    };
    mk('alpha'); mk('beta');
    fs.mkdirSync(path.join(root, 'not-a-project'), { recursive: true });

    const list = listProjects(root);
    check('PC13: only initialised projects are listed',
      list.map((p) => p.slug).join(',') === 'alpha,beta',
      list.map((p) => p.slug).join(','));
    check('PC13b: each carries its identity and adapter',
      list[0].projectId === 'alpha' && list[0].adapter === 'node');
    check('PC14: a slug that tries to leave the root resolves to nothing',
      projectBySlug(root, '../etc') === null && projectBySlug(root, 'a/b') === null
      && projectBySlug(root, '') === null);
    check('PC14b: a real slug resolves',
      projectBySlug(root, 'alpha')?.slug === 'alpha');

    check('PC15: a URL becomes a safe directory name',
      slugForUrl('https://github.com/owner/My.Repo.git') === 'my.repo'
      && slugForUrl('git@host:group/thing.git') === 'thing',
      `${slugForUrl('https://github.com/owner/My.Repo.git')} / ${slugForUrl('git@host:group/thing.git')}`);
    check('PC15b: a hostile name is flattened rather than honoured',
      slugify('../../etc/passwd') === 'etc-passwd', slugify('../../etc/passwd'));
    check('PC15c: a taken name gets a free suffix instead of clobbering',
      freeSlug(root, 'alpha') === 'alpha-2', freeSlug(root, 'alpha'));
  }
  section('project creation: over HTTP, nothing is created without an accepted card');
  {
    const proot = path.join(TMP, `hproot-${seq += 1}`);
    fs.mkdirSync(proot, { recursive: true });
    const fx = fixture();
    const ran: string[] = [];
    const runner = async (spec: { kind: string; args: string[]; cwd: string }) => {
      ran.push(`${spec.kind}:${spec.args.join(' ')}`);
      if (spec.args[0] === 'clone') {
        // Stand in for a real clone: the point of the test is the route and
        // the walls, not git's network stack.
        const dest = path.join(spec.cwd, spec.args[spec.args.length - 1]);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'package.json'), '{"name":"cloned"}\n');
      }
      if (spec.args[0] === 'init' && spec.kind === 'init') {
        fs.mkdirSync(path.join(spec.cwd, '.zeus', 'state'), { recursive: true });
        fs.writeFileSync(path.join(spec.cwd, '.zeus', 'config.yaml'),
          'version: 1\nproject:\n  name: made\n  adapter: node\n');
      }
      return { ok: true, detail: `${spec.kind} ok` };
    };

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: proot, createRunner: runner,
      });
      const auth = { authorization: `Bearer ${server.token}` };

      const empty = await get(`${server.url}/api/projects`, auth);
      check('PC20: the projects home lists an empty root without inventing anything',
        empty.status === 200 && empty.json.projects.length === 0
        && empty.json.projectsRoot === proot, JSON.stringify(empty.json?.projects?.length));

      const draft = await post(server, '/api/projects/draft',
        { message: 'https://github.com/owner/repo.git' });
      check('PC21: a URL drafts a CLONE card and creates nothing',
        draft.json.route === 'CLONE' && !!draft.json.card
        && fs.readdirSync(proot).length === 0, JSON.stringify(draft.json?.route));
      check('PC21b: the card shows where it would land',
        draft.json.card.targetSlug === 'repo'
        && draft.json.card.targetPath === path.join(proot, 'repo'),
        draft.json.card.targetPath);

      const stale = await post(server, '/api/projects/decide', {
        card: { ...draft.json.card, targetSlug: 'somewhere-else' },
        cardDigest: draft.json.card.digest, decision: 'create',
      });
      check('PC22: a card that changed is refused, and nothing is created',
        stale.status === 409 && stale.json.error === 'CARD_DIGEST_MISMATCH'
        && fs.readdirSync(proot).length === 0, JSON.stringify(stale.json?.error));

      const created = await post(server, '/api/projects/decide', {
        card: draft.json.card, cardDigest: draft.json.card.digest, decision: 'create',
      });
      check('PC23: an accepted card clones and initialises',
        created.status === 201 && created.json.slug === 'repo'
        && created.json.initialised.isProject === true, JSON.stringify(created.json?.slug));
      check('PC23b: the clone ran shallow, through the injected runner',
        ran.some((r) => r.includes('clone --depth 1')), ran.join(' | '));
      check('PC23c: and the new project appears in the projects home',
        (await get(`${server.url}/api/projects`, auth)).json.projects
          .map((p: any) => p.slug).join(',') === 'repo');

      // A credentialed URL never reaches a command line.
      const credDraft = await post(server, '/api/projects/draft',
        { message: 'https://user:tok@github.com/owner/secret.git' });
      const credDecide = await post(server, '/api/projects/decide', {
        card: credDraft.json.card, cardDigest: credDraft.json.card.digest, decision: 'create',
      });
      check('PC24: a credentialed URL is refused at the decision, not cloned',
        credDecide.status === 400 && credDecide.json.error === 'CREDENTIALED_URL_REFUSED',
        JSON.stringify(credDecide.json?.error));
      check('PC24b: and it never reached the runner',
        !ran.some((r) => r.includes('tok@')), ran.join(' | '));

      // DESCRIPTION → empty project + the W1c mission card, goal prefilled.
      const descDraft = await post(server, '/api/projects/draft',
        { message: 'build a CLI that renames files by pattern' });
      check('PC25: a description drafts a DESCRIPTION card',
        descDraft.json.route === 'DESCRIPTION', descDraft.json.route);
      const descMade = await post(server, '/api/projects/decide', {
        card: descDraft.json.card, cardDigest: descDraft.json.card.digest, decision: 'create',
      });
      check('PC26: it creates an EMPTY project and hands off to a mission card',
        descMade.status === 201 && !!descMade.json.missionCard
        && descMade.json.missionCard.originalGoal === 'build a CLI that renames files by pattern',
        JSON.stringify(descMade.json?.missionCard?.originalGoal));
      check('PC26b: the handoff says plainly that building it is a mission',
        /accept the mission card to build it/.test(descMade.json.handoff), descMade.json.handoff);
      check('PC26c: no scaffolding was written — the project is empty but initialised',
        descMade.json.initialised.isProject === true
        && !fs.existsSync(path.join(proot, descMade.json.slug, 'src')),
        descMade.json.slug);

      // Two projects now exist, and their state does not cross.
      const both = await get(`${server.url}/api/projects`, auth);
      check('PC27: multi-project listing shows both with their own identity',
        both.json.projects.length === 2
        && new Set(both.json.projects.map((p: any) => p.root)).size === 2,
        both.json.projects.map((p: any) => p.slug).join(','));
      check('PC27b: each project has its own state directory',
        both.json.projects.every((p: any) => p.root.startsWith(proot)));

      const noAuth = await get(`${server.url}/api/projects`);
      check('PC28: the projects home is authenticated like everything else',
        noAuth.status === 401, String(noAuth.status));
    } finally { await server?.close(); }
  }

  section('project creation: a zip arrives through the same card boundary');
  {
    const proot = path.join(TMP, `zproot-${seq += 1}`);
    fs.mkdirSync(proot, { recursive: true });
    const fx = fixture();
    const runner = async (spec: { kind: string; args: string[]; cwd: string }) => {
      if (spec.kind === 'init') {
        fs.mkdirSync(path.join(spec.cwd, '.zeus', 'state'), { recursive: true });
        fs.writeFileSync(path.join(spec.cwd, '.zeus', 'config.yaml'),
          'version: 1\nproject:\n  name: zipped\n  adapter: node\n');
      }
      return { ok: true, detail: 'ok' };
    };
    const zipOf = (files: Array<{ name: string; body: string; mode?: number }>): Buffer => {
      const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
      for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const body = Buffer.from(f.body, 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8);
        lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22);
        lh.writeUInt16LE(name.length, 26);
        const local = Buffer.concat([lh, name, body]);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0, 10);
        ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE((((f.mode ?? 0o100644) << 16) >>> 0), 38);
        ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name])); locals.push(local); offset += local.length;
      }
      const cd = Buffer.concat(centrals);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
      eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
      return Buffer.concat([...locals, cd, eocd]);
    };

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: proot, createRunner: runner,
      });
      const draft = await post(server, '/api/projects/draft',
        { hasAttachment: true, filename: 'my-app.zip' });
      check('PC30: an attachment routes to ZIP whatever the text says',
        draft.json.route === 'ZIP' && draft.json.card.targetSlug === 'my-app',
        draft.json.card?.targetSlug);

      const good = zipOf([{ name: 'src/index.ts', body: 'export const x = 1;\n' },
        { name: 'link', body: '/etc/passwd', mode: 0o120777 }]);
      const made = await post(server, '/api/projects/decide', {
        card: draft.json.card, cardDigest: draft.json.card.digest, decision: 'create',
        zipBase64: good.toString('base64'),
      });
      check('PC31: a good archive extracts and initialises',
        made.status === 201 && made.json.extraction.written === 1
        && made.json.initialised.isProject === true, JSON.stringify(made.json?.error ?? made.status));
      check('PC31b: the skipped link is reported back on the result',
        made.json.extraction.skippedLinks.join(',') === 'link',
        JSON.stringify(made.json.extraction.skippedLinks));

      const d2 = await post(server, '/api/projects/draft',
        { hasAttachment: true, filename: 'evil.zip' });
      const evil = zipOf([{ name: '../../escaped.txt', body: 'pwned' }]);
      const refused = await post(server, '/api/projects/decide', {
        card: d2.json.card, cardDigest: d2.json.card.digest, decision: 'create',
        zipBase64: evil.toString('base64'),
      });
      check('PC32: a traversal archive is refused over HTTP too',
        refused.status === 400 && refused.json.error === 'ARCHIVE_REFUSED',
        JSON.stringify(refused.json?.error));
      check('PC32b: and nothing landed anywhere',
        !fs.existsSync(path.join(proot, 'evil'))
        && !fs.existsSync(path.join(proot, 'escaped.txt'))
        && !fs.existsSync(path.join(TMP, 'escaped.txt')));
    } finally { await server?.close(); }
  }
  section('control center: the stream reaches a spec-faithful client');
  {
    /**
     * A minimal EventSource, implementing the dispatch rule that matters.
     *
     * The earlier tests parsed `id:` and `event:` out of the raw bytes and
     * asserted the SERVER emits correct SSE. It does — and the browser still
     * showed nothing, because a frame carrying `event: X` does not dispatch to
     * `onmessage`. The producer was tested and the consumer was not, so the
     * defect lived exactly in the gap between them.
     *
     * This client honours the spec: an absent `event:` field means type
     * "message", and any other value means a listener for THAT name must be
     * registered or the frame is dropped on the floor.
     */
    class TinySource {
      readonly received: Array<{ type: string; data: any; lastEventId: string }> = [];
      private buf = '';
      feed(chunk: string): void {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf('\n\n')) !== -1) {
          const frame = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 2);
          if (!frame.trim() || frame.startsWith(':')) continue;
          let type = 'message';
          let data = '';
          let id = '';
          for (const line of frame.split('\n')) {
            const c = line.indexOf(':');
            const field = c === -1 ? line : line.slice(0, c);
            const value = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'event') type = value;
            else if (field === 'data') data += (data ? '\n' : '') + value;
            else if (field === 'id') id = value;
          }
          let parsed: any = null;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          this.received.push({ type, data: parsed, lastEventId: id });
        }
      }
      /** Exactly what `addEventListener(name, …)` would see. */
      on(name: string) { return this.received.filter((e) => e.type === name); }
    }

    const fx = fixture();
    const rec = fx.missions.create('goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const src = new TinySource();
      const done = new Promise<void>((resolve) => {
        const req = http.get(
          `${server!.url}/api/events/stream?token=${encodeURIComponent(server!.token)}`,
          (res) => {
            res.on('data', (c) => {
              src.feed(String(c));
              if (src.on(SSE_CHANNEL).length >= 2) { req.destroy(); resolve(); }
            });
            res.on('end', () => resolve());
          });
        req.on('error', () => resolve());
        setTimeout(() => { try { req.destroy(); } catch { /* gone */ } resolve(); }, 8_000);
      });
      await new Promise((r) => setTimeout(r, 250));
      fx.missions.escalate(rec.missionId, { kind: 'one' });
      fx.missions.escalate(rec.missionId, { kind: 'two' });
      await done;

      const onChannel = src.on(SSE_CHANNEL);
      check('SC-UI1: frames dispatch to the channel the client subscribes to',
        onChannel.length >= 2, `${onChannel.length} on "${SSE_CHANNEL}"`);
      check('SC-UI2: and NOT to "message" — a named frame never reaches onmessage',
        src.on('message').length === 0,
        `${src.on('message').length} would have reached onmessage`);
      check('SC-UI3: the regression itself — no frame is named after its own type',
        src.on('MISSION_ESCALATED').length === 0 && src.received.every((e) => e.type === SSE_CHANNEL),
        [...new Set(src.received.map((e) => e.type))].join(','));
      check('SC-UI4: the real event type still arrives, inside the payload',
        onChannel.every((e) => typeof e.data?.type === 'string')
        && onChannel.some((e) => e.data.type === 'MISSION_ESCALATED'),
        onChannel.map((e) => e.data?.type).join(','));
      check('SC-UI5: each frame carries the id a client resumes from',
        onChannel.every((e) => /#\d+$/.test(e.lastEventId)),
        onChannel.map((e) => e.lastEventId).join(' '));
    } finally { await server?.close(); }
  }

  section('control center: the UI and the server agree, structurally');
  {
    check('SC-UI6: the UI subscribes to the same constant the server emits',
      UI_HTML.includes(`addEventListener('${SSE_CHANNEL}'`),
      `looking for addEventListener('${SSE_CHANNEL}'`);
    check('SC-UI7: and no longer relies on onmessage, which named frames bypass',
      !/ES\.onmessage/.test(UI_HTML), 'no ES.onmessage');
    // Bug two: the feed used to live inside the element loadDetail() replaces,
    // so appended rows were destroyed on the next refresh. Made impossible by
    // structure rather than by remembering — the feed is a sibling now.
    check('SC-UI8: the live feed is not inside the pane that gets rebuilt',
      UI_HTML.includes('<div id="feedwrap">')
      && !/\$\('detail'\)\.innerHTML[\s\S]{0,400}id="feed"/.test(UI_HTML),
      'feed lives outside #detail');
    check('SC-UI9: loadDetail no longer renders the feed at all',
      !/h \+= '<h2>live events<\/h2>/.test(UI_HTML), 'loadDetail does not emit #feed');
  }
  section('consent: what is waiting for a human is reconstructed, not remembered');
  {
    const fx = fixture();
    const armOracle = (goal: string) => {
      const rec = fx.missions.create(goal, 'base0');
      const oracle = {
        missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
        compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
        criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
          evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
          affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
      };
      fx.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
      fx.missions.recordCritique(rec.missionId, {
        valid: true, findings: [{ code: 'BEYOND_GOAL', criterionId: `${rec.missionId}/C-0001`,
          detail: 'this criterion reaches past the goal' }],
        modeOpinion: null, promptHash: 'p', hashes: {}, violations: [],
        criticProviderId: 'mock', reconciliation: {},
      });
      return rec.missionId;
    };

    const waiting = armOracle('a goal awaiting consent');
    const pend = pendingDecision(fx.missions, waiting);
    check('PD1: an unanswered oracle stop is pending, derived from the log alone',
      !!pend && pend.layer === 'oracle' && pend.version === 1, JSON.stringify(pend?.layer));
    check('PD1b: it carries the FULL findings as rendered, not a count',
      pend!.findings.length === 1
      && (pend!.findings[0] as any).detail === 'this criterion reaches past the goal',
      JSON.stringify(pend!.findings));
    check('PD1c: and the digest confirm will demand',
      pend!.digest === consentSubject(fx.missions, waiting, 'oracle')!.digest, pend!.digest);
    check('PD1d: it offers accept, send-back and cancel — the layer’s real options',
      pend!.options.map((o) => o.id).join(',') === 'accept,recompile,abort',
      pend!.options.map((o) => o.id).join(','));
    check('PD1e: and says how the stop arose rather than implying someone saw it',
      /inferred from the log/.test(pend!.source), pend!.source);
    check('PD2: awaitingHuman is the same predicate, not a second one',
      awaitingHuman(fx.missions, waiting) === (pendingDecision(fx.missions, waiting) !== null));

    // Answering clears it — both ways derived from the log.
    fx.missions.acceptOracle(waiting, {
      acceptanceMode: 'REQUIRED_CONSENT', acceptedBy: 'user-confirmed',
      modeInputs: {}, modeReasons: [], escalatedByCritic: false, acceptedDespite: [],
    } as any);
    check('PD3: a decided stop is never pending again — no double consent',
      pendingDecision(fx.missions, waiting) === null
      && !awaitingHuman(fx.missions, waiting));

    // A terminated mission waits for nobody.
    const dead = armOracle('a goal that got cancelled');
    fx.missions.cancel(dead, 'operator changed their mind');
    check('PD4: a terminated mission is not pending, whatever its oracle says',
      pendingDecision(fx.missions, dead) === null, 'terminated');

    // Plan layer.
    const planned = armOracle('a goal with a plan');
    fx.missions.acceptOracle(planned, {
      acceptanceMode: 'AUTO', acceptedBy: 'auto', modeInputs: {}, modeReasons: [],
      escalatedByCritic: false,
    } as any);
    const graph = { version: 1, nodes: [node(`${planned}/N-0001`)] };
    fx.missions.recordPlan(planned, graph as any);
    fx.missions.recordPlanCritique(planned, {
      version: 1, findings: [{ code: 'RISK_UNDERSTATED', severity: 'ADVISORY', detail: 'watch this' }],
      acceptance: 'STOP', contaminated: false,
    });
    fx.missions.recordPlanStopDecision(planned, {
      version: 1, rendered: ['ADVISORY RISK_UNDERSTATED: watch this'],
      decision: 'STOPPED_FINDINGS', decidedBy: 'nobody yet', deferred: true,
    });
    const pp = pendingDecision(fx.missions, planned);
    check('PD5: an unanswered PLAN stop is pending too',
      !!pp && pp.layer === 'plan' && pp.findings.length === 1, JSON.stringify(pp?.layer));
    check('PD5b: its options are the plan layer’s, not the oracle’s',
      pp!.options.map((o) => o.id).join(',') === 'accept,replan,abort',
      pp!.options.map((o) => o.id).join(','));
    check('PD5c: a recorded DEFERRED_NON_TTY stop is named as such',
      /DEFERRED_NON_TTY/.test(pp!.source), pp!.source);
  }

  section('consent: the reconstruction survives a restart and round-trips');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal awaiting consent', 'base0');
    const oracle = {
      missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
      compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
      criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
        evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
        affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
    };
    fx.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
    fx.missions.recordCritique(rec.missionId, {
      valid: true, findings: [{ code: 'WEAK_RUBRIC', detail: 'no threshold given' }],
      modeOpinion: null, promptHash: 'p', hashes: {}, violations: [],
      criticProviderId: 'mock', reconciliation: {},
    });

    let a: RunningServer | null = null;
    let digest = '';
    try {
      a = await startWebServer({ projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${a.token}` };
      const view = await get(`${a.url}/api/missions/M-0001`, auth);
      check('PD6: the mission VIEW carries the pending block, not just the stream',
        view.status === 200 && !!view.json.pendingDecision
        && view.json.pendingDecision.findings.length === 1,
        JSON.stringify(view.json?.pendingDecision?.layer));
      digest = view.json.pendingDecision.digest;

      const list = await get(`${a.url}/api/missions`, auth);
      check('PD7: and the LIST marks it, so a returning operator sees it at a glance',
        list.json[0].awaitingHuman === true, JSON.stringify(list.json[0]?.awaitingHuman));
    } finally { await a?.close(); }

    // A DIFFERENT server over the same state: the log is the source, so the
    // block comes back identically. This is the whole point of the fix.
    let b: RunningServer | null = null;
    try {
      b = await startWebServer({ projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${b.token}` };
      const after = await get(`${b.url}/api/missions/M-0001`, auth);
      check('PD8: after a restart the pending decision is still there, same digest',
        after.json.pendingDecision?.digest === digest, after.json?.pendingDecision?.digest);

      // And it round-trips: the digest the block hands you is the one confirm wants.
      const ok = await post(b, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: digest, decision: 'ACCEPT' });
      check('PD9: answering through the reconstructed block is accepted',
        ok.status === 200 && ok.json.decision === 'ACCEPT', JSON.stringify(ok.json?.error ?? ok.status));
      const gone = await get(`${b.url}/api/missions/M-0001`, auth);
      check('PD9b: and the block is gone afterwards, derived both ways from the log',
        gone.json.pendingDecision === null, JSON.stringify(gone.json?.pendingDecision));
      const list = await get(`${b.url}/api/missions`, auth);
      check('PD9c: the list marker clears with it',
        list.json[0].awaitingHuman === false, JSON.stringify(list.json[0]?.awaitingHuman));
    } finally { await b?.close(); }
  }

  section('consent: cancelling is a decision, and it is recorded');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal to abandon', 'base0');
    const oracle = {
      missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
      compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
      criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
        evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
        affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
    };
    fx.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
    fx.missions.recordCritique(rec.missionId, {
      valid: true, findings: [{ code: 'BEYOND_GOAL', detail: 'too wide' }], modeOpinion: null,
      promptHash: 'p', hashes: {}, violations: [], criticProviderId: 'mock', reconciliation: {},
    });
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({ projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const view = await get(`${server.url}/api/missions/M-0001`, auth);
      const digest = view.json.pendingDecision.digest;

      const stale = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: 'deadbeefdeadbeefdeadbeefdeadbeef', decision: 'ABORT' });
      check('PD10: aborting still goes through the digest — no bypass on the way out',
        stale.status === 409 && stale.json.error === 'DIGEST_MISMATCH',
        JSON.stringify(stale.json?.error));
      check('PD10b: and nothing was cancelled by the refused abort',
        !fx.missions.mission(rec.missionId)!.terminated);

      const aborted = await post(server, '/api/missions/M-0001/confirm',
        { kind: 'oracle', version: 1, findingsDigest: digest, decision: 'ABORT' });
      const after = fx.missions.mission(rec.missionId)!;
      check('PD11: a correct abort cancels the mission',
        aborted.status === 200 && after.terminated
        && after.terminationReason === 'CANCELLED', `${after.terminationReason}`);
      const stops = fx.store.read(rec.missionId).filter((e) => e.type === 'PLAN_STOP_DECISION');
      check('PD11b: the decision and what was on screen are both on the log',
        stops.some((e) => (e.payload as any).decision === 'ABORTED'
          && (e.payload as any).rendered.length === 1),
        JSON.stringify(stops.map((e) => (e.payload as any).decision)));
      check('PD11c: and it is no longer pending',
        pendingDecision(fx.missions, rec.missionId) === null);
    } finally { await server?.close(); }
  }

  section('chat: the log answerer knows what it can be asked');
  {
    // These once went through /api/chat. That route now asks the front door,
    // so the capability is tested where it actually lives — and it still
    // matters, because the "answer instead" branch of every card runs it.
    const fx = fixture();
    fx.missions.create('make the tests deterministic', 'base0');
    fx.missions.create('fix the README typo', 'base0');

    const asked = answerFromLog(fx.missions, 'what missions exist in this project?');
    check('RQ1: the exact question from the screenshot is answered',
      asked.answered === true, String(asked.answered));
    check('RQ1b: with both missions named',
      /M-0001/.test(asked.text) && /M-0002/.test(asked.text), asked.text.slice(0, 90));
    check('RQ1c: and refs that resolve to the missions',
      asked.refs.length === 2 && asked.refs.every((r: any) => r.kind === 'mission'),
      JSON.stringify(asked.refs));

    for (const [id, q] of [
      ['RQ2a', 'list missions'],
      ['RQ2b', 'چه ماموریت‌هایی هست؟'],
      ['RQ2c', 'how many missions are there?'],
    ] as Array<[string, string]>) {
      check(`${id}: the same question phrased differently is also answered`,
        answerFromLog(fx.missions, q).answered === true, `"${q}"`);
    }

    const waiting = answerFromLog(fx.missions, 'is anything waiting on me?');
    check('RQ3: "waiting on me" is answerable too',
      waiting.answered === true && /Nothing is waiting on you/.test(waiting.text),
      waiting.text.slice(0, 60));

    const nope = answerFromLog(fx.missions,
      'what is the airspeed velocity of an unladen swallow?');
    check('RQ4: the honest refusal still fires for what the log cannot answer',
      nope.answered === false, String(nope.answered));
    check('RQ5: and the help text is TRUE — every capability it lists is answerable',
      /which missions exist/.test(nope.text)
      && /whether anything is waiting on you/.test(nope.text), nope.text.slice(0, 120));
  }

  section('projects: a symlinked project is a project');
  {
    const root = path.join(TMP, `symroot-${seq += 1}`);
    fs.mkdirSync(root, { recursive: true });
    const real = path.join(TMP, `elsewhere-${seq += 1}`);
    fs.mkdirSync(path.join(real, '.zeus', 'state'), { recursive: true });
    fs.writeFileSync(path.join(real, '.zeus', 'config.yaml'),
      'version: 1\nproject:\n  name: linked\n  adapter: node\n');
    fs.symlinkSync(real, path.join(root, 'linked'));

    // A plain directory alongside it, so the fix cannot work by accident.
    const plain = path.join(root, 'plain');
    fs.mkdirSync(path.join(plain, '.zeus', 'state'), { recursive: true });
    fs.writeFileSync(path.join(plain, '.zeus', 'config.yaml'),
      'version: 1\nproject:\n  name: plain\n  adapter: node\n');

    fs.symlinkSync(path.join(TMP, 'does-not-exist'), path.join(root, 'dangling'));

    const list = listProjects(root);
    check('MP1: a project reached through a symlink is listed',
      list.some((p) => p.slug === 'linked'), list.map((p) => p.slug).join(','));
    check('MP1b: alongside ordinary directories',
      list.map((p) => p.slug).sort().join(',') === 'linked,plain',
      list.map((p) => p.slug).join(','));
    check('MP1c: a dangling symlink is not a project',
      !list.some((p) => p.slug === 'dangling'), list.map((p) => p.slug).join(','));
    check('MP1d: the symlinked project reports its own identity, not the link name',
      list.find((p) => p.slug === 'linked')!.projectId === 'linked');
    check('MP2: scopeFor resolves a symlinked project to its real state root',
      scopeFor(root, 'linked')!.stateRoot === path.join(fs.realpathSync(real), '.zeus', 'state')
      || scopeFor(root, 'linked')!.stateRoot.endsWith(path.join('.zeus', 'state')),
      scopeFor(root, 'linked')!.stateRoot);
    check('MP2b: and refuses a slug that tries to leave the root',
      scopeFor(root, '../etc') === null && scopeFor(root, 'nope') === null);
  }

  section('projects: switching scopes the per-project routes');
  {
    const root = path.join(TMP, `mproot-${seq += 1}`);
    fs.mkdirSync(root, { recursive: true });
    const mk = (slug: string, goals: string[]) => {
      const dir = path.join(root, slug);
      const st = path.join(dir, '.zeus', 'state');
      fs.mkdirSync(st, { recursive: true });
      fs.writeFileSync(path.join(dir, '.zeus', 'config.yaml'),
        `version: 1\nproject:\n  name: ${slug}\n  adapter: node\n`);
      const store = new EventStore(st);
      const reg = new MissionRegistry({ events: store, projectId: slug, stateRoot: st });
      for (const g of goals) reg.create(g, 'base0');
      return reg;
    };
    mk('alpha', ['alpha goal one', 'alpha goal two']);
    mk('beta', ['beta goal only']);

    const fx = fixture();
    fx.missions.create('the server-own project goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0, projectsRoot: root,
      });
      const auth = { authorization: `Bearer ${server.token}` };

      const home = await get(`${server.url}/api/projects`, auth);
      check('MP3: the home lists both projects with their own counts',
        home.json.projects.length === 2
        && home.json.projects.find((p: any) => p.slug === 'alpha').missions === 2
        && home.json.projects.find((p: any) => p.slug === 'beta').missions === 1,
        JSON.stringify(home.json.projects.map((p: any) => [p.slug, p.missions])));

      const a = await get(`${server.url}/api/missions?project=alpha`, auth);
      const b = await get(`${server.url}/api/missions?project=beta`, auth);
      const own = await get(`${server.url}/api/missions`, auth);
      check('MP4: ?project= scopes the mission list to that project',
        a.json.length === 2 && b.json.length === 1, `${a.json.length}/${b.json.length}`);
      check('MP4b: state does not cross — each sees only its own goals',
        a.json.every((m: any) => m.goal.startsWith('alpha'))
        && b.json.every((m: any) => m.goal.startsWith('beta')),
        JSON.stringify([a.json[0]?.goal, b.json[0]?.goal]));
      check('MP4c: with no project param the server still answers about its own',
        own.json.length === 1 && own.json[0].goal === 'the server-own project goal',
        own.json[0]?.goal);

      const one = await get(`${server.url}/api/missions/M-0001?project=beta`, auth);
      check('MP5: a mission id resolves against the SCOPED project, not the server’s',
        one.status === 200 && one.json.missionId === 'beta/M-0001'
        && one.json.goal === 'beta goal only', one.json?.missionId);

      const chat = await get(`${server.url}/api/chat?project=alpha`, auth);
      check('MP6: chat history is per project too',
        chat.status === 200 && chat.json.projectId === 'alpha', chat.json?.projectId);

      const missing = await get(`${server.url}/api/missions?project=nope`, auth);
      check('MP7: an unknown project is 404, never silently the wrong one',
        missing.status === 404 && missing.json.error === 'NO_SUCH_PROJECT',
        JSON.stringify(missing.json?.error));
      const escape = await get(`${server.url}/api/missions?project=..`, auth);
      check('MP7b: and a slug that tries to escape the root is refused',
        escape.status === 404, String(escape.status));
    } finally { await server?.close(); }
  }

  section('projects: the home is honest when there is no root');
  {
    const fx = fixture();
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const home = await get(`${server.url}/api/projects`,
        { authorization: `Bearer ${server.token}` });
      check('MP8: with no projects root it says so rather than showing an empty list',
        home.json.projectsRoot === null && home.json.projects.length === 0
        && /single project/.test(home.json.detail), home.json?.detail);
      check('MP8b: and the UI explains how to enable it instead of rendering nothing',
        UI_HTML.includes('--projects &lt;dir&gt;'), 'hint present');
    } finally { await server?.close(); }

    check('MP9: the UI carries a projects home and scopes its calls',
      UI_HTML.includes("api('/projects')") && UI_HTML.includes("'project='"),
      'home + scoping present');
    check('MP9b: and a way back to it once inside a project',
      UI_HTML.includes("id=\"crumb\""), 'breadcrumb present');
  }
  section('project creation: an init that fails leaves nothing behind');
  {
    const proot = path.join(TMP, `atomroot-${seq += 1}`);
    fs.mkdirSync(proot, { recursive: true });
    const fx = fixture();

    // A runner that clones fine and then fails to initialise — exactly the
    // shape that left two orphaned checkouts on the deployed host.
    const ran: string[] = [];
    const runner = async (spec: { kind: string; args: string[]; cwd: string }) => {
      ran.push(spec.kind);
      if (spec.args[0] === 'clone') {
        const dest = path.join(spec.cwd, spec.args[spec.args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'README.md'), '# cloned\n');
        return { ok: true, detail: 'cloned' };
      }
      return { ok: false, detail: 'SyntaxError: Unexpected token (bare node on a .ts entry)' };
    };

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: proot, createRunner: runner,
      });
      const draft = await post(server, '/api/projects/draft',
        { message: 'https://github.com/owner/talkbridge' });
      const made = await post(server, '/api/projects/decide', {
        card: draft.json.card, cardDigest: draft.json.card.digest, decision: 'create',
      });

      check('AT1: a failed init is reported, not silently swallowed',
        made.status === 502 && made.json.error === 'INIT_FAILED',
        JSON.stringify(made.json?.error));
      check('AT1b: and the failure names what actually went wrong',
        /SyntaxError/.test(made.json.detail), made.json.detail);
      check('AT2: NOTHING is left on disk — no orphaned checkout, no staging dir',
        fs.readdirSync(proot).length === 0, fs.readdirSync(proot).join(','));
      check('AT2b: specifically no half-project a human would mistake for one',
        !fs.existsSync(path.join(proot, 'talkbridge')), 'absent');
      check('AT3: the clone did run first — this is the post-clone failure path',
        ran.join(',') === 'clone,init', ran.join(','));
    } finally { await server?.close(); }
  }

  section('project creation: a successful clone lands initialised or not at all');
  {
    const proot = path.join(TMP, `atomok-${seq += 1}`);
    fs.mkdirSync(proot, { recursive: true });
    const fx = fixture();
    const runner = async (spec: { kind: string; args: string[]; cwd: string }) => {
      if (spec.args[0] === 'clone') {
        const dest = path.join(spec.cwd, spec.args[spec.args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        return { ok: true, detail: 'cloned' };
      }
      fs.mkdirSync(path.join(spec.cwd, '.zeus', 'state'), { recursive: true });
      fs.writeFileSync(path.join(spec.cwd, '.zeus', 'config.yaml'),
        'version: 1\nproject:\n  name: talkbridge\n  adapter: node\n');
      return { ok: true, detail: 'init ok' };
    };
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: proot, createRunner: runner,
      });
      const draft = await post(server, '/api/projects/draft',
        { message: 'https://github.com/owner/talkbridge' });
      const made = await post(server, '/api/projects/decide', {
        card: draft.json.card, cardDigest: draft.json.card.digest, decision: 'create',
      });
      check('AT4: a clone that initialises lands under its final name',
        made.status === 201 && made.json.initialised.isProject === true
        && fs.existsSync(path.join(proot, 'talkbridge', '.zeus', 'config.yaml')),
        JSON.stringify(made.json?.error ?? made.status));
      check('AT4b: no staging directory survives a success either',
        fs.readdirSync(proot).join(',') === 'talkbridge', fs.readdirSync(proot).join(','));
      check('AT5: and it appears on the projects home immediately',
        (await get(`${server.url}/api/projects`,
          { authorization: `Bearer ${server.token}` })).json.projects[0].slug === 'talkbridge');
    } finally { await server?.close(); }
  }

  section('the CLI can actually be spawned as a child');
  {
    const argv = zeusCliArgv();
    check('CLI1: running from source, the entry goes through ts-node, not bare node',
      argv.length === 3 && argv[0].endsWith('ts-node') && argv[1] === '--transpile-only'
      && argv[2].endsWith('cli.ts'), argv.join(' '));
    check('CLI2: bare node on the .ts entry is exactly what this prevents',
      !(argv.length === 1 && argv[0].endsWith('.ts')), 'not a bare .ts invocation');
    // The old signature took the project root and resolved the runner inside
    // it, so `mission run` worked in exactly one project — the one Zeus is
    // installed in — and died with MODULE_NOT_FOUND everywhere else. This test
    // could not have caught that: it passed the repository root, which is the
    // one value that made the bug invisible.
    const zeusRoot = path.resolve(__dirname, '..');
    check('CLI3: the runner comes from Zeus\u2019s installation, not from the project worked on',
      argv[0] === path.resolve(zeusRoot, 'node_modules/.bin/ts-node'), argv[0]);
    check('CLI4: and there is no root to pass, so it cannot be pointed at a project',
      zeusCliArgv.length === 0, `arity ${zeusCliArgv.length}`);
  }

  section('the connection status distinguishes a dead server from a stale token');
  {
    check('CS-UI1: the home opens a stream, so its status means something',
      /await loadHome\(\);[\s\S]{0,400}connectStream\(\);/.test(UI_HTML),
      'home connects the stream');
    check('CS-UI2: a 401 is reported as unauthorized, not as offline',
      UI_HTML.includes('unauthorized — token changed?'), 'auth failure named');
    check('CS-UI3: and an unreachable server says so distinctly',
      UI_HTML.includes('server unreachable'), 'unreachable named');
    check('CS-UI4: the stream error handler diagnoses rather than guessing',
      /ES\.onerror = \(\) => \{ void diagnoseConn\(\); \}/.test(UI_HTML),
      'onerror probes');
  }
  section('projects: a write lands in the project the view is showing');
  {
    const root = path.join(TMP, `wsroot-${seq += 1}`);
    fs.mkdirSync(root, { recursive: true });
    const mk = (slug: string) => {
      const dir = path.join(root, slug);
      const st = path.join(dir, '.zeus', 'state');
      fs.mkdirSync(st, { recursive: true });
      fs.writeFileSync(path.join(dir, '.zeus', 'config.yaml'),
        `version: 1\nproject:\n  name: ${slug}\n  adapter: node\n`);
      return new MissionRegistry({ events: new EventStore(st), projectId: slug, stateRoot: st });
    };
    const alphaReg = mk('alpha');
    const betaReg = mk('beta');

    const fx = fixture();
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0, projectsRoot: root,
        operations: {
          compile: async () => ({}) as any,
          plan: async () => ({}) as any,
          evaluate: async () => ({}),
          frontDoor: async (message: string) => ({
            intent: 'WORK_REQUEST' as const, confidence: 0.9, summary: 'work',
            evidenceUsed: [], answer: null, readings: null, degraded: null,
            proposedWork: { goal: message, orientation: null },
          }),
        },
      });

      // The exact shape of the bug: viewing one project, creating from its chat.
      const made = await post(server, '/api/missions?project=beta', { goal: 'improve the readme' });
      check('WS-P1: a mission created while scoped to beta belongs to BETA',
        made.status === 201 && made.json.missionId === 'beta/M-0001',
        JSON.stringify(made.json?.missionId));
      check('WS-P1b: and the server’s own project gained nothing',
        fx.missions.list().length === 0, fx.missions.list().join(','));
      check('WS-P1c: nor did the other project',
        alphaReg.list().length === 0, alphaReg.list().join(','));
      check('WS-P1d: beta’s own log holds it',
        betaReg.list().join(',') === 'beta/M-0001', betaReg.list().join(','));

      // The same through the chat card, which is how the operator hit it.
      const chat = await post(server, '/api/chat?project=alpha',
        { message: 'fix the flaky test' });
      const card = chat.json.card;
      const created = await post(server, '/api/chat/decide?project=alpha',
        { card, cardDigest: card.digest, decision: 'create' });
      check('WS-P2: a mission created from a scoped CHAT card belongs to that project',
        created.status === 201 && created.json.missionId === 'alpha/M-0001',
        JSON.stringify(created.json?.missionId));
      check('WS-P2b: and the chat message was recorded in that project’s log, not the server’s',
        alphaReg.events.read('alpha/CHAT').length >= 1
        && fx.store.listTasks().every((t) => !t.endsWith('/CHAT')),
        String(alphaReg.events.read('alpha/CHAT').length));

      const list = await get(`${server.url}/api/missions?project=alpha`,
        { authorization: `Bearer ${server.token}` });
      check('WS-P3: the view that asked for it now shows it — no empty page after a create',
        list.json.length === 1 && list.json[0].goal === 'fix the flaky test',
        JSON.stringify(list.json.map((m: any) => m.goal)));

      const nowhere = await post(server, '/api/missions?project=ghost', { goal: 'x' });
      check('WS-P4: a write to an unknown project is refused, never redirected somewhere real',
        nowhere.status === 404 && nowhere.json.error === 'NO_SUCH_PROJECT',
        JSON.stringify(nowhere.json?.error));
    } finally { await server?.close(); }
  }

  section('projects: a created project is named after where it lands');
  {
    const proot = path.join(TMP, `nameroot-${seq += 1}`);
    fs.mkdirSync(proot, { recursive: true });
    const fx = fixture();
    // `zeus init` derives the project name from the directory it runs in, and
    // it runs in the staging directory — so without a correction every project
    // is called "<slug>.incoming-<pid>" forever.
    const runner = async (spec: { kind: string; args: string[]; cwd: string }) => {
      if (spec.args[0] === 'clone') {
        const dest = path.join(spec.cwd, spec.args[spec.args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        return { ok: true, detail: 'cloned' };
      }
      fs.mkdirSync(path.join(spec.cwd, '.zeus', 'state'), { recursive: true });
      fs.writeFileSync(path.join(spec.cwd, '.zeus', 'config.yaml'),
        `version: 1\nproject:\n  name: ${path.basename(spec.cwd)}\n  adapter: node\n`);
      return { ok: true, detail: 'init ok' };
    };
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: proot, createRunner: runner,
      });
      const draft = await post(server, '/api/projects/draft',
        { message: 'https://github.com/owner/talkbridge' });
      await post(server, '/api/projects/decide',
        { card: draft.json.card, cardDigest: draft.json.card.digest, decision: 'create' });

      const cfg = fs.readFileSync(path.join(proot, 'talkbridge', '.zeus', 'config.yaml'), 'utf8');
      check('NM1: the project is named for its final directory, not the staging one',
        /name: talkbridge\b/.test(cfg) && !/incoming/.test(cfg),
        cfg.split('\n').find((l) => l.includes('name:')) ?? '');
      const home = await get(`${server.url}/api/projects`,
        { authorization: `Bearer ${server.token}` });
      check('NM1b: and the home shows that name, not a staging artefact',
        home.json.projects[0].projectId === 'talkbridge'
        && home.json.projects[0].slug === 'talkbridge',
        JSON.stringify(home.json.projects[0]?.projectId));
      check('NM1c: no staging directory survived',
        fs.readdirSync(proot).join(',') === 'talkbridge', fs.readdirSync(proot).join(','));
    } finally { await server?.close(); }
  }
  section('the console renders spend and events legibly');
  {
    check('UX1: an empty cost breakdown says so rather than printing "{}"',
      UI_HTML.includes('nothing spent yet') && !/JSON\.stringify\(m\.cost\.byPhase\)/.test(UI_HTML),
      'empty cost has words');
    check('UX2: a populated breakdown is rendered per phase with amounts',
      /byPhase\)\.map\(\(\[k, v\]\)/.test(UI_HTML), 'per-phase rendering');
    check('UX3: the live feed has room to be a feed',
      /#feedwrap \{[^}]*min-height:120px/.test(UI_HTML), 'feed has a minimum height');
    check('UX4: a chat event is labelled chat, not by a stream id that reads like a mission',
      UI_HTML.includes("tail === 'CHAT' ? 'chat'"), 'chat events labelled');
  }

  section('a write acts on the project the console is showing');
  {
    // The bug: `operations` and `spawnRun` were built ONCE around the
    // directory `zeus web` was started in. Reads honoured `?project=`; writes
    // did not. Compiling a mission in any other project asked the wrong
    // registry, and the console said NO_SUCH_MISSION about a mission it was
    // displaying on the same screen.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-wsc-'));
    const mk = (slug: string, goal: string) => {
      const dir = path.join(root, slug);
      const st = path.join(dir, '.zeus', 'state');
      fs.mkdirSync(st, { recursive: true });
      fs.writeFileSync(path.join(dir, '.zeus', 'config.yaml'),
        `version: 1\nproject:\n  name: ${slug}\n  adapter: node\n`);
      const store = new EventStore(st);
      const reg = new MissionRegistry({ events: store, projectId: slug, stateRoot: st });
      reg.create(goal, 'base0');
      return { dir, st };
    };
    const alpha = mk('alpha', 'alpha goal');
    mk('beta', 'beta goal');

    const fx = fixture();
    fx.missions.create('the server-own goal', 'base0');

    const seen: any[] = [];
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        projectsRoot: root,
        spawnRun: (missionId, target) => {
          seen.push({ op: 'run', missionId, target });
          return { ok: true, pid: 4242, detail: 'spawned' };
        },
        operations: {
          compile: async (missionId, target) => {
            seen.push({ op: 'compile', missionId, target });
            return { ok: false, kind: 'TERMINATED', detail: 'stub' } as any;
          },
          plan: async (missionId, target) => {
            seen.push({ op: 'plan', missionId, target });
            return { ok: false, kind: 'TERMINATED', detail: 'stub' } as any;
          },
          evaluate: async (missionId, _o, target) => {
            seen.push({ op: 'evaluate', missionId, target });
            return {};
          },
        },
      });
      const c = await post(server, '/api/missions/M-0001/compile?project=alpha', {});
      // 202: the operation is started, not awaited. Give it a tick to reach
      // the stub, which is the thing this test is actually about.
      await new Promise((r) => setTimeout(r, 50));
      const t = seen.find((x) => x.op === 'compile')?.target;
      check('WSC1: compile acts on the SCOPED project, not the one the server sits in',
        c.status === 202 && t && t.projectId === 'alpha' && t.root === alpha.dir,
        JSON.stringify([c.status, t?.projectId, t?.root]));
      check('WSC1b: and it is handed the id resolved against that same project',
        seen.find((x) => x.op === 'compile')?.missionId === 'alpha/M-0001',
        seen.find((x) => x.op === 'compile')?.missionId);
      check('WSC1c: the state root travels too, so it reads that project’s log',
        t && t.stateRoot === alpha.st, t?.stateRoot);

      await post(server, '/api/missions/M-0001/plan?project=beta', {});
      check('WSC2: a second project in the same server gets its own target',
        seen.find((x) => x.op === 'plan')?.target.projectId === 'beta',
        seen.find((x) => x.op === 'plan')?.target.projectId);

      await post(server, '/api/missions/M-0001/compile', {});
      const own = seen.filter((x) => x.op === 'compile')[1]?.target;
      check('WSC3: with no project param the target is the server’s own project',
        own && own.projectId === 'p' && own.root === fx.root,
        JSON.stringify([own?.projectId, own?.root]));

      // The dangerous one. `run` spawns a real process with a real cwd: an
      // unscoped target would execute a mission inside the wrong repository.
      const r = await post(server, '/api/missions/M-0001/run?project=beta', {});
      const rt = seen.find((x) => x.op === 'run')?.target;
      check('WSC4: run spawns against the scoped project’s root, not the server’s cwd',
        r.status === 202 && rt && rt.root === path.join(root, 'beta'),
        JSON.stringify([r.status, rt?.root]));

      // The consent boundary is a write like any other, and it was the one
      // call site in the UI that forgot to add the scope.
      const conf = await post(server, '/api/missions/M-0001/confirm?project=beta',
        { kind: 'oracle', version: 1, findingsDigest: 'nope', decision: 'ACCEPT' });
      check('WSC5: confirm resolves against the scoped project (no NO_SUCH_MISSION)',
        conf.status !== 404, `${conf.status} ${JSON.stringify(conf.json?.error)}`);

      const bad = await post(server, '/api/missions/M-0001/compile?project=nope', {});
      check('WSC6: an unknown project is refused rather than falling back to the server’s',
        bad.status === 404 && bad.json.error === 'NO_SUCH_PROJECT'
        && seen.filter((x) => x.op === 'compile').length === 2,
        JSON.stringify([bad.status, bad.json?.error]));
    } finally { await server?.close(); }

    // A COUNT of fetch sites was the first version of this, and it broke the
    // moment a legitimate third one arrived. The property is not how many
    // callers there are; it is that the WRITE helper scopes on its own, so a
    // write cannot be sent unscoped by forgetting, and that nothing scopes a
    // second time on top of it.
    check('WSC7: the UI scopes writes in ONE place, so no call site can forget',
      /fetch\('\/api' \+ scope\(p\)/.test(UI_HTML)
      && !/apiPost\(scope\(/.test(UI_HTML),
      'apiPost scopes centrally and nothing double-scopes');
    check('WSC7b: and the one read that bypasses the helper scopes its own url',
      /const url = scope\('\/missions\/' \+ encodeURIComponent/.test(UI_HTML)
      && /fetch\('\/api' \+ url, \{ headers/.test(UI_HTML),
      'the transcript fetch is scoped too');
  }

  section('the console can advance the mission it just created');
  {
    // A mission made from chat sat at CREATED for ever: the card promised
    // compile -> critic -> consent -> plan -> consent -> run and the page
    // offered no control for any of it, though every route already existed.
    const STEPS = [['a', 'CREATED', 'compile'], ['b', 'PLANNING', 'plan'],
      ['c', 'RUNNING', 'run'], ['d', 'INTEGRATING', 'run'],
      ['e', 'EVALUATING', 'run']] as const;
    for (const [tag, phase, verb] of STEPS) {
      check(`ACT1${tag}: phase ${phase} maps to a next step of ${verb}`,
        new RegExp(`${phase}: \\{ id: '${verb}'`).test(UI_HTML), `${phase} -> ${verb}`);
    }
    check('ACT2: a terminated mission offers no step and no cancel',
      /if \(!slot \|\| m\.terminated\) return;/.test(UI_HTML), 'terminated is inert');
    check('ACT3: while a decision is pending there is no step button beside the findings',
      /const step = m\.pendingDecision \? null : NEXT_STEP\[m\.phase\];/.test(UI_HTML),
      'pending suppresses the step');
    check('ACT4: the step posts to the mission route the server actually serves',
      /apiPost\('\/missions\/' \+ short \+ path/.test(UI_HTML)
      && WRITE_ROUTES.includes('POST /api/missions/:id/compile' as any),
      'wired to a real route');
    check('ACT5: the pressed button says it is working, so a slow step is not a dead click',
      UI_HTML.includes("btn.textContent = label + ' …'"), 'in-flight label');
    check('ACT6: every button in the bar is disabled while one is in flight',
      /for \(const x of d\.querySelectorAll\('button'\)\) x\.disabled = true;/.test(UI_HTML),
      'no double submit');
    check('ACT7: a refusal is rendered with its findings, not reduced to a status code',
      /for \(const f of \(j\.findings \|\| \[\]\)\)/.test(UI_HTML), 'findings shown');
    check('ACT8: after a refusal the phase offers a recompile that answers the findings',
      /CONSENT: \{ id: 'compile', label: 'recompile, answering the findings'/.test(UI_HTML),
      'refusal leaves a move');
  }

  section('answering a consent stop ends it');
  {
    // The loop: refusing recorded the decision and changed nothing derivable,
    // so `decidable` stayed true and the console asked the identical question
    // again, for ever, with no way forward from the web.
    const withCritique = (goal: string, findings: unknown[]) => {
      const fx2 = fixture();
      const rec = fx2.missions.create(goal, 'base0');
      const oracle = {
        missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
        compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
        criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
          evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
          affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
      };
      fx2.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
      fx2.missions.recordCritique(rec.missionId, {
        valid: true, findings, modeOpinion: null, promptHash: 'p', hashes: {},
        violations: [], criticProviderId: 'mock', reconciliation: {},
      });
      return { fx: fx2, id: rec.missionId };
    };

    const a = withCritique('a goal that gets refused',
      [{ code: 'CRITERION_BEYOND_GOAL', detail: 'wider than asked' }]);
    const before = pendingDecision(a.fx.missions, a.id);
    check('RF1: before any answer the stop is pending, as it should be',
      !!before && before.layer === 'oracle', String(before?.layer));

    a.fx.missions.recordPlanStopDecision(a.id, {
      version: 1, rendered: ['CRITERION_BEYOND_GOAL: wider than asked'],
      findingsDigest: before!.digest, decision: 'ORACLE_REFUSED',
      decidedBy: 'user-confirmed', deferred: false,
    });
    check('RF2: a refusal a PERSON made ends the stop it answered',
      pendingDecision(a.fx.missions, a.id) === null,
      JSON.stringify(pendingDecision(a.fx.missions, a.id)?.layer ?? null));
    check('RF2b: and the subject says what the next move is, not just that it is over',
      /was refused; the next move is a recompile/
        .test(consentSubject(a.fx.missions, a.id, 'oracle')!.detail),
      consentSubject(a.fx.missions, a.id, 'oracle')!.detail);
    check('RF2c: the list stops marking it as waiting on a human',
      awaitingHuman(a.fx.missions, a.id) === false, 'no longer waiting');

    // The engine records REFUSED_NO_CONSENT with 'nobody yet' when it stops
    // for want of a decision. Treating that as an answer would HIDE a stop.
    const b = withCritique('a goal nobody has answered',
      [{ code: 'WEAK_RUBRIC', detail: 'no threshold' }]);
    b.fx.missions.recordPlanStopDecision(b.id, {
      version: 1, rendered: ['WEAK_RUBRIC: no threshold'],
      decision: 'REFUSED_NO_CONSENT', decidedBy: 'nobody yet', deferred: true,
    });
    check('RF3: the engine stopping for want of consent is NOT an answer',
      pendingDecision(b.fx.missions, b.id) !== null, 'still waiting on a person');

    // A refusal answers the findings that were on screen. A different critique
    // of the same version is a different question and gets asked.
    const c = withCritique('a goal recritiqued',
      [{ code: 'WEAK_RUBRIC', detail: 'first round' }]);
    const firstDigest = pendingDecision(c.fx.missions, c.id)!.digest;
    c.fx.missions.recordPlanStopDecision(c.id, {
      version: 1, rendered: ['WEAK_RUBRIC: first round'], findingsDigest: firstDigest,
      decision: 'ORACLE_REFUSED', decidedBy: 'user-confirmed', deferred: false,
    });
    check('RF4: that refusal ends that stop',
      pendingDecision(c.fx.missions, c.id) === null, 'ended');
    c.fx.missions.recordCritique(c.id, {
      valid: true, findings: [{ code: 'EVALUATOR_DOES_NOT_PROVE_STATEMENT', detail: 'new objection' }],
      modeOpinion: null, promptHash: 'p2', hashes: {}, violations: [],
      criticProviderId: 'mock', reconciliation: {},
    });
    const after = pendingDecision(c.fx.missions, c.id);
    check('RF5: but a NEW critique of the same version is a new question, and is asked',
      !!after && after.digest !== firstDigest
      && after.findings[0].code === 'EVALUATOR_DOES_NOT_PROVE_STATEMENT',
      JSON.stringify(after?.findings?.map((f: any) => f.code)));

    // Over HTTP, end to end: refuse, then confirm the stop is gone from the view.
    const d = withCritique('a goal refused over http',
      [{ code: 'WEAK_RUBRIC', detail: 'no threshold given' }]);
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: d.fx.root, stateRoot: d.fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const view = await get(`${server.url}/api/missions/M-0001`, auth);
      const r = await post(server, '/api/missions/M-0001/confirm', {
        kind: 'oracle', version: 1,
        findingsDigest: view.json.pendingDecision.digest, decision: 'REFUSE',
      });
      const again = await get(`${server.url}/api/missions/M-0001`, auth);
      check('RF6: refusing over HTTP clears the pending block from the mission view',
        r.status === 200 && again.json.pendingDecision === null,
        `${r.status} ${JSON.stringify(again.json?.pendingDecision?.layer ?? null)}`);
      check('RF6b: the recorded decision carries the digest of what was answered',
        d.fx.missions.events.read(d.id).some((e: any) => e.type === 'PLAN_STOP_DECISION'
          && e.payload.findingsDigest === view.json.pendingDecision.digest),
        'digest recorded with the decision');
    } finally { await server?.close(); }
  }

  section('a second compile answers the critic rather than repeating itself');
  {
    // `compileMissionOracle` compiled from scratch every time, so the console's
    // 'send the findings back' sent them nowhere. The compiler has always had a
    // prompt for answering findings; nothing reached it from the web.
    const fx3 = fixture();
    const rec = fx3.missions.create('a goal already compiled', 'base0');
    const oracle = {
      missionId: rec.missionId, version: 1, acceptanceMode: 'REQUIRED_CONSENT',
      compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
      criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE', statement: 's',
        evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
        affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }],
    };
    fx3.missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
    fx3.missions.recordCritique(rec.missionId, {
      valid: true, findings: [{ code: 'WEAK_RUBRIC', detail: 'no threshold' }],
      modeOpinion: null, promptHash: 'p', hashes: {}, violations: [],
      criticProviderId: 'mock', reconciliation: {},
    });
    // Two rounds already spent. The guard is reached BEFORE any provider is
    // invoked, so this proves the delegation without calling a model.
    for (const attempt of [1, 2]) {
      fx3.missions.recordRecompile(rec.missionId, {
        fromVersion: 1, findingsForwarded: 1, attempt, limit: MAX_ORACLE_RECOMPILES,
      });
    }
    const ctx = { missions: fx3.missions, engine: null as any, projectRoot: fx3.root,
      context: { commands: {}, failingChecks: [], findings: [] }, policy: null as any };
    const res: any = await compileMissionOracle(ctx as any, rec.missionId);
    check('RC1: a compile over an unaccepted oracle IS a recompile',
      res.ok === false && res.kind === 'RECOMPILE_LIMIT',
      `${res.kind}`);
    check('RC2: and the limit is explained, not just enforced',
      /needs a person, not another round/.test(res.detail), res.detail);

    const direct: any = await recompileMissionOracle(ctx as any, rec.missionId);
    check('RC3: the CLI and the console reach the SAME operation, with the same limit',
      direct.ok === false && direct.kind === 'RECOMPILE_LIMIT', direct.kind);

    const fresh = fixture();
    const r2 = fresh.missions.create('never compiled', 'base0');
    const none: any = await recompileMissionOracle({ ...ctx, missions: fresh.missions } as any,
      r2.missionId);
    check('RC4: a mission with no oracle cannot be recompiled into one',
      none.ok === false && none.kind === 'NO_ORACLE', none.kind);
  }

  section('a repository whose root is not a package is still a project');
  {
    // A real clone: api/ and app/ side by side, a Dockerfile, and no manifest
    // at the root. Detection looked only at the root, called it `generic`, and
    // init wrote a config where every command was null — so a mission did the
    // work and then correctly refused to integrate it, because nothing could
    // verify it. Over two dollars to reach a stop decided at creation time.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-poly-'));
    fs.mkdirSync(path.join(root, 'api', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'left-over'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'left-over', 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:18\n');
    fs.writeFileSync(path.join(root, 'api', 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', start: 'node dist/index.js' },
      devDependencies: { typescript: '^5.4.0' },
    }));
    fs.writeFileSync(path.join(root, 'api', 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'api', 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'app', 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' } }));
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), '{}');

    const det = detectProject(root);
    check('PL1: it is detected as a node project, not as generic',
      det.primary.id === 'node', det.primary.id);
    check('PL2: the packages are found one level down, and node_modules is not one',
      JSON.stringify(nodePackageDirs(root)) === '["api","app"]',
      JSON.stringify(nodePackageDirs(root)));

    const cmds = det.primary.commands(root);
    check('PL3: typecheck resolves from the one package that can verify',
      cmds.typecheck === 'npm --prefix api exec -- tsc --noEmit -p api',
      String(cmds.typecheck));
    check('PL3b: and it looks for the binary in THAT package, not in the root',
      !/^npx /.test(cmds.typecheck ?? ''), String(cmds.typecheck));
    check('PL4: install comes from THAT package too, so the check has its toolchain',
      cmds.install === 'npm --prefix api ci', String(cmds.install));
    check('PL5: and so does everything else — commands are never mixed across packages',
      cmds.build === 'npm --prefix api run build', String(cmds.build));
    check('PL6: no command contains shell syntax — these are argv, never a shell line',
      Object.values(cmds).every((c) => c === null || !/[&|;()]/.test(c)),
      JSON.stringify(cmds));
    check('PL7: nothing is invented — no package declares a lint script, so there is none',
      cmds.lint === null && cmds.integrationTest === null,
      JSON.stringify([cmds.lint, cmds.integrationTest]));
    check('PL8: every package manifest is protected, not only a root one',
      det.primary.protectedPaths(root).includes('api/package.json')
      && det.primary.protectedPaths(root).includes('app/package-lock.json'),
      'manifests protected');

    // `npx --no-install` still reaches for the registry when the binary is not
    // there. On a package that never brings TypeScript, the inferred typecheck
    // does not fail with a type error — it fails with EAI_AGAIN inside a
    // sandbox with no network, and reads as "your change broke the build".
    const noTs = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-nots-'));
    fs.mkdirSync(path.join(noTs, 'svc'), { recursive: true });
    fs.writeFileSync(path.join(noTs, 'svc', 'package.json'), JSON.stringify({ scripts: {} }));
    fs.writeFileSync(path.join(noTs, 'svc', 'tsconfig.json'), '{}');
    check('PL11: a tsconfig alone does not conjure a typecheck — typescript must be declared',
      detectProject(noTs).primary.commands(noTs).typecheck === null,
      String(detectProject(noTs).primary.commands(noTs).typecheck));

    // Two packages that can both verify cannot be expressed as one argv, and
    // covering half a repository silently would be a green that means less
    // than it looks.
    const two = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-two-'));
    for (const d of ['a', 'b']) {
      fs.mkdirSync(path.join(two, d), { recursive: true });
      fs.writeFileSync(path.join(two, d, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }));
    }
    const twoCmds = detectProject(two).primary.commands(two);
    check('PL12: when two packages can verify, nothing is claimed rather than half of it',
      Object.values(twoCmds).every((c) => c === null), JSON.stringify(twoCmds));
    check('PL12b: but it is still a node project, so the doctor does not call it generic',
      detectProject(two).primary.id === 'node', detectProject(two).primary.id);

    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-poly2-'));
    fs.mkdirSync(path.join(loose, 'svc'), { recursive: true });
    fs.writeFileSync(path.join(loose, 'svc', 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }));
    check('PL9: without a lockfile the install is not a frozen one',
      detectProject(loose).primary.commands(loose).install === 'npm --prefix svc install',
      String(detectProject(loose).primary.commands(loose).install));
    check('PL9b: and the readiness probe can resolve it, because argv[0] is an executable',
      splitCommand(detectProject(loose).primary.commands(loose).install!)[0] === 'npm',
      splitCommand(detectProject(loose).primary.commands(loose).install!)[0]);

    // The doctor printed "Project type detected: Node / JavaScript / TypeScript"
    // and, two lines later, "not a node project". A report that disagrees with
    // itself teaches the reader to skim it.
    const pmProbe = probePackageManager(root, process.env as Record<string, string>);
    check('PL9c: the package-manager probe agrees with the detection above it',
      pmProbe.status !== 'SKIPPED', `${pmProbe.status} ${pmProbe.reason ?? ''}`);
    const notNode = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-nonode-'));
    fs.writeFileSync(path.join(notNode, 'main.go'), 'package main\n');
    check('PL9d: and a repository with no package anywhere is still correctly skipped',
      probePackageManager(notNode, process.env as Record<string, string>).status === 'SKIPPED',
      probePackageManager(notNode, process.env as Record<string, string>).reason ?? '');

    // The root path must be untouched: a repository that IS a package keeps
    // exactly the commands it had before any of this existed.
    const single = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-single-'));
    fs.writeFileSync(path.join(single, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }));
    fs.mkdirSync(path.join(single, 'packages', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(single, 'packages', 'inner', 'package.json'), '{}');
    check('PL10: a repository that IS a package is unchanged, and does not descend',
      nodePackageDirs(single).length === 0
      && detectProject(single).primary.commands(single).unitTest === 'npm run test',
      String(detectProject(single).primary.commands(single).unitTest));
  }

  section('the console shows what the ceiling is, not only that you passed it');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal with a budget', 'base0');
    const id = rec.missionId;

    const b0 = budgetsFor(fx.missions, id);
    check('BG1: a mission starts on the shipped defaults',
      b0.costCeilingUsd === 5 && b0.maxTasks === 20 && b0.maxPlanRecompiles === 3,
      JSON.stringify([b0.costCeilingUsd, b0.maxTasks, b0.maxPlanRecompiles]));

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const v = await get(`${server.url}/api/missions/M-0001`, auth);
      check('BG2: the mission view carries the budget, so the page has something to measure against',
        v.json.budgets && v.json.budgets.costCeilingUsd === 5,
        JSON.stringify(v.json?.budgets?.costCeilingUsd));
      check('BG3: and the usage it is enforced against, from the same source the engine uses',
        v.json.usage && typeof v.json.usage.costUsd === 'number'
        && typeof v.json.usage.planRecompiles === 'number',
        JSON.stringify(v.json?.usage));
      check('BG4: the gauge and the limit cannot disagree — one number, sent once',
        Math.abs(v.json.usage.costUsd - v.json.cost.totalUsd) < 1e-6,
        `${v.json.usage.costUsd} vs ${v.json.cost.totalUsd}`);
    } finally { await server?.close(); }

    check('BG5: the console renders spend against the ceiling',
      /spend[\s\S]{0,80}costCeilingUsd/.test(UI_HTML), 'gauge present');
    // The gauge said "3 of 3 reached" over a cascade that was correctly still
    // running, because one of the three was the attempt a person asked for.
    check('BG5b: the replan gauge counts the AUTOMATIC ones, which is what the limit bounds',
      /now: u\.autoPlanRecompiles, max: b\.maxPlanRecompiles/.test(UI_HTML)
      && !/now: u\.planRecompiles, max: b\.maxPlanRecompiles/.test(UI_HTML),
      'gauge matches the rule it draws');
    check('BG5c: and the human-asked ones are shown as information, not as a limit',
      UI_HTML.includes('bounded by spend rather than by a count'), 'totals explained');
    check('BG6: and says the unmetered calls are NOT inside the number the ceiling checks',
      UI_HTML.includes('reported no price and are not in it'), 'lower bound explained');
  }

  section('a mission can be created with a budget of its own');
  {
    const fx = fixture();
    const under = fx.missions.create('a cheap goal', 'base0', { costCeilingUsd: 2 });
    const over = fx.missions.create('an expensive goal', 'base0',
      { costCeilingUsd: 40, maxTasks: 60 });
    const plain = fx.missions.create('an ordinary goal', 'base0');

    check('CB1: a ceiling BELOW the default is honoured',
      budgetsFor(fx.missions, under.missionId).costCeilingUsd === 2,
      String(budgetsFor(fx.missions, under.missionId).costCeilingUsd));
    check('CB2: and one ABOVE it — the default is a starting value, not a maximum',
      budgetsFor(fx.missions, over.missionId).costCeilingUsd === 40
      && budgetsFor(fx.missions, over.missionId).maxTasks === 60,
      JSON.stringify([budgetsFor(fx.missions, over.missionId).costCeilingUsd,
        budgetsFor(fx.missions, over.missionId).maxTasks]));
    check('CB3: a mission created without one keeps the shipped default',
      budgetsFor(fx.missions, plain.missionId).costCeilingUsd === 5,
      String(budgetsFor(fx.missions, plain.missionId).costCeilingUsd));

    // The whole point of recording it as a revision: budgets are recomputed
    // from the log every cycle, so anything stored elsewhere would be undone.
    const revs = fx.store.read(over.missionId)
      .filter((e: any) => e.type === 'MISSION_BUDGET_REVISED');
    check('CB4: the choice is on the log as MISSION_BUDGET_REVISED, not a field',
      revs.length === 2 && revs.every((e: any) => e.payload.decidedBy === 'user-confirmed'),
      JSON.stringify(revs.map((e: any) => [e.payload.limit, e.payload.from, e.payload.to])));
    check('CB5: and it says whether it went above or below the default',
      revs.some((e: any) => /above the default/.test(e.payload.reason)),
      JSON.stringify(revs.map((e: any) => e.payload.reason)));
    check('CB6: an unchanged limit records nothing — no event that says nothing',
      fx.store.read(plain.missionId)
        .filter((e: any) => e.type === 'MISSION_BUDGET_REVISED').length === 0,
      'no empty revisions');

    // A budget on the card is a budget in the digest. Otherwise it could be
    // changed between rendering and approval and confirm-with-hash would not
    // notice, which is the entire purpose of that rule.
    const cheap = draftCard({ intent: 'WORK', message: 'do a thing', costCeilingUsd: 3 });
    const dear = draftCard({ intent: 'WORK', message: 'do a thing', costCeilingUsd: 30 });
    check('CB7: the ceiling is part of the card',
      cheap.budget.costCeilingUsd === 3 && dear.budget.costCeilingUsd === 30,
      JSON.stringify([cheap.budget.costCeilingUsd, dear.budget.costCeilingUsd]));
    check('CB8: and part of its DIGEST — a different ceiling is a different proposal',
      cheap.digest !== dear.digest, 'digests differ');
    check('CB9: a card above the default says so, in the text the digest covers',
      dear.budget.aboveDefault === true && /ABOVE the default/.test(dear.costExpectation)
      && /authorises the higher ceiling/.test(dear.costExpectation),
      dear.costExpectation);
    check('CB10: a card at or below the default does not cry wolf',
      cheap.budget.aboveDefault === false && !/ABOVE the default/.test(cheap.costExpectation),
      cheap.costExpectation);
    check('CB11: every card states the ceiling it will stop at',
      /stops at \$3\.00 of provider-reported spend/.test(cheap.costExpectation),
      cheap.costExpectation);
    check('CB12: and no longer quotes audit files from Zeus\u2019s own repository',
      !/audits\/missions\//.test(cheap.costExpectation), cheap.costExpectation);

    check('CB13: a ceiling that is not a number falls back to the default rather than NaN',
      sanitiseCeiling('abc') === 5 && sanitiseCeiling(-4) === 5 && sanitiseCeiling(null) === 5,
      JSON.stringify([sanitiseCeiling('abc'), sanitiseCeiling(-4), sanitiseCeiling(null)]));
    check('CB14: and an absurd one is capped rather than accepted',
      sanitiseCeiling(1e9) === MAX_CARD_CEILING_USD, String(sanitiseCeiling(1e9)));

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        operations: {
          compile: async () => ({}) as any,
          plan: async () => ({}) as any,
          evaluate: async () => ({}),
          frontDoor: async (message: string) => ({
            intent: 'WORK_REQUEST' as const, confidence: 0.9, summary: 'work',
            evidenceUsed: [], answer: null, readings: null, degraded: null,
            proposedWork: { goal: message, orientation: null },
          }),
        },
      });
      const auth = { authorization: `Bearer ${server.token}` };

      const drafted = await post(server, '/api/chat',
        { message: 'add a spanish translation', costCeilingUsd: 25 });
      const cardOut = drafted.json.card;
      check('CB15: the chat route drafts the card at the requested ceiling',
        cardOut.budget.costCeilingUsd === 25 && cardOut.budget.aboveDefault === true,
        JSON.stringify(cardOut?.budget));

      const tampered = JSON.parse(JSON.stringify(cardOut));
      tampered.budget.costCeilingUsd = 500;
      const bad = await post(server, '/api/chat/decide',
        { card: tampered, cardDigest: cardOut.digest, decision: 'create' });
      check('CB16: raising the ceiling after the card was rendered is REFUSED',
        bad.status === 409 && bad.json.error === 'CARD_DIGEST_MISMATCH',
        `${bad.status} ${JSON.stringify(bad.json?.error)}`);

      const good = await post(server, '/api/chat/decide',
        { card: cardOut, cardDigest: cardOut.digest, decision: 'create' });
      check('CB17: approving the card creates the mission AT the ceiling it showed',
        good.status === 201
        && budgetsFor(fx.missions, good.json.missionId).costCeilingUsd === 25,
        JSON.stringify([good.status,
          good.json && budgetsFor(fx.missions, good.json.missionId).costCeilingUsd]));

      const direct = await post(server, '/api/missions',
        { goal: 'a goal posted straight to the route', costCeilingUsd: 7.5 });
      check('CB18: the plain create route honours a ceiling too',
        direct.status === 201 && direct.json.budgets.costCeilingUsd === 7.5,
        JSON.stringify(direct.json?.budgets?.costCeilingUsd));
    } finally { await server?.close(); }

    check('CB19: the console lets the ceiling be chosen before the card is approved',
      UI_HTML.includes('cardceilset') && UI_HTML.includes('use this ceiling'),
      'card control present');
    check('CB20: and changing it REDRAWS the card, because the digest changed',
      /apiPost\('\/chat', \{ message: card\.originalGoal, costCeilingUsd: want \}\)/
        .test(UI_HTML), 'redraw not in-place edit');
  }

  section('the budget decision is not CLI-only');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal whose budget moves', 'base0');
    const id = rec.missionId;
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });

      const up = await post(server, '/api/missions/M-0001/budget',
        { limit: 'costCeilingUsd', to: 25 });
      check('MBR1: the ceiling can be raised from the console',
        up.status === 200 && up.json.budgets.costCeilingUsd === 25,
        JSON.stringify([up.status, up.json?.budgets?.costCeilingUsd]));
      check('MBR2: recorded as MISSION_BUDGET_REVISED, by a person',
        fx.store.read(id).some((e: any) => e.type === 'MISSION_BUDGET_REVISED'
          && e.payload.to === 25 && e.payload.decidedBy === 'user-confirmed'),
        'on the log');

      const down = await post(server, '/api/missions/M-0001/budget',
        { limit: 'costCeilingUsd', to: 1 });
      check('MBR3: and lowered — the ceiling moves both ways',
        down.status === 200 && down.json.budgets.costCeilingUsd === 1,
        String(down.json?.budgets?.costCeilingUsd));

      const same = await post(server, '/api/missions/M-0001/budget',
        { limit: 'costCeilingUsd', to: 1 });
      check('MBR4: setting it to what it already is records nothing',
        same.json.unchanged === true
        && fx.store.read(id).filter((e: any) => e.type === 'MISSION_BUDGET_REVISED').length === 2,
        'no empty revision');

      const nonsense = await post(server, '/api/missions/M-0001/budget',
        { limit: 'costCeilingUsd', to: -3 });
      check('MBR5: a negative ceiling is refused, not stored',
        nonsense.status === 400 && nonsense.json.error === 'BAD_LIMIT',
        JSON.stringify(nonsense.json?.error));
      const unknown = await post(server, '/api/missions/M-0001/budget',
        { limit: 'notALimit', to: 5 });
      check('MBR6: and an unknown limit is named, not invented',
        unknown.status === 400 && unknown.json.error === 'NO_SUCH_LIMIT'
        && /known limits are/.test(unknown.json.detail), unknown.json?.detail);

      const other = await post(server, '/api/missions/M-0001/budget',
        { limit: 'maxTasks', to: 40 });
      check('MBR7: any mission limit is reachable, not only the money one',
        other.status === 200 && other.json.budgets.maxTasks === 40,
        String(other.json?.budgets?.maxTasks));
    } finally { await server?.close(); }

    check('MBR8: the route is advertised in the table it belongs to',
      (WRITE_ROUTES as readonly string[]).includes('POST /api/missions/:id/budget'),
      'advertised');
    check('MBR9: the console warns before a ceiling that stops the mission at once',
      /stops this mission immediately/.test(UI_HTML), 'warned');
  }

  section('an answer that arrived is not an outage');
  {
    // A planner returned exit 0, subtype success, and a structured payload with
    // all four expected keys. Zeus discarded it as PROVIDER_UNAVAILABLE because
    // an outage keyword appeared somewhere in 376KB of the model's own text —
    // then told the operator to retry something that had never broken.
    const answered = classifyInfrastructure({
      outcome: 'COMPLETED', answered: true, providerError: null,
      stdout: 'the plan mentions rate limits, a 429 page and an overloaded queue',
    });
    check('PU1: a call that came back parsed is never an outage, whatever it says',
      answered === null, String(answered));

    const silent = classifyInfrastructure({
      outcome: 'COMPLETED', answered: false, providerError: null,
      stdout: 'Error: 529 overloaded',
    });
    check('PU2: with no answer at all, the keywords still mean what they meant',
      typeof silent === 'string' && silent.startsWith('PROVIDER_UNAVAILABLE'), String(silent));

    check('PU3: an outcome the supervisor already called infrastructure is believed first',
      String(classifyInfrastructure({ outcome: 'TIMEOUT', answered: true, stdout: 'x' }))
        .startsWith('TIMEOUT'), 'supervisor outcome wins');
    check('PU4: and so is an error the provider reported about itself',
      String(classifyInfrastructure({ outcome: 'COMPLETED', answered: true,
        providerError: 'api_error 500', stdout: 'x' })).startsWith('PROVIDER_ERROR'),
      'provider signal wins');

    // The exact shape that caused it: the provider's OWN telemetry, saying the
    // rate limit was not hit.
    const telemetry = JSON.stringify({
      type: 'result', subtype: 'success',
      rate_limit: { status: 'allowed', rateLimitType: 'five_hour' },
    });
    check('PU5: telemetry that says the limit was ALLOWED cannot mean unavailable',
      classifyInfrastructure({ outcome: 'COMPLETED', answered: true, stdout: telemetry }) === null,
      'allowed is not an outage');
  }

  section('a replan answers its critic instead of starting again');
  {
    // Two plans in a row put the site chrome outside the localisation nodes,
    // for the same reason, because the second planner had never seen the first
    // critique. planMission has accepted a `prior` since M3; nothing passed one.
    const fx = fixture();
    const rec = fx.missions.create('localise the landing page', 'base0');
    const id = rec.missionId;
    const graph = { version: 1, nodes: [
      node(`${id}/N-0001`), node(`${id}/N-0002`),
    ] } as any;
    graph.nodes[1].dependsOn = [`${id}/N-0001`];
    fx.missions.recordPlan(id, graph, [
      { code: 'CRITERION_SCOPE_MISMATCH', severity: 'info', detail: 'writes only part of app/src' },
    ]);
    fx.missions.recordPlanCritique(id, {
      version: 1, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
      findings: [
        { code: 'INCOMPLETE_CHROME', severity: 'BLOCKING', nodeId: `${id}/N-0002`,
          detail: 'the header and footer are never translated' },
        { code: 'TIDY_UP', severity: 'ADVISORY', detail: 'a nicety' },
      ],
    });

    const prior = priorPlanFor(fx.missions, id);
    check('PF-P1: the previous plan is found on the log, whichever process asks',
      !!prior && prior.prior.version === 1 && prior.prior.graph.nodes.length === 2,
      JSON.stringify([prior?.prior?.version, prior?.prior?.graph?.nodes?.length]));
    check('PF-P2: and it carries the critic findings, with their severity',
      !!prior && prior.prior.critic!.length === 2
      && prior.prior.critic!.some((f: any) => f.severity === 'BLOCKING'),
      JSON.stringify(prior?.prior?.critic?.map((f: any) => [f.code, f.severity])));
    check('PF-P3: and the validator findings, which are a different account',
      !!prior && prior.prior.findings.length === 1
      && (prior.prior.findings[0] as any).code === 'CRITERION_SCOPE_MISMATCH',
      JSON.stringify(prior?.prior?.findings));

    const none = priorPlanFor(fx.missions, fx.missions.create('a fresh goal', 'base0').missionId);
    check('PF-P4: a first plan gets no prior — an empty one would say it was revising',
      none === null, JSON.stringify(none));
  }

  section('a revision that ignored its critic is refused before anyone is paid');
  {
    // The check is on the finding CODES, because those are what the planner was
    // handed. Prose about "addressing the feedback" answers nothing nameable.
    const before = { version: 1, nodes: [node('p/M-0001/N-0001')] } as any;
    const after = { version: 2, nodes: [node('p/M-0001/N-0001')] } as any;
    const d = planDelta(before, after);
    check('PDL1: an untouched node is KEPT, not counted as changed',
      d.kept.length === 1 && d.changed.length === 0 && d.added.length === 0,
      JSON.stringify(d));

    const moved = { version: 2, nodes: [
      { ...node('p/M-0001/N-0001'), writes: ['app/src/shell.jsx'] },
      node('p/M-0001/N-0002'),
    ] } as any;
    const d2 = planDelta(before, moved);
    check('PDL2: a node whose writes changed is CHANGED, and a new one is ADDED',
      d2.changed.join() === 'N-0001' && d2.added.join() === 'N-0002',
      JSON.stringify(d2));
    const d3 = planDelta(before, { version: 2, nodes: [node('p/M-0001/N-0009')] } as any);
    check('PDL3: a revision that replaced everything shows it, rather than hiding in a diff',
      d3.kept.length === 0 && d3.removed.join() === 'N-0001' && d3.added.join() === 'N-0009',
      JSON.stringify(d3));

    check('PDL4: the planner is told a revision must resolve each blocking finding',
      /BLOCKING_FINDING_UNANSWERED/.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'mission', 'planner.ts'), 'utf8')),
      'unanswered findings are a validator refusal');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'planner.ts'), 'utf8');
    check('PDL5: and that it is a REVISION, so the difference is exactly the fix',
      /THIS IS A REVISION, NOT A NEW PLAN/.test(src), 'revision instruction present');
    check('PDL6: the unanswered check runs before the critic, not after',
      src.indexOf('BLOCKING_FINDING_UNANSWERED') < src.indexOf('The plan critic'),
      'deterministic refusal comes first');
  }

  section('a dead end says what it is');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal whose plan was rejected', 'base0');
    const id = rec.missionId;
    fx.missions.recordPlan(id, { version: 1, nodes: [node(`${id}/N-0001`)] } as any, []);
    fx.missions.recordPlanCritique(id, {
      version: 1, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
      findings: [{ code: 'INCOMPLETE_CHROME', severity: 'BLOCKING',
        detail: 'the header and footer are never translated' }],
    });

    const b = blockedBy(fx.missions, id);
    check('DE1: a rejected plan is reported as a dead end, not as nothing',
      !!b && b.reason === 'PLAN_REJECTED', JSON.stringify(b?.reason));
    check('DE2: with the findings that actually stand',
      !!b && b.findings.length === 1
      && (b.findings[0] as any).code === 'INCOMPLETE_CHROME',
      JSON.stringify(b?.findings));
    check('DE3: and the moves a person can make',
      !!b && b.options.some((o) => /^plan again/.test(o))
      && b.options.includes('cancel the mission'), JSON.stringify(b?.options));
    check('DE3b: with budget left, planning again is something the CONSOLE can do',
      b!.canPlanAgain === true, String(b?.canPlanAgain));

    // Spend Zeus's OWN replans. The mission is still affordable, so the
    // operator keeps the option — what changes is that Zeus stops trying by
    // itself and says whose turn it is.
    for (let i = 0; i < 3; i += 1) {
      fx.missions.recordPlanCritique(id, {
        version: 1, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
        findings: [{ code: 'INCOMPLETE_CHROME', severity: 'BLOCKING', detail: 'again' }],
      });
    }
    const spent = blockedBy(fx.missions, id);
    check('DE4: with its automatic replans spent, Zeus stops and hands the next one to you',
      !!spent && spent.reason === 'REJECTED_AND_EXHAUSTED'
      && spent.canPlanAgain === true
      && /yours to ask for/.test(spent.detail),
      `${spent?.reason} canPlanAgain=${spent?.canPlanAgain}`);

    const clean = fixture();
    const ok = clean.missions.create('a goal with no plan yet', 'base0');
    check('DE5: a mission with no plan is not a dead end',
      blockedBy(clean.missions, ok.missionId) === null, 'no plan, no dead end');

    check('DE6: the console renders the dead end instead of a button that cannot work',
      /if \(m\.blockedBy\) \{/.test(UI_HTML)
      && UI_HTML.includes('This mission cannot go forward as planned'),
      'dead end rendered');
    check('DE7: findings first, options second — the order every consent surface uses',
      UI_HTML.indexOf('finding(s) against the last plan') < UI_HTML.indexOf('What you can do'),
      'findings before options');
    check('DE8: a button only for what the console can actually do',
      /if \(b\.canPlanAgain\) \{/.test(UI_HTML)
      && UI_HTML.includes('plan again, answering the findings'),
      'plan button is conditional');
  }

  section('one runner per mission');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal someone runs twice', 'base0');
    const id = rec.missionId;

    check('RL1: a mission nobody is running has no claim on it',
      liveRun(fx.missions, id) === null, 'unclaimed');

    fx.missions.recordRunStarted(id, process.pid);
    const held = liveRun(fx.missions, id);
    check('RL2: a claim names the process holding it, and that it is alive',
      !!held && held.pid === process.pid && held.alive === true, JSON.stringify(held));

    fx.missions.recordRunFinished(id, process.pid, 'PARTIAL');
    check('RL3: releasing it clears the claim',
      liveRun(fx.missions, id) === null, 'released');

    // A crashed runner must not lock a mission for ever, so the claim is
    // checked against the world rather than believed.
    const gonePid = 999_999;
    fx.missions.recordRunStarted(id, gonePid);
    const stale = liveRun(fx.missions, id);
    check('RL4: a claim from a process that is gone is not alive',
      !!stale && stale.pid === gonePid && stale.alive === false, JSON.stringify(stale));

    let server: RunningServer | null = null;
    const spawns: string[] = [];
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        spawnRun: (missionId) => { spawns.push(missionId); return { ok: true, pid: 1234, detail: 'spawned' }; },
      });
      const dead = await post(server, '/api/missions/M-0001/run', {});
      check('RL5: a dead claim does not block a new run',
        dead.status === 202 && spawns.length === 1, `${dead.status} ${spawns.length}`);

      fx.missions.recordRunFinished(id, gonePid, 'ABANDONED');
      fx.missions.recordRunStarted(id, process.pid);
      const second = await post(server, '/api/missions/M-0001/run', {});
      check('RL6: a LIVE run makes a second one a 409, not a second process',
        second.status === 409 && second.json.error === 'ALREADY_RUNNING'
        && spawns.length === 1,
        `${second.status} ${second.json?.error} spawns=${spawns.length}`);
      check('RL7: and it says which process has it, so the answer is actionable',
        second.json.pid === process.pid && typeof second.json.startedAt === 'string',
        JSON.stringify([second.json?.pid, second.json?.startedAt]));

      const view = await get(`${server.url}/api/missions/M-0001`,
        { authorization: `Bearer ${server.token}` });
      check('RL8: the mission view says what is running, so a button can refuse',
        view.json.running && view.json.running.kind === 'run'
        && view.json.running.pid === process.pid, JSON.stringify(view.json?.running));
    } finally { await server?.close(); }

    check('RL9: the console renders the running state instead of the step button',
      /if \(m\.running\) \{/.test(UI_HTML) && UI_HTML.includes('is running on this mission'),
      'busy panel present');
    check('RL10: and leaves only a way to stop it',
      /slot\.appendChild\(stop\);\s*\n\s*return;/.test(UI_HTML), 'cancel only');
  }

  section('a mission whose runner was killed says so');
  {
    // `detached: true` calls setsid(), which leaves the terminal SESSION.
    // systemd tracks cgroups, not sessions, so the runner stayed inside
    // zeus-web's control group and one `systemctl restart` SIGKILLed a mission
    // four minutes into its first task. On the page it looked exactly like a
    // mission that was merely slow: phase RUNNING, nothing pending, nothing
    // blocked, and a task frozen in DESIGN.
    const fx = fixture();
    const rec = fx.missions.create('a goal whose runner was killed', 'base0');
    const id = rec.missionId;
    fx.missions.recordRunStarted(id, 999_999);
    fx.missions.taskSpawned(id, 'p/T-0001', `${id}/N-0001`, 1);

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const v = await get(`${server.url}/api/missions/M-0001`, auth);
      check('ORP1: the mission reports the claim nobody is holding',
        v.json.abandonedRun && v.json.abandonedRun.pid === 999_999,
        JSON.stringify(v.json?.abandonedRun));
      check('ORP2: and which tasks it left mid-flight',
        v.json.abandonedRun.stranded.length === 1
        && v.json.abandonedRun.stranded[0] === 'p/T-0001',
        JSON.stringify(v.json?.abandonedRun?.stranded));
      check('ORP3: it is NOT reported as running — the process is gone',
        v.json.running === null, JSON.stringify(v.json?.running));

      // A claim that was released is not an abandonment.
      fx.missions.recordRunFinished(id, 999_999, 'PARTIAL');
      const after = await get(`${server.url}/api/missions/M-0001`, auth);
      check('ORP4: a released claim leaves nothing to report',
        after.json.abandonedRun === null, JSON.stringify(after.json?.abandonedRun));

      // Nor is a mission that ended: its runner is supposed to be gone.
      const fx2 = fixture();
      const r2 = fx2.missions.create('a finished mission', 'base0');
      fx2.missions.recordRunStarted(r2.missionId, 999_998);
      fx2.missions.cancel(r2.missionId, 'done with it');
      let s2: RunningServer | null = null;
      try {
        s2 = await startWebServer({
          projectRoot: fx2.root, stateRoot: fx2.state, projectId: 'p', port: 0 });
        const t = await get(`${s2.url}/api/missions/M-0001`,
          { authorization: `Bearer ${s2.token}` });
        check('ORP5: a terminated mission is not an abandoned one',
          t.json.abandonedRun === null, JSON.stringify(t.json?.abandonedRun));
      } finally { await s2?.close(); }
    } finally { await server?.close(); }

    // Against the RENDERED string, not the phrase — the first version matched
    // a comment forty lines above the code it was trying to order.
    check('ORP6: the console says it before anything else on the page',
      UI_HTML.indexOf('The runner for this mission is gone')
        < UI_HTML.indexOf('</b> is running on this mission'), 'stated first');
    check('ORP7: and says nothing was lost, because the log is the record',
      UI_HTML.includes('Nothing was lost \u2014 the log is the record'), 'reassured');
  }

  section('comparing two calls answers the replanning question directly');
  {
    // The bug this exists for: two planner calls in a row repeated the same
    // mistake because the second was never given the critic's findings on the
    // first, and establishing that took a code read. By section hash it is one
    // line — blocking-findings is in neither, or in both.
    const mk = (id: string, sections: Array<[string, string, boolean?]>,
      model: string | null, ms: number) => ({
      traceCallId: id, stage: 'planner', provider: 'codex',
      configuredModel: model, configuredReasoning: 'high', actualModel: model,
      modelDiscrepancy: null, promptHash: null, promptBytes: null,
      manifest: sections.map(([label, hash, excluded]) => ({
        kind: 'other', label, hash, bytes: hash.length,
        included: excluded !== true,
      })),
      delivered: null, checklist: null, traceLevel: 'normal', traceLevelSource: 'zeus-default',
      promptBlob: null, responseBlob: null,
      outcome: 'COMPLETED', wallMs: ms, providerTiming: null, usage: null, toolsUsed: null,
      parsed: null, infrastructureFailure: null,
      startedAt: null, finishedAt: null, pid: null, status: 'COMPLETED' as const,
    });

    const v1 = mk('TC-v1', [['mission goal', 'h-goal'], ['accepted criteria', 'h-crit']],
      'gpt-5.5', 40_000);
    const v2 = mk('TC-v2', [['mission goal', 'h-goal'], ['accepted criteria', 'h-crit-2'],
      ['BLOCKING findings', 'h-block']], 'gpt-5.6-sol', 61_000);

    const cmp = compareCalls([v1, v2] as any, 'TC-v1', 'TC-v2')!;
    check('CMP1: the findings the second call gained are named as ADDED',
      cmp.added.join() === 'BLOCKING findings', JSON.stringify(cmp.added));
    check('CMP2: a section both got, byte for byte, is SAME',
      cmp.same.join() === 'mission goal', JSON.stringify(cmp.same));
    check('CMP3: a section both got with different content is CHANGED, not same',
      cmp.changed.join() === 'accepted criteria', JSON.stringify(cmp.changed));
    check('CMP4: a model or effort change is surfaced beside the context change',
      cmp.modelChanged?.to === 'gpt-5.6-sol' && cmp.reasoningChanged === null,
      JSON.stringify([cmp.modelChanged, cmp.reasoningChanged]));
    check('CMP5: and the duration difference, so a slower call is visible',
      cmp.costDeltaMs === 21_000, String(cmp.costDeltaMs));

    // The regression, stated as a test: a v2 that lost the findings.
    const lost = compareCalls([v2, v1] as any, 'TC-v2', 'TC-v1')!;
    check('CMP6: a call that LOST a section is named, which is the bug we shipped',
      lost.removed.join() === 'BLOCKING findings', JSON.stringify(lost.removed));

    // A withheld section was not given, whatever its hash says.
    const withheld = mk('TC-w', [['mission goal', 'h-goal'],
      ['BLOCKING findings', 'h-block', true]], 'gpt-5.5', 10);
    const w = compareCalls([v2, withheld] as any, 'TC-v2', 'TC-w')!;
    check('CMP7: a withheld section counts as not given, not as given-and-equal',
      w.removed.includes('BLOCKING findings'), JSON.stringify(w.removed));

    check('CMP8: an unknown call id yields nothing rather than a misleading diff',
      compareCalls([v1] as any, 'TC-v1', 'TC-nope') === null, 'null for unknown');

    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    check('CMP9: stored content is never printed without --raw',
      /if \(rest\.includes\('--raw'\)\) \{/.test(cli)
      && /--raw prints what was kept/.test(cli),
      'a duration check should not paste a repository into a shared terminal');
  }

  section('how much of a call is kept, and for how long');
  {
    check('TL1: mission over project over global over the shipped default',
      resolveTraceLevel({ mission: 'debug', project: 'audit', global: 'normal' }).level === 'debug'
      && resolveTraceLevel({ project: 'audit', global: 'normal' }).source === 'project'
      && resolveTraceLevel({ global: 'audit' }).source === 'global'
      && resolveTraceLevel({}).source === 'zeus-default',
      'precedence holds');
    check('TL2: the shipped default is normal — debug never arrives by inheritance',
      resolveTraceLevel({}).level === 'normal', resolveTraceLevel({}).level);
    check('TL3: a level nobody recognises is ignored rather than obeyed',
      resolveTraceLevel({ mission: 'verbose' as any, project: 'audit' }).level === 'audit',
      'unknown falls through');

    check('TL4: every level keeps the same skeleton; only content differs',
      retains('normal').prompt === false && retains('audit').prompt === true
      && retains('debug').prompt === true,
      'structure is not a level decision');
    check('TL5: audit redacts and debug does not, and each says which it is',
      retains('audit').redacted === true && retains('debug').redacted === false,
      'the flag is on the ref, not inferred from the level');
    check('TL6: debug expires soonest, normal metadata never',
      retains('debug').defaultTtlHours === 72
      && retains('audit').defaultTtlHours === 720
      && retains('normal').defaultTtlHours === null,
      JSON.stringify([retains('debug').defaultTtlHours, retains('audit').defaultTtlHours]));

    const store = new TraceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-trace-')));
    const secret = 'here is a key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK and more text';
    check('TL7: at normal, nothing is kept at all',
      store.put(secret, 'normal') === null, 'no blob');

    const audit = store.put(secret, 'audit')!;
    const readBack = store.get(audit)!;
    check('TL8: at audit the content is REDACTED BEFORE it reaches disk',
      !readBack.includes('sk-ant-api03-AAAABBBBCCCC') && audit.redacted === true,
      readBack.slice(0, 60));
    check('TL8b: and the surrounding text survives — redaction is not deletion',
      readBack.includes('here is a key') && readBack.includes('and more text'),
      'structure preserved');

    const dbg = store.put(secret, 'debug')!;
    check('TL9: at debug it is kept raw, and the ref says so rather than implying it',
      store.get(dbg)!.includes('sk-ant-api03-AAAABBBBCCCC') && dbg.redacted === false,
      'raw and labelled');

    const twice = store.put('identical body', 'debug')!;
    const again = store.put('identical body', 'debug')!;
    check('TL10: identical content is stored once — safe because blobs never change',
      twice.hash === again.hash, twice.hash.slice(0, 20));

    const big = store.put('x'.repeat(MAX_BLOB_BYTES + 5000), 'debug')!;
    check('TL11: oversized content is cut and SAYS it was, with both sizes',
      big.truncated === true && big.bytes > big.storedBytes
      && store.get(big)!.includes('[truncated by Zeus:'),
      `${big.bytes} -> ${big.storedBytes}`);

    // Expiry has to be real. Hiding expired bytes from a viewer while they sit
    // on disk is the same defect as redacting in the viewer.
    const swept = store.sweep(Date.now() + 100 * 3600_000);
    check('TL12: a sweep really unlinks expired blobs rather than hiding them',
      swept.removed > 0 && store.get(dbg) === null,
      `${swept.removed} removed, ${swept.freedBytes} bytes freed`);

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trace.ts'), 'utf8');
    check('TL13: redaction is in the STORE, not in a reader',
      /REDACTION HAPPENS HERE, before the bytes reach disk/.test(src)
      && /redactPayload/.test(src), 'the boundary is the store');
  }

  section('changing the level affects the next call, not the last one');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal whose trace level moves', 'base0');
    const id = rec.missionId;
    const priorHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-xdg2-'));

    let server: RunningServer | null = null;
    try {
      check('TR-L1: a mission starts at the shipped default, and says which tier that was',
        traceLevelFor(fx.missions, id, fx.root).level === 'normal'
        && traceLevelFor(fx.missions, id, fx.root).source === 'zeus-default',
        JSON.stringify(traceLevelFor(fx.missions, id, fx.root)));

      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });

      const debugNoAck = await post(server, '/api/missions/M-0001/trace', { level: 'debug' });
      check('TR-L2: debug is refused until the warning is acknowledged',
        debugNoAck.status === 409 && debugNoAck.json.error === 'DEBUG_NOT_ACKNOWLEDGED'
        && /secrets, credentials/.test(debugNoAck.json.warning),
        debugNoAck.json?.warning?.slice(0, 50));

      const toAudit = await post(server, '/api/missions/M-0001/trace', { level: 'audit' });
      check('TR-L3: a level a person chose is recorded as a revision, from and to',
        toAudit.status === 200 && toAudit.json.from === 'normal' && toAudit.json.to === 'audit'
        && fx.store.read(id).some((e: any) => e.type === 'MISSION_TRACE_LEVEL_REVISED'
          && e.payload.decidedBy === 'user-confirmed'),
        JSON.stringify([toAudit.json?.from, toAudit.json?.to]));
      check('TR-L4: and it becomes the mission tier, beating project and global',
        traceLevelFor(fx.missions, id, fx.root).level === 'audit'
        && traceLevelFor(fx.missions, id, fx.root).source === 'mission',
        JSON.stringify(traceLevelFor(fx.missions, id, fx.root)));

      const ack = await post(server, '/api/missions/M-0001/trace',
        { level: 'debug', acknowledged: true });
      check('TR-L5: acknowledged, debug is accepted',
        ack.status === 200 && ack.json.to === 'debug', `${ack.status} ${ack.json?.to}`);
      check('TR-L6: history is not rewritten — the earlier revision still says audit',
        fx.store.read(id).filter((e: any) => e.type === 'MISSION_TRACE_LEVEL_REVISED')
          .map((e: any) => e.payload.to).join() === 'audit,debug',
        'both revisions stand');

      const same = await post(server, '/api/missions/M-0001/trace',
        { level: 'debug', acknowledged: true });
      check('TR-L7: setting it to what it already is records nothing',
        same.json.unchanged === true
        && fx.store.read(id).filter((e: any) => e.type === 'MISSION_TRACE_LEVEL_REVISED').length === 2,
        'no empty revision');

      const bad = await post(server, '/api/missions/M-0001/trace', { level: 'loud' });
      check('TR-L8: a level nobody recognises is refused with the ones that exist',
        bad.status === 400 && /normal, audit, debug/.test(bad.json.detail), bad.json?.detail);
    } finally {
      await server?.close();
      if (priorHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorHome;
    }

    const ops = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'operations.ts'), 'utf8');
    check('TR-L9: the policy is snapshotted at call start, not read during the call',
      /SNAPSHOTTED HERE, at call start/.test(ops), 'a running call keeps its policy');
  }

  section('what the model was given, derived from the giving');
  {
    // The question this exists for: "did the critic's findings reach the next
    // planner?" Two plans in a row repeated the same mistake and it took a
    // code read to establish that nothing had ever passed `prior`.
    const a = assemble('HEADER', [
      { kind: 'mission-goal', label: 'mission goal', content: 'localise the page' },
      { kind: 'blocking-findings', label: 'BLOCKING findings',
        content: 'INCOMPLETE_CHROME: the header is never translated' },
      { kind: 'advisory-findings', label: 'advisory findings', content: '',
        excludedReason: 'the critic raised none' },
    ]);
    check('CX1: the prompt carries every included section, in order',
      a.prompt.indexOf('mission goal') < a.prompt.indexOf('BLOCKING findings')
      && a.prompt.includes('INCOMPLETE_CHROME'), 'ordered and present');
    check('CX2: a withheld section is NOT in the prompt',
      !a.prompt.includes('advisory findings'), 'withheld means absent from the text');
    check('CX3: but it IS in the manifest, with the reason it was withheld',
      a.manifest.length === 3
      && a.manifest[2].included === false
      && a.manifest[2].excludedReason === 'the critic raised none',
      JSON.stringify(a.manifest[2]));
    check('CX4: every section is hashed, so a later reader can check the claim',
      a.manifest.every((m) => m.hash.startsWith('sha256:')), 'hashed');
    check('CX5: the manifest is derived from the SAME array that built the prompt',
      a.delivered.join() === 'mission-goal,blocking-findings',
      a.delivered.join());
    check('CX6: the checklist tells present from withheld from empty',
      JSON.stringify(checklist(a.manifest).map((c) => [c.kind, c.state]))
        === JSON.stringify([['mission-goal', 'present'], ['blocking-findings', 'present'],
          ['advisory-findings', 'withheld']]),
      JSON.stringify(checklist(a.manifest).map((c) => [c.kind, c.state])));
    check('CX7: an included-but-empty section reads absent, not present',
      checklist(assemble('H', [{ kind: 'repo-evidence', label: 'evidence', content: '' }])
        .manifest)[0].state === 'absent', 'empty is absent');

    // The property that matters: a caller cannot say it forwarded the findings
    // and then not forward them, because the statement IS the forwarding.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'planner.ts'), 'utf8');
    check('CX8: the planner assembles sections rather than concatenating strings',
      /const assembled = assemble\(planHeader, sections\)/.test(src)
      && /join\('.n'\) : PLAN_HEADER;/.test(src)
      && /kind: 'blocking-findings'/.test(src), 'sections, not a string');
    check('CX9: and records the manifest on the call that used it',
      /manifest: assembled\.manifest, delivered: assembled\.delivered/.test(src),
      'manifest travels with the call');
    const csrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'compile.ts'), 'utf8');
    check('CX10: the compiler does the same, so both planning stages are comparable',
      /const assembled = assemble\(header, sections\)/.test(csrc)
      && /join\('.n'\) : COMPILE_HEADER;/.test(csrc),
      'compiler assembles too — from a header composed for this call');
    check('CX11: the critics reuse the payload manifest they already built',
      /delivered: payload\.deliveredContext/.test(csrc), 'one manifest, not two');
  }

  section('the trace pairs every model call, and knows a dead one');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal with model calls', 'base0');
    const id = rec.missionId;
    const call = (tid: string, stage: string, finish: any) => {
      fx.store.append({ taskId: id, type: 'MODEL_CALL_STARTED', payload: {
        traceCallId: tid, stage, provider: 'codex', configuredModel: 'gpt-5.5',
        configuredReasoning: 'high', promptHash: 'sha256:aa', promptBytes: 1200,
        pid: finish === 'dead' ? 999_999 : process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
      } });
      if (finish && finish !== 'dead') {
        fx.store.append({ taskId: id, type: 'MODEL_CALL_FINISHED', payload: {
          traceCallId: tid, stage, provider: 'codex', outcome: 'COMPLETED',
          configuredModel: 'gpt-5.5', actualModel: finish.actual ?? null,
          ...(finish.actual && finish.actual !== 'gpt-5.5'
            ? { modelDiscrepancy: { configured: 'gpt-5.5', actual: finish.actual } } : {}),
          wallMs: 4200, parsed: { ok: true, structuredKeys: ['criteria'] },
          finishedAt: '2026-01-01T00:01:00.000Z',
        } });
      }
    };
    call('TC-a', 'oracle', { actual: 'gpt-5.5' });
    call('TC-b', 'oracle-critic', { actual: 'gpt-5.6-sol' });
    call('TC-c', 'planner', 'dead');

    const calls = missionTrace(fx.missions, id);
    check('TC1: every call is paired, in the order it was opened',
      calls.length === 3 && calls.map((c) => c.traceCallId).join() === 'TC-a,TC-b,TC-c',
      calls.map((c) => c.traceCallId).join());
    check('TC2: a completed call carries what was asked AND what answered',
      calls[0].configuredModel === 'gpt-5.5' && calls[0].actualModel === 'gpt-5.5'
      && calls[0].status === 'COMPLETED', JSON.stringify(calls[0].status));
    check('TC3: a model that is not the one asked for is flagged as a discrepancy',
      !!calls[1].modelDiscrepancy
      && calls[1].modelDiscrepancy!.actual === 'gpt-5.6-sol',
      JSON.stringify(calls[1].modelDiscrepancy));
    check('TC4: and a call whose process is gone is ABANDONED, not forever running',
      calls[2].status === 'ABANDONED' && calls[2].finishedAt === null,
      calls[2].status);
    check('TC5: an unfinished call from a LIVE process is still running, not abandoned',
      (() => {
        const fx2 = fixture();
        const r2 = fx2.missions.create('a live one', 'base0');
        fx2.store.append({ taskId: r2.missionId, type: 'MODEL_CALL_STARTED',
          payload: { traceCallId: 'TC-live', stage: 'oracle', pid: process.pid } });
        return missionTrace(fx2.missions, r2.missionId)[0].status === 'RUNNING';
      })(), 'live means running');

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const r = await get(`${server.url}/api/missions/M-0001/trace`, auth);
      check('TC6: the route serves the paired calls',
        r.status === 200 && r.json.calls.length === 3, `${r.status} ${r.json?.calls?.length}`);
      const missing = await get(`${server.url}/api/missions/M-9999/trace`, auth);
      check('TC7: an unknown mission is 404 rather than an empty trace',
        missing.status === 404, String(missing.status));
    } finally { await server?.close(); }

    check('TC8: the console shows what answered only when it DIFFERS from what was asked',
      /if \(c\.modelDiscrepancy\) \{/.test(UI_HTML)
      && /answered by <b>/.test(UI_HTML), 'discrepancy is the signal');
    // The footer claimed nothing was stored while audit was busy storing it.
    // A small lie is what makes a reader stop believing the rest of the page.
    // Pinned as a property rather than as prose: BOTH branches must name the
    // level they describe, so neither can drift back into asserting a fixed
    // fact about storage that the level contradicts.
    check('TC9: what is said about storage comes from the LEVEL, not a fixed string',
      /const kept = d\.calls\.some\(\(c\) => c\.promptBlob \|\| c\.responseBlob\)/.test(UI_HTML)
      && (UI_HTML.match(/ran at ' \+ esc\(lvl\)/g) || []).length === 2,
      'both truths are available, and each names the level it is describing');
  }

  section('every stage of the pipeline routes on its own');
  {
    // Seven stages used to be three settings. The oracle and the planner both
    // took providers.planner; the oracle critic and the plan critic both took
    // providers.reviewer. Wanting a cheaper model for one and not the other
    // was not expressible, and no log said which model wrote a plan.
    check('RT1: the pipeline has eight stages, each nameable on its own',
      PIPELINE_STAGES.length === 8
      && PIPELINE_STAGES.includes('oracle') && PIPELINE_STAGES.includes('planner')
      && PIPELINE_STAGES.includes('oracle-critic') && PIPELINE_STAGES.includes('plan-critic')
      && PIPELINE_STAGES.includes('repair'),
      PIPELINE_STAGES.join(', '));

    const split = resolveRouting({ project: {
      oracle: { provider: 'claude', model: 'opus', reasoning: 'high' },
      planner: { provider: 'codex', model: 'gpt-5.4-mini', reasoning: 'low' },
    } });
    const at = (st: string) => split.find((r) => r.stage === st)!;
    check('RT2: the oracle and the planner are separate settings, though both plan',
      at('oracle').model === 'opus' && at('planner').model === 'gpt-5.4-mini'
      && at('oracle').role === at('planner').role,
      `${at('oracle').model} vs ${at('planner').model}, both role ${at('oracle').role}`);
    check('RT3: and so are the two critics, though both review',
      STAGE_ROLE['oracle-critic'] === 'reviewer' && STAGE_ROLE['plan-critic'] === 'reviewer'
      && at('oracle-critic').stage !== at('plan-critic').stage,
      'distinct stages, one role');

    // Precedence is per FIELD. An operator who sets only the reasoning level
    // in a project should keep the global choice of model, not fall back to
    // the Zeus default for it.
    const layered = resolveRouting({
      global: { 'plan-critic': { model: 'gpt-5.6-terra', reasoning: 'high' } },
      project: { 'plan-critic': { reasoning: 'xhigh' } },
    });
    const pc = layered.find((r) => r.stage === 'plan-critic')!;
    check('RT4: project over global over Zeus default, field by field',
      pc.model === 'gpt-5.6-terra' && pc.reasoning === 'xhigh'
      && pc.source.model === 'global' && pc.source.reasoning === 'project',
      `${pc.model}/${pc.source.model} + ${pc.reasoning}/${pc.source.reasoning}`);
    check('RT5: an unset field says provider-default rather than inventing one',
      layered.find((r) => r.stage === 'reviewer')!.model === null
      && layered.find((r) => r.stage === 'reviewer')!.source.model === 'provider-default',
      'null is a stated position');
    check('RT6: Zeus ships no default model — an upgrade cannot silently move a mission',
      Object.values(ZEUS_DEFAULT_ROUTING).every((c) => c.model === undefined
        && c.reasoning === undefined),
      JSON.stringify(ZEUS_DEFAULT_ROUTING.planner));
  }

  section('routing is a settings screen, not a config file');
  {
    // The global tier is read from the real user config, so a test that did
    // not isolate it would pass or fail depending on whose machine it ran on.
    const priorHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-xdg-'));

    const fx = fixture();
    fs.writeFileSync(path.join(fx.root, '.zeus', 'config.yaml'),
      'version: 1\nproject:\n  name: p\n  adapter: node\n');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };

      const r = await get(`${server.url}/api/routing`, auth);
      check('AR1: the screen is given every stage, with what each one is for',
        r.status === 200 && r.json.stages.length === 8
        && r.json.stages.every((s2: any) => s2.label && s2.description),
        JSON.stringify(r.json?.stages?.map((s2: any) => s2.label)));
      check('AR2: and the providers\u2019 own catalogue, so nothing is hardcoded in the page',
        Array.isArray(r.json.capabilities)
        && r.json.capabilities.every((c: any) => typeof c.closed === 'boolean'),
        JSON.stringify(r.json?.capabilities?.map((c: any) => c.provider)));
      check('AR3: with the resolved table and the tier each field came from',
        r.json.routes.length === 8 && r.json.routes[0].source.provider,
        JSON.stringify(r.json?.routes?.[0]?.source));

      const bad = await post(server, '/api/routing',
        { stage: 'not-a-stage', provider: 'claude' });
      check('AR4: an unknown stage is named, not invented',
        bad.status === 400 && bad.json.error === 'NO_SUCH_STAGE'
        && /known stages are/.test(bad.json.detail), bad.json?.detail);

      const ok = await post(server, '/api/routing',
        { stage: 'plan-critic', tier: 'project', provider: 'claude', reasoning: 'high' });
      check('AR5: a valid choice is written to the project and comes back resolved',
        ok.status === 200
        && ok.json.routes.find((x: any) => x.stage === 'plan-critic').reasoning === 'high',
        `${ok.status} ${JSON.stringify(ok.json?.routes?.find((x: any) => x.stage === 'plan-critic'))}`);
      check('AR5b: and it persisted, rather than living in the reply',
        (readConfig(fx.root) as any)?.routing?.['plan-critic']?.reasoning === 'high',
        JSON.stringify((readConfig(fx.root) as any)?.routing));

      // The screen must not be able to store something the provider refuses.
      const refused = await post(server, '/api/routing',
        { stage: 'reviewer', tier: 'project', provider: 'codex', model: 'no-such-model' });
      check('AR6: an impossible combination is refused BEFORE it is written',
        refused.status === 409 && refused.json.error === 'ROUTING_REFUSED',
        `${refused.status} ${refused.json?.error}`);
      check('AR6b: and nothing was written for it',
        !(readConfig(fx.root) as any)?.routing?.reviewer,
        JSON.stringify((readConfig(fx.root) as any)?.routing));

      // Clearing a field must mean "fall through", not "set to empty".
      const cleared = await post(server, '/api/routing',
        { stage: 'plan-critic', tier: 'project', reasoning: '' });
      check('AR7: clearing a field removes it so the tier below applies again',
        cleared.status === 200
        && !(readConfig(fx.root) as any)?.routing?.['plan-critic']?.reasoning,
        JSON.stringify((readConfig(fx.root) as any)?.routing));
    } finally {
      await server?.close();
      if (priorHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorHome;
    }

    check('AR8: the page rebuilds the model list when the provider changes',
      /sel\.provider\.onchange = \(\) => \{/.test(UI_HTML)
      && /fill\(modelSel/.test(UI_HTML), 'provider drives models');
    check('AR9: and the reasoning list when the model changes',
      /modelSel\.onchange = \(\) => fill\(reasoningSel, reasoningFor\(/.test(UI_HTML),
      'model drives reasoning');
    check('AR10: a level the model cannot use is never offered',
      /function reasoningFor\(cap, modelId\)/.test(UI_HTML)
      && /m\.reasoning\.length\) \? m\.reasoning : \(cap\.reasoning/.test(UI_HTML),
      'per-model levels win over the provider union');
  }

  section('the catalogue comes from the providers, not from Zeus');
  {
    // A hardcoded model list is wrong the week after it is written, and
    // offering a reasoning level a model cannot use is offering a failed call.
    const codexCache = path.join(TMP, `models-${seq += 1}.json`);
    fs.writeFileSync(codexCache, JSON.stringify({
      fetched_at: '2026-01-01T00:00:00Z',
      models: [
        { slug: 'big', display_name: 'Big', default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
        { slug: 'small', display_name: 'Small', default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'secret', display_name: 'Hidden', visibility: 'hidden',
          supported_reasoning_levels: [{ effort: 'low' }] },
      ],
    }));
    const cap = codexCapability(codexCache);
    check('CAT1: models and their reasoning levels are read from the provider catalogue',
      cap.models.length === 2 && cap.models[0].id === 'big'
      && cap.models[0].reasoning.join() === 'low,high,ultra',
      JSON.stringify(cap.models.map((m) => [m.id, m.reasoning.join('/')])));
    check('CAT2: a model the provider marks hidden is not offered',
      !cap.models.some((m) => m.id === 'secret'), 'hidden stays hidden');
    check('CAT3: a closed catalogue says so, so an unknown name can be refused',
      cap.closed === true, String(cap.closed));
    check('CAT4: with no catalogue on disk it says that, rather than reporting no models',
      /run the codex CLI once/.test(codexCapability(path.join(TMP, 'nope.json')).detail),
      codexCapability(path.join(TMP, 'nope.json')).detail);

    const routes = resolveRouting({ project: {
      planner: { provider: 'codex', model: 'small', reasoning: 'ultra' },
      reviewer: { provider: 'codex', model: 'nope' },
      oracle: { provider: 'codex', model: 'big', reasoning: 'ultra' },
    } });
    const problems = validateRouting(routes, [cap]);
    const byStage = (st: string) => problems.find((p) => p.stage === st);
    check('CAT5: a level THIS model cannot use is refused, with the ones it can',
      byStage('planner')?.code === 'UNSUPPORTED_REASONING'
      && byStage('planner')?.options?.join() === 'low,high',
      JSON.stringify(byStage('planner')));
    check('CAT6: the same level on a model that DOES support it passes',
      !byStage('oracle'), JSON.stringify(byStage('oracle') ?? 'accepted'));
    check('CAT7: a model outside a closed catalogue is refused, with the catalogue',
      byStage('reviewer')?.code === 'UNKNOWN_MODEL'
      && byStage('reviewer')?.options?.join() === 'big,small',
      JSON.stringify(byStage('reviewer')));

    // Claude publishes no catalogue; its list is open and must stay open, or a
    // Zeus release could stop an operator using a model that shipped yesterday.
    const open: any = { provider: 'claude', source: 'help', closed: false,
      models: [{ id: 'opus', display: 'opus', reasoning: ['low', 'high'], defaultReasoning: null }],
      reasoning: ['low', 'high'], detail: '' };
    const exotic = resolveRouting({ project: {
      planner: { provider: 'claude', model: 'claude-something-6' },
    } });
    check('CAT8: an unlisted model on an OPEN catalogue is passed through, not refused',
      !validateRouting(exotic, [open]).some((p) => p.field === 'model'),
      'open catalogues accept unknown names');
  }

  section('the resolved route reaches the provider argv');
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'providers.ts'), 'utf8');
    check('RV1: claude is given --model and --effort when Zeus resolved them',
      /\.\.\.\(r\.model \? \['--model', r\.model\] : \[\]\)/.test(src)
      && /\.\.\.\(r\.reasoning \? \['--effort', r\.reasoning\] : \[\]\)/.test(src),
      'claude flags wired');
    check('RV2: codex is given --model and its own reasoning config key',
      /model_reasoning_effort=/.test(src), 'codex flags wired');
    check('RV3: an unresolved field passes NO flag — empty is not the same as absent',
      /r\.model \? \[/.test(src) && !/'--model', r\.model \?\? ''/.test(src),
      'no empty flags');
    const orch = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'orchestrator.ts'), 'utf8');
    check('RV4: a repair routes to the repair stage, not to the implementer one',
      /rec\.repair \? 'repair' : 'implementer'/.test(orch), 'repair is its own stage');
    check('RV5: the table is resolved once per engine, not per call',
      /readonly routing: ResolvedRoute\[\]/.test(orch), 'resolved at construction');
    check('RV6b: a route names a PROVIDER, and that is the provider that runs',
      /providerFor\(stage: PipelineStage\): Provider/.test(orch)
      && /const provider = this\.providerFor\(resolvedStage\);/.test(orch),
      'the route picks the instance');
    const ops = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'operations.ts'), 'utf8');
    check('RV6c: and the mission-level calls no longer take theirs from the role',
      !/engine\.opts\.providers\./.test(ops)
      && /provider: engine\.providerFor\(stage\)/.test(ops),
      'no role-keyed providers left');
    check('RV6d: a route to a provider this engine lacks is refused, not substituted',
      /which this engine has no provider for/.test(orch),
      'running the wrong one silently is how the bug happened');

    check('RV6: what Zeus ASKED for is recorded on the call, separately from the answer',
      /configuredModel: route\.model, configuredReasoning: route\.reasoning/.test(orch),
      'configured is recorded');
  }

  section('a runner outlives the console that started it');
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'server.ts'), 'utf8');
    check('OU1: the runner is started as a transient unit of its own where one is possible',
      /systemd-run/.test(src) && /'--user', '--quiet', '--collect'/.test(src),
      'own unit attempted');
    check('OU2: with no user bus to reach, the plain spawn is used AND said to be weaker',
      /no user bus to /.test(src)
      && /restarting the console will kill it/.test(src),
      'the fallback admits what it is');
    // A transient unit does not inherit this process's environment. The first
    // cut assumed it did: node was found because argv[0] is absolute, npm was
    // not, and every mission was refused with "npm is not on PATH" on a host
    // where npm is plainly installed.
    check('OU2b: the unit is given the environment the work needs, by name',
      /--setenv=\$\{k\}=\$\{process\.env\[k\]\}/.test(src)
      && /'PATH', 'HOME'/.test(src), 'PATH travels with it');
    check('OU2c: by NAME, not wholesale — unit properties are readable',
      /Named variables, not the whole environment/.test(src)
      && !/\.\.\.Object\.entries\(process\.env\)/.test(src),
      'secrets do not get a second home');
    check('OU2d: and the unit writes to the log the caller was promised',
      /--property=StandardOutput=append:\$\{logFile\}/.test(src),
      'the journal is not where the message says to look');

    check('OU3: the stronger path says it survives, so the two are told apart',
      /it survives a restart of this console/.test(src), 'the strong path says so');
  }

  section('a long operation is not answered by a proxy');
  {
    const fx = fixture();
    fx.missions.create('a goal that takes minutes to compile', 'base0');
    let release: (v: any) => void = () => {};
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
        operations: {
          compile: () => new Promise((r) => { release = r; }),
          plan: async () => ({ ok: false, kind: 'TERMINATED', detail: 'stub' }) as any,
          evaluate: async () => ({}),
        },
      });
      const started = await post(server, '/api/missions/M-0001/compile', {});
      check('AS1: a long operation answers at once with 202, not when it finishes',
        started.status === 202 && started.json.kind === 'compile',
        `${started.status} ${JSON.stringify(started.json?.kind)}`);

      const auth = { authorization: `Bearer ${server.token}` };
      const mid = await get(`${server.url}/api/missions/M-0001`, auth);
      check('AS2: while it runs, the mission says so',
        mid.json.running && mid.json.running.kind === 'compile',
        JSON.stringify(mid.json?.running));

      const again = await post(server, '/api/missions/M-0001/compile', {});
      check('AS3: and a second attempt is refused rather than started',
        again.status === 409 && again.json.error === 'ALREADY_RUNNING',
        `${again.status} ${again.json?.error}`);

      release({ ok: false, kind: 'BUDGET', detail: 'the ceiling was already reached' });
      await new Promise((r) => setTimeout(r, 50));
      check('AS4: the OUTCOME reaches the log, so the page learns it without a response',
        fx.store.read('p/M-0001').some((e: any) => e.type === 'MISSION_OPERATION'
          && e.payload.ok === false && /BUDGET/.test(e.payload.detail)),
        JSON.stringify(fx.store.read('p/M-0001')
          .filter((e: any) => e.type === 'MISSION_OPERATION').map((e: any) => e.payload)));

      const after = await get(`${server.url}/api/missions/M-0001`, auth);
      check('AS5: and the mission stops saying it is running',
        after.json.running === null, JSON.stringify(after.json?.running));
    } finally { await server?.close(); }

    check('AS6: a cut connection is reported as still running, never as failed',
      /r\.status === 524/.test(UI_HTML) && UI_HTML.includes('do not start it again'),
      'gateway timeouts explained');
    check('AS7: a fetch that never returns becomes status 0 rather than an exception',
      UI_HTML.includes("error: 'CONNECTION_LOST'"), 'network failure has a status');
  }

  section('the autonomy bound stops Zeus, not the operator');
  {
    // This limit lived in checkMissionBudgets, which is consulted before EVERY
    // operation including the ones a person asked for — so a mission that had
    // used its automatic attempts refused the operator who had just read the
    // findings and asked for one more. It bounds a cascade; cost and time
    // bound the mission.
    const b = mergeMissionBudgets();
    const usage: any = { tasksSpawned: 0, plannedTasks: 0, replans: 0, repairs: 0,
      planRecompiles: 9, autoPlanRecompiles: 3, elapsedSeconds: 0, costUsd: 0,
      unmeteredCalls: 0, reserveDraws: [] };
    check('PRL1: the shipped bound is three automatic replans',
      b.maxPlanRecompiles === 3, String(b.maxPlanRecompiles));
    check('PRL2: three automatic replans is exhausted, and says so with both numbers',
      autoReplansExhausted(b, usage).exhausted === true
      && autoReplansExhausted(b, usage).used === 3
      && autoReplansExhausted(b, usage).limit === 3,
      JSON.stringify(autoReplansExhausted(b, usage)));
    check('PRL3: nine HUMAN replans do not exhaust it — only the automatic ones count',
      autoReplansExhausted(b, { ...usage, autoPlanRecompiles: 0 }).exhausted === false,
      'humans are not rate-limited');
    check('PRL4: and the mission budget no longer refuses on replan count at all',
      checkMissionBudgets(b, usage) === null, JSON.stringify(checkMissionBudgets(b, usage)));
    check('PRL5: what still refuses is spend, which is what a hard ceiling means',
      String(checkMissionBudgets(b, { ...usage, costUsd: 999 })?.limit) === 'costCeilingUsd',
      JSON.stringify(checkMissionBudgets(b, { ...usage, costUsd: 999 })));
  }

  section('who asked for a plan is on the log');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal that gets replanned', 'base0');
    const id = rec.missionId;
    const reject = (version: number, trigger: any) => {
      fx.missions.recordPlan(id, { version, nodes: [node(`${id}/N-0001`)] } as any,
        [], undefined, null, trigger);
      fx.missions.recordPlanCritique(id, {
        version, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
        findings: [{ code: 'STILL_WRONG', severity: 'BLOCKING', detail: 'no' }],
      });
    };
    const used = () => missionUsage(fx.store.read(id), Date.now(), () => ({ costUsd: 0, unmetered: 0 }));

    reject(1, 'HUMAN');
    check('TRG1: the attempt a person asked for is not charged to the autonomy bound',
      used().autoPlanRecompiles === 0 && used().planRecompiles === 1,
      JSON.stringify([used().autoPlanRecompiles, used().planRecompiles]));

    reject(2, 'AUTO'); reject(3, 'AUTO'); reject(4, 'AUTO');
    check('TRG2: three automatic replans exhaust it, exactly as specified',
      autoReplanState(fx.missions, id).exhausted === true
      && autoReplanState(fx.missions, id).used === 3,
      JSON.stringify(autoReplanState(fx.missions, id)));

    reject(5, 'HUMAN'); reject(6, 'HUMAN');
    check('TRG3: further HUMAN replans are unbounded — the count does not move',
      autoReplanState(fx.missions, id).used === 3 && used().planRecompiles === 6,
      JSON.stringify([autoReplanState(fx.missions, id).used, used().planRecompiles]));

    // An attempt recorded before triggers existed is read as autonomous: the
    // conservative reading, so nothing gains unlimited retries by being old.
    const old = fixture();
    const r2 = old.missions.create('an older mission', 'base0');
    old.store.append({ taskId: r2.missionId, type: 'PLAN_RECORDED',
      payload: { version: 1, plan: { version: 1, nodes: [] }, nodes: 0 } });
    old.store.append({ taskId: r2.missionId, type: 'PLAN_CRITIQUED',
      payload: { version: 1, acceptance: 'REJECT', findings: [] } });
    check('TRG4: an untriggered attempt from before this existed counts as autonomous',
      autoReplanState(old.missions, r2.missionId).used === 1,
      String(autoReplanState(old.missions, r2.missionId).used));
  }

  section('the console offers the next attempt once Zeus has stopped trying');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal Zeus gave up replanning', 'base0');
    const id = rec.missionId;
    fx.missions.recordPlan(id, { version: 1, nodes: [node(`${id}/N-0001`)] } as any,
      [], undefined, null, 'HUMAN');
    fx.missions.recordPlanCritique(id, {
      version: 1, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
      findings: [{ code: 'UNRESOLVED', severity: 'BLOCKING', detail: 'still standing' }],
    });
    for (const v of [2, 3, 4]) {
      fx.missions.recordPlan(id, { version: v, nodes: [node(`${id}/N-0001`)] } as any,
        [], undefined, null, 'AUTO');
      fx.missions.recordPlanCritique(id, {
        version: v, acceptance: 'REJECT', contaminated: false, contaminationDetail: null,
        findings: [{ code: 'UNRESOLVED', severity: 'BLOCKING', detail: 'still standing' }],
      });
    }

    const b = blockedBy(fx.missions, id)!;
    check('HR1: with its automatic replans spent, Zeus stops and says whose turn it is',
      b.reason === 'REJECTED_AND_EXHAUSTED' && /yours to ask for/.test(b.detail), b.detail);
    check('HR2: and the operator may still ask, because the mission can afford it',
      b.canPlanAgain === true, String(b.canPlanAgain));
    check('HR3: the findings that remain unresolved are what is shown',
      b.findings.length === 1 && (b.findings[0] as any).code === 'UNRESOLVED',
      JSON.stringify(b.findings));

    // The real ceiling: spend, not a replan count.
    fx.missions.reviseBudget(id, { limit: 'costCeilingUsd', from: 5, to: 0.01,
      reason: 'test', decidedBy: 'user-confirmed' });
    fx.store.append({ taskId: id, type: 'ORACLE_COMPILED',
      payload: { providerUsage: { totalCostUsd: 5 } } });
    const broke = blockedBy(fx.missions, id)!;
    check('HR4: out of money, even the human option becomes raise-the-budget-first',
      broke.canPlanAgain === false
      && broke.options.some((o) => /raise the mission budget/.test(o)),
      JSON.stringify(broke.options));
  }

  section('the mission budget is checked before the money is spent');
  {
    // checkMissionBudgets had one caller — the execution loop — so the ceiling
    // governed execution and nothing else. A mission reached $2.38 across five
    // plans without it ever being consulted, because it never ran a task.
    const fx = fixture();
    const rec = fx.missions.create('an expensive goal', 'base0');
    const id = rec.missionId;
    check('PF1: with room, the preflight passes',
      preflightBudget(fx.missions, id) === null, 'room to start');

    fx.missions.reviseBudget(id, { limit: 'costCeilingUsd', from: 5, to: 0.01,
      reason: 'test', decidedBy: 'user-confirmed' });
    fx.store.append({ taskId: id, type: 'ORACLE_COMPILED',
      payload: { providerUsage: { totalCostUsd: 0.5 } } });
    const breach = preflightBudget(fx.missions, id);
    check('PF2: spend BEFORE any task counts against the ceiling',
      !!breach && breach.limit === 'costCeilingUsd', JSON.stringify(breach));

    const ctx: any = { missions: fx.missions, engine: null, projectRoot: fx.root,
      context: { commands: {}, failingChecks: [], findings: [] }, policy: null };
    const compiled: any = await compileMissionOracle(ctx, id);
    check('PF3: compile refuses on the budget rather than calling a provider',
      compiled.ok === false && compiled.kind === 'BUDGET', compiled.kind);
    const planned: any = await planMissionGraph(ctx, id);
    check('PF4: plan refuses too — the same ceiling, checked at the same point',
      planned.ok === false && (planned.kind === 'BUDGET'
        || planned.kind === 'ORACLE_NOT_ACCEPTED'), planned.kind);
  }

  section('the console can show what a mission proposes to do');
  {
    check('PV1: the plan is rendered, not just carried in the payload',
      /function planSection\(m\)/.test(UI_HTML) && UI_HTML.includes('planSection(m)'),
      'plan section present');
    check('PV2: each node shows its dependencies and what it writes',
      UI_HTML.includes('after ') && UI_HTML.includes('writes '), 'node meta shown');
    check('PV3: and the estimate that the budget stop compares against',
      UI_HTML.includes('the planner estimates $'), 'estimate shown');
    // The UI is one template literal. A backtick anywhere inside it ends the
    // string early, and the file still looks fine to read.
    const uiSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'ui.ts'), 'utf8');
    const open = uiSrc.indexOf('`', uiSrc.indexOf('export const UI_HTML'));
    const close = uiSrc.lastIndexOf('`');
    check('PV4: no stray backtick inside the UI template — it would truncate the page',
      !uiSrc.slice(open + 1, close).includes('`'), 'template intact');

    // PV4 guards one way to break the page. It is not the only one: the
    // template is TypeScript, so an escape like \n inside it becomes a REAL
    // newline in the emitted script, and a real newline inside a single-quoted
    // JS string is a syntax error. The file still reads fine. Parse the script
    // the browser is actually handed instead of guessing at the ways to ruin it.
    const script = UI_HTML.slice(UI_HTML.indexOf('>', UI_HTML.indexOf('<script')) + 1,
      UI_HTML.lastIndexOf('</script>'));
    let parsed = '';
    try { new Function(script); } catch (e: any) { parsed = String(e && e.message || e); }
    check('PV5: the page script parses — the browser gets valid JavaScript',
      parsed === '' && script.length > 1000, parsed || `${script.length} bytes`);
  }

  section('the console can change how much of a mission is kept');
  {
    // The level was readable on this page and settable only from a terminal:
    // the console told you prompts were not being stored and offered no way to
    // start storing them.
    check('TLC1: the trace panel has a level selector, not just a level',
      UI_HTML.includes('id="tracelvl"') && UI_HTML.includes('id="tracego"'),
      'selector present');
    check('TLC2: it posts to the same endpoint the CLI uses',
      UI_HTML.includes("+ '/trace', { level: to, acknowledged: ack }"),
      'POST /missions/:id/trace');
    check('TLC3: debug is acknowledged before it applies, not after',
      /if \(to === 'debug'\)/.test(UI_HTML) && UI_HTML.includes('debugWarning')
      && UI_HTML.includes('acknowledged: ack'), 'the warning gates the request');
    check('TLC4: and the acknowledgement is not invented for the other levels',
      UI_HTML.includes('let ack = false;'), 'ack defaults to false');
    check('TLC5: the control renders before the first call, when it still matters',
      UI_HTML.includes("'<h2>agent trace</h2>' + traceControl(d)"),
      'rendered on the empty branch too');
    check('TLC6: it says a change cannot reach back',
      UI_HTML.includes('it cannot reach back'), 'the limit is stated where it is set');
    // The footer used to claim prompts were not stored while audit was storing
    // them. It now describes the CALLS, which is a different fact from the
    // setting — and both are on screen at once, so they must not be confused.
    check('TLC7: the footer describes the calls, the control describes the setting',
      UI_HTML.includes('These calls ran at ') && UI_HTML.includes('now <b>'),
      'the two facts are told apart');
  }

  section('the whole record of a mission, as one document');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal worth reading afterwards', 'base0');
    const id = rec.missionId;
    fx.store.append({ taskId: `p/CHAT`, type: 'CHAT_MESSAGE',
      payload: { message: 'do the thing' } });
    fx.missions.taskSpawned(id, `p/T-0001`, `${id}/N-0001`, 1);
    fx.store.append({ taskId: `p/T-0001`, type: 'DESIGN_RECORDED',
      payload: { design: { plan: 'a design the agent produced' } } });
    fx.store.append({ taskId: `p/T-0001`, type: 'AGENT_FINISHED',
      payload: { role: 'implementer', promptHash: 'sha256:abc', promptBytes: 1234 } });

    const text = missionBundle(fx.missions, id, { now: '2026-01-01T00:00:00.000Z' })!;
    check('TR1: the mission log is in it',
      text.includes('MISSION_CREATED') && text.includes(id), 'mission events present');
    check('TR2: and every task it spawned, with what the agents produced',
      text.includes(`task p/T-0001`)
      && text.includes('a design the agent produced'),
      'task events present');
    check('TR3: and the project chat from the moment the mission began',
      text.includes('do the thing'), 'chat present');
    check('TR4: it says plainly that prompts and raw replies are NOT in it',
      /promptHash and promptBytes/.test(text)
      && /never the\s+words/.test(text), 'the gap is stated, not discovered');
    check('TR5: and that the runner output never passed the redacting sink',
      /runner output did NOT/.test(text)
      && /Read it before sending this anywhere/.test(text), 'warned');
    check('TR6: and that the chat stream is per project, not per mission',
      /chat stream is per PROJECT/.test(text), 'scope stated');
    check('TR7: it counts what it contains, so a truncated paste is obvious',
      /mission log        \d+ event\(s\)/.test(text), 'inventory present');
    check('TR8: an unknown mission yields nothing rather than an empty document',
      missionBundle(fx.missions, `p/M-9999`) === null, 'null for unknown');
  }

  section('the transcript carries the conversations, and says what kind they are');
  {
    // The bundle stated flatly that prompts and raw replies "are not stored" —
    // the same claim the trace footer made while audit was busy storing them.
    const fx = fixture();
    const store = new TraceStore(fx.state);
    const rec = fx.missions.create('a goal', 'base0');
    const id = rec.missionId;
    fx.missions.taskSpawned(id, 'p/T-0001', `${id}/N-0001`, 1);

    // Assembled, not written as one literal: GitHub push protection reads a
    // diff the same way the redactor reads a prompt.
    const leaked = 'sk' + '_live_' + 'A1b2C3d4E5f6G7h8J9k0';
    const red = store.put('a prompt holding ' + leaked + ' as a secret', 'audit');
    const raw = store.put('the raw reply, exactly as it came back', 'debug');
    fx.store.append({ taskId: 'p/T-0001', type: 'MODEL_CALL_STARTED',
      payload: { traceCallId: 'TC-1', stage: 'implementer', promptBlob: red } });
    fx.store.append({ taskId: 'p/T-0001', type: 'MODEL_CALL_FINISHED',
      payload: { traceCallId: 'TC-1', stage: 'implementer', responseBlob: raw } });

    const text = missionBundle(fx.missions, id,
      { stateRoot: fx.state, now: '2026-01-01T00:00:00.000Z' })!;

    check('TRB1: the kept conversations are IN the transcript, not just referenced',
      text.includes('the raw reply, exactly as it came back'), 'raw content present');
    check('TRB2: redaction that happened on write survives into the export',
      text.includes('[redacted:api-key]') && !text.includes(leaked),
      'the secret does not reappear in the export');
    check('TRB3: each one says whether it is raw or redacted',
      text.includes('RAW, unredacted') && text.includes('redacted before it was written'),
      'the kind is stated per conversation');
    check('TRB4: and the header warns ONCE, at the top, that raw text is inside',
      text.indexOf('THIS TRANSCRIPT CONTAINS UNREDACTED MODEL CONVERSATIONS')
        < text.indexOf('the raw reply, exactly as it came back'),
      'the warning precedes the thing it warns about');
    check('TRB5: the count is accurate rather than decorative',
      /model conversation 2 of them — 1 raw, 1 redacted/.test(text), 'counts match');
    check('TRB6: it no longer claims prompts are never stored',
      !text.includes('raw replies are not stored'), 'the old blanket claim is gone');

    // A ref whose bytes are gone is not the same as a call that kept nothing.
    // Silently omitting it would make an expired conversation indistinguishable
    // from one that never existed.
    const orphan = { hash: 'sha256:' + 'a'.repeat(64), bytes: 99, redacted: false,
      expiresAt: '2020-01-01T00:00:00.000Z' };
    fx.store.append({ taskId: 'p/T-0001', type: 'MODEL_CALL_STARTED',
      payload: { traceCallId: 'TC-2', stage: 'reviewer', promptBlob: orphan } });
    const swept = missionBundle(fx.missions, id, { stateRoot: fx.state })!;
    check('TRB7: an expired conversation is listed as expired, not omitted',
      swept.includes('EXPIRED — swept from disk')
      && swept.includes('1 expired or swept'), 'absence is reported');
    check('TRB8: and the log still shows it existed',
      swept.includes('TC-2'), 'the audit trail outlives the content');

    // Without a store to read, the bundle must not imply the content is here.
    const noStore = missionBundle(fx.missions, id, {})!;
    check('TRB9: with no store to read, nothing is claimed to be included',
      !noStore.includes('the raw reply, exactly as it came back')
      && noStore.includes('3 expired or swept'), 'no content, and it says so');

    // A mission that kept nothing states it as a fact about ITSELF.
    const fx2 = fixture();
    const bare = fx2.missions.create('another goal', 'base0');
    const plain = missionBundle(fx2.missions, bare.missionId, { stateRoot: fx2.state })!;
    check('TRB10: a mission that kept nothing says so about itself, not about Zeus',
      plain.includes('none kept for this mission')
      && plain.includes('its calls ran at'), 'scoped to this mission');
    check('TRB11: and says raising the level now cannot recover them',
      plain.includes('cannot') && plain.includes('reach back'), 'the limit is stated');

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const auth = { authorization: `Bearer ${server.token}` };
      const r = await get(`${server.url}/api/missions/M-0001/bundle`, auth);
      check('TR9: the route serves it as text a person can paste, not as JSON',
        r.status === 200 && r.body.startsWith('ZEUS MISSION TRANSCRIPT'),
        `${r.status} ${r.body.slice(0, 30)}`);
      const missing = await get(`${server.url}/api/missions/M-9999/bundle`, auth);
      check('TR10: an unknown mission is 404 on the route too',
        missing.status === 404, String(missing.status));
      const noAuth = await get(`${server.url}/api/missions/M-0001/bundle`);
      check('TR11: and it is behind the token like every other read',
        noAuth.status === 401, String(noAuth.status));
    } finally { await server?.close(); }

    check('TR12: the route is advertised in the read table',
      (READ_ROUTES as readonly string[]).includes('GET /api/missions/:id/bundle'),
      'advertised');
    check('TR13: the console offers both, because clipboard and download fail differently',
      UI_HTML.includes('copy full transcript') && UI_HTML.includes('download it instead'),
      'both offered');
    check('TR14: and falls back when the clipboard API is not there',
      UI_HTML.includes('window.isSecureContext') && UI_HTML.includes('execCommand'),
      'fallback present');
  }

  section('a node whose work is outside the tree still counts');
  {
    // install-workspaces declared writes of api/node_modules/** and
    // app/node_modules/**, ran correctly, and produced no commit — because
    // node_modules is git-ignored. The integrator demanded a diff, called it
    // "the node changed nothing", repaired it into the identical result and
    // escalated NODE_UNREPAIRABLE. The mission stopped PARTIAL while the
    // install it had just performed was proving three of its criteria.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-effect-'));
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);

    // Both forms, exactly as isIgnored asks them: a `node_modules/` rule
    // matches directories only, and check-ignore cannot tell that a path which
    // does not exist yet is one.
    const ignored = (declared: string) => {
      const literal = declared.split(/[*?[]/)[0].replace(/\/+$/, '');
      if (!literal) return false;
      for (const form of [`${literal}/`, literal]) {
        try {
          execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', form]);
          return true;
        } catch { /* try the other form */ }
      }
      return false;
    };

    check('EO1: a declared write under node_modules is recognised as git-ignored',
      ignored('api/node_modules/**') === true && ignored('app/node_modules/**') === true,
      'node_modules is ignored');
    check('EO1b: even though neither directory exists yet — the install creates them',
      !fs.existsSync(path.join(repo, 'api', 'node_modules')), 'asked before it exists');
    check('EO2: a glob is reduced to its literal prefix, because check-ignore takes paths',
      ignored('dist/**') === true, 'globs resolve');
    check('EO3: a real source path is NOT ignored — this must keep failing loudly',
      ignored('app/src/i18n/**') === false && ignored('README.md') === false,
      'source paths still demand a diff');

    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'host.ts'), 'utf8');
    check('EO4: an empty diff is only forgiven when EVERY declared path is ignored',
      /declared\.length > 0 && declared\.every\(\(w\) => isIgnored\(/.test(src),
      'every, not some');
    check('EO5: a node that declared nothing is not forgiven — silence is not a claim',
      /declared\.length > 0 &&/.test(src), 'no declaration, no exemption');
    check('EO6: git is asked, rather than .gitignore being parsed a second time',
      /'check-ignore', '-q', '--'/.test(src), 'check-ignore is the authority');
    check('EO6b: in both forms, so a directory rule is not missed',
      /for \(const form of \[`\$\{literal\}\/`, literal\]\)/.test(src), 'both forms asked');
    check('EO7: and the mission green does not move for a node with no commit',
      /integrated: true, sha: green, touched: \[\]/.test(src), 'green unchanged');
  }

  section('Zeus scratch is never the project\u2019s work');
  {
    // A task worktree saw .zeus-cache/ — the npm cache the install step writes
    // — as untracked project work. `git add -A` staged it as the node's
    // change, and the NEXT node's rebase onto the mission green conflicted on
    // several hundred cache index files, so the mission stopped PARTIAL with
    // one node integrated and the rest unreachable.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-scratch-'));
    const git = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);

    const wt = path.join(repo, 'wt');
    git(repo, ['worktree', 'add', '--detach', '-q', wt, 'HEAD']);

    // The bug, exactly: --git-dir is the worktree's PRIVATE metadata, and git
    // reads info/exclude from the COMMON dir. They differ, and only one works.
    const privateDir = git(wt, ['rev-parse', '--git-dir']);
    const commonDir = git(wt, ['rev-parse', '--git-common-dir']);
    check('SCR1: in a linked worktree the private git dir is not the common one',
      path.resolve(wt, privateDir) !== path.resolve(wt, commonDir),
      `${privateDir} vs ${commonDir}`);

    fs.mkdirSync(path.join(wt, '.zeus-cache', 'npm'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.zeus-cache', 'npm', 'index'), 'cache\n');
    fs.writeFileSync(path.join(wt, 'README.md'), 'hello, changed\n');

    const info = path.join(path.resolve(wt, privateDir), 'info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'exclude'), ZEUS_WORKTREE_EXCLUDES.join('\n') + '\n');
    check('SCR2: an exclude written to the private dir does NOT hide the cache',
      /\.zeus-cache/.test(git(wt, ['status', '--short'])),
      git(wt, ['status', '--short']).replace(/\n/g, ' | '));

    const cinfo = path.join(path.resolve(wt, commonDir), 'info');
    fs.mkdirSync(cinfo, { recursive: true });
    fs.writeFileSync(path.join(cinfo, 'exclude'), ZEUS_WORKTREE_EXCLUDES.join('\n') + '\n');
    check('SCR3: written to the common dir, it does — which is where Zeus writes it now',
      !/\.zeus-cache/.test(git(wt, ['status', '--short'])),
      git(wt, ['status', '--short']).replace(/\n/g, ' | ') || '(only README)');

    // Belt and braces. Even with no exclude file at all, the integration
    // commit must not stage Zeus's scratch as the node's work.
    fs.rmSync(path.join(cinfo, 'exclude'));
    fs.rmSync(path.join(info, 'exclude'));
    execFileSync('git', ['-C', wt, 'add', '-A', '--', ...ZEUS_PATHSPEC_EXCLUDES]);
    const staged = git(wt, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    check('SCR4: the integration `git add` stages the file and never the cache',
      staged.includes('README.md') && !staged.some((f) => f.startsWith('.zeus-cache')),
      JSON.stringify(staged));

    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'mission', 'host.ts'), 'utf8');
    check('SCR5: and that is the call integrate actually makes',
      /gitSoft\(rec\.worktree, \['add', '-A', '--', \.\.\.ZEUS_PATHSPEC_EXCLUDES\]\)/.test(src),
      'integrate excludes zeus scratch');
    const orch = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'orchestrator.ts'), 'utf8');
    check('SCR6: the exclude file goes to the common dir, not the private one',
      /'rev-parse', '--git-common-dir'/.test(orch)
      && !/'rev-parse', '--git-dir'\],\n\s+\{ encoding: 'utf8', timeout: 30_000 \}\).trim\(\);\n\s+const abs/.test(orch),
      'common dir asked for');
  }

  section('a detached run that dies says where it died');
  {
    check('RUN1: the spawned run writes its output to the project log, not to nowhere',
      /stdio: \['ignore', out, out\]/.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.ts'), 'utf8')),
      'stdio is captured');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.ts'), 'utf8');
    check('RUN2: and the console is told where, so "spawned pid N" is a lead and not a shrug',
      /output at \$\{logFile\}/.test(src), 'the path is reported');
    check('RUN3: a log that cannot be opened does not stop the run from starting',
      /catch \{ out = 'ignore'; logFile = null; \}/.test(src), 'falls back');
  }
}
