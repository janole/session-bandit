import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Default location of the Claude aggregate stats cache. */
export const DEFAULT_CLAUDE_STATS_CACHE_PATH = "~/.claude/stats-cache.json";

/** Expand a leading tilde to the home dir (inlined to avoid a cycle with index.ts). */
function expandHome(p: string): string
{
    if (p === "~") { return homedir(); }
    if (p.startsWith("~/")) { return homedir() + p.slice(1); }
    return p;
}

/**
 * Claude Code maintains an aggregate usage cache at `~/.claude/stats-cache.json`.
 * It is not a session transcript — it holds lifetime totals, per-day activity,
 * and per-model token rolls across every Claude Code session on the machine.
 * Session Bandit reads it for the optional `stats --global` view; per-session
 * stats come from the transcripts themselves.
 *
 * The cache is best-effort and versioned; `costUSD`, `contextWindow`, and
 * `maxOutputTokens` are present but `0` in real data, so they are not exposed.
 */

/** Per-model lifetime token totals from Claude's stats cache. */
export interface ClaudeModelUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
}

/** One day of Claude activity (messages, sessions, tool calls). */
export interface ClaudeDailyActivity {
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
}

/** One day of per-model token usage from Claude's stats cache. */
export interface ClaudeDailyModelTokens {
    date: string;
    tokensByModel: Record<string, number>;
}

/** Longest-session summary recorded by Claude's stats cache. */
export interface ClaudeLongestSession {
    sessionId: string;
    duration: number;
    messageCount: number;
    timestamp: string;
}

/** Aggregate Claude usage stats decoded from `~/.claude/stats-cache.json`. */
export interface ClaudeGlobalStats {
    version: number;
    lastComputedDate: string;
    totalSessions: number;
    totalMessages: number;
    firstSessionDate: string;
    longestSession: ClaudeLongestSession;
    modelUsage: Record<string, ClaudeModelUsage>;
    dailyActivity: ClaudeDailyActivity[];
    dailyModelTokens: ClaudeDailyModelTokens[];
    hourCounts: Record<string, number>;
}

interface RawStatsCache {
    version?: number;
    lastComputedDate?: string;
    totalSessions?: number;
    totalMessages?: number;
    firstSessionDate?: string;
    longestSession?: ClaudeLongestSession;
    modelUsage?: Record<string, Partial<ClaudeModelUsage>>;
    dailyActivity?: ClaudeDailyActivity[];
    dailyModelTokens?: ClaudeDailyModelTokens[];
    hourCounts?: Record<string, number>;
}

/** Read and decode Claude's aggregate stats cache. Returns null if missing or malformed. */
export function readClaudeStatsCache(path: string = DEFAULT_CLAUDE_STATS_CACHE_PATH): ClaudeGlobalStats | null
{
    let raw: string;
    try
    {
        raw = readFileSync(expandHome(path), "utf8");
    }
    catch
    {
        return null;
    }

    let doc: RawStatsCache;
    try
    {
        doc = JSON.parse(raw) as RawStatsCache;
    }
    catch
    {
        return null;
    }

    if (!doc || typeof doc !== "object") { return null; }

    const modelUsage: Record<string, ClaudeModelUsage> = {};
    for (const [model, usage] of Object.entries(doc.modelUsage ?? {}))
    {
        if (!usage || typeof usage !== "object") { continue; }
        modelUsage[model] = {
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
            cacheReadInputTokens: num(usage.cacheReadInputTokens),
            cacheCreationInputTokens: num(usage.cacheCreationInputTokens),
            webSearchRequests: num(usage.webSearchRequests),
        };
    }

    return {
        version: num(doc.version),
        lastComputedDate: str(doc.lastComputedDate),
        totalSessions: num(doc.totalSessions),
        totalMessages: num(doc.totalMessages),
        firstSessionDate: str(doc.firstSessionDate),
        longestSession: doc.longestSession ?? { sessionId: "", duration: 0, messageCount: 0, timestamp: "" },
        modelUsage,
        dailyActivity: Array.isArray(doc.dailyActivity) ? doc.dailyActivity : [],
        dailyModelTokens: Array.isArray(doc.dailyModelTokens) ? doc.dailyModelTokens : [],
        hourCounts: doc.hourCounts ?? {},
    };
}

/** Coerce an unknown value to a non-negative integer, defaulting to 0. */
function num(v: unknown): number
{
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Coerce an unknown value to a string, defaulting to "". */
function str(v: unknown): string
{
    return typeof v === "string" ? v : "";
}
