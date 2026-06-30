/**
 * Session digest — a compact, high-signal, LLM-ingestible summary of one
 * session, computed entirely offline from the normalized {@link Session} model.
 *
 * The digest splits cleanly into two kinds of content:
 *  - **Statistics** (substance score/tier, file counts, tool counts) — useful
 *    with zero LLM; drives `list --sort importance` and triage.
 *  - **Textual excerpt** (the goal, the final state, failing outputs) — the
 *    synthesis fuel the consuming agent's LLM writes a handoff / memory from.
 *
 * Session Bandit never calls an LLM. See `docs/extract.md`.
 */

import type { AgentName, Message, RelatedSessionReference, Session, ToolCall } from "./types.js";

// ---- types -----------------------------------------------------------------

export type ImportanceTier =
  | "trivial"
  | "light"
  | "moderate"
  | "substantive"
  | "heavy";

export interface SubstanceSignals {
    messageCount: number;
    toolCallCount: number;
    filesWritten: number;
    filesRead: number;
    errorCount: number; // includes user-rejected tool uses (caveat in extract.md)
    ranTests: boolean;
    endedCleanly: boolean; // an assistant turn follows the last user turn
    idle: boolean; // high wall-clock duration, low activity
}

export interface Substance {
    score: number;
    tier: ImportanceTier;
    signals: SubstanceSignals;
}

export interface DigestFiles {
    /** Unique local paths created/edited (sorted). */
    written: string[];
    /** Unique local paths read, excluding any that were also written (sorted). */
    read: string[];
}

export interface DigestFailingCommand {
    name: string;
    input: unknown;
    output: string | null;
}

export interface DigestCommands {
    total: number;
    failing: DigestFailingCommand[];
}

export interface DigestTestRun {
    command: string;
    passed: boolean | null;
}

export interface DigestError {
    name: string;
    output: string | null;
}

export interface DigestKeyTurns {
    /** First user message — the task the session set out to do. */
    goal: string | null;
    /** Last few non-empty assistant text turns — the outcome / current state. */
    finalState: string[];
}

export interface DigestToolUsage {
    name: string;
    count: number;
}

/** A runtime-generated summary captured from the transcript (not a user/assistant turn). */
export interface DigestSummary {
    /** Semantic kind: recap, compaction, memory, provenance marker, etc. */
    subtype: string;
    /** The summary text (a recap's content, or a compaction's derived note). */
    text: string;
    timestamp: string | null;
    relatedSessions?: RelatedSessionReference[];
}

export interface SessionDigest {
    // identity
    agent: AgentName;
    sessionId: string;
    filePath: string;
    project: string | null;
    cwd: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMin: number | null;

    // substance / importance (offline-computed)
    substance: Substance;

    // what was touched (de-noised, local files only)
    files: DigestFiles;

    // commands + outcomes
    commands: DigestCommands;

    // test runs (best-effort detection)
    tests: DigestTestRun[];

    // failed tool runs (the "what went wrong" signals)
    errors: DigestError[];

    // key turns (de-noised excerpt for synthesis)
    keyTurns: DigestKeyTurns;

    // tool usage breakdown (sorted by count desc)
    tools: DigestToolUsage[];

    // runtime-generated summaries and provenance markers, chronological
    summaries: DigestSummary[];

    /** Present only when computed with `full: true` — the complete transcript. */
    transcript?: Message[];
}

// ---- tunable constants -----------------------------------------------------

/** Tier thresholds on the substance score: <3 trivial, 3–25 light, etc. */
const TIER_THRESHOLDS = [3, 25, 100, 400] as const;

/** Max chars kept from any single key turn (keeps the compact digest compact). */
const MAX_TURN_CHARS = 4000;

/** Max entries kept in the errors / failing-commands lists. */
const MAX_ERROR_ENTRIES = 20;

/** Max recaps/summaries kept in the digest (a long session can have many recaps). */
const MAX_SUMMARIES = 50;

/** A session is "idle" if it ran longer than this (minutes) with little action. */
const IDLE_MINUTES = 120;
const IDLE_MAX_CALLS = 10;

export const TIER_ORDER: ImportanceTier[] = [
    "trivial",
    "light",
    "moderate",
    "substantive",
    "heavy",
];

export function tierRank(tier: ImportanceTier): number 
{
    return TIER_ORDER.indexOf(tier);
}

// ---- tool-name classification (per agent) ----------------------------------

const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CLAUDE_READ_TOOLS = new Set(["Read"]);
const CODEX_WRITE_TOOLS = new Set(["apply_patch"]);
/** Shell-like tools whose `input` may carry a command string. */
const SHELL_TOOL_NAMES = new Set([
    "Bash",
    "exec_command",
    "shell_command",
    "shell",
    "run_command",
]);

// ---- input shape helpers ---------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> 
{
    return v !== null && typeof v === "object";
}

function asStringArray(arr: unknown): string[] | null 
{
    if (!Array.isArray(arr)) {return null;}
    return arr.every((x) => typeof x === "string") ? (arr as string[]) : null;
}

/** Pull a `file_path`-style string field out of a tool input object. */
function extractFilePathField(input: unknown): string | null 
{
    if (!isRecord(input)) {return null;}
    const fp = input["file_path"];
    if (typeof fp === "string") {return fp;}
    return null;
}

/** Parse a Codex `apply_patch` patch string for Update/Add/Delete File markers. */
export function extractCodexPatchFiles(patch: unknown): string[] 
{
    if (typeof patch !== "string") {return [];}
    const re = /\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
    const out: string[] = [];
    for (const m of patch.matchAll(re)) 
    {
        const p = m[1]?.trim();
        if (p) {out.push(p);}
    }
    return out;
}

/**
 * Extract a command string from a shell tool's input, across provider shapes:
 *  - Claude `Bash`: `input.command` is a string.
 *  - Codex `shell`/`exec_command`: `input.command` is `["bash","-lc","<cmd>"]`
 *    (take the last string element).
 *  - Codex `local_shell_call` → "shell": `input.action.command` (array or string).
 * Returns null for non-command inputs (e.g. an apply_patch patch string).
 */
export function extractCommandString(input: unknown): string | null 
{
    if (typeof input === "string") {return null;} // patch text, not a command
    if (!isRecord(input)) {return null;}

    const direct = pickCommand(input["command"]);
    if (direct) {return direct;}

    const action = input["action"];
    if (isRecord(action)) 
    {
        const nested = pickCommand(action["command"]);
        if (nested) {return nested;}
    }
    return null;
}

function pickCommand(cmd: unknown): string | null 
{
    if (typeof cmd === "string") {return cmd;}
    const arr = asStringArray(cmd);
    if (arr && arr.length > 0) {return arr[arr.length - 1]!;}
    return null;
}

// ---- file extraction -------------------------------------------------------

function extractFiles(session: Session): DigestFiles 
{
    const written = new Set<string>();
    const read = new Set<string>();
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            if (session.agent === "claude") 
            {
                if (CLAUDE_WRITE_TOOLS.has(tc.name)) 
                {
                    const p = extractFilePathField(tc.input);
                    if (p) {written.add(p);}
                }
                else if (CLAUDE_READ_TOOLS.has(tc.name)) 
                {
                    const p = extractFilePathField(tc.input);
                    if (p) {read.add(p);}
                }
            }
            else if (session.agent === "codex") 
            {
                if (CODEX_WRITE_TOOLS.has(tc.name)) 
                {
                    for (const p of extractCodexPatchFiles(tc.input)) {written.add(p);}
                }
            }
            // gemini / unknown agents: no file extraction yet
        }
    }
    // reads exclude anything that was also written
    for (const w of written) {read.delete(w);}
    return {
        written: [...written].sort(),
        read: [...read].sort(),
    };
}

// ---- test-run detection (best-effort) --------------------------------------

const TEST_RUNNER_RE =
    /\b(npm test|pnpm\s+(-r\s+)?test|yarn test|vitest|pytest|cargo test|go test|jest|maven test|mvn test|gradle test|rake test|dotnet test)\b/;

function inferTestPassed(tc: ToolCall, agent: AgentName): boolean | null 
{
    if (!tc.output) {return null;}
    if (agent === "codex") 
    {
    // Codex tool output is a JSON string with metadata.exit_code — ground truth.
        try 
        {
            const parsed = JSON.parse(tc.output) as { metadata?: { exit_code?: unknown } };
            const ec = parsed?.metadata?.exit_code;
            if (typeof ec === "number") {return ec === 0;}
        }
        catch 
        {
            // not JSON — fall through to text heuristic
        }
    }
    const txt = tc.output;
    // Conservative text heuristic (Claude has no structured exit code).
    if (/(?:^|\s)(FAIL\b|✗|✘|\b\d+\s+failing\b|tests?\s+failed|ERR_|panic|Traceback)/i.test(txt)) 
    {
        return false;
    }
    if (/(?:✓|✔|\b\d+\s+passing\b|tests?\s+passed|Test Suite:.*passed)/i.test(txt)) 
    {
        return true;
    }
    return null;
}

function extractTests(session: Session): DigestTestRun[] 
{
    const tests: DigestTestRun[] = [];
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            if (!SHELL_TOOL_NAMES.has(tc.name)) {continue;}
            const cmd = extractCommandString(tc.input);
            if (cmd && TEST_RUNNER_RE.test(cmd)) 
            {
                tests.push({ command: cmd, passed: inferTestPassed(tc, session.agent) });
            }
        }
    }
    return tests;
}

// ---- commands / errors / tools --------------------------------------------

function extractCommands(session: Session): DigestCommands 
{
    let total = 0;
    const failing: DigestFailingCommand[] = [];
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            if (!SHELL_TOOL_NAMES.has(tc.name)) {continue;}
            total++;
            // The adapter already overrides status → "error" on non-zero exit codes
            // (output-overrides-status), so status captures failed-by-exit-code too.
            if (tc.status === "error") 
            {
                failing.push({ name: tc.name, input: tc.input, output: tc.output });
            }
        }
    }
    return { total, failing: failing.slice(0, MAX_ERROR_ENTRIES) };
}

function extractErrors(session: Session): DigestError[] 
{
    const errors: DigestError[] = [];
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            if (tc.status === "error") 
            {
                errors.push({ name: tc.name, output: tc.output });
            }
        }
    }
    return errors.slice(0, MAX_ERROR_ENTRIES);
}

function toolUsage(session: Session): DigestToolUsage[] 
{
    const counts = new Map<string, number>();
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

// ---- summaries (recaps / compactions) ---------------------------------------

/**
 * Extract runtime-generated summaries (Claude recaps, Codex compactions) from
 * the normalized messages, in chronological order. These are `role: "summary"`
 * messages emitted by the adapters; the rest of the transcript is unaffected.
 */
function extractSummaries(session: Session): DigestSummary[] 
{
    const out: DigestSummary[] = [];
    for (const m of session.messages) 
    {
        if (m.role === "summary" && m.subtype) 
        {
            out.push({
                subtype: m.subtype,
                text: truncate(m.text),
                timestamp: m.timestamp,
                relatedSessions: m.metadata?.relatedSessions,
            });
        }
    }
    return out.slice(0, MAX_SUMMARIES);
}

// ---- key turns -------------------------------------------------------------

function truncate(s: string): string 
{
    if (s.length <= MAX_TURN_CHARS) {return s;}
    return s.slice(0, MAX_TURN_CHARS) + " …[truncated]";
}

function extractKeyTurns(session: Session): DigestKeyTurns 
{
    let goal: string | null = null;
    for (const m of session.messages) 
    {
        if (m.role === "user" && m.text.trim()) 
        {
            goal = truncate(m.text);
            break;
        }
    }
    const finalState: string[] = [];
    const N = 3;
    for (let i = session.messages.length - 1; i >= 0 && finalState.length < N; i--) 
    {
        const m = session.messages[i]!;
        if (m.role === "assistant" && m.text.trim()) 
        {
            finalState.unshift(truncate(m.text));
        }
    }
    return { goal, finalState };
}

// ---- substance / importance ------------------------------------------------

function durationMin(session: Session): number | null 
{
    if (!session.endedAt || !session.startedAt) {return null;}
    const start = Date.parse(session.startedAt);
    const end = Date.parse(session.endedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) {return null;}
    return (end - start) / 60000;
}

/** True if an assistant turn follows the last user turn (session wasn't interrupted mid-response). */
function computeEndedCleanly(messages: Message[]): boolean 
{
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) 
    {
        if (messages[i]!.role === "user") 
        {
            lastUserIdx = i;
            break;
        }
    }
    if (lastUserIdx === -1) {return messages.some((m) => m.role === "assistant");}
    return messages.slice(lastUserIdx + 1).some((m) => m.role === "assistant");
}

export function tierForScore(score: number): ImportanceTier 
{
    if (score < TIER_THRESHOLDS[0]) {return "trivial";}
    if (score < TIER_THRESHOLDS[1]) {return "light";}
    if (score < TIER_THRESHOLDS[2]) {return "moderate";}
    if (score < TIER_THRESHOLDS[3]) {return "substantive";}
    return "heavy";
}

interface SubstanceCounts {
    messageCount: number;
    toolCallCount: number;
    filesWritten: number;
    filesRead: number;
    errorCount: number;
    ranTests: boolean;
    endedCleanly: boolean;
    durationMin: number | null;
}

function substanceFromCounts(c: SubstanceCounts): Substance 
{
    const idle = c.durationMin !== null && c.durationMin > IDLE_MINUTES && c.toolCallCount < IDLE_MAX_CALLS;
    const score =
        c.toolCallCount +
    3 * c.filesWritten +
    1 * c.filesRead +
    (c.ranTests ? 5 : 0) -
    (c.endedCleanly ? 0 : 2);
    return {
        score,
        tier: tierForScore(score),
        signals: {
            messageCount: c.messageCount,
            toolCallCount: c.toolCallCount,
            filesWritten: c.filesWritten,
            filesRead: c.filesRead,
            errorCount: c.errorCount,
            ranTests: c.ranTests,
            endedCleanly: c.endedCleanly,
            idle,
        },
    };
}

/**
 * Lean substance computation for a single session — used by `list` for
 * sorting/filtering without building the full digest (no file lists, key
 * turns, or error arrays). One pass over messages.
 */
export function computeSubstance(session: Session): Substance 
{
    let toolCallCount = 0;
    let errorCount = 0;
    let ranTests = false;
    const written = new Set<string>();
    const read = new Set<string>();
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            toolCallCount++;
            if (tc.status === "error") {errorCount++;}
            if (session.agent === "claude") 
            {
                if (CLAUDE_WRITE_TOOLS.has(tc.name)) 
                {
                    const p = extractFilePathField(tc.input);
                    if (p) {written.add(p);}
                }
                else if (CLAUDE_READ_TOOLS.has(tc.name)) 
                {
                    const p = extractFilePathField(tc.input);
                    if (p) {read.add(p);}
                }
            }
            else if (session.agent === "codex") 
            {
                if (CODEX_WRITE_TOOLS.has(tc.name)) 
                {
                    for (const p of extractCodexPatchFiles(tc.input)) {written.add(p);}
                }
            }
            if (!ranTests && SHELL_TOOL_NAMES.has(tc.name)) 
            {
                const cmd = extractCommandString(tc.input);
                if (cmd && TEST_RUNNER_RE.test(cmd)) {ranTests = true;}
            }
        }
    }
    for (const w of written) {read.delete(w);}
    return substanceFromCounts({
        messageCount: session.messageCount,
        toolCallCount,
        filesWritten: written.size,
        filesRead: read.size,
        errorCount,
        ranTests,
        endedCleanly: computeEndedCleanly(session.messages),
        durationMin: durationMin(session),
    });
}

/**
 * Compute the full digest for a session. With `full: true`, includes the
 * complete de-noised transcript (`transcript`).
 */
export function computeDigest(
    session: Session,
    opts: { full?: boolean } = {},
): SessionDigest 
{
    const files = extractFiles(session);
    const tests = extractTests(session);
    const dur = durationMin(session);
    const endedCleanly = computeEndedCleanly(session.messages);

    let toolCallCount = 0;
    let errorCount = 0;
    for (const msg of session.messages) 
    {
        for (const tc of msg.toolCalls) 
        {
            toolCallCount++;
            if (tc.status === "error") {errorCount++;}
        }
    }

    const substance = substanceFromCounts({
        messageCount: session.messageCount,
        toolCallCount,
        filesWritten: files.written.length,
        filesRead: files.read.length,
        errorCount,
        ranTests: tests.length > 0,
        endedCleanly,
        durationMin: dur,
    });

    const digest: SessionDigest = {
        agent: session.agent,
        sessionId: session.sessionId,
        filePath: session.filePath,
        project: session.project,
        cwd: session.cwd,
        model: session.model,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMin: dur,
        substance,
        files,
        commands: extractCommands(session),
        tests,
        errors: extractErrors(session),
        keyTurns: extractKeyTurns(session),
        tools: toolUsage(session),
        summaries: extractSummaries(session),
    };
    if (opts.full) {digest.transcript = session.messages;}
    return digest;
}
