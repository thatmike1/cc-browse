# cc-browse

Read your Claude Code conversations in a browser. One Python script that indexes
`~/.claude/projects/` into a SQLite cache and serves the UI, plus a hand-written
front end: the `ui.html` shell and `ui/` — one stylesheet and seven ES modules the
browser loads directly. No build step, no `node_modules`, no service.

It exists because the logs are already on your disk and there is no good way to
look at them. `claude --resume` shows a list of recent titles; the raw JSONL is
unreadable. This gives you every conversation you have ever had, grouped by day,
searchable three different ways, and readable as a transcript.

```bash
uv run ccbrowse.py              # index, serve on :4173, open a browser
uv run ccbrowse.py --port 8080
uv run ccbrowse.py --reindex    # discard the cache and rebuild from scratch
uv run ccbrowse.py --no-embed   # skip the semantic index
uv run ccbrowse.py --no-open    # do not launch a browser
```

Requires Python 3.10+. `uv run` is what pulls in `model2vec` and `numpy`, declared
as inline script metadata — they are the only dependencies and they only power
semantic search. Plain `python3 ccbrowse.py` runs everything else and the
`meaning` mode simply hides itself.

The server binds `127.0.0.1` and has no authentication. It is a local tool.

## Using it

The left pane lists sessions grouped by day, with the title, project, branch,
message count and the last thing that was said. Click one and the right pane
opens the transcript **scrolled to the end** — the tail is normally what you came
back for. Arriving from a search is the exception: then it scrolls to the best
match and opens the find bar, even when there are zero visible matches, because
landing at the tail with no explanation is baffling.

**Filters:** project and branch (both searchable popovers; the branch list
re-scopes to the selected project), a time range, and "titled only" for sessions
that carry a real generated title rather than a cleaned-up first prompt. Sort by
newest, oldest, longest, shortest, or best match. Active filters show as
dismissible pills next to the counts.

**Keyboard:** `/` focuses search, `↑`/`↓` or `j`/`k` move the cursor, `↵` opens,
`f` opens find-in-conversation, `n`/`N` cycle matches, `Esc` backs out of
whatever is in front of you. Popovers take arrow keys and `↵` too.

`reader` hides thinking, tool calls and tool results; the three toggles beside it
turn each back on individually. When a match is hiding behind a collapsed
toggle the find bar says so and offers to reveal it. The resume chip copies
`claude --resume <id>` to your clipboard.

While the server runs it re-indexes in the background every 60 seconds. New
conversations never swap the list out from under you — you get a pill offering
them.

## Live

The `live` view is a board of what is running on this machine right now: one card
per Claude Code session, sorted so anything blocked on you is at the top.

Claude Code keeps its own registry of running sessions — one small file per
session, rewritten whenever that session's state changes — so "this one is
sitting on a permission prompt" is a fact read off disk rather than guessed from
a timestamp. Each card carries the session's name and project, a status pill,
what it is doing, how long it has been quiet, and the run's token count. Nothing
has to be installed for this: no hook, no configuration change, no API call.

The status pill says `blocked on you` and names the kind of block — a permission
prompt, a worker request, a dialog. A status the registry does not report, or one
this tool does not recognise, shows as `unknown` rather than as idle: the
registry is undocumented internals and a session that stops reporting should look
unreadable, not fine.

The line under it is the point of the board, and it comes from the transcript
rather than the registry:

```
Bash · npm run build -- --profile        a call that is still running
Bash · npm test -- --run  failed         the call that just came back
Grep ×3 · SCHEMA_VERSION                 three calls out, the first one named
asked · rebuild the day view             a prompt with no reply yet
The vectors line up with the new rowids. the model mid-sentence
```

Thinking, compaction and delegated work currently fall back to a plain
`working`. When a transcript cannot be read the line is left empty instead of
guessed.

The board polls every few seconds, and only while you are looking at it. It reads
files and writes nothing.

## Search

**`titles`** matches titles, first prompts, project paths and branch names. Fast,
predictable, and blind to anything actually said.

**`full text`** searches every message body across every conversation, via SQLite
FTS5, ranked by bm25. Matched terms come back highlighted in the list snippet,
counted per session, and marked again inside the transcript when you open it.
Note that FTS5 splits on punctuation and underscores, so `SCHEMA_VERSION` matches
a message that said "schema" and "version" separately — the UI marks the pieces
too, or the hit the server found would be invisible.

**`meaning`** ranks by embedding similarity rather than literal terms, so a
search for *"the deploy kept dying overnight"* can surface the conversation where
you debugged a cron job that ran out of memory, using none of those words. It is
a recall tool: reach for it when you cannot remember the words you used, and
`full text` when you can.

Semantic results are ranked by match quality, never by date, and they come with
real false friends — "rate limiting" will also hand you messages about limiting a
blast radius and about exchange rates. The model is static (see below), so it
reads a message as a bag of token meanings with no context. That makes it good at
concrete subjects and weak at abstract ones: "feeling burnt out" drifts toward
anything containing "burn".

### From the command line

The same index answers without starting the server.

```bash
uv run ccbrowse.py search "materialized cte"          # full text, the default
uv run ccbrowse.py search "why the tests are flaky" --mode semantic
uv run ccbrowse.py search foo --project /path/to/repo --limit 5 --json
uv run ccbrowse.py list --limit 20
uv run ccbrowse.py show <session-id>                  # the full uuid, not a prefix
```

The CLI reads the cache and never rebuilds it — it prints a warning to stderr
when the index has fallen behind and answers from what it has, rather than making
you wait on a rebuild. Run the server once to build the index first.

## Titles

Claude Code does not write one title per session, it writes several kinds of
record, and which one you want depends on which exists. `cc-browse` walks a
precedence chain:

1. a `custom-title` record — a title the user typed, so it outranks everything
2. for a subagent, the `description` from its sidecar — a human-written one-liner
3. an `ai-title` record — what `/resume` shows you
4. a `summary` record
5. the first user prompt, with command wrappers, system reminders and
   local-command caveats stripped out

Plenty of sessions have none of the first four and fall through to the cleaned
prompt, which is shown in a dimmer weight so you can tell at a glance which
titles are real. "Titled only" filters the list down to the ones that are.

The obvious thing to reach for instead is `sessions-index.json`, the per-project
index file with `firstPrompt` and `summary` fields. It is deliberately **not**
used: Claude Code stopped maintaining it. On the machine this was built on the
newest one was months stale and most project directories had none at all.

## Subagents

Work delegated to a subagent is written to a separate transcript under
`<project>/<session-id>/subagents/`, usually with a `<name>.meta.json` sidecar
recording the agent's type, name, model, spawn depth and the `Task` call that
spawned it. Those transcripts are indexed too — which matters more than it
sounds, because on a heavily delegated session most of what was actually done
lives there and not in the parent log.

They are not browsable as their own rows. A hit inside a subagent transcript is
reported against the session that spawned it and flagged `via subagent` in the
list; opening that session shows the subagent transcripts as collapsible panels
above the conversation, fetched on demand.

A subagent's own log carries its *parent's* `sessionId`, so the row id has to be
derived from the file path instead. Nested spawns do not nest on disk — a
subagent that spawns its own subagents writes them flat into the same
session-level `subagents/` tree — so the path resolves to the top-level session,
and the sidecar's `parentAgentId` is what records the immediate spawner.

## Tokens, cost and lanes

Every assistant message records what the API charged for it, so indexing keeps a
per-model token bucket for each transcript: input, cache writes split by TTL,
cache reads and output. One API response is written to several adjacent JSONL
lines with the same totals, so the buckets are keyed by response id rather than
summed line by line; ids without the `msg_` prefix are client-side placeholders
that never went to the API and are skipped.

Cost is computed when you look at it, from a small price table in the script, and
never stored. Prices change and a stored cost would freeze them, while the token
buckets stay recomputable forever. A model with no entry in the table shows its
tokens and no cost rather than a wrong one. The figures are notional: a
subscription bills against usage limits, not per token, so they are for comparing
one run with another.

The cost lands in three places: the ambient figure on each list row, a chip in the
detail header covering the whole run (lead plus every agent it spawned, with a
per-model breakdown behind a click), and a line on each subagent panel.

A delegated session also gets a **lanes** view: one row per agent on a shared
timeline, so you can see what ran in parallel and what waited. A lane spans its
own transcript's first and last message. It is deliberately not derived from the
parent's `tool_result`, because a background-spawned `Task` reports back when the
child *launches*, not when it finishes — that reading makes every backgrounded
agent look instantaneous. An agent whose log was written to in the last minute or
so counts as running: its bar loses its right edge and keeps growing, and the
block re-polls while anything is live. The token figure beside a running bar
comes from the last index pass, so it lags the bar; the header says how old it is.

## Indexing

The first run scans every `*.jsonl` under `~/.claude/projects/` across a process
pool and caches per-session metadata plus a full-text index of message bodies in
`~/.cache/cc-browse/index.db`, keyed on mtime and size. Later runs only touch
changed files. Full transcripts are parsed on demand when you click one, never
during indexing.

Only around 2% of the raw JSONL is conversation text — the rest is tool results
and metadata — which is why indexing every word of it is affordable. A cold
rebuild of a corpus of a few thousand logs took about ten seconds on one Linux
x86 machine with the page cache warm, producing roughly 1 KB of database per
indexed message. The very first run is slower than that, because it also pays to
resolve dependencies and download the embedding model.

Sidechain sessions and sessions with no messages are indexed but never listed.

Bumping `SCHEMA_VERSION` in `ccbrowse.py` forces a full rebuild on next start. An
older cache cannot be migrated in place; it is deleted and rebuilt.

## Semantic index

`minishlab/potion-base-8M` via model2vec — a *static* embedding model: a token
lookup plus pooling, with no transformer forward pass. On one Linux x86 machine
it encodes at **~0.05 ms per message** — a corpus of a hundred thousand messages
embeds in about five seconds — so the index can simply be rebuilt wholesale
whenever the corpus changes. That property is the whole design: there is no
incremental embedding path to get wrong.

Vectors live in `~/.cache/cc-browse/vectors.npy` — 256 dimensions, float32,
L2-normalised, so roughly 1 KB per message. Search is one numpy matmul: about
7 ms across a hundred thousand vectors on that machine, with the full query
landing in ~130 ms once the top hits have been resolved back to their sessions.

**Why not [ternlight](https://github.com/soycaporal/ternlight)?** It is a
genuinely good library — a ternary-weight MiniLM distillation in a 10 MB WASM
bundle, running real transformer inference on-device with no API. Measured here
on the same 4,000 messages it took **28.4 ms each**, against model2vec's
fraction of a millisecond, and retrieval quality was not better. At that rate
full-corpus indexing would run for most of an hour instead of seconds. Its niche is
the browser and the edge at demo scale; this index is orders of magnitude larger
and gets built server-side, where a Python library has no reason to pay
transformer cost.

## Design decisions worth defending

**No component library, no framework, no build step.** The UI is hand-written HTML,
CSS and ES modules the browser loads as they are. Anything off npm would need a
bundler and a `node_modules` for a tool whose entire appeal is that you can run it
from a checkout.

**The FTS query uses a `MATERIALIZED` CTE.** Without it SQLite inlines the CTE,
`bm25()` loses its FTS context, and the query dies with *"unable to use function
bm25 in the requested context"*. The same query then aggregates in an outer pass,
which is what lets a subagent hit be attributed to its parent session while the
snippet still comes from the best-scoring row.

**The index is a cache, never a source of truth.** Everything in it is derived
from the JSONL, so throwing it away is always safe, and nothing is ever written
back to `~/.claude/`.

**Search results scroll to the match.** Landing at the tail of a 900-message
conversation after searching for a phrase is the single most annoying thing a
reader can do.

## Limitations

- `titles` mode does not search message bodies; `full text` does not understand
  synonyms; `meaning` does not do exact terms. All three exist because none of
  them is enough.
- Semantic matching is topical, not conceptual. Abstract phrasings drift.
- The CLI can answer from a stale cache. It tells you, but it does answer.
- Highlighting inside a transcript stops at 2,000 marks; the counter shows a `+`.
- Costs are list-price arithmetic over the tokens in the logs. They do not know
  about subscriptions, discounts, or usage a transcript never recorded.
- Benchmarks above were measured on one Linux x86 machine and are there for
  orders of magnitude, not as universal facts.

## Licence

MIT.
