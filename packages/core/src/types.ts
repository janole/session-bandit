/**
 * Normalized session model — the common shape every provider adapter maps its
 * raw session format into. This is the single most important contract in the
 * project: it is the seam between "core" and "per-provider adapter", and it is
 * what keeps adapters swappable.
 *
 * See docs/prd.md.
 */

export type AgentName = "claude" | "codex" | "gemini" | "botbandit";

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
