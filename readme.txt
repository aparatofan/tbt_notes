=== TBT Notes ===
Contributors: thebluetree
Requires at least: 6.0
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 1.6.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Per-class lesson notes for The Blue Tree. A teacher writes notes; each student sees only their own class, in a slide-out side panel.

== Description ==

TBT Notes lets a teacher write per-class lesson notes and lets logged-in students
read the notes for the class they are assigned to, in a slide-out side panel.

* Students see a read-only view of their own class only (enforced server-side).
* The teacher manages classes, assigns a student, and writes notes inline with a
  rich-text editor that autosaves as you type.
* Formatting: bold, italic, three highlight colours, links (open in a new tab),
  and nested numbered/bulleted lists.
* The editor (Quill) is self-hosted — no external CDN or third-party service.

The visibility rule is the security model: a student sees a class if and only if
they are the assigned student. Notes are stored in custom tables so nothing leaks
through WordPress's public surfaces. Authoring rights are gated by the
`manage_tbt_notes` capability (granted to administrators), so a future teacher
role can be added without code changes.

== Installation ==

1. Upload the `tbt-notes` folder to `/wp-content/plugins/`, or install the zip via
   Plugins > Add New > Upload.
2. Activate the plugin through the Plugins menu. This creates the database tables
   and grants the management capability to administrators.
3. Log in as the teacher, open the notes panel from the left edge of the site,
   create a class, assign a student, and start writing.

== Frequently Asked Questions ==

= Can a student edit notes? =
No. Students have read-only access, enforced on the server.

= Can a student be in more than one class? =
No. Each student is assigned to at most one class (v1 design).

= Are notes lost if the browser closes mid-lesson? =
No. The editor autosaves as the teacher types.

== Changelog ==

= 1.6.2 =
* An armed highlight colour now survives Enter: pressing Enter with a colour
  armed starts the new line in that colour instead of dropping back to plain
  text while the margin dot stayed lit. Only Escape, Alt+0, the clear control
  in the margin palette or re-clicking the armed swatch disarm.

= 1.6.0 =
* The five highlight colours gain a second way to be used: with nothing
  selected, clicking a swatch (or pressing Alt+1-5) arms that colour, and
  everything typed from then on comes out highlighted until the colour is
  changed or cleared. Selecting text and clicking a swatch still works exactly
  as before.
* A faint dot in the editor's left margin tracks the current line and shows
  which colour is armed. Clicking it opens the same five colours plus a clear
  control. Alt+0 and Escape disarm.

= 1.5.0 =
* The class settings screen is rebuilt on the shared TBT components: one centred
  panel on the page canvas, interface text in Roboto, and canonical fields,
  chips and buttons instead of full-bleed inputs on white.
* Creating a class now has an explicit "Create class" step and a "Class created"
  confirmation panel, with "Open class" and "Back to classes" as the next moves.
  Editing an existing class saves in place and confirms with a brief Saved tag.
* Delete class has moved out of the main action row: it is now a quiet text
  button below the panel rather than a full-width red block.

= 1.3.11 =
* A seventh Ask AI shortcut, Collocations. Type a word and get five natural
  B2/C1 collocations, each with a short meaning and an example sentence, ready
  to drop into the note. Text only — same formatting as the other shortcuts.

= 1.3.6 =
* Class-card gradients now vary in direction as well as hue: the same eight
  two-hue pairs across four diagonals, so a wall of cards has 32 looks instead
  of 8. Note that existing class tiles will change gradient, because the
  mapping changed. Nothing else changes — the gradient is decoration and
  carries no meaning.

= 1.3.5 =
* Page Mode: the "+ NEW" lesson button now reads as the same button as
  "+ NEW CLASS", one size smaller, instead of an outline variant. Overlay mode
  is unchanged.

= 1.3.4 =
* Page Mode: a Back to top button in the class strip, next to Show / hide
  lessons. It is always visible rather than appearing on scroll, like the other
  strip controls, and is available to students as well as teachers. It does not
  print.

= 1.3.3 =
* The class strip reads as one line: the lesson header is the same size as the
  class name (22px) instead of a step smaller, and the class name is TBT blue
  while the lesson header stays ink. Both still take the content face, and the
  lesson header keeps its hover/focus treatment so it still reads as editable.

= 1.3.2 =
* The bundled fallback copy of the shared design tokens is back in step with
  TBT-Hub, which now ships and registers the canonical file. The decorative
  palette Notes had been carrying ahead of Hub is part of the shared set, so
  the local copy no longer runs ahead of anything. Nothing changes on screen.

= 1.3.1 =
* Fixed: the class strip's buttons rendered as empty boxes. Page Mode's icon
  colour was losing to the overlay header's white rule, and the print glyph
  (U+2399) is missing from almost every system font. The strip, lesson list and
  class cards now use one drawn icon set that follows hover and focus colours.
* Fixed: the class search field rendered flat white, because the theme styles
  inputs more specifically than the shared `.tbt-input` class. It now shows the
  canonical field surface used across the tools.
* The hero title is larger (40px) and the supporting text takes two lines; the
  `tbt_notes_hero_support` filter accepts one line or several.
* Class-card gradients are richer: two-hue blends across a wider decorative
  palette, and a new hash so consecutive classes no longer step through the
  colours in order.

= 1.3.0 =
* Page Mode (`[tbt_notes_page]`) now matches the canonical TBT design system.
  The plugin renders the shared Tool Hero itself, so the temporary page-builder
  header above the shortcode can be deleted; the eyebrow, title and supporting
  line are all filterable (`tbt_notes_hero_eyebrow`, `tbt_notes_hero_title`,
  `tbt_notes_hero_support`).
* The stylesheet now declares the shared `tbt-components` stylesheet as an
  enqueue dependency, with a bundled fallback registered under the same handle
  if TBT-Hub is inactive (an admin notice says so).
* Plugin-local CSS variables moved out of the shared `--tbt-*` namespace to
  `--tbtn-*`, so Notes can no longer repaint another TBT tool's tokens. The five
  highlight colours keep legacy `--tbt-hl-*` aliases for existing note bodies.
* Class cards use the four TBT domain colours only (decorative identity, never a
  category), with content-face titles in ink rather than blue uppercase.
* On a class view, the class title strip and the editor toolbar now pin below the
  site's fixed menu instead of sliding underneath it, and the class name stays
  visible at every scroll position. The offset is recomputed while scrolling, so
  a menu that shrinks on scroll no longer leaves a gap.

= 1.1.0 =
* Notes now open as a full-screen workspace: the background page no longer
  scrolls while notes are open, and only the notes content scrolls.
* New notes are pre-filled with a default lesson-notes template and a generated,
  editable title ("[class] — Lesson Notes — [date]", or "[class] — [lesson]").
* The browser tab title now reflects the open note so TBT Notes tabs are easy to
  pick out when screen-sharing in Microsoft Teams.
* Lesson Notes launcher is now a round icon button (TBT Blue, white icon) that
  links to the Page Mode workspace and reveals its label with a slide-in-from-left
  animation on hover.
* Classes page redesigned as a responsive grid of branded gradient cards (with a
  decorative TBT logo, class title, and student/note counts), a smaller New class
  button near the header, and clearer spacing below the search field.

= 1.0.0 =
* Initial release: classes, lessons, single-student assignment, server-side
  visibility rule, slide-out panel, Quill editor with autosave.
