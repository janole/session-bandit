import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { readClaudeStatsCache } from "../src/stats-cache.js";

const fixtureFile = join(__dirname, "fixtures", "stats-cache", "stats-cache.json");

describe("readClaudeStatsCache", () =>
{
    let stats!: NonNullable<ReturnType<typeof readClaudeStatsCache>>;

    beforeAll(() =>
    {
        stats = readClaudeStatsCache(fixtureFile)!;
    });

    it("returns null for a missing file", () =>
    {
        expect(readClaudeStatsCache(join(__dirname, "nope.json"))).toBeNull();
    });

    it("returns null for a malformed file", () =>
    {
        expect(readClaudeStatsCache(join(__dirname, "fixtures", "codex", "2026", "06", "19", "rollout-2026-06-19T10-00-00-fix-codex-0001.jsonl"))).toBeNull();
    });

    it("reads scalar totals", () =>
    {
        expect(stats.version).toBe(4);
        expect(stats.lastComputedDate).toBe("2026-07-20");
        expect(stats.totalSessions).toBe(434);
        expect(stats.totalMessages).toBe(136552);
        expect(stats.firstSessionDate).toBe("2026-01-22T10:42:06.325Z");
    });

    it("decodes per-model lifetime usage, dropping cost/contextWindow fields", () =>
    {
        expect(Object.keys(stats.modelUsage).sort()).toEqual([
            "claude-opus-4-5-20251101",
            "claude-sonnet-4-6",
        ]);
        const opus = stats.modelUsage["claude-opus-4-5-20251101"]!;
        expect(opus.inputTokens).toBe(89696);
        expect(opus.outputTokens).toBe(353840);
        expect(opus.cacheReadInputTokens).toBe(369209665);
        expect(opus.cacheCreationInputTokens).toBe(23575558);
        expect(opus.webSearchRequests).toBe(0);
        // costUSD / contextWindow / maxOutputTokens are not exposed.
        expect("costUSD" in opus).toBe(false);
    });

    it("decodes the longest session summary", () =>
    {
        expect(stats.longestSession.sessionId).toBe("4e4f7ab3-f198-45c8-9928-351d5d9a7c4b");
        expect(stats.longestSession.messageCount).toBe(5378);
        expect(stats.longestSession.duration).toBe(733133759);
    });

    it("decodes daily activity and per-day model tokens", () =>
    {
        expect(stats.dailyActivity).toHaveLength(2);
        expect(stats.dailyActivity[0]).toEqual({
            date: "2026-01-22",
            messageCount: 1043,
            sessionCount: 6,
            toolCallCount: 235,
        });
        expect(stats.dailyModelTokens).toHaveLength(2);
        expect(stats.dailyModelTokens[0]!.tokensByModel["claude-opus-4-5-20251101"]).toBe(14748);
    });

    it("decodes hour counts", () =>
    {
        expect(stats.hourCounts["22"]).toBe(36);
        expect(stats.hourCounts["10"]).toBe(31);
    });
});
