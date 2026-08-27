/**
 * The conversation, as one string.
 *
 * WHY A SECOND UI RATHER THAN A RESTYLE. The console is a dashboard: three
 * panes, each answering a different question, and you assemble the story by
 * looking between them. That is the right shape for auditing a mission and the
 * wrong one for running one, where the only question is "what is happening now
 * and what does it want from me". This is the second shape. The console keeps
 * the first, at /console, because a trace viewer and a routing screen are worth
 * having and are not conversations.
 *
 * ONE COLUMN, AND EVERY PIECE OF WORK IS THREE LINES UNTIL YOU ASK. What a
 * stage IS, what it DID, and what that MEANS for you - anything more is a
 * detail you open. A stream where each stage prints its whole payload is a
 * stream nobody reads to the bottom, and the bottom is where the thing waiting
 * on you lives.
 *
 * Plain HTML, CSS and JS, for the same reason as the console: `dependencies:
 * {}` is a public claim, and a build chain is a second way for what ships to
 * differ from what the source says.
 */

import { SSE_CHANNEL } from './tail';

export const CHAT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zeus</title>
<style>
  :root {
    --bg:#0b0d10; --panel:#12151a; --raise:#171b21; --fg:#e8eaed; --dim:#9aa4b2;
    --faint:#6b7480; --line:#232830; --line2:#2d333d;
    --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --acc:#7aa2f7; --acc2:#a78bfa;
    --mono: ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
    --sans: -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  }
  * { box-sizing:border-box }
  html,body { height:100% }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.65 var(--sans);
         -webkit-font-smoothing:antialiased }
  button,input,textarea,select { font:inherit; color:inherit }

  /* ---- frame ---- */
  #top { position:sticky; top:0; z-index:20; background:rgba(11,13,16,.85);
         backdrop-filter:blur(8px); border-bottom:1px solid var(--line);
         display:flex; align-items:center; gap:10px; padding:10px 16px }
  #top .brand { font-weight:650; letter-spacing:-.01em }
  #top .sep { color:var(--line2) }
  #ctx { color:var(--dim); font:13px/1 var(--mono); cursor:pointer;
         padding:5px 8px; border-radius:7px; border:1px solid transparent }
  #ctx:hover { border-color:var(--line2); background:var(--panel) }
  #top .spacer { flex:1 }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--faint);
         display:inline-block; margin-right:6px; vertical-align:middle }
  .dot.ok { background:var(--ok); box-shadow:0 0 0 3px rgba(74,222,128,.14) }
  .dot.warn { background:var(--warn) } .dot.bad { background:var(--bad) }
  #conn { color:var(--dim); font-size:13px }
  .ghost { background:transparent; border:1px solid var(--line2); color:var(--dim);
           border-radius:7px; padding:5px 10px; cursor:pointer; font-size:13px }
  .ghost:hover { color:var(--fg); border-color:var(--acc) }

  /* ---- the column ---- */
  #wrap { max-width:820px; margin:0 auto; padding:26px 20px 180px }
  #empty { color:var(--dim); padding:64px 0; text-align:center }
  #empty h2 { color:var(--fg); font-weight:600; font-size:20px; margin:0 0 8px }

  .turn { margin:20px 0 }
  .turn.me { display:flex; justify-content:flex-end }
  .turn.me .body { background:var(--raise); border:1px solid var(--line2);
                   border-radius:14px 14px 4px 14px; padding:10px 14px; max-width:78% }
  .turn.zeus .body { white-space:pre-wrap; word-break:break-word }
  .who { font:12px/1 var(--mono); color:var(--faint); margin-bottom:7px;
         letter-spacing:.02em }

  /* ---- an activity: three lines until you ask ---- */
  .act { border:1px solid var(--line); background:var(--panel); border-radius:11px;
         margin:10px 0; overflow:hidden }
  .act > .head { display:grid; grid-template-columns:18px 1fr auto; gap:10px;
                 padding:11px 13px; cursor:pointer; align-items:start }
  .act > .head:hover { background:var(--raise) }
  .act .caret { color:var(--faint); font:12px/1.5 var(--mono);
                transition:transform .12s ease }
  .act.open .caret { transform:rotate(90deg) }
  .l1 { font-weight:600; font-size:14px; letter-spacing:-.005em }
  .l1 .stage { color:var(--fg) } .l1 .who2 { color:var(--faint); font-weight:400;
                font:12px/1.5 var(--mono); margin-left:8px }
  .l2 { color:var(--dim); font-size:13px; font-family:var(--mono);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .l3 { font-size:13px; margin-top:2px }
  .l3.ask { color:var(--warn) } .l3.bad { color:var(--bad) } .l3.ok { color:var(--ok) }
  .badge { font:11px/1.6 var(--mono); padding:1px 7px; border-radius:20px;
           border:1px solid var(--line2); color:var(--dim); white-space:nowrap }
  .badge.ok { color:var(--ok); border-color:rgba(74,222,128,.4) }
  .badge.warn { color:var(--warn); border-color:rgba(251,191,36,.4) }
  .badge.bad { color:var(--bad); border-color:rgba(248,113,113,.4) }
  .badge.run { color:var(--acc); border-color:rgba(122,162,247,.45) }
  .act > .more { display:none; border-top:1px solid var(--line); padding:13px;
                 background:#0f1216 }
  .act.open > .more { display:block }
  .more pre { margin:0; font:12px/1.6 var(--mono); color:var(--dim);
              white-space:pre-wrap; word-break:break-word; max-height:460px; overflow:auto }
  .more h4 { margin:0 0 6px; font-size:12px; color:var(--faint);
             font-family:var(--mono); font-weight:500; letter-spacing:.04em }
  .more .grp { margin-bottom:14px } .more .grp:last-child { margin-bottom:0 }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:3px 14px; font:12px/1.6 var(--mono) }
  .kv b { color:var(--faint); font-weight:400 }
  .fnd { border-left:2px solid var(--warn); padding:2px 0 2px 10px; margin:7px 0;
         font-size:13px }
  .fnd .sev { font:11px/1.5 var(--mono); color:var(--warn) }

  /* ---- things that want an answer ---- */
  .acts { display:flex; gap:8px; flex-wrap:wrap; margin-top:11px }
  .btn { background:var(--acc); color:#0b0d10; border:0; border-radius:8px;
         padding:7px 13px; font-weight:600; font-size:13px; cursor:pointer }
  .btn:hover { filter:brightness(1.08) }
  .btn[disabled] { opacity:.5; cursor:default; filter:none }
  .btn.q { background:transparent; border:1px solid var(--line2); color:var(--dim);
           font-weight:500 }
  .btn.q:hover { color:var(--fg); border-color:var(--acc) }
  .num { background:var(--bg); border:1px solid var(--line2); border-radius:8px;
         padding:6px 9px; width:110px; font-family:var(--mono); font-size:13px }

  /* ---- composer ---- */
  #dock { position:fixed; left:0; right:0; bottom:0; padding:14px 20px 20px;
          background:linear-gradient(to top,var(--bg) 62%,rgba(11,13,16,0)) }
  #composer { max-width:820px; margin:0 auto; background:var(--panel);
              border:1px solid var(--line2); border-radius:14px; padding:10px 12px;
              display:flex; gap:10px; align-items:flex-end }
  #composer:focus-within { border-color:var(--acc) }
  #say { flex:1; background:transparent; border:0; outline:0; resize:none;
         max-height:190px; min-height:24px; line-height:1.55 }
  #hint { max-width:820px; margin:7px auto 0; color:var(--faint); font-size:12px;
          display:flex; gap:10px; justify-content:space-between }
  .spin { display:inline-block; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--line2); border-top-color:var(--acc);
          animation:sp .7s linear infinite; vertical-align:-1px; margin-right:7px }
  @keyframes sp { to { transform:rotate(360deg) } }

  /* ---- switcher ---- */
  #sheet { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:30;
           display:none; align-items:flex-start; justify-content:center; padding:70px 20px }
  #sheet.on { display:flex }
  #sheetbox { background:var(--panel); border:1px solid var(--line2); border-radius:14px;
              width:100%; max-width:620px; max-height:72vh; overflow:auto; padding:8px }
  .row { padding:10px 12px; border-radius:9px; cursor:pointer; display:flex;
         gap:12px; align-items:baseline }
  .row:hover { background:var(--raise) } .row.sel { background:var(--raise) }
  .row b { font-weight:600; min-width:74px; font-family:var(--mono); font-size:13px }
  .row span { color:var(--dim); font-size:13px; overflow:hidden;
              text-overflow:ellipsis; white-space:nowrap }
  .grp-t { color:var(--faint); font:11px/2.4 var(--mono); padding:0 12px;
           letter-spacing:.06em; text-transform:uppercase }
</style>
</head>
<body>
<div id="top">
  <span class="brand">Zeus</span>
  <span class="sep">/</span>
  <span id="ctx" title="switch project or mission">connect first</span>
  <span class="spacer"></span>
  <input id="tok" type="password" placeholder="bearer token" class="num" style="width:190px">
  <button id="go" class="ghost">connect</button>
  <span id="conn"><span class="dot"></span>offline</span>
  <a href="/console" class="ghost" style="text-decoration:none">console</a>
</div>

<div id="wrap">
  <div id="empty">
    <h2>What should we build?</h2>
    <div>Ask a question about this repository, or describe a change.</div>
  </div>
  <div id="stream"></div>
</div>

<div id="dock">
  <div id="composer">
    <textarea id="say" rows="1" placeholder="Ask, or describe a change…"></textarea>
    <button id="send" class="btn">Send</button>
  </div>
  <div id="hint"><span id="hintl">Enter to send · Shift+Enter for a new line</span>
    <span id="hintr"></span></div>
</div>

<div id="sheet"><div id="sheetbox"></div></div>

<script>
// In memory only. A credential that can spend money does not belong in the
// most-read storage in the browser.
let TOKEN = '', PROJECT = null, MISSION = null, ES = null, LAST = null, BUSY = false;
// One card per correlated unit of work, so a STARTED and its FINISHED are the
// same three lines rather than two entries that scroll apart.
const CARDS = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scope = (p) => p + (PROJECT ? (p.includes('?') ? '&' : '?') + 'project='
  + encodeURIComponent(PROJECT) : '');
const short = (id) => String(id || '').split('/').pop();
const ms = (n) => (n == null ? '' : n < 1000 ? n + 'ms'
  : n < 60000 ? (n / 1000).toFixed(1) + 's'
  : Math.floor(n / 60000) + 'm' + String(Math.round((n % 60000) / 1000)).padStart(2, '0') + 's');
const money = (n) => '$' + Number(n || 0).toFixed(4);

async function api(p) {
  const r = await fetch('/api' + p, { headers: { authorization: 'Bearer ' + TOKEN } });
  if (r.status === 401) { conn('unauthorized — token changed?', 'bad'); throw new Error('401'); }
  return r.json();
}
async function post(p, body) {
  const r = await fetch('/api' + p, { method:'POST',
    headers: { authorization:'Bearer ' + TOKEN, 'content-type':'application/json' },
    body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
function conn(text, cls) {
  $('conn').innerHTML = '<span class="dot ' + (cls || '') + '"></span>' + esc(text);
}

/* -- the stream ---------------------------------------------------------- */

function atBottom() {
  return window.innerHeight + window.scrollY >= document.body.offsetHeight - 220;
}
function append(el) {
  const stick = atBottom();
  $('empty').style.display = 'none';
  $('stream').appendChild(el);
  if (stick) window.scrollTo({ top: document.body.scrollHeight, behavior:'smooth' });
}
function turn(who, text, cls) {
  const d = document.createElement('div');
  d.className = 'turn ' + (cls || 'zeus');
  d.innerHTML = (cls === 'me' ? '' : '<div class="who">' + esc(who) + '</div>')
    + '<div class="body">' + esc(text) + '</div>';
  append(d);
  return d;
}

/**
 * An activity, in three lines.
 *
 * The lines are fixed in MEANING, not just in count: what this is, what it did,
 * and what it means for you. A card that puts its outcome on line two and its
 * identity on line three is three lines that still have to be read in full.
 */
function card(key, l1, l2, l3, badge, detail) {
  let el = key ? CARDS.get(key) : null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'act';
    el.innerHTML = '<div class="head"><span class="caret">&#9656;</span>'
      + '<div><div class="l1"></div><div class="l2"></div><div class="l3"></div></div>'
      + '<span class="badge"></span></div><div class="more"></div>';
    el.querySelector('.head').addEventListener('click', () => el.classList.toggle('open'));
    if (key) CARDS.set(key, el);
    append(el);
  }
  el.querySelector('.l1').innerHTML = l1 || '';
  el.querySelector('.l2').textContent = l2 || '';
  const three = el.querySelector('.l3');
  three.textContent = (l3 && l3.text) || '';
  three.className = 'l3 ' + ((l3 && l3.cls) || '');
  const b = el.querySelector('.badge');
  b.textContent = (badge && badge.text) || '';
  b.className = 'badge ' + ((badge && badge.cls) || '');
  if (detail !== undefined && detail !== null) el.querySelector('.more').innerHTML = detail;
  return el;
}
const grp = (title, inner) => '<div class="grp"><h4>' + esc(title) + '</h4>' + inner + '</div>';
const pre = (o) => '<pre>' + esc(typeof o === 'string' ? o : JSON.stringify(o, null, 1)) + '</pre>';
function kv(pairs) {
  return '<div class="kv">' + pairs.filter((p) => p[1] !== undefined && p[1] !== null && p[1] !== '')
    .map((p) => '<b>' + esc(p[0]) + '</b><span>' + esc(p[1]) + '</span>').join('') + '</div>';
}
function findings(list) {
  return (list || []).map((f) => '<div class="fnd"><span class="sev">'
    + esc(f.severity || f.code || 'finding') + '</span> '
    + esc(f.claim || f.detail || '') + (f.file ? ' <i>' + esc(f.file) + '</i>' : '')
    + (f.criterionId ? ' <i>' + esc(short(f.criterionId)) + '</i>' : '') + '</div>').join('');
}

/* -- events become cards -------------------------------------------------- */

const STAGE_NAME = { 'front-door':'Front Door', oracle:'Oracle', 'oracle-critic':'Oracle Critic',
  planner:'Planner', 'plan-critic':'Plan Critic', implementer:'Implementer',
  reviewer:'Reviewer', repair:'Repair', builder:'Builder' };

/**
 * One event, rendered - or said to be unrenderable, never silently dropped.
 *
 * A renderer that throws inside the history loop took the whole page with it:
 * the exception escaped connect() and the live stream was never opened, so a
 * single unexpected payload showed as "connecting…" for ever. The stream is
 * the one thing here that cannot be recovered by reloading, so nothing inside
 * it is allowed to be fatal.
 */
function render(e) {
  try { render1(e); }
  catch (err) {
    card(null, '<span class="stage">' + esc(e && e.type || 'event') + '</span>',
      'this event could not be rendered', { text:String(err && err.message || err), cls:'bad' },
      { text:'raw', cls:'bad' }, pre(e));
  }
}

function render1(e) {
  const p = e.payload || {};
  const t = e.type;
  const where = short(e.taskId);
  const tag = (MISSION && String(e.taskId).indexOf(MISSION) === 0) || where === 'CHAT'
    ? '' : ' ' + where;

  if (t === 'MODEL_CALL_STARTED') {
    const name = STAGE_NAME[p.stage] || p.stage || 'model';
    card('c:' + p.traceCallId,
      '<span class="stage">' + esc(name) + '</span><span class="who2">'
        + esc([p.provider, p.configuredModel, p.configuredReasoning].filter(Boolean).join(' · ')) + '</span>',
      'thinking… · prompt ' + (p.promptBytes || 0) + 'B'
        + (p.graphAttached ? ' · graph attached' : ''),
      { text:'', cls:'' }, { text:'running', cls:'run' },
      grp('what it was given', kv((p.delivered || p.checklist || []).map((c) =>
        [typeof c === 'string' ? c : c.kind, typeof c === 'string' ? 'included' : (c.state || '')]))));
    return;
  }
  if (t === 'MODEL_CALL_FINISHED') {
    const name = STAGE_NAME[p.stage] || p.stage || 'model';
    const u = (p.usage && p.usage.usage) || {};
    const tok = u.input_tokens || u.cached_input_tokens || 0;
    const bits = [];
    if (p.graphQueryCount != null) bits.push(p.graphQueryCount + ' graph ' + (p.graphQueryCount === 1 ? 'query' : 'queries'));
    if (tok) bits.push(Math.round(tok / 1000) + 'k in');
    if (p.usage && p.usage.totalCostUsd) bits.push(money(p.usage.totalCostUsd));
    bits.push(ms(p.wallMs));
    const bad = p.outcome !== 'COMPLETED' || p.infrastructureFailure;
    const w = p.writeCheck, rs = p.readScope;
    let note = { text:'', cls:'' };
    if (p.infrastructureFailure) note = { text:String(p.infrastructureFailure), cls:'bad' };
    else if (w && w.state === 'ROLE_WRITE_VIOLATION') note = { text:'this read-only role modified the repository', cls:'bad' };
    else if (w && w.state === 'WRITE_CHECK_UNAVAILABLE') note = { text:'the write check could not run — this stage is not verified', cls:'bad' };
    else if (rs && rs.state === 'ROLE_READ_ESCAPE') note = { text:'read ' + rs.reachCount + ' path(s) outside the repository', cls:'ask' };
    else if (p.modelDiscrepancy) note = { text:'answered by ' + p.modelDiscrepancy.actual + ', not ' + p.modelDiscrepancy.configured, cls:'ask' };
    card('c:' + p.traceCallId,
      '<span class="stage">' + esc(name) + '</span><span class="who2">'
        + esc([p.provider, p.actualModel || p.configuredModel].filter(Boolean).join(' · ')) + '</span>',
      bits.join(' · '), note,
      { text: bad ? 'failed' : 'done', cls: bad ? 'bad' : 'ok' },
      grp('the call', kv([['stage', p.stage], ['provider', p.provider],
        ['model asked for', p.configuredModel], ['model that answered', p.actualModel],
        ['effort', p.configuredReasoning], ['wall', ms(p.wallMs)],
        ['parsed', p.parsed && p.parsed.ok ? 'yes' : 'no'],
        ['trace level', p.traceLevel]]))
      + (p.graphOps && p.graphOps.length
        ? grp('what it asked the graph', p.graphOps.map((o) => '<div class="l2">'
            + esc(o.tool + ' ' + JSON.stringify(o.args || {}) + ' → ' + o.results
              + ' result(s) · ' + ms(o.ms)) + '</div>').join('')) : '')
      + (w ? grp('did it write?', kv([['state', w.state], ['inspected', String(w.inspected)],
          ['detail', w.detail]])) : '')
      + (rs ? grp('where did it look?', kv([['state', rs.state],
          ['tool calls', rs.toolCalls], ['outside the repo', rs.reachCount]])
          + (rs.sample ? pre(rs.sample.join('\\n')) : '')) : ''));
    return;
  }
  if (t === 'ORACLE_CRITIQUED' || t === 'ORACLE_COMPILED') {
    const o = p.oracle || {};
    const n = (p.findings || []).length;
    card('oracle:' + (o.version || p.version || 1),
      '<span class="stage">Contract' + esc(tag) + '</span>',
      (p.criterionCount || (o.criteria || []).length || 0) + ' criteria · '
        + (o.acceptanceMode || '') + (n ? ' · ' + n + ' finding(s)' : ''),
      n ? { text: n + ' finding(s) stand against it', cls:'ask' }
        : { text:'the critique raised nothing', cls:'ok' },
      { text: t === 'ORACLE_COMPILED' ? 'compiled' : 'critiqued',
        cls: n ? 'warn' : 'ok' },
      (o.criteria ? grp('what it must prove', o.criteria.map((c) => '<div class="fnd">'
        + '<span class="sev">' + esc(short(c.criterionId)) + ' · ' + esc(c.type) + '</span> '
        + esc(c.statement) + '</div>').join('')) : '')
      + (n ? grp('what the critic said', findings(p.findings)) : ''));
    return;
  }
  if (t === 'PLAN_REJECTED' || t === 'PLAN_ACCEPTED' || t === 'PLAN_CRITIQUED') {
    const nodes = p.nodes || (p.plan && p.plan.nodes) || [];
    const f = p.findings || [];
    const rejected = t === 'PLAN_REJECTED';
    card(t + ':' + (p.version || 1) + ':' + (e.seq || 0),
      '<span class="stage">Plan v' + esc(p.version || 1) + esc(tag) + '</span>',
      nodes.length + ' node(s)' + (f.length ? ' · ' + f.length + ' finding(s)' : ''),
      rejected ? { text:(f[0] && (f[0].detail || f[0].claim)) || 'refused', cls:'bad' }
        : t === 'PLAN_ACCEPTED' ? { text:'accepted', cls:'ok' }
          : { text: f.length ? f.length + ' finding(s)' : 'nothing raised', cls: f.length ? 'ask' : 'ok' },
      { text: rejected ? 'refused' : t === 'PLAN_ACCEPTED' ? 'accepted' : 'critiqued',
        cls: rejected ? 'bad' : 'ok' },
      (nodes.length ? grp('the nodes', nodes.map((n) => '<div class="fnd">'
        + '<span class="sev">' + esc(short(n.nodeId)) + (n.slug ? ' · ' + esc(n.slug) : '')
        + '</span> ' + esc(String(n.description || '').slice(0, 400)) + '</div>').join('')) : '')
      + (f.length ? grp('why', findings(f)) : ''));
    return;
  }
  if (t === 'FINDINGS') {
    const f = p.findings || [];
    card(null, '<span class="stage">Reviewer' + esc(tag) + '</span>',
      f.length + ' finding(s)',
      { text: f.length ? (f[0].claim || '').slice(0, 150) : 'nothing to raise',
        cls: f.length ? 'ask' : 'ok' },
      { text: f.length ? 'refused' : 'clean', cls: f.length ? 'warn' : 'ok' },
      grp('what the reviewer said', findings(f)));
    return;
  }
  if (t === 'ROLE_READ_ESCAPE' || t === 'ROLE_WRITE_VIOLATION' || t === 'WRITE_CHECK_UNAVAILABLE') {
    card(null, '<span class="stage">' + esc(t.split('_').join(' ').toLowerCase()) + '</span>',
      esc((p.stage || '') + (p.byKind ? ' · ' + JSON.stringify(p.byKind) : '')),
      { text: String(p.detail || p.consequence || '').slice(0, 160),
        cls: t === 'ROLE_READ_ESCAPE' ? 'ask' : 'bad' },
      { text: t === 'ROLE_READ_ESCAPE' ? 'recorded' : 'stopped',
        cls: t === 'ROLE_READ_ESCAPE' ? 'warn' : 'bad' },
      pre(p));
    return;
  }
  if (t === 'TASK_SPAWNED' || t === 'TASK_OUTCOME' || t === 'INTEGRATION_RESULT') {
    const done = t === 'INTEGRATION_RESULT';
    const okk = done ? p.integrated : p.state === 'COMPLETED';
    card('task:' + (p.taskId || p.nodeId) + ':' + t,
      '<span class="stage">' + esc(short(p.taskId) || short(p.nodeId)) + '</span>'
        + '<span class="who2">' + esc(short(p.nodeId) || '') + '</span>',
      esc(t === 'TASK_SPAWNED' ? (p.repair ? 'repair attempt' : 'first attempt')
        : String(p.state || (p.integrated ? 'integrated' : 'not integrated'))),
      { text: String(p.reason || '').slice(0, 160), cls: okk ? 'ok' : 'ask' },
      { text: t === 'TASK_SPAWNED' ? 'started' : okk ? 'landed' : 'blocked',
        cls: t === 'TASK_SPAWNED' ? 'run' : okk ? 'ok' : 'warn' },
      pre(p));
    return;
  }
  if (t === 'MISSION_TERMINATED') {
    card(null, '<span class="stage">Mission finished' + esc(tag) + '</span>',
      esc(p.achievement + ' / ' + p.terminationReason), { text:'', cls:'' },
      { text: p.achievement === 'ACHIEVED' ? 'achieved' : 'stopped',
        cls: p.achievement === 'ACHIEVED' ? 'ok' : 'warn' }, pre(p));
    if (MISSION) void loadMission();
    return;
  }
  if (t === 'CHAT_MESSAGE') {
    if (p.role === 'user') return;                 // already echoed on send
    turn('zeus', String(p.text || ''), 'zeus');
    return;
  }
  // Everything else still appears — an event nobody wrote a renderer for is
  // still something that happened, and hiding it would make the stream a
  // curated summary rather than a record.
  card(null, '<span class="stage">' + esc(t.split('_').join(' ').toLowerCase()) + esc(tag) + '</span>',
    esc(Object.keys(p).slice(0, 6).join(' · ')), { text:'', cls:'' },
    { text:'', cls:'' }, pre(p));
}

/* -- what wants an answer ------------------------------------------------- */

async function loadMission() {
  if (!MISSION) return;
  let m; try { m = await api(scope('/missions/' + encodeURIComponent(MISSION))); } catch { return; }
  $('ctx').textContent = (PROJECT || '') + ' · ' + short(MISSION);
  const b = m.blockedBy || (m.consent && m.consent.decidable ? m.consent : null);
  if (!b && !m.consent) return;
  const c = m.consent || {};
  if (!c.decidable) return;
  const el = card('consent:' + c.kind + ':' + c.version,
    '<span class="stage">Waiting on you</span><span class="who2">'
      + esc(c.kind + ' v' + c.version) + '</span>',
    esc(c.detail || ''), { text:'nothing moves until you decide', cls:'ask' },
    { text:'your call', cls:'warn' },
    (c.findings && c.findings.length ? grp('what stands against it', findings(c.findings)) : '')
    + '<div class="acts"><button class="btn" data-act="accept">Accept</button>'
    + '<button class="btn q" data-act="refuse">Refuse</button></div>');
  el.classList.add('open');
  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      btn.disabled = true;
      const r = await post(scope('/missions/' + encodeURIComponent(MISSION) + '/confirm'),
        { kind: c.kind, decision: btn.dataset.act === 'accept' ? 'ACCEPT' : 'REFUSE',
          digest: c.digest });
      turn('zeus', r.status < 300 ? 'Recorded: ' + btn.dataset.act + ' on ' + short(MISSION)
        : 'That was refused: ' + JSON.stringify(r.json), 'zeus');
    };
  });
}

/* -- the composer --------------------------------------------------------- */

async function send() {
  const box = $('say');
  const text = box.value.trim();
  if (!text || BUSY) return;
  box.value = ''; box.style.height = 'auto';
  turn('you', text, 'me');
  BUSY = true; $('send').disabled = true;
  const started = Date.now();
  const el = card('pending', '<span class="stage">Front Door</span>',
    'reading your message…', { text:'', cls:'' }, { text:'running', cls:'run' }, '');
  const tick = setInterval(() => {
    el.querySelector('.l2').textContent = 'reading your message… ' + ms(Date.now() - started);
  }, 500);
  try {
    const r = await post(scope('/chat'), { message: text });
    clearInterval(tick);
    CARDS.delete('pending'); el.remove();
    const d = r.json || {};
    if (d.answer) turn('zeus', d.answer, 'zeus');
    else if (d.summary) turn('zeus', d.summary, 'zeus');
    if (d.intent && d.intent !== 'QUESTION') {
      card(null, '<span class="stage">' + esc(d.intent.split('_').join(' ').toLowerCase())
        + '</span><span class="who2">confidence ' + esc(String(d.confidence ?? '')) + '</span>',
        esc(d.summary || ''),
        { text: d.proposedWork ? 'proposed: ' + String(d.proposedWork.goal).slice(0, 140) : '',
          cls:'ask' },
        { text:'decided', cls:'run' },
        (d.evidenceUsed && d.evidenceUsed.length
          ? grp('what it looked at', d.evidenceUsed.map((x) => '<div class="l2">'
              + esc(x.kind + ' ' + x.id + ' — ' + (x.detail || '')) + '</div>').join('')) : '')
        + pre(d));
    }
    await refresh();
  } catch (err) {
    clearInterval(tick); CARDS.delete('pending'); el.remove();
    turn('zeus', 'That did not reach the server: ' + String(err), 'zeus');
  } finally { BUSY = false; $('send').disabled = false; box.focus(); }
}

/* -- context switching ---------------------------------------------------- */

/**
 * Where you are, and everywhere else you could be.
 *
 * PROJECTS FIRST. The /api/project route answers with the project the SERVER
 * was
 * started in, and the first cut treated that as "the project" - so a host
 * serving five repositories opened on whichever one the service happened to be
 * launched from, with no way to leave it. The server was started with
 * --projects, so the set is a fact it can be asked for.
 */
async function openSheet() {
  if (!TOKEN) return;
  const box = $('sheetbox');
  box.innerHTML = '';
  const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

  let ps = null;
  try { ps = await api('/projects'); } catch { ps = null; }
  const list = (ps && ps.projects) || [];
  if (list.length) {
    box.appendChild(add('<div class="grp-t">projects</div>').firstChild);
    for (const pr of list) {
      const r = document.createElement('div');
      r.className = 'row' + (pr.projectId === PROJECT ? ' sel' : '');
      r.innerHTML = '<b>' + esc(pr.projectId) + '</b><span>'
        + esc((pr.adapter || '') + ' · ' + (pr.missions || 0) + ' mission(s)'
          + (pr.lastActivity ? ' · ' + String(pr.lastActivity).slice(0, 10) : '')) + '</span>';
      r.onclick = () => void pick(pr.projectId);
      box.appendChild(r);
    }
  }

  box.appendChild(add('<div class="grp-t">missions in ' + esc(PROJECT || 'this project')
    + '</div>').firstChild);
  let ms2 = []; try { ms2 = await api(scope('/missions')); } catch { ms2 = []; }
  if (!ms2.length) box.appendChild(add('<div class="row"><span>No missions yet. '
    + 'Describe a change below and one is proposed.</span></div>').firstChild);
  for (const m of ms2.slice().reverse().slice(0, 40)) {
    const r = document.createElement('div');
    r.className = 'row' + (m.missionId === MISSION ? ' sel' : '');
    const state = m.terminated ? (m.achievement + ' / ' + m.terminationReason) : m.phase;
    r.innerHTML = '<b>' + esc(short(m.missionId)) + '</b><span>' + esc(m.goal || '')
      + '  —  ' + esc(String(state || '')) + '</span>';
    r.onclick = () => { MISSION = m.missionId; $('sheet').classList.remove('on');
      CARDS.clear(); $('stream').innerHTML = ''; $('empty').style.display = 'none';
      void openMission(); };
    box.appendChild(r);
  }
  $('sheet').classList.add('on');
}

/**
 * Switch project.
 *
 * Everything is rebuilt, including the stream: the SSE subscription carries the
 * project in its URL, so leaving one open would keep delivering the old
 * project's events into the new project's conversation.
 */
async function pick(projectId) {
  PROJECT = projectId; MISSION = null; LAST = null;
  $('sheet').classList.remove('on');
  CARDS.clear(); $('stream').innerHTML = '';
  $('ctx').textContent = PROJECT;
  $('empty').style.display = '';
  stream();
  let ms2 = []; try { ms2 = await api(scope('/missions')); } catch { ms2 = []; }
  const live = ms2.slice().reverse().find((m) => !m.terminated);
  if (live) { MISSION = live.missionId; await openMission(); }
  $('say').focus();
}

async function openMission() {
  if (!MISSION) return;
  $('ctx').textContent = (PROJECT || '') + ' · ' + short(MISSION);
  $('ctx').title = 'click to switch project or mission';
  let evs = [];
  try {
    const r = await api(scope('/missions/' + encodeURIComponent(MISSION) + '/events'));
    // AN ENVELOPE, NOT AN ARRAY. /events answers {total,offset,limit,events},
    // and iterating the envelope threw inside the history loop - which is how
    // one wrong assumption about a response shape became a page stuck on
    // "connecting…". Both shapes are accepted so a future unwrap cannot break
    // it again.
    evs = Array.isArray(r) ? r : (r && r.events) || [];
  } catch { return; }
  for (const e of evs) render(e);
  await loadMission();
}

async function refresh() { await loadMission(); }

/* -- live ----------------------------------------------------------------- */

function stream() {
  if (ES) ES.close();
  let u = '/api/events/stream?token=' + encodeURIComponent(TOKEN)
    + (PROJECT ? '&project=' + encodeURIComponent(PROJECT) : '');
  if (LAST) u += '&lastEventId=' + encodeURIComponent(LAST);
  ES = new EventSource(u);
  ES.onopen = () => conn('live', 'ok');
  ES.onerror = async () => {
    try {
      const r = await fetch('/api/project', { headers:{ authorization:'Bearer ' + TOKEN } });
      conn(r.status === 401 ? 'unauthorized — token changed?' : 'reconnecting…',
        r.status === 401 ? 'bad' : 'warn');
    } catch { conn('server unreachable', 'bad'); }
  };
  // The server names every frame '${SSE_CHANNEL}'. A named frame does not reach
  // onmessage — that is the spec, and assuming otherwise means receiving every
  // event and showing none.
  ES.addEventListener('${SSE_CHANNEL}', (ev) => {
    LAST = ev.lastEventId || LAST;
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    const tail = short(e.taskId);
    // A mission is selected: its own events and the chat's. Nothing selected:
    // everything, because there is no other place to see it.
    if (MISSION && String(e.taskId).indexOf(MISSION) !== 0 && tail !== 'CHAT') return;
    render(e);
  });
}

async function connect() {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) return;
  conn('connecting…', 'warn');
  let p; try { p = await api('/project'); } catch { return; }
  PROJECT = p.projectId;
  $('tok').style.display = 'none'; $('go').style.display = 'none';
  $('ctx').textContent = PROJECT + ' · switch';
  $('hintr').textContent = p.root || '';
  // THE STREAM OPENS FIRST. History can be retried by reloading; a live
  // connection that was never opened because loading history failed cannot be,
  // and the page says "connecting…" with no way to find out why.
  stream();
  let ms2 = []; try { ms2 = await api(scope('/missions')); } catch { /* empty is fine */ }
  const live = ms2.slice().reverse().find((m) => !m.terminated);
  if (live) { MISSION = live.missionId; await openMission(); }
  $('say').focus();
}

$('go').onclick = () => void connect();
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') void connect(); });
$('send').onclick = () => void send();
$('ctx').onclick = () => void openSheet();
$('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('on'); };
$('say').addEventListener('input', function grow() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 190) + 'px';
});
$('say').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
});
</script>
</body>
</html>`;
