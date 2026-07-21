import { join } from "node:path";

import { beforeAll,describe, expect, it } from "vitest";

import { botbanditAdapter } from "../../src/adapters/botbandit.js";
import type { Session } from "../../src/types.js";

const fixtureRoot = join(__dirname, "..", "fixtures", "botbandit");
const simpleFile = join(fixtureRoot, "simple-session.jsonl");
const toolFile = join(fixtureRoot, "tool-session.jsonl");
const summaryFile = join(fixtureRoot, "summary-session.jsonl");
const codexWrapperFile = join(fixtureRoot, "codex-wrapper-session.jsonl");
const codexWrapperProviderOptionsFile = join(fixtureRoot, "codex-wrapper-provideroptions-session.jsonl");
const noticeFile = join(fixtureRoot, "notice-session.jsonl");
const multistepLoopFile = join(fixtureRoot, "multistep-loop-session.jsonl");

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
        expect(files).toHaveLength(7);
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

describe("botbanditAdapter.parse — wrapped Codex sessions via providerOptions", () =>
{
    // The codex provider moved its thread pointer from `providerMetadata` to
    // `providerOptions`, and onto the reasoning part rather than the text part. Reading
    // only the old location silently dropped the link on every current session.
    let session!: Session;
    beforeAll(() =>
    {
        session = botbanditAdapter.parse(codexWrapperProviderOptionsFile);
    });

    it("links the underlying codex thread", () =>
    {
        const summaries = session.messages.filter(message => message.subtype === "wrapped_codex");
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.text).toContain("019cf7d6-9c29-7331-b631-27b9313acfd6");
        expect(summaries[0]!.metadata?.relatedSessions?.[0]).toMatchObject({
            agent: "codex",
            kind: "wrapped_codex",
            sessionId: "019cf7d6-9c29-7331-b631-27b9313acfd6",
        });
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

// ---- token / context stats ------------------------------------------------

describe("botbanditAdapter.parse — stats (turn_end / loop_end usage)", () =>
{
    it("accumulates usage from turn_end only (loop_end is an aggregate duplicate)", () =>
    {
        // The fixture has a turn_end and a loop_end with identical usage
        // inputTokens=92789, cachedInputTokens=5504, outputTokens=788,
        // reasoningTokens=53. loop_end.usage is the accumulated sum of all steps
        // in the loop (botbandit builds it via addLanguageModelUsage), so it MUST
        // NOT be accumulated again — that would double-count every token.
        // BotBandit inputTokens includes cached and outputTokens includes reasoning,
        // so totals are normalized to fresh input / non-reasoning output.
        const s = botbanditAdapter.parse(toolFile);
        expect(s.stats).toBeDefined();
        expect(s.stats!.totalInputTokens).toBe(92789 - 5504);
        expect(s.stats!.totalOutputTokens).toBe(788 - 53);
        expect(s.stats!.cachedInputTokens).toBe(5504);
        expect(s.stats!.reasoningTokens).toBe(53);
    });

    it("tracks peak and final context size from inputTokens (the prompt size)", () =>
    {
        const s = botbanditAdapter.parse(toolFile);
        expect(s.stats!.peakContextSize).toBe(92789);
        expect(s.stats!.finalContextSize).toBe(92789);
    });

    it("attaches per-turn usage to the nearest preceding assistant message", () =>
    {
        const s = botbanditAdapter.parse(toolFile);
        const last = s.messages[s.messages.length - 1]!;
        expect(last.role).toBe("assistant");
        expect(last.stats).toBeDefined();
        // Fresh input = input - cached; contextSize is the full prompt (input includes cached).
        expect(last.stats!.inputTokens).toBe(92789 - 5504);
        expect(last.stats!.outputTokens).toBe(788 - 53);
        expect(last.stats!.cachedInputTokens).toBe(5504);
        // contextSize falls back to totalTokens when inputTokens is 0; here inputTokens
        // is populated so contextSize equals inputTokens (the full prompt including cached).
        expect(last.stats!.contextSize).toBe(92789);
    });

    it("leaves stats undefined when no usage events are present", () =>
    {
        expect(botbanditAdapter.parse(simpleFile).stats).toBeUndefined();
    });

    // Regression: loop_end.usage is the accumulated sum of all turn_end usages in
    // the loop (botbandit builds it via addLanguageModelUsage in agent-session.ts).
    // It MUST NOT feed the stats — otherwise every token is double-counted and
    // peakContextSize is inflated by a multi-step aggregate instead of the real
    // per-turn prompt size. This is the exact shape of the user-reported 1.77M
    // peak on a ~161k-window session.
    it("ignores loop_end aggregate usage (no double-count, peak is per-turn)", () =>
    {
        // Fixture: 3 turn_ends with inputTokens 100000 / 120000 / 150000, then a
        // loop_end with inputTokens 370000 (the sum of the three turns).
        const s = botbanditAdapter.parse(multistepLoopFile);
        expect(s.stats).toBeDefined();
        // Totals = sum of turn_ends only, NOT including the 370000 loop_end aggregate.
        expect(s.stats!.totalInputTokens).toBe(100000 + 120000 + 150000);
        expect(s.stats!.totalOutputTokens).toBe(500 + 600 + 700);
        // Peak is the largest single turn_end, not the 370000 loop aggregate.
        expect(s.stats!.peakContextSize).toBe(150000);
        expect(s.stats!.finalContextSize).toBe(150000);
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

    it("emits sub-agent events as related session summaries", () =>
    {
        const subAgents = session.messages.filter(message => message.subtype === "sub_agent");
        expect(subAgents).toHaveLength(2);
        expect(subAgents[0]!.role).toBe("summary");
        expect(subAgents[0]!.text).toContain("Sub-agent research started");
        expect(subAgents[0]!.metadata?.relatedSessions).toEqual([
            {
                agent: "botbandit",
                kind: "sub_agent",
                sessionId: "sub-session-1",
                title: "Find prior publishing work",
                turnId: "turn-sub-1",
            },
        ]);
        expect(subAgents[1]!.text).toContain("Sub-agent sub-session-1 finished (ok).");
        expect(subAgents[1]!.metadata?.relatedSessions?.[0]?.title).toBe("Find prior publishing work");
    });
});
