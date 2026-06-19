import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { makeListCommand } from "../src/commands/list.js";
import { makeShowCommand } from "../src/commands/show.js";
import { makeSearchCommand } from "../src/commands/search.js";
import { type ScanFn } from "../src/scan.js";
import type { Session } from "@session-bandit/core";

// --- fixture sessions --------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    agent: "claude",
    sessionId: "sess-0001",
    filePath: "/fake/sess-0001.jsonl",
    project: "/Users/ole/projekte/demo",
    cwd: "/Users/ole/projekte/demo",
    startedAt: "2026-06-01T10:00:00.000Z",
    endedAt: "2026-06-01T10:05:00.000Z",
    model: "claude-sonnet-4-6",
    messageCount: 3,
    messages: [
      {
        role: "user",
        text: "Fix the bug in the parser.",
        toolCalls: [],
        timestamp: "2026-06-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        text: "I'll look at the parser code first.",
        toolCalls: [
          {
            name: "Bash",
            input: { command: "cat src/parser.ts" },
            status: "ok",
            output: "export function parse() {}",
          },
        ],
        timestamp: "2026-06-01T10:00:05.000Z",
      },
      {
        role: "assistant",
        text: "The bug is in line 42. Let me fix it.",
        toolCalls: [],
        timestamp: "2026-06-01T10:00:10.000Z",
      },
    ],
    ...overrides,
  };
}

const fixtures: Session[] = [
  makeSession({
    agent: "claude",
    sessionId: "claude-aaaa-0001",
    project: "/Users/ole/projekte/demo",
    cwd: "/Users/ole/projekte/demo",
    startedAt: "2026-06-15T10:00:00.000Z",
    model: "claude-sonnet-4-6",
  }),
  makeSession({
    agent: "codex",
    sessionId: "codex-bbbb-0002",
    project: "/Users/ole/projekte/codex-workspaces/janole/botbandit-ng",
    cwd: "/Users/ole/projekte/codex-workspaces/janole/botbandit-ng",
    startedAt: "2026-06-18T12:00:00.000Z",
    model: "gpt-5.5",
    messages: [
      {
        role: "user",
        text: "Search the codebase for the bug.",
        toolCalls: [],
        timestamp: "2026-06-18T12:00:00.000Z",
      },
      {
        role: "assistant",
        text: "Searching now.",
        toolCalls: [],
        timestamp: "2026-06-18T12:00:05.000Z",
      },
    ],
    messageCount: 2,
  }),
  makeSession({
    agent: "claude",
    sessionId: "claude-cccc-0003",
    project: "/Users/ole/projekte/other",
    cwd: "/Users/ole/projekte/other",
    startedAt: "2026-06-10T08:00:00.000Z",
    model: null,
    messageCount: 0,
    messages: [],
  }),
];

const fakeScan: ScanFn = () => [...fixtures];

// --- helpers -----------------------------------------------------------------

/** Build a command as the root program and capture stdout/stderr. */
function runCommand(
  makeCmd: (scanFn: ScanFn) => Command,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const stdoutArr: string[] = [];
  const stderrArr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  console.log = (...a: unknown[]) => stdoutArr.push(a.join(" "));
  console.error = (...a: unknown[]) => stderrArr.push(a.join(" "));
  process.exitCode = 0;
  try {
    // Use the command directly as the program so args are parsed as the
    // command's own options/arguments (not as a subcommand name).
    const cmd = makeCmd(fakeScan);
    cmd.exitOverride();
    cmd.parse(["node", "test", ...args]);
  } catch (err) {
    const e = err as { exitCode?: number; code?: string };
    if (e.code === "commander.help" || e.code === "commander.version") {
      // help/version — not an error
    } else if (e.exitCode !== undefined) {
      process.exitCode = e.exitCode;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = origExitCode;
  return {
    stdout: stdoutArr.join("\n"),
    stderr: stderrArr.join("\n"),
    exitCode,
  };
}

// --- tests -------------------------------------------------------------------

describe("list command", () => {
  it("outputs JSON lines by default, sorted by startedAt desc", () => {
    const { stdout, exitCode } = runCommand(makeListCommand, []);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    // Most recent first: codex (06-18) > claude (06-15) > claude (06-10)
    const first = JSON.parse(lines[0]!);
    expect(first.sessionId).toBe("codex-bbbb-0002");
    const second = JSON.parse(lines[1]!);
    expect(second.sessionId).toBe("claude-aaaa-0001");
    const third = JSON.parse(lines[2]!);
    expect(third.sessionId).toBe("claude-cccc-0003");
  });

  it("JSON lines contain the summary fields", () => {
    const { stdout } = runCommand(makeListCommand, []);
    const first = JSON.parse(stdout.split("\n")[0]!);
    expect(first).toHaveProperty("agent");
    expect(first).toHaveProperty("sessionId");
    expect(first).toHaveProperty("project");
    expect(first).toHaveProperty("startedAt");
    expect(first).toHaveProperty("messageCount");
    expect(first).toHaveProperty("model");
    expect(first).not.toHaveProperty("messages");
  });

  it("--agent filters by agent", () => {
    const { stdout } = runCommand(makeListCommand, ["--agent", "codex"]);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).agent).toBe("codex");
  });

  it("--project filters by substring match", () => {
    const { stdout } = runCommand(makeListCommand, [
      "--project",
      "botbandit",
    ]);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).sessionId).toBe("codex-bbbb-0002");
  });

  it("--pretty prints a table with header", () => {
    const { stdout, exitCode } = runCommand(makeListCommand, ["--pretty"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("agent");
    expect(stdout).toContain("sessionId");
    expect(stdout).toContain("startedAt");
    expect(stdout).toContain("3 sessions");
  });

  it("--pretty on empty result prints 'No sessions found'", () => {
    const { stdout } = runCommand(makeListCommand, [
      "--agent",
      "gemini",
      "--pretty",
    ]);
    expect(stdout).toContain("No sessions found");
  });

  it("invalid --agent prints error and sets exitCode", () => {
    const { stderr, exitCode } = runCommand(makeListCommand, [
      "--agent",
      "invalid",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown agent");
  });
});

describe("show command", () => {
  it("prints the transcript for a matching session", () => {
    const { stdout, exitCode } = runCommand(makeShowCommand, [
      "claude-aaaa-0001",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("claude-aaaa-0001");
    expect(stdout).toContain("USER");
    expect(stdout).toContain("Fix the bug in the parser.");
    expect(stdout).toContain("ASSISTANT");
  });

  it("matches by prefix", () => {
    const { stdout, exitCode } = runCommand(makeShowCommand, ["codex-bbbb"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("codex-bbbb-0002");
  });

  it("prints tool calls with status icons", () => {
    const { stdout } = runCommand(makeShowCommand, ["claude-aaaa-0001"]);
    expect(stdout).toContain("✓");
    expect(stdout).toContain("Bash");
    expect(stdout).toContain("cat src/parser.ts");
  });

  it("non-existent session prints error", () => {
    const { stderr, exitCode } = runCommand(makeShowCommand, [
      "does-not-exist",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No session found");
  });

  it("--agent filter works with show", () => {
    const { stderr, exitCode } = runCommand(makeShowCommand, [
      "claude-aaaa-0001",
      "--agent",
      "codex",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No session found");
  });
});

describe("search command", () => {
  it("finds messages matching the query (case-insensitive)", () => {
    const { stdout, exitCode } = runCommand(makeSearchCommand, ["BUG"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter(Boolean);
    // claude-aaaa: "Fix the bug" + "The bug is in line 42"; codex-bbbb: "...for the bug"
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!);
    expect(first.text.toLowerCase()).toContain("bug");
  });

  it("returns hits with session context", () => {
    const { stdout } = runCommand(makeSearchCommand, ["codebase"]);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const hit = JSON.parse(lines[0]!);
    expect(hit.agent).toBe("codex");
    expect(hit.sessionId).toBe("codex-bbbb-0002");
    expect(hit.messageIndex).toBe(1);
    expect(hit.role).toBe("user");
  });

  it("--agent filter applies to search", () => {
    const { stdout } = runCommand(makeSearchCommand, [
      "bug",
      "--agent",
      "codex",
    ]);
    const lines = stdout.split("\n").filter(Boolean);
    // codex-bbbb has "Search the codebase for the bug."
    expect(lines).toHaveLength(1);
    const hit = JSON.parse(lines[0]!);
    expect(hit.agent).toBe("codex");
  });

  it("--pretty prints human-readable results", () => {
    const { stdout, exitCode } = runCommand(makeSearchCommand, [
      "bug",
      "--pretty",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("claude-aaaa-0001".slice(0, 12));
    expect(stdout).toContain("matches");
  });

  it("no matches prints empty (JSON) or message (--pretty)", () => {
    const { stdout } = runCommand(makeSearchCommand, ["zzzznotfound"]);
    expect(stdout.trim()).toBe("");
  });

  it("no matches --pretty prints 'No matches found'", () => {
    const { stdout } = runCommand(makeSearchCommand, [
      "zzzznotfound",
      "--pretty",
    ]);
    expect(stdout).toContain("No matches found");
  });
});