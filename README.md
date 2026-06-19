# Session Bandit

Search, browse, and extract information from the local session transcripts
written by your coding agents — Claude Code and Codex.

Every major coding agent writes its full session history to disk as JSONL.
Session Bandit indexes those files locally — no API calls, no auth, no network.
Just point it at your session directories and search across everything you've
ever done with every agent.

## Features

- **Unified listing** across Claude Code and Codex sessions, sorted by most
  recent first, with filters by agent and project.
- **Full transcripts** — read any session's normalized transcript with tool
  calls, inputs, outputs, and status indicators.
- **Full-text search** across all session messages, with agent and project
  filters.
- **Works as a library too** — `@session-bandit/core` exposes a programmatic
  API for indexing and querying sessions from your own code.

## Install

```sh
pnpm install
pnpm build
```

Requires Node.js 22+ and pnpm 10+.

## CLI usage

```sh
# List all sessions (JSON lines, most recent first)
session-bandit list

# List with a human-readable table
session-bandit list --pretty

# Filter by agent
session-bandit list --agent claude
session-bandit list --agent codex

# Filter by project (substring match on project path / cwd)
session-bandit list --project botbandit

# Show the full transcript of a session (accepts ID prefix)
session-bandit show 342647fa-5bf

# Full-text search across all session messages
session-bandit search "tool approval" --pretty

# Search within a specific agent
session-bandit search "adapter" --agent claude --pretty
```

### Commands

```
session-bandit list [--agent <name>] [--project <path>] [--pretty]
session-bandit show <sessionId> [--agent <name>]
session-bandit search <query> [--agent <name>] [--project <path>] [--pretty]
```

| Flag | Description |
|---|---|
| `-a, --agent <name>` | Filter by agent: `claude` or `codex` |
| `-p, --project <path>` | Filter by project (substring match on project/cwd) |
| `--pretty` | Print human-readable output instead of JSON lines |

**Output defaults to JSON lines** (one object per line) for machine
consumption and piping. Use `--pretty` for terminal browsing.

### Example output

`list --pretty`:

```
agent   sessionId     startedAt            msgs  model              project
--------------------------------------------------------------------------------
codex   019ee0ad-2eb  2026-06-19T16:18:26  64    gpt-5.5            /Users/ole/projekte/botbandit-ng
claude  342647fa-5bf  2026-06-19T10:38:38  153   claude-opus-4-8    /Users/ole/projekte/botbandit-ng
codex   019eda02-434  2026-06-18T09:14:02  65    gpt-5.5            /Users/ole/projekte/botbandit-ng
...
```

`list` (JSON lines):

```json
{"agent":"claude","sessionId":"342647fa-5bf0-41b4-b21d-1e7d0d78b371","project":"/Users/ole/projekte/botbandit-ng","cwd":"/Users/ole/projekte/botbandit-ng","startedAt":"2026-06-19T10:38:38.122Z","endedAt":"2026-06-19T14:41:00.972Z","model":"claude-opus-4-8","messageCount":153}
```

`show <sessionId>`:

```
Session: 342647fa-5bf0-41b4-b21d-1e7d0d78b371
Agent:   claude
Project: /Users/ole/projekte/botbandit-ng
Model:   claude-opus-4-8
Started: 2026-06-19T10:38:38.122Z
Messages: 153

--- #1 USER  [2026-06-19T10:38:38.122Z] ---
  Do you remember us working on the tool approval yesterday?
--- #2 ASSISTANT  [2026-06-19T10:38:44.405Z] ---
  I don't have a running memory of our actual conversation yesterday, but I do have a saved note that matches what you're describing.
--- #4 ASSISTANT  [2026-06-19T10:38:45.880Z] ---
  ✓ Read
    input: {"file_path":"/Users/ole/.claude/projects/.../memory/plan085.md"}
    output: <system-reminder>This memory is 7 days old...</system-reminder>
```

`search <query> --pretty`:

```
[claude] 005f7977-937  #440  user
  So what about going for simple saving of tool approvals / denials with regexes...
[claude] 005f7977-937  #535  assistant
  Written to `docs/architecture.md` — the repo's canonical systems doc...

2 matches
```

## Library usage

The `@session-bandit/core` package exposes the indexing engine and adapters
for programmatic use — no CLI required.

```ts
import {
  indexSessions,
  claudeAdapter,
  codexAdapter,
} from "@session-bandit/core";

// Index all sessions from both adapters
const sessions = indexSessions([
  { adapter: claudeAdapter },
  { adapter: codexAdapter },
]);

// Or just one agent
const claudeSessions = indexSessions([{ adapter: claudeAdapter }]);

// Each session is normalized to a common shape:
// {
//   agent, sessionId, filePath, project, cwd,
//   startedAt, endedAt, model, messageCount, messages[]
// }
```

### Adapter interface

```ts
interface Adapter {
  readonly agent: AgentName;       // "claude" | "codex" | "gemini"
  defaultRoot(): string;           // e.g. "~/.claude/projects"
  discover(root: string): string[];// find session files under root
  parse(filePath: string): Session;// parse one file → normalized Session
}
```

A new agent is a new adapter file — nothing else changes. See
`packages/core/src/adapters/` for reference implementations.

## Where sessions live

Session Bandit scans these directories by default:

| Agent | Default location |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (+ legacy flat files) |

Codex has used three file formats over time — legacy `.json` (single object),
flat `.jsonl` (no envelope), and modern envelope `.jsonl`. The Codex adapter
handles all three transparently.

## Development

```sh
pnpm install          # install deps
pnpm -r build         # build both packages
pnpm -r typecheck     # type-check (strict mode)
pnpm -r test          # run all tests (73 tests)

# Run the CLI from source (no build needed, uses tsx):
pnpm dev list --pretty
pnpm dev show <sessionId>
pnpm dev search "query" --pretty
```

### Project structure

```
packages/
  core/                          @session-bandit/core — indexing engine
    src/
      types.ts                   normalized Session/Message/ToolCall model
      adapter.ts                 Adapter interface
      index.ts                   indexSessions() + exports
      jsonl.ts                   JSONL reader
      adapters/
        claude.ts                Claude Code adapter
        codex.ts                 Codex adapter (3 formats)
    test/                        fixtures + 51 tests
  cli/                           session-bandit — CLI
    src/
      bin.ts                     entry point
      index.ts                   Commander program + cli()
      scan.ts                    scanAll() + filters + sorting
      format.ts                  output formatters (JSON, table, transcript)
      commands/
        list.ts                  list command
        show.ts                  show command
        search.ts                search command
    test/                        22 tests
docs/
  prd.md                         product requirements document
  adapters.md                    how to add an agent / adapt to format drift
  format-claude.md               Claude Code on-disk format reference
  format-codex.md                Codex on-disk format reference (3 historical formats)
```

## Extending

See [`docs/adapters.md`](docs/adapters.md) for how to add a new agent adapter
or adapt an existing one when a provider changes its on-disk format. Per-agent
format details live in [`docs/format-claude.md`](docs/format-claude.md) and
[`docs/format-codex.md`](docs/format-codex.md).

## License

MIT