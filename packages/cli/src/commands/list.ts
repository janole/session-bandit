import { Command } from "commander";
import {
  filterSessions,
  sortByRecent,
  isValidAgent,
  type ScanFn,
} from "../scan.js";
import { printListJson, printListPretty } from "../format.js";

export function makeListCommand(scanFn: ScanFn): Command {
  const cmd = new Command("list");
  cmd
    .description("List sessions, sorted by most recent first")
    .option("-a, --agent <name>", "Filter by agent (claude | codex)")
    .option("-p, --project <path>", "Filter by project (substring match)")
    .option("--pretty", "Print a human-readable table instead of JSON lines")
    .action((opts: ListOptions) => {
      if (opts.agent && !isValidAgent(opts.agent)) {
        console.error(
          `Unknown agent: "${opts.agent}". Valid: claude, codex`,
        );
        process.exitCode = 1;
        return;
      }

      let sessions = scanFn();
      sessions = filterSessions(sessions, {
        agent: opts.agent,
        project: opts.project,
      });
      sessions = sortByRecent(sessions);

      if (opts.pretty) {
        printListPretty(sessions);
      } else {
        printListJson(sessions);
      }
    });
  return cmd;
}

interface ListOptions {
  agent?: string;
  project?: string;
  pretty?: boolean;
}