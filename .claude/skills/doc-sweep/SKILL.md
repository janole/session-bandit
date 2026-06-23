---
name: doc-sweep
description: 'Reconcile Session Bandit''s long-lived docs against recent code changes. Reads each doc''s "Last updated:" cursor, diffs git since then, and applies targeted edits to the PRD, architecture decision log, adapter guides, extract design, README files, and the Session Bandit skill. Invoke with /doc-sweep [window], e.g. /doc-sweep 1w. Use when the user asks to "sync docs", "update the docs", "catch the docs up", or after merging a chunk of work.'
---

# doc-sweep

Periodic reconciliation of Session Bandit's long-lived documentation against
what actually shipped. This is a **backstop for drift**, not a replacement for
updating docs in the same change that modifies a public contract.

## Argument

`/doc-sweep [window]` — optional. A git-friendly window like `1d`, `3d`, `1w`,
`2w`, or an ISO date `2026-05-17`. When omitted, use **each doc's own
`Last updated:` stamp** as its cursor where present, falling back to `2w` for
docs that have no stamp.

## Doc registry

Sweep these docs. For each, only commits touching its **scope globs** are
relevant — ignore the rest of the changeset for that doc.

| Doc | Scope globs |
|---|---|
| `README.md` | `packages/core/src`, `packages/cli/src`, `packages/cli/README.md`, `skill/SKILL.md`, `package.json` |
| `packages/cli/README.md` | `packages/cli/src`, `packages/core/src/digest.ts`, `packages/core/src/diagnose.ts`, `package.json` |
| `docs/prd.md` | `packages/core/src`, `packages/cli/src`, `package.json`, `pnpm-workspace.yaml` |
| `docs/decisions.md` | `packages/core/src`, `packages/cli/src`, `eslint.config.mjs`, `package.json` |
| `docs/adapters.md` | `packages/core/src/adapter.ts`, `packages/core/src/adapters`, `packages/core/src/types.ts`, `packages/core/test/adapters`, `packages/core/test/fixtures` |
| `docs/format-claude.md` | `packages/core/src/adapters/claude.ts`, `packages/core/test/adapters/claude.test.ts`, `packages/core/test/fixtures/claude` |
| `docs/format-codex.md` | `packages/core/src/adapters/codex.ts`, `packages/core/test/adapters/codex.test.ts`, `packages/core/test/fixtures/codex` |
| `docs/extract.md` | `packages/core/src/digest.ts`, `packages/core/test/digest.test.ts`, `packages/cli/src`, `packages/cli/test/extract.test.ts` |
| `skill/SKILL.md` | `packages/cli/src`, `packages/cli/README.md`, `README.md` |

## Procedure

1. **Resolve the window** per the argument rule above. For per-doc mode, read
   the `Last updated:` line from each doc first. If a doc has no stamp, use
   `2w` for that doc.

2. **Build the changeset.** For each doc, run:
   ```bash
   git log --oneline --since=<window> -- <scope globs>
   ```
   Then inspect the relevant commits with `git show --stat` or focused diffs.
   Keep the review scoped to the doc's registry row.

3. **Judge relevance, then apply targeted edits.** Decide whether the changeset
   actually changes what the doc claims. Respect each doc's altitude:
   - `docs/prd.md` is product scope and acceptance criteria. Update it for
     changed scope, supported agents, CLI surface, package layout, or test/build
     contract. Do not add implementation trivia.
   - `docs/decisions.md` records stable rationale. Add or amend entries only
     when the underlying decision or trade-off changes.
   - `docs/adapters.md` is the adapter authoring contract and drift playbook.
     Update it when the normalized model, adapter interface, fixture workflow,
     or golden rules change.
   - `docs/format-*.md` are reverse-engineered format references. Update only
     when an observed agent format or parser behavior changes.
   - `docs/extract.md` is the digest and importance design. Update it when the
     digest shape, scoring, extraction heuristics, or prompt behavior changes.
   - `README.md`, `packages/cli/README.md`, and `skill/SKILL.md` are user-facing
     usage docs. Keep them accurate for install, commands, flags, and workflow.
   Make specific line or section edits. Never rewrite a doc wholesale.
   Preserve voice and existing structure.

4. **Bump the cursor.** Update each edited doc's `Last updated:` stamp to today.
   If an edited doc has no stamp and it is meant to be swept in future, add one
   near the top (`Last updated: YYYY-MM-DD.`).

5. **Check in-repo links.** Committed docs must be self-contained. Prefer
   relative links to files in this repo. Do not add references to local vault
   paths, private planning docs, or another repository's internal notes.

6. **Flag stale assumptions.** If the changeset shows a doc or comment now
   contradicts the code but fixing it would require a larger rewrite, call that
   out explicitly with the file and section. Do not silently leave known drift.

## Output & approval

- Lead with a short **summary of drift found** per doc, or "no drift" for clean
  docs.
- Apply doc edits directly; they are low-risk and reviewable in the diff.
- Do **not** commit unless the user explicitly asks.
- If a doc needs a large structural catch-up, say so and offer it as a focused
  follow-up rather than bloating one sweep.

## Notes

- Keep edits additive and linear.
- The `Last updated:` stamp is the contract that makes the sweep cheap. Do not
  drop it from docs that already have one.
- Tests and fixtures may intentionally contain old transcript shapes. Do not
  "modernize" fixture content unless the parser behavior being tested changes.
