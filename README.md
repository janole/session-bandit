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
- **Parsing health check** — `doctor` command validates that Session Bandit's
  parsing assumptions match your real session files (format drift, injection
  markers, unrecognized types, silent skips).
- **Works as a library too** — `@session-bandit/core` exposes a programmatic
  API for indexing and querying sessions from your own code.

## Install

### As a global CLI (npm)

```sh
npm install -g session-bandit
```

Requires Node.js 22+.

### From source (for development or pre-npm)

```sh
git clone https://github.com/janole/session-bandit.git
cd session-bandit
pnpm install
pnpm -r build
npm install -g packages/cli
```

Requires Node.js 22+ and pnpm 10+. The `npm install -g packages/cli` step
installs the CLI globally from the built output (core is bundled into the
CLI, so no separate install needed).

### Agent skill

Session Bandit ships an agent skill in the `skill/` directory. The skill
teaches Claude Code, Codex, and other `npx skills`-compatible agents how to use
Session Bandit to write handoff notes and memory notes from past sessions.

Install it globally for Claude Code:

```sh
npx skills add janole/session-bandit --skill session-bandit -g -a claude-code -y
```

Install it globally for Codex:

```sh
npx skills add janole/session-bandit --skill session-bandit -g -a codex -y
```

You can also install directly from the skill path:

```sh
npx skills add https://github.com/janole/session-bandit/tree/main/skill -g -a claude-code -y
```

Or manually copy the `skill/` directory to the relevant agent skill directory,
for example `~/.claude/skills/session-bandit/` for Claude Code or
`~/.codex/skills/session-bandit/` for Codex.

The skill's `SKILL.md` includes instructions for the agent to install the CLI
via `npm install -g session-bandit` if it's not already available.

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

# Emit a structured digest of a session (substance, files, key turns)
# for LLM ingestion — the payoff feature for handoffs / memories
session-bandit extract 342647fa-5bf --pretty

# Wrap the digest in a ready-to-send synthesis prompt
session-bandit extract 342647fa-5bf --prompt handoff
session-bandit extract 342647fa-5bf --prompt memory

# Find the sessions where something actually happened (by substance score)
session-bandit list --sort importance --pretty

# Drop the trivial / hello-only sessions
session-bandit list --min-importance moderate --pretty
```

### Commands

```
session-bandit list [--agent <name>] [--project <path>] [--sort recent|importance] [--min-importance <tier>] [--pretty]
session-bandit show <sessionId> [--agent <name>]
session-bandit search <query> [--agent <name>] [--project <path>] [--pretty]
session-bandit extract <sessionId> [--agent <name>] [--prompt handoff|memory] [--full] [--pretty]
```

| Flag | Description |
|---|---|
| `-a, --agent <name>` | Filter by agent: `claude` or `codex` |
| `-p, --project <path>` | Filter by project (substring match on project/cwd) |
| `--sort <field>` | `list`: sort by `recent` (default) or `importance` (substance score) |
| `--min-importance <tier>` | `list`: drop sessions below tier (`trivial`\|`light`\|`moderate`\|`substantive`\|`heavy`) |
| `--prompt <kind>` | `extract`: wrap the digest in a synthesis prompt (`handoff`\|`memory`) |
| `--full` | `extract`: include the complete de-noised transcript |
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
pnpm -r test          # run all tests (139 tests)

# Run the CLI from source (no build needed, uses tsx):
pnpm dev list --pretty
pnpm dev show <sessionId>
pnpm dev search "query" --pretty
pnpm dev doctor --pretty
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
      diagnose.ts               doctor diagnostics (format drift, injection markers)
      adapters/
        claude.ts                Claude Code adapter
        codex.ts                 Codex adapter (3 formats)
    test/                        fixtures + 91 tests
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
        extract.ts               extract command
        doctor.ts                doctor command (parsing health)
    test/                        48 tests
docs/
  prd.md                         product requirements document
  extract.md                     session extracts & digest design (primary v2 feature)
  decisions.md                   decision log (the "why" behind the structure)
  adapters.md                    how to add an agent / adapt to format drift
  format-claude.md               Claude Code on-disk format reference
  format-codex.md                Codex on-disk format reference (3 historical formats)
skill/
  SKILL.md                       Codex agent skill (handoff + memory note generation)
```

## Extending

See [`docs/adapters.md`](docs/adapters.md) for how to add a new agent adapter
or adapt an existing one when a provider changes its on-disk format. Per-agent
format details live in [`docs/format-claude.md`](docs/format-claude.md) and
[`docs/format-codex.md`](docs/format-codex.md). The rationale behind the
structural choices is in [`docs/decisions.md`](docs/decisions.md).

## Roadmap

**Done:**
- **Session extracts** — the primary v2 feature. `extract` computes a
  structured digest (substance score, files touched, commands, errors, key
  turns) and can emit a ready-to-send synthesis prompt. See
  [`docs/extract.md`](docs/extract.md).
- **`doctor` command** — parsing health check that validates adapter
  assumptions against real files (format drift, injection markers,
  unrecognized types).

**Next:**
- **Skill definition** (separate repo) that calls `session-bandit extract
  --prompt <kind>` and feeds the result to an LLM to write handoffs/memories
  into a doc store.
- **Gemini adapter** — the adapter guide uses Gemini as its worked example;
  implementing it would dogfood the guide and round out the big three agents.
- **Usage tier** — read Claude's `~/.claude/stats-cache.json` for offline
  token/cost estimates. Codex `token_count` events already cleanly skipped.

## License

MIT
