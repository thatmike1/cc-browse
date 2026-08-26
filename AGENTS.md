# Agent Instructions

`cc-browse` indexes Claude Code conversation logs (`~/.claude/projects/*.jsonl`) into a
SQLite cache and serves a single-page UI over it. Two files, edited independently:
`ccbrowse.py` (scanner, cache, HTTP API, CLI) and `ui.html` (the entire front end —
hand-written, no framework, no build step).

## Running it

```bash
uv run ccbrowse.py --port 4185 --no-open   # serve
uv run ccbrowse.py search "some phrase" --json
uv run ccbrowse.py list --limit 5
uv run ccbrowse.py show <full-session-uuid>   # a prefix returns "not found"
```

`uv run` supplies `model2vec` + `numpy` from the script's inline metadata; plain
`python3 ccbrowse.py` runs everything but semantic search. `uv run python …` does *not*
read that metadata, so importing `ccbrowse` from an ad-hoc interpreter lands in the
no-semantics branch without saying so.

Run `pgrep -f ccbrowse.py` first. A live copy re-indexes on its own connection every
60 seconds and `--reindex` deletes the shared cache out from under it; pick a spare port.

## Verifying

**Drive the real UI in a browser.** The interesting failures live in the interaction
between the transcript DOM, the reader toggles and the match navigator, and none of them
show up in a diff or in an API response. There is no test suite to lean on.

## Before you change the cache or the index

- Bump `SCHEMA_VERSION` whenever the cache shape changes (the `SCHEMA` DDL, `COLUMNS`, or
  what `scan_file` writes). There is no migration — the database is deleted and rebuilt,
  and the CLI refuses to answer until that happens. ~10 s for a few thousand logs.
- `vectors.npy` is aligned to `msg_fts` rowids through the `vec_rows` table. Changing what
  goes into the FTS index moves those rowids, so the vectors must be rebuilt or `meaning`
  results point at the wrong messages. Only `_fingerprint()` triggers a rebuild, and it
  cannot see a change that leaves the row count intact — bump `SCHEMA_VERSION` as well.
- The content query's CTE must stay `AS MATERIALIZED`, and `MIN(score)` must stay its only
  min/max aggregate. Details and the exact failure modes are in `CLAUDE.md`.
- A subagent log records its *parent's* `sessionId`; row ids come from the file path.

## Tokens and lanes

Usage is keyed by `message.id` (the same response is written to several lines with
identical totals) and cache writes are split by TTL. Cost is computed at read time
from `PRICES`, so changing a price needs no schema bump. A lane's end comes from the
agent's own transcript, never the parent's `tool_result` — details in `CLAUDE.md`.

## Editing `ui.html`

No framework, no npm, no build step — that constraint is the product, not an accident.
The type scale is fixed at 11 / 12 / 14 / 16 / 20 px. `impeccable detect ui.html` reports
`flat-type-hierarchy` and five `design-system-color` findings against it; both are known
and accepted, so leave the scale alone rather than inflating headings to clear the check.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation
prompts. `cp`, `mv` and `rm` may be aliased to `-i` on some systems.

```bash
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file
rm -rf directory            # NOT: rm -r directory
```

`ssh`/`scp` take `-o BatchMode=yes`, `apt-get` takes `-y`.

## What must not be committed

This tool reads private conversation logs, and the repo is public. Nothing derived from
a real corpus belongs in a tracked file: no absolute home paths, no session or message
counts, no project or branch names, no quoted messages. Documentation examples are
invented ones. The cache itself lives outside the repo, under `~/.cache/cc-browse/`.
