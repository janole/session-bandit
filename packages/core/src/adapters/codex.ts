import { readdirSync, readFileSync,statSync } from "node:fs";
import { basename } from "node:path";

import type { Adapter } from "../adapter.js";
import { num } from "../num.js";
import type { Message, Session, SessionStats, ToolCall } from "../types.js";

/**
 * Codex stores sessions under `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
 *
 * Three on-disk formats coexist across versions:
 *
 *  **A — Legacy `.json`** (single JSON object, 2025-04 era):
 *    `{ session: { id, timestamp, instructions }, items: [...] }`
 *    Items have `type` = `message` | `reasoning` | `function_call` |
 *    `function_call_output` | `local_shell_call`.
 *
 *  **B — Flat `.jsonl`** (2025-07 era, no envelope):
 *    Line 0 is bare metadata `{ id, timestamp, instructions }`; subsequent lines
 *    are bare items with the same shapes as format-A `items`.
 *
 *  **C — Modern `.jsonl`** (2025-12+, current):
 *    Every line is an envelope `{ timestamp, type, payload }` where `type` is
 *    `session_meta` | `response_item` | `event_msg` | `turn_context` |
 *    `compacted`. The actual content lives in `payload`:
 *      - `session_meta.payload` → `{ id, timestamp, cwd, originator, ... }`
 *      - `response_item.payload` → `message` | `reasoning` | `function_call` |
 *        `function_call_output` | `custom_tool_call` |
 *        `custom_tool_call_output` | `web_search_call`
 *      - `turn_context.payload` → `{ turn_id, cwd, model, ... }`
 *      - `event_msg.payload` → UI events (task lifecycle, token counts) — skipped
 *
 * All three formats share the same item *shapes* (only the wrapping differs):
 *  - `message`: `{ role, content: [{ type: "input_text"|"output_text", text }] }`
 *  - `function_call`: `{ name, namespace?, arguments (JSON string), call_id, status? }`
 *  - `local_shell_call`: `{ call_id, status, action: { type, command, ... } }`
 *  - `custom_tool_call`: `{ call_id, status, name, input }`
 *  - `web_search_call`: `{ status, action: { type, query, queries } }`
 *  - `function_call_output` / `custom_tool_call_output`: `{ call_id, output }`
 *
 * `reasoning` items (thinking) are skipped from `Message.text`, matching the
 * Claude adapter's treatment of `thinking` blocks.
 *
 * Layout: `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (modern) + legacy flat
 * `rollout-*.jsonl` / `rollout-*.json` at the sessions root.
 */

// ---- line shapes -----------------------------------------------------------

interface ContentBlock {
    type: string;
    text?: string;
}

interface Item {
    type?: string;
    role?: string;
    content?: ContentBlock[];
    name?: string;
    namespace?: string;
    arguments?: string;
    call_id?: string;
    status?: string;
    action?: unknown;
    input?: unknown;
    output?: string;
    id?: string;
}

interface Envelope {
    timestamp?: string;
    type?: string;
    payload?: Item | Record<string, unknown>;
}

interface SessionMeta {
    id?: string;
    timestamp?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    source?: string;
    model_provider?: string;
    instructions?: string | null;
}

/** A Codex `event_msg` `token_count` payload: running session totals + last-turn delta. */
interface TokenCountInfo {
    total_token_usage?: TokenUsage;
    last_token_usage?: TokenUsage;
    model_context_window?: number;
}

/** Codex token-usage shape (input / cached / output / reasoning / total). */
interface TokenUsage {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
}

/** A Codex `event_msg` payload (only `token_count` is consumed; others skipped). */
interface EventMsgPayload {
    type?: string;
    info?: TokenCountInfo | null;
}

interface LegacyJson {
    session?: { id?: string; timestamp?: string; instructions?: string | null };
    items?: Item[];
}

// ---- helpers ---------------------------------------------------------------

/** Extract text from a message's content blocks (input_text / output_text). */
function messageText(content: ContentBlock[] | undefined): string 
{
    if (!Array.isArray(content)) {return "";}
    return content
        .filter(
            (b) =>
                (b.type === "input_text" || b.type === "output_text") &&
        typeof b.text === "string",
        )
        .map((b) => b.text as string)
        .join("\n");
}

/**
 * Markers for Codex-injected `user`-role messages — machine-generated blocks
 * that wear a `user` label but are not real user input:
 *  - `# AGENTS.md instructions for <path>` — the project's AGENTS.md content,
 *    wrapped in `<INSTRUCTIONS>` tags
 *  - `<environment_context>` — cwd, shell, date, timezone, filesystem info
 *  - `<user_action>` — UI-generated actions (e.g. review-task selections)
 *
 * These are always the first user-role message(s) in a session, injected by
 * the Codex runtime before the real task. A human would never type these
 * angle-bracket XML tags or the fixed `# AGENTS.md instructions for` header.
 *
 * Exported so the `doctor` command can verify detection rates on real logs.
 */
export const CODEX_INJECTED_MARKERS = [
    "# AGENTS.md instructions for",
    "<environment_context>",
    "<user_action>",
] as const;

/**
 * Detect whether a user-role message is a Codex-injected instruction/context
 * block (not a real user task). Checks if any content block starts with one of
 * the known injection markers. Skipped from the normalized model, consistent
 * with developer/system skips.
 */
function isInjectedUserMessage(content: ContentBlock[] | undefined): boolean 
{
    if (!Array.isArray(content)) {return false;}
    return content.some((b) => 
    {
        const text = (b.text ?? "").trimStart();
        return CODEX_INJECTED_MARKERS.some((marker) => text.startsWith(marker));
    });
}

/** Build a full tool name from a function_call's namespace + name. */
function fullToolName(name: string | undefined, namespace: string | undefined): string 
{
    if (namespace && name) {return `${namespace}${name}`;}
    return name ?? "unknown";
}

/** Parse a function_call's `arguments` (a JSON string) into an object. */
function parseArguments(args: string | undefined): unknown 
{
    if (!args) {return null;}
    try 
    {
        return JSON.parse(args);
    }
    catch 
    {
        return args;
    }
}

/** Map a Codex status string to our status enum. */
function mapStatus(status: string | undefined): "ok" | "error" | "unknown" 
{
    if (status === "completed" || status === "succeeded") {return "ok";}
    if (status === "failed" || status === "error") {return "error";}
    return "unknown";
}

// ---- core item processor ---------------------------------------------------

interface ParseContext {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    cwd: string | null;
    model: string | null;
    messages: Message[];
    /** call_id → the ToolCall to attach output to. */
    callIndex: Map<string, ToolCall>;
    /** Running session token totals from the most recent `token_count` event. */
    totalUsage: TokenUsage | null;
    /** Context-window limit reported by Codex (from `token_count.info.model_context_window`). */
    contextWindow: number | null;
    /** Peak context size observed across `token_count` events. */
    peakContextSize: number | null;
    /** Last context size observed (becomes `finalContextSize`). */
    lastContextSize: number | null;
    /** Most recent assistant message, to attach per-turn `last_token_usage` to. */
    lastAssistant: Message | null;
}

/** Process one normalized item (from any format) into messages/tool calls. */
function processItem(item: Item, ts: string | null, ctx: ParseContext): void 
{
    const type = item.type;

    if (type === "message") 
    {
        const role = item.role;
        if (role === "user") 
        {
            // Skip injected AGENTS.md / environment_context / user_action blocks.
            // These wear a `user` role label but are machine-generated instructions,
            // not real user input. Without this, the digest's `keyTurns.goal` would
            // pick up the AGENTS.md instructions instead of the actual task.
            if (isInjectedUserMessage(item.content)) {return;}
            ctx.messages.push({
                role: "user",
                text: messageText(item.content),
                toolCalls: [],
                timestamp: ts,
            });
        }
        else if (role === "assistant") 
        {
            ctx.messages.push({
                role: "assistant",
                text: messageText(item.content),
                toolCalls: [],
                timestamp: ts,
            });
            ctx.lastAssistant = ctx.messages[ctx.messages.length - 1] ?? null;
        }
        // developer / system messages are instructions/permissions — skipped
        return;
    }

    if (type === "reasoning") 
    {
    // thinking blocks — skipped from text (consistent with Claude adapter)
        return;
    }

    // Tool calls → each becomes an assistant message with one ToolCall
    if (
        type === "function_call" ||
    type === "custom_tool_call" ||
    type === "local_shell_call" ||
    type === "web_search_call"
    ) 
    {
        const call_id = item.call_id;
        const tc: ToolCall = {
            name:
        type === "local_shell_call"
            ? "shell"
            : type === "web_search_call"
                ? "web_search"
                : fullToolName(item.name, item.namespace),
            input:
        type === "local_shell_call" || type === "web_search_call"
            ? (item.action ?? null)
            : type === "custom_tool_call"
                ? (item.input ?? null)
                : parseArguments(item.arguments),
            status: mapStatus(item.status),
            output: null,
        };
        if (call_id) {ctx.callIndex.set(call_id, tc);}
        const msg: Message = {
            role: "assistant",
            text: "",
            toolCalls: [tc],
            timestamp: ts,
        };
        ctx.messages.push(msg);
        ctx.lastAssistant = msg;
        return;
    }

    // Tool outputs → matched to the tool call by call_id
    if (type === "function_call_output" || type === "custom_tool_call_output") 
    {
        const call_id = item.call_id;
        if (call_id) 
        {
            const tc = ctx.callIndex.get(call_id);
            if (tc) 
            {
                tc.output = item.output ?? null;
                // The output is the ground truth for status. A `completed` tool call
                // can still produce a non-zero exit code, so always infer from output
                // when an exit_code is present; otherwise keep the item's status.
                const inferred = inferStatusFromOutput(item.output);
                if (inferred !== "unknown") 
                {
                    tc.status = inferred;
                }
            }
        }
        return;
    }

    // unrecognized item type — skip (never throw)
}

/** Best-effort status inference from a Codex tool output string. */
function inferStatusFromOutput(output: string | undefined): "ok" | "error" | "unknown" 
{
    if (!output) {return "unknown";}
    try 
    {
        const parsed = JSON.parse(output);
        const exitCode = parsed?.metadata?.exit_code;
        if (typeof exitCode === "number") 
        {
            return exitCode === 0 ? "ok" : "error";
        }
    }
    catch 
    {
    // not JSON — treat as ok (the output exists)
    }
    return "ok";
}

// ---- format detection + parsing --------------------------------------------

/**
 * Parse a Codex session file. Handles all three formats (legacy .json, flat
 * .jsonl, modern envelope .jsonl). Never throws.
 */
function parseCodex(filePath: string): Session 
{
    const fileName = basename(filePath);

    // Read raw text once (needed for .json detection and .jsonl line parsing).
    let raw: string;
    try 
    {
        raw = readFileSync(filePath, "utf8");
    }
    catch 
    {
        return emptySession(filePath, fileName);
    }

    // Detect format A (legacy .json): the file is a single JSON object.
    // We check the extension first, then validate by parsing.
    if (fileName.endsWith(".json")) 
    {
        return parseLegacyJson(raw, filePath, fileName);
    }

    // Formats B and C are both .jsonl — parse line by line.
    return parseJsonl(raw, filePath, fileName);
}

/** Parse a legacy .json file (format A). */
function parseLegacyJson(
    raw: string,
    filePath: string,
    fileName: string,
): Session 
{
    let doc: LegacyJson;
    try 
    {
        doc = JSON.parse(raw) as LegacyJson;
    }
    catch 
    {
        return emptySession(filePath, fileName);
    }

    const session = doc.session ?? {};
    const ctx: ParseContext = {
        sessionId: session.id ?? stripExt(fileName),
        startedAt: session.timestamp ?? "",
        endedAt: session.timestamp ?? null,
        cwd: null,
        model: null,
        messages: [],
        callIndex: new Map(),
        totalUsage: null,
        contextWindow: null,
        peakContextSize: null,
        lastContextSize: null,
        lastAssistant: null,
    };

    for (const item of doc.items ?? []) 
    {
        if (!item || typeof item !== "object") {continue;}
        processItem(item, null, ctx);
    }

    return buildSession(filePath, ctx);
}

/** Parse a .jsonl file (format B flat or format C envelope). */
function parseJsonl(raw: string, filePath: string, fileName: string): Session 
{
    const lines = parseLines(raw);
    if (lines.length === 0) {return emptySession(filePath, fileName);}

    const ctx: ParseContext = {
        sessionId: stripExt(fileName),
        startedAt: "",
        endedAt: null,
        cwd: null,
        model: null,
        messages: [],
        callIndex: new Map(),
        totalUsage: null,
        contextWindow: null,
        peakContextSize: null,
        lastContextSize: null,
        lastAssistant: null,
    };

    for (const line of lines) 
    {
        if (!line || typeof line !== "object") {continue;}

        // Format C: envelope with { timestamp, type, payload }
        if (isEnvelope(line)) 
        {
            processEnvelope(line as Envelope, ctx);
            continue;
        }

        // Format B: bare items. The first line may be metadata { id, timestamp,
        // instructions } (no `type` field); subsequent lines are typed items.
        if (isBareMetadata(line)) 
        {
            const meta = line as SessionMeta;
            if (meta.id) {ctx.sessionId = meta.id;}
            if (meta.timestamp) 
            {
                ctx.startedAt = meta.timestamp;
                ctx.endedAt = meta.timestamp;
            }
            continue;
        }

        // Otherwise it's a bare typed item.
        processItem(line as Item, null, ctx);
    }

    return buildSession(filePath, ctx);
}

/** Process a modern envelope line (format C). */
function processEnvelope(env: Envelope, ctx: ParseContext): void 
{
    const ts = env.timestamp ?? null;

    if (env.timestamp) 
    {
        if (!ctx.startedAt) {ctx.startedAt = env.timestamp;}
        ctx.endedAt = env.timestamp;
    }

    const type = env.type;
    const payload = env.payload;

    if (type === "session_meta" && payload && typeof payload === "object") 
    {
        const meta = payload as SessionMeta;
        if (meta.id) {ctx.sessionId = meta.id;}
        if (meta.timestamp) 
        {
            if (!ctx.startedAt) {ctx.startedAt = meta.timestamp;}
            // session_meta.timestamp is the session start; don't let it override
            // endedAt which should track the last event.
        }
        if (meta.cwd) {ctx.cwd = meta.cwd;}
        return;
    }

    if (type === "turn_context" && payload && typeof payload === "object") 
    {
        const tc = payload as { model?: string; cwd?: string };
        if (tc.model && !ctx.model) {ctx.model = tc.model;}
        if (tc.cwd && !ctx.cwd) {ctx.cwd = tc.cwd;}
        return;
    }

    if (type === "response_item" && payload && typeof payload === "object") 
    {
        processItem(payload as Item, ts, ctx);
        return;
    }

    if (type === "compacted" && payload && typeof payload === "object") 
    {
    // A compaction replaces older context with a compacted view. Its payload is
    // { message: "", replacement_history: [<full prior messages>] }. The survey
    // showed the replacement_history is redundant: 99% of those messages already
    // appear as earlier `response_item` lines in the same file (already captured
    // by the adapter as normal turns). So we record only that a compaction
    // happened — a marker — and do not carry the (median 43 KB) payload. The
    // `.message` field is always empty in real data, so the note is derived from
    // the replacement_history length. See docs/format-codex.md.
        const p = payload as { message?: string; replacement_history?: unknown[] };
        const rh = Array.isArray(p.replacement_history) ? p.replacement_history : [];
        const note =
            typeof p.message === "string" && p.message.trim()
                ? p.message
                : `Context compacted: ${rh.length} prior message${rh.length === 1 ? "" : "s"} replaced.`;
        ctx.messages.push({
            role: "summary",
            subtype: "compaction",
            text: note,
            toolCalls: [],
            timestamp: ts,
        });
        return;
    }

    if (type === "event_msg" && payload && typeof payload === "object")
    {
        processEventMsg(payload as EventMsgPayload, ctx);
        return;
    }

    // unknown envelope types — skipped
}

/**
 * Process a Codex `event_msg` payload. Only `token_count` is consumed: it
 * carries running session totals, the last-turn delta, the model's context
 * window, and the current context size. Other event types (`task_started`,
 * `task_complete`, …) are skipped.
 *
 * Codex (OpenAI) token accounting differs from Claude's: `input_tokens`
 * already includes cached tokens (`cached_input_tokens` is the cached subset),
 * and `output_tokens` already includes reasoning (`reasoning_output_tokens`
 * is the reasoning subset). `total_token_usage` is cumulative across the
 * session; `last_token_usage` is the delta for the most recent turn. The
 * current context size at a turn is that turn's prompt size =
 * `last_token_usage.input_tokens` (which already counts cached tokens).
 */
function processEventMsg(payload: EventMsgPayload, ctx: ParseContext): void
{
    if (payload.type !== "token_count") { return; }

    const info = payload.info;
    if (!info || typeof info !== "object") { return; }

    if (typeof info.model_context_window === "number")
    {
        ctx.contextWindow = info.model_context_window;
    }

    const total = info.total_token_usage;
    if (total && typeof total === "object")
    {
        ctx.totalUsage = total;
    }

    // The current context size is the prompt size of the most recent turn.
    // Codex's `last_token_usage.input_tokens` already includes cached tokens,
    // so it is the full prompt size for that turn — not the cumulative total.
    const last = info.last_token_usage;
    if (last && typeof last === "object")
    {
        const turnContextSize = num(last.input_tokens);
        if (turnContextSize > 0)
        {
            ctx.lastContextSize = turnContextSize;
            if (ctx.peakContextSize === null || turnContextSize > ctx.peakContextSize)
            {
                ctx.peakContextSize = turnContextSize;
            }
        }

        // Attach the per-turn delta to the nearest preceding assistant message.
        if (ctx.lastAssistant && !ctx.lastAssistant.stats)
        {
            ctx.lastAssistant.stats = {
                inputTokens: num(last.input_tokens) - num(last.cached_input_tokens),
                outputTokens: num(last.output_tokens) - num(last.reasoning_output_tokens),
                cachedInputTokens: num(last.cached_input_tokens),
                reasoningTokens: num(last.reasoning_output_tokens),
                contextSize: turnContextSize > 0 ? turnContextSize : null,
            };
        }
    }
}


/** Build the aggregate {@link SessionStats} for a Codex session from accumulated token counts. */
function buildCodexStats(ctx: ParseContext): SessionStats | undefined
{
    if (!ctx.totalUsage && ctx.contextWindow === null && ctx.lastContextSize === null)
    {
        return undefined;
    }
    const t = ctx.totalUsage;
    // Codex `input_tokens` includes cached; `output_tokens` includes reasoning.
    // Normalize to the Claude convention: fresh input / non-reasoning output.
    const totalInput = t ? num(t.input_tokens) : 0;
    const cached = t ? num(t.cached_input_tokens) : 0;
    const totalOutput = t ? num(t.output_tokens) : 0;
    const reasoning = t ? num(t.reasoning_output_tokens) : 0;
    return {
        totalInputTokens: Math.max(totalInput - cached, 0),
        totalOutputTokens: Math.max(totalOutput - reasoning, 0),
        cachedInputTokens: cached,
        reasoningTokens: reasoning,
        contextWindow: ctx.contextWindow,
        finalContextSize: ctx.lastContextSize,
        peakContextSize: ctx.peakContextSize,
    };
}

// ---- format helpers --------------------------------------------------------

/** True if a line looks like a modern envelope { timestamp, type, payload }. */
function isEnvelope(line: object): boolean 
{
    const env = line as Envelope;
    return (
        typeof env.type === "string" &&
    typeof env.payload === "object" &&
    env.payload !== null &&
    // session_meta / response_item / event_msg / turn_context / compacted
    (env.type === "session_meta" ||
      env.type === "response_item" ||
      env.type === "event_msg" ||
      env.type === "turn_context" ||
      env.type === "compacted")
    );
}

/** True if a bare line is the metadata header { id, timestamp, instructions }. */
function isBareMetadata(line: object): boolean 
{
    const obj = line as SessionMeta;
    return (
        typeof obj.id === "string" &&
    typeof obj.timestamp === "string" &&
    !("type" in obj)
    );
}

/** Parse JSONL lines from raw text, skipping blank/malformed lines. */
function parseLines(raw: string): unknown[] 
{
    const out: unknown[] = [];
    for (const line of raw.split("\n")) 
    {
        const trimmed = line.trim();
        if (!trimmed) {continue;}
        try 
        {
            out.push(JSON.parse(trimmed));
        }
        catch 
        {
            // skip malformed line
        }
    }
    return out;
}

/** Remove the extension from a filename: `rollout-...-uuid.jsonl` → `rollout-...-uuid`. */
function stripExt(fileName: string): string 
{
    return fileName.replace(/\.(jsonl?|jsonl\.zst)$/, "");
}

/** Build an empty (0-message) Session for error/empty cases. */
function emptySession(filePath: string, fileName: string): Session 
{
    return {
        agent: "codex",
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

/** Build the final Session from a ParseContext. */
function buildSession(filePath: string, ctx: ParseContext): Session 
{
    return {
        agent: "codex",
        sessionId: ctx.sessionId,
        filePath,
        project: ctx.cwd,
        cwd: ctx.cwd,
        startedAt: ctx.startedAt,
        endedAt: ctx.endedAt,
        model: ctx.model,
        messageCount: ctx.messages.length,
        messages: ctx.messages,
        stats: buildCodexStats(ctx),
    };
}

// ---- adapter ---------------------------------------------------------------

function walkSessions(root: string, files: string[]): void 
{
    let entries: string[];
    try 
    {
        entries = readdirSync(root);
    }
    catch 
    {
        return;
    }
    for (const entry of entries) 
    {
        const sub = `${root}/${entry}`;
        let st;
        try 
        {
            st = statSync(sub);
        }
        catch 
        {
            continue;
        }
        if (st.isDirectory()) 
        {
            walkSessions(sub, files);
        }
        else if (st.isFile()) 
        {
            // Accept .jsonl and legacy .json (but not .jsonl.zst — no zstd dep in v1).
            if (
                (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) ||
        (entry.startsWith("rollout-") && entry.endsWith(".json"))
            ) 
            {
                files.push(sub);
            }
        }
    }
}

export const codexAdapter: Adapter = {
    agent: "codex",
    defaultRoot: () => "~/.codex/sessions",
    discover(root: string): string[] 
    {
        const files: string[] = [];
        walkSessions(root, files);
        return files.sort();
    },
    parse: parseCodex,
};
