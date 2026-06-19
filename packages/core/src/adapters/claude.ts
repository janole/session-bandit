import { readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { readJsonl } from "../jsonl.js";
import type { Adapter } from "../adapter.js";
import type { Session, Message, ToolCall } from "../types.js";

/**
 * Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * where `<encoded-cwd>` is the working dir with `/` replaced by `-`.
 *
 * Each line is a JSON object tagged by `type`. We care about:
 *  - `user`      → a user turn (text) and/or tool_result blocks
 *  - `assistant` → an assistant turn with text/thinking/tool_use blocks
 *  - `system`    → metadata (cwd, gitBranch, version, durationMs)
 * Everything else (`mode`, `permission-mode`, `ai-title`, `attachment`, …) is
 * skipped. Malformed or unrecognized lines are always skipped, never thrown.
 */

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[] | null;
  is_error?: boolean;
}

interface ClaudeLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  uuid?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
  };
}

/** Decode an encoded-cwd directory name (`-Users-ole-foo`) back to a path (`/Users/ole/foo`). */
export function decodeCwd(dir: string): string {
  // The encoding replaces every `/` with `-`, so a leading `/` becomes a
  // leading `-`. Reversing is a straight `-` -> `/` replacement.
  if (!dir.includes("-")) return dir;
  return dir.replaceAll("-", "/");
}

function blocksOf(line: ClaudeLine): ContentBlock[] {
  const content = line.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

/** Flatten a tool_result's `content` (string or array of text blocks) to a string. */
function resultContentToString(content: ContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

/** Build a ToolCall[] from assistant tool_use blocks, keyed by id for later result matching. */
function toolCallsFromAssistant(line: ClaudeLine): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const b of blocksOf(line)) {
    if (b.type === "tool_use" && b.id && b.name) {
      calls.push({
        name: b.name,
        input: b.input ?? null,
        status: "unknown",
        output: null,
      });
    }
  }
  return calls;
}

/** Parse one Claude session file. Never throws. */
function parseClaude(filePath: string): Session {
  const lines = readJsonl(filePath) as ClaudeLine[];
  const fileName = basename(filePath, ".jsonl");

  let sessionId = fileName;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let model: string | null = null;
  let startedAt = "";
  let endedAt: string | null = null;

  // tool_use id → index into the assistant message's toolCalls (for result matching)
  // We match results to the most recent tool_use with that id.
  const toolUseIndex = new Map<string, { msg: Message; idx: number }>();

  const messages: Message[] = [];

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (line.sessionId) sessionId = line.sessionId;
    if (line.cwd) cwd = line.cwd;
    if (line.gitBranch) gitBranch = line.gitBranch;
    if (line.timestamp) {
      if (!startedAt) startedAt = line.timestamp;
      endedAt = line.timestamp;
    }

    const role = line.message?.role;
    const content = line.message?.content;

    if (role === "assistant") {
      if (line.message?.model) model = line.message.model;
      const text = blocksOf(line)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      const toolCalls = toolCallsFromAssistant(line);
      const msg: Message = {
        role: "assistant",
        text,
        toolCalls,
        timestamp: line.timestamp ?? null,
      };
      // register tool_use ids for result matching (position-aligned to toolCalls)
      const useIds = blocksOf(line)
        .filter((b) => b.type === "tool_use" && b.id)
        .map((b) => b.id as string);
      for (let i = 0; i < toolCalls.length && i < useIds.length; i++) {
        toolUseIndex.set(useIds[i]!, { msg, idx: i });
      }
      messages.push(msg);
    } else if (role === "user") {
      // user content can be a plain string or an array of blocks
      if (typeof content === "string") {
        // skip meta/local-command-caveat lines from the visible transcript
        if (line.isMeta) continue;
        messages.push({
          role: "user",
          text: content,
          toolCalls: [],
          timestamp: line.timestamp ?? null,
        });
      } else if (Array.isArray(content)) {
        // tool_result blocks: attach to the corresponding assistant tool_use
        let hasResult = false;
        for (const b of content) {
          if (b?.type === "tool_result" && b.tool_use_id) {
            hasResult = true;
            const target = toolUseIndex.get(b.tool_use_id);
            if (target) {
              const tc = target.msg.toolCalls[target.idx]!;
              tc.output = resultContentToString(b.content);
              tc.status = b.is_error ? "error" : "ok";
            }
          }
        }
        // also surface any plain text blocks on user turns
        const text = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
        if (text && !hasResult && !line.isMeta) {
          messages.push({
            role: "user",
            text,
            toolCalls: [],
            timestamp: line.timestamp ?? null,
          });
        }
      }
    }
    // system / mode / other lines: no message emitted, but we already captured cwd/branch
  }

  if (!startedAt) {
    // no timestamps at all — fall back to file mtime would need fs.stat; use empty
    startedAt = "";
  }

  const project = cwd ?? decodeCwd(basename(dirname(filePath)));

  return {
    agent: "claude",
    sessionId,
    filePath,
    project,
    cwd,
    startedAt,
    endedAt,
    model,
    messageCount: messages.length,
    messages,
  };
}

export const claudeAdapter: Adapter = {
  agent: "claude",
  defaultRoot: () => "~/.claude/projects",
  discover(root: string): string[] {
    const files: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    for (const entry of entries) {
      const sub = join(root, entry);
      let isDir = false;
      try {
        isDir = statSync(sub).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      let subEntries: string[];
      try {
        subEntries = readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of subEntries) {
        if (f.endsWith(".jsonl")) files.push(join(sub, f));
      }
    }
    return files;
  },
  parse: parseClaude,
};