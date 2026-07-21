import type { Message, MessageStats, RedactionReport, Session, SessionStats, ToolCall } from "@session-bandit/core";
import { type AgentDoctorReport, type BotBanditDoctorDetails, type ClaudeDoctorDetails, type ClaudeGlobalStats, type CodexDoctorDetails, computeSubstance, type DoctorReport, type ImportanceTier, type SessionDigest } from "@session-bandit/core";

/** A compact session summary for `list` output. */
export interface SessionSummary
{
    agent: string;
    sessionId: string;
    project: string | null;
    cwd: string | null;
    startedAt: string;
    endedAt: string | null;
    model: string | null;
    messageCount: number;
    substance: { score: number; tier: ImportanceTier };
}

/** Build a summary object from a session (drops the heavy messages array). */
export function summarize(s: Session): SessionSummary 
{
    const sub = computeSubstance(s);
    return {
        agent: s.agent,
        sessionId: s.sessionId,
        project: s.project,
        cwd: s.cwd,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        model: s.model,
        messageCount: s.messageCount,
        substance: { score: sub.score, tier: sub.tier },
    };
}

// ---- list output ------------------------------------------------------------

/** Print sessions as JSON lines (one summary object per line). */
export function printListJson(sessions: Session[]): void 
{
    for (const s of sessions) 
    {
        console.log(JSON.stringify(summarize(s)));
    }
}

/** Print sessions as a human-readable table. */
export function printListPretty(sessions: Session[]): void 
{
    if (sessions.length === 0) 
    {
        console.log("No sessions found.");
        return;
    }

    const rows = sessions.map((s) => 
    {
        const sub = computeSubstance(s);
        return {
            agent: s.agent,
            sessionId: s.sessionId.slice(0, 12),
            startedAt: s.startedAt ? s.startedAt.slice(0, 19) : "(unknown)",
            msgs: String(s.messageCount),
            tier: sub.tier,
            model: s.model ?? "-",
            project: s.project ?? "-",
        };
    });

    // Column widths
    const cols: (keyof typeof rows[number])[] = [
        "agent",
        "sessionId",
        "startedAt",
        "msgs",
        "tier",
        "model",
        "project",
    ];
    const widths: Record<string, number> = {};
    for (const c of cols) 
    {
        widths[c] = Math.max(c.length, ...rows.map((r) => r[c].length));
    }

    // Header
    const header = cols
        .map((c) => c.padEnd(widths[c]!))
        .join("  ");
    console.log(header);
    console.log("-".repeat(header.length));

    // Rows
    for (const r of rows) 
    {
        console.log(cols.map((c) => r[c].padEnd(widths[c]!)).join("  "));
    }
    console.log(`\n${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
}

// ---- show output ------------------------------------------------------------

/** Print the full normalized transcript of a session. */
export function printTranscript(session: Session): void 
{
    console.log(
        `Session: ${session.sessionId}`,
    );
    console.log(`Agent:   ${session.agent}`);
    if (session.project) { console.log(`Project: ${session.project}`); }
    if (session.cwd) { console.log(`Cwd:     ${session.cwd}`); }
    if (session.model) { console.log(`Model:   ${session.model}`); }
    console.log(`Started: ${session.startedAt || "(unknown)"}`);
    if (session.endedAt) { console.log(`Ended:   ${session.endedAt}`); }
    console.log(`Messages: ${session.messageCount}`);
    console.log("");

    printMessages(session.messages);
}

function printMessages(messages: Message[]): void 
{
    for (let i = 0; i < messages.length; i++) 
    {
        const msg = messages[i]!;
        printMessage(i + 1, msg);
    }
}

function printMessage(index: number, msg: Message): void 
{
    const ts = msg.timestamp ? `  [${msg.timestamp}]` : "";
    const label = roleLabel(msg.role);
    console.log(`--- #${index} ${label}${ts} ---`);

    if (msg.text) 
    {
        console.log(indent(msg.text, "  "));
    }

    for (const tc of msg.toolCalls) 
    {
        printToolCall(tc);
    }
}

function roleLabel(role: string): string 
{
    switch (role) 
    {
        case "user":
            return "USER";
        case "assistant":
            return "ASSISTANT";
        case "system":
            return "SYSTEM";
        case "tool":
            return "TOOL";
        case "summary":
            return "SUMMARY";
        default:
            return role.toUpperCase();
    }
}

function printToolCall(tc: ToolCall): void 
{
    const statusIcon =
        tc.status === "ok" ? "✓" : tc.status === "error" ? "✗" : "?";
    console.log(`  ${statusIcon} ${tc.name}`);
    if (tc.input) 
    {
        const inputStr =
            typeof tc.input === "string"
                ? tc.input
                : JSON.stringify(tc.input).slice(0, 200);
        console.log(`    input: ${inputStr}`);
    }
    if (tc.output) 
    {
        const outputStr = tc.output.slice(0, 300);
        console.log(`    output: ${outputStr}`);
    }
}

// ---- search output ----------------------------------------------------------

export interface SearchHit
{
    agent: string;
    sessionId: string;
    messageIndex: number;
    role: string;
    text: string;
    timestamp: string | null;
}

/** Print search hits as JSON lines. */
export function printSearchJson(hits: SearchHit[]): void 
{
    for (const h of hits) 
    {
        console.log(JSON.stringify(h));
    }
}

/** Print search hits in a human-readable format. */
export function printSearchPretty(hits: SearchHit[]): void 
{
    if (hits.length === 0) 
    {
        console.log("No matches found.");
        return;
    }
    for (const h of hits) 
    {
        console.log(
            `[${h.agent}] ${h.sessionId.slice(0, 12)}  #${h.messageIndex}  ${h.role}`,
        );
        console.log(`  ${truncate(h.text, 120)}`);
        console.log("");
    }
    console.log(`${hits.length} match${hits.length === 1 ? "" : "es"}`);
}

// ---- extract / digest output ----------------------------------------------

/** Print a session digest as JSON. */
export function printDigestJson(digest: SessionDigest): void 
{
    console.log(JSON.stringify(digest));
}

/** Print a session digest in a human-readable layout. */
export function printDigestPretty(d: SessionDigest): void 
{
    console.log(`Session:  ${d.sessionId}`);
    console.log(`Agent:    ${d.agent}`);
    if (d.project) { console.log(`Project:  ${d.project}`); }
    if (d.model) { console.log(`Model:    ${d.model}`); }
    console.log(`Started:  ${d.startedAt || "(unknown)"}`);
    if (d.durationMin !== null) 
    {
        console.log(`Duration: ${Math.round(d.durationMin)} min`);
    }
    console.log("");

    const sig = d.substance.signals;
    console.log(
        `Substance: ${d.substance.tier} (score ${d.substance.score})`,
    );
    console.log(
        `  ${sig.toolCallCount} tool calls · ${sig.filesWritten} files written · ${sig.filesRead} read · ${sig.errorCount} errors · tests: ${sig.ranTests} · ended cleanly: ${sig.endedCleanly}${sig.idle ? " · IDLE" : ""}`,
    );
    console.log("");

    if (d.files.written.length > 0) 
    {
        console.log(`Files written (${d.files.written.length}):`);
        for (const f of d.files.written) { console.log(`  ${f}`); }
        console.log("");
    }

    if (d.files.read.length > 0) 
    {
        console.log(`Files read (${d.files.read.length}):`);
        for (const f of d.files.read.slice(0, 20)) { console.log(`  ${f}`); }
        if (d.files.read.length > 20) { console.log(`  … and ${d.files.read.length - 20} more`); }
        console.log("");
    }

    if (d.tests.length > 0) 
    {
        console.log("Test runs:");
        for (const t of d.tests) 
        {
            const verdict = t.passed === null ? "unknown" : t.passed ? "PASS" : "FAIL";
            console.log(`  [${verdict}] ${t.command}`);
        }
        console.log("");
    }

    if (d.errors.length > 0) 
    {
        console.log(`Errors (${d.errors.length}):`);
        for (const e of d.errors.slice(0, 10)) 
        {
            console.log(`  ✗ ${e.name}${e.output ? ": " + truncate(e.output, 100) : ""}`);
        }
        console.log("");
    }

    if (d.tools.length > 0) 
    {
        console.log("Tools:");
        for (const t of d.tools.slice(0, 10)) 
        {
            console.log(`  ${String(t.count).padStart(5)}  ${t.name}`);
        }
        console.log("");
    }

    if (d.summaries.length > 0) 
    {
        console.log(`Summaries (${d.summaries.length}):`);
        for (const s of d.summaries) 
        {
            const ts = s.timestamp ? ` [${s.timestamp}]` : "";
            console.log(`  (${s.subtype})${ts}`);
            console.log(indent(truncate(s.text, 600), "    "));
        }
        console.log("");
    }

    if (d.keyTurns.goal) 
    {
        console.log("Goal:");
        console.log(indent(truncate(d.keyTurns.goal, 600), "  "));
        console.log("");
    }

    if (d.keyTurns.finalState.length > 0) 
    {
        console.log("Final state:");
        for (const t of d.keyTurns.finalState) 
        {
            console.log(indent(truncate(t, 600), "  "));
        }
        console.log("");
    }

    if (d.transcript) 
    {
        console.log(`Transcript (${d.transcript.length} messages):`);
        console.log("");
        printMessages(d.transcript);
    }
}

/** Prompt templates for `extract --prompt`. First-draft; refine against real LLM output. */
const PROMPT_TEMPLATES: Record<string, (d: SessionDigest) => string> = {
    handoff: (d) => `You are continuing work from a previous coding agent session. Below is a structured digest of that session. Write a concise handoff note for the next agent covering: the goal, what was done, the current state, and what is left to do.

Session:  ${d.sessionId} (${d.agent})
Project:  ${d.project ?? "-"}
Model:    ${d.model ?? "-"}
Started:  ${d.startedAt}
Duration: ${d.durationMin !== null ? Math.round(d.durationMin) + " min" : "-"}

Substance: ${d.substance.tier} (score ${d.substance.score})
  ${d.substance.signals.toolCallCount} tool calls, ${d.substance.signals.filesWritten} files written, ${d.substance.signals.errorCount} errors, ran tests: ${d.substance.signals.ranTests}, ended cleanly: ${d.substance.signals.endedCleanly}

Files written:
${d.files.written.map((f) => "  - " + f).join("\n") || "  (none)"}

Errors:
${d.errors.map((e) => "  - " + e.name + (e.output ? ": " + truncate(e.output, 160) : "")).join("\n") || "  (none)"}

Agent summaries and provenance notes (recaps, memories, compactions, wrapped sessions):
${d.summaries.map((s) => "  - [" + s.subtype + "] " + truncate(s.text, 400)).join("\n") || "  (none)"}

Goal:
${d.keyTurns.goal ?? "(none)"}

Final state:
${d.keyTurns.finalState.map((t) => "  - " + truncate(t, 400)).join("\n") || "  (none)"}

— full structured digest (JSON) —
${JSON.stringify(d, null, 2)}
`,

    memory: (d) => `You are creating a memory note from a coding agent session. Below is a structured digest. Write a short note (2–4 sentences) capturing: what the session was about, the key outcome, and any files or decisions worth remembering. End with a suggested importance tier (one of: trivial, light, moderate, substantive, heavy).

Session:  ${d.sessionId} (${d.agent}, ${d.project ?? "-"})
Substance: ${d.substance.tier} (score ${d.substance.score}) — ${d.substance.signals.toolCallCount} tool calls, ${d.substance.signals.filesWritten} files written

Files written:
${d.files.written.map((f) => "  - " + f).join("\n") || "  (none)"}

Agent summaries and provenance notes:
${d.summaries.map((s) => "  - [" + s.subtype + "] " + truncate(s.text, 400)).join("\n") || "  (none)"}

Goal:
${d.keyTurns.goal ?? "(none)"}

Final state:
${d.keyTurns.finalState.map((t) => "  - " + truncate(t, 400)).join("\n") || "  (none)"}

— full structured digest (JSON) —
${JSON.stringify(d, null, 2)}
`,
};

/** Render a digest as a ready-to-send synthesis prompt. */
export function renderDigestPrompt(
    d: SessionDigest,
    kind: "handoff" | "memory",
): string 
{
    const tmpl = PROMPT_TEMPLATES[kind];
    if (!tmpl) 
    {
        throw new Error(`Unknown prompt kind: "${kind}". Valid: handoff, memory`);
    }
    return tmpl(d);
}

/** Print a digest wrapped in a synthesis prompt. */
export function printDigestPrompt(
    d: SessionDigest,
    kind: "handoff" | "memory",
): void 
{
    console.log(renderDigestPrompt(d, kind));
}

// ---- redaction output -------------------------------------------------------

/** Print a redaction report as JSON. */
export function printRedactionReportJson(report: RedactionReport): void
{
    console.log(JSON.stringify(report));
}

/** Print a redaction report in a human-readable layout. */
export function printRedactionReportPretty(session: Session, report: RedactionReport): void
{
    console.log(`Session: ${session.sessionId}`);
    console.log(`Agent:   ${session.agent}`);
    console.log(`Mode:    ${report.mode}`);
    console.log("");

    console.log("Findings:");
    for (const [kind, count] of Object.entries(report.counts))
    {
        console.log(`  ${kind}: ${count}`);
    }

    if (report.findings.length > 0)
    {
        console.log("");
        console.log("Sample findings:");
        for (const finding of report.findings.slice(0, 20))
        {
            console.log(`  ${finding.kind}  ${finding.path}  -> ${finding.replacement}`);
        }
        if (report.findings.length > 20)
        {
            console.log(`  ... and ${report.findings.length - 20} more`);
        }
    }
}

/** Parse and validate a `--min-importance` tier argument. Returns null if not a tier. */
export function parseTier(arg: string): ImportanceTier | null 
{
    const tiers: ImportanceTier[] = [
        "trivial",
        "light",
        "moderate",
        "substantive",
        "heavy",
    ];
    return tiers.includes(arg as ImportanceTier) ? (arg as ImportanceTier) : null;
}

// ---- utils ------------------------------------------------------------------

/** Print a doctor report as JSON. */
export function printDoctorJson(report: DoctorReport): void 
{
    console.log(JSON.stringify(report));
}

/** Print a doctor report in a human-readable layout. */
export function printDoctorPretty(report: DoctorReport): void 
{
    console.log("Session Bandit Doctor — parsing health check");
    console.log("=".repeat(50));
    console.log("");
    console.log(
        `Total: ${report.totals.files} files · ${report.totals.sessions} sessions · ${report.totals.emptySessions} empty · ${report.totals.skippedCompressed} compressed (skipped)`,
    );
    console.log("");

    for (const agent of report.agents) 
    {
        printAgentReport(agent);
    }
}

function printAgentReport(a: AgentDoctorReport): void 
{
    console.log(`── ${a.agent} ──────────────────────────────`);
    console.log(`  Root:        ${a.root}`);
    console.log(`  Files:       ${a.files}`);
    console.log(`  Sessions:    ${a.sessions}`);
    console.log(`  Empty:       ${a.emptySessions}${a.emptySessions > 0 ? " ⚠" : ""}`);
    if (a.skippedCompressed > 0) 
    {
        console.log(`  Compressed:  ${a.skippedCompressed} .jsonl.zst (not supported, skipped)`);
    }

    if (a.details && a.agent === "codex") 
    {
        const d = a.details as CodexDoctorDetails;
        console.log("");
        console.log("  Format distribution:");
        console.log(`    legacy .json:      ${d.formatDistribution.legacyJson}`);
        console.log(`    flat .jsonl:       ${d.formatDistribution.flatJsonl}`);
        console.log(`    envelope .jsonl:   ${d.formatDistribution.envelopeJsonl}`);
        if (d.formatDistribution.unrecognized > 0) 
        {
            console.log(`    unrecognized:      ${d.formatDistribution.unrecognized} ⚠`);
        }

        console.log("");
        console.log("  First user-message markers (injection detection):");
        const m = d.firstUserMarkers;
        console.log(`    # AGENTS.md instructions for  ${m.agentsMd}`);
        console.log(`    <environment_context>         ${m.envContext}`);
        console.log(`    <user_action>                 ${m.userAction}`);
        console.log(`    plain task (no marker)         ${m.plainTask}${m.plainTask > 0 ? " ⚠" : ""}`);
        console.log(`    ───────────────────────────── ${m.total} total`);

        const envTypes = Object.entries(d.unrecognizedEnvelopeTypes);
        if (envTypes.length > 0) 
        {
            console.log("");
            console.log("  ⚠ Unrecognized envelope types:");
            for (const [type, count] of envTypes) 
            {
                console.log(`    ${count}× ${type}`);
            }
        }

        const itemTypes = Object.entries(d.unrecognizedItemTypes);
        if (itemTypes.length > 0) 
        {
            console.log("");
            console.log("  ⚠ Unrecognized item types:");
            for (const [type, count] of itemTypes) 
            {
                console.log(`    ${count}× ${type}`);
            }
        }
    }

    if (a.details && a.agent === "claude") 
    {
        const d = a.details as ClaudeDoctorDetails;
        if (d.unmatchedToolResults > 0) 
        {
            console.log("");
            console.log(`  ⚠ Unmatched tool results (no matching tool_use id): ${d.unmatchedToolResults}`);
        }
    }

    if (a.details && a.agent === "botbandit")
    {
        const d = a.details as BotBanditDoctorDetails;
        const schemaVersions = Object.entries(d.schemaVersions);
        if (schemaVersions.length > 0)
        {
            console.log("");
            console.log("  Schema versions:");
            for (const [version, count] of schemaVersions)
            {
                console.log(`    ${version}: ${count}`);
            }
        }

        const eventTypes = Object.entries(d.unrecognizedEventTypes);
        if (eventTypes.length > 0)
        {
            console.log("");
            console.log("  ⚠ Unrecognized event types:");
            for (const [type, count] of eventTypes)
            {
                console.log(`    ${count}× ${type}`);
            }
        }
    }

    console.log("");
}

// ---- utils ------------------------------------------------------------------

function indent(text: string, prefix: string): string 
{
    return text
        .split("\n")
        .map((line) => prefix + line)
        .join("\n");
}

function truncate(text: string, max: number): string 
{
    if (text.length <= max) { return text; }
    return text.slice(0, max - 1) + "…";
}

// ---- stats output -----------------------------------------------------------

/** A compact per-session stats object for JSON output. */
export interface SessionStatsView
{
    agent: string;
    sessionId: string;
    project: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    messageCount: number;
    stats: SessionStats | null;
    perTurn: { turn: number; role: string; stats: MessageStats }[];
}

/** Build a JSON-friendly stats view from a session (token totals + per-turn usage). */
export function buildSessionStatsView(session: Session): SessionStatsView
{
    const perTurn: { turn: number; role: string; stats: MessageStats }[] = [];
    let turn = 0;
    for (const msg of session.messages)
    {
        if (msg.stats)
        {
            turn += 1;
            perTurn.push({ turn, role: msg.role, stats: msg.stats });
        }
    }
    return {
        agent: session.agent,
        sessionId: session.sessionId,
        project: session.project,
        model: session.model,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        messageCount: session.messageCount,
        stats: session.stats ?? null,
        perTurn,
    };
}

/** Print per-session stats as JSON. */
export function printSessionStatsJson(session: Session): void
{
    console.log(JSON.stringify(buildSessionStatsView(session)));
}

/** Print per-session stats in a human-readable layout. */
export function printSessionStatsPretty(session: Session): void
{
    console.log(`Session:  ${session.sessionId}`);
    console.log(`Agent:    ${session.agent}`);
    if (session.project) { console.log(`Project:  ${session.project}`); }
    if (session.model) { console.log(`Model:    ${session.model}`); }
    console.log(`Started:  ${session.startedAt || "(unknown)"}`);
    console.log(`Messages: ${session.messageCount}`);
    console.log("");

    const s = session.stats;
    if (!s)
    {
        console.log("No token usage recorded for this session.");
        return;
    }

    console.log("Tokens");
    console.log(`  input          ${fmt(s.totalInputTokens)}    (cached: ${fmt(s.cachedInputTokens)})`);
    console.log(`  output         ${fmt(s.totalOutputTokens)}    (reasoning: ${fmt(s.reasoningTokens)})`);
    // Reasoning is split out of totalOutputTokens by every adapter, so it has to be
    // added back here — otherwise the total silently omits it. For Codex this makes
    // the sum equal its own `total_tokens` (input_tokens + output_tokens).
    const totalTokens = s.totalInputTokens + s.cachedInputTokens + s.totalOutputTokens + s.reasoningTokens;
    console.log(`  total          ${fmt(totalTokens)}`);
    console.log("");

    if (s.contextWindow !== null || s.finalContextSize !== null || s.peakContextSize !== null)
    {
        console.log("Context window");
        if (s.contextWindow !== null) { console.log(`  limit      ${fmt(s.contextWindow)}`); }
        if (s.peakContextSize !== null)
        {
            const pct = s.contextWindow ? pctOf(s.peakContextSize, s.contextWindow) : null;
            console.log(`  peak       ${fmt(s.peakContextSize)}${pct !== null ? `   (${pct}%)` : ""}`);
        }
        if (s.finalContextSize !== null)
        {
            const pct = s.contextWindow ? pctOf(s.finalContextSize, s.contextWindow) : null;
            console.log(`  final      ${fmt(s.finalContextSize)}${pct !== null ? `   (${pct}%)` : ""}`);
        }
        console.log("");
    }

    const view = buildSessionStatsView(session);
    if (view.perTurn.length > 0)
    {
        console.log("Per turn");
        for (const t of view.perTurn)
        {
            const ctx = t.stats.contextSize !== null ? fmt(t.stats.contextSize) : "-";
            const pct = t.stats.contextSize !== null && s.contextWindow
                ? `   (${pctOf(t.stats.contextSize, s.contextWindow)}%)`
                : "";
            console.log(`  #${String(t.turn).padStart(2)}   in ${fmt(t.stats.inputTokens)}  out ${fmt(t.stats.outputTokens)}   ctx ${ctx}${pct}`);
        }
    }
}

/** Format a token count with thousands separators. */
function fmt(n: number): string
{
    return n.toLocaleString("en-US");
}

/** Compute an integer percentage of `part` of `whole`, or null if whole is 0. */
function pctOf(part: number, whole: number): number | null
{
    if (whole <= 0) { return null; }
    return Math.round((part / whole) * 100);
}

/** Print Claude global stats as JSON. */
export function printGlobalStatsJson(global: ClaudeGlobalStats, sessionTotals: GlobalSessionTotals): void
{
    console.log(JSON.stringify({ global, sessionTotals }));
}

/** Aggregate token totals summed across per-session stats (non-Claude agents). */
export interface GlobalSessionTotals
{
    sessions: number;
    withStats: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
}

/** Sum per-session stats across a list of sessions (for the global view). */
export function sumSessionTotals(sessions: Session[]): GlobalSessionTotals
{
    const totals: GlobalSessionTotals = {
        sessions: sessions.length,
        withStats: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
    };
    for (const s of sessions)
    {
        if (!s.stats) { continue; }
        totals.withStats += 1;
        totals.totalInputTokens += s.stats.totalInputTokens;
        totals.totalOutputTokens += s.stats.totalOutputTokens;
        totals.cachedInputTokens += s.stats.cachedInputTokens;
        totals.reasoningTokens += s.stats.reasoningTokens;
    }
    return totals;
}

/** Print Claude global stats in a human-readable layout. */
export function printGlobalStatsPretty(global: ClaudeGlobalStats, sessionTotals: GlobalSessionTotals): void
{
    console.log(`All-time (since ${global.firstSessionDate || "(unknown)"})`);
    console.log(`  sessions      ${fmt(global.totalSessions)}`);
    console.log(`  messages      ${fmt(global.totalMessages)}`);
    if (global.longestSession.sessionId)
    {
        const mins = Math.round(global.longestSession.duration / 60_000);
        console.log(`  longest       ${fmt(global.longestSession.messageCount)} msgs (${mins} min)  ${global.longestSession.sessionId}`);
    }
    console.log("");

    const models = Object.entries(global.modelUsage).sort(
        (a, b) => (b[1].outputTokens + b[1].cacheReadInputTokens) - (a[1].outputTokens + a[1].cacheReadInputTokens),
    );
    if (models.length > 0)
    {
        console.log("Tokens by model (Claude aggregate)");
        for (const [model, u] of models)
        {
            console.log(`  ${model}`);
            console.log(`    in ${fmt(u.inputTokens)}   out ${fmt(u.outputTokens)}   cache-read ${fmt(u.cacheReadInputTokens)}   cache-create ${fmt(u.cacheCreationInputTokens)}`);
        }
        console.log("");
    }

    if (sessionTotals.withStats > 0)
    {
        console.log(`Per-session totals (summed from transcripts, ${sessionTotals.withStats} sessions with stats)`);
        console.log(`  input          ${fmt(sessionTotals.totalInputTokens)}    (cached: ${fmt(sessionTotals.cachedInputTokens)})`);
        console.log(`  output         ${fmt(sessionTotals.totalOutputTokens)}    (reasoning: ${fmt(sessionTotals.reasoningTokens)})`);
        console.log("");
    }

    const hours = Object.entries(global.hourCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    if (hours.length > 0)
    {
        console.log("Busiest hours (messages)");
        for (const [hour, count] of hours)
        {
            console.log(`  ${hour.padStart(2, "0")}:00  ${fmt(count)}`);
        }
    }
}
