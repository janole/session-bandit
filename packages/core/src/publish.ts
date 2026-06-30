import { computeDigest, type SessionDigest } from "./digest.js";
import type { AgentName, RelatedSessionReference, Session } from "./types.js";

export type PublishedSessionKind = "session-bandit-published-session";

export type PublishedRedactionMode = "strict" | "cautious" | "minimal" | "none";

export interface PublishedSessionSource {
    agent: AgentName;
    sessionId: string;
    project: string | null;
    startedAt: string;
    endedAt: string | null;
    model: string | null;
    relatedSessions: RelatedSessionReference[];
}

export interface PublishedSessionManifest {
    schemaVersion: 1;
    kind: PublishedSessionKind;
    title: string;
    slug: string;
    generatedAt: string;
    source: PublishedSessionSource;
    redaction: {
        mode: PublishedRedactionMode;
        reportPath: string | null;
    };
}

export interface PublishedSessionBundle {
    manifest: PublishedSessionManifest;
    session: Session;
    digest: SessionDigest;
}

export interface BuildPublishedSessionBundleOptions {
    title?: string;
    slug?: string;
    generatedAt?: string;
    digest?: SessionDigest;
    redaction?: {
        mode?: PublishedRedactionMode;
        reportPath?: string | null;
    };
}

/** Build the deterministic public bundle shape consumed by Markdown/HTML exporters. */
export function buildPublishedSessionBundle(
    session: Session,
    options: BuildPublishedSessionBundleOptions = {},
): PublishedSessionBundle
{
    const digest = options.digest ?? computeDigest(session, { full: true });
    const title = options.title ?? titleFromDigest(digest);
    const slug = options.slug ?? slugify(title || session.sessionId);

    return {
        manifest: {
            schemaVersion: 1,
            kind: "session-bandit-published-session",
            title,
            slug,
            generatedAt: options.generatedAt ?? new Date().toISOString(),
            source: {
                agent: session.agent,
                sessionId: session.sessionId,
                project: session.project,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                model: session.model,
                relatedSessions: extractRelatedSessions(session),
            },
            redaction: {
                mode: options.redaction?.mode ?? "none",
                reportPath: options.redaction?.reportPath ?? null,
            },
        },
        session,
        digest,
    };
}

/** Convert arbitrary title text into a stable URL slug. */
export function slugify(value: string): string
{
    const slug = value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "session";
}

/** Collect unique machine-readable source-session references from messages. */
export function extractRelatedSessions(session: Session): RelatedSessionReference[]
{
    const seen = new Map<string, RelatedSessionReference>();
    const out: RelatedSessionReference[] = [];

    for (const message of session.messages)
    {
        for (const related of message.metadata?.relatedSessions ?? [])
        {
            const key = [
                related.agent,
                related.kind,
                related.sessionId,
                related.turnId ?? "",
                related.path ?? "",
            ].join("\u0000");
            const existing = seen.get(key);
            if (existing)
            {
                existing.title ??= related.title;
                continue;
            }
            seen.set(key, related);
            out.push(related);
        }
    }

    return out;
}

function titleFromDigest(digest: SessionDigest): string
{
    const goal = digest.keyTurns.goal?.trim();
    if (goal) { return firstLine(goal); }
    return `Session ${digest.sessionId}`;
}

function firstLine(value: string): string
{
    return value.split(/\r?\n/, 1)[0]?.trim() || value.trim();
}
