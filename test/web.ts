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
import { startWebServer, RunningServer, routeTable, READ_ROUTES, WRITE_ROUTES } from '../src/web/server';
import { ensureToken, tokenMatches, tokenPath } from '../src/web/token';
import { eventId, parseEventId, cursorFromLastId, since, advance } from '../src/web/tail';
import { missionStatusView, missionReportView } from '../src/views';
import { findingsDigest } from '../src/mission/consent';
import {
  classifyMessage, draftCard, wantsTightening, chatHistory,
} from '../src/mission/chat';
import { scopeOf } from '../src/mission/types';
import { routeFor, carriesCredentials, draftCreationCard } from '../src/create';
import { extractZip } from '../src/zip';
import {
  listProjects, projectBySlug, slugForUrl, slugify, freeSlug,
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
      delete apiCore.phase; delete apiCore.cost;
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
      READ_ROUTES.length === 10 && WRITE_ROUTES.length === 9,
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
      check('WV3: each frame carries the event type, so a client can filter without parsing',
        got.types.includes('MISSION_ESCALATED'), got.types.join(','));
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
}
