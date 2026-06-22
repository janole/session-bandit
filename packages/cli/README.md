# Session Bandit

Search, browse, and extract useful summaries from local coding-agent session
transcripts.

Session Bandit indexes the JSONL session histories written by Claude Code and
Codex. It runs locally, reads local files, and does not call an API.

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
session-bandit doctor [options]
```

### `list`

List sessions from all supported agents.

```sh
session-bandit list --pretty
session-bandit list --agent claude --pretty
session-bandit list --agent codex --pretty
session-bandit list --project my-repo --pretty
session-bandit list --sort importance --min-importance moderate --pretty
```

Useful options:

| Option | Description |
| --- | --- |
| `--agent <name>` | Filter by `claude` or `codex` |
| `--project <text>` | Filter by project/cwd substring |
| `--sort <field>` | `recent` (default) or `importance` |
| `--min-importance <tier>` | Drop sessions below `trivial`, `light`, `moderate`, `substantive`, or `heavy` |
| `--pretty` | Print a table instead of JSON lines |

### `show`

Print a normalized transcript, including tool calls, inputs, outputs, and
status indicators.

```sh
session-bandit show 342647fa-5bf --agent claude
```

### `search`

Search message text across sessions.

```sh
session-bandit search "adapter" --pretty
session-bandit search "failed test" --agent codex --project session-bandit --pretty
```

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

### `doctor`

Check whether parser assumptions still match your local session files. This is
useful when Claude Code or Codex changes their transcript format.

```sh
session-bandit doctor --pretty
```

## Session Locations

Session Bandit scans these default locations:

| Agent | Default location |
| --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` plus legacy flat files |

## Package Notes

The npm package is the CLI. Its runtime bundle includes the core parser code,
so installing `session-bandit` is enough for command-line use.

The project repository is <https://github.com/janole/session-bandit>.
