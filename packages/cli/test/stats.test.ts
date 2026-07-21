import type { ClaudeGlobalStats, Session } from "@session-bandit/core";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { makeStatsCommand } from "../src/commands/stats.js";
import { type ScanFn } from "../src/scan.js";

// --- fixture sessions --------------------------------------------------------

function makeStatsSession(): Session
{
    return {
        agent: "codex",
        sessionId: "codex-dddd-0004",
        filePath: "/fake/codex-dddd-0004.jsonl",
        project: "/Users/ole/projekte/demo",
        cwd: "/Users/ole/projekte/demo",
        startedAt: "2026-06-20T09:00:00.000Z",
        endedAt: "2026-06-20T09:05:00.000Z",
        model: "gpt-5.5",
        messageCount: 2,
        messages: [
            {
                role: "user",
                text: "Show me the changes.",
                toolCalls: [],
                timestamp: "2026-06-20T09:00:00.000Z",
            },
            {
                role: "assistant",
                text: "Here they are.",
                toolCalls: [],
                timestamp: "2026-06-20T09:00:05.000Z",
                stats: {
                    inputTokens: 22088,
                    outputTokens: 1700,
                    cachedInputTokens: 17792,
                    reasoningTokens: 1178,
                    contextSize: 34373,
                },
            },
        ],
        stats: {
            totalInputTokens: 72864,
            totalOutputTokens: 2536,
            cachedInputTokens: 44160,
            reasoningTokens: 1607,
            contextWindow: 258400,
            finalContextSize: 75400,
            peakContextSize: 75400,
        },
    };
}

function makeEmptySession(): Session
{
    return {
        agent: "claude",
        sessionId: "claude-empty-0005",
        filePath: "/fake/claude-empty-0005.jsonl",
        project: null,
        cwd: null,
        startedAt: "2026-06-21T09:00:00.000Z",
        endedAt: null,
        model: null,
        messageCount: 0,
        messages: [],
    };
}

const fakeScan: ScanFn = () => [makeStatsSession(), makeEmptySession()];

const fakeGlobal: ClaudeGlobalStats = {
    version: 4,
    lastComputedDate: "2026-07-20",
    totalSessions: 434,
    totalMessages: 136552,
    firstSessionDate: "2026-01-22T10:42:06.325Z",
    longestSession: {
        sessionId: "4e4f7ab3-f198-45c8-9928-351d5d9a7c4b",
        duration: 733133759,
        messageCount: 5378,
        timestamp: "2026-03-15T07:49:46.933Z",
    },
    modelUsage: {
        "claude-opus-4-8": {
            inputTokens: 4616653,
            outputTokens: 45713062,
            cacheReadInputTokens: 5329110624,
            cacheCreationInputTokens: 170472123,
            webSearchRequests: 0,
        },
    },
    dailyActivity: [],
    dailyModelTokens: [],
    hourCounts: { "22": 36, "10": 31, "18": 30 },
};

// --- helpers -----------------------------------------------------------------

function runStats(
    args: string[],
    global: ClaudeGlobalStats | null = fakeGlobal,
): { stdout: string; stderr: string; exitCode: number }
{
    const stdoutArr: string[] = [];
    const stderrArr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...a: unknown[]) => stdoutArr.push(a.join(" "));
    console.error = (...a: unknown[]) => stderrArr.push(a.join(" "));
    process.exitCode = 0;
    try
    {
        const cmd: Command = makeStatsCommand(fakeScan, () => global);
        cmd.exitOverride();
        cmd.parse(["node", "test", ...args]);
    }
    catch (err)
    {
        const e = err as { exitCode?: number; code?: string };
        if (e.code !== "commander.help" && e.code !== "commander.version" && e.exitCode !== undefined)
        {
            process.exitCode = e.exitCode;
        }
    }
    finally
    {
        console.log = origLog;
        console.error = origErr;
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = origExitCode;
    return { stdout: stdoutArr.join("\n"), stderr: stderrArr.join("\n"), exitCode };
}

// --- tests -------------------------------------------------------------------

describe("stats command — per-session", () =>
{
    it("prints JSON with session totals and per-turn usage", () =>
    {
        const { stdout, exitCode } = runStats(["codex-dddd-0004"]);
        expect(exitCode).toBe(0);
        const view = JSON.parse(stdout);
        expect(view.agent).toBe("codex");
        expect(view.sessionId).toBe("codex-dddd-0004");
        expect(view.stats.totalInputTokens).toBe(72864);
        expect(view.stats.contextWindow).toBe(258400);
        expect(view.stats.finalContextSize).toBe(75400);
        expect(view.perTurn).toHaveLength(1);
        expect(view.perTurn[0].stats.contextSize).toBe(34373);
    });

    it("--pretty prints a human-readable layout with context window and per-turn", () =>
    {
        const { stdout, exitCode } = runStats(["codex-dddd-0004", "--pretty"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Session:  codex-dddd-0004");
        expect(stdout).toContain("Tokens");
        expect(stdout).toContain("Context window");
        expect(stdout).toContain("limit");
        expect(stdout).toContain("peak");
        expect(stdout).toContain("Per turn");
        expect(stdout).toContain("ctx");
    });

    it("--pretty counts reasoning tokens in the total", () =>
    {
        const { stdout, exitCode } = runStats(["codex-dddd-0004", "--pretty"]);
        expect(exitCode).toBe(0);
        // 72,864 input + 44,160 cached + 2,536 output + 1,607 reasoning.
        // Adapters split reasoning out of totalOutputTokens, so omitting it here
        // under-reports every reasoning-model session.
        expect(stdout).toContain("total          121,167");
    });

    it("matches a session by id prefix", () =>
    {
        const { stdout, exitCode } = runStats(["codex-dddd"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout).sessionId).toBe("codex-dddd-0004");
    });

    it("prints 'No token usage recorded' for a session without stats (--pretty)", () =>
    {
        const { stdout, exitCode } = runStats(["claude-empty-0005", "--pretty"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("No token usage recorded");
    });

    it("errors when no session matches", () =>
    {
        const { stderr, exitCode } = runStats(["nope-xxxx"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("No session found matching");
    });

    it("errors when neither sessionId nor --global is given", () =>
    {
        const { stderr, exitCode } = runStats([]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Either <sessionId> or --global is required");
    });
});

describe("stats command --global", () =>
{
    it("prints JSON with Claude global + summed session totals", () =>
    {
        const { stdout, exitCode } = runStats(["--global"]);
        expect(exitCode).toBe(0);
        const view = JSON.parse(stdout);
        expect(view.global.totalSessions).toBe(434);
        expect(view.global.modelUsage["claude-opus-4-8"].outputTokens).toBe(45713062);
        // The codex fixture has stats; the empty claude one does not.
        expect(view.sessionTotals.withStats).toBe(1);
        expect(view.sessionTotals.totalInputTokens).toBe(72864);
    });

    it("--pretty prints all-time totals, per-model tokens, and busiest hours", () =>
    {
        const { stdout, exitCode } = runStats(["--global", "--pretty"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("All-time");
        expect(stdout).toContain("434");
        expect(stdout).toContain("Tokens by model");
        expect(stdout).toContain("claude-opus-4-8");
        expect(stdout).toContain("Per-session totals");
        expect(stdout).toContain("Busiest hours");
        expect(stdout).toContain("22:00");
    });

    it("falls back to summed per-session totals when the global cache is missing", () =>
    {
        const { stdout, exitCode } = runStats(["--global", "--pretty"], null);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Per-session totals");
        expect(stdout).toContain("72,864");
    });

    it("errors when no global cache and no sessions carry stats", () =>
    {
        const emptyScan: ScanFn = () => [makeEmptySession()];
        const stdoutArr: string[] = [];
        const stderrArr: string[] = [];
        const origLog = console.log;
        const origErr = console.error;
        const origExitCode = process.exitCode;
        console.log = (...a: unknown[]) => stdoutArr.push(a.join(" "));
        console.error = (...a: unknown[]) => stderrArr.push(a.join(" "));
        process.exitCode = 0;
        try
        {
            const cmd: Command = makeStatsCommand(emptyScan, () => null);
            cmd.exitOverride();
            cmd.parse(["node", "test", "--global"]);
        }
        catch (err)
        {
            const e = err as { exitCode?: number; code?: string };
            if (e.code !== "commander.help" && e.code !== "commander.version" && e.exitCode !== undefined)
            {
                process.exitCode = e.exitCode;
            }
        }
        finally
        {
            console.log = origLog;
            console.error = origErr;
        }
        const exitCode = process.exitCode ?? 0;
        process.exitCode = origExitCode;
        expect(exitCode).toBe(1);
        expect(stderrArr.join("\n")).toContain("No stats available");
    });
});
