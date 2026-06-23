=== TBT Notes ===
Contributors: thebluetree
Requires at least: 6.0
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 1.1.0
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

= 1.1.0 =
* Notes now open as a full-screen workspace: the background page no longer
  scrolls while notes are open, and only the notes content scrolls.
* New notes are pre-filled with a default lesson-notes template and a generated,
  editable title ("[class] — Lesson Notes — [date]", or "[class] — [lesson]").
* The browser tab title now reflects the open note so TBT Notes tabs are easy to
  pick out when screen-sharing in Microsoft Teams.
* Lesson Notes launcher button: white text and icon on the blue background.
* Classes page redesigned as a responsive grid of branded gradient cards (with a
  decorative TBT logo, class title, and student/note counts), a smaller New class
  button near the header, and clearer spacing below the search field.

= 1.0.0 =
* Initial release: classes, lessons, single-student assignment, server-side
  visibility rule, slide-out panel, Quill editor with autosave.
