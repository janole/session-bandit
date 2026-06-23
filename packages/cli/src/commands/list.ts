import { Command } from "commander";

import { parseTier,printListJson, printListPretty } from "../format.js";
import { filterByMinImportance, filterByTime, filterSessions, isValidAgent, parseTimeArg, type ScanFn, sortByImportance, sortByRecent } from "../scan.js";

export function makeListCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("list");
    cmd
        .description("List sessions, sorted by most recent first")
        .option("-a, --agent <name>", "Filter by agent (claude | codex)")
        .option("-p, --project <path>", "Filter by project (substring match)")
        .option(
            "--sort <field>",
            "Sort order: recent (default) or importance (substance score)",
        )
        .option(
            "--min-importance <tier>",
            "Drop sessions below this tier (trivial|light|moderate|substantive|heavy)",
        )
        .option(
            "--since <date>",
            "Only sessions started at/after this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option(
            "--until <date>",
            "Only sessions started at/before this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option("--pretty", "Print a human-readable table instead of JSON lines")
        .action((opts: ListOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex`,
                );
                process.exitCode = 1;
                return;
            }
            if (opts.sort !== undefined && opts.sort !== "recent" && opts.sort !== "importance") 
            {
                console.error(
                    `Unknown sort: "${opts.sort}". Valid: recent, importance`,
                );
                process.exitCode = 1;
                return;
            }
            let minTier;
            if (opts.minImportance !== undefined) 
            {
                minTier = parseTier(opts.minImportance);
                if (!minTier) 
                {
                    console.error(
                        `Unknown importance tier: "${opts.minImportance}". Valid: trivial, light, moderate, substantive, heavy`,
                    );
                    process.exitCode = 1;
                    return;
                }
            }

            const since = opts.since !== undefined ? parseTimeArg(opts.since, undefined, "start") : null;
            if (opts.since !== undefined && !since) 
            {
                console.error(
                    `Invalid --since value: "${opts.since}". Use a date (2026-06-01) or relative (7d, 24h, 2w, 3m).`,
                );
                process.exitCode = 1;
                return;
            }
            const until = opts.until !== undefined ? parseTimeArg(opts.until, undefined, "end") : null;
            if (opts.until !== undefined && !until) 
            {
                console.error(
                    `Invalid --until value: "${opts.until}". Use a date (2026-06-01) or relative (7d, 24h, 2w, 3m).`,
                );
                process.exitCode = 1;
                return;
            }

            let sessions = scanFn();
            sessions = filterSessions(sessions, {
                agent: opts.agent,
                project: opts.project,
            });
            sessions = filterByTime(sessions, { since, until });
            if (minTier) 
            {
                sessions = filterByMinImportance(sessions, minTier);
            }
            sessions =
                opts.sort === "importance"
                    ? sortByImportance(sessions)
                    : sortByRecent(sessions);

            if (opts.pretty) 
            {
                printListPretty(sessions);
            }
            else 
            {
                printListJson(sessions);
            }
        });
    return cmd;
}

interface ListOptions {
    agent?: string;
    project?: string;
    sort?: string;
    minImportance?: string;
    since?: string;
    until?: string;
    pretty?: boolean;
}
