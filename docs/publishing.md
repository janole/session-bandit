# Publishing bundle schema

Session Bandit publishing starts from the normalized `Session` model and
`SessionDigest`; it does not re-parse raw provider JSONL. The P0 bundle is a
pure in-memory contract for later Markdown and static-site exporters.

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

## Next Phases

P1 should add redaction over the same bundle shape and produce a
`redaction-report.json` object. P2/P3 Markdown and HTML exporters should consume
the redacted bundle rather than reading raw sessions directly.
