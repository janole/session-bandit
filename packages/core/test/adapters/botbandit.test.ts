import { join } from "node:path";

import { beforeAll,describe, expect, it } from "vitest";

import { botbanditAdapter } from "../../src/adapters/botbandit.js";
import type { Session } from "../../src/types.js";

const fixtureRoot = join(__dirname, "..", "fixtures", "botbandit");
const simpleFile = join(fixtureRoot, "simple-session.jsonl");
const toolFile = join(fixtureRoot, "tool-session.jsonl");
const summaryFile = join(fixtureRoot, "summary-session.jsonl");
const codexWrapperFile = join(fixtureRoot, "codex-wrapper-session.jsonl");
const noticeFile = join(fixtureRoot, "notice-session.jsonl");

describe("botbanditAdapter basics", () =>
{
    it("agent is botbandit", () =>
    {
        expect(botbanditAdapter.agent).toBe("botbandit");
    });

    it("defaultRoot is ~/.botbandit/sessions", () =>
    {
        expect(botbanditAdapter.defaultRoot()).toBe("~/.botbandit/sessions");
    });
});

describe("botbanditAdapter.discover", () =>
{
    it("finds top-level .jsonl session files", () =>
    {
        const files = botbanditAdapter.discover(fixtureRoot);
        expect(files).toHaveLength(5);
        expect(files).toEqual([...files].sort());
        expect(files.some(file => file.endsWith("simple-session.jsonl"))).toBe(true);
    });

    it("returns [] for a missing root", () =>
    {
        expect(botbanditAdapter.discover(join(fixtureRoot, "nope"))).toEqual([]);
    });
});

describe("botbanditAdapter.parse — notices", () =>
{
    it("keeps non-debug notices as tagged system messages", () =>
    {
        const session = botbanditAdapter.parse(noticeFile);
        const notice = session.messages.find(message => message.subtype === "notice");

        expect(notice).toBeTruthy();
        expect(notice!.role).toBe("system");
        expect(notice!.text).toBe("[info] Auto-approved safe shell command by policy rule(s) bash(grep *).");
    });
});

describe("botbanditAdapter.parse — wrapped Codex sessions", () =>
{
    let session!: Session;
    beforeAll(() =>
    {
        session = botbanditAdapter.parse(codexWrapperFile);
    });

    it("emits one summary marker for the original Codex session", () =>
    {
        const summaries = session.messages.filter(message => message.subtype === "wrapped_codex");
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.role).toBe("summary");
        expect(summaries[0]!.timestamp).toBe("2026-06-28T13:00:02.000Z");
        expect(summaries[0]!.text).toContain("Original Codex session: thr_codex_123");
        expect(summaries[0]!.text).toContain("First observed turn: turn_codex_1");
        expect(summaries[0]!.text).toContain("Codex session file: /Users/ole/.codex/sessions/2026/06/28/rollout-2026-06-28T13-00-00-thr_codex_123.jsonl");
    });

    it("keeps the assistant transcript content", () =>
    {
        expect(session.messages.map(message => message.role)).toEqual(["user", "summary", "assistant", "assistant"]);
        expect(session.messages.at(-1)!.text).toBe("Still on the same Codex thread.");
    });
});

describe("botbanditAdapter.parse — simple session", () =>
{
    let session!: Session;
    beforeAll(() =>
    {
        session = botbanditAdapter.parse(simpleFile);
    });

    it("captures identity and metadata", () =>
    {
        expect(session.agent).toBe("botbandit");
        expect(session.sessionId).toBe("simple-session");
        expect(session.filePath).toBe(simpleFile);
        expect(session.cwd).toBe("/Users/ole/projekte/demo");
        expect(session.project).toBe("demo");
        expect(session.model).toBe("gpt-5.5");
    });

    it("captures timestamps from session_init and latest timestamped event", () =>
    {
        expect(session.startedAt).toBe("2026-06-28T10:00:00.000Z");
        expect(session.endedAt).toBe("2026-06-28T10:00:05.500Z");
    });

    it("emits user and assistant messages from persisted message events", () =>
    {
        expect(session.messages.map(message => message.role)).toEqual(["user", "assistant"]);
        expect(session.messages[0]!.text).toBe("Summarize the project.");
        expect(session.messages[1]!.text).toBe("This is a compact demo project.");
        expect(session.messageCount).toBe(2);
    });
});

describe("botbanditAdapter.parse — tool session", () =>
{
    let session!: Session;
    beforeAll(() =>
    {
        session = botbanditAdapter.parse(toolFile);
    });

    it("captures assistant tool calls and attaches tool results by toolCallId", () =>
    {
        const assistant = session.messages.find(message => message.toolCalls.length > 0);
        expect(assistant).toBeTruthy();
        const tool = assistant!.toolCalls[0]!;
        expect(tool.name).toBe("bash");
        expect(tool.input).toEqual({ cmd: "ls -1" });
        expect(tool.status).toBe("ok");
        expect(tool.output).toContain("README.md");
    });

    it("does not emit an extra tool message when the result matched an assistant call", () =>
    {
        expect(session.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
    });
});

describe("botbanditAdapter.parse — summaries", () =>
{
    let session!: Session;
    beforeAll(() =>
    {
        session = botbanditAdapter.parse(summaryFile);
    });

    it("emits compaction events as summary messages", () =>
    {
        const compaction = session.messages.find(message => message.subtype === "compaction");
        expect(compaction).toBeTruthy();
        expect(compaction!.role).toBe("summary");
        expect(compaction!.text).toContain("Compaction after 4 turns / 12 history messages.");
        expect(compaction!.text).toContain("Keep redaction conservative.");
        expect(compaction!.text).toContain("Older publishing discussion was summarized.");
    });

    it("emits memory events as summary messages", () =>
    {
        const memory = session.messages.find(message => message.subtype === "memory");
        expect(memory).toBeTruthy();
        expect(memory!.text).toContain("Memory: Publishing plan");
        expect(memory!.text).toContain("Goal: Publish sessions to the web");
        expect(memory!.text).toContain("Next steps:");
        expect(memory!.text).toContain("Importance: 0.8");
    });
});
