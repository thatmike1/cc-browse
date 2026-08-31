// the scope drawer: project, branch, range and the three flags, out of the bar
// and behind one gesture. scope is set rarely and read constantly, so the bar
// keeps the readback (the chip) and the drawer keeps the controls.
//
// it owns no state of its own — it writes the shared `state` and then asks
// list.js to reload, the same way the old header controls did.

import { $, $$, esc, projectColor, shortProj } from './helpers.js';
import { state, ui } from './state.js';
import { load, loadFacets, syncControls } from './list.js';
import { loadTimeline } from './timeline.js';

const el = $('#scope'), chip = $('#scope-chip');
const RANGE = { '': '', 1: 'today', 7: '7d', 30: '30d' };
const FLAGS = [
  ['titled', 'titled sessions'],
  ['lanes', 'delegated to agents'],
  ['mincost', 'cost over $1'],
];
// how many projects fit before the list becomes a wall; past that the filter
// box is the way through, which is what the row at the bottom says
const SHOWN = 6;

let facets = { projects: [], branches: [] };
let sinceDays = '';
let countReq = 0, countTimer = null;

/* ---------------- readback ---------------- */

function renderChip() {
  const bits = [`<b>${esc(state.project ? shortProj(state.project) : 'all projects')}</b>`];
  if (state.branch) bits.push(`<span>${esc(state.branch)}</span>`);
  if (RANGE[sinceDays]) bits.push(`<span>${RANGE[sinceDays]}</span>`);
  const flags = FLAGS.filter(([k]) => state[k]).length;
  if (flags) bits.push(`<span>+${flags}</span>`);
  $('.read', chip).innerHTML = bits.join('<i>/</i>');
  chip.classList.toggle('set', !!(state.project || state.branch || sinceDays || flags));
}

/* ---------------- panel ---------------- */

function filterText() {
  return ($('#scope-q').value || '').trim().toLowerCase();
}

function sectionHtml(label, note, rows) {
  return `<div class="sc-h"><span class="k">${label}</span><span class="n">${esc(note)}</span></div>` + rows;
}

function renderProjects() {
  const f = filterText();
  const all = facets.projects.map((p, i) => ({ ...p, color: projectColor(i) }));
  const match = f ? all.filter((p) => shortProj(p.value).toLowerCase().includes(f) || p.value.toLowerCase().includes(f)) : all;
  const shown = f ? match.slice(0, 40) : match.slice(0, SHOWN);
  const rest = match.length - shown.length;
  const rows = shown.map((p) => `<button class="sc-row ${state.project === p.value ? 'on' : ''}" data-project="${esc(p.value)}">
      <i class="bar" style="background:${p.color}"></i>
      <span class="name">${esc(shortProj(p.value))}</span>
      <span class="n">${p.n}</span>
    </button>`).join('')
    + (rest > 0 ? `<div class="sc-more"><i class="bar"></i>${rest} more, keep typing to filter</div>` : '')
    + (match.length ? '' : '<div class="sc-more"><i class="bar"></i>no project matches</div>');
  $('#sc-projects').innerHTML = sectionHtml('Project', String(facets.projects.length), rows);
}

function renderBranches() {
  const f = filterText();
  const all = facets.branches;
  const match = f ? all.filter((b) => b.value.toLowerCase().includes(f)) : all;
  const shown = match.slice(0, f ? 40 : SHOWN);
  const rest = match.length - shown.length;
  const note = state.project ? 'in ' + shortProj(state.project) : String(all.length);
  const rows = shown.map((b) => `<button class="sc-row br ${state.branch === b.value ? 'on' : ''}" data-branch="${esc(b.value)}">
      <span class="name">${esc(b.value)}</span>
      <span class="n">${b.n}</span>
    </button>`).join('')
    + (rest > 0 ? `<div class="sc-more">${rest} more, keep typing to filter</div>` : '')
    + (match.length ? '' : '<div class="sc-more">no branch matches</div>');
  $('#sc-branches').innerHTML = sectionHtml('Branch', note, rows);
}

function renderFlags() {
  $('#sc-flags').innerHTML = '<div class="sc-h"><span class="k">Only show</span></div>'
    + FLAGS.map(([k, label]) => `<button class="sc-check ${state[k] ? 'on' : ''}" data-flag="${k}">
        <i><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M4 12l5 5L20 7"/></svg></i>
        <span>${label}</span>
      </button>`).join('');
}

function renderRange() {
  $$('#sc-since button').forEach((b) => b.classList.toggle('on', b.dataset.v === sinceDays));
}

function render() {
  renderProjects();
  renderBranches();
  renderRange();
  renderFlags();
  renderChip();
}

/* ---------------- the count is the point ---------------- */

// it tells you the result before you close the panel, so it is asked for on
// every change rather than on close. `limit=1` makes it a count and one row.
function refreshCount() {
  clearTimeout(countTimer);
  const req = ++countReq;
  $('#sc-count').classList.add('pending');
  countTimer = setTimeout(async () => {
    const p = new URLSearchParams({
      project: state.project, branch: state.branch, since: state.since,
      titled: state.titled, lanes: state.lanes, mincost: state.mincost, limit: 1,
    });
    let d;
    try { d = await fetch('/api/sessions?' + p).then((r) => r.json()); } catch (e) { return; }
    if (req !== countReq) return;
    $('#sc-count').classList.remove('pending');
    $('#sc-count').textContent = d && d.total != null ? d.total.toLocaleString() : '—';
  }, 120);
}

/* ---------------- applying ---------------- */

function apply(scoping) {
  render();
  refreshCount();
  syncControls();
  // project and branch also scope the timeline; the flags and the range are
  // list-only, and the live board is never filtered — it is what is running
  if (ui.view === 'live') return;
  if (ui.view !== 'list') { if (scoping) loadTimeline(); return; }
  load(true);
}

async function pullFacets() {
  const p = new URLSearchParams(state.project ? { project: state.project } : {});
  let f;
  try { f = await fetch('/api/facets?' + p).then((r) => r.json()); } catch (e) { return; }
  if (!f || !f.projects) return;  // an error envelope has no lists to render
  facets = f;
  renderProjects();
  renderBranches();
}

/* ---------------- open / close ---------------- */

export function openScope() {
  // the live board is everything that is running, deliberately unfiltered, so
  // every control in here would be inert over it
  if (!el.hidden || ui.view === 'live') return;
  el.hidden = false;
  render();
  refreshCount();
  pullFacets();
  $('#scope-q').value = '';
  $('#scope-q').focus();
}

export function closeScope() {
  el.hidden = true;
}

chip.addEventListener('click', () => (el.hidden ? openScope() : closeScope()));
$('.sc-scrim', el).addEventListener('click', closeScope);
// leaving for the board takes the panel with you; nothing in it applies there
$('#live-btn').addEventListener('click', closeScope);
$('#scope-q').addEventListener('input', () => { renderProjects(); renderBranches(); });

$('#sc-projects').addEventListener('click', (e) => {
  const b = e.target.closest('[data-project]'); if (!b) return;
  // clicking the project already in force clears it: there is no "all" row to
  // aim at, and a scope you cannot leave is a trap
  state.project = state.project === b.dataset.project ? '' : b.dataset.project;
  state.branch = '';
  loadFacets();
  pullFacets();
  apply(true);
});

$('#sc-branches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-branch]'); if (!b) return;
  state.branch = state.branch === b.dataset.branch ? '' : b.dataset.branch;
  apply(true);
});

$('#sc-since').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sinceDays = b.dataset.v;
  state.since = sinceISO(sinceDays);
  apply(false);
});

$('#sc-flags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-flag]'); if (!b) return;
  const k = b.dataset.flag;
  state[k] = state[k] ? '' : '1';
  apply(false);
});

$('#sc-reset').addEventListener('click', () => {
  state.project = ''; state.branch = ''; state.since = '';
  state.titled = ''; state.lanes = ''; state.mincost = '';
  sinceDays = '';
  loadFacets();
  pullFacets();
  apply(true);
});

function sinceISO(days) {
  if (!days) return '';
  const d = new Date();
  if (days === '1') d.setHours(0, 0, 0, 0); else d.setDate(d.getDate() - +days);
  return d.toISOString();
}

// capture, so Esc closes the drawer before the global handler reads it as
// "leave this view", and so `S` never reaches a field being typed into
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
  if (e.key === 'Escape' && !el.hidden) {
    closeScope(); e.stopPropagation(); e.preventDefault(); return;
  }
  if ((e.key === 's' || e.key === 'S') && !typing && ui.view !== 'live'
      && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation();
    if (el.hidden) openScope(); else closeScope();
  }
}, true);

renderChip();
