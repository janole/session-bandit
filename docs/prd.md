# Session Bandit — Product Requirements Document

Status: **Draft** · Last updated: 2026-06-20

## Purpose

Search, browse, and extract information from the local session transcripts
written by every coding agent you use — Claude Code, Codex, Gemini CLI, and
others — plus a view of how much you've been using each one.

The core insight: every major coding agent writes its full session history to
disk as JSONL. There is no API to call and no auth to manage for search and
extract — it's a local-file indexing problem. That makes the core of Session
Bandit cheap, offline, and fast.

## Primary feature: session extracts (v2)

Search/browse (v1) is the foundation. The **payoff** is extracts: turning a
session into a reusable handoff, memory note, or "what happened here" summary
that answers what was done, how substantial it was, and what files were
touched. This is what connects Session Bandit to the botbandit memory system.

**Session Bandit stays offline.** It computes a structured **digest**
(substance/importance score, files touched, commands + outcomes, errors, key
turns) from the normalized model — no LLM call. The consuming agent's LLM does
the natural-language synthesis, fed the digest via a skill. Full design,
digest shape, and the grounded importance heuristic live in
[`docs/extract.md`](extract.md).

## Out of scope for v1

- Gemini CLI support (adapter comes in v2).
- Usage / quota dashboard (comes after the index works).
- Session persistence / incremental indexing — v1 does a fresh scan each run.
- Network access, provider APIs, auth.
- TUI / web surfaces.

## Tech stack (fixed)

- **Language:** TypeScript (strict mode, no `any`).
- **Package manager:** pnpm.
- **Runtime:** Node.js 22 LTS.
- **Monorepo:** two pnpm workspaces — `packages/core` (the library) and
  `packages/cli` (the `session-bandit` command). The CLI depends on `core`.
- **CLI framework:** Commander.
- **Build:** `tsup` for both packages (ESM, type declarations).
- **Tests:** `vitest`. Real session files from `tests/fixtures/**` — no
  network, no live `~/.claude` / `~/.codex` access in tests.
- **No native dependencies.** No SQLite, no `better-sqlite3`. v1 is a fresh
  in-memory scan; persistence is a later decision.
- **Lint/format:** keep it light — `tsc --noEmit` as the gate, optional
  prettier later.

## Products

### `@session-bandit/core` (`packages/core`)

The reusable library. Crawls agent session directories, parses each JSONL
session, and normalizes it to a common model. Exposes a programmatic API a
human CLI or another library (e.g. the main botbandit project) can call
directly — no CLI knowledge, no Node `fs`-path assumptions beyond what the
caller passes in.

### `session-bandit` CLI (`packages/cli`)

A thin front-end over `@session-bandit/core`. Targets: humans running it in a
terminal, and LLMs invoking it as a tool via a skill. Output is
machine-friendly by default (JSON), with an optional `--pretty` / human mode.

Commands:

```
session-bandit scan                          # build the in-memory index (implicit; run on every invocation)
session-bandit list [--agent <name>] [--project <path>] [--sort importance] [--min-importance <tier>]
session-bandit show <sessionId>
session-bandit search <query> [--agent] [--project]
session-bandit extract <sessionId> [--prompt handoff|memory] [--full] [--pretty]
```

`list` defaults to JSON lines; `--pretty` prints a table. `show` prints the
normalized transcript. `search` does full-text search over session content.
`extract` emits a structured **digest** (see [`extract.md`](extract.md)) for
LLM ingestion; `--prompt` wraps it in a ready-to-send synthesis prompt.

## Normalized session model

The common shape every provider adapter maps its JSONL into. This is the
single most important contract in the project — it is the seam between "core"
and "per-provider adapter", and it is what keeps adapters swappable.

```ts
type AgentName = "claude" | "codex" | "gemini"; // extend as adapters land

interface Session {
  agent: AgentName;
  sessionId: string;
  filePath: string;          // source JSONL file, for debugging / "show"
  project: string | null;    // best-effort project/cwd label, or null
  cwd: string | null;        // working dir if recoverable from the session, else null
  startedAt: string;         // ISO 8601
  endedAt: string | null;    // ISO 8601, or null if unknown
  model: string | null;      // primary model if recoverable, else null
  messageCount: number;
  messages: Message[];
}

interface Message {
  role: "user" | "assistant" | "system" | "tool" | "summary";
  text: string;              // human-readable text content (concatenated for assistant)
  subtype?: string;          // for `summary`: "recap" (Claude away_summary) | "compaction" (Codex compacted)
  toolCalls: ToolCall[];     // tool invocations attached to this message, if any
  timestamp: string | null;  // ISO 8601 if present in source, else null
}

interface ToolCall {
  name: string;              // e.g. "bash", "write_file", "local_shell_call"
  input: unknown;            // raw tool input, provider-specific shape
  status: "ok" | "error" | "unknown";
  output: string | null;     // truncated/summarized output, or null
}
```

Rules:
- Adapters **must not throw** on an unrecognized line — they skip it and
  continue. A session with zero parseable messages is still returned (with
  `messageCount: 0`), so the index is always complete.
- `text` is always a string (never `undefined`). Empty turns use `""`.
- Timestamps are ISO 8601 strings or `null` — never invented.

## Adapter interface

```ts
interface Adapter {
  readonly agent: AgentName;
  /** Default root directory for this agent's sessions (e.g. ~/.claude/projects). */
  defaultRoot(): string;
  /** Discover session files under a root directory. */
  discover(root: string): string[];
  /** Parse one session file into the normalized model. */
  parse(filePath: string): Session;
}
```

Core flow: for each registered adapter, call `discover(root)` → for each file
call `parse(file)` → collect into `Session[]`.

v1 ships two adapters:
- **Claude adapter** — root `~/.claude/projects`, walks `<encoded-cwd>/*.jsonl`.
  Encoded cwd = working dir with `/` replaced by `-`. Parse lines by `type`:
  `user`/`assistant`/`message`/`tool_use`/`tool_result`/`thinking`. Recover
  `project`/`cwd` from the directory name and/or session metadata.
- **Codex adapter** — root `$CODEX_HOME/sessions` (default `~/.codex/sessions`),
  recursively find `rollout-*.jsonl` (handle the `YYYY/MM/DD/` layout and legacy
  flat files). First line is metadata `{id, timestamp, instructions}`; then
  `{type, role, content}` messages and `{type, id, call_id, status, action}`
  tool calls. `cwd` often lives in the metadata/instructions — extract
  best-effort.

## MVP scope and acceptance criteria

> Scan `~/.claude/projects` and `~/.codex/sessions`, build an in-memory index
> of sessions normalized to the common model, and expose `list`, `show`, and
> `search` through the `@session-bandit/core` library and the `session-bandit`
> CLI.

**Done when:**

1. **Workspace** — `pnpm install` at the repo root works; `pnpm -r build`
   builds both packages; `pnpm -r test` passes. No native deps.
2. **Claude adapter** — against real `~/.claude/projects` on this machine,
   `session-bandit list --agent claude` returns every Claude session with
   `agent`, `sessionId`, `project`, `startedAt`, `messageCount`, `model`. At
   least one fixture-based unit test parses a real Claude JSONL excerpt and
   asserts the normalized shape.
3. **Codex adapter** — same, against `~/.codex/sessions`, returning Codex
   `rollout-*.jsonl` sessions. Unit test with a real Codex JSONL excerpt.
4. **`list`** — `session-bandit list` lists sessions from both agents, sorted
   by `startedAt` descending. `--agent` and `--project <path>` filters work.
   Default output is JSON (one object per line); `--pretty` prints a table.
5. **`show`** — `session-bandit show <sessionId>` prints the normalized
   transcript: user/assistant turns and tool calls. Works for a session id
   from either agent.
6. **`search`** — `session-bandit search <query>` does case-insensitive
   full-text search over session `messages[].text` and returns matching
   sessions (or matching messages with their session id — pick the simpler
   useful shape). `--agent` / `--project` filters apply.
7. **No network, no auth** — the CLI runs fully offline. Tests use only
   `tests/fixtures/**`.
8. **README** — root `README.md` documents install + the three commands with
   example output.

## Non-goals / explicit decisions

- **No persistence in v1.** Every CLI invocation scans fresh. Session files
  are small JSONL and there aren't that many; a full scan is sub-second.
  SQLite / incremental indexing is a later decision, gated on measured scan
  time.
- **No Gemini in v1.** Format is known and feasible (see feasibility doc);
  it's cut from v1 only to keep the milestone finishable.
- **No usage/quota in v1.** Claude's `~/.claude/stats-cache.json` makes an
  offline usage dashboard nearly free, but it's a separate feature and not
  needed to prove the indexing core.
- **Library and CLI ship together.** The CLI is a thin Commander front-end
  over the library. This avoids a v2 "extract the library" refactor and gives
  the main botbandit project a direct integration path from day one.

## Risks

- **Format drift.** Providers change JSONL schemas. Mitigation: thin,
  explicit adapters that skip unrecognized lines (never throw) and fail loudly
  in tests on known-shape regressions.
- **Token/model recovery.** Codex sessions may not store per-turn token
  counts or a single "primary model" the way Claude does. v1 fields
  (`model`, `messageCount`) are best-effort and nullable where needed.
- **Scope creep.** This PRD is the scope. Anything outside "Out of scope for
  v1" / "Non-goals" is deferred — including, deliberately, usage, Gemini, and
  persistence.

## Build order (for the implementing agent)

1. Repo + pnpm workspace + both packages scaffolded (`tsup`, `vitest`,
   Commander). `pnpm -r build` and `pnpm -r test` run green with a trivial
   test.
2. `@session-bandit/core`: define the normalized model + `Adapter` interface +
   an indexing function that takes adapters and roots and returns `Session[]`.
3. Claude adapter + fixture test.
4. Codex adapter + fixture test.
5. CLI `list` (JSON + `--pretty`), `show`, `search`.
6. README with examples.
7. Verify all acceptance criteria pass.
