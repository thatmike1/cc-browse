import { $, $$, ago, dayLabel, esc, fmtCost, highlight, shortProj, unmark } from './helpers.js';
import { state, ui } from './state.js';
import { openSession } from './detail.js';
import { loadTimeline } from './timeline.js';

const listEl = $('#list');

let offset = 0, total = 0, loading = false, done = false;
let facets = { projects: [], branches: [] };
// never swap the list out from under a read — just offer it
let pendingRefresh = null;
let fingerprint = null, statusOff = false;

const SORTS = [
  ['recent', 'newest first'], ['oldest', 'oldest first'],
  ['longest', 'longest first'], ['shortest', 'shortest first'],
  ['costly', 'most expensive'], ['cheapest', 'cheapest first'],
  ['relevance', 'best match'],
];



function rowHtml(s, i) {
  const hit = s.snip
    ? `<div class="snip">${unmark(s.snip)}</div>`
    : (() => {
        const t = s.tail && s.tail.length ? s.tail[s.tail.length - 1] : null;
        // a tail line carrying a sender came from another session, not from here
        const who = t && t.sender ? esc(t.sender) : (t && t.role === 'user' ? 'you' : 'claude');
        return t ? `<div class="snip"><b class="who">${who}:</b> ${esc(t.text.slice(0, 220))}</div>` : '';
      })();
  const title = state.mode === 'meta' && state.q
    ? highlight(esc(s.title || '(empty)'), state.q) : esc(s.title || '(empty)');
  return `<div class="row" data-i="${i}" data-id="${s.session_id}">
    <div class="title ${s.titled ? '' : 'untitled'}">${title}</div>
    <div class="meta">
      <span class="proj">${esc(shortProj(s.project))}</span>
      ${s.branch ? `<span class="sep">·</span><span class="branch">${esc(s.branch)}</span>` : ''}
      <span class="sep">·</span><span>${s.n_user + s.n_assistant} msgs</span>
      <span class="sep">·</span><span>${ago(s.modified)}</span>
      ${s.n_agents ? `<span class="sep">·</span><span class="lanes" title="${s.n_agents} agent lane${s.n_agents > 1 ? 's' : ''} ran in this conversation">${s.n_agents} lane${s.n_agents > 1 ? 's' : ''}</span>` : ''}
      ${s.via_subagent ? '<span class="via" title="matched inside a subagent transcript, not the conversation itself">via subagent</span>' : ''}
      ${s.n_hits ? `<span class="hits">${s.n_hits} hit${s.n_hits > 1 ? 's' : ''}</span>` : ''}
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

export async function load(reset) {
  if (loading || (done && !reset)) return;
  loading = true;
  if (reset) {
    offset = 0; ui.sessions = []; done = false;
    listEl.innerHTML = '<div class="skeleton">' + '<div style="width:70%"></div><div style="width:45%"></div><div style="width:88%"></div>'.repeat(4) + '</div>';
  }
  const p = new URLSearchParams({ ...state, offset, limit: 60 });
  let r;
  try {
    r = await fetch('/api/sessions?' + p).then((x) => x.json());
  } catch (e) { loading = false; return; }
  if (reset) listEl.innerHTML = '';
  if (!r || !r.sessions) {  // the server answered with an error, not a page
    if (reset) listEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">${esc(r?.error || 'the server could not answer that')}</div></div>`;
    done = true; loading = false; return;
  }
  total = r.total;
  const start = ui.sessions.length;
  ui.sessions = ui.sessions.concat(r.sessions);
  offset += r.sessions.length;
  if (!r.sessions.length) done = true;
  if (!ui.sessions.length) {
    listEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">nothing matches${state.q ? ` “${esc(state.q)}”` : ''}</div></div>`;
  } else {
    renderChunk(r.sessions, start);
  }
  renderStats();
  loading = false;
}

function renderStats() {
  const bits = [`<b>${total.toLocaleString()}</b> conversations`];
  if (facets.stats) bits.push(`<span class="sep">·</span><b>${facets.stats.messages.toLocaleString()}</b> messages indexed`);
  const chips = [];
  if (state.project) chips.push(['project', shortProj(state.project), () => setFilter('project', '')]);
  if (state.branch) chips.push(['branch', state.branch, () => setFilter('branch', '')]);
  $('#stats').innerHTML = bits.join(' ') +
    chips.map(([k, v]) => `<span class="pill" data-clear="${k}">${esc(v)}<button aria-label="clear ${k}">×</button></span>`).join('') +
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
    return;
  }
  const pill = e.target.closest('.pill');
  if (pill && pill.dataset.clear) setFilter(pill.dataset.clear, '');
});

listEl.addEventListener('scroll', () => {
  if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 500) load(false);
});

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) { ui.cursor = +row.dataset.i; openSession(row.dataset.id); }
});

/* ---------------- filters ---------------- */

function sinceISO(days) {
  if (!days) return '';
  const d = new Date();
  if (days === '1') d.setHours(0, 0, 0, 0); else d.setDate(d.getDate() - +days);
  return d.toISOString();
}

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
  $('#pop-project .label').textContent = state.project ? shortProj(state.project) : 'all projects';
  $('#pop-project .trigger').classList.toggle('set', !!state.project);
  $('#pop-branch .label').textContent = state.branch || 'all branches';
  $('#pop-branch .trigger').classList.toggle('set', !!state.branch);
  $('#pop-sort .label').textContent = (SORTS.find((s) => s[0] === state.sort) || SORTS[0])[1];
  $('#q').placeholder = { content: 'search everything that was said…',
    semantic: 'describe what it was about…' }[state.mode] || 'search titles or paste a session id…';
  renderStats();
}

// segmented controls
function segment(id, key, transform) {
  $(`#${id}`).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    state[key] = transform ? transform(b.dataset.v) : b.dataset.v;
    if (id === 'mode') {
      // a fuzzy match is only useful ranked by how well it matched
      if (b.dataset.v === 'semantic') state.sort = 'relevance';
      else if (state.sort === 'relevance' && b.dataset.v === 'meta') state.sort = 'recent';
    }
    syncControls();
    load(true);
  });
}
segment('mode', 'mode');
segment('since', 'since', sinceISO);
segment('titled', 'titled');
// the detail pane already owns #lanes, so the filter's own id has to differ
segment('haslanes', 'lanes');
segment('mincost', 'mincost');

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

setupPop('pop-project',
  () => [{ label: 'all projects', value: '', on: !state.project },
    ...facets.projects.map((p) => ({ label: shortProj(p.value), value: p.value, n: p.n, on: state.project === p.value }))],
  (it) => setFilter('project', it.value));

setupPop('pop-branch',
  () => [{ label: 'all branches', value: '', on: !state.branch },
    ...facets.branches.map((b) => ({ label: b.value, value: b.value, n: b.n, on: state.branch === b.value }))],
  (it) => setFilter('branch', it.value));

setupPop('pop-sort',
  () => SORTS.filter(([v]) => v !== 'relevance' || state.mode !== 'meta')
    .map(([value, label]) => ({ label, value, on: state.sort === value })),
  (it) => setFilter('sort', it.value), { searchable: false });

export async function loadFacets() {
  const p = new URLSearchParams(state.project ? { project: state.project } : {});
  facets = await fetch('/api/facets?' + p).then((r) => r.json());
  $('#mode-semantic').hidden = !facets.semantic;
  renderStats();
}

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
