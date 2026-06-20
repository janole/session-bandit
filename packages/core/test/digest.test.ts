import { describe, it, expect } from "vitest";
import {
  computeDigest,
  computeSubstance,
  tierForScore,
  tierRank,
  extractCodexPatchFiles,
  extractCommandString,
} from "../src/digest.js";
import type { Session, Message, ToolCall, AgentName } from "../src/types.js";

// --- helpers --------------------------------------------------------------

function tc(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    name: "Bash",
    input: { command: "ls" },
    status: "ok",
    output: null,
    ...overrides,
  };
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    role: "user",
    text: "",
    toolCalls: [],
    timestamp: null,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    agent: "claude",
    sessionId: "sess-0001",
    filePath: "/fake/sess-0001.jsonl",
    project: "/home/user/projekte/demo",
    cwd: "/home/user/projekte/demo",
    startedAt: "2026-06-01T10:00:00.000Z",
    endedAt: "2026-06-01T10:30:00.000Z",
    model: "claude-sonnet-4-6",
    messageCount: 0,
    messages: [],
    ...overrides,
  };
}

function setMessages(s: Session, messages: Message[]): Session {
  return { ...s, messages, messageCount: messages.length };
}

// --- pure helpers ---------------------------------------------------------

describe("tierForScore / tierRank", () => {
  it("maps scores to tiers at the documented thresholds", () => {
    expect(tierForScore(0)).toBe("trivial");
    expect(tierForScore(2)).toBe("trivial");
    expect(tierForScore(3)).toBe("light");
    expect(tierForScore(24)).toBe("light");
    expect(tierForScore(25)).toBe("moderate");
    expect(tierForScore(99)).toBe("moderate");
    expect(tierForScore(100)).toBe("substantive");
    expect(tierForScore(399)).toBe("substantive");
    expect(tierForScore(400)).toBe("heavy");
    expect(tierForScore(1000)).toBe("heavy");
  });

  it("tierRank is monotonic", () => {
    const ranks = ["trivial", "light", "moderate", "substantive", "heavy"].map(
      (t) => tierRank(t as never),
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("extractCodexPatchFiles", () => {
  it("parses Update/Add/Delete File markers from a patch string", () => {
    const patch =
      "*** Begin Patch\n" +
      "*** Update File: /home/user/projekte/demo/src/index.ts\n" +
      "@@\n-old\n+new\n" +
      "*** Add File: /home/user/projekte/demo/src/new.ts\n" +
      "@@\n+export const x = 1;\n" +
      "*** Delete File: /home/user/projekte/demo/src/old.ts\n";
    expect(extractCodexPatchFiles(patch)).toEqual([
      "/home/user/projekte/demo/src/index.ts",
      "/home/user/projekte/demo/src/new.ts",
      "/home/user/projekte/demo/src/old.ts",
    ]);
  });

  it("returns [] for non-string input", () => {
    expect(extractCodexPatchFiles(null)).toEqual([]);
    expect(extractCodexPatchFiles({ foo: "bar" })).toEqual([]);
    expect(extractCodexPatchFiles(42)).toEqual([]);
  });

  it("returns [] when no file markers present", () => {
    expect(extractCodexPatchFiles("just some text\nno markers here")).toEqual([]);
  });
});

describe("extractCommandString", () => {
  it("reads a string command (Claude Bash)", () => {
    expect(extractCommandString({ command: "npm test" })).toBe("npm test");
  });

  it("reads the last element of an array command (Codex shell)", () => {
    expect(
      extractCommandString({ command: ["bash", "-lc", "git show --stat HEAD"] }),
    ).toBe("git show --stat HEAD");
  });

  it("reads action.command (local_shell_call → shell)", () => {
    expect(
      extractCommandString({
        action: { type: "exec", command: ["bash", "-lc", "ls -1"] },
      }),
    ).toBe("ls -1");
  });

  it("returns null for a patch string (not a command)", () => {
    expect(extractCommandString("*** Begin Patch\n*** Update File: x.ts")).toBeNull();
  });

  it("returns null when no command field is present", () => {
    expect(extractCommandString({ query: "something" })).toBeNull();
    expect(extractCommandString(null)).toBeNull();
    expect(extractCommandString(42)).toBeNull();
  });
});

// --- computeSubstance -----------------------------------------------------

describe("computeSubstance", () => {
  it("a trivial hello session scores ~0 and is trivial", () => {
    const s = setMessages(session(), [
      msg({ role: "user", text: "hello!" }),
      msg({ role: "assistant", text: "Hi there!" }),
    ]);
    const sub = computeSubstance(s);
    expect(sub.signals.toolCallCount).toBe(0);
    expect(sub.signals.filesWritten).toBe(0);
    expect(sub.score).toBeLessThan(3);
    expect(sub.tier).toBe("trivial");
    expect(sub.signals.endedCleanly).toBe(true);
    expect(sub.signals.idle).toBe(false);
  });

  it("an interrupted session (no assistant after last user) is not endedCleanly and is penalized", () => {
    const s = setMessages(session(), [
      msg({ role: "user", text: "do the thing" }),
      msg({ role: "assistant", text: "ok" }),
      msg({ role: "user", text: "and also this?" }), // last turn is user → interrupted
    ]);
    const sub = computeSubstance(s);
    expect(sub.signals.endedCleanly).toBe(false);
    // 0 calls + interrupted penalty: score = 0 - 2 = -2 → trivial
    expect(sub.tier).toBe("trivial");
  });

  it("a heavy session with many file writes + tests is heavy", () => {
    const calls: ToolCall[] = [];
    for (let i = 0; i < 200; i++) {
      calls.push(
        tc({
          name: "Edit",
          input: { file_path: `/home/user/projekte/demo/src/file${i}.ts` },
          status: "ok",
        }),
      );
    }
    calls.push(
      tc({
        name: "Bash",
        input: { command: "npm test" },
        status: "ok",
        output: "3 passing",
      }),
    );
    const s = setMessages(session(), [
      msg({ role: "user", text: "refactor everything" }),
      msg({ role: "assistant", text: "", toolCalls: calls }),
      msg({ role: "assistant", text: "Done." }),
    ]);
    const sub = computeSubstance(s);
    // score = 201 calls + 3*200 written + 1*0 read + 5 tests - 0 = 806 → heavy
    expect(sub.signals.filesWritten).toBe(200);
    expect(sub.signals.ranTests).toBe(true);
    expect(sub.tier).toBe("heavy");
    expect(sub.score).toBeGreaterThanOrEqual(400);
  });

  it("idle flag: long duration + low activity", () => {
    const s = setMessages(
      {
        ...session(),
        startedAt: "2026-06-01T10:00:00.000Z",
        endedAt: "2026-06-01T13:30:00.000Z", // 210 min
      },
      [
        msg({ role: "user", text: "hi" }),
        msg({ role: "assistant", text: "hey" }),
      ],
    );
    expect(computeSubstance(s).signals.idle).toBe(true);
  });

  it("idle flag false when activity is high despite long duration", () => {
    const calls: ToolCall[] = Array.from({ length: 50 }, () =>
      tc({ name: "Edit", input: { file_path: "/a/b.ts" }, status: "ok" }),
    );
    const s = setMessages(
      {
        ...session(),
        startedAt: "2026-06-01T10:00:00.000Z",
        endedAt: "2026-06-01T14:00:00.000Z", // 240 min
      },
      [msg({ role: "assistant", text: "", toolCalls: calls })],
    );
    expect(computeSubstance(s).signals.idle).toBe(false);
  });

  it("errorCount tallies status:error tool calls", () => {
    const s = setMessages(session(), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({ name: "Bash", status: "ok" }),
          tc({ name: "Bash", status: "error", output: "boom" }),
          tc({ name: "Edit", status: "error", output: "rejected" }),
        ],
      }),
    ]);
    expect(computeSubstance(s).signals.errorCount).toBe(2);
  });
});

// --- computeDigest: file extraction ---------------------------------------

describe("computeDigest file extraction", () => {
  it("Claude: Write/Edit → written, Read → read, read excludes written", () => {
    const s = setMessages(session({ agent: "claude" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({ name: "Write", input: { file_path: "/p/src/new.ts" } }),
          tc({ name: "Edit", input: { file_path: "/p/src/index.ts" } }),
          tc({ name: "Read", input: { file_path: "/p/src/index.ts" } }), // also written → excluded from read
          tc({ name: "Read", input: { file_path: "/p/README.md" } }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.files.written).toEqual(["/p/src/index.ts", "/p/src/new.ts"]);
    expect(d.files.read).toEqual(["/p/README.md"]);
  });

  it("Codex: apply_patch → written via patch-string parsing", () => {
    const s = setMessages(session({ agent: "codex" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({
            name: "apply_patch",
            input:
              "*** Begin Patch\n" +
              "*** Update File: /p/src/a.ts\n" +
              "*** Add File: /p/src/b.ts\n",
          }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.files.written).toEqual(["/p/src/a.ts", "/p/src/b.ts"]);
    expect(d.files.read).toEqual([]);
  });

  it("Codex: shell/exec commands are NOT counted as files", () => {
    const s = setMessages(session({ agent: "codex" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({
            name: "exec_command",
            input: { command: ["bash", "-lc", "cat /p/src/a.ts && ls /p"] },
          }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.files.written).toEqual([]);
    expect(d.files.read).toEqual([]);
  });

  it("Claude: Bash commands are NOT counted as files", () => {
    const s = setMessages(session({ agent: "claude" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [tc({ name: "Bash", input: { command: "cat src/a.ts" } })],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.files.written).toEqual([]);
    expect(d.files.read).toEqual([]);
  });
});

// --- computeDigest: tests / commands / errors ----------------------------

describe("computeDigest tests & commands", () => {
  it("detects a test run and infers pass from Codex exit_code", () => {
    const s = setMessages(session({ agent: "codex" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({
            name: "shell",
            input: { command: ["bash", "-lc", "npm test"] },
            status: "ok",
            output: '{"output":"3 passed","metadata":{"exit_code":0}}',
          }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.tests).toHaveLength(1);
    expect(d.tests[0]?.command).toBe("npm test");
    expect(d.tests[0]?.passed).toBe(true);
    expect(d.substance.signals.ranTests).toBe(true);
  });

  it("infers failure from Codex non-zero exit_code", () => {
    const s = setMessages(session({ agent: "codex" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({
            name: "shell",
            input: { command: ["bash", "-lc", "pytest"] },
            status: "error",
            output: '{"output":"FAIL","metadata":{"exit_code":1}}',
          }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.tests[0]?.passed).toBe(false);
  });

  it("commands.total counts shell tools; failing lists errored ones", () => {
    const s = setMessages(session({ agent: "claude" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({ name: "Bash", input: { command: "echo hi" }, status: "ok" }),
          tc({
            name: "Bash",
            input: { command: "false" },
            status: "error",
            output: "exit 1",
          }),
          tc({ name: "Edit", input: { file_path: "/a.ts" }, status: "ok" }), // not a command
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.commands.total).toBe(2);
    expect(d.commands.failing).toHaveLength(1);
    expect(d.commands.failing[0]?.name).toBe("Bash");
  });

  it("errors lists all failed tool calls (not just commands)", () => {
    const s = setMessages(session({ agent: "claude" }), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({ name: "Bash", status: "error", output: "cmd failed" }),
          tc({ name: "Edit", status: "error", output: "rejected by user" }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.errors).toHaveLength(2);
    expect(d.errors.map((e) => e.name).sort()).toEqual(["Bash", "Edit"]);
  });
});

// --- computeDigest: key turns & tools -------------------------------------

describe("computeDigest key turns & tools", () => {
  it("goal = first user message; finalState = last assistant turns", () => {
    const s = setMessages(session(), [
      msg({ role: "user", text: "Fix the parser bug." }),
      msg({ role: "assistant", text: "Looking into it." }),
      msg({ role: "assistant", text: "Fixed and verified." }),
    ]);
    const d = computeDigest(s);
    expect(d.keyTurns.goal).toBe("Fix the parser bug.");
    expect(d.keyTurns.finalState).toEqual(["Looking into it.", "Fixed and verified."]);
  });

  it("goal is null when there are no user messages", () => {
    const s = setMessages(session(), [
      msg({ role: "assistant", text: "hello" }),
    ]);
    const d = computeDigest(s);
    expect(d.keyTurns.goal).toBeNull();
  });

  it("finalState collects up to 3 non-empty assistant turns, in order", () => {
    const s = setMessages(session(), [
      msg({ role: "user", text: "go" }),
      msg({ role: "assistant", text: "step 1" }),
      msg({ role: "assistant", text: "" }), // empty, skipped
      msg({ role: "assistant", text: "step 2" }),
      msg({ role: "assistant", text: "step 3" }),
      msg({ role: "assistant", text: "step 4" }), // only last 3 kept
    ]);
    const d = computeDigest(s);
    expect(d.keyTurns.finalState).toEqual(["step 2", "step 3", "step 4"]);
  });

  it("tools breakdown is sorted by count desc", () => {
    const s = setMessages(session(), [
      msg({
        role: "assistant",
        text: "",
        toolCalls: [
          tc({ name: "Bash" }),
          tc({ name: "Bash" }),
          tc({ name: "Edit" }),
          tc({ name: "Read" }),
          tc({ name: "Read" }),
          tc({ name: "Read" }),
        ],
      }),
    ]);
    const d = computeDigest(s);
    expect(d.tools.map((t) => t.name)).toEqual(["Read", "Bash", "Edit"]);
    expect(d.tools[0]?.count).toBe(3);
  });
});

// --- computeDigest: full transcript & identity ---------------------------

describe("computeDigest misc", () => {
  it("omits transcript by default; includes it with full:true", () => {
    const messages = [msg({ role: "user", text: "hi" })];
    const s = setMessages(session(), messages);
    expect(computeDigest(s).transcript).toBeUndefined();
    expect(computeDigest(s, { full: true }).transcript).toBe(messages);
  });

  it("carries identity fields from the session", () => {
    const s = session({
      agent: "codex",
      sessionId: "abc-123",
      project: "/home/user/x",
      cwd: "/home/user/x",
      model: "gpt-5.5",
      startedAt: "2026-06-19T10:00:00.000Z",
      endedAt: "2026-06-19T10:05:00.000Z",
    });
    const d = computeDigest(setMessages(s, [msg({ role: "user", text: "go" })]));
    expect(d.agent).toBe("codex");
    expect(d.sessionId).toBe("abc-123");
    expect(d.project).toBe("/home/user/x");
    expect(d.model).toBe("gpt-5.5");
    expect(d.durationMin).toBe(5);
  });

  it("durationMin is null when endedAt is missing", () => {
    const s = session({ endedAt: null });
    const d = computeDigest(setMessages(s, [msg({ role: "user", text: "go" })]));
    expect(d.durationMin).toBeNull();
  });
});