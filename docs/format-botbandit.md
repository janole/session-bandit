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
| `turn_end` | Error messages |
| `cancel` | Cancellation marker |
| `compaction` | Summary message with `subtype: "compaction"` |
| `memory` | Summary message with `subtype: "memory"` |
| `sub_agent_*` | Parent-visible sub-agent summary messages |

Live `stream` events are ignored by default. In BotBandit, a live stream is a
preview of a turn; the persisted assistant `message` for the same `turn_id`
supersedes it.

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
entry. The first observed `threadId` is emitted once as a summary marker:

```ts
{ role: "summary", subtype: "wrapped_codex", text: "Original Codex session: ..." }
```

The raw BotBandit transcript remains intact; this marker only preserves
provenance for detailed views and handoff extracts.

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
