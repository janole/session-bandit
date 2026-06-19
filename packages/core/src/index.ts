import { homedir } from "node:os";
import type { Adapter } from "./adapter.js";
import type { Session } from "./types.js";

export type { Adapter } from "./adapter.js";
export type {
  AgentName,
  Session,
  Message,
  ToolCall,
} from "./types.js";
export { claudeAdapter } from "./adapters/claude.js";
export { codexAdapter } from "./adapters/codex.js";
export { readJsonl } from "./jsonl.js";
export { decodeCwd } from "./adapters/claude.js";

/**
 * Expand a leading `~` to the user's home directory. Leaves other paths
 * unchanged. (Adapters' `defaultRoot()` may return `~`-prefixed paths so they
 * stay portable and testable without touching a real home dir.)
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/** An adapter paired with the root to scan (defaults to the adapter's). */
export interface AdapterConfig {
  adapter: Adapter;
  /** Root directory to scan. Defaults to `adapter.defaultRoot()`. */
  root?: string;
}

/**
 * Build an in-memory index of sessions by running each adapter against its
 * root directory. Files are parsed in order; adapter parse failures must not
 * throw (per the Adapter contract) so one bad file never aborts the whole scan.
 *
 * Sessions are returned grouped by adapter in config order, unsorted. Sorting
 * is the caller's responsibility (the CLI sorts by `startedAt` desc).
 */
export function indexSessions(configs: AdapterConfig[]): Session[] {
  const sessions: Session[] = [];
  for (const { adapter, root } of configs) {
    const actualRoot = expandHome(root ?? adapter.defaultRoot());
    const files = adapter.discover(actualRoot);
    for (const file of files) {
      sessions.push(adapter.parse(file));
    }
  }
  return sessions;
}