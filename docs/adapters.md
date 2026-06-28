# Adapter authoring guide

How to add a new agent to Session Bandit, and how to adapt an existing agent
when its on-disk format changes.

The core idea: every agent writes its session history to disk as JSONL. An
**adapter** is a small module that knows where one agent's files live and how
to parse one file into the normalized model. Adapters are the only place that
knows about a specific agent's format — everything else operates on the
normalized `Session`.

## The contract

### The normalized model (the seam)

Every adapter maps its raw format into one common shape, defined in
`packages/core/src/types.ts`:

```ts
type AgentName = "claude" | "codex" | "gemini" | "botbandit"; // extend as adapters land

interface Session {
  agent: AgentName;
  sessionId: string;
  filePath: string;          // source file, for "show"
  project: string | null;    // best-effort project/cwd label
  cwd: string | null;        // working dir if recoverable, else null
  startedAt: string;         // ISO 8601
  endedAt: string | null;   // ISO 8601, or null
  model: string | null;      // primary model if recoverable, else null
  messageCount: number;
  messages: Message[];
}

interface Message {
  role: "user" | "assistant" | "system" | "tool" | "summary";
  text: string;              // human-readable, always a string (never undefined)
  subtype?: string;          // for `summary`: "recap" | "compaction" | "memory" — semantic kind
  toolCalls: ToolCall[];
  timestamp: string | null;  // ISO 8601 or null — never invented
}

interface ToolCall {
  name: string;              // e.g. "bash", "shell", "apply_patch"
  input: unknown;            // raw tool input, provider-specific shape
  status: "ok" | "error" | "unknown";
  output: string | null;
}
```

### The Adapter interface

`packages/core/src/adapter.ts`:

```ts
interface Adapter {
  readonly agent: AgentName;
  defaultRoot(): string;            // e.g. "~/.claude/projects"
  discover(root: string): string[]; // find session files under root
  parse(filePath: string): Session;  // parse one file → normalized model
}
```

Three methods. That's the whole contract.

### The golden rules

These are non-negotiable, and they're what make the index resilient to
format drift:

1. **Never throw.** Adapters must not throw on unrecognized content. A
   malformed line, an unknown `type`, a missing field — all skipped. A
   session with zero parseable messages is still returned (with
   `messageCount: 0`), so the index is always complete. One bad file never
   aborts a scan.
2. **`text` is always a string.** Empty turns use `""`, never `undefined` or
   `null`.
3. **Timestamps are ISO 8601 strings or `null`.** Never invented, never
   coerced from a non-ISO source.
4. **Thinking/reasoning blocks are excluded from `Message.text`.** Keeps the
   transcript human-readable. (Flagged as a potential v2 extension point.)

## Adding a new agent

Let's say we're adding Gemini CLI.

### 1. Register the agent name

Add it to the `AgentName` union in `packages/core/src/types.ts`:

```ts
export type AgentName = "claude" | "codex" | "gemini" | "botbandit";
```

Also add it to the CLI's validator in `packages/cli/src/scan.ts` (`isValidAgent`).

### 2. Write the adapter

Create `packages/core/src/adapters/gemini.ts`. Implement the three methods:

- `defaultRoot()` — return the agent's session directory as a `~`-prefixed
  path (e.g. `"~/.gemini/sessions"`). The `~` is expanded by `expandHome()` at
  index time, so the adapter stays portable and testable without touching a
  real home dir.
- `discover(root)` — walk `root` and return an array of session file paths.
  Use `readdirSync`/`statSync` and return `[]` (not throw) if the root is
  missing.
- `parse(filePath)` — read the file, map it to the normalized `Session`. Use
  `readJsonl()` (`packages/core/src/jsonl.ts`) for JSONL files — it already
  skips blank/malformed lines and never throws.

Look at `claude.ts` and `codex.ts` for reference. They're the source of truth
for the patterns (tool-call↔result matching by id, status inference, skipping
unrecognized lines).

### 3. Export and register it

- Export it from `packages/core/src/index.ts`.
- Add it to the `ADAPTERS` array in `packages/cli/src/scan.ts` so the CLI scans
  it by default.

### 4. Capture a fixture

This is the most important step for future-proofing. Copy a small, realistic
excerpt (~10–30 lines) from a real session into
`packages/core/test/fixtures/<agent>/`, mirroring the on-disk directory layout
so `discover()` finds it. The existing fixtures are deliberately small and
hand-crafted to exercise the interesting cases:

- `fixtures/claude/-Users-ole-projekte-demo/fix-aaaa-0001.jsonl` — user/assistant
  turns, tool_use + tool_result matching, a malformed line, an unknown line
  type (both skipped), and an `away_summary` recap line (emitted as
  `summary`/`recap`).
- `fixtures/codex/` — four fixtures covering all three historical formats plus
  an empty/interrupted session, and a `compacted` envelope (emitted as
  `summary`/`compaction`).

**Redact anything sensitive** (real API keys, private paths) when copying. The
fixtures ship in the repo.

### 5. Write tests

Create `packages/core/test/adapters/gemini.test.ts`. Follow the pattern in
`claude.test.ts` / `codex.test.ts`:

- Assert `agent` and `defaultRoot()`.
- Assert `discover()` finds the fixture files.
- Parse the fixture and assert the **normalized** shape: `sessionId`,
  `startedAt`, `model`, `messageCount`, and the structure of `messages[]`
  (roles, text, tool calls with status/output).

Run `pnpm -r test` from the repo root. The fixture-based test is the
acceptance criterion for a new adapter — see PRD criterion #2/#3.

### 6. Document the format

Add a `docs/format-<agent>.md` describing where sessions live, the line/item
shapes, field recovery, and any quirks. See
[format-claude.md](format-claude.md) and [format-codex.md](format-codex.md) for
the level of detail. This is the knowledge that's expensive to rediscover.

## Adapting to format drift

When an agent ships a new format or field (the scenario this guide exists
for). Usually a small change, not a rewrite.

### Symptoms

- A session that used to parse now has `messageCount: 0` or null fields.
- A new field appears in the raw JSONL that we're not surfacing.
- `session-bandit list` shows fewer sessions than expected for an agent.

### Procedure

1. **Find a recent session.** Use Session Bandit itself to locate it:
   ```sh
   session-bandit list --agent codex --pretty | head
   session-bandit show <sessionId>   # or just cat the file
   ```
2. **Capture a fixture.** Copy ~20 representative lines (including the new
   shape) into `packages/core/test/fixtures/<agent>/`, mirroring the on-disk
   layout. This is your regression target.
3. **Extend the parser.** This is almost always *additive* — a new `case` in
   the item processor, or a new branch for an envelope type. The existing
   parsing of known shapes stays untouched.
4. **Respect the golden rules.** A new field the adapter doesn't understand
   must not break parsing of the fields it does. Unrecognized → skip, never
   throw.
5. **Add a test case** against the new fixture, asserting the normalized
   output for the new shape.
6. **Update the format reference doc** (`docs/format-<agent>.md`) with the
   new shape and the date you observed it.

The drift playbook is deliberately boring: capture, extend, test, document.
Because adapters skip unrecognized lines by default, **format drift usually
means "add a case", not "rewrite the adapter"** — and old sessions in the old
format keep parsing unchanged.

## Testing without touching real sessions

Adapter tests use **only** `packages/core/test/fixtures/**` — no live
`~/.claude` / `~/.codex` access in tests (PRD criterion #7). The only thing
that touches `os.homedir()` in tests is `expandHome()`, and only to verify
string expansion.

The CLI is testable the same way: commands take an injected `ScanFn`
(`() => Session[]`) rather than calling `scanAll()` directly, so tests pass in
fake sessions and assert output without scanning the real machine. See
`packages/cli/test/commands.test.ts` for the pattern.

## Existing adapters

- [Claude format reference](format-claude.md) — `~/.claude/projects/<encoded-cwd>/*.jsonl`
- [Codex format reference](format-codex.md) — `~/.codex/sessions/**`, three historical formats
- [BotBandit format reference](format-botbandit.md) — `~/.botbandit/sessions/*.jsonl`
