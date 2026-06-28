import type { Session } from "@session-bandit/core";
import type { Command } from "commander";
import { describe, expect,it } from "vitest";

import { makeRedactCheckCommand } from "../src/commands/redact-check.js";
import { type ScanFn } from "../src/scan.js";

const sensitiveSession: Session = {
    agent: "claude",
    sessionId: "sensitive-0001",
    filePath: "/Users/ole/.claude/projects/demo/sensitive.jsonl",
    project: "/Users/ole/project",
    cwd: "/Users/ole/project",
    startedAt: "2026-06-28T12:00:00.000Z",
    endedAt: "2026-06-28T12:05:00.000Z",
    model: "claude-sonnet-4-6",
    messageCount: 2,
    messages: [
        {
            role: "user",
            text: "Use jane@example.com with sk-testSECRET123456 and https://example.com/path?token=secret",
            toolCalls: [],
            timestamp: "2026-06-28T12:00:00.000Z",
        },
        {
            role: "assistant",
            text: "Checking /Users/ole/project",
            toolCalls: [
                {
                    name: "Bash",
                    input: { command: "SECRET_TOKEN=abc123 deploy", file_path: "/Users/ole/project/.env" },
                    status: "ok",
                    output: "ok",
                },
            ],
            timestamp: "2026-06-28T12:00:01.000Z",
        },
    ],
};

const otherSession: Session = {
    ...sensitiveSession,
    agent: "codex",
    sessionId: "other-0002",
    messages: [],
    messageCount: 0,
};

const fakeScan: ScanFn = () => [sensitiveSession, otherSession];

function runCommand(args: string[]): { stdout: string; stderr: string; exitCode: number }
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
        const cmd: Command = makeRedactCheckCommand(fakeScan);
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
    const exitCode = process.exitCode ?? 0;
    process.exitCode = origExitCode;
    return { stdout: stdoutArr.join("\n"), stderr: stderrArr.join("\n"), exitCode };
}

describe("redact-check command", () =>
{
    it("prints a JSON report with cautious redaction by default", () =>
    {
        const { stdout, exitCode } = runCommand(["sensitive-0001"]);
        expect(exitCode).toBe(0);
        const report = JSON.parse(stdout);
        expect(report.mode).toBe("cautious");
        expect(report.counts.secretLike).toBeGreaterThan(0);
        expect(report.counts.email).toBeGreaterThan(0);
        expect(report.counts.homePath).toBeGreaterThan(0);
        expect(stdout).not.toContain("sk-testSECRET123456");
        expect(stdout).not.toContain("jane@example.com");
    });

    it("supports minimal mode", () =>
    {
        const { stdout, exitCode } = runCommand(["sensitive", "--redact", "minimal"]);
        expect(exitCode).toBe(0);
        const report = JSON.parse(stdout);
        expect(report.mode).toBe("minimal");
        expect(report.counts.secretLike).toBeGreaterThan(0);
        expect(report.counts.email).toBe(0);
    });

    it("--pretty prints a readable report", () =>
    {
        const { stdout, exitCode } = runCommand(["sensitive-0001", "--pretty"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Session: sensitive-0001");
        expect(stdout).toContain("Mode:    cautious");
        expect(stdout).toContain("Findings:");
        expect(stdout).not.toContain("SECRET_TOKEN=abc123");
    });

    it("filters by agent", () =>
    {
        const { stderr, exitCode } = runCommand(["sensitive-0001", "--agent", "codex"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("No session found");
    });

    it("errors on invalid redaction mode", () =>
    {
        const { stderr, exitCode } = runCommand(["sensitive-0001", "--redact", "bogus"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Unknown redaction mode");
    });

    it("errors on invalid agent", () =>
    {
        const { stderr, exitCode } = runCommand(["sensitive-0001", "--agent", "bogus"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Unknown agent");
    });
});
