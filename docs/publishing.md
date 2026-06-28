# Publishing bundle schema

Session Bandit publishing starts from the normalized `Session` model and
`SessionDigest`; it does not re-parse raw provider JSONL. The P0 bundle is a
pure in-memory contract for later Markdown and static-site exporters.

The core publishing path is deterministic and offline. It may derive structural
fields such as title and slug from the digest, but it must not call an LLM or a
network service. Subjective prose such as intros and section headings belongs in
the agent skill workflow or in user-provided input.

## Bundle

`buildPublishedSessionBundle(session, options)` returns:

```ts
interface PublishedSessionBundle {
  manifest: PublishedSessionManifest;
  session: Session;
  digest: SessionDigest;
}
```

The builder computes `computeDigest(session, { full: true })` unless a digest is
provided. Redaction is not implemented in P0; the manifest still records the
intended redaction mode so later exporters can write compatible bundles.

`buildPublishedSessionBundle` is policy-neutral and defaults `redaction.mode` to
`"none"`. User-facing export commands should choose safer defaults, typically
`"cautious"`, before writing public artifacts.

## Manifest

```ts
interface PublishedSessionManifest {
  schemaVersion: 1;
  kind: "session-bandit-published-session";
  title: string;
  slug: string;
  generatedAt: string;
  source: {
    agent: AgentName;
    sessionId: string;
    project: string | null;
    startedAt: string;
    endedAt: string | null;
    model: string | null;
    relatedSessions: RelatedSessionReference[];
  };
  redaction: {
    mode: "strict" | "cautious" | "minimal" | "none";
    reportPath: string | null;
  };
}
```

`title` defaults to the first user goal from the digest, then to
`Session <sessionId>`. `slug` defaults to a stable ASCII slug from the title.
Export commands should pass an explicit `generatedAt` in tests and may let the
builder use the current time in real CLI runs.

## Public Field Policy

P0 does not redact, but it defines the target shape P1 redaction must make safe.
Exporters must write a redacted copy of the bundle; they must never mutate the
parsed source `Session` object.

| Field area | P0 bundle status | P1 redaction expectation |
| --- | --- | --- |
| `manifest.schemaVersion`, `kind`, `generatedAt`, `redaction` | Public metadata | Safe as-is. |
| `manifest.title`, `slug` | Derived or user/skill-provided | Redact secret-like text before writing. |
| `manifest.source.agent`, `sessionId`, `startedAt`, `endedAt`, `model` | Source provenance | Safe structurally, but session IDs may be sensitive in some environments; allow future policy overrides. |
| `manifest.source.project` | Local/project metadata | Normalize or redact home paths and private names. |
| `manifest.source.relatedSessions` | Cross-session provenance | Keep `agent`/`kind`; redact or normalize `path`; allow policy to redact opaque IDs if needed. |
| `session.filePath`, `cwd`, `project` | Local filesystem metadata | Redact or normalize before public output. |
| `session.messages[].text` | Transcript content | Redact secrets, personal data, private URLs, and local paths. |
| `session.messages[].toolCalls[].input` | Tool input | Redact aggressively; write/network commands may need collapse or allowlisting. |
| `session.messages[].toolCalls[].output` | Tool output | Redact secrets and collapse large output. |
| `digest` strings and file/command lists | Derived from session | Apply the same redaction policy as the source fields they came from. |

## Related Sessions

Normalized messages may include machine-readable metadata:

```ts
interface MessageMetadata {
  relatedSessions?: RelatedSessionReference[];
}
```

The publishing builder deduplicates these references into
`manifest.source.relatedSessions`.

For BotBandit sessions backed by an underlying Codex app-server thread, the
BotBandit adapter emits a `summary` message with `subtype: "wrapped_codex"` and
metadata like:

```json
{
  "agent": "codex",
  "kind": "wrapped_codex",
  "sessionId": "thr_...",
  "turnId": "turn_...",
  "path": "~/.codex/sessions/..."
}
```

The text summary keeps `show` and `extract` readable. The metadata lets
publishers expose provenance without parsing display text.

## Summary Mapping

Summary-role messages should be rendered as labeled public sections, not as
ordinary chat turns:

| `Message.subtype` | Public section label | Notes |
| --- | --- | --- |
| `memory` | Session memory | BotBandit-generated session memory; useful authoring context, still subject to redaction. |
| `compaction` | Context summary | Provider/agent compaction summary for earlier transcript context. |
| `wrapped_codex` | Original Codex session | Provenance marker for BotBandit sessions backed by Codex; also feeds `relatedSessions`. |
| `recap` | Session recap | Claude while-you-were-away recap. |
| other subtype | Summary | Preserve the subtype label for auditability. |

## Next Phases

P1 should add redaction over the same bundle shape and produce a
`redaction-report.json` object. P2/P3 Markdown and HTML exporters should consume
the redacted bundle rather than reading raw sessions directly.
