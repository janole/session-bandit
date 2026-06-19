import type { Session, Message, ToolCall } from "@session-bandit/core";

/** A compact session summary for `list` output. */
export interface SessionSummary {
  agent: string;
  sessionId: string;
  project: string | null;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  messageCount: number;
}

/** Build a summary object from a session (drops the heavy messages array). */
export function summarize(s: Session): SessionSummary {
  return {
    agent: s.agent,
    sessionId: s.sessionId,
    project: s.project,
    cwd: s.cwd,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    model: s.model,
    messageCount: s.messageCount,
  };
}

// ---- list output ------------------------------------------------------------

/** Print sessions as JSON lines (one summary object per line). */
export function printListJson(sessions: Session[]): void {
  for (const s of sessions) {
    console.log(JSON.stringify(summarize(s)));
  }
}

/** Print sessions as a human-readable table. */
export function printListPretty(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const rows = sessions.map((s) => ({
    agent: s.agent,
    sessionId: s.sessionId.slice(0, 12),
    startedAt: s.startedAt ? s.startedAt.slice(0, 19) : "(unknown)",
    msgs: String(s.messageCount),
    model: s.model ?? "-",
    project: s.project ?? "-",
  }));

  // Column widths
  const cols: (keyof typeof rows[number])[] = [
    "agent",
    "sessionId",
    "startedAt",
    "msgs",
    "model",
    "project",
  ];
  const widths: Record<string, number> = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => r[c].length));
  }

  // Header
  const header = cols
    .map((c) => c.padEnd(widths[c]!))
    .join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  // Rows
  for (const r of rows) {
    console.log(cols.map((c) => r[c].padEnd(widths[c]!)).join("  "));
  }
  console.log(`\n${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
}

// ---- show output ------------------------------------------------------------

/** Print the full normalized transcript of a session. */
export function printTranscript(session: Session): void {
  console.log(
    `Session: ${session.sessionId}`,
  );
  console.log(`Agent:   ${session.agent}`);
  if (session.project) console.log(`Project: ${session.project}`);
  if (session.cwd) console.log(`Cwd:     ${session.cwd}`);
  if (session.model) console.log(`Model:   ${session.model}`);
  console.log(`Started: ${session.startedAt || "(unknown)"}`);
  if (session.endedAt) console.log(`Ended:   ${session.endedAt}`);
  console.log(`Messages: ${session.messageCount}`);
  console.log("");

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]!;
    printMessage(i + 1, msg);
  }
}

function printMessage(index: number, msg: Message): void {
  const ts = msg.timestamp ? `  [${msg.timestamp}]` : "";
  const label = roleLabel(msg.role);
  console.log(`--- #${index} ${label}${ts} ---`);

  if (msg.text) {
    console.log(indent(msg.text, "  "));
  }

  for (const tc of msg.toolCalls) {
    printToolCall(tc);
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "USER";
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    case "tool":
      return "TOOL";
    default:
      return role.toUpperCase();
  }
}

function printToolCall(tc: ToolCall): void {
  const statusIcon =
    tc.status === "ok" ? "✓" : tc.status === "error" ? "✗" : "?";
  console.log(`  ${statusIcon} ${tc.name}`);
  if (tc.input) {
    const inputStr =
      typeof tc.input === "string"
        ? tc.input
        : JSON.stringify(tc.input).slice(0, 200);
    console.log(`    input: ${inputStr}`);
  }
  if (tc.output) {
    const outputStr = tc.output.slice(0, 300);
    console.log(`    output: ${outputStr}`);
  }
}

// ---- search output ----------------------------------------------------------

export interface SearchHit {
  agent: string;
  sessionId: string;
  messageIndex: number;
  role: string;
  text: string;
  timestamp: string | null;
}

/** Print search hits as JSON lines. */
export function printSearchJson(hits: SearchHit[]): void {
  for (const h of hits) {
    console.log(JSON.stringify(h));
  }
}

/** Print search hits in a human-readable format. */
export function printSearchPretty(hits: SearchHit[]): void {
  if (hits.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const h of hits) {
    console.log(
      `[${h.agent}] ${h.sessionId.slice(0, 12)}  #${h.messageIndex}  ${h.role}`,
    );
    console.log(`  ${truncate(h.text, 120)}`);
    console.log("");
  }
  console.log(`${hits.length} match${hits.length === 1 ? "" : "es"}`);
}

// ---- utils ------------------------------------------------------------------

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}