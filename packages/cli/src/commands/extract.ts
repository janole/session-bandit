import { computeDigest } from "@session-bandit/core";
import { Command } from "commander";

import { printDigestJson, printDigestPretty, printDigestPrompt } from "../format.js";
import { resolveSession } from "../resolve.js";
import { isValidAgent, type ScanFn } from "../scan.js";

export function makeExtractCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("extract");
    cmd
        .description(
            "Emit a structured digest of a session (substance, files, commands, key turns)",
        )
        .argument("<sessionId>", "Session ID (or prefix)")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("--prompt <kind>", "Wrap the digest in a synthesis prompt (handoff | memory)")
        .option("--full", "Include the complete de-noised transcript")
        .option("--pretty", "Print a human-readable digest instead of JSON")
        .action((sessionId: string, opts: ExtractOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`,
                );
                process.exitCode = 1;
                return;
            }
            if (
                opts.prompt !== undefined &&
        opts.prompt !== "handoff" &&
        opts.prompt !== "memory"
            ) 
            {
                console.error(
                    `Unknown prompt kind: "${opts.prompt}". Valid: handoff, memory`,
                );
                process.exitCode = 1;
                return;
            }

            const session = resolveSession(scanFn(), sessionId, opts.agent);
            if (!session) { return; }

            const digest = computeDigest(session, { full: opts.full });

            if (opts.prompt) 
            {
                printDigestPrompt(digest, opts.prompt);
            }
            else if (opts.pretty) 
            {
                printDigestPretty(digest);
            }
            else 
            {
                printDigestJson(digest);
            }
        });
    return cmd;
}

interface ExtractOptions {
    agent?: string;
    prompt?: string;
    full?: boolean;
    pretty?: boolean;
}
