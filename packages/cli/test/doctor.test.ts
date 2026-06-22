import type { AdapterConfig,DoctorReport } from "@session-bandit/core";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { type DiagnoseFn,makeDoctorCommand } from "../src/commands/doctor.js";

// --- fixture reports --------------------------------------------------------

function makeReport(): DoctorReport 
{
    return {
        agents: [
            {
                agent: "claude",
                root: "/home/user/.claude/projects",
                files: 108,
                sessions: 108,
                emptySessions: 0,
                skippedCompressed: 0,
                details: { unmatchedToolResults: 2 },
            },
            {
                agent: "codex",
                root: "/home/user/.codex/sessions",
                files: 973,
                sessions: 973,
                emptySessions: 2,
                skippedCompressed: 14,
                details: {
                    formatDistribution: { legacyJson: 15, flatJsonl: 8, envelopeJsonl: 950, unrecognized: 0 },
                    firstUserMarkers: { agentsMd: 870, envContext: 100, userAction: 2, plainTask: 1, total: 973 },
                    unrecognizedEnvelopeTypes: {},
                    unrecognizedItemTypes: {},
                },
            },
        ],
        totals: { files: 1081, sessions: 1081, emptySessions: 2, skippedCompressed: 14 },
    };
}

function runCommand(args: string[], diagnoseFn: DiagnoseFn): { stdout: string; stderr: string; code: number } 
{
    const stdoutArr: string[] = [];
    const stderrArr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...a: unknown[]) => stdoutArr.push(a.join(" "));
    console.error = (...a: unknown[]) => stderrArr.push(a.join(" "));
    process.exitCode = 0;
    try 
    {
        const cmd: Command = makeDoctorCommand(diagnoseFn);
        cmd.exitOverride();
        cmd.parse(["node", "test", ...args]);
    }
    catch (err) 
    {
        const e = err as { exitCode?: number; code?: string };
        if (e.code === "commander.help" || e.code === "commander.version") 
        {
            // not an error
        }
        else if (e.exitCode !== undefined) 
        {
            process.exitCode = e.exitCode;
        }
    }
    finally 
    {
        console.log = origLog;
        console.error = origErr;
    }
    const code = process.exitCode ?? 0;
    process.exitCode = origExitCode;
    return { stdout: stdoutArr.join("\n"), stderr: stderrArr.join("\n"), code };
}

// --- tests -------------------------------------------------------------------

describe("doctor command", () => 
{
    it("prints JSON by default", () => 
    {
        const fn: DiagnoseFn = () => makeReport();
        const { stdout } = runCommand([], fn);
        const parsed = JSON.parse(stdout);
        expect(parsed.totals.files).toBe(1081);
        expect(parsed.agents).toHaveLength(2);
    });

    it("prints pretty with --pretty", () => 
    {
        const fn: DiagnoseFn = () => makeReport();
        const { stdout } = runCommand(["--pretty"], fn);
        expect(stdout).toContain("Session Bandit Doctor");
        expect(stdout).toContain("Format distribution");
        expect(stdout).toContain("First user-message markers");
        expect(stdout).toContain("# AGENTS.md instructions for");
    });

    it("filters by agent with --agent codex", () => 
    {
        const fn = vi.fn((_configs: AdapterConfig[]) => makeReport());
        runCommand(["--agent", "codex"], fn);
        // The command should filter configs to codex only.
        expect(fn).toHaveBeenCalled();
        const configs = fn.mock.calls[0]![0];
        expect(configs).toHaveLength(1);
        expect(configs[0]!.adapter.agent).toBe("codex");
    });

    it("filters by agent with --agent claude", () => 
    {
        const fn = vi.fn((_configs: AdapterConfig[]) => makeReport());
        runCommand(["--agent", "claude"], fn);
        const configs = fn.mock.calls[0]![0];
        expect(configs).toHaveLength(1);
        expect(configs[0]!.adapter.agent).toBe("claude");
    });

    it("errors on unknown agent", () => 
    {
        const fn: DiagnoseFn = () => makeReport();
        const { stderr, code } = runCommand(["--agent", "unknown-agent"], fn);
        expect(stderr).toContain("Unknown agent");
        expect(code).toBe(1);
    });

    it("pretty output shows warnings for empty sessions and plain-task markers", () => 
    {
        const fn: DiagnoseFn = () => makeReport();
        const { stdout } = runCommand(["--pretty"], fn);
        expect(stdout).toContain("⚠"); // empty sessions and plainTask both show ⚠
    });
});
