// dom, formatting and axis helpers. no imports, no state — everything else
// in ui/ pulls from here.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const shortProj = (p) => (p || '').split('/').filter(Boolean).pop() || '—';

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1600);
}

export function md(text) {
  let out = esc(text);
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code>${c}</code></pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return out;
}

// the server wraps fts hits in \x02..\x03 so highlighting survives escaping
export const unmark = (s) => esc(s).replaceAll('\x02', '<mark>').replaceAll('\x03', '</mark>');

export function highlight(html, q) {
  if (!q) return html;
  const terms = q.match(/[\w#@./-]{2,}/g);
  if (!terms) return html;
  const re = new RegExp('(?![^<]*>)(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return html.replace(re, '<mark>$1</mark>');
}

export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// one decimal above a million, none below; costs two decimals under $100
export const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.floor(n / 1000) + 'k' : String(n || 0));

export function fmtCost(c) {
  if (c == null) return '';
  if (c < 0.01) return '<1\u00A2';
  return c < 100 ? '$' + c.toFixed(2) : '$' + Math.round(c).toLocaleString();
}

export function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + 's';
  const m = Math.round(sec / 60);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export function dayLabel(day) {
  if (!day) return 'undated';
  const d = new Date(day + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

// readable tick steps, in seconds. a run spanning days is ordinary — a session
// resumed the next morning — so the ladder runs past a day, and the fallback
// holds the axis to ~7 gridlines however long the span turns out to be
const TICKS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
               43200, 86400, 172800, 604800, 1209600, 2592000];
const DAY = 86400000;

export function axisTicks(t0, t1) {
  const span = t1 - t0;
  const step = (TICKS.find((sec) => span / (sec * 1000) <= 8) || 0) * 1000
    || Math.ceil(span / 7 / DAY) * DAY;
  const out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    out.push({ t, pct: ((t - t0) / span) * 100, step });
  }
  return out;
}

// 24h: the axis is a ruler, and "10:00 AM" is twice as wide as "10:00"
export const hhmm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// past a day the clock alone is ambiguous
export const tickLabel = (t, step) => (step < DAY
  ? hhmm(t)
  : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
