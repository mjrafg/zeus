/**
 * The console, as one string.
 *
 * Plain HTML, CSS and JS with no framework and no build chain. Two reasons,
 * both deliberate: `dependencies: {}` is a public claim about this package,
 * and a build chain is a second way for what ships to differ from what the
 * source says. The UI can be plain and honest — the data is the product, and
 * everything on screen is a rendering of the event log.
 *
 * Embedded rather than shipped as separate asset files so the packaged
 * artifact's file list is unchanged and the existing packaging probes keep
 * meaning what they meant.
 */

import { SSE_CHANNEL } from './tail';

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zeus Control Center</title>
<style>
  :root { --bg:#0d1117; --fg:#e6edf3; --dim:#8b949e; --line:#30363d;
          --ok:#3fb950; --warn:#d29922; --bad:#f85149; --acc:#58a6ff; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex;
           gap:12px; align-items:center; flex-wrap:wrap }
  h1 { font-size:15px; margin:0; font-weight:600 }
  .dim { color:var(--dim) }
  main { display:grid; grid-template-columns:minmax(220px,1fr) 1.9fr minmax(300px,1.2fr);
         gap:0; height:calc(100vh - 49px) }
  #list, #chat { overflow:auto; padding:12px 16px }
  #centre { display:flex; flex-direction:column; overflow:hidden }
  #detail { overflow:auto; padding:12px 16px; flex:1 }
  /* The feed lives OUTSIDE #detail on purpose: loadDetail() replaces
     #detail.innerHTML, and anything appended inside it would be destroyed on
     the next refresh. Structure, not discipline, keeps it alive. */
  #feedwrap { border-top:1px solid var(--line); padding:8px 16px 12px;
              height:34%; min-height:120px; overflow:auto; flex:0 0 auto }
  #chat { border-left:1px solid var(--line); display:flex; flex-direction:column }
  #log { flex:1; overflow:auto; margin-bottom:8px }
  .msg { margin:6px 0; padding:6px 8px; border-radius:6px; background:#161b22;
         white-space:pre-wrap; word-break:break-word }
  .msg.me { background:#1f2937 }
  .card { border:1px solid var(--acc); border-radius:6px; padding:10px; margin:8px 0 }
  .card h3 { margin:0 0 6px; font-size:13px }
  .card ol { margin:6px 0; padding-left:18px; color:var(--dim) }
  .card .acts { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px }
  .ask { display:flex; gap:6px }
  .ask input { flex:1; min-width:0 }
  .ref { color:var(--acc); cursor:pointer; text-decoration:underline }
  #home { padding:20px 24px; overflow:auto; grid-column:1 / -1 }
  #home h2 { margin-top:0 }
  .p { border:1px solid var(--line); border-radius:6px; padding:10px 12px;
       margin-bottom:8px; cursor:pointer; display:flex; gap:14px; align-items:baseline }
  .p:hover { border-color:var(--acc) }
  .p b { min-width:170px }
  .newp { border:1px solid var(--acc); border-radius:6px; padding:12px; margin-top:18px }
  .newp .ask { margin-top:8px }
  #crumb { cursor:pointer; color:var(--acc) }
  #list { border-right:1px solid var(--line) }
  .m { padding:8px; border:1px solid var(--line); border-radius:6px;
       margin-bottom:8px; cursor:pointer }
  .m:hover { border-color:var(--acc) }
  .m.sel { border-color:var(--acc); background:#161b22 }
  .goal { display:block; margin-top:4px; color:var(--dim);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  table { border-collapse:collapse; width:100%; margin:8px 0 16px }
  td,th { text-align:left; padding:3px 8px 3px 0; vertical-align:top }
  th { color:var(--dim); font-weight:400 }
  .PROVEN,.ok { color:var(--ok) } .FAILED,.bad { color:var(--bad) }
  .UNEVALUATED,.warn { color:var(--warn) }
  pre { background:#161b22; border:1px solid var(--line); border-radius:6px;
        padding:10px; overflow:auto; max-height:340px }
  input { background:#161b22; color:var(--fg); border:1px solid var(--line);
          border-radius:6px; padding:5px 8px; font:inherit; min-width:280px }
  button { background:#21262d; color:var(--fg); border:1px solid var(--line);
           border-radius:6px; padding:5px 12px; font:inherit; cursor:pointer }
  #feed div { padding:1px 0; border-bottom:1px solid #161b22 }
  h2 { font-size:13px; color:var(--dim); font-weight:400; margin:16px 0 4px;
       text-transform:uppercase; letter-spacing:.06em }
  .phase { display:inline-block; padding:1px 7px; border:1px solid var(--line);
           border-radius:999px; font-size:12px }
  .waiting { border-color:var(--warn); color:var(--warn) }
  .m.waits { border-color:var(--warn) }
  .pending { border:1px solid var(--warn); border-radius:6px; padding:12px;
             margin:10px 0; background:#1b1710 }
  .pending h3 { margin:0 0 8px; font-size:13px; color:var(--warn) }
  .pending .f { border-left:2px solid var(--line); padding:4px 0 4px 8px; margin:6px 0 }
  .pending .acts { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px }
  .gauge { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap }
  .bar { flex:1; min-width:120px; height:6px; border-radius:3px; background:#21262d;
         overflow:hidden }
  .bar i { display:block; height:100%; background:var(--acc) }
  .bar i.warn { background:var(--warn) }
  .bar i.bad { background:var(--bad) }
  .budgetpick input { width:88px }
  .budgetpick { margin:8px 0 }
  .node { border-left:2px solid var(--line); padding:6px 0 6px 10px; margin:8px 0 }
  .node.done { border-left-color:var(--ok) }
  .node b { font-weight:600 }
  .node .meta { color:var(--dim); font-size:11px; margin-top:2px }
  .node .desc { color:var(--dim); margin-top:3px; white-space:pre-wrap }
  .busy { border:1px solid var(--acc); border-radius:6px; padding:8px 10px;
          margin:10px 0; background:#0d1a26 }
  .busy b { color:var(--acc) }
  @keyframes pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
  .busy .dot { display:inline-block; width:7px; height:7px; border-radius:50%;
               background:var(--acc); margin-right:6px; animation:pulse 1.4s infinite }
  #actslot .acts { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 }
  #actslot button.ghost { background:transparent; color:var(--dim);
                          border-color:var(--line) }
  #actslot button:disabled { opacity:.55; cursor:default }
  .f { border-left:2px solid var(--line); padding:4px 0 4px 8px; margin:6px 0 }
</style>
</head>
<body>
<header>
  <h1>Zeus Control Center</h1>
  <span class="dim" id="proj">—</span>
  <span id="crumb" style="display:none">← all projects</span>
  <span style="flex:1"></span>
  <input id="tok" type="password" placeholder="bearer token (printed once at startup)">
  <button id="go">connect</button>
  <span id="conn" class="dim">offline</span>
</header>
<main>
  <div id="home" style="display:none"></div>
  <div id="list"><p class="dim">Enter the token to connect.</p></div>
  <div id="centre">
    <div id="detail"><p class="dim">Select a mission.</p></div>
    <div id="feedwrap"><h2>live events</h2><div id="feed"></div></div>
  </div>
  <div id="chat">
    <h2>chat</h2>
    <div id="log"><p class="dim">Ask about this project, or describe a change.</p></div>
    <div class="ask">
      <input id="say" placeholder="ask a question, or describe a change…">
      <button id="send">send</button>
    </div>
  </div>
</main>
<script>
// The token lives in memory only. Persisting it to localStorage would put a
// credential that can spend money into the most-read storage in the browser.
let TOKEN = '', SEL = null, ES = null, LAST = null;
// Which project every per-project call is about. null = the project the
// server was started in, which is what the API assumes without ?project=.
let PROJECT = null;
const scope = (p) => p + (PROJECT ? (p.includes('?') ? '&' : '?') + 'project='
  + encodeURIComponent(PROJECT) : '');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

async function api(p) {
  const r = await fetch('/api' + p, { headers: { authorization: 'Bearer ' + TOKEN } });
  if (r.status === 401) { setConn('unauthorized — token changed?', 'bad'); throw new Error('401'); }
  return r.json();
}

function setConn(text, cls) {
  $('conn').textContent = text;
  $('conn').className = cls || 'dim';
}

/**
 * Why the connection is down, rather than only that it is.
 *
 * EventSource reports failure without a status code, so "offline" covered a
 * dead server and a stale token alike — two problems with completely different
 * answers. One probe tells them apart.
 */
async function diagnoseConn() {
  try {
    const r = await fetch('/api/project', { headers: { authorization: 'Bearer ' + TOKEN } });
    if (r.status === 401) { setConn('unauthorized — token changed?', 'bad'); return; }
    setConn('reconnecting…', 'warn');
  } catch { setConn('server unreachable', 'bad'); }
}

async function loadList() {
  const ms = await api(scope('/missions'));
  $('list').innerHTML = ms.length ? '' : '<p class="dim">No missions yet.</p>';
  for (const m of ms) {
    const d = document.createElement('div');
    d.className = 'm' + (m.missionId === SEL ? ' sel' : '');
    const state = m.terminated ? m.achievement + ' / ' + m.terminationReason : m.phase;
    if (m.awaitingHuman) d.className += ' waits';
    d.innerHTML = '<b>' + esc(m.missionId.split('/').pop()) + '</b> '
      + '<span class="phase' + (m.awaitingHuman ? ' waiting' : '') + '">' + esc(state) + '</span>'
      + (m.awaitingHuman ? ' <span class="phase waiting">waiting on you</span>' : '')
      + '<span class="goal">' + esc(m.goal) + '</span>';
    d.onclick = () => { SEL = m.missionId; loadList(); loadDetail(); };
    $('list').appendChild(d);
  }
}

async function loadDetail() {
  if (!SEL) return;
  const m = await api(scope('/missions/' + encodeURIComponent(SEL.split('/').pop())));
  const rep = await api(scope('/missions/' + encodeURIComponent(SEL.split('/').pop()) + '/report'));
  const o = m.oracle;
  let h = '<h2>' + esc(m.missionId) + '</h2><p>' + esc(m.goal) + '</p>';
  h += '<table><tr><th>phase</th><td><span class="phase">' + esc(m.phase) + '</span></td></tr>'
    + '<tr><th>plan</th><td>' + (m.acceptedPlanVersion == null ? 'none accepted'
      : 'v' + m.acceptedPlanVersion + (m.acceptedPlan ? '' : ' (invalidated)')) + '</td></tr>'
    + '<tr><th>ratchet</th><td>' + esc(m.ratchetSha ? m.ratchetSha.slice(0,12) : 'never advanced') + '</td></tr>'
    + '<tr><th>cost</th><td>' + costCell(m) + '</td></tr>'
    + '<tr><th>budget</th><td>' + budgetCell(m) + '</td></tr></table>';

  h += '<div id="transcript" class="acts"></div>';
  h += '<div id="actslot"></div>';
  if (o) {
    h += '<div id="pendingslot"></div>';
  h += '<h2>criteria</h2><table>';
    for (const c of o.criteria) {
      const out = m.criterionOutcomes[c.criterionId] || 'UNEVALUATED';
      h += '<tr><td>' + esc(c.criterionId.split('/').pop()) + '</td>'
        + '<td class="' + esc(out) + '">' + esc(out) + '</td>'
        + '<td class="dim">' + esc(c.statement) + '</td></tr>';
    }
    h += '</table>';
  }
  h += planSection(m);
  if (rep.integrations.length) {
    h += '<h2>integrations</h2><table>';
    for (const i of rep.integrations) {
      h += '<tr><td class="' + (i.integrated && !i.invariantsBroken.length ? 'ok' : 'bad') + '">'
        + (i.integrated && !i.invariantsBroken.length ? 'green' : 'refused') + '</td>'
        + '<td>' + esc(i.nodeId.split('/').pop()) + '</td>'
        + '<td class="dim">' + esc(i.reason) + '</td></tr>';
    }
    h += '</table>';
  }
  $('detail').innerHTML = h;
  wireTranscript(m);
  wireBudgetControl(m);
  renderActions(m);
  if (m.pendingDecision) renderPending(m, m.pendingDecision);
}

function costCell(m) {
  let h = '$' + (m.cost.totalUsd || 0).toFixed(4);
  if (m.cost.isLowerBound) {
    h += ' <span class="warn">(a lower bound \u2014 ' + m.cost.unmeteredCalls
      + ' call(s) reported no price)</span>';
  }
  h += Object.keys(m.cost.byPhase || {}).length
    ? '<br><span class="dim">'
      + Object.entries(m.cost.byPhase).map(([k, v]) => esc(k) + ' $' + Number(v).toFixed(4)).join('  ')
      + '</span>'
    : '<br><span class="dim">nothing spent yet</span>';
  return h;
}

/**
 * The whole record of one mission, on the clipboard or on disk.
 *
 * Everything the log holds: the mission's own events, every task it spawned,
 * the project chat since it began, and the runner's own output. Reading a
 * mission by scrolling a feed and opening event payloads one at a time is not
 * reading it; this is the thing to paste into a message, an issue, or another
 * model when you want a second opinion on what actually happened.
 *
 * Copy AND download, because the two fail differently. The clipboard needs a
 * secure context and balks at some sizes; a download always works but leaves
 * a file to find. Whichever is refused, the other is still there.
 */
function wireTranscript(m) {
  const slot = $('transcript');
  if (!slot) return;
  const url = scope('/missions/' + encodeURIComponent(m.missionId.split('/').pop()) + '/bundle');

  const copy = document.createElement('button');
  copy.className = 'ghost';
  copy.textContent = 'copy full transcript';
  copy.title = 'every event on this mission, its tasks, the chat and the runner output';
  copy.onclick = async () => {
    const was = copy.textContent;
    copy.disabled = true;
    copy.textContent = 'fetching\u2026';
    try {
      const r = await fetch('/api' + url, { headers: { authorization: 'Bearer ' + TOKEN } });
      if (!r.ok) throw new Error('the server answered ' + r.status);
      const text = await r.text();
      await writeClipboard(text);
      const kb = Math.max(1, Math.round(text.length / 1024));
      copy.textContent = 'copied \u2014 ' + kb + ' KB';
      bubble('Copied the full transcript of <b>' + esc(m.missionId) + '</b> \u2014 '
        + kb + ' KB.<br><span class="dim">prompts and raw model replies are not in it; '
        + 'the log keeps a hash and a size, never the words</span>', false);
    } catch (e) {
      copy.textContent = was;
      bubble('<span class="bad">could not copy: ' + esc(String(e && e.message || e))
        + '</span><br><span class="dim">use download instead</span>', false);
    } finally {
      copy.disabled = false;
      setTimeout(() => { copy.textContent = was; }, 4000);
    }
  };
  slot.appendChild(copy);

  const dl = document.createElement('a');
  dl.className = 'ref';
  dl.style.marginLeft = '8px';
  dl.href = '/api' + url + (url.includes('?') ? '&' : '?') + 'token='
    + encodeURIComponent(TOKEN);
  dl.textContent = 'download it instead';
  slot.appendChild(dl);
}

/**
 * The clipboard, with the fallback that works when it is not available.
 *
 * navigator.clipboard needs a secure context and is not there on a plain-http
 * origin, which is exactly how someone reaching this over a tunnel or a LAN
 * address arrives. The old execCommand path is deprecated and still works.
 */
async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('the browser refused the clipboard');
}

/**
 * Spend against the ceiling, and the counts against their limits.
 *
 * The console used to show money going out with nothing to measure it
 * against: the $5.00 default appeared nowhere until the moment a stop
 * announced you had passed it. These are the numbers the engine enforces, not
 * a second opinion about them — the server sends what budgetsFor and
 * missionUsage produce, which is exactly what checkMissionBudgets is handed.
 */
function budgetCell(m) {
  const b = m.budgets, u = m.usage;
  if (!b || !u) return '<span class="dim">not reported</span>';
  const rows = [
    { label: 'spend', now: u.costUsd || 0, max: b.costCeilingUsd,
      fmt: (v) => '$' + Number(v).toFixed(4) },
    { label: 'tasks', now: u.tasksSpawned, max: b.maxTasks, fmt: (v) => String(v) },
    // AUTOMATIC replans against the limit, because that is the only kind the
    // limit bounds. Showing every refused plan against it read "3 of 3
    // reached" over a cascade that was correctly still running, because one of
    // the three was the attempt a person asked for. A gauge that disagrees
    // with the rule it draws is worse than no gauge.
    { label: 'automatic replans', now: u.autoPlanRecompiles, max: b.maxPlanRecompiles,
      fmt: (v) => String(v) },
    { label: 'replans', now: u.replans, max: b.maxReplans, fmt: (v) => String(v) },
  ];
  let h = '';
  for (const r of rows) {
    // Only the spend line is worth showing when nothing has happened yet; the
    // rest are noise on a mission that has not started.
    if (r.now === 0 && r.label !== 'spend') continue;
    const frac = r.max > 0 ? Math.min(1, r.now / r.max) : 0;
    const cls = r.now >= r.max ? 'bad' : frac >= 0.75 ? 'warn' : '';
    h += '<div class="gauge">'
      + '<span>' + esc(r.label) + ' <b>' + r.fmt(r.now) + '</b>'
      + ' <span class="dim">of ' + r.fmt(r.max) + '</span></span>'
      + '<span class="bar"><i class="' + cls + '" style="width:'
      + Math.round(frac * 100) + '%"></i></span>'
      + (r.now >= r.max ? '<span class="bad">reached</span>' : '')
      + '</div>';
  }
  // The total, as information rather than a limit: human-triggered attempts
  // are bounded by spend, not by a count.
  if (u.planRecompiles > u.autoPlanRecompiles) {
    h += '<div class="dim">' + u.planRecompiles + ' plan(s) refused in all; the other '
      + (u.planRecompiles - u.autoPlanRecompiles)
      + ' were asked for, and are bounded by spend rather than by a count</div>';
  }
  if (m.cost.isLowerBound) {
    h += '<div class="dim">the ceiling is checked against provider-reported spend; '
      + m.cost.unmeteredCalls + ' call(s) reported no price and are not in it</div>';
  }
  if (!m.terminated) {
    h += '<div class="gauge budgetpick"><span>set ceiling $</span>'
      + '<input id="setceil" type="number" min="0.5" step="0.5" value="'
      + Number(b.costCeilingUsd).toFixed(2) + '">'
      + '<button class="ghost" id="setceilgo">revise</button></div>';
  }
  return h;
}

/**
 * Revising a limit from the page.
 *
 * The only way to change a budget was zeus mission confirm --raise-budget,
 * which raises the ceiling to exactly the planner's estimate and lives in a
 * terminal. A console that can spend money should be able to say how much it
 * is allowed to spend. The change is a MISSION_BUDGET_REVISED event like every
 * other, so it survives a restart and appears in the log next to what it paid
 * for.
 */
function wireBudgetControl(m) {
  const go = $('setceilgo');
  if (!go) return;
  go.onclick = async () => {
    const to = Number($('setceil').value);
    if (!(to > 0)) {
      bubble('<span class="bad">a ceiling must be a positive number of dollars</span>', false);
      return;
    }
    const from = m.budgets.costCeilingUsd;
    if (to < (m.usage.costUsd || 0)) {
      if (!confirm('$' + (m.usage.costUsd || 0).toFixed(4)
        + ' is already spent. A ceiling of $' + to.toFixed(2)
        + ' stops this mission immediately. Continue?')) return;
    }
    go.disabled = true;
    const r = await apiPost('/missions/' + encodeURIComponent(m.missionId.split('/').pop())
      + '/budget', { limit: 'costCeilingUsd', to });
    if (r.status >= 400) {
      bubble('<span class="bad">' + esc((r.json && (r.json.detail || r.json.error)) || r.status)
        + '</span>', false);
    } else if (r.json && r.json.unchanged) {
      bubble('The ceiling is already $' + to.toFixed(2) + '.', false);
    } else {
      bubble('Ceiling on <b>' + esc(m.missionId) + '</b> $' + Number(from).toFixed(2)
        + ' &rarr; <b>$' + to.toFixed(2) + '</b>, recorded as MISSION_BUDGET_REVISED.', false);
    }
    loadList(); loadDetail();
  };
}

/**
 * The task graph, which the console has never shown.
 *
 * The plan has been on the mission view since W1a and nothing rendered it, so
 * the only way to see what a mission proposed to DO was to read the event log
 * by hand. A plan is the thing you are consenting to; it belongs on the page.
 */
function planSection(m) {
  const p = m.plan;
  if (!p || !Array.isArray(p.nodes) || !p.nodes.length) return '';
  const accepted = m.acceptedPlanVersion === p.version;
  const doneIds = {};
  for (const s of (m.spawned || [])) if (s && s.nodeId) doneIds[s.nodeId] = s.taskId || true;
  let h = '<h2>plan v' + p.version + ' <span class="dim">'
    + p.nodes.length + ' node(s), '
    + (accepted ? 'accepted' : 'not accepted') + '</span></h2>';
  for (const n of p.nodes) {
    const short = String(n.nodeId || '').split('/').pop();
    const deps = (n.dependsOn || []).map((d) => String(d).split('/').pop());
    h += '<div class="node' + (doneIds[n.nodeId] ? ' done' : '') + '">'
      + '<b>' + esc(short) + '</b> ' + esc(n.slug || '')
      + '<div class="meta">'
      + esc(n.estimatedTier || '') + ' \u00b7 risk ' + esc(n.risk || '')
      + ' \u00b7 est $' + Number(n.estimatedCost || 0).toFixed(2)
      + (deps.length ? ' \u00b7 after ' + esc(deps.join(', ')) : '')
      + (n.writes && n.writes.length ? ' \u00b7 writes ' + esc(n.writes.join(' ')) : '')
      + '</div>'
      + '<div class="desc">' + esc(String(n.description || '').slice(0, 400))
      + (String(n.description || '').length > 400 ? '\u2026' : '') + '</div>'
      + '</div>';
  }
  const est = p.nodes.reduce((a, n) => a + (Number(n.estimatedCost) || 0), 0);
  h += '<p class="dim">the planner estimates $' + est.toFixed(2)
    + ' across ' + p.nodes.length + ' node(s)</p>';
  return h;
}

/**
 * The next step, and the way out.
 *
 * The console could create a mission and then not move it: the card promised
 * compile -> critic -> consent -> plan -> consent -> run and offered no
 * control for any of them, so every mission made from the web sat at CREATED
 * until someone opened a terminal. The routes existed the whole time.
 *
 * ONE step button, because there is only ever one next step, and none at all
 * while a consent decision is pending — the findings below are the move then,
 * and a second button beside them would be a way to skip reading.
 */
const NEXT_STEP = {
  CREATED: { id: 'compile', label: 'compile the contract',
    detail: 'a model turns the goal into checkable criteria, and a second model reviews it' },
  ORACLE: { id: 'compile', label: 'recompile the contract',
    detail: 'compiled but not yet critiqued — run it again' },
  // Reached by refusing a contract: the stop is answered, and what is left to
  // do is a second round that answers the findings rather than repeating them.
  CONSENT: { id: 'compile', label: 'recompile, answering the findings',
    detail: 'the critic\u2019s findings go back to the compiler, and a fresh critic reviews the result' },
  PLAN_CONSENT: { id: 'plan', label: 'plan again',
    detail: 'the refused plan is replaced by a new one' },
  PLANNING: { id: 'plan', label: 'plan the work',
    detail: 'a model proposes the task graph, and a critic reviews it' },
  RUNNING: { id: 'run', label: 'run the tasks',
    detail: 'tasks execute one at a time, each integrated only if it stays green' },
  INTEGRATING: { id: 'run', label: 'continue the run',
    detail: 'pick the mission back up where it stopped' },
  EVALUATING: { id: 'run', label: 'continue the run',
    detail: 'pick the mission back up where it stopped' },
};

function renderActions(m) {
  const slot = $('actslot');
  if (!slot || m.terminated) return;

  // NOTHING is pressable while something is running on this mission.
  //
  // The buttons only ever disabled themselves for the life of their own
  // request, so a reload, a second tab, or a request the proxy cut off left
  // them live again — and a second click spawned a second runner. Two runs
  // raced on one mission: same node built twice, paid for twice, and the
  // slower one wrote an integration into a mission the faster had terminated.
  // The state comes from the server, so every tab agrees.
  if (m.running) {
    const b = document.createElement('div');
    b.className = 'busy';
    b.innerHTML = '<span class="dot"></span><b>' + esc(m.running.kind)
      + '</b> is running on this mission'
      + (m.running.pid ? ' <span class="dim">(pid ' + m.running.pid + ')</span>' : '')
      + '<br><span class="dim">since ' + esc(String(m.running.since).replace('T', ' ').slice(0, 19))
      + ' \u00b7 watch the live events; the page rebuilds itself from the log</span>';
    slot.appendChild(b);
    const stop = document.createElement('div');
    stop.className = 'acts';
    const c = document.createElement('button');
    c.className = 'ghost';
    c.textContent = 'cancel mission';
    c.onclick = async () => {
      if (!confirm('Cancel ' + m.missionId + '? This terminates it.')) return;
      c.disabled = true;
      const r = await apiPost('/missions/'
        + encodeURIComponent(m.missionId.split('/').pop()) + '/cancel', {});
      reportOperation(m, 'cancel mission', r);
      loadList(); loadDetail();
    };
    stop.appendChild(c);
    slot.appendChild(stop);
    return;
  }

  // A DEAD END SAYS WHAT IT IS. A plan the critic rejected is not decidable by
  // consent, so nothing is pending — and this slot used to fill that silence
  // with a 'plan again' button that could not help, while the findings that
  // actually stood were on the log and on no screen.
  if (m.blockedBy) {
    slot.appendChild(renderBlocked(m, m.blockedBy));
    return;
  }

  const step = m.pendingDecision ? null : NEXT_STEP[m.phase];
  if (!step && !m.pendingDecision) return;
  const d = document.createElement('div');
  d.className = 'acts';
  const short = encodeURIComponent(m.missionId.split('/').pop());

  // Says so ON THE BUTTON THAT WAS PRESSED. A click that changes nothing on
  // screen for the twenty seconds a model takes reads as a click that never
  // registered, and the second click is the one that does damage.
  const fire = async (btn, path, label) => {
    for (const x of d.querySelectorAll('button')) x.disabled = true;
    const was = btn.textContent;
    btn.textContent = label + ' …';
    const r = await apiPost('/missions/' + short + path, {});
    btn.textContent = was;
    reportOperation(m, label, r);
    loadList(); loadDetail();
  };

  if (step) {
    const b = document.createElement('button');
    b.textContent = step.label;
    b.title = step.detail;
    b.onclick = () => fire(b, '/' + step.id, step.label);
    d.appendChild(b);
  }
  const c = document.createElement('button');
  c.className = 'ghost';
  c.textContent = 'cancel mission';
  c.title = 'terminate this mission';
  c.onclick = () => {
    if (!confirm('Cancel ' + m.missionId + '? This terminates it.')) return;
    return fire(c, '/cancel', 'cancel mission');
  };
  d.appendChild(c);
  slot.appendChild(d);
}

/**
 * What the operation answered, in full.
 *
 * A refusal is the interesting outcome, so it is rendered rather than reduced
 * to a status code: REJECTED comes back with the findings that caused it, and
 * hiding them would defeat the point of stopping.
 */
function reportOperation(m, label, r) {
  const j = r.json || {};
  const id = esc(m.missionId);
  // A LOST CONNECTION IS NOT A FAILED OPERATION. Compile and plan take
  // minutes; a proxy that gives up at 100 seconds produced "failed: 524" over
  // work that had already succeeded and was on the log — and the operator,
  // told it failed, pressed the button again.
  if (r.status === 0 || r.status === 502 || r.status === 503
    || r.status === 504 || r.status === 524) {
    bubble('<span class="warn">' + esc(label) + ' on ' + id
      + ' lost its connection (' + r.status + ')</span>'
      + '<br><span class="dim">the operation is still running on the server \u2014 '
      + 'watch the live events; do not start it again</span>', false);
    return;
  }
  if (r.status === 202) {
    bubble(esc(label) + ' on ' + id + ' <span class="ok">started</span>'
      + '<br><span class="dim">' + esc(j.detail || 'it runs on the server') + '</span>', false);
    return;
  }
  if (r.status === 409 && j.error === 'ALREADY_RUNNING') {
    bubble('<span class="warn">' + esc(j.detail || 'already running') + '</span>', false);
    return;
  }
  if (r.status >= 400) {
    bubble('<span class="bad">' + esc(label) + ' on ' + id + ' failed: '
      + esc(j.error || r.status) + '</span>'
      + (j.detail ? '<br><span class="dim">' + esc(j.detail) + '</span>' : ''), false);
    return;
  }
  if (j.ok === false) {
    let h = '<span class="bad">' + esc(label) + ' stopped: ' + esc(j.kind || 'refused')
      + '</span>';
    if (j.detail) h += '<br><span class="dim">' + esc(j.detail) + '</span>';
    for (const f of (j.findings || [])) {
      h += '<div class="f"><b>' + esc(f.code || f.severity || 'finding') + '</b> '
        + '<span class="dim">' + esc(f.detail || JSON.stringify(f)) + '</span></div>';
    }
    bubble(h, false);
    return;
  }
  if (j.pid !== undefined) {
    bubble(esc(label) + ' on ' + id + ': ' + esc(j.detail || 'started')
      + '<br><span class="dim">it runs detached; watch the live events</span>', false);
    return;
  }
  bubble(esc(label) + ' on ' + id + ' <span class="ok">done</span>'
    + '<span class="dim"> — the mission page below is rebuilt from the log</span>', false);
}

/**
 * Why there is no next step, and what can actually be done about it.
 *
 * The findings first and in full, then the options — the same order every
 * surface in this product uses. The only action offered here is the one that
 * needs no new decision from the engine; raising a limit and narrowing a goal
 * are things a person does, and saying so is more use than a button that
 * spends money to reach the identical refusal.
 */
function renderBlocked(m, b) {
  const d = document.createElement('div');
  d.className = 'pending';
  let h = '<h3>This mission cannot go forward as planned</h3>';
  h += '<p class="dim">' + esc(b.detail) + '</p>';
  if (b.findings && b.findings.length) {
    h += '<b>' + b.findings.length + ' finding(s) against the last plan</b>';
    for (const f of b.findings) {
      h += '<div class="f"><b>' + esc(f.code || 'finding') + '</b> '
        + (f.severity ? '<span class="warn">' + esc(f.severity) + '</span> ' : '')
        + esc(f.nodeId ? String(f.nodeId).split('/').pop() : '')
        + '<br><span class="dim">' + esc(f.detail || '') + '</span></div>';
    }
  }
  h += '<b>What you can do</b><ul class="dim">'
    + b.options.map((o) => '<li>' + esc(o) + '</li>').join('') + '</ul>';
  h += '<div class="acts"></div>';
  d.innerHTML = h;
  const acts = d.querySelector('.acts');
  const short = encodeURIComponent(m.missionId.split('/').pop());

  // A button for what the console CAN do, prose for what a person must decide.
  // The first cut removed the plan button in every case rather than the
  // exhausted one, so a mission with budget to spare listed 'plan again' as an
  // option with no way to take it.
  if (b.canPlanAgain) {
    const p = document.createElement('button');
    p.textContent = 'plan again, answering the findings';
    p.title = 'the critic\u2019s findings are carried into the next plan';
    p.onclick = async () => {
      for (const x of d.querySelectorAll('button')) x.disabled = true;
      const r = await apiPost('/missions/' + short + '/plan', {});
      reportOperation(m, 'plan again', r);
      loadList(); loadDetail();
    };
    acts.appendChild(p);
  }

  const c = document.createElement('button');
  c.className = 'ghost';
  c.textContent = 'cancel mission';
  c.onclick = async () => {
    if (!confirm('Cancel ' + m.missionId + '? This terminates it.')) return;
    for (const x of d.querySelectorAll('button')) x.disabled = true;
    const r = await apiPost('/missions/' + short + '/cancel', {});
    reportOperation(m, 'cancel mission', r);
    loadList(); loadDetail();
  };
  acts.appendChild(c);
  return d;
}

/**
 * What this mission is waiting on, rebuilt from the log.
 *
 * Findings FIRST and in full, then the buttons — the same order every consent
 * surface in this product uses. A decision carries the digest of exactly what
 * is on screen, and the server refuses any digest that no longer matches, so
 * this is pure exposure of a boundary that already existed rather than a new
 * way in.
 */
function renderPending(m, p) {
  const slot = $('pendingslot');
  if (!slot) return;
  const d = document.createElement('div');
  d.className = 'pending';
  let h = '<h3>This mission is waiting on you — ' + esc(p.layer) + ' v' + p.version + '</h3>';
  h += '<p class="dim">' + esc(p.detail) + '<br>' + esc(p.source) + '</p>';
  h += '<b>' + p.findings.length + ' finding(s), as they were rendered</b>';
  for (const f of p.findings) {
    h += '<div class="f"><b>' + esc(f.code || f.severity || 'finding') + '</b> '
      + esc(f.criterionId ? f.criterionId.split('/').pop() : (f.nodeId || ''))
      + '<br><span class="dim">' + esc(f.detail || JSON.stringify(f)) + '</span></div>';
  }
  h += '<div class="acts"></div>';
  d.innerHTML = h;
  const acts = d.querySelector('.acts');
  const MAP = { accept: 'ACCEPT', abort: 'ABORT', recompile: 'REFUSE', replan: 'REFUSE' };
  for (const o of p.options) {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.title = o.detail;
    b.onclick = async () => {
      if (o.id === 'abort' && !confirm('Cancel ' + m.missionId + '? This terminates it.')) return;
      for (const x of d.querySelectorAll('button')) x.disabled = true;
      const r = await apiPost('/missions/' + encodeURIComponent(m.missionId.split('/').pop()) + '/confirm',
        { kind: p.layer, version: p.version, findingsDigest: p.digest, decision: MAP[o.id] || 'REFUSE' });
      if (r.status === 409) {
        bubble('<span class="bad">' + esc(r.json.detail) + '</span>', false);
      } else {
        bubble('Recorded: <b>' + esc(o.label) + '</b> on ' + esc(m.missionId) + '.', false);
      }
      loadList(); loadDetail();
    };
    acts.appendChild(b);
  }
  slot.appendChild(d);
}

function connectStream() {
  if (ES) ES.close();
  // EventSource cannot set headers, so the stream takes the same token in the
  // query string — same secret, same check.
  let u = '/api/events/stream?token=' + encodeURIComponent(TOKEN)
    + (PROJECT ? '&project=' + encodeURIComponent(PROJECT) : '');
  if (LAST) u += '&lastEventId=' + encodeURIComponent(LAST);
  ES = new EventSource(u);
  ES.onopen = () => setConn('live', 'ok');
  ES.onerror = () => { void diagnoseConn(); };
  // The server names every frame '${SSE_CHANNEL}'. A named SSE frame does NOT
  // reach onmessage — that is the spec, and assuming otherwise meant the
  // browser received every event and displayed none of them.
  ES.addEventListener('${SSE_CHANNEL}', (ev) => {
    LAST = ev.lastEventId || LAST;
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    const feed = $('feed');
    if (feed) {
      const mine = SEL && (e.taskId === SEL || String(e.taskId).startsWith(SEL));
      const tail = String(e.taskId).split('/').pop();
      const where = mine ? '' : (tail === 'CHAT' ? 'chat' : tail);
      const row = document.createElement('div');
      row.innerHTML = '<span class="dim">' + esc(e.ts.slice(11,19)) + '</span> '
        + (where ? '<span class="dim">' + esc(where) + '</span> ' : '')
        + esc(e.type);
      feed.prepend(row);
      while (feed.childElementCount > 200) feed.lastElementChild.remove();
    }
    loadList();
    if (SEL) loadDetail();
  });
}

// Scoped HERE rather than at each call site. The consent route was the one
// caller that forgot, which meant an ACCEPT typed in one project was posted
// against the project the server was started in. A rule every caller must
// remember is a rule one caller will eventually forget.
async function apiPost(p, body) {
  // A fetch that never came back is reported as status 0 rather than thrown.
  // A thrown error left the caller unable to tell "the server refused" from
  // "the connection died", and those need opposite advice: one means fix it,
  // the other means wait and DO NOT press it again.
  let r;
  try {
    r = await fetch('/api' + scope(p), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { status: 0, json: { error: 'CONNECTION_LOST', detail: String(e && e.message || e) } };
  }
  return { status: r.status, json: await r.json().catch(() => null) };
}

function bubble(html, mine) {
  const d = document.createElement('div');
  d.className = 'msg' + (mine ? ' me' : '');
  d.innerHTML = html;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
  return d;
}

function renderAnswer(a) {
  let h = esc(a.text);
  if (a.refs && a.refs.length) {
    h += '<br>' + a.refs.map((r) => '<span class="ref" data-id="' + esc(r.id) + '">'
      + esc(r.kind + ' ' + r.id.split('/').pop() + (r.seq != null ? '#' + r.seq : '')) + '</span>').join(' ');
  }
  const d = bubble(h, false);
  // Refs are clickable through to the views W1a built.
  for (const el of d.querySelectorAll('.ref')) {
    el.onclick = () => { SEL = el.getAttribute('data-id'); loadList(); loadDetail(); };
  }
}

/**
 * A card is a proposal. Nothing here creates anything: every button posts a
 * decision carrying the digest of exactly what is on screen, and the server
 * refuses any digest that no longer matches.
 */
function renderCard(card) {
  const d = document.createElement('div');
  d.className = 'card';
  let h = '<h3>Create a mission?</h3>';
  if (card.intent === 'AMBIGUOUS') {
    h += '<p class="warn">I am not sure whether this was a request or a question.</p>';
  }
  h += '<p><b>Goal:</b> ' + esc(card.originalGoal) + '</p>';
  if (card.proposedGoal) {
    h += '<p><b>Proposed wording:</b> ' + esc(card.proposedGoal)
      + ' <span class="dim">(that suggestion cost $'
      + (card.proposalCostUsd || 0).toFixed(4) + ')</span></p>';
  }
  h += '<b>What happens next</b><ol>'
    + card.whatHappensNext.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol>';
  h += '<p class="dim">' + esc(card.costExpectation) + '</p>';
  if (card.budget) {
    h += '<div class="gauge budgetpick"><span>ceiling $</span>'
      + '<input id="cardceil" type="number" min="0.5" step="0.5" value="'
      + Number(card.budget.costCeilingUsd).toFixed(2) + '">'
      + '<button class="ghost" id="cardceilset">use this ceiling</button>'
      + (card.budget.aboveDefault
        ? '<span class="warn">above the $'
          + Number(card.budget.defaultCeilingUsd).toFixed(2) + ' default</span>'
        : '')
      + '</div>';
  }
  h += '<div class="acts"></div>';
  d.innerHTML = h;
  // Changing the ceiling REDRAWS the card rather than editing it in place.
  // The budget is inside the digest, so a card whose number was changed after
  // it was rendered is a different proposal and has to be read again.
  const setBtn = d.querySelector('#cardceilset');
  if (setBtn) {
    setBtn.onclick = async () => {
      const want = Number(d.querySelector('#cardceil').value);
      if (!(want > 0)) { bubble('<span class="bad">a ceiling must be a positive number of dollars</span>', false); return; }
      for (const x of d.querySelectorAll('button')) x.disabled = true;
      const r = await apiPost('/chat', { message: card.originalGoal, costCeilingUsd: want });
      if (r.json && r.json.card) renderCard(r.json.card);
      else bubble('<span class="bad">the card could not be redrawn</span>', false);
    };
  }
  const acts = d.querySelector('.acts');
  for (const a of card.actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = async () => {
      let goal = card.originalGoal;
      if (a.id === 'edit') {
        const next = prompt('Goal for this mission:', card.proposedGoal || card.originalGoal);
        if (!next) return;
        goal = next;
      }
      const decision = a.id === 'edit' ? 'create' : a.id;
      const r = await apiPost('/chat/decide',
        { card, cardDigest: card.digest, decision, goal });
      for (const x of d.querySelectorAll('button')) x.disabled = true;
      if (r.status === 409) {
        bubble('<span class="bad">' + esc(r.json.detail) + '</span>', false);
        renderCard(r.json.current);
      } else if (r.json && r.json.answer) {
        renderAnswer(r.json.answer);
      } else if (r.json && r.json.missionId) {
        bubble('Created <b>' + esc(r.json.missionId) + '</b>.', false);
        SEL = r.json.missionId; loadList(); loadDetail();
      } else {
        bubble('Nothing was created.', false);
      }
    };
    acts.appendChild(b);
  }
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}

async function send() {
  const text = $('say').value.trim();
  if (!text) return;
  $('say').value = '';
  bubble(esc(text), true);
  const r = await apiPost('/chat', { message: text });
  if (!r.json) { bubble('<span class="bad">no answer</span>', false); return; }
  if (r.json.answer) renderAnswer(r.json.answer);
  if (r.json.card) renderCard(r.json.card);
}

async function loadChat() {
  const h = await api(scope('/chat'));
  $('log').innerHTML = '';
  for (const e of h.events) {
    if (e.type === 'CHAT_MESSAGE') {
      bubble(esc(e.payload.message), true);
      bubble('<span class="dim">routed ' + esc(e.payload.intent) + ' — '
        + esc(e.payload.reason) + '</span>', false);
    } else if (e.type === 'CHAT_CARD_DECISION') {
      bubble('<span class="dim">decision: ' + esc(e.payload.decision)
        + (e.payload.missionId ? ' → ' + esc(e.payload.missionId) : '') + '</span>', false);
    }
  }
}

$('send').onclick = send;
$('say').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

function showHome(on) {
  $('home').style.display = on ? 'block' : 'none';
  for (const id of ['list', 'centre', 'chat']) $(id).style.display = on ? 'none' : '';
  $('crumb').style.display = on ? 'none' : '';
}

/**
 * The Projects home.
 *
 * Rendered only when the server was given a projects root. Without one it has
 * nothing true to show, so it says so rather than presenting an empty list as
 * if it were an answer.
 */
async function loadHome() {
  const d = await api('/projects');
  let h = '<h2>Projects</h2>';
  if (!d.projectsRoot) {
    h += '<p class="dim">This server was started inside a single project, so there is '
      + 'no projects root to list. Start it with <b>--projects &lt;dir&gt;</b> to enable '
      + 'this page.</p>';
    $('home').innerHTML = h;
    return;
  }
  h += '<p class="dim">' + esc(d.projectsRoot) + '</p><div id="plist"></div>';
  h += '<div class="newp"><b>New project</b>'
    + '<p class="dim">Paste a git URL to clone, or describe what to build. '
    + 'Nothing is created until you approve a card.</p>'
    + '<div class="ask"><input id="newmsg" placeholder="https://github.com/owner/repo — or describe what to build…">'
    + '<button id="newgo">continue</button></div><div id="newcard"></div></div>';
  $('home').innerHTML = h;

  const list = $('plist');
  if (!d.projects.length) {
    list.innerHTML = '<p class="dim">No initialised projects under this root yet.</p>';
  }
  for (const p of d.projects) {
    const el = document.createElement('div');
    el.className = 'p';
    el.innerHTML = '<b>' + esc(p.slug) + '</b>'
      + '<span class="dim">' + esc(p.adapter) + '</span>'
      + '<span>' + p.missions + ' mission(s)</span>'
      + '<span class="dim">' + esc(p.lastActivity ? p.lastActivity.slice(0, 16).replace('T', ' ') : 'no activity') + '</span>';
    el.onclick = () => openProject(p.slug, p.projectId, p.root);
    list.appendChild(el);
  }
  $('newgo').onclick = draftProject;
  $('newmsg').addEventListener('keydown', (e) => { if (e.key === 'Enter') draftProject(); });
}

async function draftProject() {
  const msg = $('newmsg').value.trim();
  if (!msg) return;
  const r = await apiPost('/projects/draft', { message: msg });
  const c = r.json && r.json.card;
  if (!c) { $('newcard').innerHTML = '<p class="bad">' + esc(JSON.stringify(r.json)) + '</p>'; return; }
  const d = document.createElement('div');
  d.className = 'card';
  let h = '<h3>' + esc(r.json.route) + '</h3>'
    + '<p class="dim">' + esc(r.json.decision.reason) + '</p>'
    + '<p><b>Source:</b> ' + esc(c.source) + '<br><b>Target:</b> ' + esc(c.targetPath) + '</p>'
    + '<b>What happens next</b><ol>'
    + c.whatHappensNext.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol>';
  for (const w of c.warnings) h += '<p class="warn">' + esc(w) + '</p>';
  h += '<p class="dim">' + esc(c.costExpectation) + '</p><div class="acts"></div>';
  d.innerHTML = h;
  const acts = d.querySelector('.acts');
  for (const a of c.actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = async () => {
      for (const x of d.querySelectorAll('button')) x.disabled = true;
      const res = await apiPost('/projects/decide',
        { card: c, cardDigest: c.digest, decision: a.id === 'rename' ? 'cancel' : a.id });
      $('newcard').innerHTML = '<p class="dim">' + esc(JSON.stringify(res.json).slice(0, 300)) + '</p>';
      await loadHome();
    };
    acts.appendChild(b);
  }
  $('newcard').innerHTML = '';
  $('newcard').appendChild(d);
}

function openProject(slug, projectId, root) {
  PROJECT = slug;
  SEL = null;
  $('proj').textContent = projectId + '  ' + root;
  showHome(false);
  $('detail').innerHTML = '<p class="dim">Select a mission.</p>';
  loadList(); loadChat(); connectStream();
}

$('crumb').onclick = () => {
  PROJECT = null; SEL = null;
  if (ES) { ES.close(); ES = null; }
  $('proj').textContent = '';
  showHome(true); loadHome();
};

$('go').onclick = async () => {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) return;
  try {
    const p = await api('/project');
    const projects = await api('/projects');
    if (projects.projectsRoot) {
      // A projects root exists, so the honest landing page is the list of
      // projects rather than whichever one the service happens to sit in.
      showHome(true);
      await loadHome();
      // The home is a live view too. Without this the status read "offline"
      // for as long as you stayed on it, while the server was perfectly fine —
      // an indicator that lies in the safe-looking direction is still lying.
      connectStream();
      return;
    }
    $('proj').textContent = p.projectId + '  ' + p.root;
    showHome(false);
    await loadList();
    await loadChat();
    connectStream();
  } catch (e) { /* the status line already says what happened */ }
};
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
</script>
</body>
</html>`;
