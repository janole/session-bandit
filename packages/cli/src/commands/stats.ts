import { type ClaudeGlobalStats, readClaudeStatsCache } from "@session-bandit/core";
import { Command } from "commander";

import { printGlobalStatsJson, printGlobalStatsPretty, printSessionStatsJson, printSessionStatsPretty, sumSessionTotals } from "../format.js";
import { filterSessions, isValidAgent, type ScanFn } from "../scan.js";

/** A function that returns the Claude global aggregate stats (or null if unavailable). */
export type GlobalStatsFn = () => ClaudeGlobalStats | null;

/** Build the `stats` command (per-session and global token/context stats). */
export function makeStatsCommand(scanFn: ScanFn, getGlobalStats: GlobalStatsFn = readClaudeStatsCache): Command
{
    const cmd = new Command("stats");
    cmd
        .description("Show token usage and context-window stats for a session, or aggregate usage with --global")
        .argument("[sessionId]", "Session ID (or prefix) — omit with --global")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("--global", "Show aggregate usage across all sessions (reads Claude's stats cache + sums per-session stats)")
        .option("--pretty", "Print a human-readable layout instead of JSON")
        .action((sessionId: string | undefined, opts: StatsOptions) =>
        {
            if (opts.agent && !isValidAgent(opts.agent))
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`,
                );
                process.exitCode = 1;
                return;
            }

            if (opts.global)
            {
                printGlobal(scanFn, opts, getGlobalStats);
                return;
            }

            if (!sessionId)
            {
                console.error("Either <sessionId> or --global is required. See `session-bandit stats --help`.");
                process.exitCode = 1;
                return;
            }

            const sessions = scanFn();
            const candidates = sessions.filter((s) =>
            {
                if (opts.agent && s.agent !== opts.agent) { return false; }
                return s.sessionId === sessionId || s.sessionId.startsWith(sessionId);
            });

            if (candidates.length === 0)
            {
                console.error(`No session found matching "${sessionId}".`);
                process.exitCode = 1;
                return;
            }
            if (candidates.length > 1)
            {
                console.error(
                    `Ambiguous session prefix "${sessionId}" — matches ${candidates.length} sessions:`,
                );
                for (const c of candidates.slice(0, 10))
                {
                    console.error(`  ${c.agent}  ${c.sessionId}  ${c.startedAt}`);
                }
                process.exitCode = 1;
                return;
            }

            if (opts.pretty)
            {
                printSessionStatsPretty(candidates[0]!);
            }
            else
            {
                printSessionStatsJson(candidates[0]!);
            }
        });
    return cmd;
}

interface StatsOptions
{
    agent?: string;
    global?: boolean;
    pretty?: boolean;
}

/** Print the aggregate global stats view. */
function printGlobal(scanFn: ScanFn, opts: StatsOptions, getGlobalStats: GlobalStatsFn): void
{
    const sessions = scanFn();
    const filtered = filterSessions(sessions, { agent: opts.agent });
    const totals = sumSessionTotals(filtered);

    const global = getGlobalStats();
    if (!global)
    {
        // No Claude stats cache available — fall back to summed per-session totals only.
        if (totals.withStats === 0)
        {
            console.error("No stats available: Claude's stats cache was not found and no sessions carry token usage.");
            process.exitCode = 1;
            return;
        }
        if (opts.pretty)
        {
            // Reuse the global pretty printer with an empty Claude global so only
            // the per-session totals and (empty) hour/model sections render.
            printGlobalStatsPretty(emptyClaudeGlobal(), totals);
        }
        else
        {
            console.log(JSON.stringify({ global: null, sessionTotals: totals }));
        }
        return;
    }

    if (opts.pretty)
    {
        printGlobalStatsPretty(global, totals);
    }
    else
    {
        printGlobalStatsJson(global, totals);
    }
}

/** An empty Claude global stats object, used when the cache is missing but per-session totals exist. */
function emptyClaudeGlobal()
{
    return {
        version: 0,
        lastComputedDate: "",
        totalSessions: 0,
        totalMessages: 0,
        firstSessionDate: "",
        longestSession: { sessionId: "", duration: 0, messageCount: 0, timestamp: "" },
        modelUsage: {},
        dailyActivity: [],
        dailyModelTokens: [],
        hourCounts: {},
    };
}
