import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Session } from "@session-bandit/core";
import type { Command } from "commander";
import { describe, expect,it } from "vitest";

import { makeExportMdCommand } from "../src/commands/export-md.js";
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
            text: "Use jane@example.com with sk-testSECRET123456.",
            toolCalls: [],
            timestamp: "2026-06-28T12:00:00.000Z",
        },
        {
            role: "assistant",
            text: "Writing config in /Users/ole/project.",
            toolCalls: [
                {
                    name: "Bash",
                    input: { command: "SECRET_TOKEN=abc123 npm test", file_path: "/Users/ole/project/.env" },
                    status: "ok",
                    output: "3 passing",
                },
            ],
            timestamp: "2026-06-28T12:01:00.000Z",
        },
    ],
};

const fakeScan: ScanFn = () => [sensitiveSession];

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
        const cmd: Command = makeExportMdCommand(fakeScan);
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

describe("export-md command", () =>
{
    it("writes cautious-redacted Markdown by default", () =>
    {
        const dir = mkdtempSync(join(tmpdir(), "session-bandit-export-md-"));
        const out = join(dir, "session.md");

        const { exitCode } = runCommand(["sensitive-0001", "--out", out, "--title", "Sensitive Export"]);

        expect(exitCode).toBe(0);
        const markdown = readFileSync(out, "utf8");
        expect(markdown).toContain("# Sensitive Export");
        expect(markdown).toContain("redactionMode: \"cautious\"");
        expect(markdown).toContain("## Session Transcript");
        expect(markdown).toContain("### User");
        expect(markdown).toContain("### Assistant");
        expect(markdown).toContain("### Tools");
        expect(markdown).toContain("<summary>Bash - ok</summary>");
        expect(markdown).not.toContain("jane@example.com");
        expect(markdown).not.toContain("sk-testSECRET123456");
        expect(markdown).not.toContain("SECRET_TOKEN=abc123");
        expect(markdown).toContain("[REDACTED_EMAIL]");
        expect(markdown).toContain("[REDACTED_SECRET]");
    });

    it("writes an optional redaction report", () =>
    {
        const dir = mkdtempSync(join(tmpdir(), "session-bandit-export-md-"));
        const out = join(dir, "session.md");
        const reportOut = join(dir, "redaction-report.json");

        const { exitCode } = runCommand(["sensitive", "--out", out, "--report-out", reportOut]);

        expect(exitCode).toBe(0);
        const report = JSON.parse(readFileSync(reportOut, "utf8"));
        expect(report.mode).toBe("cautious");
        expect(report.counts.secretLike).toBeGreaterThan(0);
        expect(report.counts.email).toBeGreaterThan(0);
    });

    it("refuses --redact none without --yes", () =>
    {
        const dir = mkdtempSync(join(tmpdir(), "session-bandit-export-md-"));
        const out = join(dir, "session.md");

        const { stderr, exitCode } = runCommand(["sensitive-0001", "--out", out, "--redact", "none"]);

        expect(exitCode).toBe(1);
        expect(stderr).toContain("Refusing to export");
    });

    it("allows --redact none with --yes", () =>
    {
        const dir = mkdtempSync(join(tmpdir(), "session-bandit-export-md-"));
        const out = join(dir, "session.md");

        const { exitCode } = runCommand(["sensitive-0001", "--out", out, "--redact", "none", "--yes"]);

        expect(exitCode).toBe(0);
        const markdown = readFileSync(out, "utf8");
        expect(markdown).toContain("jane@example.com");
        expect(markdown).toContain("sk-testSECRET123456");
    });

    it("errors on invalid mode", () =>
    {
        const dir = mkdtempSync(join(tmpdir(), "session-bandit-export-md-"));
        const out = join(dir, "session.md");

        const { stderr, exitCode } = runCommand(["sensitive-0001", "--out", out, "--redact", "bogus"]);

        expect(exitCode).toBe(1);
        expect(stderr).toContain("Unknown redaction mode");
    });
});
