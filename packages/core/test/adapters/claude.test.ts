import { describe, it, expect, beforeAll } from "vitest";
import { join, basename, dirname } from "node:path";
import { claudeAdapter, decodeCwd } from "../../src/adapters/claude.js";
import type { Session } from "../../src/types.js";

const fixtureRoot = join(__dirname, "..", "fixtures", "claude");

describe("decodeCwd", () => {
  it("decodes an encoded cwd directory name", () => {
    expect(decodeCwd("-Users-ole-projekte-demo")).toBe(
      "/Users/ole/projekte/demo",
    );
  });
  it("leaves non-encoded names unchanged", () => {
    expect(decodeCwd("plain")).toBe("plain");
  });
});

describe("claudeAdapter.discover", () => {
  it("finds .jsonl files under project subdirectories", () => {
    const files = claudeAdapter.discover(fixtureRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("fix-aaaa-0001.jsonl");
  });

  it("returns [] for a missing root", () => {
    expect(claudeAdapter.discover(join(fixtureRoot, "nope"))).toEqual([]);
  });

  it("defaultRoot is ~/.claude/projects", () => {
    expect(claudeAdapter.defaultRoot()).toBe("~/.claude/projects");
  });

  it("agent is claude", () => {
    expect(claudeAdapter.agent).toBe("claude");
  });
});

// The fixture file lives at fixtures/claude/<encoded-cwd>/fix-aaaa-0001.jsonl,
// matching the real ~/.claude/projects layout. Parse it directly to test the
// parser in isolation.
const fixtureFile = join(
  fixtureRoot,
  "-Users-ole-projekte-demo",
  "fix-aaaa-0001.jsonl",
);

describe("claudeAdapter.parse", () => {
  let session!: Session;
  beforeAll(() => {
    session = claudeAdapter.parse(fixtureFile);
  });

  it("parses without throwing", () => {
    expect(session).toBeTruthy();
  });

  it("captures agent, sessionId, filePath", () => {
    expect(session.agent).toBe("claude");
    expect(session.sessionId).toBe("fix-aaaa-0001");
    expect(session.filePath).toBe(fixtureFile);
  });

  it("captures cwd and project from the session content", () => {
    expect(session.cwd).toBe("/Users/ole/projekte/demo");
    expect(session.project).toBe("/Users/ole/projekte/demo");
  });

  it("captures startedAt and endedAt from timestamps", () => {
    expect(session.startedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(session.endedAt).toBe("2026-06-01T10:00:12.000Z");
  });

  it("captures the assistant model", () => {
    expect(session.model).toBe("claude-sonnet-4-6");
  });

  it("emits user and assistant messages, skipping meta/system/mode lines", () => {
    const roles = session.messages.map((m) => m.role);
    // 1 user (initial) + 2 assistant + 2 user tool_result-only turns (no text msg emitted)
    expect(roles.filter((r) => r === "user")).toHaveLength(1);
    expect(roles.filter((r) => r === "assistant")).toHaveLength(2);
    expect(session.messageCount).toBe(3);
  });

  it("joins assistant text blocks and excludes thinking", () => {
    const a1 = session.messages.find((m) => m.text === "I'll look at the commit first.");
    expect(a1).toBeTruthy();
    expect(a1!.role).toBe("assistant");
    // thinking block must NOT leak into text
    expect(a1!.text).not.toContain("Let me check the diff");
  });

  it("captures tool_use calls on the assistant message", () => {
    const a1 = session.messages.find((m) => m.text === "I'll look at the commit first.");
    expect(a1!.toolCalls).toHaveLength(1);
    expect(a1!.toolCalls[0]!.name).toBe("Bash");
    expect(a1!.toolCalls[0]!.input).toEqual({ command: "git show abc123" });
    expect(a1!.toolCalls[0]!.status).toBe("ok");
    expect(a1!.toolCalls[0]!.output).toContain("commit abc123");
  });

  it("marks errored tool results with status error", () => {
    const a2 = session.messages.find((m) => m.text.startsWith("Now let me run"));
    expect(a2!.toolCalls).toHaveLength(1);
    expect(a2!.toolCalls[0]!.status).toBe("error");
    expect(a2!.toolCalls[0]!.output).toBe("Error: tests failed");
  });

  it("project falls back to decoded dir name when cwd absent", () => {
    // the fixture dir name is the encoded cwd; decoding it yields the project path
    const dir = basename(dirname(fixtureFile));
    expect(dir).toBe("-Users-ole-projekte-demo");
    expect(decodeCwd(dir)).toBe("/Users/ole/projekte/demo");
  });

  it("does not throw on an empty/garbage file", () => {
    const s = claudeAdapter.parse(join(fixtureRoot, "does-not-exist.jsonl"));
    expect(s.messageCount).toBe(0);
    expect(s.messages).toEqual([]);
  });
});