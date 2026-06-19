# TBT Notes

A WordPress plugin for **The Blue Tree (TBT)**. A teacher writes per-class lesson
notes; each logged-in student sees **only** the notes for the class they are
assigned to, in a slide-out side panel on the TBT site.

It replaces an external notes tool (OneNote / Notion). The point is ownership and
control: notes live on the TBT domain, behind TBT login, with no third-party
platform in the way. The bundled editor (Quill) is self-hosted — there is **no
runtime dependency on any external CDN or service**.

## How it works

- A **notes launcher** sits on the left edge of every front-end page (for
  logged-in users). Clicking it slides out a panel.
- **Students** see a read-only view: their one class → a list of lessons (newest
  on top) → a formatted, read-only lesson.
- The **teacher** sees the same panel, but with inline management: create/rename/
  delete classes, assign a student, add/edit/delete lessons, and write notes in a
  rich-text editor that **autosaves as you type**.

### The security model (visibility rule)

A student can see a class **if and only if** they are the assigned student for
that class. The teacher/admin sees everything. This is enforced **server-side**
in the REST API (`includes/class-tbt-notes-rest.php`), not just hidden in the UI:

- Every write route requires the `manage_tbt_notes` capability.
- Read routes verify ownership in their permission callback **before** the handler
  runs (`TBT_Notes_REST::user_can_view_class()`).
- Notes are stored in **custom tables**, not custom post types, so nothing leaks
  through WordPress's public surfaces (REST defaults, search, archives, feeds,
  sitemaps). Every read goes through one ownership check.

### Roles & granting teacher access

Permissions hang off a single capability, `manage_tbt_notes`. Administrators can
always manage notes. To let a **non-admin teacher** account manage notes (the
usual case — you run lessons logged in as the teacher, not as an admin), go to
**wp-admin → TBT Notes** and enter that account's username under *"Teacher
accounts."* That grants the capability to those specific users without elevating
everyone who shares their role. A whole role can be granted too (advanced), and
the `tbt_notes_managing_roles` filter still works for code-level control.

## Formatting

The lesson body supports exactly what v1 requires (and nothing more):

- **Bold**, *italic*, underline, strikethrough
- **Semantic highlights** in five teacher-defined categories (stored as
  colour-based classes such as `tbt-hl-blue`, not inline styles):
  - Useful expression — blue
  - Mistake / correction — red
  - Important idea — yellow
  - Pronunciation — pink
  - Grammar — green
- **Highlight filtering** in the lesson view: show the full note, all
  highlights grouped by category, or one selected category extracted as a list.
  In the teacher editor the filter lives in the toolbar; for students it sits
  above the read-only note
- **Links** that always open in a new tab (`target="_blank" rel="noopener noreferrer"`)
- **Numbered and bulleted lists, including nesting** (1 → a → i …)
- **H2 headings and H3 subheadings** (clean sans-serif), plus **blockquotes**
- **Spacious body text** with generous line height — easy to read and to print
  with room for students' handwritten notes between lines

Saved HTML is sanitised on the server with a tight `wp_kses` allowlist plus a
normalisation pass (safe links, highlight-only classes). No images, no inline
styles, no script.

## Installation

1. Copy this repository's contents into `wp-content/plugins/tbt-notes/` (the repo
   root *is* the plugin), or zip it and upload via **Plugins → Add New → Upload**.
2. Activate **TBT Notes**. Activation creates the database tables and grants the
   `manage_tbt_notes` capability to administrators.
3. Log in as the teacher/admin, open the notes panel from the left edge, create a
   class, assign a student, and start writing.

No build step is required — the editor is vendored in `assets/vendor/quill/`.

## Project layout

```
tbt-notes.php                     Plugin bootstrap, constants, activation/upgrade
uninstall.php                     Drops tables + capability on delete (only)
includes/
  class-tbt-notes-plugin.php      Orchestrator
  class-tbt-notes-db.php          Custom tables + all queries ($wpdb->prepare)
  class-tbt-notes-capabilities.php Capability (role-based) management
  class-tbt-notes-sanitizer.php   Body/text sanitisation (the kses allowlist)
  class-tbt-notes-rest.php        REST API + permission/ownership checks
  class-tbt-notes-frontend.php    Asset loading + panel markup
assets/
  css/tbt-notes.css               Panel, read view, editor chrome, highlights
  js/tbt-notes.js                 The panel app (vanilla JS) + autosave
  vendor/quill/                   Self-hosted Quill 2 (BSD-3-Clause)
tests/test-logic.php              Sanitiser + visibility-rule tests
```

## Data model

- **Class** — free-text `title` with **many students** (a group). Membership is a
  separate table; each student belongs to **at most one** class (enforced by the
  membership table's primary key + a friendly server-side check).
- **Lesson** — belongs to a class; has a teacher-typed free-text `header` and a
  rich-text `body`. Listed newest-first by creation time.

## Running the tests

```
php tests/test-logic.php
```

These cover the sanitiser's normalisation (safe links, highlight-only classes,
`&nbsp;` handling) and the visibility rule (a student sees only their own class).
WordPress is not required — the few WP functions used are stubbed.

## Not in v1 (by design)

Images in notes, a homework section, multi-teacher UI, live sync during lessons,
games/streaks/import-export, student editing/comments, version history, and
soft-delete are intentionally excluded.
