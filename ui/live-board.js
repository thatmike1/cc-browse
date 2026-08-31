import { $, esc, fmtDur, fmtTokens, shortProj } from './helpers.js';
import { ui } from './state.js';

const liveEl = $('#live');

// here, where `ago` starts at "just now" and stays there for a whole minute
function quietLabel(sec) {
  if (sec == null) return '';
  if (sec < 90) return sec + 's quiet';
  return fmtDur(sec * 1000) + ' quiet';
}

const STATUS_TEXT = {
  waiting: 'blocked on you', busy: 'working', idle: 'idle',
  shell: 'shell running', unknown: 'unknown',
};

function actHtml(a) {
  if (!a || !a.kind) return '<div class="live-act"><span class="none">no transcript to read</span></div>';
  const label = a.label ? `<b>${esc(a.label)}</b>` : '';
  const sep = a.label && a.detail ? ' <span class="sep">·</span> ' : '';
  const fail = a.failed ? ' <span class="fail">failed</span>' : '';
  return `<div class="live-act ${esc(a.kind)}">${label}${sep}${esc(a.detail)}${fail}</div>`;
}

function liveCardHtml(s) {
  const st = s.status;
  const pill = st === 'waiting' && s.waiting_for ? s.waiting_for : (STATUS_TEXT[st] || st);
  return `<div class="live-card ${esc(st)}">
    <div class="live-top">
      <h3 title="${esc(s.title || '')}">${esc(s.name || shortProj(s.project))}</h3>
      <span class="st ${esc(st)}"><i></i>${esc(pill)}</span>
    </div>
    <div class="meta">
      <span class="proj">${esc(shortProj(s.project))}</span>
      ${s.branch ? `<span class="sep">·</span><span class="branch">${esc(s.branch)}</span>` : ''}
    </div>
    ${actHtml(s.activity)}
    <div class="live-foot">
      <span>${esc(quietLabel(s.quiet_for))}</span>
      <span class="sep">·</span><span>pid ${esc(s.pid)}</span>
      ${s.tokens == null
        ? '<span class="tok" title="this session started after the last index pass">not indexed yet</span>'
        : `<span class="tok" title="the whole run: this session plus every agent it spawned">${fmtTokens(s.tokens)} tokens</span>`}
    </div>
  </div>`;
}

function renderLive(d) {
  const rows = (d && d.sessions) || [];
  if (!rows.length) {
    liveEl.innerHTML = `<div class="placeholder" style="height:60vh">
      <div class="hint">no claude code sessions running on this machine</div></div>`;
    return;
  }
  const blocked = rows.filter((r) => r.status === 'waiting').length;
  liveEl.innerHTML = `<div class="tl-head">
      <b>${rows.length}</b> session${rows.length > 1 ? 's' : ''} running
      ${blocked ? `<span class="sep">·</span><b>${blocked}</b> blocked on you` : ''}
    </div>
    <div class="live-grid">${rows.map(liveCardHtml).join('')}</div>`;
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
    const d = await fetch('/api/live').then((x) => x.json());
    if (req !== liveReq || ui.view !== 'live') return;
    if (d && d.error) liveEl.innerHTML = `<div class="placeholder" style="height:60vh"><div class="hint">${esc(d.error)}</div></div>`;
    else renderLive(d);
  } catch (e) { /* a poll that fails leaves the last board on screen */ }
  if (req === liveReq && ui.view === 'live') liveTimer = setTimeout(loadLive, 4000);
}

