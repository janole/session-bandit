import { describe, expect,it } from "vitest";

import { buildPublishedSessionBundle } from "../src/publish.js";
import { redactPublishedSessionBundle } from "../src/redact.js";
import type { Message, Session, ToolCall } from "../src/types.js";

describe("redactPublishedSessionBundle", () =>
{
    it("redacts common sensitive strings from session and digest copies", () =>
    {
        const session = makeSensitiveSession();
        const bundle = buildPublishedSessionBundle(session, {
            title: "Deploy with jane@example.com",
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });

        const result = redactPublishedSessionBundle(bundle);
        const redactedJson = JSON.stringify(result.bundle);
        const reportJson = JSON.stringify(result.report);

        expect(redactedJson).not.toContain("sk-testSECRET123456");
        expect(redactedJson).not.toContain("ghp_abcdef1234567890");
        expect(redactedJson).not.toContain("jane@example.com");
        expect(redactedJson).not.toContain("/Users/ole");
        expect(redactedJson).not.toContain("token=secret");
        expect(redactedJson).not.toContain("SECRET_TOKEN=abc123");
        expect(redactedJson).not.toContain("private.pem");

        expect(redactedJson).toContain("[REDACTED_SECRET]");
        expect(redactedJson).toContain("[REDACTED_EMAIL]");
        expect(redactedJson).toContain("SECRET_TOKEN=[REDACTED_ENV]");
        expect(redactedJson).toContain("https://example.com/path");
        expect(redactedJson).toContain("~");

        expect(reportJson).not.toContain("sk-testSECRET123456");
        expect(reportJson).not.toContain("jane@example.com");
        expect(result.report.counts.secretLike).toBeGreaterThan(0);
        expect(result.report.counts.email).toBeGreaterThan(0);
        expect(result.report.counts.homePath).toBeGreaterThan(0);
        expect(result.report.counts.urlQuery).toBeGreaterThan(0);
        expect(result.report.counts.envAssignment).toBeGreaterThan(0);
        expect(result.report.counts.knownAuthFile).toBeGreaterThan(0);
    });

    it("collapses long tool outputs and records a finding", () =>
    {
        const session = makeSession([
            assistantWithTool({
                output: "x".repeat(60),
            }),
        ]);
        const bundle = buildPublishedSessionBundle(session, {
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });

        const result = redactPublishedSessionBundle(bundle, { maxOutputChars: 10 });
        const output = result.bundle.session.messages[0]!.toolCalls[0]!.output!;

        expect(output).toContain("xxxxxxxxxx");
        expect(output).toContain("output collapsed");
        expect(result.report.counts.longOutputCollapsed).toBeGreaterThanOrEqual(1);
    });

    it("does not mutate the source bundle or parsed session", () =>
    {
        const session = makeSensitiveSession();
        const bundle = buildPublishedSessionBundle(session, {
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "cautious", reportPath: "redaction-report.json" },
        });
        const beforeSession = JSON.stringify(session);
        const beforeBundle = JSON.stringify(bundle);

        const result = redactPublishedSessionBundle(bundle);

        expect(JSON.stringify(session)).toBe(beforeSession);
        expect(JSON.stringify(bundle)).toBe(beforeBundle);
        expect(JSON.stringify(result.bundle)).not.toBe(beforeBundle);
    });

    it("mode none only clones and records no findings", () =>
    {
        const session = makeSensitiveSession();
        const bundle = buildPublishedSessionBundle(session, {
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "none", reportPath: null },
        });

        const result = redactPublishedSessionBundle(bundle);

        expect(result.bundle).not.toBe(bundle);
        expect(result.bundle).toEqual(bundle);
        expect(result.report.findings).toEqual([]);
        expect(Object.values(result.report.counts).every(count => count === 0)).toBe(true);
    });

    it("minimal mode keeps low-risk personal context but redacts high-confidence secrets", () =>
    {
        const session = makeSensitiveSession();
        const bundle = buildPublishedSessionBundle(session, {
            generatedAt: "2026-06-28T12:00:00.000Z",
            redaction: { mode: "minimal", reportPath: "redaction-report.json" },
        });

        const result = redactPublishedSessionBundle(bundle);
        const redactedJson = JSON.stringify(result.bundle);

        expect(redactedJson).not.toContain("sk-testSECRET123456");
        expect(redactedJson).toContain("jane@example.com");
        expect(redactedJson).toContain("/Users/ole");
    });
});

function makeSensitiveSession(): Session
{
    return makeSession([
        {
            role: "user",
            text: "Deploy with jane@example.com and key sk-testSECRET123456. See https://example.com/path?token=secret#frag",
            toolCalls: [],
            timestamp: "2026-06-28T12:00:00.000Z",
        },
        assistantWithTool({
            input: {
                command: "SECRET_TOKEN=abc123 gh auth status --token ghp_abcdef1234567890",
                file_path: "/Users/ole/project/.env",
                cert: "/Users/ole/private.pem",
            },
            output: "Wrote /Users/ole/project/file.ts with PRIVATE_KEY=abc123",
        }),
    ]);
}

function assistantWithTool(overrides: Partial<ToolCall> = {}): Message
{
    return {
        role: "assistant",
        text: "Running tool in /Users/ole/project",
        toolCalls: [
            {
                name: "Bash",
                input: { command: "echo ok" },
                status: "ok",
                output: "ok",
                ...overrides,
            },
        ],
        timestamp: "2026-06-28T12:00:01.000Z",
    };
}

function makeSession(messages: Message[]): Session
{
    return {
        agent: "claude",
        sessionId: "sensitive-session",
        filePath: "/Users/ole/.claude/projects/demo/sensitive-session.jsonl",
        project: "/Users/ole/project",
        cwd: "/Users/ole/project",
        startedAt: "2026-06-28T12:00:00.000Z",
        endedAt: "2026-06-28T12:05:00.000Z",
        model: "claude-sonnet-4-6",
        messageCount: messages.length,
        messages,
    };
}
