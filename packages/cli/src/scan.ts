import {
  indexSessions,
  claudeAdapter,
  codexAdapter,
  computeSubstance,
  tierRank,
  type AdapterConfig,
  type Session,
  type AgentName,
  type ImportanceTier,
} from "@session-bandit/core";

/** All adapters v1 knows about, in display order. */
const ADAPTERS: AdapterConfig[] = [
  { adapter: claudeAdapter },
  { adapter: codexAdapter },
];

/** A function that returns a session index. */
export type ScanFn = () => Session[];

/**
 * Build a fresh in-memory index of all known sessions. v1 always scans fresh
 * — no persistence, no incremental updates.
 */
export function scanAll(): Session[] {
  return indexSessions(ADAPTERS);
}

/** Filter sessions by agent and/or project (substring match on project/cwd). */
export function filterSessions(
  sessions: Session[],
  opts: { agent?: string; project?: string },
): Session[] {
  let result = sessions;
  if (opts.agent) {
    result = result.filter((s) => s.agent === opts.agent);
  }
  if (opts.project) {
    const q = opts.project.toLowerCase();
    result = result.filter(
      (s) =>
        (s.project?.toLowerCase().includes(q) ?? false) ||
        (s.cwd?.toLowerCase().includes(q) ?? false),
    );
  }
  return result;
}

/** Sort sessions by startedAt descending (most recent first). */
export function sortByRecent(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) =>
    (b.startedAt || "").localeCompare(a.startedAt || ""),
  );
}

/** Sort sessions by substance score descending (most substantial first). */
export function sortByImportance(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (a, b) => computeSubstance(b).score - computeSubstance(a).score,
  );
}

/** Keep only sessions whose substance tier is at least `min`. */
export function filterByMinImportance(
  sessions: Session[],
  min: ImportanceTier,
): Session[] {
  const minRank = tierRank(min);
  return sessions.filter((s) => tierRank(computeSubstance(s).tier) >= minRank);
}

/** Validate that a string is a known agent name. */
export function isValidAgent(name: string): name is AgentName {
  return name === "claude" || name === "codex" || name === "gemini";
}