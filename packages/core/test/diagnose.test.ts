import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { BotBanditDoctorDetails, CodexDoctorDetails } from "../src/diagnose.js";
import { diagnoseAll } from "../src/diagnose.js";
import { botbanditAdapter, claudeAdapter, codexAdapter } from "../src/index.js";

const fixtureRoot = join(__dirname, "fixtures");

describe("diagnoseAll", () => 
{
    it("returns a report with totals", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
            { adapter: claudeAdapter, root: join(fixtureRoot, "claude") },
            { adapter: botbanditAdapter, root: join(fixtureRoot, "botbandit") },
        ]);
        expect(report.totals).toBeDefined();
        expect(report.totals.files).toBeGreaterThan(0);
        expect(report.totals.sessions).toBeGreaterThan(0);
        expect(report.agents).toHaveLength(3);
    });

    it("includes per-agent reports", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
        ]);
        expect(report.agents).toHaveLength(1);
        const codex = report.agents[0]!;
        expect(codex.agent).toBe("codex");
        expect(codex.files).toBe(4); // 3 jsonl + 1 json
        expect(codex.sessions).toBe(4);
    });
});

describe("diagnoseAll — botbandit details", () =>
{
    it("reports BotBandit files and schema versions", () =>
    {
        const report = diagnoseAll([
            { adapter: botbanditAdapter, root: join(fixtureRoot, "botbandit") },
        ]);
        const botbandit = report.agents[0]!;
        const details = botbandit.details as BotBanditDoctorDetails;
        expect(botbandit.agent).toBe("botbandit");
        expect(botbandit.files).toBe(5);
        expect(botbandit.sessions).toBe(5);
        expect(details.schemaVersions["2"]).toBe(5);
    });

    it("reports unrecognized BotBandit event types", () =>
    {
        const report = diagnoseAll([
            { adapter: botbanditAdapter, root: join(fixtureRoot, "botbandit") },
        ]);
        const details = report.agents[0]!.details as BotBanditDoctorDetails;
        expect(details.unrecognizedEventTypes["mystery_event"]).toBe(1);
    });
});

describe("diagnoseAll — codex details", () => 
{
    it("reports format distribution", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
        ]);
        const codex = report.agents[0]!;
        const details = codex.details as CodexDoctorDetails;
        expect(details.formatDistribution.legacyJson).toBe(1);
        expect(details.formatDistribution.flatJsonl).toBeGreaterThanOrEqual(1);
        expect(details.formatDistribution.envelopeJsonl).toBeGreaterThanOrEqual(1);
    });

    it("detects the AGENTS.md injection marker in the first user message", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
        ]);
        const details = report.agents[0]!.details as CodexDoctorDetails;
        // The modern envelope fixture has an AGENTS.md-prefixed first user message.
        expect(details.firstUserMarkers.agentsMd).toBeGreaterThanOrEqual(1);
        expect(details.firstUserMarkers.total).toBeGreaterThanOrEqual(1);
    });

    it("reports no unrecognized envelope or item types for known fixtures", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
        ]);
        const details = report.agents[0]!.details as CodexDoctorDetails;
        expect(Object.keys(details.unrecognizedEnvelopeTypes)).toHaveLength(0);
        expect(Object.keys(details.unrecognizedItemTypes)).toHaveLength(0);
    });

    it("reports empty sessions (the stub fixture)", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "codex") },
        ]);
        const codex = report.agents[0]!;
        // The stub file (fix-codex-empty-0004) has 0 messages.
        expect(codex.emptySessions).toBeGreaterThanOrEqual(1);
    });
});

describe("diagnoseAll — missing root", () => 
{
    it("returns zeros for a non-existent root without throwing", () => 
    {
        const report = diagnoseAll([
            { adapter: codexAdapter, root: join(fixtureRoot, "nope-does-not-exist") },
        ]);
        expect(report.agents[0]!.files).toBe(0);
        expect(report.agents[0]!.sessions).toBe(0);
    });
});
