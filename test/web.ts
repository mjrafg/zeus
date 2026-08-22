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
} from '../src/web/server';
import { ensureToken, tokenMatches, tokenPath } from '../src/web/token';
import {
  eventId, parseEventId, cursorFromLastId, since, advance, SSE_CHANNEL,
} from '../src/web/tail';
import { UI_HTML } from '../src/web/ui';
import { missionStatusView, missionReportView } from '../src/views';
import {
  findingsDigest, pendingDecision, awaitingHuman, consentSubject,
} from '../src/mission/consent';
import {
  compileMissionOracle, recompileMissionOracle, MAX_ORACLE_RECOMPILES,
} from '../src/mission/operations';
import {
  classifyMessage, draftCard, wantsTightening, chatHistory,
} from '../src/mission/chat';
import { scopeOf, TaskNode } from '../src/mission/types';
const node = (id: string): TaskNode => ({ nodeId: id, description: 'd', dependsOn: [],
  preconditions: [], reads: [], writes: [], affectedCriteria: [], predictedEffects: [],
  estimatedTier: 'FAST', estimatedCost: 1, risk: 'LOW' });
import { routeFor, carriesCredentials, draftCreationCard } from '../src/create';
import { extractZip } from '../src/zip';
import { detectProject, nodePackageDirs } from '../src/adapters';
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
      delete apiCore.phase; delete apiCore.cost; delete apiCore.pendingDecision;
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
      READ_ROUTES.length === 11 && WRITE_ROUTES.length === 11,
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
  section('chat: routing is mechanical, and doubt never routes to work');
  {
    const TABLE: Array<{ text: string; want: string; why: string }> = [
      // English questions
      { text: 'what is the status of M-0001?', want: 'QUESTION', why: 'opener + mark' },
      { text: 'why did the mission fail', want: 'QUESTION', why: 'opener, no mark' },
      { text: 'how much did it cost?', want: 'QUESTION', why: 'opener' },
      { text: 'show me the report', want: 'QUESTION', why: 'status vocabulary' },
      { text: 'is the ratchet advanced?', want: 'QUESTION', why: 'auxiliary opener' },
      // Persian questions
      { text: 'وضعیت ماموریت چیست؟', want: 'QUESTION', why: 'FA status vocabulary + mark' },
      { text: 'چرا این ماموریت شکست خورد', want: 'QUESTION', why: 'FA opener' },
      { text: 'هزینه چقدر بود؟', want: 'QUESTION', why: 'FA cost vocabulary' },
      // English work
      { text: 'fix the failing unit tests', want: 'WORK', why: 'imperative' },
      { text: 'add a retry to the uploader', want: 'WORK', why: 'imperative' },
      { text: 'please refactor the invoice module', want: 'WORK', why: 'polite imperative' },
      { text: 'I want you to remove the dead config option', want: 'WORK', why: 'request form' },
      // Persian work
      { text: 'این باگ را درست کن', want: 'WORK', why: 'FA imperative' },
      { text: 'یک تست جدید بنویس', want: 'WORK', why: 'FA imperative' },
      // Neither
      { text: 'the invoice module is a mess', want: 'AMBIGUOUS', why: 'an observation, not a request' },
      { text: 'hmm', want: 'AMBIGUOUS', why: 'nothing to go on' },
      { text: '', want: 'AMBIGUOUS', why: 'empty' },
      { text: 'maybe we should think about the parser', want: 'AMBIGUOUS', why: 'musing' },
    ];
    const wrong = TABLE.filter((t) => classifyMessage(t.text).intent !== t.want);
    check('CH1: the classifier table holds for every English and Persian case',
      wrong.length === 0,
      wrong.map((t) => `"${t.text}" → ${classifyMessage(t.text).intent}, wanted ${t.want}`).join(' | '));

    // THE DOUBT-DIRECTION PROPERTY: nothing reaches WORK without an explicit
    // work pattern. Building costs money; asking does not.
    const workish = TABLE.filter((t) => classifyMessage(t.text).intent === 'WORK');
    check('CH2: every WORK classification names the explicit pattern that caused it',
      workish.every((t) => classifyMessage(t.text).matched.some((m) => m.startsWith('work:'))),
      workish.map((t) => classifyMessage(t.text).matched.join(',')).join(' | '));
    check('CH3: a question that also names work is read as a question — the cheap reading wins',
      classifyMessage('how do I fix the failing tests?').intent === 'QUESTION',
      classifyMessage('how do I fix the failing tests?').reason);
    check('CH4: every classification carries a reason a human can argue with',
      TABLE.every((t) => classifyMessage(t.text).reason.length > 20));
  }

  section('chat: a card is a proposal, and only an accepted card creates');
  {
    const fx = fixture();
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const auth = { authorization: `Bearer ${server.token}` };
      const work = await post(server, '/api/chat', { message: 'fix the failing unit tests' });

      check('CC1: a work message produces a card',
        work.status === 200 && work.json.intent === 'WORK' && !!work.json.card,
        JSON.stringify(work.json?.intent));
      check('CC2: and creates NOTHING',
        fx.missions.list().length === 0, String(fx.missions.list().length));
      check('CC3: the card keeps the user’s own words, unrewritten',
        work.json.card.originalGoal === 'fix the failing unit tests'
        && work.json.card.proposedGoal === null, work.json.card.originalGoal);
      check('CC4: it says what happens next, and what that is expected to cost',
        work.json.card.whatHappensNext.length === 6
        && /audits\/missions/.test(work.json.card.costExpectation),
        work.json.card.costExpectation.slice(0, 60));
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

  section('chat: questions are answered from the log, for free');
  {
    const fx = fixture();
    const rec = fx.missions.create('a goal', 'base0');
    fx.missions.escalate(rec.missionId, { kind: 'NOTE' });

    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const status = await post(server, '/api/chat', { message: 'what is the status?' });
      const cost = await post(server, '/api/chat', { message: 'how much did it cost?' });
      const events = await post(server, '/api/chat', { message: 'show me the last events' });
      const unknown = await post(server, '/api/chat',
        { message: 'what is the airspeed velocity of an unladen swallow?' });

      check('CQ1: a question is answered, with no card offered',
        status.json.intent === 'QUESTION' && status.json.card === null
        && status.json.answer.answered === true, JSON.stringify(status.json?.intent));
      check('CQ2: the answer cites the mission it is about',
        status.json.answer.refs.some((r: any) => r.kind === 'mission' && r.id === rec.missionId),
        JSON.stringify(status.json.answer.refs));
      check('CQ3: cost answers keep unmetered calls distinct from spend',
        /no provider-reported spend|lower bound|\$/.test(cost.json.answer.text),
        cost.json.answer.text.slice(0, 80));
      check('CQ4: event answers carry seq refs that resolve',
        events.json.answer.refs.some((r: any) => r.kind === 'event' && typeof r.seq === 'number'),
        JSON.stringify(events.json.answer.refs.slice(0, 2)));
      check('CQ5: a question the log cannot answer says so, and says what CAN be asked',
        unknown.json.answer.answered === false
        && /cannot answer that from the event log/.test(unknown.json.answer.text)
        && /I can answer questions about/.test(unknown.json.answer.text),
        unknown.json.answer.text.slice(0, 60));
      check('CQ6: and it does not reach for a model to improvise one',
        /V1 does not call one to improvise/.test(unknown.json.answer.text));
      check('CQ7: no mission was created by any question',
        fx.missions.list().length === 1, String(fx.missions.list().length));
    } finally { await server?.close(); }
  }

  section('chat: ambiguity is rendered, not resolved');
  {
    const fx = fixture();
    fx.missions.create('an existing goal', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({
        projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0,
      });
      const amb = await post(server, '/api/chat', { message: 'the invoice module is a mess' });
      check('CA1: an ambiguous message produces a card, not a mission',
        amb.json.intent === 'AMBIGUOUS' && !!amb.json.card
        && fx.missions.list().length === 1, JSON.stringify(amb.json?.intent));
      check('CA2: the card carries the "this was just a question" option',
        amb.json.card.actions.some((a: any) => a.id === 'answer'),
        JSON.stringify(amb.json.card.actions.map((a: any) => a.id)));

      const answered = await post(server, '/api/chat/decide', {
        card: amb.json.card, cardDigest: amb.json.card.digest, decision: 'answer',
      });
      check('CA3: choosing it answers from the log and creates nothing',
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
    check('PC5c: and cites committed cost evidence rather than an invented average',
      /audits\/missions/.test(desc.costExpectation), desc.costExpectation.slice(0, 60));

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

  section('chat: the most obvious question is answerable now');
  {
    const fx = fixture();
    fx.missions.create('make the tests deterministic', 'base0');
    fx.missions.create('fix the README typo', 'base0');
    let server: RunningServer | null = null;
    try {
      server = await startWebServer({ projectRoot: fx.root, stateRoot: fx.state, projectId: 'p', port: 0 });
      const asked = await post(server, '/api/chat', { message: 'what missions exist in this project?' });
      check('RQ1: the exact question from the screenshot is answered',
        asked.json.intent === 'QUESTION' && asked.json.answer.answered === true,
        JSON.stringify(asked.json?.answer?.answered));
      check('RQ1b: with both missions named',
        /M-0001/.test(asked.json.answer.text) && /M-0002/.test(asked.json.answer.text),
        asked.json.answer.text.slice(0, 90));
      check('RQ1c: and refs that resolve to the missions',
        asked.json.answer.refs.length === 2
        && asked.json.answer.refs.every((r: any) => r.kind === 'mission'),
        JSON.stringify(asked.json.answer.refs));

      const variants: Array<[string, string]> = [
        ['RQ2a', 'list missions'],
        ['RQ2b', 'چه ماموریت‌هایی هست؟'],
        ['RQ2c', 'how many missions are there?'],
      ];
      for (const [id, q] of variants) {
        const r = await post(server, '/api/chat', { message: q });
        check(`${id}: the same question phrased differently is also answered`,
          r.json.answer?.answered === true, `"${q}" -> ${r.json?.answer?.answered}`);
      }

      const waiting = await post(server, '/api/chat', { message: 'is anything waiting on me?' });
      check('RQ3: "waiting on me" is answerable too',
        waiting.json.answer.answered === true
        && /Nothing is waiting on you/.test(waiting.json.answer.text),
        waiting.json.answer.text.slice(0, 60));

      const nope = await post(server, '/api/chat',
        { message: 'what is the airspeed velocity of an unladen swallow?' });
      check('RQ4: the honest refusal still fires for what the log cannot answer',
        nope.json.answer.answered === false, JSON.stringify(nope.json?.answer?.answered));
      check('RQ5: and the help text is TRUE — every capability it lists is answerable',
        /which missions exist/.test(nope.json.answer.text)
        && /whether anything is waiting on you/.test(nope.json.answer.text),
        nope.json.answer.text.slice(0, 120));
    } finally { await server?.close(); }
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
  section('chat: the verbs real messages actually use');
  {
    // Every one of these was typed at the deployed console, or is the same
    // shape as one that was. "improve the readme" routed AMBIGUOUS and that is
    // how the gap was found — the list grows from real use, not imagination.
    const WORKISH = [
      'improve the readme', 'improve the readme wording', 'enhance the error messages',
      'clarify the setup instructions', 'simplify the parser', 'tidy up the imports',
      'polish the CLI output', 'harden the upload path', 'reduce the bundle size',
      'bump the node version', 'enable strict mode', 'validate the input',
      'بهبود بده مستندات را', 'ساده کن این تابع را',
    ];
    const missed = WORKISH.filter((m) => classifyMessage(m).intent !== 'WORK');
    check('VB-W1: the verbs people actually use route to WORK',
      missed.length === 0,
      missed.map((m) => `"${m}" -> ${classifyMessage(m).intent}`).join(' | '));
    check('VB-W2: and each names the pattern that caught it',
      WORKISH.every((m) => classifyMessage(m).matched.some((x) => x.startsWith('work:'))));

    // The doubt direction is unchanged: adding verbs must not make the
    // classifier greedy about things that are plainly not requests.
    const NOT_WORK = [
      'the readme could be better', 'improvements are needed somewhere',
      'how do I improve the readme?', 'what would improve this?',
    ];
    const wrong = NOT_WORK.filter((m) => classifyMessage(m).intent === 'WORK');
    check('VB-W3: an observation or a question about improving is still not a work order',
      wrong.length === 0,
      wrong.map((m) => `"${m}" -> WORK`).join(' | '));
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
      const t = seen.find((x) => x.op === 'compile')?.target;
      check('WSC1: compile acts on the SCOPED project, not the one the server sits in',
        c.status === 200 && t && t.projectId === 'alpha' && t.root === alpha.dir,
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

    check('WSC7: the UI scopes writes in ONE place, so no call site can forget',
      /async function apiPost\(p, body\) \{\s*const r = await fetch\('\/api' \+ scope\(p\)/
        .test(UI_HTML)
      && !/apiPost\(scope\(/.test(UI_HTML),
      'apiPost scopes centrally and nothing double-scopes');
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
    fs.writeFileSync(path.join(root, 'api', 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/index.js' } }));
    fs.writeFileSync(path.join(root, 'api', 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'api', 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'app', 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build', test: 'vitest run' } }));
    fs.writeFileSync(path.join(root, 'app', 'package-lock.json'), '{}');

    const det = detectProject(root);
    check('PL1: it is detected as a node project, not as generic',
      det.primary.id === 'node', det.primary.id);
    check('PL2: the packages are found one level down, and node_modules is not one',
      JSON.stringify(nodePackageDirs(root)) === '["api","app"]',
      JSON.stringify(nodePackageDirs(root)));

    const cmds = det.primary.commands(root);
    check('PL3: typecheck resolves from the package that has a tsconfig',
      cmds.typecheck === '(cd api && npx --no-install tsc --noEmit)', String(cmds.typecheck));
    check('PL4: a declared script is preferred over an inferred one',
      cmds.unitTest === '(cd app && npm run test)', String(cmds.unitTest));
    check('PL5: build runs every package that declares one, in order, stopping at a failure',
      cmds.build === '(cd api && npm run build) && (cd app && npm run build)',
      String(cmds.build));
    check('PL6: a lockfile means a frozen install',
      cmds.install === '(cd api && npm ci) && (cd app && npm ci)', String(cmds.install));
    check('PL7: nothing is invented — no package declares a lint script, so there is none',
      cmds.lint === null && cmds.integrationTest === null,
      JSON.stringify([cmds.lint, cmds.integrationTest]));
    check('PL8: every package manifest is protected, not only a root one',
      det.primary.protectedPaths(root).includes('api/package.json')
      && det.primary.protectedPaths(root).includes('app/package-lock.json'),
      'manifests protected');

    // Without a lockfile a frozen install cannot run, and a command that
    // cannot run is worse than one that is not offered.
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-poly2-'));
    fs.mkdirSync(path.join(loose, 'svc'), { recursive: true });
    fs.writeFileSync(path.join(loose, 'svc', 'package.json'), JSON.stringify({ scripts: {} }));
    check('PL9: without a lockfile the install is not a frozen one',
      detectProject(loose).primary.commands(loose).install === '(cd svc && npm install)',
      String(detectProject(loose).primary.commands(loose).install));

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
