// the only bindings that cross module boundaries. everything else stays a
// module-local `let` in the file that owns it.

export const state = {
  q: '', mode: 'meta', project: '', branch: '', since: '', titled: '', lanes: '',
  mincost: '', sort: 'recent',
};

export const show = { thinking: false, tool: false, tool_result: false };

export const ui = {
  sessions: [],   // written by list.js, read by detail.js and main.js
  cursor: -1,     // written by list.js and main.js
  activeId: null, // written by detail.js, read by list.js and main.js
  nav: [],        // written by detail.js, read by main.js
  view: 'list',   // written by timeline.js, read by list.js, live-board.js, main.js
};
