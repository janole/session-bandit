import { Command } from "commander";
import type { DoctorReport } from "@session-bandit/core";
import { isValidAgent } from "../scan.js";
import { printDoctorJson, printDoctorPretty } from "../format.js";

// The same adapter configs used by scanAll.
import { claudeAdapter, codexAdapter, diagnoseAll, type AdapterConfig } from "@session-bandit/core";

const DEFAULT_ADAPTERS: AdapterConfig[] = [
  { adapter: claudeAdapter },
  { adapter: codexAdapter },
];

/** A function that produces a doctor report. */
export type DiagnoseFn = (configs: AdapterConfig[]) => DoctorReport;

/** Default diagnose implementation — scans real ~/.claude and ~/.codex roots. */
const defaultDiagnose: DiagnoseFn = (configs) => diagnoseAll(configs);

export function makeDoctorCommand(diagnoseFn: DiagnoseFn = defaultDiagnose): Command {
  const cmd = new Command("doctor");
  cmd
    .description(
      "Diagnose parsing health — checks format drift, injection markers, and silent skips against real session files",
    )
    .option("-a, --agent <name>", "Check only one agent (claude | codex)")
    .option("--pretty", "Print a human-readable report instead of JSON")
    .action((opts: DoctorOptions) => {
      if (opts.agent && !isValidAgent(opts.agent)) {
        console.error(`Unknown agent: "${opts.agent}". Valid: claude, codex`);
        process.exitCode = 1;
        return;
      }

      let configs = DEFAULT_ADAPTERS;
      if (opts.agent) {
        configs = DEFAULT_ADAPTERS.filter((c) => c.adapter.agent === opts.agent);
      }

      const report = diagnoseFn(configs);

      if (opts.pretty) {
        printDoctorPretty(report);
      } else {
        printDoctorJson(report);
      }
    });
  return cmd;
}

interface DoctorOptions {
  agent?: string;
  pretty?: boolean;
}