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
  main { display:grid; grid-template-columns:minmax(240px,1fr) 2.4fr; gap:0;
         height:calc(100vh - 49px) }
  #list, #detail { overflow:auto; padding:12px 16px }
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
</style>
</head>
<body>
<header>
  <h1>Zeus Control Center</h1>
  <span class="dim" id="proj">—</span>
  <span style="flex:1"></span>
  <input id="tok" type="password" placeholder="bearer token (printed once at startup)">
  <button id="go">connect</button>
  <span id="conn" class="dim">offline</span>
</header>
<main>
  <div id="list"><p class="dim">Enter the token to connect.</p></div>
  <div id="detail"><p class="dim">Select a mission.</p></div>
</main>
<script>
// The token lives in memory only. Persisting it to localStorage would put a
// credential that can spend money into the most-read storage in the browser.
let TOKEN = '', SEL = null, ES = null, LAST = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

async function api(p) {
  const r = await fetch('/api' + p, { headers: { authorization: 'Bearer ' + TOKEN } });
  if (r.status === 401) { $('conn').textContent = 'unauthorized'; throw new Error('401'); }
  return r.json();
}

async function loadList() {
  const ms = await api('/missions');
  $('list').innerHTML = ms.length ? '' : '<p class="dim">No missions yet.</p>';
  for (const m of ms) {
    const d = document.createElement('div');
    d.className = 'm' + (m.missionId === SEL ? ' sel' : '');
    const state = m.terminated ? m.achievement + ' / ' + m.terminationReason : m.phase;
    d.innerHTML = '<b>' + esc(m.missionId.split('/').pop()) + '</b> '
      + '<span class="phase">' + esc(state) + '</span>'
      + '<span class="goal">' + esc(m.goal) + '</span>';
    d.onclick = () => { SEL = m.missionId; loadList(); loadDetail(); };
    $('list').appendChild(d);
  }
}

async function loadDetail() {
  if (!SEL) return;
  const m = await api('/missions/' + encodeURIComponent(SEL.split('/').pop()));
  const rep = await api('/missions/' + encodeURIComponent(SEL.split('/').pop()) + '/report');
  const o = m.oracle;
  let h = '<h2>' + esc(m.missionId) + '</h2><p>' + esc(m.goal) + '</p>';
  h += '<table><tr><th>phase</th><td><span class="phase">' + esc(m.phase) + '</span></td></tr>'
    + '<tr><th>plan</th><td>' + (m.acceptedPlanVersion == null ? 'none accepted'
      : 'v' + m.acceptedPlanVersion + (m.acceptedPlan ? '' : ' (invalidated)')) + '</td></tr>'
    + '<tr><th>ratchet</th><td>' + esc(m.ratchetSha ? m.ratchetSha.slice(0,12) : 'never advanced') + '</td></tr>'
    + '<tr><th>cost</th><td>$' + (m.cost.totalUsd || 0).toFixed(4)
    + (m.cost.isLowerBound ? ' <span class="warn">(a lower bound — '
        + m.cost.unmeteredCalls + ' call(s) reported no price)</span>' : '')
    + '<br><span class="dim">' + esc(JSON.stringify(m.cost.byPhase)) + '</span></td></tr></table>';

  if (o) {
    h += '<h2>criteria</h2><table>';
    for (const c of o.criteria) {
      const out = m.criterionOutcomes[c.criterionId] || 'UNEVALUATED';
      h += '<tr><td>' + esc(c.criterionId.split('/').pop()) + '</td>'
        + '<td class="' + esc(out) + '">' + esc(out) + '</td>'
        + '<td class="dim">' + esc(c.statement) + '</td></tr>';
    }
    h += '</table>';
  }
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
  h += '<h2>live events</h2><div id="feed"></div>';
  $('detail').innerHTML = h;
}

function connectStream() {
  if (ES) ES.close();
  // EventSource cannot set headers, so the stream takes the same token in the
  // query string — same secret, same check.
  let u = '/api/events/stream?token=' + encodeURIComponent(TOKEN);
  if (LAST) u += '&lastEventId=' + encodeURIComponent(LAST);
  ES = new EventSource(u);
  ES.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'ok'; };
  ES.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'warn'; };
  ES.onmessage = (ev) => {
    LAST = ev.lastEventId || LAST;
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    const feed = $('feed');
    if (feed && SEL && (e.taskId === SEL || String(e.taskId).startsWith(SEL))) {
      const row = document.createElement('div');
      row.innerHTML = '<span class="dim">' + esc(e.ts.slice(11,19)) + '</span> ' + esc(e.type);
      feed.prepend(row);
    }
    loadList();
    if (SEL) loadDetail();
  };
}

$('go').onclick = async () => {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) return;
  try {
    const p = await api('/project');
    $('proj').textContent = p.projectId + '  ' + p.root;
    await loadList();
    connectStream();
  } catch (e) { /* the status line already says what happened */ }
};
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
</script>
</body>
</html>`;
