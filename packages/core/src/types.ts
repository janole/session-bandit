/**
 * Normalized session model — the common shape every provider adapter maps its
 * raw session format into. This is the single most important contract in the
 * project: it is the seam between "core" and "per-provider adapter", and it is
 * what keeps adapters swappable.
 *
 * See docs/prd.md.
 */

export type AgentName = "claude" | "codex" | "gemini" | "botbandit";

/** Related source session referenced by a normalized message or published bundle. */
export interface RelatedSessionReference {
    agent: AgentName;
    kind: string;
    sessionId: string;
    title?: string;
    turnId?: string;
    path?: string;
}

/** Optional machine-readable annotations that complement message text. */
export interface MessageMetadata {
    relatedSessions?: RelatedSessionReference[];
}

export interface Session {
    agent: AgentName;
    sessionId: string;
    /** Source JSONL file, for debugging / "show". */
    filePath: string;
    /** Best-effort project/cwd label, or null. */
    project: string | null;
    /** Working dir if recoverable from the session, else null. */
    cwd: string | null;
    /** ISO 8601. */
    startedAt: string;
    /** ISO 8601, or null if unknown. */
    endedAt: string | null;
    /** Primary model if recoverable, else null. */
    model: string | null;
    messageCount: number;
    messages: Message[];
    /** Aggregate token/context-window stats for the session, if the source carries any. */
    stats?: SessionStats;
}

export type MessageRole = "user" | "assistant" | "system" | "tool" | "summary";

export interface Message {
    role: MessageRole;
    /** Human-readable text content (concatenated for assistant). Always a string. */
    text: string;
    /** Tool invocations attached to this message, if any. */
    toolCalls: ToolCall[];
    /** ISO 8601 if present in source, else null. */
    timestamp: string | null;
    /**
     * Semantic kind for non-turn roles. For `role: "summary"`, this traces
     * back where the summary comes from:
     *  - `"recap"`      — Claude `away_summary` (a while-you-were-away recap)
     *  - `"compaction"` — Codex `compacted` envelope (context-window compaction)
     *  - `"memory"`     — BotBandit generated session memory
     *  - `"wrapped_codex"` — BotBandit transcript backed by an original Codex session
     * The provider is already on {@link Session.agent}, so the subtype is the
     * semantic kind, not the raw provider string.
     */
    subtype?: string;
    /** Machine-readable annotations used by downstream consumers such as publishing. */
    metadata?: MessageMetadata;
    /** Per-turn token usage for this message, when the source records it (Claude `usage`, Codex `last_token_usage`, BotBandit `turn_end.usage`). */
    stats?: MessageStats;
}

export interface ToolCall {
    /** e.g. "bash", "write_file", "local_shell_call". */
    name: string;
    /** Raw tool input, provider-specific shape. */
    input: unknown;
    status: "ok" | "error" | "unknown";
    /** Truncated/summarized output, or null. */
    output: string | null;
}

/** Per-turn token usage attached to a normalized message. */
export interface MessageStats {
    /** Fresh input tokens for this turn (excludes cache reads/creation). */
    inputTokens: number;
    /** Output tokens generated this turn. */
    outputTokens: number;
    /** Cached input tokens (read + creation) — the cheap tokens. */
    cachedInputTokens: number;
    /** Reasoning/thinking output tokens, if the provider separates them. */
    reasoningTokens: number;
    /** Context size at this turn (Codex `total_tokens`; derived prompt size elsewhere). */
    contextSize: number | null;
}

/** Aggregate token/context-window stats for a session, when the source carries any. */
export interface SessionStats {
    /** Total fresh input tokens across the session. */
    totalInputTokens: number;
    /** Total output tokens (excludes reasoning where the provider separates it). */
    totalOutputTokens: number;
    /** Total cached input tokens (read + creation). */
    cachedInputTokens: number;
    /** Total reasoning/thinking output tokens, if the provider separates them. */
    reasoningTokens: number;
    /** Context-window limit for the model, if known (Codex reports it). */
    contextWindow: number | null;
    /** Final context size at the end of the session, if known. */
    finalContextSize: number | null;
    /** Peak context size observed during the session, if known. */
    peakContextSize: number | null;
}
