import type { Session } from "@session-bandit/core";
import { describe, expect, it } from "vitest";

import { filterByTime, inTimeWindow, parseTimeArg } from "../src/scan.js";

// Fixed reference point so relative-time tests are deterministic.
const NOW = new Date("2026-06-23T12:00:00.000Z");

function mkSession(startedAt: string): Session
{
    return {
        agent: "claude",
        sessionId: startedAt,
        filePath: "/fake/" + startedAt,
        project: null,
        cwd: null,
        startedAt,
        endedAt: null,
        model: null,
        messageCount: 0,
        messages: [],
    };
}

const SESSIONS: Session[] = [
    mkSession("2026-06-10T08:00:00.000Z"),
    mkSession("2026-06-15T10:00:00.000Z"),
    mkSession("2026-06-18T12:00:00.000Z"),
    mkSession("2026-06-22T09:00:00.000Z"),
];

// --- parseTimeArg ------------------------------------------------------------

describe("parseTimeArg", () =>
{
    it("parses relative hours", () =>
    {
        const d = parseTimeArg("24h", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-22T12:00:00.000Z");
    });

    it("parses relative days", () =>
    {
        const d = parseTimeArg("7d", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-16T12:00:00.000Z");
    });

    it("parses relative weeks", () =>
    {
        const d = parseTimeArg("2w", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-09T12:00:00.000Z");
    });

    it("parses relative months (30-day approximation)", () =>
    {
        const d = parseTimeArg("1m", NOW);
        expect(d).not.toBeNull();
        // 30 days back from 2026-06-23T12:00 → 2026-05-24T12:00
        expect(d!.toISOString()).toBe("2026-05-24T12:00:00.000Z");
    });

    it("parses fractional relative values", () =>
    {
        const d = parseTimeArg("0.5d", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-23T00:00:00.000Z");
    });

    it("parses an absolute date (date-only → UTC midnight)", () =>
    {
        const d = parseTimeArg("2026-06-15", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    });

    it("date-only with edge 'end' pins to the last instant of the day", () =>
    {
        const d = parseTimeArg("2026-06-15", NOW, "end");
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-15T23:59:59.999Z");
    });

    it("date-only with edge 'start' pins to UTC midnight", () =>
    {
        const d = parseTimeArg("2026-06-15", NOW, "start");
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    });

    it("full datetime ignores the edge argument", () =>
    {
        const a = parseTimeArg("2026-06-15T10:00:00Z", NOW, "start");
        const b = parseTimeArg("2026-06-15T10:00:00Z", NOW, "end");
        expect(a!.toISOString()).toBe("2026-06-15T10:00:00.000Z");
        expect(b!.toISOString()).toBe("2026-06-15T10:00:00.000Z");
    });

    it("parses an absolute datetime with timezone", () =>
    {
        const d = parseTimeArg("2026-06-15T10:00:00Z", NOW);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-06-15T10:00:00.000Z");
    });

    it("returns null for unparseable input", () =>
    {
        expect(parseTimeArg("bogus", NOW)).toBeNull();
        expect(parseTimeArg("not-a-date", NOW)).toBeNull();
    });

    it("returns null for an unknown unit", () =>
    {
        expect(parseTimeArg("5s", NOW)).toBeNull();
        expect(parseTimeArg("5y", NOW)).toBeNull();
    });

    it("defaults `now` to the current wall-clock time", () =>
    {
        const before = Date.now();
        const d = parseTimeArg("1h");
        const after = Date.now();
        expect(d).not.toBeNull();
        // Within the 1-hour window centered on "now - 1h".
        const got = d!.getTime();
        expect(got).toBeGreaterThanOrEqual(before - 3_600_000 - 5);
        expect(got).toBeLessThanOrEqual(after - 3_600_000 + 5);
    });
});

// --- filterByTime ------------------------------------------------------------

describe("filterByTime", () =>
{
    it("returns all sessions when no window is given", () =>
    {
        expect(filterByTime(SESSIONS, {})).toHaveLength(4);
    });

    it("since keeps sessions at or after the boundary", () =>
    {
        const since = new Date("2026-06-15T10:00:00.000Z");
        const out = filterByTime(SESSIONS, { since });
        expect(out.map((s) => s.sessionId)).toEqual([
            "2026-06-15T10:00:00.000Z",
            "2026-06-18T12:00:00.000Z",
            "2026-06-22T09:00:00.000Z",
        ]);
    });

    it("until keeps sessions at or before the boundary", () =>
    {
        const until = new Date("2026-06-18T12:00:00.000Z");
        const out = filterByTime(SESSIONS, { until });
        expect(out.map((s) => s.sessionId)).toEqual([
            "2026-06-10T08:00:00.000Z",
            "2026-06-15T10:00:00.000Z",
            "2026-06-18T12:00:00.000Z",
        ]);
    });

    it("combined since+until keeps only the window", () =>
    {
        const out = filterByTime(SESSIONS, {
            since: new Date("2026-06-14T00:00:00.000Z"),
            until: new Date("2026-06-19T00:00:00.000Z"),
        });
        expect(out.map((s) => s.sessionId)).toEqual([
            "2026-06-15T10:00:00.000Z",
            "2026-06-18T12:00:00.000Z",
        ]);
    });

    it("drops sessions with an empty/unparseable startedAt", () =>
    {
        const weird: Session[] = [mkSession(""), mkSession("not-a-date")];
        const out = filterByTime(weird, { since: new Date("2020-01-01") });
        expect(out).toHaveLength(0);
    });
});

// --- inTimeWindow ------------------------------------------------------------

describe("inTimeWindow", () =>
{
    it("returns true when no window is set", () =>
    {
        expect(inTimeWindow(null, {})).toBe(true);
        expect(inTimeWindow("2026-06-15T10:00:00.000Z", {})).toBe(true);
    });

    it("respects since boundary", () =>
    {
        const since = new Date("2026-06-15T10:00:00.000Z");
        expect(inTimeWindow("2026-06-15T10:00:00.000Z", { since })).toBe(true);
        expect(inTimeWindow("2026-06-15T09:59:59.000Z", { since })).toBe(false);
    });

    it("respects until boundary", () =>
    {
        const until = new Date("2026-06-18T12:00:00.000Z");
        expect(inTimeWindow("2026-06-18T12:00:00.000Z", { until })).toBe(true);
        expect(inTimeWindow("2026-06-18T12:00:01.000Z", { until })).toBe(false);
    });

    it("drops null timestamps when a window is set", () =>
    {
        const since = new Date("2020-01-01");
        expect(inTimeWindow(null, { since })).toBe(false);
        expect(inTimeWindow("", { since })).toBe(false);
    });
});
