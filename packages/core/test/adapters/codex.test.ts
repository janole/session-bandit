import { join } from "node:path";

import { beforeAll,describe, expect, it } from "vitest";

import { codexAdapter } from "../../src/adapters/codex.js";
import type { Session } from "../../src/types.js";

const fixtureRoot = join(__dirname, "..", "fixtures", "codex");

// Three format fixtures:
//  - modern envelope .jsonl  → 2026/06/19/rollout-...fix-codex-0001.jsonl
//  - flat .jsonl (no envelope) → rollout-...fix-codex-flat-0002.jsonl
//  - legacy .json (single obj) → rollout-...fix-codex-legacy-0003.json
//  - stub .jsonl (metadata only) → rollout-...fix-codex-empty-0004.jsonl
const modernFile = join(
    fixtureRoot,
    "2026",
    "06",
    "19",
    "rollout-2026-06-19T10-00-00-fix-codex-0001.jsonl",
);
const flatFile = join(
    fixtureRoot,
    "rollout-2025-07-19T22-25-43-fix-codex-flat-0002.jsonl",
);
const legacyFile = join(
    fixtureRoot,
    "rollout-2025-04-17-fix-codex-legacy-0003.json",
);
const stubFile = join(
    fixtureRoot,
    "rollout-2025-07-10T17-36-24-fix-codex-empty-0004.jsonl",
);

describe("codexAdapter basics", () => 
{
    it("agent is codex", () => 
    {
        expect(codexAdapter.agent).toBe("codex");
    });

    it("defaultRoot is ~/.codex/sessions", () => 
    {
        expect(codexAdapter.defaultRoot()).toBe("~/.codex/sessions");
    });
});

describe("codexAdapter.discover", () => 
{
    it("recursively finds rollout-*.jsonl and rollout-*.json files", () => 
    {
        const files = codexAdapter.discover(fixtureRoot);
        // 3 jsonl + 1 json = 4 session files
        expect(files).toHaveLength(4);
        // The deeply nested modern file is found
        expect(files.some((f) => f.includes("fix-codex-0001.jsonl"))).toBe(true);
        expect(files.some((f) => f.includes("fix-codex-flat-0002.jsonl"))).toBe(true);
        expect(files.some((f) => f.includes("fix-codex-legacy-0003.json"))).toBe(true);
        expect(files.some((f) => f.includes("fix-codex-empty-0004.jsonl"))).toBe(true);
    });

    it("returns [] for a missing root", () => 
    {
        expect(codexAdapter.discover(join(fixtureRoot, "nope"))).toEqual([]);
    });
});

// ---- modern envelope format (format C) -------------------------------------

describe("codexAdapter.parse — modern envelope .jsonl", () => 
{
    let session!: Session;
    beforeAll(() => 
    {
        session = codexAdapter.parse(modernFile);
    });

    it("parses without throwing", () => 
    {
        expect(session).toBeTruthy();
    });

    it("captures agent, sessionId, filePath", () => 
    {
        expect(session.agent).toBe("codex");
        expect(session.sessionId).toBe("fix-codex-0001");
        expect(session.filePath).toBe(modernFile);
    });

    it("captures cwd from session_meta and project", () => 
    {
        expect(session.cwd).toBe("/Users/ole/projekte/demo");
        expect(session.project).toBe("/Users/ole/projekte/demo");
    });

    it("captures startedAt from session_meta and endedAt from last event", () => 
    {
        expect(session.startedAt).toBe("2026-06-19T10:00:00.100Z");
        expect(session.endedAt).toBe("2026-06-19T10:00:11.000Z");
    });

    it("captures model from turn_context", () => 
    {
        expect(session.model).toBe("gpt-5.5");
    });

    it("emits user and assistant messages, skipping developer/reasoning/event_msg", () => 
    {
        const roles = session.messages.map((m) => m.role);
        // 2 user + 3 assistant text + 3 tool-call assistant msgs = 8
        expect(roles.filter((r) => r === "user")).toHaveLength(2);
        expect(roles.filter((r) => r === "assistant")).toHaveLength(6);
        expect(session.messageCount).toBe(8);
    });

    it("joins assistant output_text and excludes reasoning", () => 
    {
        const a1 = session.messages.find(
            (m) => m.text === "I'll check the last commit with git.",
        );
        expect(a1).toBeTruthy();
        expect(a1!.role).toBe("assistant");
    });

    it("captures function_call as a tool call with parsed arguments", () => 
    {
        const toolMsg = session.messages.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.name === "shell",
        );
        expect(toolMsg).toBeTruthy();
        const tc = toolMsg!.toolCalls[0]!;
        expect(tc.input).toEqual({
            command: ["bash", "-lc", "git show --stat HEAD"],
        });
        // call_001 output has exit_code 0 → ok
        expect(tc.status).toBe("ok");
        expect(tc.output).toContain("src/index.ts");
    });

    it("matches function_call_output to the tool call by call_id", () => 
    {
        const toolMsgs = session.messages.filter((m) => m.toolCalls.length > 0);
        // call_001 (git show) → ok, call_002 (apply_patch) → ok, call_003 (npm test) → error
        const git = toolMsgs.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.output?.includes("src/index.ts"),
        );
        expect(git).toBeTruthy();
        expect(git!.toolCalls[0]!.status).toBe("ok");

        const test = toolMsgs.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.output?.includes("FAIL"),
        );
        expect(test).toBeTruthy();
        expect(test!.toolCalls[0]!.status).toBe("error");
    });

    it("captures custom_tool_call (apply_patch) with raw input", () => 
    {
        const patch = session.messages.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.name === "apply_patch",
        );
        expect(patch).toBeTruthy();
        expect(patch!.toolCalls[0]!.input).toContain("Begin Patch");
        expect(patch!.toolCalls[0]!.status).toBe("ok");
        expect(patch!.toolCalls[0]!.output).toContain("Success");
    });

    it("does not leak developer (permissions) messages into the transcript", () => 
    {
        expect(session.messages.some((m) => m.text.includes("permissions instructions"))).toBe(false);
    });

    it("skips injected AGENTS.md + environment_context user messages", () => 
    {
    // The fixture includes an injected user message with:
    //   block[0]: "# AGENTS.md instructions for /Users/ole/projekte/demo\n\n<INSTRUCTIONS>..."
    //   block[1]: "<environment_context>..."
    // This must NOT appear in the transcript — it's a machine-generated
    // instruction block, not a real user task.
        expect(session.messages.some((m) => m.text.includes("# AGENTS.md instructions for"))).toBe(false);
        expect(session.messages.some((m) => m.text.includes("<environment_context>"))).toBe(false);
        expect(session.messages.some((m) => m.text.includes("<INSTRUCTIONS>"))).toBe(false);
    });

    it("picks up the real task as the first user message, not the AGENTS.md injection", () => 
    {
        const firstUser = session.messages.find((m) => m.role === "user");
        expect(firstUser).toBeTruthy();
        expect(firstUser!.text).toBe("Show me what files changed in the last commit.");
    });
});

// ---- flat .jsonl format (format B) -----------------------------------------

describe("codexAdapter.parse — flat .jsonl (no envelope)", () => 
{
    let session!: Session;
    beforeAll(() => 
    {
        session = codexAdapter.parse(flatFile);
    });

    it("parses without throwing", () => 
    {
        expect(session).toBeTruthy();
    });

    it("captures sessionId and startedAt from the bare metadata header", () => 
    {
        expect(session.sessionId).toBe("fix-codex-flat-0002");
        expect(session.startedAt).toBe("2025-07-19T22:25:43.741Z");
    });

    it("has no cwd (not available in flat format)", () => 
    {
        expect(session.cwd).toBeNull();
        expect(session.project).toBeNull();
    });

    it("emits user + assistant + shell tool call", () => 
    {
        const roles = session.messages.map((m) => m.role);
        expect(roles).toContain("user");
        expect(roles).toContain("assistant");
        // 1 user + 1 tool-call msg + 1 assistant text = 3
        expect(session.messageCount).toBe(3);
    });

    it("parses local_shell_call as a shell tool call with action as input", () => 
    {
        const tool = session.messages.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.name === "shell",
        );
        expect(tool).toBeTruthy();
        expect(tool!.toolCalls[0]!.input).toEqual({
            type: "exec",
            command: ["bash", "-lc", "ls -1"],
            timeout_ms: null,
            working_directory: null,
            env: {},
            user: null,
        });
        expect(tool!.toolCalls[0]!.status).toBe("ok");
        expect(tool!.toolCalls[0]!.output).toContain("AGENTS.md");
    });
});

// ---- legacy .json format (format A) ----------------------------------------

describe("codexAdapter.parse — legacy .json", () => 
{
    let session!: Session;
    beforeAll(() => 
    {
        session = codexAdapter.parse(legacyFile);
    });

    it("parses without throwing", () => 
    {
        expect(session).toBeTruthy();
    });

    it("captures sessionId and startedAt from session header", () => 
    {
        expect(session.sessionId).toBe("fix-codex-legacy-0003");
        expect(session.startedAt).toBe("2025-04-17T14:50:24.646Z");
    });

    it("emits user + assistant messages and a shell tool call", () => 
    {
        const roles = session.messages.map((m) => m.role);
        // 1 user + 1 tool-call msg + 2 assistant text = 4
        expect(roles.filter((r) => r === "user")).toHaveLength(1);
        expect(roles.filter((r) => r === "assistant")).toHaveLength(3);
        expect(session.messageCount).toBe(4);
    });

    it("parses function_call with arguments JSON string", () => 
    {
        const tool = session.messages.find(
            (m) => m.toolCalls.length > 0 && m.toolCalls[0]!.name === "shell",
        );
        expect(tool).toBeTruthy();
        expect(tool!.toolCalls[0]!.input).toEqual({
            command: ["bash", "-lc", "ls -R ."],
        });
        expect(tool!.toolCalls[0]!.status).toBe("ok");
    });

    it("skips reasoning items", () => 
    {
        expect(session.messages.some((m) => m.text.includes("reasoning"))).toBe(false);
    });
});

// ---- edge cases -------------------------------------------------------------

describe("codexAdapter.parse — edge cases", () => 
{
    it("does not throw on a metadata-only stub file (0 messages)", () => 
    {
        const s = codexAdapter.parse(stubFile);
        expect(s.messageCount).toBe(0);
        expect(s.messages).toEqual([]);
        expect(s.sessionId).toBe("fix-codex-empty-0004");
    });

    it("does not throw on a non-existent file", () => 
    {
        const s = codexAdapter.parse(join(fixtureRoot, "does-not-exist.jsonl"));
        expect(s.messageCount).toBe(0);
        expect(s.messages).toEqual([]);
    });
});
