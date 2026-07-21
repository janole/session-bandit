# Claude Code session format reference

Reverse-engineered reference for Claude Code's on-disk session format.

> See [Adapters](adapters.md) for how this maps into the normalized model, and
> `packages/core/src/adapters/claude.ts` for the implementation.

## Where sessions live

```
~/.claude/projects/
└── -Users-ole-projekte-codex-workspaces-janole-botbandit-ng/   ← encoded cwd
    ├── 342647fa-5bf0-41b4-b21d-1e7d0d78b371.jsonl
    └── 7d7622d4-9e6b-...jsonl
```

Each session is one `.jsonl` file under an **encoded-cwd** directory. The
filename (without `.jsonl`) is the session id.

## The encoded-cwd directory name

Claude encodes the working directory by replacing every `/` with `-`:

```
/Users/ole/projekte/demo  →  -Users-ole-projekte-demo
```

Note the **leading `-`** (the leading `/` becomes `-`). Decoding is a straight
`-` → `/` replacement — see `decodeCwd()` in `packages/core/src/adapters/claude.ts`.

The adapter uses `decodeCwd(dirname(filePath))` as a fallback for `project`
when the session's own `cwd` field isn't present on any line.

## Line structure

Each line is a JSON object tagged by `type`. The adapter cares about a subset;
everything else is skipped.

### Lines we parse

**`user`** — a user turn, or a tool result:

```json
{"type":"user","message":{"role":"user","content":"Review the changes in commit abc123."},
 "uuid":"u1","timestamp":"2026-06-01T10:00:00.000Z","cwd":"/Users/ole/projekte/demo",
 "gitBranch":"main","sessionId":"fix-aaaa-0001"}
```

`content` can be a plain string (user text) or an array of blocks. When it's an
array, the adapter looks for `tool_result` blocks and attaches them to the
originating assistant tool call (matched by `tool_use_id`), and also surfaces
any plain `text` blocks as a user message.

A `tool_result` block:

```json
{"tool_use_id":"toolu_001","type":"tool_result","content":"commit abc123\nAuthor: O\n...","is_error":false}
```

**`assistant`** — an assistant turn with text/thinking/tool_use blocks:

```json
{"type":"assistant","message":{"model":"claude-sonnet-4-6","role":"assistant",
 "content":[
   {"type":"thinking","thinking":"Let me check the diff.","signature":"sig"},
   {"type":"text","text":"I'll look at the commit first."},
   {"type":"tool_use","id":"toolu_001","name":"Bash","input":{"command":"git show abc123"},"caller":{"type":"direct"}}
 ],"stop_reason":"tool_use"},
 "uuid":"a1","timestamp":"2026-06-01T10:00:05.000Z"}
```

The adapter:
- Extracts `text` blocks and concatenates them into `Message.text`.
- Extracts `tool_use` blocks into `ToolCall[]` (keyed by `id` for result
  matching).
- **Skips `thinking` blocks** from `Message.text` to keep the transcript
  human-readable (consistent with the Codex adapter's treatment of `reasoning`).
- Captures `message.model` as the session's `model`.
- Captures `message.usage` (when present) into `Message.stats` and accumulates
  it into `Session.stats`. Claude's per-assistant-line `usage` block carries:

```json
"usage": {
  "input_tokens": 2,
  "cache_creation_input_tokens": 8375,
  "cache_read_input_tokens": 7732,
  "output_tokens": 353
}
```

  Claude's accounting is **fresh-input**: `input_tokens` excludes cached tokens
  (cache creation and cache reads are separate fields). So
  `MessageStats.contextSize` (the prompt size for the turn) = `input +
  cache_creation + cache_read`, `inputTokens` = `input_tokens` (fresh),
  `cachedInputTokens` = `cache_creation + cache_read`. Claude's transcript does
  not carry the model's context-window limit or a running context size, so
  `SessionStats.contextWindow` / `finalContextSize` / `peakContextSize` are
  `null` for Claude sessions (the per-turn `contextSize` is still on each
  assistant `Message.stats`).

**`system`** (subtype `turn_duration`) — metadata, not a transcript turn:

```json
{"type":"system","subtype":"turn_duration","durationMs":12000,"messageCount":6,
 "timestamp":"2026-06-01T10:00:12.000Z","cwd":"/Users/ole/projekte/demo",
 "gitBranch":"main","sessionId":"fix-aaaa-0001","version":"2.1.170"}
```

No message is emitted, but the adapter harvests `cwd`, `gitBranch`, `version`,
and `timestamp` from these lines.

**`system`** (subtype `away_summary`) — a Claude **recap**. This *is* a
content-bearing system line, unlike `turn_duration`: Claude writes it when you
return after being away, summarising what was done lately + the next step. The
text lives in a top-level `content` field (not `message.content`):

```json
{"type":"system","subtype":"away_summary",
 "content":"I reviewed today's 45 commits … Next: your go-ahead to fix both. (disable recaps in /config)",
 "timestamp":"2026-06-09T19:42:36.278Z","cwd":"…","gitBranch":"main","isMeta":false}
```

The adapter emits this as a **`summary` message with `subtype: "recap"`** —
the `{role, subtype}` pair is the normalized home for runtime-generated
summaries (see `types.ts`). `isMeta` is `false` here, so recap content is real
and must not be dropped. Every recap ends with the boilerplate
`(disable recaps in /config)`; that's a UI hint, not data. Other (future)
`system` subtypes stay metadata-only unless they carry content.

### Lines we skip

- `mode` / `permission-mode` — session state, not transcript.
- `ai-title` — the AI-generated session title.
- `attachment` — file attachments.
- Anything unrecognized, and **any malformed line** — the golden rule: skip,
  never throw.

A real session file interleaves these freely; the adapter only acts on the
three line types above.

## Field recovery

| normalized field | source |
|---|---|
| `sessionId` | `line.sessionId`, falling back to the filename (without `.jsonl`) |
| `cwd` | any line's `cwd` field (user/system lines carry it) |
| `project` | `cwd`, falling back to `decodeCwd(dirname)` |
| `model` | the first `assistant` line's `message.model` |
| `startedAt` | the first line's `timestamp` |
| `endedAt` | the last line's `timestamp` |

`gitBranch` is captured internally by the adapter but **not currently surfaced**
in the normalized `Session` type — it's available if a future version wants to
group sessions by branch.

## Tool call ↔ result matching

Claude's format separates tool *use* (in an `assistant` message) from tool
*result* (in the next `user` message's `tool_result` block). They're linked by
`tool_use_id` / `id`. The adapter keeps a `Map<tool_use_id, {msg, idx}>` while
walking lines, so when a `tool_result` arrives it can find the exact
`ToolCall` in the exact assistant `Message` and attach `output` + `status`
(`is_error` → `error`, else `ok`).

This means tool call status comes directly from the result block — there's no
Codex-style `metadata.exit_code` quirk here.

## Format drift playbook

When Claude Code ships a new line type or field:

1. **Capture a sample.** Copy ~10 lines from a real
   `~/.claude/projects/<encoded-cwd>/*.jsonl` into
   `packages/core/test/fixtures/claude/<encoded-cwd>/` (mirror the directory
   layout so `discover()` finds it).
2. **Add/extend the fixture test** in `test/adapters/claude.test.ts`.
3. **Add a branch** to the parser. A new `type` usually means a new `if` /
   `case`. A new content-block `type` means a new filter in `blocksOf()`.
4. **Never throw.** Unrecognized lines and blocks are skipped by default. A
   new field the adapter doesn't read should not break reading the fields it
   does.
5. **Test** the new shape against the fixture, asserting the normalized output.