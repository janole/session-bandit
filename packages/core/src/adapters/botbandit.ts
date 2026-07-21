import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Adapter } from "../adapter.js";
import { num } from "../num.js";
import type { Message, RelatedSessionReference, Session, SessionStats, ToolCall } from "../types.js";

/**
 * BotBandit stores one JSONL event log per session under
 * `~/.botbandit/sessions/<sessionId>.jsonl`.
 *
 * The durable protocol is the `SessionEvent` union from botbandit's
 * `packages/agent-core/src/types.ts`. The event log is event-sourced: `message`
 * events carry AI SDK `ModelMessage` history, while `memory` and `compaction`
 * events carry high-signal generated summaries. Live `stream` events are ignored
 * because persisted assistant messages supersede them.
 */

interface BotBanditEvent
{
    type?: string;
    event_id?: string;
    timestamp?: string;
    id?: string;
    parentId?: string;
    schemaVersion?: number;
    config?: { profile?: string; provider?: string; model?: string };
    cwd?: string;
    project?: string;
    git?: { root?: string; remote?: string; branch?: string };
    message?: ProviderMessage;
    variant?: string;
    text?: string;
    format?: string;
    kind?: string;
    turn_id?: string;
    error?: string;
    stepCount?: number;
    toolCallCount?: number;
    durationMs?: number;
    prompt?: string;
    status?: string;
    title?: string;
    goal?: string;
    summary?: string;
    guidance?: string;
    turnCount?: number;
    historyLength?: number;
    nextSteps?: string[];
    tags?: string[];
    resources?: string[];
    importance?: number;
    subAgentId?: string;
    agent?: string;
    task?: string;
    result?: string;
    /** AI SDK `usage` block on `turn_end` / `loop_end` events (per-turn tokens). */
    usage?: BotBanditUsage;
}

/** BotBandit `turn_end`/`loop_end` `usage` block (AI SDK shape). */
interface BotBanditUsage
{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
}

interface ProviderMessage
{
    role?: string;
    content?: string | ProviderPart[];
    providerMetadata?: Record<string, unknown>;
}

interface ProviderPart
{
    type?: string;
    text?: string;
    reasoning?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    approvalId?: string;
    approved?: boolean;
    reason?: string;
    providerMetadata?: Record<string, unknown>;
}

interface ParseContext
{
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    cwd: string | null;
    project: string | null;
    model: string | null;
    messages: Message[];
    callIndex: Map<string, ToolCall>;
    wrappedCodexSessionIds: Set<string>;
    subAgentTitles: Map<string, string>;
    /** Accumulated per-session token totals from `turn_end`/`loop_end` usage blocks. */
    usageTotals: { input: number; output: number; cached: number; reasoning: number };
    /** Peak context size observed across turn usages. */
    peakContextSize: number | null;
    /** Last context size observed (becomes `finalContextSize`). */
    lastContextSize: number | null;
    /** Most recent assistant message, to attach per-turn usage to. */
    lastAssistant: Message | null;
}

const CODEX_PROVIDER_ID = "@janole/ai-sdk-provider-codex-asp";

/** Event types known to the BotBandit session adapter. Exported for doctor diagnostics. */
export const BOTBANDIT_KNOWN_EVENT_TYPES = new Set([
    "session_init",
    "config",
    "approval_routing",
    "approval_policy",
    "approval_decided",
    "approval_deferred",
    "context",
    "stream",
    "message",
    "send",
    "turn_start",
    "turn_end",
    "cancel",
    "interrupted",
    "loop_start",
    "loop_end",
    "notice",
    "tool_display",
    "lifecycle",
    "compaction",
    "memory",
    "skill",
    "sub_agent_started",
    "sub_agent_continued",
    "sub_agent_finished",
    "extension",
]);

/** Parse a BotBandit session file. Never throws. */
function parseBotBandit(filePath: string): Session
{
    const fileName = basename(filePath);
    let raw: string;
    try
    {
        raw = readFileSync(filePath, "utf8");
    }
    catch
    {
        return emptySession(filePath, fileName);
    }

    const ctx: ParseContext = {
        sessionId: stripExt(fileName),
        startedAt: "",
        endedAt: null,
        cwd: null,
        project: null,
        model: null,
        messages: [],
        callIndex: new Map(),
        wrappedCodexSessionIds: new Set(),
        subAgentTitles: new Map(),
        usageTotals: { input: 0, output: 0, cached: 0, reasoning: 0 },
        peakContextSize: null,
        lastContextSize: null,
        lastAssistant: null,
    };

    for (const event of parseLines(raw))
    {
        processEvent(event, ctx);
    }

    return buildSession(filePath, ctx);
}

function processEvent(event: BotBanditEvent, ctx: ParseContext): void
{
    if (!event || typeof event !== "object") { return; }

    if (event.timestamp)
    {
        if (!ctx.startedAt) { ctx.startedAt = event.timestamp; }
        ctx.endedAt = event.timestamp;
    }

    if (event.type === "session_init")
    {
        if (event.id) { ctx.sessionId = event.id; }
        return;
    }

    if (event.type === "config")
    {
        if (event.config?.model) { ctx.model = event.config.model; }
        return;
    }

    if (event.type === "context")
    {
        if (event.cwd) { ctx.cwd = event.cwd; }
        if (event.project) { ctx.project = event.project; }
        if (!ctx.cwd && event.git?.root) { ctx.cwd = event.git.root; }
        return;
    }

    if (event.type === "message" && event.message)
    {
        processProviderMessage(event, ctx);
        return;
    }

    if (event.type === "memory")
    {
        ctx.messages.push({
            role: "summary",
            subtype: "memory",
            text: memoryText(event),
            toolCalls: [],
            timestamp: event.timestamp ?? null,
        });
        return;
    }

    if (event.type === "compaction")
    {
        ctx.messages.push({
            role: "summary",
            subtype: "compaction",
            text: compactionText(event),
            toolCalls: [],
            timestamp: event.timestamp ?? null,
        });
        return;
    }

    if (event.type === "notice" && event.variant !== "debug" && event.text)
    {
        ctx.messages.push({
            role: "system",
            subtype: "notice",
            text: `[${event.variant ?? "info"}] ${event.text}`,
            toolCalls: [],
            timestamp: event.timestamp ?? null,
        });
        return;
    }

    if (event.type === "turn_end" && event.error)
    {
        ctx.messages.push({
            role: "system",
            text: `[error] ${event.error}`,
            toolCalls: [],
            timestamp: event.timestamp ?? null,
        });
        recordUsage(event, ctx);
        return;
    }

    // `turn_end` carries the per-callModel usage; `loop_end.usage` is the
    // accumulated sum of all steps in the loop (botbandit builds it via
    // addLanguageModelUsage in agent-session.ts). Accumulating both would
    // double-count every token and inflate peakContextSize with a multi-step
    // aggregate, so only turn_end feeds the stats.
    if (event.type === "turn_end")
    {
        recordUsage(event, ctx);
        return;
    }

    if (event.type === "cancel")
    {
        ctx.messages.push({
            role: "system",
            text: "Cancellation requested.",
            toolCalls: [],
            timestamp: event.timestamp ?? null,
        });
        return;
    }

    if (event.type === "sub_agent_started")
    {
        rememberSubAgentTitle(event, ctx);
        ctx.messages.push({
            role: "summary",
            subtype: "sub_agent",
            text: `Sub-agent ${event.agent ?? event.subAgentId ?? "unknown"} started${event.title ? `: ${event.title}` : ""}\n\n${event.task ?? ""}`.trim(),
            toolCalls: [],
            timestamp: event.timestamp ?? null,
            metadata: subAgentMetadata(event, ctx),
        });
        return;
    }

    if (event.type === "sub_agent_continued")
    {
        rememberSubAgentTitle(event, ctx);
        ctx.messages.push({
            role: "summary",
            subtype: "sub_agent",
            text: `Sub-agent ${event.subAgentId ?? "unknown"} continued${event.title ? `: ${event.title}` : ""}\n\n${event.task ?? ""}`.trim(),
            toolCalls: [],
            timestamp: event.timestamp ?? null,
            metadata: subAgentMetadata(event, ctx),
        });
        return;
    }

    if (event.type === "sub_agent_finished")
    {
        ctx.messages.push({
            role: "summary",
            subtype: "sub_agent",
            text: `Sub-agent ${event.subAgentId ?? "unknown"} finished (${event.status ?? "unknown"}).\n\n${event.result ?? ""}`.trim(),
            toolCalls: [],
            timestamp: event.timestamp ?? null,
            metadata: subAgentMetadata(event, ctx),
        });
    }
}

function rememberSubAgentTitle(event: BotBanditEvent, ctx: ParseContext): void
{
    const sessionId = stringValue(event.subAgentId);
    const title = stringValue(event.title);
    if (sessionId && title) { ctx.subAgentTitles.set(sessionId, title); }
}

function subAgentMetadata(event: BotBanditEvent, ctx: ParseContext): { relatedSessions: RelatedSessionReference[] } | undefined
{
    const relatedSession = subAgentReference(event, ctx);
    return relatedSession ? { relatedSessions: [relatedSession] } : undefined;
}

function subAgentReference(event: BotBanditEvent, ctx: ParseContext): RelatedSessionReference | undefined
{
    const sessionId = stringValue(event.subAgentId);
    if (!sessionId) { return undefined; }

    return {
        agent: "botbandit",
        kind: "sub_agent",
        sessionId,
        title: stringValue(event.title) ?? ctx.subAgentTitles.get(sessionId),
        turnId: stringValue(event.turn_id),
    };
}

function processProviderMessage(event: BotBanditEvent, ctx: ParseContext): void
{
    const message = event.message;
    if (!message) { return; }

    const timestamp = event.timestamp ?? null;
    collectWrappedCodexSessions(message, timestamp, ctx);

    if (message.role === "user")
    {
        const text = contentText(message.content);
        if (text)
        {
            ctx.messages.push({ role: "user", text, toolCalls: [], timestamp });
        }
        return;
    }

    if (message.role === "assistant")
    {
        const parts = Array.isArray(message.content) ? message.content : [];
        const text = typeof message.content === "string" ? message.content : contentText(parts);
        const toolCalls = toolCallsFromParts(parts);
        const normalized: Message = { role: "assistant", text, toolCalls, timestamp };
        for (const [index, part] of parts.entries())
        {
            if (part.type === "tool-call" && part.toolCallId)
            {
                const tc = toolCalls[indexForToolCallPart(parts, index)];
                if (tc) { ctx.callIndex.set(part.toolCallId, tc); }
            }
        }
        if (text || toolCalls.length > 0) { ctx.messages.push(normalized); ctx.lastAssistant = normalized; }
        return;
    }

    if (message.role === "tool")
    {
        const parts = Array.isArray(message.content) ? message.content : [];
        const toolResults = toolResultCalls(parts, ctx.callIndex);
        if (toolResults.length > 0 || typeof message.content === "string")
        {
            ctx.messages.push({
                role: "tool",
                text: typeof message.content === "string" ? message.content : "",
                toolCalls: toolResults,
                timestamp,
            });
        }
        return;
    }

    if (message.role === "system")
    {
        const text = contentText(message.content);
        if (text) { ctx.messages.push({ role: "system", text, toolCalls: [], timestamp }); }
    }
}

function collectWrappedCodexSessions(message: ProviderMessage, timestamp: string | null, ctx: ParseContext): void
{
    recordCodexProviderMetadata(message.providerMetadata, timestamp, ctx);

    if (!Array.isArray(message.content)) { return; }
    for (const part of message.content)
    {
        recordCodexProviderMetadata(part.providerMetadata, timestamp, ctx);
    }
}

function recordCodexProviderMetadata(providerMetadata: unknown, timestamp: string | null, ctx: ParseContext): void
{
    if (!isRecord(providerMetadata)) { return; }

    const entry = providerMetadata[CODEX_PROVIDER_ID];
    if (!isRecord(entry)) { return; }

    const threadId = stringValue(entry.threadId);
    if (!threadId || ctx.wrappedCodexSessionIds.has(threadId)) { return; }

    const relatedSession = wrappedCodexReference({
        threadId,
        turnId: stringValue(entry.turnId),
        threadPath: stringValue(entry.threadPath),
    });
    ctx.wrappedCodexSessionIds.add(threadId);
    ctx.messages.push({
        role: "summary",
        subtype: "wrapped_codex",
        text: wrappedCodexText(relatedSession),
        toolCalls: [],
        timestamp,
        metadata: { relatedSessions: [relatedSession] },
    });
}

function wrappedCodexReference(metadata: { threadId: string; turnId?: string; threadPath?: string }): RelatedSessionReference
{
    return {
        agent: "codex",
        kind: "wrapped_codex",
        sessionId: metadata.threadId,
        turnId: metadata.turnId,
        path: metadata.threadPath,
    };
}

function wrappedCodexText(metadata: RelatedSessionReference): string
{
    return [
        `Original Codex session: ${metadata.sessionId}`,
        metadata.turnId ? `First observed turn: ${metadata.turnId}` : undefined,
        metadata.path ? `Codex session file: ${metadata.path}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
}

function toolCallsFromParts(parts: ProviderPart[]): ToolCall[]
{
    return parts
        .filter(part => part.type === "tool-call")
        .map(part => ({
            name: part.toolName ?? "unknown",
            input: part.input ?? null,
            status: "unknown",
            output: null,
        }));
}

function toolResultCalls(parts: ProviderPart[], callIndex: Map<string, ToolCall>): ToolCall[]
{
    const out: ToolCall[] = [];
    for (const part of parts)
    {
        if (part.type === "tool-result")
        {
            const output = stringifyToolOutput(part.output);
            const status = toolResultStatus(part.output);
            if (part.toolCallId)
            {
                const existing = callIndex.get(part.toolCallId);
                if (existing)
                {
                    existing.output = output;
                    existing.status = status;
                    continue;
                }
            }

            out.push({
                name: part.toolName ?? "unknown",
                input: null,
                status,
                output,
            });
        }
        else if (part.type === "tool-approval-response")
        {
            out.push({
                name: "tool_approval",
                input: { approvalId: part.approvalId, approved: part.approved, reason: part.reason },
                status: part.approved === false ? "error" : "ok",
                output: part.reason ?? null,
            });
        }
    }
    return out;
}

function indexForToolCallPart(parts: ProviderPart[], partIndex: number): number
{
    let count = 0;
    for (let i = 0; i <= partIndex; i++)
    {
        if (parts[i]?.type === "tool-call") { count++; }
    }
    return count - 1;
}

function contentText(content: ProviderMessage["content"]): string
{
    if (typeof content === "string") { return content; }
    if (!Array.isArray(content)) { return ""; }

    return content
        .filter(part => part.type === "text")
        .map(part => part.text ?? part.reasoning ?? "")
        .filter(Boolean)
        .join("\n");
}

function stringifyToolOutput(output: unknown): string | null
{
    if (output === undefined || output === null) { return null; }
    if (typeof output === "string") { return output; }
    try
    {
        return JSON.stringify(output);
    }
    catch
    {
        return String(output);
    }
}

function toolResultStatus(output: unknown): "ok" | "error" | "unknown"
{
    if (output && typeof output === "object" && "type" in output)
    {
        const type = (output as { type?: unknown }).type;
        if (type === "error" || type === "execution-denied") { return "error"; }
    }
    return "ok";
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined
{
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function memoryText(event: BotBanditEvent): string
{
    const lines = [
        event.title ? `Memory: ${event.title}` : "Memory",
        event.goal ? `Goal: ${event.goal}` : undefined,
        event.status ? `Status: ${event.status}` : undefined,
        event.summary,
        event.nextSteps?.length ? `Next steps:\n${event.nextSteps.map(step => `- ${step}`).join("\n")}` : undefined,
        event.tags?.length ? `Tags: ${event.tags.join(", ")}` : undefined,
        event.resources?.length ? `Resources: ${event.resources.join(", ")}` : undefined,
        typeof event.importance === "number" ? `Importance: ${event.importance}` : undefined,
    ];
    return lines.filter((line): line is string => Boolean(line)).join("\n\n");
}

function compactionText(event: BotBanditEvent): string
{
    const prefix = typeof event.turnCount === "number" || typeof event.historyLength === "number"
        ? `Compaction after ${event.turnCount ?? "?"} turns / ${event.historyLength ?? "?"} history messages.`
        : "Compaction";
    return [
        prefix,
        event.guidance ? `Guidance: ${event.guidance}` : undefined,
        event.summary,
    ].filter((line): line is string => Boolean(line)).join("\n\n");
}

function parseLines(raw: string): BotBanditEvent[]
{
    const out: BotBanditEvent[] = [];
    for (const line of raw.split("\n"))
    {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try
        {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === "object")
            {
                out.push(parsed as BotBanditEvent);
            }
        }
        catch
        {
            // Skip malformed lines.
        }
    }
    return out;
}

function stripExt(fileName: string): string
{
    return fileName.replace(/\.jsonl$/, "");
}

function emptySession(filePath: string, fileName: string): Session
{
    return {
        agent: "botbandit",
        sessionId: stripExt(fileName),
        filePath,
        project: null,
        cwd: null,
        startedAt: "",
        endedAt: null,
        model: null,
        messageCount: 0,
        messages: [],
    };
}

function buildSession(filePath: string, ctx: ParseContext): Session
{
    return {
        agent: "botbandit",
        sessionId: ctx.sessionId,
        filePath,
        project: ctx.project ?? ctx.cwd,
        cwd: ctx.cwd,
        startedAt: ctx.startedAt,
        endedAt: ctx.endedAt,
        model: ctx.model,
        messageCount: ctx.messages.length,
        messages: ctx.messages,
        stats: buildBotBanditStats(ctx),
    };
}

/**
 * Record per-turn token usage from a `turn_end` / `loop_end` event. Accumulates
 * session totals, tracks peak/last context size, and attaches the per-turn
 * {@link MessageStats} to the nearest preceding assistant message.
 */
function recordUsage(event: BotBanditEvent, ctx: ParseContext): void
{
    const usage = event.usage;
    if (!usage || typeof usage !== "object") { return; }

    // BotBandit (AI SDK / OpenAI convention): `inputTokens` includes cached and
    // `outputTokens` includes reasoning. Normalize to fresh input / non-reasoning
    // output to match the Claude convention used by SessionStats.
    const rawInput = num(usage.inputTokens);
    const rawOutput = num(usage.outputTokens);
    const cached = num(usage.cachedInputTokens) || num(usage.inputTokenDetails?.cacheReadTokens);
    const reasoning = num(usage.reasoningTokens) || num(usage.outputTokenDetails?.reasoningTokens);
    const freshInput = Math.max(rawInput - cached, 0);
    const nonReasoningOutput = Math.max(rawOutput - reasoning, 0);

    ctx.usageTotals.input += freshInput;
    ctx.usageTotals.output += nonReasoningOutput;
    ctx.usageTotals.cached += cached;
    ctx.usageTotals.reasoning += reasoning;

    // The current context size is the prompt size for this turn = inputTokens
    // (which already counts cached tokens). Falls back to totalTokens when the
    // provider omits inputTokens.
    const contextSize = rawInput > 0 ? rawInput : num(usage.totalTokens);
    if (contextSize > 0)
    {
        ctx.lastContextSize = contextSize;
        if (ctx.peakContextSize === null || contextSize > ctx.peakContextSize)
        {
            ctx.peakContextSize = contextSize;
        }
    }

    if (ctx.lastAssistant && !ctx.lastAssistant.stats && (rawInput > 0 || rawOutput > 0))
    {
        ctx.lastAssistant.stats = {
            inputTokens: freshInput,
            outputTokens: nonReasoningOutput,
            cachedInputTokens: cached,
            reasoningTokens: reasoning,
            contextSize: contextSize > 0 ? contextSize : null,
        };
    }
}

/** Build the aggregate {@link SessionStats} for a BotBandit session. */
function buildBotBanditStats(ctx: ParseContext): SessionStats | undefined
{
    const t = ctx.usageTotals;
    if (t.input === 0 && t.output === 0 && t.cached === 0 && t.reasoning === 0
        && ctx.peakContextSize === null && ctx.lastContextSize === null)
    {
        return undefined;
    }
    return {
        totalInputTokens: t.input,
        totalOutputTokens: t.output,
        cachedInputTokens: t.cached,
        reasoningTokens: t.reasoning,
        // BotBandit does not report the model's context-window limit on disk.
        contextWindow: null,
        finalContextSize: ctx.lastContextSize,
        peakContextSize: ctx.peakContextSize,
    };
}


export const botbanditAdapter: Adapter = {
    agent: "botbandit",
    defaultRoot: () => "~/.botbandit/sessions",
    discover(root: string): string[]
    {
        let entries: string[];
        try
        {
            entries = readdirSync(root);
        }
        catch
        {
            return [];
        }

        const files: string[] = [];
        for (const entry of entries)
        {
            const file = join(root, entry);
            try
            {
                if (statSync(file).isFile() && entry.endsWith(".jsonl"))
                {
                    files.push(file);
                }
            }
            catch
            {
                continue;
            }
        }
        return files.sort();
    },
    parse: parseBotBandit,
};
