# Decision log

The "why" behind Session Bandit's structure. These were the non-obvious
decisions made during the v1 build — captured now while the context is fresh,
because the rationale is expensive to reconstruct later from the code alone.

Each entry lists the **decision**, the **context** that forced it, the
**rationale** for the chosen option, and the **consequences** / trade-offs.

For the "what" and "how", see the [PRD](prd.md), the
[adapter guide](adapters.md), and the source. For future scope, see the PRD's
"Out of scope for v1" and "Non-goals".

## Architecture

### 1. Ship library + CLI together from v1 (not CLI-first)

**Decision.** `@session-bandit/core` (the library) and `session-bandit` (the
CLI) both ship in v1. The CLI is a thin Commander front-end over the library;
it owns no parsing logic.

**Context.** The obvious MVP shape is a single CLI binary that does
everything. A library is only needed once a second consumer appears.

**Rationale.** The downstream project that motivated Session Bandit needs to
index and query sessions programmatically, not via a subprocess. Building the
library first avoids a painful v2 "extract the library from the CLI" refactor,
and gives downstream consumers an integration path from day one. The cost is
small — the CLI is genuinely thin (`scan.ts` is ~50 lines of glue).

**Consequences.** Two packages instead of one, with a workspace dependency.
The `ScanFn` injection seam (below) exists precisely to keep the CLI testable
without coupling it to the library's real scanner.

### 2. No persistence in v1 — fresh in-memory scan every run

**Decision.** Every CLI invocation re-scans `~/.claude/projects` and
`~/.codex/sessions` from scratch. No SQLite, no index file, no incremental
updates.

**Context.** A persistent index would make repeat queries instant and enable
richer features (history, deltas).

**Rationale.** Session files are small JSONL and there aren't that many of
them; a full scan of ~1000 sessions is sub-second on a normal machine. Adding
persistence introduces a native dependency (`better-sqlite3`), a schema to
maintain, invalidation logic, and a whole class of "stale index" bugs — none of
which pay for themselves at this scale.

**Consequences.** Every command pays the scan cost once. SQLite / incremental
indexing is explicitly deferred to a later version, gated on *measured* scan
time becoming a problem (it isn't yet).

### 3. No native dependencies

**Decision.** The project depends only on pure-JS packages (`commander`,
`tsup`, `vitest`, `tsx`, `typescript`). No `better-sqlite3`, no `node-gyp`, no
native modules.

**Context.** Native deps complicate install across Node versions / platforms
and are the usual reason a tool fails to `pnpm install` cleanly.

**Rationale.** Reinforces #2 (no persistence → no SQLite). Also keeps the
install story trivial for anyone cloning the repo. The one place a native dep
would have helped — decompressing Codex's `.jsonl.zst` files — was cut (see #10).

**Consequences.** `.jsonl.zst` session files are skipped (no zstd). Everything
else works with a plain `pnpm install`.

## Adapter design

### 4. Adapters must skip unrecognized lines, never throw

**Decision.** An adapter's `parse()` must never throw on content it doesn't
understand — not a malformed line, not an unknown `type`, not a missing field.
Unrecognized content is skipped; a session with zero parseable messages is
still returned with `messageCount: 0`.

**Context.** Provider JSONL schemas drift over time, and a single corrupt line
in a single file should not abort an entire scan.

**Rationale.** This is the single most important resilience rule in the
project. It guarantees the index is always *complete* (every file contributes a
`Session`, even if empty) and that format drift degrades gracefully (new fields
are ignored, not fatal). `readJsonl()` enforces this at the line level; each
adapter enforces it at the item level.

**Consequences.** The `Adapter` interface contract is load-bearing — any new
adapter must honor it. Format drift becomes "add a case", not "rewrite the
adapter" (see the [adapter guide](adapters.md)).

### 5. The normalized model is the single seam

**Decision.** One common `Session` / `Message` / `ToolCall` shape. Adapters
map into it; everything else (CLI, search, formatters) operates on it and knows
nothing about provider formats.

**Context.** Multiple agents with different on-disk formats need to be queried
uniformly.

**Rationale.** The normalized model is the seam that keeps adapters swappable.
Adding an agent means writing one module that maps to this shape — nothing else
changes. This is also what makes downstream library use feasible (#1).

**Consequences.** Some provider-specific detail is lost (see #6, #7). Fields
are nullable where a provider doesn't reliably populate them.

### 6. Codex tool-call status: output overrides item status

**Decision.** For Codex, a tool call's `status` field is initial, but the
*output* is ground truth: if the output's `metadata.exit_code` is present and
non-zero, the call is `error` even if the item said `completed`.

**Context.** Codex marks a shell command `status: "completed"` when it *ran*,
not when it *succeeded*. A command that exits non-zero is still "completed" by
this definition but is a failure from the user's perspective.

**Rationale.** The exit code is the only reliable signal of success. Trusting
the item `status` would report failing commands as `ok`. Claude doesn't have
this problem — its `tool_result` block carries `is_error` directly — so the
override is Codex-specific.

**Consequences.** A Codex `ToolCall.status` can differ from the raw item
status. Callers that want the raw value must read the provider format
themselves. The inference is best-effort: if the output isn't JSON or has no
`exit_code`, it defaults to `ok`.

### 7. Thinking / reasoning blocks are excluded from `Message.text`

**Decision.** Claude `thinking` blocks and Codex `reasoning` items are not
included in `Message.text`. They're dropped entirely (not stored elsewhere on
the message).

**Context.** These blocks can be large, encrypted, and are not human-authored
prose. Including them would bloat `text` and make search/full-text noisy.

**Rationale.** `Message.text` is meant to be human-readable transcript text.
Keeping reasoning out makes `show` output and `search` results cleaner. The two
adapters apply the same rule for consistency.

**Consequences.** Reasoning content is currently inaccessible through the
normalized model. Flagged as a potential v2 extension point (e.g. a separate
`reasoning` field) if a use case emerges.

### 8. Codex `developer` / `system` messages are skipped

**Decision.** Codex `message` items with `role: "developer"` or `"system"` are
not emitted as messages.

**Context.** These carry injected permissions instructions and AGENTS.md
content — they're agent configuration, not user-visible conversation.

**Rationale.** Surfacing them would flood the transcript with duplicated
permission boilerplate on every turn. They're not part of what a person reading
the transcript wants to see.

**Consequences.** The normalized transcript contains only `user` and
`assistant` turns (plus tool calls). The raw injected instructions remain in the
source file if ever needed.

## CLI design

### 9. Output defaults to JSON lines; `--pretty` is opt-in

**Decision.** `list` and `search` emit one JSON object per line by default.
`--pretty` switches to a human-readable table / excerpt view.

**Context.** The CLI has two audiences: humans in a terminal, and LLMs /
scripts using it as a tool.

**Rationale.** JSON lines is machine-friendly (pipeable, parseable,
greppable) and is the safer default for a tool that will often be invoked
programmatically. Humans opt into the table with one flag. `show` has no
`--pretty` because a transcript is inherently human-readable prose.

**Consequences.** A human running `list` raw gets a wall of JSON — they should
pass `--pretty`. Scripts get structured output for free.

### 10. `--project` uses substring match, not exact path

**Decision.** `--project <path>` filters sessions where the query is a
case-insensitive substring of `project` *or* `cwd`.

**Context.** Exact-path matching would require knowing the exact working
directory a session used, which is tedious to type and varies by machine.

**Rationale.** Substring match is far more ergonomic — `--project botbandit`
matches `/home/user/projects/botbandit-ng` without knowing the full path.
Matching both `project` and `cwd` covers adapters that populate one but not
the other.

**Consequences.** A short query could over-match. Acceptable for an
interactive filter; users can make the query more specific.

### 11. `show` matches by full id OR prefix, with ambiguity detection

**Decision.** `show <id>` matches a session whose `sessionId` equals the
argument *or* starts with it. If the prefix matches multiple sessions, it
errors and lists the candidates instead of guessing.

**Context.** Session ids are long UUIDs; typing the full thing is painful.

**Rationale.** Prefix matching makes `show` usable interactively. Ambiguity
detection prevents silently showing the wrong session when a prefix is too
short. The `--agent` filter can disambiguate further.

**Consequences.** A too-short prefix errors rather than picking arbitrarily —
a deliberate trade of a bit of convenience for correctness.

### 12. Commands take an injected `ScanFn`, not the real scanner

**Decision.** Each CLI command is constructed with a `ScanFn` (`() => Session[]`)
injected at program-assembly time. The real CLI passes `scanAll`; tests pass a
function returning fake sessions.

**Context.** Testing `list`/`show`/`search` against the real `~/.claude` and
`~/.codex` would be flaky, machine-specific, and violate the offline-tests
requirement.

**Rationale.** Injection makes the commands pure functions of (sessions,
args) → output. Tests assert output against injected fixtures with zero
filesystem access. This is the seam that makes the thin-CLI design (#1)
testable.

**Consequences.** Command factories take a `ScanFn` argument rather than
importing `scanAll` directly. A small structural cost for fully isolated tests.

## Scope cuts (deferred, not rejected)

### 13. Gemini CLI deferred to a later version

**Decision.** v1 ships Claude and Codex adapters only. Gemini is out of scope.

**Context.** The Gemini format is known and feasible (documented in the
feasibility research).

**Rationale.** Cut solely to keep the v1 milestone finishable. Two adapters
already prove the adapter pattern end-to-end; a third adds length without
proving anything new about the architecture.

**Consequences.** Gemini sessions aren't indexed in v1. The adapter guide uses
Gemini as its worked example so the path is documented even though it isn't
implemented.

### 14. Usage / quota dashboard deferred

**Decision.** v1 does not surface token usage or remaining quota.

**Context.** Claude's `~/.claude/stats-cache.json` makes an offline usage view
nearly free to add; Codex emits per-turn `token_count` events in-session.

**Rationale.** Usage is a separate feature, not needed to prove the indexing
core. Deferring keeps v1 focused. The adapter already skips Codex
`token_count` / rate-limit events cleanly, so a future usage feature can read
them without a format change.

**Consequences.** No usage data in v1. The data is reachable later without
re-parsing sessions.

### 15. Codex `.jsonl.zst` files not supported in v1

**Decision.** Compressed Codex session files (`.jsonl.zst`) are silently
skipped by `discover()`.

**Context.** Some Codex sessions are written compressed on disk.

**Rationale.** Reading them requires a zstd dependency (native or wasm),
which conflicts with the no-native-deps rule (#3) and adds weight for a format
variant that may be rare. Uncompressed `.jsonl` covers the common case.

**Consequences.** Compressed sessions are invisible to v1. Adding zstd support
later is a discover/parse change localized to the Codex adapter.

### 16. `gitBranch` captured but not surfaced

**Decision.** The Claude adapter reads `gitBranch` from session lines but
does not expose it on the normalized `Session` type.

**Context.** Branch is useful for grouping sessions but isn't part of the core
query model.

**Rationale.** Keep the normalized model minimal until a feature actually
needs the field. Capturing it in the adapter means surfacing it later is a
type change, not a re-parse.

**Consequences.** Branch info is parsed and discarded today. Available on
request for a future "group by branch" view.