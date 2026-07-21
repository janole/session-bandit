# Codex session format reference

Reverse-engineered reference for Codex CLI's on-disk session format. This is
the knowledge that's expensive to rediscover every time Codex ships a format
change — written down once here.

> See [Adapters](adapters.md) for how this maps into the normalized model, and
> `packages/core/src/adapters/codex.ts` for the implementation.

## Where sessions live

```
~/.codex/sessions/
├── 2026/
│   └── 06/
│       └── 19/
│           ├── rollout-2026-06-19T10-00-00.000Z-<uuid>.jsonl   ← format C (modern)
│           └── rollout-2026-06-19T14-22-01.000Z-<uuid>.jsonl
├── rollout-2025-07-19T22-25-43.741Z-<uuid>.jsonl                ← format B (flat, legacy)
└── rollout-2025-04-17-<uuid>.json                               ← format A (legacy, single object)
```

`$CODEX_HOME` overrides the `~/.codex` prefix; the adapter reads
`~/.codex/sessions` by default.

The adapter discovers files by recursively walking the root and matching
`rollout-*.jsonl` and `rollout-*.json`. **`.jsonl.zst` files are not supported
in v1** (no zstd dependency) — they're silently skipped.

## Three coexisting formats

Codex's format has changed twice, and old sessions on disk are still in the
older formats. The adapter handles all three by detecting the format per file.

### Format A — Legacy `.json` (2025-04 era)

A single JSON object, **not** JSONL. One file, one parse.

```json
{
  "session": { "id": "...", "timestamp": "2025-04-17T14:50:24.646Z", "instructions": "" },
  "items": [
    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] },
    { "type": "reasoning", "summary": [], "duration_ms": 4011 },
    { "type": "function_call", "status": "completed", "arguments": "...", "call_id": "...", "name": "shell" },
    { "type": "function_call_output", "call_id": "...", "output": "..." }
  ]
}
```

Detected by `.json` extension.

### Format B — Flat `.jsonl` (2025-07 era, no envelope)

JSONL where line 0 is bare metadata and subsequent lines are bare items (the
same item shapes as format A's `items[]`, just one per line):

```jsonl
{"id":"...","timestamp":"2025-07-19T22:25:43.741Z","instructions":"# AGENTS.md..."}
{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}
{"type":"local_shell_call","call_id":"...","status":"completed","action":{"type":"exec","command":["bash","-lc","ls -1"]}}
{"type":"function_call_output","call_id":"...","output":"..."}
```

Detected as `.jsonl` where the first line has `id` + `timestamp` but **no**
`type` field (the metadata header). Each subsequent line is a bare item.

### Format C — Modern envelope `.jsonl` (2025-12+, current)

Every line is an envelope of the same shape:

```ts
{ timestamp: string, type: "session_meta" | "response_item" | "event_msg" | "turn_context" | "compacted", payload: ... }
```

The actual content lives in `payload`, and the envelope `type` tells you what
kind of payload to expect:

| envelope `type` | payload shape | what we do with it |
|---|---|---|
| `session_meta` | `{ id, timestamp, cwd, originator, cli_version, ... }` | capture `id`, `timestamp`, `cwd` |
| `turn_context` | `{ turn_id, cwd, model, approval_policy, ... }` | capture `model`, `cwd` |
| `response_item` | a message / reasoning / `*_call` / `*_call_output` (see below) | parse as an item |
| `event_msg` | `{ type: "task_started" \| "task_complete" \| "token_count" \| ... }` | `token_count` → capture usage; others **skipped** |
| `compacted` | `{ message: "", replacement_history: [<full prior messages>] }` | emit as a `summary`/`compaction` marker |

A real modern session opens with `session_meta`, then `turn_context`, then a
mix of `response_item` (the actual conversation) and `event_msg` (noise). A
`compacted` line marks a context-window compaction.

### The `compacted` envelope (context-window compaction)

When the context window fills, Codex replaces older context with a compacted
view and records a `compacted` envelope:

```json
{ "timestamp": "…", "type": "compacted",
  "payload": { "message": "",
    "replacement_history": [ {"type":"message","role":"user", …}, … ] } }
```

The adapter emits this as a **`summary` message with `subtype: "compaction"`**.
The payload's `.message` is empty in real data (0/43 in a survey), so the note
is derived from `replacement_history.length`:
`"Context compacted: N prior messages replaced."`

**The heavy `replacement_history` is deliberately not carried.** A survey of all
43 compactions on disk found 99% of those messages already appear as earlier
`response_item` lines in the same file (the adapter already captured them as
normal turns). So the compaction is a pure marker, and the (median 43 KB,
max 186 KB) redundant history is dropped — no data loss.

## Item shapes (shared across all formats)

Regardless of the wrapping (legacy / flat / envelope), the items inside all use
the same shapes. This is why the adapter has one `processItem()` function that
all three formats feed into.

### `message`

```ts
{ type: "message", role: "user" | "assistant" | "developer" | "system",
  content: [{ type: "input_text" | "output_text", text: string }] }
```

- `user` → a user turn.
- `assistant` → an assistant turn.
- `developer` / `system` → **instructions/permissions, skipped** from the
  visible transcript. (These are the `<permissions instructions>` /
  AGENTS.md injections, not user-authored text.)

Text is extracted from `input_text` / `output_text` blocks and concatenated.

#### Injected `user`-role messages (important)

Codex also injects machine-generated instruction blocks **as `user`-role
messages** — these are NOT real user input. They always appear as the first
user message(s) in a session, before the actual task. The adapter detects and
skips them, consistent with the `developer`/`system` skip. Three markers:

| marker (first content block starts with) | what it is |
|---|---|
| `# AGENTS.md instructions for <path>` | The project's AGENTS.md content, wrapped in `<INSTRUCTIONS>` tags (followed by a second `<environment_context>` block) |
| `<environment_context>` | cwd, shell, date, timezone, filesystem info — injected when there's no AGENTS.md |
| `<user_action>` | UI-generated actions (e.g. review-task selections) |

Without this detection, the digest's `keyTurns.goal` would pick up the
AGENTS.md instructions instead of the real task. The markers are exported as
`CODEX_INJECTED_MARKERS` so the `doctor` command can verify detection rates.

> **Checking your own Codex logs.** This pattern was verified against ~1000
> real sessions on one system (codex v0.128–v0.140, 2025-04 to 2026-06).
> Codex versions or platforms may differ. Run `session-bandit doctor --agent
> codex --pretty` — it reports how many first-user-messages matched each
> marker. If you see a non-zero `plain task` count, the injection pattern has
> drifted and the adapter may need new markers.

### `reasoning`

```ts
{ type: "reasoning", summary: [], content: null, encrypted_content: "..." }
```

Thinking blocks. **Skipped** from `Message.text` to keep the transcript
human-readable (consistent with the Claude adapter's treatment of `thinking`
blocks). Flagged as a potential v2 extension point if you want reasoning shown.

### Tool calls

Five item types produce tool calls. Each becomes an assistant `Message` with
exactly one `ToolCall`:

| item `type` | tool name | input source |
|---|---|---|
| `function_call` | `name` (e.g. `shell`) — namespace is prepended only when non-empty | `arguments` (JSON string → parsed object) |
| `custom_tool_call` | `name` (e.g. `apply_patch`) | `input` (already an object/string) |
| `local_shell_call` | `shell` | `action` (the `{ type, command, ... }` object) |
| `web_search_call` | `web_search` | `action` (the `{ type, query, queries }` object) |

A `function_call`'s `arguments` field is a **JSON string**, not an object —
the adapter parses it (`JSON.parse`), falling back to the raw string if it
isn't valid JSON.

### Tool outputs

```ts
{ type: "function_call_output" | "custom_tool_call_output", call_id: string, output: string }
```

Matched to the originating tool call by `call_id` (a `Map<call_id, ToolCall>`).
The `output` field is itself a **JSON string** that the adapter does not parse
into `Message.text`, but it *does* peek inside for status inference (below).

## The status quirk (important)

A tool call's `status` field is **not** the ground truth. The output is.

The item-level `status` is one of `completed` / `succeeded` / `failed` /
`error`. But a `completed` tool call can still fail — e.g. a shell command
that ran to completion but exited non-zero. The real status lives in the
output's `metadata.exit_code`:

```json
{ "output": "FAIL  src/index.test.ts\n...", "metadata": { "exit_code": 1, "duration_seconds": 0.5 } }
```

So the adapter's rule is:

1. Map the item `status` initially (`completed`/`succeeded` → `ok`,
   `failed`/`error` → `error`, else `unknown`).
2. When the output arrives, **infer from `metadata.exit_code`** and let it
   override: `exit_code === 0` → `ok`, non-zero → `error`.
3. If the output isn't JSON or has no `exit_code`, default to `ok` (the output
   exists, so something happened).

This is why a Codex session can show a tool call as `error` even though the
item said `completed`.

## Model and cwd recovery

Codex doesn't store a single "primary model" the way Claude does. The adapter
recovers `model` opportunistically from the **first** `turn_context` envelope
it sees, and `cwd` from `session_meta.payload.cwd` (falling back to
`turn_context.payload.cwd`). Both are nullable in the normalized model for
exactly this reason.

Per-turn token counts are emitted as `event_msg` payloads with
`type: "token_count"`. The Codex adapter captures these into `Session.stats`
and the nearest assistant `Message.stats`:

- `info.total_token_usage` — running session totals (cumulative across turns).
- `info.last_token_usage` — the delta for the most recent turn.
- `info.model_context_window` — the model's context-window limit (→
  `SessionStats.contextWindow`).
- `info.last_token_usage.input_tokens` — the prompt size for the last turn (→
  `MessageStats.contextSize`, and tracked for peak/final context size).

Codex (OpenAI) token accounting differs from Claude's: `input_tokens`
**already includes** `cached_input_tokens` (cached is a subset), and
`output_tokens` **already includes** `reasoning_output_tokens`. The adapter
normalizes to the Claude convention (`totalInputTokens` = fresh input =
`input - cached`; `totalOutputTokens` = non-reasoning = `output - reasoning`).
`total_token_usage.total_tokens` is a **cumulative** session total, not the
current context size — the current context size is the per-turn prompt size
(`last_token_usage.input_tokens`). Other `event_msg` types (`task_started`,
`task_complete`, …) and the `rate_limits` block are still skipped.

## Empty / interrupted sessions

A session file with only a metadata line (no items) is valid and produces a
`Session` with `messageCount: 0`. Real-world example: `rollout-*.jsonl`
containing only `{"id":"...","timestamp":"..."}` — likely a session that
started but was interrupted before the first turn. The adapter returns it
rather than skipping, so the index stays complete.

## Format drift playbook

When Codex ships a new format or field:

1. **Capture a sample.** Find a recent `rollout-*.jsonl` under
   `~/.codex/sessions/` and copy ~20 representative lines into
   `packages/core/test/fixtures/codex/` (mirror the `YYYY/MM/DD/` layout for
   modern format, or a flat `rollout-*.jsonl` for flat).
2. **Add or extend a fixture** in the test suite. See
   `test/adapters/codex.test.ts` for the pattern — one fixture per format
   variant.
3. **Extend the parser.** Usually this means adding a `case` to
   `processItem()` (new item `type`) or a new envelope `type` branch in
   `processEnvelope()`. The shared `processItem()` means a new item shape
   works across all three formats at once.
4. **Never throw.** Unrecognized lines/envelopes/items are skipped by default —
   this is the golden rule. A new field that the adapter doesn't understand
   should not break parsing of the fields it does understand.
5. **Test the new shape** against the fixture, asserting the normalized output.