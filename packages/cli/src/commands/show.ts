import { Command } from "commander";

import { printTranscript } from "../format.js";
import { resolveSession } from "../resolve.js";
import { isValidAgent, type ScanFn } from "../scan.js";

export function makeShowCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("show");
    cmd
        .description("Print the normalized transcript of a session")
        .argument("<sessionId>", "Session ID (or prefix)")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .action((sessionId: string, opts: ShowOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`,
                );
                process.exitCode = 1;
                return;
            }

            const session = resolveSession(scanFn(), sessionId, opts.agent);
            if (!session) { return; }

            printTranscript(session);
        });
    return cmd;
}

interface ShowOptions {
    agent?: string;
}
