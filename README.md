# Session Bandit

A tool to search, browse, and extract information from the local session
transcripts written by every coding agent you use — Claude Code, Codex,
Gemini CLI, and others — plus a view of how much you've been using each one.

Every major coding agent already writes its full session history to disk as
JSONL. There is no API to call and no auth to manage for search and extract —
it's a local-file indexing problem. That makes the core of Session Bandit
cheap, offline, and fast.

## Features

- **Unified search** across all your agent sessions — by project, date,
  model, content, or tool call.
- **Extract information** from sessions: summaries, "what did I do in project
  X last week", "which sessions touched file Y", "show me the failed tool
  runs".
- **Usage dashboard**: tokens per model per day, session counts, longest
  session, busiest hours — and, where possible, remaining subscription quota.

## Status

Early idea stage. See
[`projects/sessionbandit/session-bandit-a-tool-to-manage-all-your-coding-agent-sessions.md`](https://docs.botbandit.dev)
for the full product description and feasibility notes.