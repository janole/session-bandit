import { Command } from "commander";
import { computeDigest } from "@session-bandit/core";
import { isValidAgent, type ScanFn } from "../scan.js";
import {
  printDigestJson,
  printDigestPretty,
  printDigestPrompt,
} from "../format.js";

export function makeExtractCommand(scanFn: ScanFn): Command {
  const cmd = new Command("extract");
  cmd
    .description(
      "Emit a structured digest of a session (substance, files, commands, key turns)",
    )
    .argument("<sessionId>", "Session ID (or prefix)")
    .option("-a, --agent <name>", "Filter by agent (claude | codex)")
    .option("--prompt <kind>", "Wrap the digest in a synthesis prompt (handoff | memory)")
    .option("--full", "Include the complete de-noised transcript")
    .option("--pretty", "Print a human-readable digest instead of JSON")
    .action((sessionId: string, opts: ExtractOptions) => {
      if (opts.agent && !isValidAgent(opts.agent)) {
        console.error(
          `Unknown agent: "${opts.agent}". Valid: claude, codex`,
        );
        process.exitCode = 1;
        return;
      }
      if (
        opts.prompt !== undefined &&
        opts.prompt !== "handoff" &&
        opts.prompt !== "memory"
      ) {
        console.error(
          `Unknown prompt kind: "${opts.prompt}". Valid: handoff, memory`,
        );
        process.exitCode = 1;
        return;
      }

      const sessions = scanFn();
      // Match by full sessionId or by prefix (same behavior as `show`).
      const candidates = sessions.filter((s) => {
        if (opts.agent && s.agent !== opts.agent) return false;
        return s.sessionId === sessionId || s.sessionId.startsWith(sessionId);
      });

      if (candidates.length === 0) {
        console.error(`No session found matching "${sessionId}".`);
        process.exitCode = 1;
        return;
      }
      if (candidates.length > 1) {
        console.error(
          `Ambiguous session prefix "${sessionId}" — matches ${candidates.length} sessions:`,
        );
        for (const c of candidates.slice(0, 10)) {
          console.error(`  ${c.agent}  ${c.sessionId}  ${c.startedAt}`);
        }
        process.exitCode = 1;
        return;
      }

      const digest = computeDigest(candidates[0]!, { full: opts.full });

      if (opts.prompt) {
        printDigestPrompt(digest, opts.prompt);
      } else if (opts.pretty) {
        printDigestPretty(digest);
      } else {
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