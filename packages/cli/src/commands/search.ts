import { Command } from "commander";

import { printSearchJson, printSearchPretty, type SearchHit } from "../format.js";
import { filterSessions, inTimeWindow, isValidAgent, parseTimeArg, type ScanFn } from "../scan.js";

export function makeSearchCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("search");
    cmd
        .description("Full-text search over session messages")
        .argument("<query>", "Case-insensitive search query")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("-p, --project <path>", "Filter by project (substring match)")
        .option(
            "--since <date>",
            "Only messages at/after this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option(
            "--until <date>",
            "Only messages at/before this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option("--pretty", "Print human-readable results instead of JSON lines")
        .action((query: string, opts: SearchOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`,
                );
                process.exitCode = 1;
                return;
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
            const timeWindow = { since, until };

            let sessions = scanFn();
            sessions = filterSessions(sessions, {
                agent: opts.agent,
                project: opts.project,
            });

            const q = query.toLowerCase();
            const hits: SearchHit[] = [];
            for (const s of sessions) 
            {
                for (let i = 0; i < s.messages.length; i++) 
                {
                    const msg = s.messages[i]!;
                    if (msg.text.toLowerCase().includes(q) && inTimeWindow(msg.timestamp, timeWindow)) 
                    {
                        hits.push({
                            agent: s.agent,
                            sessionId: s.sessionId,
                            messageIndex: i + 1,
                            role: msg.role,
                            text: msg.text,
                            timestamp: msg.timestamp,
                        });
                    }
                }
            }

            if (opts.pretty) 
            {
                printSearchPretty(hits);
            }
            else 
            {
                printSearchJson(hits);
            }
        });
    return cmd;
}

interface SearchOptions {
    agent?: string;
    project?: string;
    since?: string;
    until?: string;
    pretty?: boolean;
}
