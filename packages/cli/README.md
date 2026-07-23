# Session Bandit

Search, browse, and extract useful summaries from local coding-agent session
transcripts.

Session Bandit indexes the JSONL session histories written by Claude Code,
Codex, and BotBandit. It runs locally, reads local files, and does not call an
API.

## Install

```sh
npm install -g session-bandit
```

Requires Node.js 22 or newer.

## Quick Start

```sh
# List sessions, newest first
session-bandit list --pretty

# Search all normalized messages
session-bandit search "tool approval" --pretty

# Show a transcript by full ID or prefix
session-bandit show 342647fa-5bf

# Create a structured digest for handoff or memory notes
session-bandit extract 342647fa-5bf --pretty

# Wrap a digest in a synthesis prompt
session-bandit extract 342647fa-5bf --prompt handoff
session-bandit extract 342647fa-5bf --prompt memory

# Preview redaction findings before publishing/exporting
session-bandit redact-check 342647fa-5bf --pretty

# Export a redacted Markdown artifact
session-bandit export-md 342647fa-5bf --out ./session.md

# Check parser health against your real session files
session-bandit doctor --pretty
```

By default, machine-facing commands print JSON lines. Add `--pretty` for
human-readable terminal output.

## Commands

```text
session-bandit list [options]
session-bandit show [options] <sessionId>
session-bandit search [options] <query>
session-bandit extract [options] <sessionId>
session-bandit redact-check [options] <sessionId>
session-bandit export-md [options] <sessionId>
session-bandit stats [options] [sessionId]
session-bandit doctor [options]
```

### `list`

List sessions from all supported agents.

```sh
session-bandit list --pretty
session-bandit list --agent claude --pretty
session-bandit list --agent codex --pretty
session-bandit list --agent botbandit --pretty
session-bandit list --project my-repo --pretty
session-bandit list --sort importance --min-importance moderate --pretty
session-bandit list --since 7d --pretty
session-bandit list --since 2026-06-01 --until 2026-06-15 --pretty
```

Useful options:

| Option | Description |
| --- | --- |
| `--agent <name>` | Filter by `claude`, `codex`, or `botbandit` |
| `--project <text>` | Filter by project/cwd substring |
| `--sort <field>` | `recent` (default) or `importance` |
| `--min-importance <tier>` | Drop sessions below `trivial`, `light`, `moderate`, `substantive`, or `heavy` |
| `--since <date>` | Only sessions started at/after this time — absolute date (`2026-06-01`) or relative (`7d`, `24h`, `2w`, `3m`) |
| `--until <date>` | Only sessions started at/before this time — absolute date or relative |
| `--pretty` | Print a table instead of JSON lines |

### `show`

Print a normalized transcript, including tool calls, inputs, outputs, and
status indicators.

```sh
session-bandit show 342647fa-5bf --agent claude
```

### `search`

Search message text **and tool-call input/output** across sessions. Hits in
tool calls carry a `toolCall` field with the tool name and a snippet centered on
the match. When ripgrep is installed it pre-filters candidate files for speed;
otherwise the full index is scanned. Condensed BotBandit wrappers are skipped
when their full Codex original is in the index, so the same conversation is not
returned twice.

```sh
session-bandit search "adapter" --pretty
session-bandit search "failed test" --agent codex --project session-bandit --pretty
session-bandit search "adapter" --since 3d --pretty
```

`--since`/`--until` filter hits by message timestamp (absolute date or relative
`7d`, `24h`, `2w`, `3m`). Messages with no timestamp are dropped when a time
filter is active.

### `extract`

Emit a structured digest with the session goal, final state, tool usage,
files touched, test runs, and substance score.

```sh
session-bandit extract 342647fa-5bf --pretty
session-bandit extract 342647fa-5bf --full
session-bandit extract 342647fa-5bf --prompt handoff
session-bandit extract 342647fa-5bf --prompt memory
```

Useful options:

| Option | Description |
| --- | --- |
| `--prompt handoff` | Wrap the digest in a handoff-note prompt |
| `--prompt memory` | Wrap the digest in a memory-note prompt |
| `--full` | Include the complete de-noised transcript |
| `--pretty` | Print a readable digest instead of JSON |

### `redact-check`

Preview the redaction report that publishing/export commands will use. This
does not write any files.

```sh
session-bandit redact-check 342647fa-5bf
session-bandit redact-check 342647fa-5bf --pretty
session-bandit redact-check 342647fa-5bf --redact strict
```

Useful options:

| Option | Description |
| --- | --- |
| `--redact strict` | Most conservative mode |
| `--redact cautious` | Default mode |
| `--redact minimal` | Only high-confidence secrets |
| `--redact none` | No redaction; useful only for local debugging |
| `--pretty` | Print a readable report instead of JSON |

### `export-md`

Export a session as a Markdown file. The command builds the publishing bundle,
applies redaction, then renders Markdown with frontmatter, digest, provenance,
summaries, transcript, and collapsible tool calls.

```sh
session-bandit export-md 342647fa-5bf --out ./session.md
session-bandit export-md 342647fa-5bf --out ./session.md --title "Apple Watch interface"
session-bandit export-md 342647fa-5bf --out ./session.md --report-out ./redaction-report.json
```

Useful options:

| Option | Description |
| --- | --- |
| `--out <path>` | Required Markdown output path |
| `--title <title>` | Override the digest-derived title |
| `--redact cautious` | Default redaction mode |
| `--redact strict` | More conservative redaction |
| `--redact minimal` | Only high-confidence secrets |
| `--redact none --yes` | Disable redaction explicitly |
| `--report-out <path>` | Write the redaction report JSON |

### Publishing workflow

Use `redact-check` and `export-md` together when preparing a public artifact:

```sh
session-bandit list --sort importance --pretty
session-bandit search "the topic" --pretty
session-bandit redact-check 342647fa-5bf --pretty

mkdir -p sessions/the-topic
session-bandit export-md 342647fa-5bf \
  --out sessions/the-topic/index.md \
  --report-out sessions/the-topic/redaction-report.json \
  --title "The topic"
```

Review both files before committing or publishing. The CLI does not push,
deploy, call an LLM, or generate a generic HTML page; Markdown is the canonical
offline artifact. If HTML is needed, generate it from the reviewed Markdown or
redacted publishing bundle.

The installable skill ships a default GitHub Pages template at
`skills/session-bandit/templates/github-pages-default/`. Use that template for new publishing
repos when you want polished static rendering without adding an HTML exporter to
the CLI.

### `doctor`

Check whether parser assumptions still match your local session files. This is
useful when Claude Code, Codex, or BotBandit changes their transcript format.

```sh
session-bandit doctor --pretty
session-bandit doctor --agent botbandit --pretty
```

### `stats`

Show token usage and context-window stats for a session, or aggregate usage
across all sessions with `--global`.

```sh
# Per-session token usage, context window, and per-turn breakdown
session-bandit stats 342647fa-5bf --pretty

# Aggregate usage across all sessions (reads Claude's stats cache + sums
# per-session stats from every adapter)
session-bandit stats --global --pretty
```

Per-session stats report total input/output/cache/reasoning tokens, the
model's context-window limit (when known — Codex reports it), and the peak and
final context size, plus a per-turn breakdown. `--global` sums usage across
every adapter's transcripts, broken down per agent. Adding `--agent claude`
layers in Claude's own lifetime cache (`~/.claude/stats-cache.json`) — per-model
totals, the longest session, and busiest hours. That cache is Claude-only and
counts sessions whose transcripts have since been rotated away, so it is scoped
to a Claude view rather than mixed into the all-agent one. Cost is not available
offline from any source.

## Session Locations

Session Bandit scans these default locations:

| Agent | Default location |
| --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` plus legacy flat files |
| BotBandit | `~/.botbandit/sessions/*.jsonl` |

## Package Notes

The npm package is the CLI. Its runtime bundle includes the core parser code,
so installing `session-bandit` is enough for command-line use.

The project repository is <https://github.com/janole/session-bandit>.
