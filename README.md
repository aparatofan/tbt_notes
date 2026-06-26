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

### Display modes: overlay vs. page

The same workspace runs in two modes:

- **Overlay mode (default)** — the launcher slides out a fixed, full-screen panel
  over the current page; the background page is scroll-locked. Use the
  `[tbt_notes]` shortcode to add an opener button anywhere.
- **Page mode** — the workspace renders **inline as normal page content** so the
  browser window scrolls naturally (no overlay, launcher, scroll-lock or modal
  behaviour). Add the **`[tbt_notes_page]`** shortcode to a page.

To set up page mode, create a WordPress page (suggested title **TBT Notes**, slug
`tbt-notes`) whose content is just:

```
[tbt_notes_page]
```

On that page the floating launcher and footer overlay are automatically
suppressed (so IDs never duplicate), the app boots already-open, and there is no
close button. The mode is driven by `data-tbt-mode="page"` on the root element;
the front-end script branches on it. Page mode is the foundation for a future
student-facing / PWA app. Overlay mode keeps working on all other pages.

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

### Highlight keyboard shortcuts (editor)

While the Quill editor has focus, highlight the selection without leaving the
keyboard:

| Shortcut | Highlight                  |
| -------- | -------------------------- |
| `Alt+1`  | Useful expression (blue)   |
| `Alt+2`  | Mistake / correction (red) |
| `Alt+3`  | Important idea (yellow)    |
| `Alt+4`  | Pronunciation (pink)       |
| `Alt+5`  | Grammar (green)            |
| `Alt+0`  | Clear highlight            |

Shortcuts only fire inside the editor — they never interfere with the lesson
title, search fields, the filter dropdown, or anything else on the page.

### Pronunciation audio (ElevenLabs)

Pink **Pronunciation** highlights can have spoken audio. Under **Show:
Pronunciation**, the teacher sees each pink phrase with a **Generate audio**
button; clicking it calls a server-side WordPress REST route that asks
ElevenLabs to synthesise the phrase, saves the MP3 under
`wp-content/uploads/tbt-notes-pronunciation/`, and returns a Play button.
Students viewing the same filter see **only** phrases that already have audio,
with a Play button — they can never trigger generation. Audio appears solely in
the Pronunciation filter, never in the full note.

Generation is deliberately conservative: it is teacher-only and manual,
already-generated audio is cached and reused (keyed by lesson + voice + text),
the requested text must currently be highlighted pink in that lesson, phrases
over 200 characters are rejected, and each teacher is capped at 30 generations
per hour.

**Configure the API key server-side** (it is never exposed to the browser).
Either define a constant in `wp-config.php`:

```php
define( 'TBT_NOTES_ELEVENLABS_API_KEY', 'your-key-here' );
```

…or return it from a filter (handy with a Code Snippets plugin):

```php
add_filter( 'tbt_notes_elevenlabs_api_key', function () {
    return 'your-key-here';
} );
```

Without a key, generation reports "ElevenLabs API key is not configured." and no
request is made.

### AI expression cards — OpenAI

Blue **Useful expression** highlights can become small editable English–Polish
flashcards. Under **Show: Useful expression**, the teacher sees each blue phrase
with a **Generate card** button; clicking it calls a server-side WordPress REST
route that asks OpenAI to produce a natural Polish translation plus one clear
B1/B2 English example, then stores the result as a **draft** card.

The teacher stays the quality-control gate. A draft card can be **edited** (both
the Polish translation and the example are editable text fields), **regenerated**
(a fresh OpenAI call that resets the card to draft), and **approved**. Students
viewing the same filter see **only approved cards** — never drafts, never the
generation controls, and never anything in the full note view. If an expression
is no longer highlighted blue, it drops out of the current list.

Generation is deliberately conservative and mirrors the pronunciation feature: it
is teacher-only and manual, the requested text must currently be highlighted blue
in that lesson, expressions over 200 characters are rejected, each teacher is
capped at 50 generations per hour, and the OpenAI key is **server-side only** —
it is never exposed to the browser. No AI generation ever happens for students.

The call uses the OpenAI **Responses API** with **Structured Outputs** (a strict
JSON schema), defaulting to the small `gpt-5.4-nano` model.

**Configure the key and (optionally) the model server-side.** The preferred setup
is a Code Snippets plugin:

```php
add_filter( 'tbt_notes_openai_api_key', function () {
    return 'your-key-here';
} );

add_filter( 'tbt_notes_openai_model', function () {
    return 'gpt-5.4-nano';
} );
```

…or define constants in `wp-config.php`:

```php
define( 'TBT_NOTES_OPENAI_API_KEY', 'your-key-here' );
define( 'TBT_NOTES_OPENAI_MODEL', 'gpt-5.4-nano' );
```

Without a key, generation reports "OpenAI API key is not configured." and no
request is made.

### AI Quick Note — OpenAI

A small **✨ Ask AI** helper lives inside the lesson editor (teacher only). The
teacher opens it by typing **`/ai`** in the note (the trigger text is removed
automatically) or by clicking the **✨ Ask AI** button on the editor toolbar. A
compact panel appears near the cursor with a prompt box, optional preset chips
(**Define, Translate, Example, Flashcard, Questions, Compare**), and a submit
button.

On submit, the prompt goes to a server-side WordPress REST route
(`POST /wp-json/tbt-notes/v1/ai-quick-note`) which calls the OpenAI **Responses
API** and returns a short, lesson-friendly answer. The answer appears in a calm
light-blue **response card** with three actions: **Insert** (drops the answer
into the note at the cursor, preserving line breaks), **Regenerate** (asks
again), and **Discard**. Loading shows *Thinking…*, and any failure shows a
friendly message without breaking the editor.

Like the other AI features it is teacher-only and server-side: the request is
gated by the `manage_tbt_notes` capability, prompts over 2000 characters are
rejected, each teacher is capped at **20 requests per hour**, and the OpenAI key
is **never** exposed to the browser.

Per the project's API-key decision this feature reads its **own** constants from
a server-side PHP snippet (do **not** edit `wp-config.php`):

```php
// ============================================
// TBT AI Quick Note — Configuration
// ============================================
define( 'TBT_AI_QUICK_NOTE_API_KEY', 'PASTE_TBT_AI_QUICK_NOTE_KEY_HERE' );
define( 'TBT_AI_QUICK_NOTE_MODEL', 'gpt-4.1-mini' );
```

Filters (`tbt_ai_quick_note_api_key`, `tbt_ai_quick_note_model`) are also
available. If only the shared `TBT_NOTES_OPENAI_API_KEY` is configured (for the
expression cards), AI Quick Note falls back to it so a single key powers every AI
feature. Without any key, the helper reports that AI is not available and no
request is made.

> **Note awareness is intentionally minimal in this MVP.** The endpoint already
> accepts `noteContext`, `noteTitle`, and `selectedText`, but the editor does not
> send them yet — using the note as context is a deliberate future step.

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
  class-tbt-notes-pronunciation.php  Pink-highlight ElevenLabs audio (extract/cache/generate)
  class-tbt-notes-expression-cards.php  Blue-highlight OpenAI expression cards (extract/generate/approve)
  class-tbt-notes-ai-quick-note.php  In-editor "Ask AI" prompt → OpenAI (presets/rate-limit)
  class-tbt-notes-rest.php        REST API + permission/ownership checks
  class-tbt-notes-frontend.php    Asset loading + panel markup
assets/
  css/tbt-notes.css               Panel, read view, editor chrome, highlights
  js/tbt-notes.js                 The panel app (vanilla JS) + autosave
  vendor/quill/                   Self-hosted Quill 2 (BSD-3-Clause)
tests/test-logic.php              Sanitiser, visibility, pronunciation, expression-card + AI Quick Note tests
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
