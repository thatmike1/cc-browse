import {
  $, $$, axisTicks, dayLabel, esc, fmtCost, fmtDur, fmtTokens, hhmm, shortProj,
  tickLabel,
} from './helpers.js';
import { state, ui } from './state.js';
import { hideTip, openSession, showTip } from './detail.js';
import { loadLive, stopLivePoll } from './live-board.js';

// sequential cost ramp: one hue (the accent), dim -> bright, validated for the
// dark surface (monotone L, adjacent ΔL, light-end contrast). shared by the
// day/week bars and the month cells so a colour means the same cost everywhere.
// tokens were tried as the alternative weighting — swap `cost` for `tokens` in
// rampColor's callers to compare — but cost won: it folds model price in, and
// the unpriced-run case gets an honest neutral instead of a fake zero.
const RAMP = ['#634e37', '#856540', '#a57947', '#c58f51', '#dfa45f'];
const tlEl = $('#timeline');
const liveEl = $('#live');
let tlAnchor = new Date(); tlAnchor.setHours(0, 0, 0, 0);
let tlData = null, tlReq = 0;

// sqrt, not linear: day costs are long-tailed, and a linear scale would leave
// everything but the one monster session in the bottom step
function rampColor(cost, max) {
  if (cost == null || !max) return null;
  const k = Math.sqrt(Math.min(cost / max, 1));
  return RAMP[Math.min(RAMP.length - 1, Math.floor(k * RAMP.length))];
}

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const localDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function tlRange() {
  const a = new Date(tlAnchor);
  if (ui.view === 'day') return [a, addDays(a, 1)];
  if (ui.view === 'week') { const s = addDays(a, -((a.getDay() + 6) % 7)); return [s, addDays(s, 7)]; }
  const s = new Date(a.getFullYear(), a.getMonth(), 1);
  return [s, new Date(a.getFullYear(), a.getMonth() + 1, 1)];
}

function periodLabel(s, e) {
  if (ui.view === 'day') return dayLabel(localDay(s));
  if (ui.view === 'month') return s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return fmt(s) + ' – ' + fmt(addDays(e, -1));
}

export function setView(v) {
  ui.view = v;
  const live = v === 'live';
  // both full-width views clear the list's search and filters out of the header;
  // only the timeline replaces them with a period navigator
  const wide = v !== 'list';
  document.body.classList.toggle('tl', wide);
  document.body.classList.toggle('live', live);
  tlEl.hidden = !wide || live;
  liveEl.hidden = !live;
  $('#list').hidden = wide;
  $('#detail').hidden = wide;
  $$('#view button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  hideTip();
  if (live) loadLive();
  else { stopLivePoll(); if (wide) loadTimeline(); }
}

$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setView(b.dataset.v);
});

function tlStep(n) {
  if (ui.view === 'month') tlAnchor.setMonth(tlAnchor.getMonth() + n, 1);
  else tlAnchor.setDate(tlAnchor.getDate() + n * (ui.view === 'week' ? 7 : 1));
  loadTimeline();
}
$('#tlprev').onclick = () => tlStep(-1);
$('#tlnext').onclick = () => tlStep(1);
$('#tltoday').onclick = () => { tlAnchor = new Date(); tlAnchor.setHours(0, 0, 0, 0); loadTimeline(); };

export async function loadTimeline() {
  const req = ++tlReq;
  const [s, e] = tlRange();
  $('#tllabel').textContent = periodLabel(s, e);
  tlEl.innerHTML = '<div class="skeleton"><div style="width:40%"></div><div style="width:85%"></div><div style="width:70%"></div></div>';
  const p = new URLSearchParams({ project: state.project, branch: state.branch });
  // the month grid rides the indexed utc day column; day/week ask for the
  // exact local range, so a late-evening session lands on the day you lived it
  if (ui.view === 'month') { p.set('agg', 'day'); p.set('start', localDay(s)); p.set('end', localDay(e)); }
  else { p.set('start', s.toISOString()); p.set('end', e.toISOString()); }
  let d;
  try { d = await fetch('/api/timeline?' + p).then((x) => x.json()); } catch (err) { return; }
  if (req !== tlReq || !d || d.error) {
    if (req === tlReq && d && d.error) tlEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">${esc(d.error)}</div></div>`;
    return;
  }
  tlData = d;
  tlEl.innerHTML = ui.view === 'month' ? monthHtml(d, s) : barsHtml(d, s, e);
}

const clampT = (t, t0, t1) => Math.max(t0, Math.min(t1, t));

function barsHtml(d, s, e) {
  const ss = d.sessions || [];
  if (!ss.length) return `<div class="placeholder" style="height:60vh"><div class="hint">nothing ran ${esc(periodLabel(s, e))}</div></div>`;
  const t0 = +s, t1 = +e, span = t1 - t0, now = Date.now();
  const bucket = ui.view === 'day' ? 900000 : 3600000;  // 15 min buckets; 1 h squashed
  const maxCost = Math.max(0, ...ss.map((r) => r.cost || 0));

  const ends = (r) => {
    const bs = clampT(+new Date(r.created), t0, t1);
    const be = clampT(r.active ? now : (+new Date(r.modified) || bs), bs, t1);
    return [bs, be];
  };

  // agents are intensity, not lanes: concurrent transcripts per bucket. the
  // lead's own interval counts as 1, so a solo session reads as a flat bar.
  const heat = (r, bs, be) => {
    const n = Math.max(1, Math.round((be - bs) / bucket));
    const iv = [[bs, be], ...(r.agents || []).map((a) =>
      [+new Date(a.start), a.active ? now : +new Date(a.end)])];
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = bs + (i * (be - bs)) / n, b = bs + ((i + 1) * (be - bs)) / n;
      out.push(iv.reduce((c, [x, y]) => c + (x < b && y > a ? 1 : 0), 0));
    }
    return out;
  };
  const maxHeat = Math.max(1, ...ss.map((r) => Math.max(...heat(r, ...ends(r)))));

  const barFill = (r, bs, be, color) => {
    const h = heat(r, bs, be);
    const alpha = (c) => 32 + 68 * Math.min(1, maxHeat <= 1 ? 0 : Math.max(0, c - 1) / (maxHeat - 1));
    if (h.every((c) => c === h[0])) return `background:color-mix(in srgb, ${color} ${alpha(h[0]).toFixed(0)}%, transparent)`;
    const w = 100 / h.length;
    const stops = h.map((c, i) =>
      `color-mix(in srgb, ${color} ${alpha(c).toFixed(0)}%, transparent) ${(i * w).toFixed(2)}% ${((i + 1) * w).toFixed(2)}%`);
    return `background:linear-gradient(90deg, ${stops.join(',')})`;
  };

  // cost per hour, each run's cost spread evenly over its own wall span
  const hours = Math.round(span / 3600000);
  const vals = new Array(hours).fill(0);
  for (const r of ss) {
    if (r.cost == null) continue;
    const [bs, be] = ends(r);
    if (be <= bs) { vals[Math.min(hours - 1, Math.floor((bs - t0) / 3600000))] += r.cost; continue; }
    const rate = r.cost / (be - bs);
    for (let i = Math.floor((bs - t0) / 3600000); i <= Math.floor((be - 1 - t0) / 3600000) && i < hours; i++) {
      const a = t0 + i * 3600000, b = a + 3600000;
      vals[i] += rate * (Math.min(be, b) - Math.max(bs, a));
    }
  }
  const vmax = Math.max(...vals);
  const cw = 100 / hours;
  const strip = vmax > 0 ? `<div class="tl-strip">` + vals.map((v, i) => v > 0
    ? `<div class="col" style="left:${(i * cw).toFixed(3)}%;width:${(cw * 0.7).toFixed(3)}%;height:max(${((v / vmax) * 100).toFixed(1)}%, 2px)" title="${hhmm(t0 + i * 3600000)} – ${hhmm(t0 + (i + 1) * 3600000)} · ${fmtCost(v)}"></div>`
    : '').join('') + `</div>` : '';

  const ticks = axisTicks(t0, t1);
  const grid = ticks.map((k) => `<i class="grid" style="left:${k.pct}%"></i>`).join('');
  const axis = `<div class="lane-axis">${ticks.map((k) => `<span style="left:${k.pct}%">${tickLabel(k.t, k.step)}</span>`).join('')}</div>`;

  const groups = new Map();
  for (const r of ss) {
    if (!groups.has(r.project)) groups.set(r.project, []);
    groups.get(r.project).push(r);
  }
  const glist = [...groups.entries()].map(([p, rows]) => ({
    p, rows,
    cost: rows.some((r) => r.cost == null) ? null : rows.reduce((a, r) => a + r.cost, 0),
  })).sort((a, b) => (b.cost || 0) - (a.cost || 0));

  const rowsHtml = glist.map((g) => `<div class="tl-proj">${esc(shortProj(g.p))}<span class="n">${g.rows.length} session${g.rows.length > 1 ? 's' : ''}${g.cost != null ? ' · ' + fmtCost(g.cost) : ''}</span></div>`
    + g.rows.map((r) => {
      const [bs, be] = ends(r);
      const left = ((bs - t0) / span) * 100;
      const width = Math.max(((be - bs) / span) * 100, 0.35);
      const color = rampColor(r.cost, maxCost) || 'var(--faint)';
      const fig = [fmtDur(be - bs), r.n_agents ? r.n_agents + ' agent' + (r.n_agents > 1 ? 's' : '') : null,
                   r.cost != null ? fmtCost(r.cost) : null].filter(Boolean).join(' · ');
      // near the right edge the figure flips inside the bar; a bar too narrow
      // to hold it gets the figure on its left instead of underneath it
      const inside = left + width > 78 && width > 14;
      const figStyle = inside ? `right:${Math.max(100 - left - width, 0)}%;padding-right:10px`
        : left + width > 78 ? `right:${100 - left}%;padding-right:8px`
        : `left:${left + width}%;padding-left:10px`;
      return `<div class="tl-row" data-id="${esc(r.id)}" style="--m:${color}">
        <div class="tl-name">${esc(r.title || '(untitled)')}</div>
        <div class="tl-track">${grid}
          <div class="tl-bar ${r.active ? 'live' : ''}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;${barFill(r, bs, be, color)};border:1px solid color-mix(in srgb, ${color} 55%, transparent)"></div>
          <span class="lane-fig ${inside ? 'inside' : ''}" style="${figStyle}">${fig}</span>
        </div>
      </div>`;
    }).join('')).join('');

  const nAgents = ss.reduce((a, r) => a + r.n_agents, 0);
  const total = ss.some((r) => r.cost == null) ? null : ss.reduce((a, r) => a + r.cost, 0);
  return `<div class="tl-head">
      <span><b>${ss.length}</b> session${ss.length > 1 ? 's' : ''}</span>
      ${nAgents ? `<span class="sep">·</span><span><b>${nAgents}</b> agents</span>` : ''}
      ${total != null ? `<span class="sep">·</span><span><b>${fmtCost(total)}</b> total</span>` : ''}
      <span class="tl-legend">cheap ${RAMP.map((c) => `<i style="background:${c}"></i>`).join('')} costly${maxHeat > 1 ? '<span class="sep" style="margin:0 4px">·</span>brighter = more agents at once' : ''}</span>
    </div>
    <div class="tl-body ${ui.view === 'week' ? 'tl-week' : ''}">${strip}${axis}${rowsHtml}</div>`;
}

function monthHtml(d, s) {
  const by = {};
  for (const x of d.days || []) by[x.day] = x;
  const maxCost = Math.max(0, ...(d.days || []).map((x) => x.cost || 0));
  const firstDow = (s.getDay() + 6) % 7;  // monday-first
  const start = addDays(s, -firstDow);
  const nDays = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((firstDow + nDays) / 7);
  let cells = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((w) => `<div class="tl-dow">${w}</div>`).join('');
  let total = 0, anyNull = false, nSess = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(start, i);
    const iso = localDay(day);
    const x = by[iso];
    const off = day.getMonth() !== s.getMonth();
    if (!off && x) { nSess += x.sessions; if (x.cost == null) anyNull = true; else total += x.cost; }
    const color = x ? rampColor(x.cost, maxCost) : null;
    const tone = color ? (RAMP.indexOf(color) >= 1 ? 'ink' : 'lo') : '';
    cells += `<div class="tl-cell ${off ? 'off' : ''} ${tone}" data-day="${iso}" style="${color ? `background:${color};border-color:${color}` : ''}">
      <span class="d">${day.getDate()}</span>
      ${x ? `<span class="c">${x.sessions} · ${x.cost != null ? fmtCost(x.cost) : fmtTokens(x.tokens) + ' tok'}</span>` : ''}
    </div>`;
  }
  return `<div class="tl-head">
      <span><b>${nSess}</b> sessions</span>
      ${total ? `<span class="sep">·</span><span><b>${anyNull ? '≥' : ''}${fmtCost(total)}</b> total</span>` : ''}
      <span class="tl-legend">cheap ${RAMP.map((c) => `<i style="background:${c}"></i>`).join('')} costly</span>
    </div>
    <div class="tl-month">${cells}</div>`;
}

// hover mirrors the lane tooltip; click opens the run in the lane view
tlEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.tl-row');
  if (!row || !tlData) { if (!e.target.closest('.tl-cell')) hideTip(); return; }
  const r = (tlData.sessions || []).find((x) => x.id === row.dataset.id);
  if (!r) { hideTip(); return; }
  const start = +new Date(r.created), end = r.active ? Date.now() : +new Date(r.modified);
  showTip(`<div class="t">${esc(r.title || '(untitled)')}</div>
    <div class="s">${esc([shortProj(r.project), r.n_msgs + ' msgs'].join(' · '))}</div>
    <dl>
      <dt>ran</dt><dd>${hhmm(start)} → ${r.active ? 'now' : hhmm(end)} · ${fmtDur(end - start)}</dd>
      ${r.n_agents ? `<dt>agents</dt><dd>${r.n_agents}</dd>` : ''}
      <dt>tokens</dt><dd>${fmtTokens(r.tokens)}</dd>
      <dt>cost</dt><dd>${r.cost == null ? '—' : fmtCost(r.cost)}</dd>
    </dl>
    <div class="open">click to open ${r.n_agents ? 'the lane view' : 'the transcript'}</div>`, e);
});
tlEl.addEventListener('mouseleave', hideTip);

tlEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.tl-cell');
  if (cell && cell.dataset.day) {
    tlAnchor = new Date(cell.dataset.day + 'T00:00:00');
    setView('day');
    return;
  }
  const row = e.target.closest('.tl-row');
  if (row) { hideTip(); setView('list'); openSession(row.dataset.id, 'lanes'); }
});

