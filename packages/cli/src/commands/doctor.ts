import type { DoctorReport } from "@session-bandit/core";
// The same adapter configs used by scanAll.
import { type AdapterConfig,botbanditAdapter, claudeAdapter, codexAdapter, diagnoseAll } from "@session-bandit/core";
import { Command } from "commander";

import { printDoctorJson, printDoctorPretty } from "../format.js";
import { isValidAgent } from "../scan.js";

const DEFAULT_ADAPTERS: AdapterConfig[] = [
    { adapter: claudeAdapter },
    { adapter: codexAdapter },
    { adapter: botbanditAdapter },
];

/** A function that produces a doctor report. */
export type DiagnoseFn = (configs: AdapterConfig[]) => DoctorReport;

/** Default diagnose implementation — scans real ~/.claude and ~/.codex roots. */
const defaultDiagnose: DiagnoseFn = (configs) => diagnoseAll(configs);

export function makeDoctorCommand(diagnoseFn: DiagnoseFn = defaultDiagnose): Command 
{
    const cmd = new Command("doctor");
    cmd
        .description(
            "Diagnose parsing health — checks format drift, injection markers, and silent skips against real session files",
        )
        .option("-a, --agent <name>", "Check only one agent (claude | codex | botbandit)")
        .option("--pretty", "Print a human-readable report instead of JSON")
        .action((opts: DoctorOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(`Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`);
                process.exitCode = 1;
                return;
            }

            let configs = DEFAULT_ADAPTERS;
            if (opts.agent) 
            {
                configs = DEFAULT_ADAPTERS.filter((c) => c.adapter.agent === opts.agent);
            }

            const report = diagnoseFn(configs);

            if (opts.pretty) 
            {
                printDoctorPretty(report);
            }
            else 
            {
                printDoctorJson(report);
            }
        });
    return cmd;
}

interface DoctorOptions {
    agent?: string;
    pretty?: boolean;
}
