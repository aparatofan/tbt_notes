# TBT Notes — Claude Code guidance

Keep this file concise. It is loaded at the start of every Claude Code session.

## Start here

- Work from the task, not from a full-repository scan.
- Inspect `git status`, then search for the relevant route, class, DOM selector, shortcode, or hook.
- Read only the files and sections required for the task.
- `README.md` is extensive; do not load it by default. Use it only for architecture or product context the task actually needs.
- Use `docs/` selectively. Do not read the whole directory as orientation.
- Do not change unrelated behavior, copy, formatting, or styling.

## Project basics

- WordPress plugin; PHP 7.4+.
- PHP + vanilla JavaScript; Quill is vendored/self-hosted. No application build step is required.
- Bootstrap: `tbt-notes.php`.
- Server-side code: `includes/`.
- Main browser code: `assets/js/tbt-notes.js` and `assets/css/tbt-notes.css`.
- Logic test suite: `tests/test-logic.php`.
- Notes are stored in custom database tables, not public post types.

## Architecture to preserve

- The same Notes workspace has two modes: Overlay Mode and Page Mode. A fix for one must not casually change the other.
- Page Mode uses the canonical shared TBT design system. Overlay Mode still contains plugin-local `--tbtn-*` styling as a deliberate legacy boundary; do not migrate or merge the two style worlds unless the task explicitly asks for it.
- Students may view only classes they belong to. Teachers manage only classes they own. Administrators may oversee all classes.
- Ownership and visibility are enforced server-side in REST permission logic; UI hiding is never the security boundary.
- The generic class-extras extension point is vendor-neutral. Do not make Notes depend on a specific contributing plugin merely because one currently uses it.
- Optional integrations and AI helpers must fail gracefully when unavailable.
- Database/schema migrations are explicit. Bump the DB version only for real schema changes; do not invent backfills for historical data unless required.

## Shared TBT design system

- TBT-Hub is the canonical owner of `tbt-tokens` and `tbt-components`.
- Notes may use vendored fallbacks under `assets/vendor/tbt/` only when Hub has not provided the shared handles.
- Shared fallback copies must remain byte-identical to the Hub originals. Plugin-specific styling belongs in Notes' own CSS.
- Treat changes to shared-token usage as cross-plugin work with a larger blast radius than a local visual tweak.

## Security and data rules

- Never expose or commit OpenAI, ElevenLabs, FTP, or other credentials or real configuration values.
- AI/audio requests and keys remain server-side.
- Preserve REST nonce/capability/ownership checks on writes and permission callbacks on reads.
- Keep saved note HTML behind the existing tight sanitization/normalization boundary; do not loosen the allowlist casually.
- Preserve rate limits, input-length limits, and teacher-only controls where they exist.
- Student self-generation does not imply student editing/approval rights.

## Coding style

- Follow surrounding WordPress/PHP style and existing `TBT_Notes_*` naming.
- Prefer existing helpers and extension points over parallel implementations.
- Avoid broad refactors while fixing a local bug.
- Preserve print behavior, keyboard accessibility, focus management, and reduced-motion behavior when touching related UI.
- Do not add external runtime dependencies or CDNs.

## Validation

Run the logic suite for PHP/domain changes:

```bash
php tests/test-logic.php
```

For JavaScript changes:

```bash
node --check assets/js/tbt-notes.js
```

For changed PHP files, run `php -l <file>`; for broad PHP changes, lint all PHP files.

Many behaviors depend on real WordPress, Divi, print dialogs, permissions, or third-party APIs. State explicitly what still requires a live-site/browser check instead of claiming full coverage from local tests.

## Git and deployment

- Do not commit directly to `main`; use a focused feature branch unless explicitly instructed otherwise.
- Inspect the final diff before finishing.
- This repository's FTPS deployment workflow is **manual** (`workflow_dispatch`); merging to `main` does not itself deploy Notes.
- Deployment excludes Markdown, `docs/`, and `tests/`.
- Never alter deployment credentials or server paths unless the task is specifically about deployment.

## Context discipline

- Prefer targeted search + narrow reads over broad exploration.
- Avoid pasting large README sections, logs, API responses, or test output into the conversation when a short summary is sufficient.
- At task completion, summarize the change, checks run, and remaining manual verification in a few bullets.
- Start a fresh Claude Code session for a new unrelated task rather than carrying unnecessary history forward.
