import { basename, dirname,join } from "node:path";

import { beforeAll,describe, expect, it } from "vitest";

import { claudeAdapter, decodeCwd } from "../../src/adapters/claude.js";
import type { Session } from "../../src/types.js";

const fixtureRoot = join(__dirname, "..", "fixtures", "claude");

describe("decodeCwd", () => 
{
    it("decodes an encoded cwd directory name", () => 
    {
        expect(decodeCwd("-Users-ole-projekte-demo")).toBe(
            "/Users/ole/projekte/demo",
        );
    });
    it("leaves non-encoded names unchanged", () => 
    {
        expect(decodeCwd("plain")).toBe("plain");
    });
});

describe("claudeAdapter.discover", () => 
{
    it("finds .jsonl files under project subdirectories", () => 
    {
        const files = claudeAdapter.discover(fixtureRoot);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain("fix-aaaa-0001.jsonl");
    });

    it("returns [] for a missing root", () => 
    {
        expect(claudeAdapter.discover(join(fixtureRoot, "nope"))).toEqual([]);
    });

    it("defaultRoot is ~/.claude/projects", () => 
    {
        expect(claudeAdapter.defaultRoot()).toBe("~/.claude/projects");
    });

    it("agent is claude", () => 
    {
        expect(claudeAdapter.agent).toBe("claude");
    });
});

// The fixture file lives at fixtures/claude/<encoded-cwd>/fix-aaaa-0001.jsonl,
// matching the real ~/.claude/projects layout. Parse it directly to test the
// parser in isolation.
const fixtureFile = join(
    fixtureRoot,
    "-Users-ole-projekte-demo",
    "fix-aaaa-0001.jsonl",
);

describe("claudeAdapter.parse", () => 
{
    let session!: Session;
    beforeAll(() => 
    {
        session = claudeAdapter.parse(fixtureFile);
    });

    it("parses without throwing", () => 
    {
        expect(session).toBeTruthy();
    });

    it("captures agent, sessionId, filePath", () => 
    {
        expect(session.agent).toBe("claude");
        expect(session.sessionId).toBe("fix-aaaa-0001");
        expect(session.filePath).toBe(fixtureFile);
    });

    it("captures cwd and project from the session content", () => 
    {
        expect(session.cwd).toBe("/Users/ole/projekte/demo");
        expect(session.project).toBe("/Users/ole/projekte/demo");
    });

    it("captures startedAt and endedAt from timestamps", () => 
    {
        expect(session.startedAt).toBe("2026-06-01T10:00:00.000Z");
        // endedAt tracks the last line with a timestamp — the away_summary recap
        expect(session.endedAt).toBe("2026-06-01T11:30:00.000Z");
    });

    it("captures the assistant model", () => 
    {
        expect(session.model).toBe("claude-sonnet-4-6");
    });

    it("emits user and assistant messages, skipping meta/system/mode lines", () => 
    {
        const roles = session.messages.map((m) => m.role);
        // 1 user (initial) + 2 assistant + 2 user tool_result-only turns (no text msg emitted)
        expect(roles.filter((r) => r === "user")).toHaveLength(1);
        expect(roles.filter((r) => r === "assistant")).toHaveLength(2);
        // 3 user/assistant turns + 1 away_summary recap
        expect(session.messageCount).toBe(4);
    });

    it("emits away_summary recaps as summary messages with subtype recap", () => 
    {
        const recaps = session.messages.filter((m) => m.role === "summary");
        expect(recaps).toHaveLength(1);
        const recap = recaps[0]!;
        expect(recap.subtype).toBe("recap");
        expect(recap.text).toContain("Reviewed commit abc123");
        expect(recap.text).toContain("Next:");
        expect(recap.timestamp).toBe("2026-06-01T11:30:00.000Z");
        // recaps carry no tool calls
        expect(recap.toolCalls).toEqual([]);
    });

    it("still skips turn_duration and other metadata-only system lines", () => 
    {
        // turn_duration must NOT become a message — only away_summary is content-bearing
        expect(session.messages.some((m) => m.text.includes("turn_duration"))).toBe(false);
        const systemMsgs = session.messages.filter((m) => m.role === "system");
        expect(systemMsgs).toHaveLength(0);
    });

    it("joins assistant text blocks and excludes thinking", () => 
    {
        const a1 = session.messages.find((m) => m.text === "I'll look at the commit first.");
        expect(a1).toBeTruthy();
        expect(a1!.role).toBe("assistant");
        // thinking block must NOT leak into text
        expect(a1!.text).not.toContain("Let me check the diff");
    });

    it("captures tool_use calls on the assistant message", () => 
    {
        const a1 = session.messages.find((m) => m.text === "I'll look at the commit first.");
        expect(a1!.toolCalls).toHaveLength(1);
        expect(a1!.toolCalls[0]!.name).toBe("Bash");
        expect(a1!.toolCalls[0]!.input).toEqual({ command: "git show abc123" });
        expect(a1!.toolCalls[0]!.status).toBe("ok");
        expect(a1!.toolCalls[0]!.output).toContain("commit abc123");
    });

    it("marks errored tool results with status error", () => 
    {
        const a2 = session.messages.find((m) => m.text.startsWith("Now let me run"));
        expect(a2!.toolCalls).toHaveLength(1);
        expect(a2!.toolCalls[0]!.status).toBe("error");
        expect(a2!.toolCalls[0]!.output).toBe("Error: tests failed");
    });

    it("project falls back to decoded dir name when cwd absent", () => 
    {
    // the fixture dir name is the encoded cwd; decoding it yields the project path
        const dir = basename(dirname(fixtureFile));
        expect(dir).toBe("-Users-ole-projekte-demo");
        expect(decodeCwd(dir)).toBe("/Users/ole/projekte/demo");
    });

    it("does not throw on an empty/garbage file", () => 
    {
        const s = claudeAdapter.parse(join(fixtureRoot, "does-not-exist.jsonl"));
        expect(s.messageCount).toBe(0);
        expect(s.messages).toEqual([]);
    });
});

// ---- token / context stats ------------------------------------------------

describe("claudeAdapter.parse — stats (message.usage)", () =>
{
    let session!: Session;
    beforeAll(() =>
    {
        session = claudeAdapter.parse(fixtureFile);
    });

    it("captures per-assistant-message usage", () =>
    {
        const assistants = session.messages.filter((m) => m.role === "assistant");
        const a1 = assistants.find((m) => m.text.includes("I'll look at the commit"));
        expect(a1!.stats).toBeDefined();
        expect(a1!.stats!.inputTokens).toBe(2);
        expect(a1!.stats!.outputTokens).toBe(353);
        expect(a1!.stats!.cachedInputTokens).toBe(8375 + 7732);
        // Claude prompt size = fresh input + cache creation + cache reads.
        expect(a1!.stats!.contextSize).toBe(2 + 8375 + 7732);
        expect(a1!.stats!.reasoningTokens).toBe(0);
    });

    it("sums per-message usage into session totals", () =>
    {
        expect(session.stats).toBeDefined();
        expect(session.stats!.totalInputTokens).toBe(2 + 12);
        expect(session.stats!.totalOutputTokens).toBe(353 + 410);
        expect(session.stats!.cachedInputTokens).toBe((8375 + 7732) + (9000 + 20000));
    });

    it("does not report a context-window limit for Claude", () =>
    {
        // Claude's transcript carries per-turn prompt sizes but not the model's limit,
        // so context sizes are reported in absolute tokens with no percentage.
        expect(session.stats!.contextWindow).toBeNull();
    });

    it("derives peak and final context size from per-turn prompt sizes", () =>
    {
        // Each turn's prompt size is input + cache_creation + cache_read.
        const turn1 = 2 + 8375 + 7732;
        const turn2 = 12 + 9000 + 20000;
        expect(session.stats!.finalContextSize).toBe(turn2);
        expect(session.stats!.peakContextSize).toBe(Math.max(turn1, turn2));
    });
});
