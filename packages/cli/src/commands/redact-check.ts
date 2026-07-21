import { buildPublishedSessionBundle, type PublishedRedactionMode,redactPublishedSessionBundle } from "@session-bandit/core";
import { Command } from "commander";

import { printRedactionReportJson, printRedactionReportPretty } from "../format.js";
import { resolveSession } from "../resolve.js";
import { isValidAgent, type ScanFn } from "../scan.js";

const REDACTION_MODES = new Set(["strict", "cautious", "minimal", "none"]);

export function makeRedactCheckCommand(scanFn: ScanFn): Command
{
    const cmd = new Command("redact-check");
    cmd
        .description("Preview redaction findings for a session without writing an export")
        .argument("<sessionId>", "Session ID (or prefix)")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("--redact <mode>", "Redaction mode (strict | cautious | minimal | none)", "cautious")
        .option("--pretty", "Print a human-readable redaction report instead of JSON")
        .action((sessionId: string, opts: RedactCheckOptions) =>
        {
            if (opts.agent && !isValidAgent(opts.agent))
            {
                console.error(`Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`);
                process.exitCode = 1;
                return;
            }

            if (!isRedactionMode(opts.redact))
            {
                console.error(`Unknown redaction mode: "${opts.redact}". Valid: strict, cautious, minimal, none`);
                process.exitCode = 1;
                return;
            }

            const session = resolveSession(scanFn(), sessionId, opts.agent);
            if (!session) { return; }

            const bundle = buildPublishedSessionBundle(session, {
                redaction: { mode: opts.redact, reportPath: "redaction-report.json" },
            });
            const { report } = redactPublishedSessionBundle(bundle, { mode: opts.redact });

            if (opts.pretty)
            {
                printRedactionReportPretty(session, report);
            }
            else
            {
                printRedactionReportJson(report);
            }
        });
    return cmd;
}

interface RedactCheckOptions {
    agent?: string;
    redact: string;
    pretty?: boolean;
}

function isRedactionMode(value: string): value is PublishedRedactionMode
{
    return REDACTION_MODES.has(value);
}
