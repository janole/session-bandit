import type { AgentName, Session } from "./types.js";

/**
 * A provider adapter maps one agent's on-disk session format into the
 * normalized {@link Session} model.
 *
 * Adapters **must not throw** on an unrecognized line — they skip it and
 * continue. A session with zero parseable messages is still returned (with
 * `messageCount: 0`), so the index is always complete.
 */
export interface Adapter {
    readonly agent: AgentName;

    /**
   * Default root directory for this agent's sessions
   * (e.g. `~/.claude/projects`). Callers may override this.
   */
    defaultRoot(): string;

    /**
   * Discover session files under a root directory. Returns absolute or
   * root-relative file paths.
   */
    discover(root: string): string[];

    /**
   * Parse one session file into the normalized model. Must not throw on
   * unrecognized content — return a Session with `messageCount: 0` instead.
   */
    parse(filePath: string): Session;
}
