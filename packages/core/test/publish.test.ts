import { join } from "node:path";

import { describe, expect,it } from "vitest";

import { botbanditAdapter } from "../src/adapters/botbandit.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { buildPublishedSessionBundle, extractRelatedSessions, slugify } from "../src/publish.js";
import type { Message, Session } from "../src/types.js";

const fixtureRoot = join(__dirname, "fixtures");

describe("slugify", () =>
{
    it("normalizes titles into stable URL slugs", () =>
    {
        expect(slugify("Apple Watch Interface for BotBandit")).toBe("apple-watch-interface-for-botbandit");
        expect(slugify("  déjà vu / API keys?  ")).toBe("deja-vu-api-keys");
        expect(slugify("")).toBe("session");
    });
});

describe("extractRelatedSessions", () =>
{
    it("deduplicates related session references in message metadata", () =>
    {
        const related = {
            agent: "codex" as const,
            kind: "wrapped_codex",
            sessionId: "thr_1",
            turnId: "turn_1",
            path: "~/.codex/sessions/thread.jsonl",
        };
        const messages: Message[] = [
            { role: "summary", subtype: "wrapped_codex", text: "one", toolCalls: [], timestamp: null, metadata: { relatedSessions: [related] } },
            { role: "summary", subtype: "wrapped_codex", text: "two", toolCalls: [], timestamp: null, metadata: { relatedSessions: [related] } },
        ];
        const session = sessionWithMessages(messages);

        expect(extractRelatedSessions(session)).toEqual([related]);
    });
});

describe("buildPublishedSessionBundle", () =>
{
    it("builds a manifest and full digest for a Claude fixture", () =>
    {
        const file = join(fixtureRoot, "claude", "-Users-ole-projekte-demo", "fix-aaaa-0001.jsonl");
        const session = claudeAdapter.parse(file);

        const bundle = buildPublishedSessionBundle(session, {
            title: "Claude Fixture",
            slug: "claude-fixture",
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });

        expect(bundle.manifest).toMatchObject({
            schemaVersion: 1,
            kind: "session-bandit-published-session",
            title: "Claude Fixture",
            slug: "claude-fixture",
            generatedAt: "2026-06-28T12:00:00.000Z",
            source: {
                agent: "claude",
                sessionId: session.sessionId,
                relatedSessions: [],
            },
            redaction: {
                mode: "cautious",
                reportPath: "redaction-report.json",
            },
        });
        expect(bundle.session).toBe(session);
        expect(bundle.digest.transcript).toHaveLength(session.messages.length);
    });

    it("builds a default title and slug for a Codex fixture", () =>
    {
        const file = join(fixtureRoot, "codex", "2026", "06", "19", "rollout-2026-06-19T10-00-00-fix-codex-0001.jsonl");
        const session = codexAdapter.parse(file);

        const bundle = buildPublishedSessionBundle(session, {
            generatedAt: "2026-06-28T12:00:00.000Z",
        });

        expect(bundle.manifest.source.agent).toBe("codex");
        expect(bundle.manifest.title).toBe(bundle.digest.keyTurns.goal);
        expect(bundle.manifest.slug).toBe(slugify(bundle.manifest.title));
        expect(bundle.manifest.redaction.mode).toBe("none");
        expect(bundle.digest.transcript).toHaveLength(session.messages.length);
    });

    it("includes wrapped Codex provenance for a BotBandit fixture", () =>
    {
        const file = join(fixtureRoot, "botbandit", "codex-wrapper-session.jsonl");
        const session = botbanditAdapter.parse(file);

        const bundle = buildPublishedSessionBundle(session, {
            title: "BotBandit Wrapped Codex",
            generatedAt: "2026-06-28T12:00:00.000Z",
        });

        expect(bundle.manifest.source.agent).toBe("botbandit");
        expect(bundle.manifest.source.relatedSessions).toEqual([
            {
                agent: "codex",
                kind: "wrapped_codex",
                sessionId: "thr_codex_123",
                turnId: "turn_codex_1",
                path: "/Users/ole/.codex/sessions/2026/06/28/rollout-2026-06-28T13-00-00-thr_codex_123.jsonl",
            },
        ]);
        expect(bundle.digest.summaries.some(summary => summary.subtype === "wrapped_codex")).toBe(true);
    });

    it("includes BotBandit sub-agent provenance for a BotBandit fixture", () =>
    {
        const file = join(fixtureRoot, "botbandit", "summary-session.jsonl");
        const session = botbanditAdapter.parse(file);

        const bundle = buildPublishedSessionBundle(session, {
            title: "BotBandit Sub Agents",
            generatedAt: "2026-06-28T12:00:00.000Z",
        });

        expect(bundle.manifest.source.relatedSessions).toEqual([
            {
                agent: "botbandit",
                kind: "sub_agent",
                sessionId: "sub-session-1",
                title: "Find prior publishing work",
                turnId: "turn-sub-1",
            },
        ]);
        expect(bundle.digest.summaries.some(summary => summary.subtype === "sub_agent")).toBe(true);
    });
});

function sessionWithMessages(messages: Message[]): Session
{
    return {
        agent: "botbandit",
        sessionId: "botbandit-1",
        filePath: "/fixtures/botbandit-1.jsonl",
        project: null,
        cwd: null,
        startedAt: "2026-06-28T12:00:00.000Z",
        endedAt: null,
        model: null,
        messageCount: messages.length,
        messages,
    };
}
