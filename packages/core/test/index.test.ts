import { describe, it, expect } from "vitest";
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { indexSessions, expandHome } from "../src/index.js";
import type { Adapter } from "../src/adapter.js";
import type { Session } from "../src/types.js";

/** A fake adapter that reads `.txt` files and treats each line as a user message. */
function fakeAdapter(root: string): { adapter: Adapter; root: string } {
  const adapter: Adapter = {
    agent: "claude",
    defaultRoot: () => root,
    discover: (r) => {
      try {
        return readdirSync(r)
          .filter((f) => f.endsWith(".txt"))
          .map((f) => join(r, f));
      } catch {
        return [];
      }
    },
    parse: (filePath: string): Session => {
      const text = readFileSync(filePath, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return {
        agent: "claude",
        sessionId: filePath,
        filePath,
        project: null,
        cwd: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        model: null,
        messageCount: lines.length,
        messages: lines.map((text) => ({
          role: "user" as const,
          text,
          toolCalls: [],
          timestamp: null,
        })),
      };
    },
  };
  return { adapter, root };
}

describe("expandHome", () => {
  it("expands ~ to home", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/foo")).toBe(join(homedir(), "foo"));
  });
  it("leaves other paths unchanged", () => {
    expect(expandHome("/var/data")).toBe("/var/data");
    expect(expandHome("relative")).toBe("relative");
  });
});

describe("indexSessions", () => {
  it("parses all files from all adapters in config order", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    writeFileSync(join(dir, "b.txt"), "foo\n");

    const { adapter, root } = fakeAdapter(dir);
    const sessions = indexSessions([{ adapter, root }]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.agent === "claude")).toBe(true);
    const counts = sessions.map((s) => s.messageCount).sort();
    expect(counts).toEqual([1, 2]);
  });

  it("uses adapter.defaultRoot() when root omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "c.txt"), "x\n");
    const { adapter } = fakeAdapter(dir);
    const sessions = indexSessions([{ adapter }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(1);
  });

  it("returns a 0-message session for empty files, never throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "empty.txt"), "");
    const { adapter, root } = fakeAdapter(dir);
    const sessions = indexSessions([{ adapter, root }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(0);
    expect(sessions[0]!.messages).toEqual([]);
  });

  it("handles a missing root directory gracefully (no throw, empty result)", () => {
    const { adapter, root } = fakeAdapter(join(tmpdir(), "does-not-exist"));
    const sessions = indexSessions([{ adapter, root }]);
    expect(sessions).toEqual([]);
  });

  it("groups multiple adapters in config order", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "sb-"));
    const dir2 = mkdtempSync(join(tmpdir(), "sb-"));
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, "1.txt"), "a\n");
    writeFileSync(join(dir2, "2.txt"), "b\nc\n");
    const a1 = fakeAdapter(dir1);
    const a2 = fakeAdapter(dir2);
    const sessions = indexSessions([
      { adapter: a1.adapter, root: a1.root },
      { adapter: a2.adapter, root: a2.root },
    ]);
    expect(sessions.map((s) => s.messageCount)).toEqual([1, 2]);
  });
});