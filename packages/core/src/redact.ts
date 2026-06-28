import type { PublishedRedactionMode, PublishedSessionBundle } from "./publish.js";

export type RedactionKind =
    | "email"
    | "envAssignment"
    | "homePath"
    | "knownAuthFile"
    | "longOutputCollapsed"
    | "secretLike"
    | "urlQuery";

export interface RedactionFinding {
    kind: RedactionKind;
    path: string;
    replacement: string;
}

export interface RedactionReport {
    mode: PublishedRedactionMode;
    counts: Record<RedactionKind, number>;
    findings: RedactionFinding[];
}

export interface RedactPublishedSessionBundleOptions {
    mode?: PublishedRedactionMode;
    maxOutputChars?: number;
}

export interface RedactedPublishedSessionBundle {
    bundle: PublishedSessionBundle;
    report: RedactionReport;
}

const EMPTY_COUNTS: Record<RedactionKind, number> = {
    email: 0,
    envAssignment: 0,
    homePath: 0,
    knownAuthFile: 0,
    longOutputCollapsed: 0,
    secretLike: 0,
    urlQuery: 0,
};

/** Redact a published session bundle without mutating the source bundle. */
export function redactPublishedSessionBundle(
    bundle: PublishedSessionBundle,
    options: RedactPublishedSessionBundleOptions = {},
): RedactedPublishedSessionBundle
{
    const mode = options.mode ?? bundle.manifest.redaction.mode;
    const report: RedactionReport = {
        mode,
        counts: { ...EMPTY_COUNTS },
        findings: [],
    };

    if (mode === "none")
    {
        return {
            bundle: cloneJson(bundle),
            report,
        };
    }

    const redacted = redactValue(bundle, "$", {
        mode,
        maxOutputChars: options.maxOutputChars ?? defaultMaxOutputChars(mode),
        report,
    }) as PublishedSessionBundle;
    redacted.manifest.redaction.mode = mode;
    return { bundle: redacted, report };
}

interface RedactionContext {
    mode: PublishedRedactionMode;
    maxOutputChars: number;
    report: RedactionReport;
}

function redactValue(value: unknown, path: string, ctx: RedactionContext): unknown
{
    if (typeof value === "string")
    {
        const collapsed = maybeCollapseOutput(value, path, ctx);
        return redactString(collapsed, path, ctx);
    }

    if (Array.isArray(value))
    {
        return value.map((item, index) => redactValue(item, `${path}[${index}]`, ctx));
    }

    if (isRecord(value))
    {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value))
        {
            out[key] = redactValue(child, `${path}.${key}`, ctx);
        }
        return out;
    }

    return value;
}

function redactString(value: string, path: string, ctx: RedactionContext): string
{
    let out = value;

    out = replaceMatches(out, path, ctx, "envAssignment", envAssignmentPattern(ctx.mode), (match) =>
    {
        const key = match.match(/^([A-Z][A-Z0-9_]{2,})=/)?.[1] ?? "VALUE";
        return `${key}=[REDACTED_ENV]`;
    });

    out = redactContextualSecretLike(out, path, ctx);
    out = replaceMatches(out, path, ctx, "secretLike", secretPatterns(ctx.mode), () => "[REDACTED_SECRET]");

    if (ctx.mode !== "minimal")
    {
        out = replaceMatches(out, path, ctx, "email", [/(?<![A-Z0-9._%+/-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi], () => "[REDACTED_EMAIL]");
        out = redactUrls(out, path, ctx);
        out = replaceMatches(out, path, ctx, "homePath", [
            /\/Users\/[A-Za-z0-9._-]+(?=\/|$)/g,
            /\/home\/[A-Za-z0-9._-]+(?=\/|$)/g,
        ], () => "~");
        out = replaceMatches(out, path, ctx, "knownAuthFile", [
            /(?:^|[\s"'(])([^\s"'()]*?(?:\.env(?:\.[A-Za-z0-9_-]+)?|auth\.json|\.npmrc|\.pem|\.p8|\.ssh\/[^\s"'()]+))/g,
        ], (match) => match.startsWith(" ") ? " [REDACTED_AUTH_PATH]" : "[REDACTED_AUTH_PATH]");
    }

    return out;
}

function redactContextualSecretLike(value: string, path: string, ctx: RedactionContext): string
{
    let out = value;

    if (ctx.mode === "minimal")
    {
        return out;
    }

    out = replaceMatches(out, path, ctx, "secretLike", [
        /\b((?:[Aa]pple [Dd]eveloper )?[Tt]eam(?:\s+ID)?(?:\s+is)?\s+`?)[A-Z0-9]{10}`?/g,
        /\b((?:DEVELOPMENT_TEAM(?:\s*=)?|BOTBANDIT_DEV_TEAM=|[Aa]pplication-identifier:\s*)`?)[A-Z0-9]{10}`?/g,
    ], (match) =>
    {
        const id = match.match(/[A-Z0-9]{10}/i);
        if (!id || id.index === undefined)
        {
            return "[REDACTED_SECRET]";
        }
        return `${match.slice(0, id.index)}[REDACTED_SECRET]${match.endsWith("`") ? "`" : ""}`;
    });

    out = replaceMatches(out, path, ctx, "secretLike", [
        /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g,
        /(?<![A-Z0-9])(?=[A-Z0-9]{10}(?![A-Z0-9]))(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{10}(?![A-Z0-9])/g,
    ], () => "[REDACTED_SECRET]");

    return out;
}

function redactUrls(value: string, path: string, ctx: RedactionContext): string
{
    return value.replace(/https?:\/\/[^\s"'<>)}\]]+/g, (raw) =>
    {
        try
        {
            const url = new URL(raw);
            const hadSensitiveParts = Boolean(url.username || url.password || url.search || url.hash);
            if (!hadSensitiveParts) { return raw; }
            url.username = "";
            url.password = "";
            url.search = "";
            url.hash = "";
            record(ctx.report, "urlQuery", path, "[REDACTED_URL_QUERY]");
            return url.toString();
        }
        catch
        {
            return raw;
        }
    });
}

function maybeCollapseOutput(value: string, path: string, ctx: RedactionContext): string
{
    if (!path.endsWith(".output") || value.length <= ctx.maxOutputChars)
    {
        return value;
    }

    const omitted = value.length - ctx.maxOutputChars;
    record(ctx.report, "longOutputCollapsed", path, "[OUTPUT_COLLAPSED]");
    return `${value.slice(0, ctx.maxOutputChars)}\n[... output collapsed; ${omitted} chars omitted ...]`;
}

function replaceMatches(
    value: string,
    path: string,
    ctx: RedactionContext,
    kind: RedactionKind,
    patterns: RegExp[],
    replacement: (match: string) => string,
): string
{
    let out = value;
    for (const pattern of patterns)
    {
        out = out.replace(pattern, (match) =>
        {
            const next = replacement(match);
            if (next !== match)
            {
                record(ctx.report, kind, path, next);
            }
            return next;
        });
    }
    return out;
}

function envAssignmentPattern(mode: PublishedRedactionMode): RegExp[]
{
    if (mode === "strict")
    {
        return [/\b([A-Z][A-Z0-9_]{2,})=(?:"[^"]*"|'[^']*'|[^\s"'`]+)/g];
    }
    return [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s"'`]+)/g];
}

function secretPatterns(mode: PublishedRedactionMode): RegExp[]
{
    const patterns = [
        /\bsk-[A-Za-z0-9_-]{8,}\b/g,
        /\bghp_[A-Za-z0-9_]{8,}\b/g,
        /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
        /\bpat_[A-Za-z0-9._-]{8,}\b/g,
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    ];

    if (mode === "strict")
    {
        patterns.push(/\b[A-Fa-f0-9]{40,}\b/g);
        patterns.push(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g);
    }

    return patterns;
}

function defaultMaxOutputChars(mode: PublishedRedactionMode): number
{
    if (mode === "strict") { return 1_000; }
    if (mode === "minimal") { return Number.MAX_SAFE_INTEGER; }
    return 2_000;
}

function record(report: RedactionReport, kind: RedactionKind, path: string, replacement: string): void
{
    report.counts[kind]++;
    report.findings.push({ kind, path, replacement });
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T
{
    return JSON.parse(JSON.stringify(value)) as T;
}
