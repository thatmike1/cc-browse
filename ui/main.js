import { $ } from './helpers.js';
import { state, ui } from './state.js';
import { closeAllPops, load, loadFacets, paintActive, pollStatus, syncControls } from './list.js';
import { closeFind, gotoMatch, openFind, openSession } from './detail.js';
import { setView } from './timeline.js';

const listEl = $('#list'), findEl = $('#findbar');

function moveCursor(delta) {
  if (!ui.sessions.length) return;
  ui.cursor = Math.max(0, Math.min(ui.sessions.length - 1, ui.cursor + delta));
  paintActive();
  const el = $(`.row[data-i="${ui.cursor}"]`, listEl);
  el?.scrollIntoView({ block: 'nearest' });
  if (ui.cursor > ui.sessions.length - 8) load(false);
}

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (e.key === 'f' && !typing && ui.activeId) { e.preventDefault(); openFind(); return; }
  if ((e.key === 'n' || e.key === 'N') && !typing && ui.nav.length) {
    e.preventDefault(); gotoMatch(e.key === 'N' ? -1 : 1); return;
  }
  if (e.key === 'Escape') {
    if (typing) { e.target.blur(); return; }
    if (ui.view !== 'list') { setView('list'); return; }
    if (!findEl.hidden) { closeFind(); return; }
    if (document.body.classList.contains('reading') && window.innerWidth <= 900) {
      document.body.classList.remove('reading'); return;
    }
    closeAllPops(); return;
  }
  if (typing && e.target.id !== 'q') return;
  if (e.key === 'ArrowDown' || (e.key === 'j' && !typing)) { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp' || (e.key === 'k' && !typing)) { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter' && ui.sessions[ui.cursor]) { e.preventDefault(); openSession(ui.sessions[ui.cursor].session_id); }
});

let t;
$('#q').addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(() => { state.q = $('#q').value.trim(); ui.cursor = -1; load(true); },
    state.mode === 'content' ? 260 : 160);
});

/* ---------------- boot ---------------- */

setInterval(pollStatus, 45000);
pollStatus();

loadFacets();
syncControls();
load(true);
