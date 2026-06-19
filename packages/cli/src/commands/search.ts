import { Command } from "commander";
import { filterSessions, isValidAgent, type ScanFn } from "../scan.js";
import {
  printSearchJson,
  printSearchPretty,
  type SearchHit,
} from "../format.js";

export function makeSearchCommand(scanFn: ScanFn): Command {
  const cmd = new Command("search");
  cmd
    .description("Full-text search over session messages")
    .argument("<query>", "Case-insensitive search query")
    .option("-a, --agent <name>", "Filter by agent (claude | codex)")
    .option("-p, --project <path>", "Filter by project (substring match)")
    .option("--pretty", "Print human-readable results instead of JSON lines")
    .action((query: string, opts: SearchOptions) => {
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

      const q = query.toLowerCase();
      const hits: SearchHit[] = [];
      for (const s of sessions) {
        for (let i = 0; i < s.messages.length; i++) {
          const msg = s.messages[i]!;
          if (msg.text.toLowerCase().includes(q)) {
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

      if (opts.pretty) {
        printSearchPretty(hits);
      } else {
        printSearchJson(hits);
      }
    });
  return cmd;
}

interface SearchOptions {
  agent?: string;
  project?: string;
  pretty?: boolean;
}