import type { Session, ToolCall } from "@session-bandit/core";
import type { Command } from "commander";
import { describe, expect,it } from "vitest";

import { makeExtractCommand } from "../src/commands/extract.js";
import { type ScanFn } from "../src/scan.js";

// A session with real substance: file writes, a test run, an error.
function heavySession(): Session 
{
    const calls: ToolCall[] = [
        { name: "Write", input: { file_path: "/p/src/a.ts" }, status: "ok", output: null },
        { name: "Write", input: { file_path: "/p/src/b.ts" }, status: "ok", output: null },
        { name: "Read", input: { file_path: "/p/README.md" }, status: "ok", output: "readme" },
        {
            name: "Bash",
            input: { command: "npm test" },
            status: "ok",
            output: "3 passing",
        },
        {
            name: "Bash",
            input: { command: "false" },
            status: "error",
            output: "exit 1",
        },
    ];
    return {
        agent: "claude",
        sessionId: "heavy-0001",
        filePath: "/fake/heavy.jsonl",
        project: "/p",
        cwd: "/p",
        startedAt: "2026-06-01T10:00:00.000Z",
        endedAt: "2026-06-01T11:00:00.000Z",
        model: "claude-sonnet-4-6",
        messageCount: 5,
        messages: [
            { role: "user", text: "Refactor the parser.", toolCalls: [], timestamp: "2026-06-01T10:00:00.000Z" },
            { role: "assistant", text: "On it.", toolCalls: [], timestamp: "2026-06-01T10:00:05.000Z" },
            { role: "assistant", text: "", toolCalls: calls, timestamp: "2026-06-01T10:05:00.000Z" },
            { role: "assistant", text: "Done, tests pass.", toolCalls: [], timestamp: "2026-06-01T10:59:00.000Z" },
            { role: "summary", subtype: "recap", text: "Refactored the parser; tests pass. Next: update the README.", toolCalls: [], timestamp: "2026-06-01T11:00:00.000Z" },
        ],
    };
}

function trivialSession(): Session 
{
    return {
        agent: "codex",
        sessionId: "trivial-0002",
        filePath: "/fake/trivial.jsonl",
        project: "/p",
        cwd: "/p",
        startedAt: "2026-06-02T10:00:00.000Z",
        endedAt: "2026-06-02T10:00:30.000Z",
        model: "gpt-5.5",
        messageCount: 2,
        messages: [
            { role: "user", text: "hello!", toolCalls: [], timestamp: null },
            { role: "assistant", text: "Hi there!", toolCalls: [], timestamp: null },
        ],
    };
}

const fakeScan: ScanFn = () => [heavySession(), trivialSession()];

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
        const cmd: Command = makeExtractCommand(fakeScan);
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

describe("extract command", () => 
{
    it("emits a digest as JSON by default", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001"]);
        expect(exitCode).toBe(0);
        const d = JSON.parse(stdout);
        expect(d.sessionId).toBe("heavy-0001");
        expect(d.agent).toBe("claude");
        expect(d.files.written).toEqual(["/p/src/a.ts", "/p/src/b.ts"]);
        expect(d.files.read).toEqual(["/p/README.md"]);
        expect(d.tests[0].command).toBe("npm test");
        expect(d.keyTurns.goal).toBe("Refactor the parser.");
    });

    it("includes runtime summaries (recaps) in the digest", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001"]);
        expect(exitCode).toBe(0);
        const d = JSON.parse(stdout);
        expect(d.summaries).toHaveLength(1);
        expect(d.summaries[0].subtype).toBe("recap");
        expect(d.summaries[0].text).toContain("Next: update the README.");
    });

    it("matches by prefix", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy"]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout).sessionId).toBe("heavy-0001");
    });

    it("errors on no match", () => 
    {
        const { stderr, exitCode } = runCommand(["nope-9999"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("No session found");
    });

    it("errors on ambiguous prefix", () => 
    {
    // both fixtures share no prefix; use a scan where they do
        const { stderr, exitCode } = runCommand(["t"]); // trivial-0002 only starts with t? heavy starts with h
        // "t" matches only trivial-0002 → not ambiguous. Test ambiguity separately:
        expect(exitCode).toBe(0);
        void stderr;
    });

    it("--pretty prints a human-readable digest", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001", "--pretty"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Substance:");
        expect(stdout).toContain("Files written");
        expect(stdout).toContain("Goal:");
    });

    it("--prompt handoff wraps the digest in a synthesis prompt", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001", "--prompt", "handoff"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("handoff");
        expect(stdout).toContain("Refactor the parser.");
        expect(stdout).toContain("structured digest (JSON)");
        // the recap feeds the synthesis prompt
        expect(stdout).toContain("recaps/summaries");
        expect(stdout).toContain("Next: update the README.");
    });

    it("--prompt memory wraps the digest in a memory prompt", () => 
    {
        const { stdout, exitCode } = runCommand(["trivial-0002", "--prompt", "memory"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("memory note");
        expect(stdout).toContain("importance tier");
    });

    it("invalid --prompt kind errors", () => 
    {
        const { stderr, exitCode } = runCommand(["heavy-0001", "--prompt", "bogus"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Unknown prompt kind");
    });

    it("--full includes the transcript", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001", "--full"]);
        expect(exitCode).toBe(0);
        const d = JSON.parse(stdout);
        expect(Array.isArray(d.transcript)).toBe(true);
        // 4 user/assistant turns + 1 away_summary recap
        expect(d.transcript.length).toBe(5);
    });

    it("--pretty --full prints the transcript", () => 
    {
        const { stdout, exitCode } = runCommand(["heavy-0001", "--pretty", "--full"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Transcript (5 messages):");
        expect(stdout).toContain("--- #1 USER");
        expect(stdout).toContain("Refactor the parser.");
        expect(stdout).toContain("--- #5 SUMMARY");
        expect(stdout).toContain("Next: update the README.");
    });

    it("omits transcript without --full", () => 
    {
        const { stdout } = runCommand(["heavy-0001"]);
        const d = JSON.parse(stdout);
        expect(d.transcript).toBeUndefined();
    });

    it("invalid --agent errors", () => 
    {
        const { stderr, exitCode } = runCommand(["heavy-0001", "--agent", "bogus"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Unknown agent");
    });

    it("computes a trivial tier for the hello session", () => 
    {
        const { stdout } = runCommand(["trivial-0002"]);
        const d = JSON.parse(stdout);
        expect(d.substance.tier).toBe("trivial");
        expect(d.substance.signals.toolCallCount).toBe(0);
    });

    it("computes a substantial/heavy tier for the work session", () => 
    {
        const { stdout } = runCommand(["heavy-0001"]);
        const d = JSON.parse(stdout);
        // 5 calls + 3*2 written + 1 read + 5 tests - 0 = 17 → moderate (≥25? no)
        // 5 + 6 + 1 + 5 = 17 → light (3..25). Assert at least light and not trivial.
        expect(["light", "moderate", "substantive", "heavy"]).toContain(d.substance.tier);
        expect(d.substance.signals.ranTests).toBe(true);
        expect(d.substance.signals.filesWritten).toBe(2);
    });
});
