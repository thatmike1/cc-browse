# cc-browse

A local reader for Claude Code conversation logs: index `~/.claude/projects/*.jsonl`
into a SQLite cache, serve a single-page UI over it. Every source file is edited by
hand — nothing is generated from anything else.

- `ccbrowse.py` — scanner, cache, HTTP server, JSON API, and the `search`/`list`/`show`
  CLI. Stdlib apart from `model2vec` + `numpy`, declared as PEP 723 inline metadata.
- `ui.html` — the shell: head, favicon and the markup. Links `ui/styles.css` and
  loads `ui/main.js` as a module.
- `ui/` — the front end proper: one stylesheet plus seven hand-written ES modules
  (`state`, `helpers`, `list`, `detail`, `timeline`, `live-board`, `main`). The
  browser loads them as they are; `ccbrowse.py` serves the directory at `/ui/`.

There is no build step, no test suite, no package manifest.

## Run and verify

```bash
uv run ccbrowse.py --port 4185 --no-open   # serve; --port avoids colliding with a live copy
uv run ccbrowse.py search "some phrase" --json
uv run ccbrowse.py list --limit 5
uv run ccbrowse.py show <full-session-uuid>   # a prefix returns "not found"
```

`uv run` is what supplies the optional dependencies; plain `python3 ccbrowse.py` runs
everything except semantic search, and the UI hides the `meaning` mode when the import
fails. Note that `uv run python …` does **not** read the inline metadata — importing
`ccbrowse` from an ad-hoc interpreter silently lands in the no-semantics branch.

**Verification means running the server and driving the real UI in a browser.** Almost
every bug in this codebase lives in the interaction between the transcript DOM, the
reader toggles and the match navigator, and none of it is visible in a diff.

Check `pgrep -f ccbrowse.py` before starting anything: a running copy re-indexes on its
own connection every 60 seconds, and `--reindex` deletes the shared cache out from
under it.

## Cache invariants

Everything under `~/.cache/cc-browse/` is derived and disposable, but three things in
it must be changed together or search silently returns wrong rows.

**`SCHEMA_VERSION` (top of `ccbrowse.py`) must be bumped whenever the cache shape
changes** — the `SCHEMA` DDL, the `COLUMNS` tuple, or what `scan_file` puts in a row.
There is no in-place migration: `connect()` deletes the database and rebuilds it, and
until that happens `open_cache()` makes the CLI refuse to answer at all. A full rebuild
of a few-thousand-log corpus measured ~10 s here with a warm page cache; treat it as
cheap, not free.

**The embedding matrix is positional, aligned to `msg_fts` rowids through the `vec_rows`
table.** Row *i* of `vectors.npy` is the message at `vec_rows.rid`. Change what goes into
the FTS index — `FTS_CHARS`, which roles or block kinds are indexed, the tokenizer — and
that alignment has to be rebuilt, or `meaning` results point at the wrong messages.
`_fingerprint()` (session count, max mtime, `msg_fts` row count) is the only thing that
triggers a rebuild, so a change that leaves the row *count* identical will not invalidate
it. Bump `SCHEMA_VERSION` in that case.

**`_remove_db()` unlinks `-wal` and `-shm` alongside the database.** A stale WAL fails
the next open.

## The FTS query

`bm25()` and `snippet()` only work inside a direct scan of the FTS table, so the content
query ranks in a CTE and aggregates outside it.

- The CTE must be `AS MATERIALIZED`. Inlined, `bm25()` loses its FTS context and SQLite
  raises *"unable to use function bm25 in the requested context"*.
- `MIN(score)` has to stay the query's **only** min/max aggregate. SQLite's bare-column
  behaviour is what makes the un-aggregated `snip` come from the best-scoring row; a
  second `MAX()` in the same `SELECT` breaks that. This is why `via` is summed.
- Hits are attributed to a listable session in the `mapped` CTE: a hit inside a subagent
  transcript counts for its parent. The `count_sql` twin has to apply the same mapping or
  the total disagrees with the page.

## Subagent identity

Subagent transcripts live at `<project>/<session>/subagents/**` with `<name>.meta.json`
sidecars. Their own log records the **parent's** `sessionId`, so `file_identity()`
derives the row id from the path (`<parent>~<tail>`); trusting `sessionId` collides every
subagent with its owner. Nested spawns are written flat into the same session-level
`subagents/` tree, so `rel[1]` is always the top-level session — the sidecar's
`parentAgentId` is the only record of the immediate spawner.

Subagent rows are searchable but never listable: `BASE_FILTERS` pins listing to
`kind = 'session'`.

## Token accounting

`scan_file` keys usage by `message.id`, not by line: one API response is written to
several adjacent lines carrying the *same* totals, so summing lines double-counts.
Ids without the `msg_` prefix are client-side `<synthetic>` placeholders and never
billed. Cache writes are split by TTL because a 1h write costs 2x base input and a
5m write 1.25x — one bucket for both misprices whichever kind dominates.

The row stores per-model token buckets only. **Cost is read-time**, from `PRICES` in
`ccbrowse.py`, so a price edit needs no `SCHEMA_VERSION` bump and no rebuild. An
unpriced model makes `usage_cost` return `None` — tokens with no cost beside them,
never a partial sum.

`{"type": "cost-state"}` records in recent logs are a useful oracle for the
arithmetic: the multipliers reproduce their per-model `costUSD` exactly. Their
totals can still run ahead of one transcript's own usage, so they check the
formula, not the coverage.

## Lanes

A lane spans the agent's own file's first→last message timestamp. Never derive the
end from the parent's `tool_result`: a background-spawned `Task` returns its result
when the child *launches*. Lanes anchor on the subagent's own `created` rather than
on a spawning tool call, because named team agents have no `toolUseId` at all.

"Running" is decided by a fresh `os.stat` at request time, not by the row's
`modified` — the indexed value lags a growing file by up to `REFRESH_SECS`, which is
why `ACTIVE_SECS` is larger than it.

## The live board

`/api/live` reads `~/.claude/sessions/<pid>.json`, the registry each running Claude
Code session rewrites whenever its own status changes. This is **undocumented
internals**: field names can move between releases with no notice.

- **A status is only ever what the file says.** Anything outside
  `waiting / busy / shell / idle` — including a missing or empty one — becomes
  `unknown`, which sorts *below* `idle` and renders as a dashed grey pill. Never map
  an unreadable status onto `idle`: a session that stops reporting must look
  unreadable, not fine.
- **Liveness is the pid plus its start time**, not the pid alone. `procStart` in the
  file equals field 22 of `/proc/<pid>/stat`, and comparing them is what catches a
  stale file whose pid has since been reused. `proc_start` counts fields from the
  last `)` because the comm field can contain spaces and parentheses.
- **The endpoint never waits on the refresh loop.** A session that started a minute
  ago has no indexed row yet and still belongs on the board — `transcript_path`
  derives its log from the cwd (every character outside `[A-Za-z0-9]` becomes a
  dash) so the activity line works before the index catches up.
- **The endpoint writes nothing and needs no schema bump.** It reads live files plus
  the existing index.

`claude agents --json` prints the same rows and verifies liveness itself, which makes
it the cross-check when the pid files stop parsing. It is not the poller: it spawns a
~200 MB binary per call.

### The activity line

The registry says a session is busy, never what it is busy *with*. That comes from
`activity_of`, a bounded reverse read of the transcript, and the rule is that **the
line names the work, not the bytes** — one clause, always with a subject.

- **Open calls are matched before anything else.** A `tool_use` with no `tool_result`
  after it is the most valuable line on the board and the one thing the registry can
  never say. It has to be decided first, or a result arriving for one of three calls
  reads as "just finished" while two are still running.
- **A finished call shows the call, never the result body.** Results are enormous and
  usually a wall of file contents. The outcome is appended only when it is bad.
- Four cases are worded — call in flight, call just finished, assistant prose, a
  prompt with no reply. Thinking, compaction and subagent recursion fall back to a
  bare `working`; an unreadable transcript renders an empty column, because an empty
  column is honest and a guessed one is not.
- `_clause` cuts from the **head**: a truncated command still reads from its head and
  is meaningless from its middle. Its quote-balancing is off by default and on only
  for shell text — in prose every apostrophe looks like an unclosed quote and the
  backtrack throws away most of the line.
- The indexed `tail` cannot serve this. `scan_file` stores prose only: it joins
  `text` blocks, skips tool-result-only user turns and never stores thinking, so the
  in-flight tool call is exactly what it drops.

The front end polls `/api/live` every 4 s and only while the board is visible —
`loadLive` is view-scoped and self-cancelling, the same contract as
`scheduleLanePoll`. Polling rather than SSE: the server is a stdlib
`ThreadingHTTPServer`, so every SSE client would pin a thread for its lifetime.

## Titles

Precedence in `scan_file`: `custom-title` → sidecar `description` → sidecar `name` →
`ai-title` → `summary` → cleaned first prompt → `(empty)`. `sessions-index.json` is
deliberately unused; Claude Code abandoned it.

`clean_prompt` strips wrappers in a specific order. `_ANY_TAG` caps tag length at 60
chars, which an attribute-bearing wrapper blows past — that is what `_ATTR_TAG` is for,
and subagent prompts arrive inside one, so removing it makes the wrapper tag become the
title.

## UI conventions

- **No framework, no dependencies, no build step.** The value proposition is a checkout
  you can run; anything off npm costs a bundler and a `node_modules`. The front end is
  split into ES modules the browser resolves itself, never a bundle.
- `ui/state.js` holds the only bindings that cross module boundaries (`state`, `show`,
  and the `ui` object carrying `sessions`/`cursor`/`activeId`/`nav`/`view`). Everything
  else stays a module-local `let` in the file that owns it, and DOM handles are
  re-declared per module rather than exported.
- The type scale is fixed at 11 / 12 / 14 / 16 / 20 px (14 arrives via the `body` font
  shorthand). `impeccable detect ui/styles.css` reports `flat-type-hierarchy` — it wants a
  ≥ 2.0 ratio between the extremes and this scale is 1.8 — plus five
  `design-system-color` findings for the accent alpha variants. Both are **known and
  accepted**; keep the scale as it is rather than inflating headings to clear the check.
- The server marks FTS snippets with `\x02`/`\x03` control characters, never HTML, so
  highlighting survives escaping in the client. Keep it that way.
- One match model serves both arrivals-from-search and the find bar: `marks` is every hit
  in the DOM, `nav` the subset not collapsed behind a reader toggle. Anything that reveals
  or hides text (toggles, opening a subagent panel) has to call `refreshNav`.
- Match marking stops at 2,000 hits and the counter shows a `+`.

## Conventions

- Comments here carry the *why*. The verified-the-hard-way gotchas above are the
  expensive knowledge in this repo, and the ones written down cost someone a rebuild
  to find.
- Docstrings carry the contract for the functions whose behaviour is not guessable:
  `file_identity`, `read_sidecar`, `agent_tool_calls`.
- This repo is public and the tool reads private conversation logs. Nothing derived
  from a real corpus belongs in tracked files — no absolute home paths, no session
  counts or corpus statistics, no project or branch names, no quoted messages. Use
  invented examples in documentation.
