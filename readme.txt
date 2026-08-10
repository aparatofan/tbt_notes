=== TBT Notes ===
Contributors: thebluetree
Requires at least: 6.0
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 1.3.1
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
