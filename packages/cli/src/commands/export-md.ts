import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildPublishedSessionBundle, type PublishedRedactionMode, redactPublishedSessionBundle, renderPublishedSessionMarkdown } from "@session-bandit/core";
import { Command } from "commander";

import { resolveSession } from "../resolve.js";
import { isValidAgent, type ScanFn } from "../scan.js";

const REDACTION_MODES = new Set(["strict", "cautious", "minimal", "none"]);

export function makeExportMdCommand(scanFn: ScanFn): Command
{
    const cmd = new Command("export-md");
    cmd
        .description("Export a redacted session as a Markdown file")
        .argument("<sessionId>", "Session ID (or prefix)")
        .requiredOption("--out <path>", "Markdown output path")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("--title <title>", "Override the generated title")
        .option("--redact <mode>", "Redaction mode (strict | cautious | minimal | none)", "cautious")
        .option("--report-out <path>", "Optional redaction report JSON output path")
        .option("--yes", "Allow unsafe options such as --redact none")
        .action((sessionId: string, opts: ExportMdOptions) =>
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

            if (opts.redact === "none" && !opts.yes)
            {
                console.error("Refusing to export with --redact none unless --yes is provided.");
                process.exitCode = 1;
                return;
            }

            const session = resolveSession(scanFn(), sessionId, opts.agent);
            if (!session) { return; }

            const bundle = buildPublishedSessionBundle(session, {
                title: opts.title,
                redaction: { mode: opts.redact, reportPath: opts.reportOut ?? null },
            });
            const { bundle: redactedBundle, report } = redactPublishedSessionBundle(bundle, { mode: opts.redact });
            const markdown = renderPublishedSessionMarkdown(redactedBundle);

            writeFile(opts.out, markdown);
            if (opts.reportOut)
            {
                writeFile(opts.reportOut, JSON.stringify(report, null, 2) + "\n");
            }
        });
    return cmd;
}

interface ExportMdOptions {
    agent?: string;
    out: string;
    title?: string;
    redact: string;
    reportOut?: string;
    yes?: boolean;
}

function isRedactionMode(value: string): value is PublishedRedactionMode
{
    return REDACTION_MODES.has(value);
}

function writeFile(path: string, contents: string): void
{
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
}
