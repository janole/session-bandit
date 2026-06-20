import { Command } from "commander";
import { scanAll } from "./scan.js";
import { makeListCommand } from "./commands/list.js";
import { makeShowCommand } from "./commands/show.js";
import { makeSearchCommand } from "./commands/search.js";
import { makeExtractCommand } from "./commands/extract.js";
import { makeDoctorCommand } from "./commands/doctor.js";

// Re-export core for programmatic use.
export {
  indexSessions,
  claudeAdapter,
  codexAdapter,
  diagnoseAll,
  type AdapterConfig,
  type Session,
  type Message,
  type ToolCall,
  type AgentName,
  type DoctorReport,
} from "@session-bandit/core";
export { scanAll, filterSessions, sortByRecent, sortByImportance, filterByMinImportance, type ScanFn } from "./scan.js";

/**
 * Build the Commander program (without running it). Useful for tests.
 */
export function createProgram(): Command {
  const program = new Command();
  program
    .name("session-bandit")
    .description(
      "Search, browse, and extract information from your coding agent sessions.",
    )
    .version("0.0.0");

  program.addCommand(makeListCommand(scanAll));
  program.addCommand(makeShowCommand(scanAll));
  program.addCommand(makeSearchCommand(scanAll));
  program.addCommand(makeExtractCommand(scanAll));
  program.addCommand(makeDoctorCommand());

  return program;
}

/**
 * Run the CLI with the given arguments. Errors are printed to stderr and
 * `process.exitCode` is set (never calls `process.exit` directly so tests
 * can capture output without the process dying).
 */
export function cli(argv: string[]): void {
  const program = createProgram();
  program.exitOverride(); // throw on --help/--version/parse errors instead of exiting
  try {
    program.parse(["node", "session-bandit", ...argv]);
  } catch (err) {
    // Commander throws CommanderError on parse errors / --help / --version.
    // We only treat real parse errors as failures; --help/--version exit 0.
    const e = err as { exitCode?: number; code?: string };
    if (e.code === "commander.help" || e.code === "commander.version") {
      return;
    }
    if (e.exitCode !== undefined) {
      process.exitCode = e.exitCode;
    }
  }
}