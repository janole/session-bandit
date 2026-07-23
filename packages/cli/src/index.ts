import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { makeDoctorCommand } from "./commands/doctor.js";
import { makeExportMdCommand } from "./commands/export-md.js";
import { makeExtractCommand } from "./commands/extract.js";
import { makeListCommand } from "./commands/list.js";
import { makeRedactCheckCommand } from "./commands/redact-check.js";
import { makeSearchCommand } from "./commands/search.js";
import { makeShowCommand } from "./commands/show.js";
import { makeStatsCommand } from "./commands/stats.js";
import { scanAll, scanForSearch } from "./scan.js";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
const VERSION = packageJson.version ?? "0.0.0";

// Re-export core for programmatic use.
export { filterByMinImportance, filterByTime, filterSessions, inTimeWindow, parseTimeArg, scanAll, type ScanFn,scanForSearch, sortByImportance, sortByRecent } from "./scan.js";
export {
    type AdapterConfig,
    type AgentName,
    claudeAdapter,
    codexAdapter,
    diagnoseAll,
    type DoctorReport,
    indexSessions,
    type Message,
    readClaudeStatsCache,
    type Session,
    type SessionStats,
    type ToolCall,
} from "@session-bandit/core";

/**
 * Build the Commander program (without running it). Useful for tests.
 */
export function createProgram(): Command 
{
    const program = new Command();
    program
        .name("session-bandit")
        .description(
            "Search, browse, and extract information from your coding agent sessions.",
        )
        .version(VERSION);

    program.addCommand(makeListCommand(scanAll));
    program.addCommand(makeShowCommand(scanAll));
    program.addCommand(makeSearchCommand(scanForSearch));
    program.addCommand(makeExtractCommand(scanAll));
    program.addCommand(makeRedactCheckCommand(scanAll));
    program.addCommand(makeExportMdCommand(scanAll));
    program.addCommand(makeDoctorCommand());
    program.addCommand(makeStatsCommand(scanAll));

    return program;
}

/**
 * Run the CLI with the given arguments. Errors are printed to stderr and
 * `process.exitCode` is set (never calls `process.exit` directly so tests
 * can capture output without the process dying).
 */
export function cli(argv: string[]): void 
{
    const program = createProgram();
    program.exitOverride(); // throw on --help/--version/parse errors instead of exiting
    try 
    {
        program.parse(["node", "session-bandit", ...argv]);
    }
    catch (err) 
    {
    // Commander throws CommanderError on parse errors / --help / --version.
    // We only treat real parse errors as failures; --help/--version exit 0.
        const e = err as { exitCode?: number; code?: string };
        if (e.code === "commander.help" || e.code === "commander.version") 
        {
            return;
        }
        if (e.exitCode !== undefined) 
        {
            process.exitCode = e.exitCode;
        }
    }
}
