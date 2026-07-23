import { Command } from "commander";

import { printSearchJson, printSearchPretty, type SearchHit } from "../format.js";
import { collectCondensedWrapperIds, filterSessions, inTimeWindow, isValidAgent, parseTimeArg, type ScanFn } from "../scan.js";

export function makeSearchCommand(scanFn: ScanFn): Command 
{
    const cmd = new Command("search");
    cmd
        .description("Full-text search over session messages")
        .argument("<query>", "Case-insensitive search query")
        .option("-a, --agent <name>", "Filter by agent (claude | codex | botbandit)")
        .option("-p, --project <path>", "Filter by project (substring match)")
        .option(
            "--since <date>",
            "Only messages at/after this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option(
            "--until <date>",
            "Only messages at/before this time (absolute date or relative: 7d, 24h, 2w, 3m)",
        )
        .option("--pretty", "Print human-readable results instead of JSON lines")
        .action((query: string, opts: SearchOptions) => 
        {
            if (opts.agent && !isValidAgent(opts.agent)) 
            {
                console.error(
                    `Unknown agent: "${opts.agent}". Valid: claude, codex, botbandit`,
                );
                process.exitCode = 1;
                return;
            }

            const since = opts.since !== undefined ? parseTimeArg(opts.since, undefined, "start") : null;
            if (opts.since !== undefined && !since) 
            {
                console.error(
                    `Invalid --since value: "${opts.since}". Use a date (2026-06-01) or relative (7d, 24h, 2w, 3m).`,
                );
                process.exitCode = 1;
                return;
            }
            const until = opts.until !== undefined ? parseTimeArg(opts.until, undefined, "end") : null;
            if (opts.until !== undefined && !until) 
            {
                console.error(
                    `Invalid --until value: "${opts.until}". Use a date (2026-06-01) or relative (7d, 24h, 2w, 3m).`,
                );
                process.exitCode = 1;
                return;
            }
            const timeWindow = { since, until };

            let sessions = scanFn(query);
            // Resolve condensed wrappers against the unfiltered index: a BotBandit
            // session that wraps a Codex original is a condensed duplicate, so search
            // surfaces the full Codex transcript instead. `list` still shows both.
            const condensedWrappers = collectCondensedWrapperIds(sessions);
            sessions = filterSessions(sessions, {
                agent: opts.agent,
                project: opts.project,
            });
            if (condensedWrappers.size > 0)
            {
                sessions = sessions.filter((s) => !condensedWrappers.has(s.sessionId));
            }

            const q = query.toLowerCase();
            const hits: SearchHit[] = [];
            for (const s of sessions) 
            {
                for (let i = 0; i < s.messages.length; i++) 
                {
                    const msg = s.messages[i]!;
                    if (!inTimeWindow(msg.timestamp, timeWindow)) { continue; }

                    // Match on message text
                    if (msg.text.toLowerCase().includes(q)) 
                    {
                        hits.push({
                            agent: s.agent,
                            sessionId: s.sessionId,
                            messageIndex: i + 1,
                            role: msg.role,
                            text: msg.text,
                            timestamp: msg.timestamp,
                        });
                    }

                    // Match on tool call input/output. Tool outputs can be large,
                    // so the hit text is a snippet centered on the match.
                    for (const tc of msg.toolCalls) 
                    {
                        const inputText = toolCallInputText(tc.input);
                        const outputText = tc.output ?? "";
                        const inMatch = inputText.toLowerCase().includes(q);
                        const outMatch = outputText.toLowerCase().includes(q);
                        if (!inMatch && !outMatch) { continue; }
                        const matchText = outMatch ? outputText : inputText;
                        hits.push({
                            agent: s.agent,
                            sessionId: s.sessionId,
                            messageIndex: i + 1,
                            role: msg.role,
                            text: snippetAround(matchText, q, 500),
                            timestamp: msg.timestamp,
                            toolCall: tc.name,
                        });
                    }
                }
            }

            if (opts.pretty) 
            {
                printSearchPretty(hits);
            }
            else 
            {
                printSearchJson(hits);
            }
        });
    return cmd;
}

interface SearchOptions {
    agent?: string;
    project?: string;
    since?: string;
    until?: string;
    pretty?: boolean;
}

/** Stringify a tool call's input for search (object → JSON, string → as-is). */
function toolCallInputText(input: unknown): string 
{
    if (input == null) { return ""; }
    if (typeof input === "string") { return input; }
    try 
    {
        return JSON.stringify(input);
    }
    catch 
    {
        return String(input);
    }
}

/** Truncate `text` to `max` chars, appending an ellipsis if cut. */
function truncate(text: string, max: number): string 
{
    if (text.length <= max) { return text; }
    return text.slice(0, max - 1) + "…";
}

/** Return a snippet of `text` centered on the first match of `query`. */
function snippetAround(text: string, query: string, max: number): string 
{
    if (text.length <= max) { return text; }
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) { return truncate(text, max); }
    const half = Math.floor((max - 1) / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(text.length, start + max);
    let snippet = text.slice(start, end);
    if (start > 0) { snippet = "…" + snippet; }
    if (end < text.length) { snippet = snippet + "…"; }
    return snippet;
}
