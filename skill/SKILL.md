---
name: session-bandit
description: 'Search, browse, extract, and publish information from coding agent session transcripts (Claude Code, Codex, BotBandit). Use when: (1) You need to write a handoff note from a previous session, (2) You need to create a memory note from a past session, (3) You want to find what happened in a previous coding session, (4) You want to search across all your agent sessions for a specific topic, file, or command, (5) You want to publish a session as a reviewed Markdown artifact. Triggers on: "session extract", "handoff from previous session", "what did I do in the last session", "search my sessions", "find a session where I worked on", "publish this session", "export session".'
---

## Prerequisites

Session Bandit is a CLI tool that must be installed on the system. Check if it's available:

```sh
command -v session-bandit
```

If not installed, install it globally:

```sh
npm install -g session-bandit
```

If the package is not yet on npm, install from source:

```sh
git clone https://github.com/janole/session-bandit.git
cd session-bandit
pnpm install
pnpm -r build
npm install -g packages/cli
```

Requires Node.js 22+ and pnpm 10+ (for building from source only; the npm install requires nothing but Node.js).

Verify the installation:

```sh
session-bandit --version
```

## What Session Bandit does

Session Bandit indexes the session transcripts that coding agents (Claude Code, Codex, BotBandit) write to disk as JSONL. It works fully offline — no API calls, no auth, no network. It scans `~/.claude/projects/`, `~/.codex/sessions/`, and `~/.botbandit/sessions/` by default.

## Output modes

Prefer the default machine-readable output when using Session Bandit as an
agent tool:

- `list` and `search` print JSON lines by default.
- `extract`, `redact-check`, and `doctor` print JSON by default.
- `show` prints a human-readable transcript.

Use `--pretty` only when a human-readable terminal view is useful for browsing
or reporting to the user. Do not add `--pretty` to commands whose output you
intend to parse or use as structured input for a handoff or memory note.

## Commands

### List sessions

```sh
# List all sessions, most recent first (JSON lines)
session-bandit list

# Human-readable table with importance tier
session-bandit list --pretty

# Filter by agent or project
session-bandit list --agent codex --project botbandit

# Sort by substance/importance (heavy sessions first)
session-bandit list --sort importance

# Drop trivial sessions
session-bandit list --min-importance moderate

# Limit to a time period: relative (7d, 24h, 2w, 3m) or absolute date
session-bandit list --since 7d
session-bandit list --since 2026-06-01 --until 2026-06-15
```

### Show a session transcript

```sh
# Full ID or prefix match
session-bandit show 342647fa-5bf
session-bandit show 342647fa --agent claude
```

### Search across sessions

```sh
session-bandit search "tool approval"
session-bandit search "apply_patch" --agent codex
session-bandit search "adapter" --since 3d --pretty
```

### Extract a session digest (the key feature for handoffs/memories)

```sh
# Structured digest (JSON) — substance score, files, commands, errors, key turns
session-bandit extract 342647fa-5bf

# Wrap the digest in a ready-to-send synthesis prompt
session-bandit extract 342647fa-5bf --prompt handoff
session-bandit extract 342647fa-5bf --prompt memory

# Include the full transcript in the digest
session-bandit extract 342647fa-5bf --full --prompt handoff
```

### Check parsing health

```sh
session-bandit doctor
session-bandit doctor --agent codex
session-bandit doctor --agent botbandit
```

### Check redaction before publishing

```sh
# JSON report by default
session-bandit redact-check 342647fa-5bf

# Human-readable report for review with the user
session-bandit redact-check 342647fa-5bf --pretty

# More conservative preview
session-bandit redact-check 342647fa-5bf --redact strict
```

### Export Markdown for review/publishing

```sh
session-bandit export-md 342647fa-5bf --out ./session.md
session-bandit export-md 342647fa-5bf --out ./session.md --report-out ./redaction-report.json
session-bandit export-md 342647fa-5bf --out ./session.md --title "Apple Watch interface"
```

`export-md` defaults to `--redact cautious`. Do not use `--redact none` for a
public artifact unless the user explicitly asks for it and accepts the risk; the
CLI requires `--yes` for that mode.

## Publishing a session

When asked to publish a coding session, keep Session Bandit deterministic and
offline. Use the CLI to create the redacted Markdown artifact and redaction
report; use your agent judgment only for session selection, title/slug choice,
optional prose polish, and reporting risk to the user.

1. **Find the source session.** If the user gives a session ID, use it directly.
   Otherwise search or list likely sessions:
   ```sh
   session-bandit list --sort importance
   session-bandit search "the topic"
   ```
   Use `--agent` or `--project` when the user narrows the target.

2. **Choose title, slug, and output paths.** For a GitHub Pages-style repo,
   prefer one folder per session:
   ```text
   sessions/<slug>/README.md
   sessions/<slug>/redaction-report.json
   ```
   Keep slugs short, lowercase, and stable. If the title is uncertain, propose
   it to the user before exporting.

3. **Preview redaction before writing the artifact:**
   ```sh
   session-bandit redact-check <sessionId> --pretty
   ```
   Report the counts and any notable risk. Use `--redact strict` if the session
   appears to contain private customer data, credentials, proprietary output, or
   unusually sensitive local context.

4. **Export Markdown and the report:**
   ```sh
   session-bandit export-md <sessionId> \
     --out sessions/<slug>/README.md \
     --report-out sessions/<slug>/redaction-report.json \
     --title "Human readable title"
   ```
   Do not use `--redact none` for public publishing unless the user explicitly
   requests it and accepts the risk.

5. **Review before publishing.** Inspect the Markdown and redaction report. Make
   sure summary sections, related sessions, commands, tool output, and local
   paths are reasonable. Automated redaction is best-effort, not proof of safety.

6. **Optionally polish the Markdown.** You may add or edit a short intro,
   section headings, or a closing note outside the CLI output. Do not invent
   facts; keep the transcript, digest, provenance, and redaction report intact.

7. **Ask before making it public.** Before `git add`, `git commit`, `git push`,
   or any deploy action, summarize the redaction risk and ask for explicit user
   approval unless the user already gave that approval in the current turn.

## Writing a handoff note

When asked to write a handoff note from a previous session:

1. **Find the session.** If the user gives a session ID, use it directly. Otherwise, list recent sessions and pick the relevant one:
   ```sh
   session-bandit list --sort importance
   ```
   Or search for a topic:
   ```sh
   session-bandit search "the topic"
   ```
   Add `--pretty` only if you need a table/excerpt for manual browsing.

2. **Generate the digest with a handoff prompt:**
   ```sh
   session-bandit extract <sessionId> --prompt handoff
   ```
   This emits a structured digest (substance score, files written, errors, summaries/recaps, goal, final state) wrapped in a synthesis prompt that tells you what to write.

3. **Write the handoff.** The prompt asks you to cover: the goal, what was done, the current state, and what is left to do. Use the digest's structured data (files written, errors, key turns) as the factual basis. Keep it concise — a returning agent needs the state, not the full history.

4. **Save the handoff** to wherever the user wants it (doc store, markdown file, etc.).

## Writing a memory note

When asked to create a memory note from a past session:

1. **Find and extract the session:**
   ```sh
   session-bandit extract <sessionId> --prompt memory
   ```

2. **Write the memory note.** The prompt asks for 2–4 sentences covering: what the session was about, the key outcome, and files/decisions worth remembering. End with a suggested importance tier (trivial / light / moderate / substantive / heavy).

3. **Save the memory note** to wherever the user wants it.

## Tips

- The `--prompt handoff` and `--prompt memory` templates are first drafts. Feel free to adapt the output format to the user's needs — the digest data is the valuable part, not the template text.
- Use `--full` when you need the complete transcript for context (e.g. complex multi-step work). Without `--full`, the digest is compact and may omit details.
- Claude recaps, Codex compactions, and BotBandit memory/compaction events are surfaced as `summary` messages and included in extracts. Treat them as useful synthesis context, but still ground handoffs and memories in the digest's files, errors, tests, and final turns.
- Before helping publish or export a session publicly, run `session-bandit redact-check <sessionId> --pretty` and report the remaining risk. Automated redaction is best-effort, not proof of safety.
- For a Markdown export, prefer `session-bandit export-md <sessionId> --out <path> --report-out <reportPath>`, then inspect the report before suggesting commit/publish.
- Markdown is the canonical publishing artifact. Do not create a basic HTML transcript unless the user specifically asks for HTML; high-quality HTML should be generated from the reviewed Markdown or redacted bundle.
- The substance score measures *activity* (tool calls, file writes, test runs), not *significance*. A short session can contain a critical decision. Read the key turns, not just the score.
- Session IDs can be specified as prefixes (e.g. `342647fa` instead of the full UUID).
- Run `session-bandit doctor` if something seems off — it checks whether the parsing assumptions match your real session files, including format drift, injection markers, unrecognized types, and silent skips. Use `--agent claude`, `--agent codex`, or `--agent botbandit` to narrow the check.
