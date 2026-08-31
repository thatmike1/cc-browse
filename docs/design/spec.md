# UI direction, settled 31 August 2026

Five changes, agreed off the design canvas. `mockups/` holds a static HTML
mockup per change, built on the real tokens from `ui.html` — open one in a
browser, or read it for exact colours, spacing and control heights. The mockups
show the look; this file carries the intent, which a mockup cannot state.

Colour, radius and control-height values in the mockups are lifted from
`ui.html`'s `:root`. Do not round them.

## 1. Scope drawer replaces the top-bar filter row

`mockups/scope-drawer.html`, against `mockups/baseline-today.html`.

The bar today carries eight controls. Project, branch, range and the three
"only show" flags move into an overlay drawer, 300px, opened by a chip in the
bar or `S`, closed by `Esc`. The chip reads back the current scope as
`cc-browse / main / 30d`.

A drawer, not a sidebar: it floats over the content and costs a gesture, where a
sidebar would own width permanently. Scope gets set rarely and read constantly.

Inside the drawer: one row height for projects and branches (no pills), colour
bar per project matching the day chart's project colours, checkboxes for the
three flags, and a footer counting how many sessions the current scope matches.
That count is the point — it tells you the result before you close the panel.

## 2. Search runs all three modes at once

`mockups/blended-search.html`.

The `titles / full text / meaning` segmented control comes out. All three modes
run on every query, results rank together, and chips below the bar narrow what
came back rather than deciding what you get. Each chip shows its own hit count
and timing.

The timings make the design defensible on screen: semantic is one numpy matmul,
titles is trivial, full text is the slow one. All three fit inside one
keystroke's budget.

Open question for implementation: bm25 scores and cosine similarities are not
on the same scale, so blending them into one ranked list needs a normalisation
rule. Pick one and write it down in the code.

## 3. Live leaves the view segment

`mockups/live-board.html`, and visible in every other mockup's header.

`live` is not a way of looking at the same list, so it comes out of the
`list / day / week / month` segment and becomes its own button on the far right
of the bar, carrying one number: sessions **waiting on you**. Not running.
Running is ambient; waiting is the only count that costs something by being
missed.

## 4. Live board: triage, cache timers, and what finished

`mockups/live-board.html`.

- The one session blocked on you takes the top of the screen, with its actual
  question quoted and how long it has been stopped.
- Every row carries a prompt-cache countdown with a depleting bar. On an idle
  session this is the useful number: it says whether coming back in twenty
  minutes is free or expensive.
- A spend sparkline per row, and one for the last ten minutes in the header.
- A "finished while you were away" section. A session that ended with four
  uncommitted files has no home in the UI today.

Answering a blocked session from the board was considered and cut.

**Data source.** The prompt-cache and rate-limit figures never reach the JSONL —
Claude Code hands them only to a statusline hook. `~/.claude/statusline-cav.sh`
already stashes each session's raw payload at
`~/.cache/cc-browse-tray/status/<session-id>.json`, write-then-rename. Read
`prompt_cache.expires_at`, `prompt_cache.ttl` and
`prompt_cache.recache_tokens_if_cold` from there. The same file carries
`rate_limits.five_hour` if the block reset is wanted later.

## 5. Day chart: every agent on one axis

`mockups/day-chart.html`. Built on the real 28 August 2026 index data.

One row per **project**, not per session. Sessions per day run 10–23, but
distinct projects run 1–7: over 188 indexed days the distribution is 30 days at
one project, 47 at two, 52 at three, 30 at four, 17 at five, 8 at six, 3 at
seven, one outlier at 24. Four hues cover 85% of days, five cover 94%. The
existing palette supplies four plus grey; past that the tail collapses to grey.

Three things the real data forces:

- Sessions inside one project overlap constantly — a lead session ran 09:20 to
  21:22 on 28 August while ten others came and went underneath it. A project row
  packs into sublanes only where it has to.
- Sessions of a few seconds (probes, a stray `/config`) render as ticks, not
  bars, or they vanish.
- `/tmp` scratchpad paths group into one grey `scratch` row rather than claiming
  a colour.

The row labelled `you` is the new idea: where attention actually was, session by
session. Every hatched stretch below it is a session that stopped because
attention was elsewhere on the chart.

**Not yet possible.** The `you` row, the hatching, and the three summary figures
need per-message timestamps. `sessions` carries `created` and `modified` per
transcript and nothing finer, so this needs a schema addition and a
`SCHEMA_VERSION` bump. Everything else on the chart works off what is indexed
today.

`mockups/critical-path.html` is the same idea inside one run — spawn and
report-back as edges, the chain that set the wall clock highlighted. Cheaper to
build than the day chart, and it needs spawn/report timestamps rather than
per-message ones.

## Cut

The table/grid list view and the transcript reader's minimap and right rail were
drawn, reviewed and dropped.

## Sequencing

The `ui.html` split into `ui.html` + `ui.css` + ES modules lands first;
everything here is new code that should go into the resulting modules rather
than into the 2151-line file.

Then: 1–3 are pure front-end and can go together. 4 needs a small endpoint in
`ccbrowse.py` reading the status stash. 5 needs the schema work and is its own
piece.
