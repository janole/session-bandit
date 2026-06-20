import { Command } from "commander";
import {
  filterSessions,
  sortByRecent,
  sortByImportance,
  filterByMinImportance,
  isValidAgent,
  type ScanFn,
} from "../scan.js";
import { printListJson, printListPretty, parseTier } from "../format.js";

export function makeListCommand(scanFn: ScanFn): Command {
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
    .option("--pretty", "Print a human-readable table instead of JSON lines")
    .action((opts: ListOptions) => {
      if (opts.agent && !isValidAgent(opts.agent)) {
        console.error(
          `Unknown agent: "${opts.agent}". Valid: claude, codex`,
        );
        process.exitCode = 1;
        return;
      }
      if (opts.sort !== undefined && opts.sort !== "recent" && opts.sort !== "importance") {
        console.error(
          `Unknown sort: "${opts.sort}". Valid: recent, importance`,
        );
        process.exitCode = 1;
        return;
      }
      let minTier;
      if (opts.minImportance !== undefined) {
        minTier = parseTier(opts.minImportance);
        if (!minTier) {
          console.error(
            `Unknown importance tier: "${opts.minImportance}". Valid: trivial, light, moderate, substantive, heavy`,
          );
          process.exitCode = 1;
          return;
        }
      }

      let sessions = scanFn();
      sessions = filterSessions(sessions, {
        agent: opts.agent,
        project: opts.project,
      });
      if (minTier) {
        sessions = filterByMinImportance(sessions, minTier);
      }
      sessions =
        opts.sort === "importance"
          ? sortByImportance(sessions)
          : sortByRecent(sessions);

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
  sort?: string;
  minImportance?: string;
  pretty?: boolean;
}