import { $, esc, fmtCost, fmtTokens, shortProj, toast } from './helpers.js';
import { ui } from './state.js';

const liveEl = $('#live');

// how long a session has been quiet, in the board's own units: seconds matter
// here, where `ago` starts at "just now" and stays there for a whole minute.
// the board's own number words: the rest of the ui runs units together ("6s")
// where this surface spaces them, and a cache countdown stays in minutes long
// after a duration would have rolled over to hours.
const pad2 = (n) => String(n).padStart(2, '0');

function gap(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + ' s';
  const m = Math.floor(sec / 60);
  return m < 60 ? m + ' m' : Math.floor(m / 60) + ' h ' + pad2(m % 60) + ' m';
}

// the hero counts the seconds off, because the seconds are the point: this is
// how long a session has been sitting on you
function stoppedFor(sec) {
  if (sec == null) return '';
  if (sec >= 3600) return gap(sec);
  const m = Math.floor(sec / 60);
  return m ? `${m} min ${pad2(sec % 60)} s` : `${sec} s`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// "12 min ago", the coarse form — a session that ended is not being timed
function agoWords(sec) {
  if (sec == null) return '';
  if (sec < 60) return 'moments ago';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + ' h ' + pad2(m % 60) + ' m ago' : Math.floor(h / 24) + ' d ago';
}

// three states, never two: `unknown` is a session whose statusline never handed
// over a prompt_cache block, which is not the same as a cache that ran out
function cacheLabel(c) {
  if (!c || c.state === 'unknown') return '—';
  if (c.state === 'cold') return 'cold';
  return gap(c.left);
}

const cachePct = (c) => (c && c.state === 'warm' && c.pct != null ? c.pct * 100 : 0);

function cacheNote(c) {
  if (!c || c.state === 'unknown') return 'no cache reading from this session';
  const cost = c.recache
    ? `rebuilding it cold costs ${fmtTokens(c.recache)} tokens`
    : 'nothing to rebuild yet';
  if (c.state === 'cold') return `cache expired · ${cost}`;
  return `${c.ttl || '?'} TTL · ${cost}`;
}

// bars are drawn against the tallest bar in their own series, so a $4 session
// and a 20c one both read as shape. an all-zero series stays at the floor.
function sparkHtml(bars, cls, w, h) {
  const vals = bars && bars.length ? bars : [0];
  const top = Math.max(...vals);
  const last = vals.length - 1;
  return `<span class="lb-spark ${cls}" style="height:${h}px">${vals.map((v, i) => {
    const px = top > 0 ? Math.max(3, Math.round((v / top) * h)) : 3;
    return `<i style="width:${w}px;height:${px}px" class="${i === last && cls === 'head' ? 'now' : ''}"></i>`;
  }).join('')}</span>`;
}

function heroHtml(s) {
  const started = s.started_at ? Math.round((Date.now() - s.started_at) / 1000) : null;
  const since = s.status_since;
  const cmd = 'claude --resume ' + s.session_id;
  return `<div class="lb-hero">
    <div class="lb-hero-main">
      <div class="lb-hero-top">
        <span class="lb-flag"><i></i>waiting on you</span>
        ${since ? `<span class="tnum lb-since">since ${esc(clock(since))} · ${esc(stoppedFor(Math.round((Date.now() - since) / 1000)))}</span>` : ''}
        <span class="lb-chip">${esc(shortProj(s.project))}</span>
      </div>
      <div class="lb-hero-title">${esc(s.title || s.name || shortProj(s.project))}</div>
      ${s.question
        ? `<div class="lb-hero-q">${esc(s.question)}</div>`
        : `<div class="lb-hero-q none">${esc(s.waiting_for || 'stopped, with nothing readable in the transcript tail')}</div>`}
    </div>
    <div class="lb-hero-side">
      <div class="lb-kv"><span>running for</span><span class="tnum v">${esc(gap(started) || '—')}</span></div>
      <div class="lb-kv"><span>cost</span><span class="tnum v accent">${esc(fmtCost(s.cost) || '—')}</span></div>
      <div class="lb-kv"><span>agents</span><span class="tnum v">${esc(String(s.agents ?? 0))}</span></div>
      <div class="lb-cache">
        <div class="lb-kv">
          <span>prompt cache</span>
          <span class="tnum v">${esc(cacheLabel(s.cache))}${s.cache && s.cache.state === 'warm' ? ' left' : ''}</span>
        </div>
        <span class="lb-bar"><i style="width:${cachePct(s.cache).toFixed(1)}%"></i></span>
        <span class="lb-note">${esc(cacheNote(s.cache))}</span>
      </div>
      <button class="lb-copy mono" data-cmd="${esc(cmd)}">copy resume</button>
    </div>
  </div>`;
}

function actHtml(a) {
  if (!a || !a.kind) return '<span class="lb-act none">no transcript to read</span>';
  const label = a.label ? `<b class="mono">${esc(a.label)}</b> ` : '';
  const fail = a.failed ? ' <em class="fail">failed</em>' : '';
  return `<span class="lb-act ${esc(a.kind)}">${label}${esc(a.detail)}${fail}</span>`;
}

// a background agent gets the agent hue, an interactive session the assistant
// one — the same split the transcript reader draws, and a fact the registry
// states rather than one inferred from what the session happens to be doing
function dotClass(s) {
  if (s.status === 'waiting') return 'waiting';
  if (s.status === 'unknown') return 'dead';
  return s.session_kind === 'bg' ? 'agent' : 'busy';
}

function rowHtml(s) {
  return `<div class="lb-row">
    <span class="lb-dot ${dotClass(s)}"></span>
    <span class="lb-name" title="${esc(s.title || '')}">${esc(s.name || shortProj(s.project))}</span>
    ${actHtml(s.activity)}
    ${sparkHtml(s.spend, s.session_kind === 'bg' ? 'agent' : 'row', 3, 14)}
    <span class="lb-mini ${s.cache && s.cache.state === 'warm' ? '' : 'off'}" title="${esc(cacheNote(s.cache))}">
      <span class="lb-bar"><i style="width:${cachePct(s.cache).toFixed(1)}%"></i></span>
      <span class="tnum">${esc(cacheLabel(s.cache))}</span>
    </span>
    <span class="tnum lb-quiet" title="nothing written to the transcript for this long">${esc(gap(s.quiet_for))}</span>
    <span class="tnum lb-cost">${esc(fmtCost(s.cost) || '—')}</span>
  </div>`;
}

function doneDetail(f) {
  if (!f.readable) return 'status unreadable — no statusline payload was left behind';
  const bits = ['last active ' + agoWords(f.last_active)];
  if (f.lines_added || f.lines_removed) {
    bits.push(`+${f.lines_added || 0} −${f.lines_removed || 0} lines`);
  }
  // a repo fact, not a session one: the checkout is shared, so it is worded
  // against the repo rather than credited to whoever just stopped
  if (f.uncommitted) bits.push(`${f.uncommitted} uncommitted in ${shortProj(f.project)}`);
  return bits.join(' · ');
}

const TICK = '<svg class="lb-tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--assistant)" stroke-width="2.6"><path d="M4 12l5 5L20 7"/></svg>';

function doneHtml(f) {
  return `<div class="lb-row done">
    ${f.readable ? TICK : '<span class="lb-dot dead"></span>'}
    <span class="lb-name">${esc(f.name || (f.project ? shortProj(f.project) : f.session_id.slice(0, 8)))}</span>
    <span class="lb-act">${esc(doneDetail(f))}</span>
    <span class="lb-mini ${f.cache && f.cache.state === 'warm' ? '' : 'off'}" title="${esc(cacheNote(f.cache))}">
      <span class="lb-bar"><i style="width:${cachePct(f.cache).toFixed(1)}%"></i></span>
      <span class="tnum">${esc(cacheLabel(f.cache))}</span>
    </span>
    <span class="tnum lb-cost">${esc(fmtCost(f.cost) || '—')}</span>
  </div>`;
}

function secHtml(label, right) {
  return `<div class="lb-sec"><span class="lb-h">${esc(label)}</span>
    <span class="lb-rule"></span>${right || ''}</div>`;
}

function renderLive(d) {
  const rows = (d && d.sessions) || [];
  const finished = (d && d.finished) || [];
  if (!rows.length && !finished.length) {
    liveEl.innerHTML = `<div class="placeholder" style="height:60vh">
      <div class="hint">no claude code sessions running on this machine</div></div>`;
    return;
  }
  const spend = (d && d.spend) || {};
  const mins = Math.round((spend.window || 600) / 60);
  // `fmtCost` floors at "<1¢", which reads as a lie when the figure is a true
  // zero — a machine that spent nothing for ten minutes should say so
  const money = spend.sampled
    ? `<span class="tnum lb-spend">${spend.total ? esc(fmtCost(spend.total)) + ` in the last ${mins} min` : `no spend in the last ${mins} min`}</span>
       ${sparkHtml(spend.bars, 'head', 4, 15)}`
    : `<span class="lb-spend none">watching spend, ${mins} min of history to fill</span>`;

  const hero = rows.find((r) => r.status === 'waiting');
  const rest = hero ? rows.filter((r) => r !== hero) : rows;

  liveEl.innerHTML = `<div class="lb">
    ${hero ? heroHtml(hero) : ''}
    ${rest.length ? secHtml('Running', money) + `<div class="lb-list">${rest.map(rowHtml).join('')}</div>` : ''}
    ${finished.length ? secHtml('Finished while you were away', '')
      + `<div class="lb-list">${finished.map(doneHtml).join('')}</div>` : ''}
  </div>`;

  const copy = liveEl.querySelector('.lb-copy');
  if (copy) {
    copy.onclick = () => {
      navigator.clipboard.writeText(copy.dataset.cmd);
      toast('resume command copied');
    };
  }
}

// view-scoped and self-cancelling, like the lane poll: the board is the only
// thing here that has to keep asking, and it stops the moment you leave it
let liveTimer = null, liveReq = 0;

export function stopLivePoll() {
  clearTimeout(liveTimer);
  liveTimer = null;
}

export async function loadLive() {
  stopLivePoll();
  const req = ++liveReq;
  if (!liveEl.innerHTML) {
    liveEl.innerHTML = '<div class="skeleton"><div style="width:40%"></div><div style="width:85%"></div><div style="width:70%"></div></div>';
  }
  try {
    const d = await fetch('/api/live-board').then((x) => x.json());
    if (req !== liveReq || ui.view !== 'live') return;
    if (d && d.error) liveEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">${esc(d.error)}</div></div>`;
    else renderLive(d);
  } catch (e) { /* a poll that fails leaves the last board on screen */ }
  if (req === liveReq && ui.view === 'live') liveTimer = setTimeout(loadLive, 4000);
}
