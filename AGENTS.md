# AGENTS.md

## Quality Gate

Before finishing any code, package metadata, fixture, or behavior-affecting
change, run:

```bash
pnpm run ok  # => build + lint:fix + test
```

For documentation-only changes, do not run the full gate by default.

## Package Overview

- `packages/core` - Session indexing, adapters, normalized model, diagnostics,
  and digest generation.
- `packages/cli` - The `session-bandit` command-line interface over
  `@session-bandit/core`.
- `skill` - The installable agent skill that teaches agents how to use the CLI
  for handoffs, memory notes, and session search.
- `docs` - Product, design, adapter, and format reference documentation.

## Architecture Guardrails

- Keep the CLI thin. Parsing, indexing, diagnostics, and digest logic belong in
  `packages/core`; `packages/cli` should mostly validate options, call core, and
  format output.
- The normalized `Session` / `Message` / `ToolCall` model is the boundary
  between agent-specific adapters and every consumer. Avoid leaking raw Claude
  or Codex shapes outside adapter modules.
- Adapters must be resilient to format drift: skip malformed or unrecognized
  input, never abort a scan because one session file is odd, and add fixtures for
  newly observed shapes.
- Tests must not read live `~/.claude`, `~/.codex`, or other private session
  directories. Use fixtures under `packages/core/test/fixtures/**` and injected
  scan functions in CLI tests.
- Keep the project offline by default. Do not add network calls, auth, native
  dependencies, persistence, or background indexing unless the user explicitly
  asks for that scope.

## Style

- TypeScript strict mode is authoritative.
- Follow the existing ESLint/style rules: Allman braces, sorted imports,
  4-space indent, double quotes, and semicolons.
- Prefer explicit, small functions over speculative abstractions.
- Add or update tests when behavior changes.
- Add a one-liner JSDoc comment (`/** ... */`) to every exported function, type,
  and class — skip only when the name alone is unambiguous (e.g. `isRecord`).
- Keep comments concise and focused on non-obvious intent.
- Do not rewrite existing code for style. Only touch code that is directly
  required by the task.
- Do **not** remove TODO comments unless they are implemented or fixed.
- Do **not** remove unrelated uncommented code.

## Documentation

- Keep committed docs self-contained. A reader should not need private plans,
  local notes, or another repository to understand the rationale.
- When adapter behavior or transcript format knowledge changes, update the
  relevant format reference in `docs/format-*.md`.
- When CLI flags or output behavior changes, update `README.md`,
  `packages/cli/README.md`, and `skill/SKILL.md` as appropriate.
- Use `.claude/skills/doc-sweep` for periodic documentation drift checks.
