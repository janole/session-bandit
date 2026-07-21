import { type AdapterConfig, type AgentName, botbanditAdapter, claudeAdapter, codexAdapter, computeSubstance, extractRelatedSessions, type ImportanceTier, indexSessions, type Session, tierRank } from "@session-bandit/core";

/** All adapters v1 knows about, in display order. */
const ADAPTERS: AdapterConfig[] = [
    { adapter: claudeAdapter },
    { adapter: codexAdapter },
    { adapter: botbanditAdapter },
];

/** A function that returns a session index. */
export type ScanFn = () => Session[];

/**
 * Build a fresh in-memory index of all known sessions. v1 always scans fresh
 * — no persistence, no incremental updates.
 */
export function scanAll(): Session[] 
{
    return indexSessions(ADAPTERS);
}

/** Milliseconds per relative time unit. `m` is a 30-day month approximation. */
const UNIT_MS: Record<string, number> = {
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    m: 2_592_000_000,
};

/** Parse a relative (`7d`, `24h`, `2w`, `3m`) or absolute (`2026-06-01`) time argument into a Date.
 *
 * A date-only value (`2026-06-01`) is pinned to UTC midnight for `edge: "start"`
 * (the `--since` case) or to the last instant of that day for `edge: "end"`
 * (the `--until` case), so `--until 2026-06-01` includes sessions that started
 * later that day. Full datetimes are always treated as exact moments. */
export function parseTimeArg(
    arg: string,
    now: Date = new Date(),
    edge: "start" | "end" = "start",
): Date | null
{
    const rel = arg.match(/^(\d+(?:\.\d+)?)\s*([hdwm])$/);
    if (rel)
    {
        const n = parseFloat(rel[1]!);
        const unit = rel[2]!;
        return new Date(now.getTime() - n * UNIT_MS[unit]!);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg))
    {
        const d = new Date(arg);
        if (Number.isNaN(d.getTime())) { return null; }
        return edge === "end"
            ? new Date(d.getTime() + 86_400_000 - 1)
            : d;
    }
    const d = new Date(arg);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Convert an ISO 8601 string to epoch ms, or null if empty/unparseable. */
function epochMs(iso: string | null | undefined): number | null
{
    if (!iso) { return null; }
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
}

/** Filter sessions whose `startedAt` falls within the `[since, until]` window. */
export function filterByTime(
    sessions: Session[],
    opts: { since?: Date | null; until?: Date | null },
): Session[]
{
    if (!opts.since && !opts.until) { return sessions; }
    const sinceMs = opts.since?.getTime() ?? null;
    const untilMs = opts.until?.getTime() ?? null;
    return sessions.filter((s) =>
    {
        const ms = epochMs(s.startedAt);
        if (ms === null) { return false; }
        if (sinceMs !== null && ms < sinceMs) { return false; }
        if (untilMs !== null && ms > untilMs) { return false; }
        return true;
    });
}

/** True if a timestamp falls within `[since, until]`, or if no window is set. */
export function inTimeWindow(
    timestamp: string | null | undefined,
    opts: { since?: Date | null; until?: Date | null },
): boolean
{
    if (!opts.since && !opts.until) { return true; }
    const ms = epochMs(timestamp);
    if (ms === null) { return false; }
    if (opts.since && ms < opts.since.getTime()) { return false; }
    if (opts.until && ms > opts.until.getTime()) { return false; }
    return true;
}

/**
 * Collect the ids of codex sessions that a BotBandit session ran underneath.
 *
 * BotBandit can drive codex as its provider, in which case the same conversation exists
 * twice on disk: once as the BotBandit session the user actually ran, and once as the
 * codex transcript beneath it. Aggregates must know which codex sessions those are, or
 * they count the same work twice.
 *
 * Derive this from the **unfiltered** index — a `--agent codex` view has no BotBandit
 * sessions left to learn it from.
 */
export function collectWrappedCodexIds(sessions: Session[]): Set<string>
{
    const wrapped = new Set<string>();
    for (const session of sessions)
    {
        if (session.agent !== "botbandit") { continue; }
        for (const related of extractRelatedSessions(session))
        {
            if (related.kind === "wrapped_codex") { wrapped.add(related.sessionId); }
        }
    }
    return wrapped;
}

/** Filter sessions by agent and/or project (substring match on project/cwd). */
export function filterSessions(
    sessions: Session[],
    opts: { agent?: string; project?: string },
): Session[] 
{
    let result = sessions;
    if (opts.agent) 
    {
        result = result.filter((s) => s.agent === opts.agent);
    }
    if (opts.project) 
    {
        const q = opts.project.toLowerCase();
        result = result.filter(
            (s) =>
                (s.project?.toLowerCase().includes(q) ?? false) ||
                (s.cwd?.toLowerCase().includes(q) ?? false),
        );
    }
    return result;
}

/** Sort sessions by startedAt descending (most recent first). */
export function sortByRecent(sessions: Session[]): Session[] 
{
    return [...sessions].sort((a, b) =>
        (b.startedAt || "").localeCompare(a.startedAt || ""),
    );
}

/** Sort sessions by substance score descending (most substantial first). */
export function sortByImportance(sessions: Session[]): Session[] 
{
    return [...sessions].sort(
        (a, b) => computeSubstance(b).score - computeSubstance(a).score,
    );
}

/** Keep only sessions whose substance tier is at least `min`. */
export function filterByMinImportance(
    sessions: Session[],
    min: ImportanceTier,
): Session[] 
{
    const minRank = tierRank(min);
    return sessions.filter((s) => tierRank(computeSubstance(s).tier) >= minRank);
}

/** Validate that a string is a known agent name. */
export function isValidAgent(name: string): name is AgentName 
{
    return name === "claude" || name === "codex" || name === "gemini" || name === "botbandit";
}
