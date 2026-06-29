# Coding Sessions

This is the default Session Bandit GitHub Pages template. It renders exported
Markdown sessions as polished public pages while keeping the source artifacts
reviewable in git.

## Publish a Session

```sh
mkdir -p sessions/apple-watch-interface
session-bandit redact-check <sessionId> --pretty
session-bandit export-md <sessionId> \
  --out sessions/apple-watch-interface/index.md \
  --report-out sessions/apple-watch-interface/redaction-report.json \
  --title "Apple Watch interface"
```

Review both files before committing or pushing. Automated redaction is
best-effort, not proof of safety.

## GitHub Pages

Enable Pages for the repository in GitHub settings. Use the `main` branch and
the repository root as the publishing source.

The template uses Jekyll defaults in `_config.yml` so files under
`sessions/<slug>/index.md` automatically use the session layout.

## Design Fixture

Open `.design/session-page.html` directly in a browser to test layout changes
without running Jekyll or publishing to GitHub Pages. It uses the same CSS as
the real site and includes long titles, metadata, inline code, and tool output
that should not create horizontal page scroll.
