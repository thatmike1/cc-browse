import {
  $, $$, ago, axisTicks, dayLabel, esc, fmtCost, fmtDur, fmtTokens, hhmm, md,
  shortProj, tickLabel, toast,
} from './helpers.js';
import { show, state, ui } from './state.js';
import { closeAllPops, paintActive } from './list.js';

const convoEl = $('#convo');


function applyToggles() {
  $$('.tgl[data-k]').forEach((b) => b.classList.toggle('on', show[b.dataset.k]));
  $('#t-reader').classList.toggle('on', !show.thinking && !show.tool && !show.tool_result);
  $$('.ev', convoEl).forEach((el) => {
    const k = el.dataset.kind;
    if (k in show) el.classList.toggle('hidden', !show[k]);
  });
}

$$('.tgl[data-k]').forEach((b) =>
  b.addEventListener('click', () => { show[b.dataset.k] = !show[b.dataset.k]; applyToggles(); refreshNav(true); }));
$('#t-reader').addEventListener('click', () => {
  Object.keys(show).forEach((k) => (show[k] = false));
  applyToggles(); refreshNav(true);
});

function eventsHtml(events, { stamps = true } = {}) {
  let lastDay = null, html = '';
  for (const e of events) {
    const day = (e.ts || '').slice(0, 10);
    if (stamps && day && day !== lastDay) {
      html += `<div class="stamp">${dayLabel(day)}</div>`;
      lastDay = day;
    }
    // an inbound message names the session that sent it; the badge is what keeps
    // it from reading as something the user typed
    const who = e.kind === 'agent_message'
      ? `${esc(e.sender || 'another session')}<span class="badge">agent message</span>`
      : e.kind === 'text' ? (e.role === 'user' ? 'you' : 'claude') : e.kind.replace('_', ' ');
    const cls = e.kind === 'text' ? e.role : e.kind;
    html += `<div class="ev ${cls}" data-kind="${e.kind}">
      <div class="who">${who}</div><div class="body">${md(e.text)}</div></div>`;
  }
  return html;
}

/* ---------------- match cycling + find in conversation ---------------- */

// one match model serves both arrivals: opening a search result and the find
// bar. `marks` is every hit in the DOM, `nav` the subset that is not currently
// collapsed behind a reader toggle — only those can be scrolled to.
let marks = [], mIdx = -1, findSource = null, capped = false;
const findEl = $('#findbar'), fqEl = $('#fq'), fcountEl = $('#fcount'), frevealEl = $('#freveal');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clearMarks() {
  for (const m of $$('mark.hit', convoEl)) {
    const p = m.parentNode;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  }
  $$('.ev.semhit', convoEl).forEach((e) => e.classList.remove('semhit', 'cur'));
  marks = []; ui.nav = []; mIdx = -1; capped = false;
}

// walk only message bodies: role labels and day stamps are chrome, not content
function wrapMatches(re, cap = 2000) {
  const out = [];
  capped = false;
  for (const body of $$('.ev .body', convoEl)) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n; (n = walker.nextNode());) if (n.nodeValue) nodes.push(n);
    for (const node of nodes) {
      re.lastIndex = 0;
      if (!re.test(node.nodeValue)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(node.nodeValue))) {
        if (!m[0]) { re.lastIndex++; continue; }
        frag.append(node.nodeValue.slice(last, m.index));
        const el = document.createElement('mark');
        el.className = 'hit';
        el.textContent = m[0];
        frag.append(el);
        out.push(el);
        last = m.index + m[0].length;
        if (out.length >= cap) break;
      }
      frag.append(node.nodeValue.slice(last));
      node.parentNode.replaceChild(frag, node);
      if (out.length >= cap) { capped = true; return out; }
    }
  }
  return out;
}

// semantic queries are descriptions, not terms, so there is nothing literal to
// highlight. The server hands back the message that matched (`snip`); find that
// message in the transcript and mark the whole thing.
function markSemantic(snip) {
  if (!snip) return [];
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const key = norm(snip).replace(/…+$/, '');
  if (key.length < 12) return [];
  const evs = $$('.ev', convoEl);
  const hit = evs.find((e) => norm(e.querySelector('.body').textContent).startsWith(key))
    || evs.find((e) => norm(e.querySelector('.body').textContent).includes(key));
  if (!hit) return [];
  hit.classList.add('semhit');
  return [hit];
}

function refreshNav(keepCurrent) {
  const cur = keepCurrent ? ui.nav[mIdx] : null;
  ui.nav = marks.filter((m) => !m.closest('.ev').classList.contains('hidden'));
  const i = cur ? ui.nav.indexOf(cur) : -1;
  mIdx = i >= 0 ? i : (ui.nav.length ? Math.min(Math.max(mIdx, 0), ui.nav.length - 1) : -1);
  if (mIdx >= 0) {
    marks.forEach((m) => m.classList.remove('cur'));
    ui.nav[mIdx].classList.add('cur');
  }
  renderCount();
}

function renderCount() {
  const hidden = marks.length - ui.nav.length;
  if (!marks.length) {
    fcountEl.textContent = (fqEl.value.trim() || findSource === 'semantic') ? 'no matches' : '';
  } else if (findSource === 'semantic' && ui.nav.length === 1) {
    fcountEl.textContent = 'best match';
  } else {
    const n = ui.nav.length + (capped ? '+' : '');  // marking stops at 2000 hits
    fcountEl.textContent = ui.nav.length ? `${mIdx + 1} of ${n}` : '0 of 0';
  }
  frevealEl.hidden = !hidden;
  if (hidden) frevealEl.textContent = `${hidden} hidden — show`;
}

export function gotoMatch(delta, smooth = true) {
  if (!ui.nav.length) return;
  mIdx = (mIdx + delta + ui.nav.length) % ui.nav.length;
  marks.forEach((m) => m.classList.remove('cur'));
  const el = ui.nav[mIdx];
  el.classList.add('cur');
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  renderCount();
}

frevealEl.addEventListener('click', () => {
  for (const m of marks) {
    const k = m.closest('.ev').dataset.kind;
    if (k in show) show[k] = true;
  }
  applyToggles();
  refreshNav(true);
});

function runFind(q) {
  clearMarks();
  findSource = 'find';
  const term = q.trim();
  if (term.length >= 1) marks = wrapMatches(new RegExp(escRe(term), 'gi'));
  refreshNav(false);
  if (ui.nav.length) { mIdx = -1; gotoMatch(1, false); }
}

export function openFind() {
  if (!ui.activeId) return;
  findEl.hidden = false;
  fqEl.focus();
  fqEl.select();
}

export function closeFind() {
  findEl.hidden = true;
  fqEl.value = '';
  clearMarks();
  findSource = null;
  renderCount();
}

let ft;
fqEl.addEventListener('input', () => {
  clearTimeout(ft);
  ft = setTimeout(() => runFind(fqEl.value), 170);
});
fqEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else return;
  e.stopPropagation();
});
$('#fnext').onclick = () => gotoMatch(1);
$('#fprev').onclick = () => gotoMatch(-1);
$('#fclose').onclick = () => closeFind();

/* ---------------- subagent transcripts ---------------- */

function subsHtml(subs) {
  if (!subs || !subs.length) return '';
  return `<div class="subs">
    <div class="subs-h">${subs.length} subagent transcript${subs.length > 1 ? 's' : ''}</div>
    ${subs.map((s) => `<div class="sub" data-sub="${esc(s.id)}">
      <button class="sub-t">
        <svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>
        <span class="name">${esc(s.title || 'subagent')}</span>
        <span class="n">${s.n_events} events${s.tokens ? ' · ' + fmtTokens(s.tokens) + (s.cost != null ? ' · ' + fmtCost(s.cost) : '') : ''}</span>
      </button>
      <div class="sub-body" hidden></div>
    </div>`).join('')}
  </div>`;
}

// open/closed is decided synchronously so a second click during the fetch
// cannot leave the panel and its class disagreeing
convoEl.addEventListener('click', (e) => {
  const t = e.target.closest('.sub-t');
  if (!t) return;
  const sub = t.closest('.sub'), body = $('.sub-body', sub);
  const opening = !sub.classList.contains('open');
  sub.classList.toggle('open', opening);
  body.hidden = !opening;
  if (opening) loadSub(sub, body);
  else refreshNav(true);
});

async function loadSub(sub, body) {
  if (body.dataset.loaded || body.dataset.loading) { refreshNav(true); return; }
  body.dataset.loading = '1';
  body.innerHTML = '<div class="skeleton"><div style="width:60%"></div><div style="width:88%"></div></div>';
  try {
    const d = await fetch('/api/subagent/' + encodeURIComponent(sub.dataset.sub)).then((x) => x.json());
    if (d.error || !d.events) throw new Error(d.error || 'no events');
    body.innerHTML = eventsHtml(d.events, { stamps: false });
    body.dataset.loaded = '1';
  } catch (err) {
    body.innerHTML = '<div class="menu-empty">could not load this transcript</div>';
  }
  delete body.dataset.loading;
  applyToggles();
  // newly revealed text has to join the current match set
  if (findSource === 'find' && fqEl.value.trim()) runFind(fqEl.value);
  else refreshNav(true);
}

/* ---------------- tokens, cost and the lane view ---------------- */

// the ui owns three voices (accent / user / assistant); model colours reuse
// them rather than introducing hues, and the label is the family, not the id
function modelLabel(id) {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)/.exec(id || '');
  if (!m) return id ? 'unknown' : '';
  // only fable and mythos carry their version — the rest read as one family
  return m[1] === 'fable' || m[1] === 'mythos' ? `${m[1]}-${m[2]}` : m[1];
}

function modelColor(id) {
  const fam = (modelLabel(id) || '').split('-')[0];
  if (fam === 'fable' || fam === 'mythos') return 'var(--accent)';
  if (fam === 'opus') return 'var(--user)';
  if (fam === 'haiku') return 'var(--assistant)';
  if (fam === 'sonnet') return 'var(--dim)';
  return 'var(--faint)';
}

// a sidecar records the model it was spawned with, and the lead has no sidecar
// at all — the transcript's own usage is the only thing that always knows
function dominantModel(usage, fallback) {
  let best = fallback || '', out = -1;
  for (const [m, b] of Object.entries(usage || {})) {
    if ((b.out || 0) > out) { out = b.out || 0; best = m; }
  }
  return best;
}

function laneRows(d) {
  const meta = d.meta || {};
  const lead = {
    id: null, name: 'lead', desc: '', depth: 0,
    model: dominantModel(meta.usage, ''),
    start: meta.created, end: meta.modified, active: !!meta.active,
    events: (meta.n_user || 0) + (meta.n_assistant || 0),
    tokens: meta.tokens || 0, cost: meta.cost,
  };
  const subs = (d.subagents || []).map((s) => ({
    id: s.id, name: s.agent_name || s.agent_type || 'subagent',
    desc: s.description || s.title || '', depth: s.spawn_depth || 0,
    model: dominantModel(s.usage, s.model),
    start: s.started, end: s.ended, active: !!s.active,
    events: s.n_events, tokens: s.tokens || 0, cost: s.cost,
  }));
  return [lead, ...subs];
}

function lanesHtml(d) {
  const rows = laneRows(d);
  const now = Date.now();
  const starts = rows.map((r) => +new Date(r.start)).filter((n) => !isNaN(n));
  if (!starts.length) return '<div class="placeholder"><div class="hint">no timestamps to lay out</div></div>';
  const t0 = Math.min(...starts);
  let t1 = Math.max(...rows.map((r) => (r.active ? now : +new Date(r.end) || t0)));
  if (t1 <= t0) t1 = t0 + 60000;
  const span = t1 - t0;
  const ticks = axisTicks(t0, t1);
  const grid = ticks.map((k) => `<i class="grid" style="left:${k.pct}%"></i>`).join('');

  // every agent's own wall time added up — the parallelism the lanes show
  const agentMs = rows.slice(1).reduce(
    (a, r) => a + Math.max(0, (r.active ? now : +new Date(r.end)) - +new Date(r.start)), 0);
  const seen = [];
  for (const r of rows) {
    const label = modelLabel(r.model);
    if (label && !seen.some((x) => x.label === label)) seen.push({ label, color: modelColor(r.model) });
  }
  const stamp = d.indexed_at ? `figures updated ${ago(d.indexed_at)}` : '';

  const lanes = rows.map((r, i) => {
    const start = +new Date(r.start);
    const end = r.active ? now : (+new Date(r.end) || start);
    const left = ((start - t0) / span) * 100;
    const width = Math.max(((end - start) / span) * 100, 0.4);
    const color = modelColor(r.model), label = modelLabel(r.model);
    const fig = [fmtDur(end - start), r.tokens ? fmtTokens(r.tokens) : null,
                 r.cost != null ? fmtCost(r.cost) : null].filter(Boolean).join(' · ');
    // the figure flips inside the bar's right end rather than off the track
    const inside = left + width > 78;
    const figStyle = inside ? `right:${Math.max(100 - left - width, 0)}%;padding-right:10px`
                            : `left:${left + width}%;padding-left:10px`;
    return `<div class="lane ${i === 0 ? 'lead' : ''}" data-lane="${i}" ${r.id ? `data-sub="${esc(r.id)}"` : ''} style="--m:${color}">
      <div class="lane-name" style="padding-left:${r.depth * 14}px">
        <span class="who">${esc(r.name)}${r.desc ? ' · ' + esc(r.desc) : ''}</span>
        ${label ? `<span class="mchip">${esc(label)}</span>` : ''}
      </div>
      <div class="lane-track">${grid}
        <div class="lane-bar ${r.active ? 'live' : ''}" style="left:${left}%;width:${width}%"></div>
        <span class="lane-fig ${inside ? 'inside' : ''}" style="${figStyle}">${fig}</span>
      </div>
    </div>`;
  }).join('');

  return `<div class="lanes-h">
      <span><b>${rows.length}</b> agent${rows.length > 1 ? 's' : ''}</span>
      <span class="sep">·</span><span><b>${fmtDur(span)}</b> wall clock</span>
      ${agentMs ? `<span class="sep">·</span><span><b>${fmtDur(agentMs)}</b> agent time</span>` : ''}
      ${stamp ? `<span class="sep">·</span><span>${esc(stamp)}</span>` : ''}
      <span class="legend">${seen.map((x) => `<span style="--m:${x.color}"><i></i>${esc(x.label)}</span>`).join('')}</span>
    </div>
    <div class="lanes-body">
      <div class="lane-axis">${ticks.map((k) => `<span style="left:${k.pct}%">${tickLabel(k.t, k.step)}</span>`).join('')}</div>
      ${lanes}
    </div>`;
}

/* ---- the detail pane's two views ---- */

let detail = null, laneTimer = null;

function showView(v) {
  const lanes = v === 'lanes';
  $$('#dview button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'lanes') === lanes));
  $('#lanes').hidden = !lanes;
  convoEl.hidden = lanes;
  $('#jump').style.display = lanes ? 'none' : 'flex';
  if (lanes) { findEl.hidden = true; hideTip(); }
  if (lanes) renderLanes();
  scheduleLanePoll();
}

$('#dview').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) showView(b.dataset.v);
});

function renderLanes() {
  if (detail) $('#lanes').innerHTML = lanesHtml(detail);
}

// polling exists for the open right edge; it stops the moment nothing is live
// or the reader moves to another session, and never touches #convo
function scheduleLanePoll() {
  clearTimeout(laneTimer);
  laneTimer = null;
  if (!detail || $('#lanes').hidden) return;
  if (!laneRows(detail).some((r) => r.active)) return;
  const id = ui.activeId;
  laneTimer = setTimeout(async () => {
    try {
      const d = await fetch('/api/session/' + encodeURIComponent(id)).then((x) => x.json());
      if (ui.activeId !== id || d.error || !d.meta) return;
      detail = d;
      renderUsageChip(d);
      renderLanes();
    } catch (e) { return; }
    scheduleLanePoll();
  }, 15000);
}

/* ---- hover tooltip + click through to the transcript ---- */

export const tipEl = $('#lanetip');

export function hideTip() { tipEl.hidden = true; }

$('#lanes').addEventListener('mousemove', (e) => {
  const lane = e.target.closest('.lane');
  if (!lane) { hideTip(); return; }
  const r = laneRows(detail)[+lane.dataset.lane];
  if (!r) { hideTip(); return; }
  const start = +new Date(r.start), end = r.active ? Date.now() : (+new Date(r.end) || start);
  tipEl.innerHTML = `<div class="t">${esc(r.desc || r.name)}</div>
    <div class="s">${esc([modelLabel(r.model), r.depth ? 'spawn depth ' + r.depth : '', r.events + ' events'].filter(Boolean).join(' · '))}</div>
    <dl>
      <dt>ran</dt><dd>${hhmm(start)} → ${r.active ? 'now' : hhmm(end)} · ${fmtDur(end - start)}</dd>
      <dt>tokens</dt><dd>${fmtTokens(r.tokens)}</dd>
      <dt>cost</dt><dd>${r.cost == null ? '—' : fmtCost(r.cost)}</dd>
    </dl>
    <div class="open">click the lane to open its transcript</div>`;
  tipEl.hidden = false;
  const box = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(e.clientX + 16, window.innerWidth - box.width - 12) + 'px';
  tipEl.style.top = Math.min(e.clientY + 16, window.innerHeight - box.height - 12) + 'px';
});
$('#lanes').addEventListener('mouseleave', hideTip);

$('#lanes').addEventListener('click', (e) => {
  const lane = e.target.closest('.lane');
  if (!lane) return;
  hideTip();
  showView('transcript');
  const id = lane.dataset.sub;
  if (!id) { convoEl.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const sub = $(`.sub[data-sub="${id}"]`, convoEl);
  if (!sub) return;
  if (!sub.classList.contains('open')) $('.sub-t', sub).click();
  sub.scrollIntoView({ block: 'start', behavior: 'smooth' });
  sub.classList.remove('landed');
  void sub.offsetWidth;  // restart the animation when the same lane is clicked twice
  sub.classList.add('landed');
});

/* ---- the cost chip and its breakdown ---- */

function renderUsageChip(d) {
  const run = d.subagents && d.subagents.length;
  const usage = run ? d.run_usage : d.meta.usage;
  const tokens = run ? d.run_tokens : d.meta.tokens;
  const cost = run ? d.run_cost : d.meta.cost;
  const pop = $('#dusage');
  pop.hidden = !tokens;
  if (!tokens) { pop.classList.remove('open'); return; }
  $('#dcost').textContent = `${fmtTokens(tokens)} tok${cost != null ? ' · ' + fmtCost(cost) : ''}`;

  const KINDS = [['in', 'input'], ['cw1h', 'cache write 1h'], ['cw5m', 'cache write 5m'],
                 ['cr', 'cache read'], ['out', 'output']];
  const sums = {};
  const models = Object.entries(usage || {}).map(([m, b]) => {
    for (const [k] of KINDS) sums[k] = (sums[k] || 0) + (b[k] || 0);
    const t = KINDS.reduce((a, [k]) => a + (b[k] || 0), 0);
    return `<tr><td><span class="mchip" style="--m:${modelColor(m)}">${esc(modelLabel(m) || 'unknown')}</span></td>
      <td class="n">${fmtTokens(t)}</td></tr>`;
  }).join('');
  $('#dbreak').innerHTML = `<table class="ubreak">
      ${models}<tr class="rule"><td colspan="2"></td></tr>
      ${KINDS.map(([k, label]) => `<tr class="kind"><td>${label}</td><td class="n">${fmtTokens(sums[k] || 0)}</td></tr>`).join('')}
      <tr class="rule"><td colspan="2"></td></tr>
      <tr><td>${run ? 'lead + ' + d.subagents.length + ' agents' : 'this conversation'}</td><td class="n">${cost == null ? '—' : fmtCost(cost)}</td></tr>
    </table>
    <div class="unote">notional, at published list prices. a subscription bills against usage limits, not per token.</div>`;
}

$('#dcost').addEventListener('click', () => {
  const pop = $('#dusage');
  const opening = !pop.classList.contains('open');
  closeAllPops(pop);
  pop.classList.toggle('open', opening);
});

export async function openSession(id, want = 'transcript') {
  ui.activeId = id;
  document.body.classList.add('reading');
  paintActive();
  clearMarks();
  findEl.hidden = true; fqEl.value = ''; findSource = null;
  $('#dempty').hidden = true;
  $('#dhead').hidden = false;
  detail = null; clearTimeout(laneTimer); laneTimer = null;
  $('#dusage').hidden = true; $('#dview').hidden = true; hideTip();
  $('#creader').hidden = false;
  convoEl.innerHTML = '<div class="wrap skeleton">' + '<div style="width:35%"></div><div style="width:92%"></div><div style="width:76%"></div>'.repeat(5) + '</div>';

  const d = await fetch('/api/session/' + id).then((x) => x.json());
  if (ui.activeId !== id) return;  // a faster click won the race
  if (d.error) { convoEl.innerHTML = `<div class="placeholder">${esc(d.error)}</div>`; return; }

  $('#dtitle').textContent = d.meta.title || '(empty)';
  $('#dmeta').textContent =
    `${shortProj(d.meta.project)}${d.meta.branch ? ' · ' + d.meta.branch : ''} · ${d.meta.n_user + d.meta.n_assistant} msgs · ${d.meta.n_tool} tool calls`;
  const cmd = 'claude --resume ' + id;
  $('#dresume').textContent = cmd;
  $('#dresume').onclick = () => { navigator.clipboard.writeText(cmd); toast('resume command copied'); };

  convoEl.innerHTML = '<div class="wrap">' + subsHtml(d.subagents) + eventsHtml(d.events) + '</div>';
  applyToggles();
  $('#jump').style.display = 'flex';
  detail = d;
  renderUsageChip(d);
  // lanes only mean anything once work was delegated
  const hasLanes = !!(d.subagents && d.subagents.length);
  $('#dview').hidden = !hasLanes;
  showView(want === 'lanes' && hasLanes ? 'lanes' : 'transcript');

  // arriving from a search means the tail is the wrong place to land
  if (state.q && state.mode === 'content') {
    const terms = state.q.match(/[\w#@./-]{2,}/g);
    if (terms) {
      // fts5 splits on punctuation and underscores, so "SCHEMA_VERSION" matched
      // a message saying "schema" and "version". Mark the pieces too, or the
      // hit the server found is invisible here.
      const parts = new Set();
      for (const t of terms) {
        parts.add(t);
        for (const p of t.split(/[^A-Za-z0-9]+/)) if (p.length >= 2) parts.add(p);
      }
      findSource = 'search';
      const alt = [...parts].sort((a, b) => b.length - a.length).map(escRe).join('|');
      marks = wrapMatches(new RegExp(alt, 'gi'));
    }
  } else if (state.q && state.mode === 'semantic') {
    findSource = 'semantic';
    marks = markSemantic((ui.sessions.find((s) => s.session_id === id) || {}).snip);
  }
  if (findSource === 'search') fqEl.value = state.q;
  // arriving from a search always shows the bar, even on zero matches — landing
  // at the tail with no explanation is what made this confusing in the first place
  if (findSource) findEl.hidden = false;
  refreshNav(false);

  if (ui.nav.length) {
    mIdx = -1;
    gotoMatch(1, false);
  } else {
    // land at the end of the conversation — the tail is what you came for
    convoEl.scrollTop = convoEl.scrollHeight;
    renderCount();
  }
}

$('#jtop').onclick = () => convoEl.scrollTo({ top: 0, behavior: 'smooth' });
$('#jbot').onclick = () => convoEl.scrollTo({ top: convoEl.scrollHeight, behavior: 'smooth' });
