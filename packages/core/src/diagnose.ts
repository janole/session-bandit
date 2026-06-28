/**
 * Doctor diagnostics — a self-check that validates parsing assumptions against
 * real session files on disk.
 *
 * The adapters follow a "skip-don't-throw" philosophy: unrecognized lines and
 * item types are silently skipped so one bad file never aborts a scan. The
 * `doctor` command turns that silent resilience into observable signal: it
 * scans raw files and reports format distribution, injection-marker match
 * rates, unrecognized item/envelope types, empty sessions, and skipped
 * compressed files.
 *
 * This is an independent diagnostic — it does its own raw file analysis to
 * cross-check the adapter's assumptions. If the adapter has a bug in format
 * detection, the doctor can catch it because it has its own logic.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { BOTBANDIT_KNOWN_EVENT_TYPES,botbanditAdapter } from "./adapters/botbandit.js";
import { claudeAdapter } from "./adapters/claude.js";
import { CODEX_INJECTED_MARKERS,codexAdapter } from "./adapters/codex.js";
import type { AgentName } from "./types.js";

// ---- types -----------------------------------------------------------------

export interface AgentDoctorReport {
    agent: AgentName;
    root: string;
    files: number;
    sessions: number;
    emptySessions: number;
    skippedCompressed: number;
    /** Agent-specific diagnostic details (downcast for display). */
    details?: CodexDoctorDetails | ClaudeDoctorDetails | BotBanditDoctorDetails;
}

export interface DoctorReport {
    agents: AgentDoctorReport[];
    totals: { files: number; sessions: number; emptySessions: number; skippedCompressed: number };
}

export interface CodexDoctorDetails {
    formatDistribution: {
        legacyJson: number;
        flatJsonl: number;
        envelopeJsonl: number;
        unrecognized: number;
    };
    firstUserMarkers: {
        agentsMd: number;
        envContext: number;
        userAction: number;
        plainTask: number;
        total: number;
    };
    unrecognizedEnvelopeTypes: Record<string, number>;
    unrecognizedItemTypes: Record<string, number>;
}

export interface ClaudeDoctorDetails {
    /** Sessions where tool_use blocks have no matching tool_result by id. */
    unmatchedToolResults: number;
}

export interface BotBanditDoctorDetails {
    unrecognizedEventTypes: Record<string, number>;
    schemaVersions: Record<string, number>;
}

// ---- helpers ---------------------------------------------------------------

function expandHome(p: string): string 
{
    if (p === "~") {return homedir();}
    if (p.startsWith("~/")) {return homedir() + p.slice(1);}
    return p;
}

function countCompressedCodex(root: string): number 
{
    let count = 0;
    function walk(dir: string): void 
    {
        let entries: string[];
        try 
        {
            entries = readdirSync(dir);
        }
        catch 
        {
            return;
        }
        for (const entry of entries) 
        {
            const sub = join(dir, entry);
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
                walk(sub);
            }
            else if (st.isFile() && entry.startsWith("rollout-") && entry.endsWith(".jsonl.zst")) 
            {
                count++;
            }
        }
    }
    walk(root);
    return count;
}

// ---- Codex doctor ----------------------------------------------------------

const KNOWN_CODEX_ENVELOPE_TYPES = new Set([
    "session_meta",
    "response_item",
    "event_msg",
    "turn_context",
    "compacted",
]);

const KNOWN_CODEX_ITEM_TYPES = new Set([
    "message",
    "reasoning",
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "web_search_call",
    "function_call_output",
    "custom_tool_call_output",
]);

type FirstUserMarkerTag = "agentsMd" | "envContext" | "userAction" | "plainTask";

function classifyFirstUserMarker(content: Array<{ text?: string }> | undefined): FirstUserMarkerTag 
{
    if (!Array.isArray(content) || content.length === 0) {return "plainTask";}
    const firstText = (content[0]?.text ?? "").trimStart();
    if (firstText.startsWith(CODEX_INJECTED_MARKERS[0]!)) {return "agentsMd";}
    if (firstText.startsWith(CODEX_INJECTED_MARKERS[1]!)) {return "envContext";}
    if (firstText.startsWith(CODEX_INJECTED_MARKERS[2]!)) {return "userAction";}
    return "plainTask";
}

function bumpMarker(markers: CodexDoctorDetails["firstUserMarkers"], tag: FirstUserMarkerTag): void 
{
    switch (tag) 
    {
        case "agentsMd": markers.agentsMd++; break;
        case "envContext": markers.envContext++; break;
        case "userAction": markers.userAction++; break;
        case "plainTask": markers.plainTask++; break;
    }
    markers.total++;
}

function diagnoseCodex(root: string): AgentDoctorReport 
{
    const files = codexAdapter.discover(root);
    const skippedCompressed = countCompressedCodex(root);

    const fmt = { legacyJson: 0, flatJsonl: 0, envelopeJsonl: 0, unrecognized: 0 };
    const markers = { agentsMd: 0, envContext: 0, userAction: 0, plainTask: 0, total: 0 };
    const unrecognizedEnvelopeTypes: Record<string, number> = {};
    const unrecognizedItemTypes: Record<string, number> = {};
    let emptySessions = 0;

    for (const file of files) 
    {
    // Parse via adapter to check for empty sessions.
        const session = codexAdapter.parse(file);
        if (session.messageCount === 0) {emptySessions++;}

        // Raw analysis for format drift checks.
        let raw: string;
        try 
        {
            raw = readFileSync(file, "utf8");
        }
        catch 
        {
            fmt.unrecognized++;
            continue;
        }

        const fileName = basename(file);

        if (fileName.endsWith(".json")) 
        {
            fmt.legacyJson++;
            continue;
        }

        // Parse JSONL lines.
        const lines: unknown[] = [];
        for (const line of raw.split("\n")) 
        {
            const trimmed = line.trim();
            if (!trimmed) {continue;}
            try 
            {
                lines.push(JSON.parse(trimmed));
            }
            catch 
            {
                // skip malformed line
            }
        }

        if (lines.length === 0) 
        {
            fmt.unrecognized++;
            continue;
        }

        const first = lines[0] as Record<string, unknown> | undefined;
        const isEnvelope =
            first !== undefined &&
      typeof first["type"] === "string" &&
      typeof first["payload"] === "object" &&
      first["payload"] !== null;

        if (isEnvelope) 
        {
            fmt.envelopeJsonl++;

            // Scan for envelope types, item types, and first user message.
            let firstUserFound = false;
            for (const line of lines) 
            {
                const obj = line as Record<string, unknown>;
                const envType = obj["type"];
                if (typeof envType === "string" && !KNOWN_CODEX_ENVELOPE_TYPES.has(envType)) 
                {
                    unrecognizedEnvelopeTypes[envType] = (unrecognizedEnvelopeTypes[envType] ?? 0) + 1;
                }

                if (envType === "response_item") 
                {
                    const payload = obj["payload"] as Record<string, unknown> | undefined;
                    if (payload && typeof payload === "object") 
                    {
                        const itemType = payload["type"];
                        if (typeof itemType === "string" && !KNOWN_CODEX_ITEM_TYPES.has(itemType)) 
                        {
                            unrecognizedItemTypes[itemType] = (unrecognizedItemTypes[itemType] ?? 0) + 1;
                        }

                        if (
                            !firstUserFound &&
              payload["role"] === "user" &&
              Array.isArray(payload["content"])
                        ) 
                        {
                            firstUserFound = true;
                            const tag = classifyFirstUserMarker(
                                payload["content"] as Array<{ text?: string }>,
                            );
                            bumpMarker(markers, tag);
                        }
                    }
                }
            }
        }
        else 
        {
            // Flat format (bare metadata header or bare items).
            const isBareMeta =
                first !== undefined &&
        typeof first["id"] === "string" &&
        typeof first["timestamp"] === "string" &&
        !("type" in first);
            if (isBareMeta || (!isEnvelope && lines.length > 0)) 
            {
                fmt.flatJsonl++;
            }
            else 
            {
                fmt.unrecognized++;
            }
        }
    }

    return {
        agent: "codex",
        root,
        files: files.length,
        sessions: files.length,
        emptySessions,
        skippedCompressed,
        details: {
            formatDistribution: fmt,
            firstUserMarkers: markers,
            unrecognizedEnvelopeTypes,
            unrecognizedItemTypes,
        },
    };
}

// ---- Claude doctor ---------------------------------------------------------

function diagnoseClaude(root: string): AgentDoctorReport 
{
    const files = claudeAdapter.discover(root);
    let emptySessions = 0;
    let unmatchedToolResults = 0;

    for (const file of files) 
    {
        const session = claudeAdapter.parse(file);
        if (session.messageCount === 0) 
        {
            emptySessions++;
            continue;
        }
        // Count tool_use blocks without a matching tool_result by id.
        // The Claude adapter already matches them; unmatched ones have output: null
        // and status: "unknown". We count those as a drift signal.
        for (const msg of session.messages) 
        {
            for (const tc of msg.toolCalls) 
            {
                if (tc.output === null && tc.status === "unknown") 
                {
                    unmatchedToolResults++;
                }
            }
        }
    }

    return {
        agent: "claude",
        root,
        files: files.length,
        sessions: files.length,
        emptySessions,
        skippedCompressed: 0,
        details: { unmatchedToolResults },
    };
}

// ---- BotBandit doctor ------------------------------------------------------

function diagnoseBotBandit(root: string): AgentDoctorReport
{
    const files = botbanditAdapter.discover(root);
    let emptySessions = 0;
    const unrecognizedEventTypes: Record<string, number> = {};
    const schemaVersions: Record<string, number> = {};

    for (const file of files)
    {
        const session = botbanditAdapter.parse(file);
        if (session.messageCount === 0) { emptySessions++; }

        let raw: string;
        try
        {
            raw = readFileSync(file, "utf8");
        }
        catch
        {
            continue;
        }

        for (const line of raw.split("\n"))
        {
            const trimmed = line.trim();
            if (!trimmed) { continue; }
            let obj: Record<string, unknown>;
            try
            {
                const parsed = JSON.parse(trimmed) as unknown;
                if (!parsed || typeof parsed !== "object") { continue; }
                obj = parsed as Record<string, unknown>;
            }
            catch
            {
                continue;
            }

            const type = obj["type"];
            if (typeof type === "string" && !BOTBANDIT_KNOWN_EVENT_TYPES.has(type))
            {
                unrecognizedEventTypes[type] = (unrecognizedEventTypes[type] ?? 0) + 1;
            }

            if (type === "session_init")
            {
                const schemaVersion = obj["schemaVersion"];
                const key = typeof schemaVersion === "number" ? String(schemaVersion) : "unknown";
                schemaVersions[key] = (schemaVersions[key] ?? 0) + 1;
            }
        }
    }

    return {
        agent: "botbandit",
        root,
        files: files.length,
        sessions: files.length,
        emptySessions,
        skippedCompressed: 0,
        details: { unrecognizedEventTypes, schemaVersions },
    };
}

// ---- public API ------------------------------------------------------------

/**
 * Run diagnostics for all configured adapters. Scans raw files and reports
 * parsing health: format distribution, injection-marker match rates,
 * unrecognized types, empty sessions, and skipped compressed files.
 */
export function diagnoseAll(
    configs: { adapter: { agent: AgentName; defaultRoot(): string }; root?: string }[],
): DoctorReport 
{
    const agents: AgentDoctorReport[] = [];
    for (const config of configs) 
    {
        const root = expandHome(config.root ?? config.adapter.defaultRoot());
        if (config.adapter.agent === "codex") 
        {
            agents.push(diagnoseCodex(root));
        }
        else if (config.adapter.agent === "claude") 
        {
            agents.push(diagnoseClaude(root));
        }
        else if (config.adapter.agent === "botbandit")
        {
            agents.push(diagnoseBotBandit(root));
        }
        else 
        {
            // Generic fallback for unknown agents.
            agents.push({
                agent: config.adapter.agent,
                root,
                files: 0,
                sessions: 0,
                emptySessions: 0,
                skippedCompressed: 0,
            });
        }
    }

    const totals = {
        files: agents.reduce((s, a) => s + a.files, 0),
        sessions: agents.reduce((s, a) => s + a.sessions, 0),
        emptySessions: agents.reduce((s, a) => s + a.emptySessions, 0),
        skippedCompressed: agents.reduce((s, a) => s + a.skippedCompressed, 0),
    };

    return { agents, totals };
}
