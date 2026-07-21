# BotBandit session format

BotBandit stores persisted agent sessions as JSONL event logs:

```text
~/.botbandit/sessions/<sessionId>.jsonl
```

Each line is one JSON object from BotBandit's `SessionEvent` discriminated
union (`packages/agent-core/src/types.ts` in the BotBandit repo). The event log
is event-sourced: replaying events derives conversation history, state, usage,
pending approvals, memory, and compaction state.

## Storage

The file store writes one file per session:

```text
<sessionId>.jsonl
```

The filename is the adapter's fallback session ID. The first event should
usually be:

```json
{"type":"session_init","event_id":"...","timestamp":"...","id":"...","schemaVersion":2}
```

The adapter uses `session_init.id` when present, otherwise the filename stem.

## Events used by the adapter

The MVP adapter reads these durable events:

| Event | Use |
| --- | --- |
| `session_init` | Session ID and start timestamp |
| `config` | Latest model (`config.model`) |
| `context` | Latest project/cwd/git context |
| `message` | Main transcript (`message` is an AI SDK `ModelMessage`) |
| `notice` | Non-debug system notices |
| `turn_end` | Error messages; per-turn `usage` → `Message.stats` / `Session.stats` |
| `loop_end` | Loop summary; `usage` is an aggregate (sum of the loop's `turn_end` usages) and is **ignored** for stats to avoid double-counting |
| `cancel` | Cancellation marker |
| `compaction` | Summary message with `subtype: "compaction"` |
| `memory` | Summary message with `subtype: "memory"` |
| `sub_agent_*` | Parent-visible sub-agent summary messages with related-session metadata when `subAgentId` is present |

Live `stream` events are ignored by default. In BotBandit, a live stream is a
preview of a turn; the persisted assistant `message` for the same `turn_id`
supersedes it.

### Token usage (`turn_end`)

Newer BotBandit sessions emit an AI SDK `usage` block on `turn_end` events
(`loop_end` also carries a `usage` block, but it is the accumulated sum of all
steps in the loop — built via `addLanguageModelUsage` in botbandit's
`agent-session.ts` — so the adapter ignores it to avoid double-counting every
token and inflating `peakContextSize` with a multi-step aggregate):

```json
{"type":"turn_end","result":"continued","durationMs":66404,
 "usage":{
   "inputTokens":92789,
   "inputTokenDetails":{"cacheReadTokens":5504},
   "outputTokens":788,
   "outputTokenDetails":{"reasoningTokens":53},
   "totalTokens":93577,
   "cachedInputTokens":5504,
   "reasoningTokens":53
 }}
```

The adapter records this into `Session.stats` (accumulated across turns) and
attaches the per-turn `MessageStats` to the nearest preceding assistant
message. `inputTokens` is the prompt size for the turn (→ `contextSize`, and
tracked for peak/final). BotBandit (AI SDK / OpenAI convention) counts
`inputTokens` as **including** cached and `outputTokens` as **including**
reasoning, so the adapter normalizes to fresh input / non-reasoning output to
match the Claude convention. `cachedInputTokens` mirrors
`inputTokenDetails.cacheReadTokens` and `reasoningTokens` mirrors
`outputTokenDetails.reasoningTokens` (the adapter prefers the convenience
field and falls back to the details field). Providers that do not report
cache reads (e.g. `ai-sdk-ollama`, which only emits `inputTokenDetails.noCacheTokens`)
leave `cachedInputTokens === 0`. Older sessions without these
events have `Session.stats === undefined`.

## Message projection

BotBandit `message.message` is an AI SDK `ModelMessage`.

String content is used directly. Array content is projected structurally:

- `text` parts become readable message text.
- `reasoning` parts are skipped from `Message.text`, matching the other
  adapters' treatment of thinking blocks.
- `tool-call` parts become normalized `ToolCall` objects.
- `tool-result` parts are matched back to the earlier `tool-call` by
  `toolCallId` when possible.
- `tool-approval-response` parts become a synthetic `tool_approval` tool call
  when they cannot be attached to a previous call.

Matched tool results update the original assistant tool call and do not emit a
separate normalized tool message.

## Wrapped Codex sessions

When BotBandit uses the `codex` provider, it may be wrapping or remote
controlling an underlying Codex app-server session. The Codex AI SDK provider
persists that source session as provider metadata:

```json
{
  "providerMetadata": {
    "@janole/ai-sdk-provider-codex-asp": {
      "threadId": "thr_...",
      "turnId": "turn_...",
      "threadPath": "~/.codex/sessions/..."
    }
  }
}
```

Session Bandit scans message-level and content-part `providerMetadata` for that
entry. The first observed `threadId` is emitted once as a summary marker with
structured provenance metadata:

```ts
{
  role: "summary",
  subtype: "wrapped_codex",
  text: "Original Codex session: ...",
  metadata: {
    relatedSessions: [
      { agent: "codex", kind: "wrapped_codex", sessionId: "thr_...", turnId: "turn_...", path: "~/.codex/sessions/..." }
    ]
  }
}
```

The raw BotBandit transcript remains intact; this marker only preserves
provenance for detailed views and handoff extracts.

## Sub-agent sessions

BotBandit records parent-visible sub-agent lifecycle events as `sub_agent_*`
events. Session Bandit preserves those as `summary` messages with
`subtype: "sub_agent"`. When the event includes `subAgentId`, the adapter also
adds a related-session reference:

```ts
{
  role: "summary",
  subtype: "sub_agent",
  text: "Sub-agent research started: ...",
  metadata: {
    relatedSessions: [
      { agent: "botbandit", kind: "sub_agent", sessionId: "sub-session-id", title: "Research the API", turnId: "turn-id" }
    ]
  }
}
```

Publishing uses that metadata to list child sessions in the manifest. Recursive
export/link generation is a publisher concern layered on top of the normalized
references.

When `sub_agent_started` includes a title, the related-session reference keeps it
as `title`. Renderers should use that title as the public link label instead of
showing only the opaque `subAgentId`.

## Memory and compaction

BotBandit has first-class persisted summaries:

- `memory` is an incremental generated memory with title, goal, summary,
  status, next steps, tags, resources, and importance.
- `compaction` summarizes older conversation history for context-window
  management.

Session Bandit preserves both as `role: "summary"` messages:

```ts
{ role: "summary", subtype: "memory", ... }
{ role: "summary", subtype: "compaction", ... }
{ role: "summary", subtype: "wrapped_codex", ... }
{ role: "summary", subtype: "sub_agent", ... }
```

These summaries are high-signal input for `session-bandit extract --prompt
handoff|memory`, but they do not replace the earlier raw transcript events.

## Doctor diagnostics

`session-bandit doctor --agent botbandit` reports:

- number of files/sessions/empty sessions
- observed `session_init.schemaVersion` values
- unrecognized event types

Unknown events are skipped by the adapter and counted by doctor so format drift
is visible without breaking scans.
