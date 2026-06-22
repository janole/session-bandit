import { Command } from "commander";

import { printTranscript } from "../format.js";
import { isValidAgent, type ScanFn } from "../scan.js";

export function makeShowCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("show");
    cmd
        .description("Print the normalized transcript of a session")
        .argument("<sessionId>", "Session ID (or prefix)")
        .option("-a, --agent <name>", "Filter by agent (claude | codex)")
        .action((sessionId: string, opts: ShowOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex`,
                );
                process.exitCode = 1;
                return;
            }

            const sessions = scanFn();
            // Match by full sessionId or by prefix (first N chars).
            const candidates = sessions.filter((s) => 
            {
                if (opts.agent && s.agent !== opts.agent) {return false;}
                return (
                    s.sessionId === sessionId ||
          s.sessionId.startsWith(sessionId)
                );
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

            printTranscript(candidates[0]!);
        });
    return cmd;
}

interface ShowOptions {
    agent?: string;
}
