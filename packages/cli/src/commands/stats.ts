import { type ClaudeGlobalStats, readClaudeStatsCache } from "@session-bandit/core";
import { Command } from "commander";

import { printGlobalStatsJson, printGlobalStatsPretty, printSessionStatsJson, printSessionStatsPretty, sumSessionTotals } from "../format.js";
import { resolveSession } from "../resolve.js";
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

            const session = resolveSession(scanFn(), sessionId, opts.agent);
            if (!session) { return; }

            if (opts.pretty)
            {
                printSessionStatsPretty(session);
            }
            else
            {
                printSessionStatsJson(session);
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

    // A missing Claude stats cache is not an error as long as transcripts carry usage —
    // both printers render `null` as "cache absent" rather than as zeroed totals.
    const global = getGlobalStats();
    if (!global && totals.withStats === 0)
    {
        console.error("No stats available: Claude's stats cache was not found and no sessions carry token usage.");
        process.exitCode = 1;
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
