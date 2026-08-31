import { $, $$, ago, dayLabel, esc, fmtCost, highlight, shortProj, unmark } from './helpers.js';
import { state, ui } from './state.js';
import { openSession } from './detail.js';
import { loadTimeline, setView } from './timeline.js';

const listEl = $('#list');

let offset = 0, total = 0, loading = false, done = false, queuedReset = false;
let facets = { projects: [], branches: [] };
// never swap the list out from under a read — just offer it
let pendingRefresh = null;
let fingerprint = null, statusOff = false;
// a blended response arrives whole, so the chips can narrow it without asking
// again: `hits` is everything that came back, `only` is the chip in force
let blend = null, hits = [], only = '';

const SORTS = [
  ['recent', 'newest first'], ['oldest', 'oldest first'],
  ['longest', 'longest first'], ['shortest', 'shortest first'],
  ['costly', 'most expensive'], ['cheapest', 'cheapest first'],
  ['relevance', 'best match'],
];

const MODE_LABEL = { meta: 'titles', content: 'full text', semantic: 'meaning' };
// the label a row wears, which is not quite the chip's: a row says what matched
const HIT_LABEL = { meta: 'title', content: 'full text', semantic: 'meaning' };


function hitHtml(s) {
  if (!s.hit_mode) return '';
  const pct = Math.round((s.score || 0) * 100);
  return `<div class="hit ${esc(s.hit_mode)}">
    <span class="m">${HIT_LABEL[s.hit_mode] || s.hit_mode}</span>
    <span class="bar"><i style="width:${pct}%"></i></span>
    <span class="sc">${(s.score || 0).toFixed(2)}</span>
  </div>`;
}

// the badge may only promise marks the reader will actually show. a match that
// lives in a subagent transcript is not in this conversation's reader, so it is
// named as such rather than counted into a number that opens to "no matches"
function hitsHtml(s) {
  const n = s.n_hits || 0, sub = s.n_sub || 0;
  if (!n && !sub) return '';
  if (!n) {
    return `<span class="hits sub" title="every match is inside a subagent transcript, which this conversation's reader does not show">${sub} in subagent</span>`;
  }
  return `<span class="hits">${n} hit${n > 1 ? 's' : ''}${sub
    ? `<i title="matched inside a subagent transcript, which this reader does not show"> · ${sub} in subagent</i>` : ''}</span>`;
}

function rowHtml(s, i) {
  const hit = s.snip
    ? `<div class="snip">${unmark(s.snip)}</div>`
    : (() => {
        const t = s.tail && s.tail.length ? s.tail[s.tail.length - 1] : null;
        // a tail line carrying a sender came from another session, not from here
        const who = t && t.sender ? esc(t.sender) : (t && t.role === 'user' ? 'you' : 'claude');
        return t ? `<div class="snip"><b class="who">${who}:</b> ${esc(t.text.slice(0, 220))}</div>` : '';
      })();
  // a title hit is the only one whose terms are actually in the title
  const title = s.hit_mode === 'meta' && state.q
    ? highlight(esc(s.title || '(empty)'), state.q) : esc(s.title || '(empty)');
  return `<div class="row ${s.hit_mode ? 'blended ' + esc(s.hit_mode) : ''}" data-i="${i}" data-id="${s.session_id}">
    ${hitHtml(s)}
    <div class="title ${s.titled ? '' : 'untitled'}">${title}</div>
    <div class="meta">
      <span class="proj">${esc(shortProj(s.project))}</span>
      ${s.branch ? `<span class="sep">·</span><span class="branch">${esc(s.branch)}</span>` : ''}
      <span class="sep">·</span><span>${s.n_user + s.n_assistant} msgs</span>
      <span class="sep">·</span><span>${ago(s.modified)}</span>
      ${s.n_agents ? `<span class="sep">·</span><span class="lanes" title="${s.n_agents} agent lane${s.n_agents > 1 ? 's' : ''} ran in this conversation">${s.n_agents} lane${s.n_agents > 1 ? 's' : ''}</span>` : ''}
      ${s.via_subagent ? '<span class="via" title="matched inside a subagent transcript, not the conversation itself">via subagent</span>' : ''}
      ${hitsHtml(s)}
      ${s.cost != null ? `<span class="cost" title="notional cost at list prices">${fmtCost(s.cost)}</span>` : ''}
    </div>${hit}</div>`;
}

function renderChunk(items, startIdx) {
  let html = '';
  let lastDay = startIdx > 0 ? ui.sessions[startIdx - 1].day : null;
  const grouped = state.sort === 'recent' || state.sort === 'oldest';
  items.forEach((s, k) => {
    const i = startIdx + k;
    if (grouped && s.day !== lastDay) {
      html += `<div class="daygroup">${dayLabel(s.day)}</div>`;
      lastDay = s.day;
    }
    html += rowHtml(s, i);
  });
  listEl.insertAdjacentHTML('beforeend', html);
  paintActive();
}

export function paintActive() {
  $$('.row', listEl).forEach((r) => {
    r.classList.toggle('active', r.dataset.id === ui.activeId);
    r.classList.toggle('cursor', +r.dataset.i === ui.cursor);
  });
}

function empty() {
  listEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">nothing matches${state.q ? ` “${esc(state.q)}”` : ''}${only ? ` in ${MODE_LABEL[only]}` : ''}</div></div>`;
}

// the chip narrows what came back; it never decides what runs, so this repaints
// from the response already in hand
function narrow() {
  ui.sessions = only ? hits.filter((s) => (s.hit_modes || []).includes(only)) : hits;
  ui.cursor = -1;
  offset = ui.sessions.length;
  listEl.innerHTML = '';
  if (!ui.sessions.length) empty(); else renderChunk(ui.sessions, 0);
  renderModes();
}

export async function load(reset) {
  if (loading) {
    // a reset asked for while a page is in flight is a *different* query, and
    // dropping it silently is how the refresh pill used to clear itself without
    // ever loading anything. remember it and run it when the page lands.
    if (reset) queuedReset = true;
    return;
  }
  if (done && !reset) return;
  loading = true;
  try {
    // a blended list is only worth reading by best match, and a list with no
    // query is only worth reading by recency — so the two defaults swap together
    if (state.q && state.sort === 'recent') { state.sort = 'relevance'; syncControls(); }
    else if (!state.q && state.sort === 'relevance') { state.sort = 'recent'; syncControls(); }
    if (reset) {
      offset = 0; ui.sessions = []; done = false; blend = null; hits = []; only = '';
      listEl.innerHTML = '<div class="skeleton">' + '<div style="width:70%"></div><div style="width:45%"></div><div style="width:88%"></div>'.repeat(4) + '</div>';
    }
    const p = new URLSearchParams({ ...state, offset, limit: 60 });
    let r;
    try {
      r = await fetch('/api/sessions?' + p).then((x) => x.json());
    } catch (e) { return; }
    // the answer belongs to a query nobody is waiting for any more
    if (queuedReset) return;
    if (reset) listEl.innerHTML = '';
    if (!r || !r.sessions) {  // the server answered with an error, not a page
      if (reset) listEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">${esc(r?.error || 'the server could not answer that')}</div></div>`;
      done = true; renderModes(); renderStats(); return;
    }
    total = r.total;
    if (r.modes) {
      // blended: every mode's hits arrive in one ranked list, so there is nothing
      // left to page — the chips work over what is already here
      blend = r; hits = r.sessions; done = true;
      narrow();
    } else {
      blend = null; hits = [];
      const start = ui.sessions.length;
      ui.sessions = ui.sessions.concat(r.sessions);
      offset += r.sessions.length;
      if (!r.sessions.length) done = true;
      if (!ui.sessions.length) empty(); else renderChunk(r.sessions, start);
      renderModes();
    }
    renderStats();
  } finally {
    loading = false;
    if (queuedReset) { queuedReset = false; load(true); }
  }
}

/* ---------------- search mode chips ---------------- */

function renderModes() {
  const box = $('#searchmodes'), meta = $('#qmeta');
  $('.search').classList.toggle('active', !!state.q);
  if (!blend) {
    box.hidden = true; box.innerHTML = ''; meta.textContent = '';
    return;
  }
  // past the cap the chips still count every match, so the bar has to say that
  // the list under them is only the top slice rather than the whole answer
  meta.textContent = blend.truncated
    ? `top ${blend.returned} of ${total.toLocaleString()} sessions · ${Math.round(blend.ms)} ms`
    : `${total.toLocaleString()} session${total === 1 ? '' : 's'} · ${Math.round(blend.ms)} ms`;
  const rows = Object.entries(blend.modes)
    .filter(([, m]) => m.ran)
    .sort((a, b) => b[1].n - a[1].n);
  box.hidden = false;
  box.innerHTML = '<span class="lead">narrow to</span>' + rows.map(([k, m]) =>
    `<button class="schip ${only === k ? 'on' : ''}" data-m="${k}" ${m.n ? '' : 'disabled'}>
      ${MODE_LABEL[k]} <b>${m.n}</b> <span class="ms">${m.ms} ms</span>
    </button>`).join('');
}

$('#searchmodes').addEventListener('click', (e) => {
  const b = e.target.closest('.schip');
  if (!b) return;
  only = only === b.dataset.m ? '' : b.dataset.m;
  narrow();
});

function renderStats() {
  const bits = [`<b>${total.toLocaleString()}</b> conversations`];
  if (facets.stats) bits.push(`<span class="sep">·</span><b>${facets.stats.messages.toLocaleString()}</b> messages indexed`);
  $('#stats').innerHTML = bits.join(' ') +
    (pendingRefresh
      ? `<span class="pill" style="border-color:var(--accent-dim);color:var(--accent)" id="refresh-pill">new conversations<button aria-label="load them">↻</button></span>`
      : '');
}

$('#stats').addEventListener('click', (e) => {
  if (e.target.closest('#refresh-pill')) {
    fingerprint = pendingRefresh.fingerprint;
    pendingRefresh = null;
    loadFacets();
    load(true);
  }
});

listEl.addEventListener('scroll', () => {
  if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 500) load(false);
});

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) { ui.cursor = +row.dataset.i; openSession(row.dataset.id); }
});

/* ---------------- sort ---------------- */

function setFilter(key, value) {
  state[key] = value;
  if (key === 'project') { state.branch = ''; loadFacets(); }
  syncControls();
  // project/branch also scope the timeline; the other filters are list-only,
  // and the live board is not filtered at all — it is everything that is running
  if (ui.view === 'live') return;
  if (ui.view !== 'list' && (key === 'project' || key === 'branch')) loadTimeline();
  else load(true);
}

export function syncControls() {
  $('#pop-sort .label').textContent = (SORTS.find((s) => s[0] === state.sort) || SORTS[0])[1];
  renderStats();
}

// popovers
export function closeAllPops(except) {
  $$('.pop').forEach((p) => { if (p !== except) p.classList.remove('open'); });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.pop')) closeAllPops();
});

function setupPop(id, getItems, onPick, { searchable = true } = {}) {
  const pop = $(`#${id}`), listNode = $('.menu-list', pop), input = $('.menu-search input', pop);
  let mcursor = 0, shown = [];

  function render() {
    const filter = (input?.value || '').toLowerCase();
    shown = getItems().filter((it) => !filter || it.label.toLowerCase().includes(filter));
    if (!shown.length) { listNode.innerHTML = '<div class="menu-empty">no matches</div>'; return; }
    listNode.innerHTML = shown.map((it, i) => `
      <button class="opt ${it.on ? 'on' : ''} ${i === mcursor ? 'cursor' : ''}" data-i="${i}">
        <svg class="tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12.5l5.5 5.5L20 7"/></svg>
        <span class="name">${esc(it.label)}</span>
        ${it.n != null ? `<span class="n">${it.n}</span>` : ''}
      </button>`).join('');
    const cur = $('.opt.cursor', listNode);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  $('.trigger', pop).addEventListener('click', () => {
    const opening = !pop.classList.contains('open');
    closeAllPops(pop);
    pop.classList.toggle('open', opening);
    if (opening) { if (input) input.value = ''; mcursor = 0; render(); input?.focus(); }
  });

  input?.addEventListener('input', () => { mcursor = 0; render(); });

  listNode.addEventListener('click', (e) => {
    const opt = e.target.closest('.opt'); if (!opt) return;
    pop.classList.remove('open');
    onPick(shown[+opt.dataset.i]);
  });

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pop.classList.remove('open'); $('.trigger', pop).focus(); }
    else if (e.key === 'ArrowDown') { mcursor = Math.min(mcursor + 1, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { mcursor = Math.max(mcursor - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[mcursor]) { pop.classList.remove('open'); onPick(shown[mcursor]); }
    else return;
    e.stopPropagation();
  });
  if (!searchable) pop.querySelector('.menu-search')?.remove();
}

setupPop('pop-sort',
  // best match means nothing without a query to be a match for
  () => SORTS.filter(([v]) => v !== 'relevance' || state.q)
    .map(([value, label]) => ({ label, value, on: state.sort === value })),
  (it) => setFilter('sort', it.value), { searchable: false });

export async function loadFacets() {
  const p = new URLSearchParams(state.project ? { project: state.project } : {});
  let f;
  try { f = await fetch('/api/facets?' + p).then((r) => r.json()); } catch (e) { return; }
  // an error envelope has no `projects`, and the popover reading it would throw
  // long after the request failed — keep the last good facets instead
  if (!f || !f.projects) return;
  facets = f;
  renderStats();
}

/* ---------------- live badge ---------------- */

// the badge carries one number, and it is not "running": running is ambient,
// where a session stopped on you costs something for every minute it is missed
async function pollWaiting() {
  let d;
  try { d = await fetch('/api/waiting').then((r) => r.json()); } catch (e) { return; }
  const n = d && d.waiting;
  $('#live-n').hidden = !n;
  $('#live-n').textContent = n || 0;
  $('#live-btn').classList.toggle('waiting', !!n);
  $('#live-btn').title = n
    ? `${n} session${n > 1 ? 's' : ''} waiting on you`
    : `nothing is waiting on you · ${(d && d.running) || 0} running`;
}
$('#live-btn').addEventListener('click', () => setView('live'));
setInterval(pollWaiting, 10000);
pollWaiting();

/* ---------------- new conversations while you read ---------------- */

export async function pollStatus() {
  if (statusOff) return;
  try {
    const r = await fetch('/api/status');
    if (!r.ok) { statusOff = true; return; }
    const s = await r.json();
    if (fingerprint === null) { fingerprint = s.fingerprint; return; }
    if (s.fingerprint !== fingerprint && !pendingRefresh) {
      pendingRefresh = s;
      renderStats();
    }
  } catch (e) { statusOff = true; }
}
