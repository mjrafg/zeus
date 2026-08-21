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
      READ_ROUTES.length === 9 && WRITE_ROUTES.length === 7,
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
}
