import { readdirSync, statSync } from "node:fs";
import { basename, dirname,join } from "node:path";

import type { Adapter } from "../adapter.js";
import { readJsonl } from "../jsonl.js";
import type { Message, MessageStats, Session, SessionStats, ToolCall } from "../types.js";

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
    subtype?: string;
    /** System lines carry their text in a top-level `content` (not `message.content`). */
    content?: string;
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
        usage?: ClaudeUsage;
    };
}

/** Claude `message.usage` block on assistant lines (per-turn token accounting). */
interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/** Decode an encoded-cwd directory name (`-Users-ole-foo`) back to a path (`/Users/ole/foo`). */
export function decodeCwd(dir: string): string 
{
    // The encoding replaces every `/` with `-`, so a leading `/` becomes a
    // leading `-`. Reversing is a straight `-` -> `/` replacement.
    if (!dir.includes("-")) {return dir;}
    return dir.replaceAll("-", "/");
}

function blocksOf(line: ClaudeLine): ContentBlock[] 
{
    const content = line.message?.content;
    if (Array.isArray(content)) {return content;}
    return [];
}

/** Flatten a tool_result's `content` (string or array of text blocks) to a string. */
function resultContentToString(content: ContentBlock["content"]): string 
{
    if (typeof content === "string") {return content;}
    if (Array.isArray(content)) 
    {
        return content
            .map((b) => (typeof b?.text === "string" ? b.text : ""))
            .join("\n");
    }
    return "";
}

/** Build a ToolCall[] from assistant tool_use blocks, keyed by id for later result matching. */
function toolCallsFromAssistant(line: ClaudeLine): ToolCall[] 
{
    const calls: ToolCall[] = [];
    for (const b of blocksOf(line)) 
    {
        if (b.type === "tool_use" && b.id && b.name) 
        {
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
function parseClaude(filePath: string): Session 
{
    const lines = readJsonl(filePath) as ClaudeLine[];
    const fileName = basename(filePath, ".jsonl");

    let sessionId = fileName;
    let cwd: string | null = null;
    let model: string | null = null;
    let startedAt = "";
    let endedAt: string | null = null;

    // tool_use id → index into the assistant message's toolCalls (for result matching)
    // We match results to the most recent tool_use with that id.
    const toolUseIndex = new Map<string, { msg: Message; idx: number }>();

    // Accumulated per-session token totals from assistant `message.usage` blocks.
    const totals = { input: 0, output: 0, cached: 0 };

    const messages: Message[] = [];

    for (const line of lines) 
    {
        if (!line || typeof line !== "object") {continue;}
        if (line.sessionId) {sessionId = line.sessionId;}
        if (line.cwd) {cwd = line.cwd;}
        if (line.timestamp) 
        {
            if (!startedAt) {startedAt = line.timestamp;}
            endedAt = line.timestamp;
        }

        const role = line.message?.role;
        const content = line.message?.content;

        if (role === "assistant") 
        {
            if (line.message?.model) {model = line.message.model;}
            const text = blocksOf(line)
                .filter((b) => b.type === "text" && typeof b.text === "string")
                .map((b) => b.text as string)
                .join("\n");
            const toolCalls = toolCallsFromAssistant(line);
            const stats = messageStatsFromUsage(line.message?.usage);
            const msg: Message = {
                role: "assistant",
                text,
                toolCalls,
                timestamp: line.timestamp ?? null,
            };
            if (stats)
            {
                msg.stats = stats;
                accumulateUsage(stats, totals);
            }
            // register tool_use ids for result matching (position-aligned to toolCalls)
            const useIds = blocksOf(line)
                .filter((b) => b.type === "tool_use" && b.id)
                .map((b) => b.id as string);
            for (let i = 0; i < toolCalls.length && i < useIds.length; i++) 
            {
                toolUseIndex.set(useIds[i]!, { msg, idx: i });
            }
            messages.push(msg);
        }
        else if (role === "user") 
        {
            // user content can be a plain string or an array of blocks
            if (typeof content === "string") 
            {
                // skip meta/local-command-caveat lines from the visible transcript
                if (line.isMeta) {continue;}
                messages.push({
                    role: "user",
                    text: content,
                    toolCalls: [],
                    timestamp: line.timestamp ?? null,
                });
            }
            else if (Array.isArray(content)) 
            {
                // tool_result blocks: attach to the corresponding assistant tool_use
                let hasResult = false;
                for (const b of content) 
                {
                    if (b?.type === "tool_result" && b.tool_use_id) 
                    {
                        hasResult = true;
                        const target = toolUseIndex.get(b.tool_use_id);
                        if (target) 
                        {
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
                if (text && !hasResult && !line.isMeta) 
                {
                    messages.push({
                        role: "user",
                        text,
                        toolCalls: [],
                        timestamp: line.timestamp ?? null,
                    });
                }
            }
        }
        // system / mode / other lines: no message emitted, but we already
        // captured cwd/branch — except `away_summary` recaps, which are
        // content-bearing system lines. A recap is Claude's own "while you were
        // away" summary (what was done + the next step). It is `isMeta: false`
        // real content, not metadata, so it must not be dropped. Other system
        // subtypes (e.g. `turn_duration`) are pure metadata and stay skipped.
        // See docs/format-claude.md.
        if (line.type === "system" && line.subtype === "away_summary" && line.content) 
        {
            messages.push({
                role: "summary",
                subtype: "recap",
                text: line.content,
                toolCalls: [],
                timestamp: line.timestamp ?? null,
            });
        }
    }

    if (!startedAt) 
    {
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
        stats: claudeSessionStats(totals),
    };
}

/** Build a assistant {@link MessageStats} from a Claude `usage` block. */
function messageStatsFromUsage(usage: ClaudeUsage | undefined): MessageStats | undefined
{
    if (!usage || typeof usage !== "object") { return undefined; }
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    // No `usage` block fields means the message carried no token accounting.
    if (input === 0 && output === 0 && cacheCreate === 0 && cacheRead === 0)
    {
        return undefined;
    }
    return {
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cacheCreate + cacheRead,
        reasoningTokens: 0,
        // The prompt size for this turn = fresh input + cached creation + cached reads.
        contextSize: input + cacheCreate + cacheRead,
    };
}

/** Accumulate a per-turn {@link MessageStats} into the running session totals. */
function accumulateUsage(stats: MessageStats, totals: { input: number; output: number; cached: number }): void
{
    totals.input += stats.inputTokens;
    totals.output += stats.outputTokens;
    totals.cached += stats.cachedInputTokens;
}

/** Build the aggregate {@link SessionStats} for a Claude session. */
function claudeSessionStats(totals: { input: number; output: number; cached: number }): SessionStats | undefined
{
    if (totals.input === 0 && totals.output === 0 && totals.cached === 0)
    {
        return undefined;
    }
    return {
        totalInputTokens: totals.input,
        totalOutputTokens: totals.output,
        cachedInputTokens: totals.cached,
        reasoningTokens: 0,
        // Claude's transcript does not carry the model's context-window limit.
        contextWindow: null,
        // Claude does not report a running context size; the per-turn contextSize
        // is on each assistant message, but the session-level final/peak are unknown.
        finalContextSize: null,
        peakContextSize: null,
    };
}

/** Coerce an unknown value to a non-negative number, defaulting to 0. */
function num(v: unknown): number
{
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export const claudeAdapter: Adapter = {
    agent: "claude",
    defaultRoot: () => "~/.claude/projects",
    discover(root: string): string[] 
    {
        const files: string[] = [];
        let entries: string[];
        try 
        {
            entries = readdirSync(root);
        }
        catch 
        {
            return [];
        }
        for (const entry of entries) 
        {
            const sub = join(root, entry);
            let isDir = false;
            try 
            {
                isDir = statSync(sub).isDirectory();
            }
            catch 
            {
                continue;
            }
            if (!isDir) {continue;}
            let subEntries: string[];
            try 
            {
                subEntries = readdirSync(sub);
            }
            catch 
            {
                continue;
            }
            for (const f of subEntries) 
            {
                if (f.endsWith(".jsonl")) {files.push(join(sub, f));}
            }
        }
        return files;
    },
    parse: parseClaude,
};
