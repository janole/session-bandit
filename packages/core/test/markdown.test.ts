import { join } from "node:path";

import { describe, expect,it } from "vitest";

import { botbanditAdapter } from "../src/adapters/botbandit.js";
import { renderPublishedSessionMarkdown } from "../src/markdown.js";
import { buildPublishedSessionBundle } from "../src/publish.js";
import { redactPublishedSessionBundle } from "../src/redact.js";
import type { Message, Session } from "../src/types.js";

const fixtureRoot = join(__dirname, "fixtures");

describe("renderPublishedSessionMarkdown", () =>
{
    it("renders manifest, digest, transcript, and tool details", () =>
    {
        const session = makeSession([
            { role: "user", text: "Build the thing.", toolCalls: [], timestamp: "2026-06-28T12:00:00.000Z" },
            {
                role: "assistant",
                text: "Running tests.",
                toolCalls: [
                    {
                        name: "Bash",
                        input: { command: "npm test" },
                        status: "ok",
                        output: "3 passing\nliteral </details>\n<section class=\"owned\">bad</section>\n````",
                    },
                ],
                timestamp: "2026-06-28T12:01:00.000Z",
            },
            {
                role: "system",
                subtype: "notice",
                text: "[info] Auto-approved safe shell command by policy rule(s) bash(grep *).",
                toolCalls: [],
                timestamp: "2026-06-28T12:01:30.000Z",
            },
            {
                role: "system",
                text: "[error] Turn failed.",
                toolCalls: [],
                timestamp: "2026-06-28T12:01:45.000Z",
            },
        ]);
        const bundle = buildPublishedSessionBundle(session, {
            title: "Build The Thing",
            slug: "build-the-thing",
            generatedAt: "2026-06-28T12:05:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });

        const markdown = renderPublishedSessionMarkdown(bundle);

        expect(markdown).toContain("title: \"Build The Thing\"");
        expect(markdown).toContain("# Build The Thing");
        expect(markdown.indexOf("## Session Transcript")).toBeLessThan(markdown.indexOf("## Digest"));
        expect(markdown).toContain("## Source");
        expect(markdown).toContain("## Digest");
        expect(markdown).toContain("### Goal");
        expect(markdown).toContain("Build the thing.");
        expect(markdown).toContain("## Session Transcript");
        expect(markdown).toContain("### User");
        expect(markdown).toContain("### Assistant");
        expect(markdown).toContain("2026-06-28T12:01:00.000Z · model: claude-sonnet-4-6");
        expect(markdown).toContain("### Tools");
        expect(markdown).toContain("### System");
        expect(markdown).toContain("[error] Turn failed.");
        expect(markdown).not.toContain("Auto-approved safe shell command");
        expect(markdown).toContain("<summary>Bash - ok</summary>");
        expect(markdown).toContain("\"command\": \"npm test\"");
        expect(markdown).toContain("3 passing");
        expect(markdown.match(/<\/details>/g)).toHaveLength(1);
        expect(markdown).not.toContain("<section class=\"owned\">");
        expect(markdown).toContain("&lt;section class=\"owned\"&gt;bad&lt;/section&gt;");
        expect(markdown).toContain("````");
    });

    it("renders BotBandit wrapped Codex provenance and summary labels", () =>
    {
        const file = join(fixtureRoot, "botbandit", "codex-wrapper-session.jsonl");
        const session = botbanditAdapter.parse(file);
        const bundle = buildPublishedSessionBundle(session, {
            title: "BotBandit Wrapped Codex",
            generatedAt: "2026-06-28T12:05:00.000Z",
        });

        const markdown = renderPublishedSessionMarkdown(bundle);

        expect(markdown).toContain("## Related Sessions");
        expect(markdown).toContain("codex wrapped_codex: `thr_codex_123`");
        expect(markdown).toContain("## Summaries");
        expect(markdown).toContain("### Original Codex Session");
        expect(markdown).toContain("Original Codex session: thr_codex_123");
        expect(markdown.match(/Original Codex session: thr_codex_123/g)).toHaveLength(1);
        expect(markdown).not.toContain("2. Original Codex Session");
        expect(markdown).toContain("### Assistant");
    });

    it("renders redacted bundles without leaking sensitive originals", () =>
    {
        const session = makeSession([
            {
                role: "user",
                text: "Use jane@example.com and sk-testSECRET123456.",
                toolCalls: [],
                timestamp: null,
            },
        ]);
        const bundle = buildPublishedSessionBundle(session, {
            title: "Use jane@example.com",
            generatedAt: "2026-06-28T12:05:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });
        const { bundle: redacted } = redactPublishedSessionBundle(bundle);

        const markdown = renderPublishedSessionMarkdown(redacted);

        expect(markdown).not.toContain("jane@example.com");
        expect(markdown).not.toContain("sk-testSECRET123456");
        expect(markdown).toContain("[REDACTED_EMAIL]");
        expect(markdown).toContain("[REDACTED_SECRET]");
    });
});

function makeSession(messages: Message[]): Session
{
    return {
        agent: "claude",
        sessionId: "markdown-session",
        filePath: "/fixtures/markdown-session.jsonl",
        project: "/project",
        cwd: "/project",
        startedAt: "2026-06-28T12:00:00.000Z",
        endedAt: "2026-06-28T12:05:00.000Z",
        model: "claude-sonnet-4-6",
        messageCount: messages.length,
        messages,
    };
}
