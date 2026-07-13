# Session extracts & digest — design

Status: **Draft** · Last updated: 2026-06-20

> This is the design for Session Bandit's primary feature: turning a session
> into a reusable **extract** — a handoff, a memory note, or a "what happened
> here" summary — plus an offline **importance** signal that ranks sessions by
> how much actually happened in them.

## Thesis

Search/browse (v1) is the *foundation*. Extracts are the *payoff*: the thing
that turns a pile of session transcripts into reusable knowledge, and the
thing that connects Session Bandit to the botbandit memory system.

A "session extract" answers, for one session:

- **What was done?** (a one-paragraph synthesis)
- **How important/substantial was it?** (the "hello!" session vs. the 1000-tool-call refactor)
- **What files were touched?** (local files written/edited/read)
- **What was the final state / open threads?** (last turns, errors)

## The offline/LLM split (the key architectural decision)

Session Bandit **stays fully offline.** It does not call an LLM. This preserves
the foundational principle (no network, no auth — see
[decisions.md](decisions.md) §3) and plays to each side's strength:

- **Session Bandit owns the offline-computable signals.** It already parses
  messy provider JSONL into the clean normalized `Session`/`Message`/`ToolCall`
  model — which is exactly the structured data an LLM needs as input. From that
  model it computes, with no LLM: the importance/substance score, the files
  touched, the commands run + outcomes, the errors, the key turns. This is
  90% of the work of preparing a handoff.
- **The consuming agent's LLM owns the natural-language synthesis.** It takes
  Session Bandit's structured **digest** and writes the one-paragraph "what was
  done" / the memory note. This happens via a **skill** that calls
  `session-bandit extract <id>` and feeds the result to its LLM.

So Session Bandit's job is to emit a **digest**: a compact, high-signal,
LLM-ingestible JSON document. It optionally wraps that digest in a
ready-to-send **prompt template** (`--prompt handoff|memory`) — still pure text
shaping, no LLM.

## The digest

A new `SessionDigest` type, produced by a `digest.ts` module in core that takes
a `Session` and returns a `SessionDigest`. The digest is a *downstream
computation* over the normalized model — adapters are untouched (the normalized
model remains the single seam, see [decisions.md](decisions.md) §5).

```ts
interface SessionDigest {
  // — identity —
  agent: AgentName;
  sessionId: string;
  filePath: string;
  project: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMin: number | null;

  // — substance / importance (offline-computed) —
  substance: {
    score: number;
    tier: "trivial" | "light" | "moderate" | "substantive" | "heavy";
    signals: {
      messageCount: number;
      toolCallCount: number;
      filesWritten: number;
      filesRead: number;
      errorCount: number;     // includes user-rejected tool uses (caveat)
      ranTests: boolean;
      endedCleanly: boolean;  // has a final assistant turn, not interrupted
      idle: boolean;          // high wall-clock duration, low activity
    };
  };

  // — what was touched (de-noised, local files only) —
  files: {
    written: string[];        // unique paths created/edited
    read: string[];           // unique paths read (excluding written)
  };

  // — commands + outcomes —
  commands: {
    total: number;
    failing: { name: string; input: unknown; output: string | null }[];
  };

  // — test runs (best-effort detection) —
  tests: { command: string; passed: boolean | null }[];

  // — failed tool runs (the "what went wrong" signals) —
  errors: { name: string; output: string | null }[];

  // — key turns (de-noised excerpt for synthesis) —
  keyTurns: {
    goal: string | null;       // first user message — the task
    finalState: string[];      // last N assistant text turns — the outcome
  };

  // — tool usage breakdown —
  tools: { name: string; count: number }[];
}
```

A full session can be 2000+ messages / ~1MB of text. The digest is **compact by
default** — it carries the signals, the file/command summaries, and a few key
turns, *not* the whole transcript. `extract --full` adds the complete de-noised
transcript (`transcript: Message[]`) for cases that want full ingestion.

### Runtime-generated summaries (recaps & compactions)

Claude and Codex both emit runtime-generated summaries mid-session — Claude
writes an `away_summary` **recap** when you return after being away (what was
done, what's next); Codex writes a `compacted` envelope when the context window
fills and older context is replaced. These were previously dropped; now the
adapters emit them as `summary`-role messages (`subtype: "recap"` /
`"compaction"`) and `computeDigest()` collects them into `summaries`.

```ts
interface DigestSummary {
  subtype: string;            // "recap" | "compaction" — the semantic kind
  text: string;               // the recap content, or a compaction's derived note
  timestamp: string | null;
}
```

These are high-signal synthesis fuel: a recap is the agent's own
natural-language summary of recent work, and a compaction marks where the
context was pruned. Both appear in the `extract --pretty` "Summaries" section
and in the `--prompt handoff|memory` templates as "Agent's own recaps/summaries".

- **Recaps** carry real summary text (Claude's top-level `content` field).
- **Compactions** have an empty `.message` in real data, so the note is
  derived: `"Context compacted: N prior messages replaced."` The heavy
  `replacement_history` is *not* carried — a survey of all on-disk
  compactions found 99% of those messages already appear as earlier
  `response_item` lines the adapter already captured, so it's redundant. No
  data loss. See [format-codex.md](format-codex.md) and [format-claude.md](format-claude.md).

The list is capped at `MAX_SUMMARIES = 50` (a long session can accumulate many
recaps), kept in chronological order. See `extractSummaries()` in `digest.ts`.

### Why this shape

Every field is either (a) something an LLM needs to write a good handoff
(goal, final state, files, errors) or (b) something useful *without* an LLM
(substance score, files touched, test outcome). The `substance.signals` object
is emitted alongside the score so the LLM (or a human) can *justify* the
importance call ("heavy: 555 tool calls, 96 files written, ran tests").

## The substance / importance heuristic

Grounded in a recon scan of 1083 real sessions (108 Claude + 973 Codex, plus 2
from this build session). The tool-call-count distribution:

| tool calls | sessions | reading |
|---|---|---|
| 0–1   | 232 | the "hello!" / interrupted / empty tier |
| 1–5   | 227 | light conversation, little action |
| 5–20  | 219 | moderate — real work begins |
| 20–100 | 295 | substantive multi-step work |
| 100+  | 110 | heavy refactors / long builds (max 1067 calls, 96 files) |

### Score formula

```
filesWritten = unique local paths from write/edit tools
filesRead     = unique local paths from read tools (excluding written)
substanceScore = toolCallCount
               + 3 * filesWritten
               + 1 * filesRead
               + 5 * (ranTests ? 1 : 0)
               - 2 * (endedCleanly ? 0 : 1)    // interrupted → mild penalty
```

- **Files weighted above raw tool calls**: 50 `Read`s with no writes is
  exploration, not work. Writes/edits are the real "something changed" signal.
- **`ranTests` is a small flat bonus**: running tests indicates verification,
  a marker of real work.
- **Duration is deliberately NOT in the score**: wall-clock duration is inflated
  by sessions left open across days (the largest sample ran 73 hours). Instead
  it drives the `idle` flag (below).

### Tiers (anchored to the distribution above)

| score | tier | |
|---|---|---|
| < 3 | trivial | the "hello!" / empty / interrupted tier |
| 3–25 | light | some talk, minimal action |
| 25–100 | moderate | real, focused work |
| 100–400 | substantive | multi-file, multi-step |
| > 400 | heavy | large refactors / long builds |

Sanity-checked against the recon: the heaviest real session (1067 calls, ~47
files written, ran tests) scores well into `heavy`; a 2-message "hello" scores
0 → `trivial`. Thresholds are tunable constants in `digest.ts`.

### Auxiliary flags

- **`idle`**: `durationMin > 120` *and* `toolCallCount < 10` — left open but
  little happened. Surfaced so `list` can de-emphasize abandoned sessions.
- **`endedCleanly`**: there is at least one assistant turn after the last user
  turn. A session that ends mid-tool-call or with only user input is likely
  interrupted.

## File extraction (the riskiest part — grounded)

File paths are extracted from tool-call `input` using **per-agent heuristics**,
because the tool vocabularies differ sharply (from the recon):

**Claude** — clean and easy:
- `Write`, `Edit`, `Read`, `MultiEdit` → `input.file_path` (a string).
- `Bash` → **not** counted as a file (command-string path tokens are too noisy).

**Codex** — needs patch parsing:
- `apply_patch` → `input` is a **patch string**, not an object. Parse for the
  file markers: `*** Update File: <path>`, `*** Add File: <path>`,
  `*** Delete File: <path>`.
- `exec_command` / `shell_command` / `shell` / `write_stdin` → **not** counted
  as files (commands, not file edits).
- `mcp__github__get_file_contents`, `document_read`, etc. → **excluded**; these
  reference *remote* or doc-store files, not local files touched by the session.

**General rule:** only tools on a file-edit whitelist (Write/Edit/apply_patch/
MultiEdit/…) count as `written`; only Read-like tools count as `read`. This
keeps "files touched" honest — it means *local files this session changed or
inspected*, not "every path-shaped string anywhere."

The per-agent file-extraction logic lives in `digest.ts` (keyed by `agent` +
tool-name patterns), **not** in the adapters — adapters still only produce the
normalized model. If a new agent lands, `digest.ts` gains a small
file-extraction branch alongside its adapter.

## Test-run detection (best-effort)

Scan shell/bash command strings for known runners: `npm test`, `pnpm test`,
`vitest`, `pytest`, `cargo test`, `go test`, `jest`, `mvn test`, `gradle test`.

Outcome:
- **Codex**: the tool output carries `metadata.exit_code` → `passed = exit_code === 0`.
- **Claude**: tool-result content is plain text, no structured exit code →
  infer from text heuristics (`FAIL`/`failed`/`✗` → false, `pass`/`✓` → true),
  else `null` (unknown).

`tests[].passed` is `boolean | null`; we never claim certainty we don't have.

## Command surface

```
session-bandit extract <sessionId> [--prompt handoff|memory] [--full] [--pretty]
session-bandit list [--sort importance] [--min-importance <tier>] ...
```

- `extract` emits the digest as JSON (default) or `--pretty` human-readable.
  `--prompt handoff|memory` wraps the digest in a ready-to-send prompt template
  (pure text shaping — Session Bandit still makes no LLM call). `--full`
  includes the complete de-noised transcript.
- `list` gains `--sort importance` (by substance score, desc) and
  `--min-importance <tier>` (filter out trivial/light sessions). The substance
  score and tier become fields on the `list` JSON object, so the "find the
  sessions where something actually happened" use case works with zero LLM.

## Skill integration

A Session Bandit skill exposes `list` / `show` / `search` / `extract` to an
agent. The extract workflow:

1. Agent calls `session-bandit list --sort importance --min-importance moderate`
   to find substantive sessions (or `search` to find ones about a topic).
2. Agent calls `session-bandit extract <id> --prompt memory` (or `handoff`).
3. Session Bandit returns the digest wrapped in a synthesis prompt.
4. The agent feeds that to its own LLM and writes the memory/handoff into the
   botbandit doc store.

Session Bandit never makes the LLM call; the agent does, using its own model
and context. This keeps the tool offline and the synthesis in the place that
already has the memory-writing capability.

## Open questions / risks

- **Importance ≠ value.** A 2-message session might contain a critical
  architectural decision; a 1000-call session might be a tedious churn. The
  substance score measures *activity*, not *significance*. The LLM synthesis
  (reading the key turns) is what judges significance; the score is just a
  triage/ranking signal. We should label it "substance," not "importance," in
  the UI to stay honest — though "importance" is the user-facing word.
- **File extraction heuristics will miss things.** Agents invent new tool names
  (the recon shows a long MCP tail: `mcp__next_devtools__*`, `readGithubFile`,
  …). The whitelist will need tuning as new tools appear; unrecognized
  write-like tools are silently excluded today. Mitigation: log unmatched
  tool names in a debug mode so the whitelist stays current.
- **Test pass/fail for Claude is a text heuristic.** Acceptable as
  best-effort; `passed: null` is the honest fallback.
- **Digest size for `--full`.** A 2000-message session's full transcript is
  large for LLM context. Default stays compact; `--full` is opt-in and may need
  truncation/segmentation for very large sessions (deferred).
- **Prompt templates need iteration.** The `--prompt handoff|memory` templates
  are guesses until we see what the consuming LLM does with them. Ship a first
  draft, refine against real outputs.

## Validation (against 1084 real sessions)

Implemented and spot-checked against live data (108 Claude + 973 Codex + build
sessions):

- **`list --sort importance`** surfaces the genuinely heavy sessions first
  (1581, 2031, 1522 messages — all `heavy`). Tier filters: 22 heavy, 135
  substantive, 1084 total. Full scan + per-session substance computes in ~1.9s.
- **File extraction** matches what `show` reveals: a 1067-call Codex session
  yielded 47 local files (apply_patch parsing); an 854-call Claude session
  yielded 59 written + 23 read (Write/Edit/Read `file_path`). No command-string
  noise leaked in.
- **Trivial detection** is honest: a 2-message "are there any bugs in my code?"
  session correctly scores `trivial` by activity — validating the open question
  that *substance ≠ value* (it has a real question but no work done).

**Fixed during validation:** in Codex sessions the first `user`-role
message is the injected AGENTS.md / permissions instructions, so
`keyTurns.goal` would pick up the instructions rather than the real task. The
Codex adapter now skips `user`-role messages whose first content block starts
with `# AGENTS.md instructions for`, `<environment_context>`, or
`<user_action>` — consistent with the existing `developer`/`system` skip. The
`doctor` command verifies detection rates (see `docs/format-codex.md` and
decision #17 in `docs/decisions.md`).

## Build order (proposed)

1. ✅ `digest.ts` in core: `computeDigest(session): SessionDigest` — the substance
   score, tiers, file extraction (Claude + Codex), test detection, key turns,
   errors. Unit tests over the existing fixtures + in-test constructed sessions
   (31 digest tests).
2. ✅ `extract` CLI command: emits the digest (JSON / `--pretty` / `--full` /
   `--prompt`). Injectable `ScanFn`, tested (14 extract tests).
3. ✅ `list --sort importance` / `--min-importance` + substance fields on `list`
   output (7 list tests).
4. ✅ `--prompt handoff|memory` templates.
5. ✅ Validate against real sessions: spot-check that the heavy/light sessions
   from the recon land in the expected tiers, and that file extraction matches
   what `show` reveals. (See "Validation" above.)
6. ✅ Skill definition — lives in the repo at `skills/session-bandit/SKILL.md`. Installable
   via the Codex skill-installer from GitHub. Teaches the agent to use
   `session-bandit extract --prompt handoff|memory` and synthesize a note.
   CLI bundles core (`noExternal`) so `npm install -g session-bandit` works
   without a workspace dependency (decision #19).