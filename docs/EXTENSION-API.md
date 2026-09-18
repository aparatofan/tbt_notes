# TBT Notes — extension API

A contributing plugin is not a trusted source, and neither is Notes. Notes
re-checks everything handed to it through the extras filter; this document is
the other half of that bargain, and everything Notes hands back through the API
below is an **answer**, never a grant. A caller that reads a row and shows it
without checking the flags on it has a security bug of its own making.

Notes opens two doors and stops there:

1. A read-only PHP API for asking who may see what.
2. An empty slot under a student's note, plus an event when the view changes,
   so another plugin can mount something there.

Everything else — routes, tables, UI, policy — belongs to the plugin that calls
these. Notes stores nothing on anyone else's behalf.

Available since **TBT Notes 1.18.0**.

---

## What this API is not

- **It is not a permission.** `tbt_notes_lesson_context()` returns a row for a
  lesson that exists, whether or not the caller may see it. The `can_view` and
  `can_manage` flags are the answer; the presence of the row is not.
- **It never writes.** There is no write API and there will not be one. Another
  plugin never writes through Notes — it keeps its own rows in its own tables.
- **It grants nothing and caches nothing.** Every call is resolved fresh from
  Notes' own tables through Notes' own ownership rule.
- **It is not a substitute for your own checks.** Validate on your own route,
  server-side, on every request. Do not trust an id posted from a browser
  because a slot in the page carried it.

The ownership rule itself lives in exactly one place —
`TBT_Notes_REST::user_can_view_class()` and `::user_can_manage_class()`. This
API delegates to those helpers rather than restating them, so a change to the
rule reaches every caller at once. Do not copy the rule into your plugin.

---

## PHP API

Three file-level functions, all `function_exists`-guarded, all read-only. Each
takes `$user_id = 0` meaning "the current user".

Notes may not be active. Guard your calls:

```php
if ( ! function_exists( 'tbt_notes_lesson_context' ) ) {
    return; // Notes is not installed or is older than 1.18.0.
}
```

### `tbt_notes_lesson_context( int $lesson_id, int $user_id = 0 ): ?array`

Does this lesson exist, and what may this user do with it? This is the
submit-time question.

```php
array(
    'lesson_id'    => 412,
    'class_id'     => 12,
    'lesson_title' => 'Kat — 18 September',   // the lesson's header
    'class_title'  => 'Kat',
    'created_at'   => '2026-09-18 09:12:00',
    'can_view'     => true,   // a student in the class, or its manager
    'can_manage'   => false,  // the teacher/admin side
)
```

- Returns `null` when the lesson does not exist (including a lesson id of `0`
  or below).
- A lesson that exists but is **not the caller's** returns the full row with
  **both flags `false`**. The row is not permission to display it — read the
  flags.
- A lesson whose class has since been deleted returns the row with both flags
  `false` and an empty `class_title`: there is no class row left to prove
  membership or ownership against.
- `can_view` is true for a student in the class, for the teacher who owns it,
  and for an administrator. `can_manage` is true for the owning teacher and for
  an administrator.

### `tbt_notes_class_ids_for_manager( int $user_id = 0 ): array`

The class ids this user manages — their own classes, or every class for an
administrator.

```php
array( 12, 14, 17 )
```

- Empty for a student. Empty for a logged-out visitor.
- This is how a teacher-side queue works without touching a Notes table: store
  `class_id` on your own rows, then query your own table restricted to the ids
  this returns.

### `tbt_notes_lessons_brief( array $lesson_ids, int $user_id = 0 ): array`

Display titles in bulk, for a queue or a dossier holding many rows. Keyed by
lesson id:

```php
array(
    412 => array(
        'lesson_title' => 'Kat — 18 September',
        'class_id'     => 12,
        'class_title'  => 'Kat',
        'created_at'   => '2026-09-18 09:12:00',
    ),
)
```

- Ids the user may not view are **omitted from the result**, not returned
  empty. An absent key means "not yours, or not there", and a caller listing its
  own rows therefore cannot leak a title by accident. Fall back to your own
  wording for a missing key rather than showing a blank line.
- At most **200** ids per call; anything past that is ignored. Duplicates
  collapse and non-positive ids are dropped.
- The class row and its roster are resolved once per distinct class rather than
  once per lesson, so a page of submissions from one or two classes stays cheap.

### Worked example — validating a submission

A companion plugin's own REST route, accepting a student's homework against a
lesson. Notes answers who may see the lesson; the route decides everything else.

```php
public function submit( WP_REST_Request $request ) {
    $lesson_id = (int) $request['lesson_id'];

    if ( ! function_exists( 'tbt_notes_lesson_context' ) ) {
        return new WP_Error( 'no_notes', 'Notes is unavailable.', array( 'status' => 503 ) );
    }

    // Resolved for the CURRENT user, server-side. The ids came from a browser
    // and prove nothing on their own.
    $ctx = tbt_notes_lesson_context( $lesson_id );

    if ( null === $ctx ) {
        return new WP_Error( 'no_lesson', 'That note does not exist.', array( 'status' => 404 ) );
    }
    if ( ! $ctx['can_view'] ) {
        return new WP_Error( 'forbidden', 'Not your note.', array( 'status' => 403 ) );
    }
    if ( $ctx['can_manage'] ) {
        // A teacher does not submit homework to themselves.
        return new WP_Error( 'forbidden', 'Teachers do not submit.', array( 'status' => 403 ) );
    }

    // $ctx['class_id'] comes from Notes, not from the request — store that one,
    // so the teacher's queue can later be filtered by class id safely.
    return $this->store( get_current_user_id(), (int) $ctx['class_id'], $lesson_id, $request['text'] );
}
```

Note what the example does **not** do: it does not read `class_id` from the
request, and it does not decide visibility itself.

---

## The slot and the event

### The slot

When a **student** has a note open, Notes renders one empty element as a
sibling of the note's content area:

```html
<div class="tbt-notes-slot"
     data-tbt-slot="lesson-foot"
     data-class-id="12"
     data-lesson-id="412"></div>
```

- **Students only.** The teacher's editor view gets no slot.
- **Both modes.** Page Mode and Overlay Mode both render it.
- **No lesson, no slot.**
- **Empty and unstyled.** Notes adds no CSS and reserves no space; the plugin
  that mounts into it owns every pixel it then shows.
- It is a **sibling** of the content area, not a child, so pressing a highlight
  filter — which clears and refills that content area — never destroys what you
  mounted.

### The event

After the view is rendered, and only when a slot exists, Notes dispatches on
`document`:

```
tbt-notes:lesson-view
detail: { classId: 12, lessonId: 412 }
```

**There is no deduplication.** It fires on every render that emits a slot, even
for the same lesson, because every render builds a *fresh* slot element. Your
consumer must re-mount into the new node each time — a node you mounted into on
a previous render is no longer in the document.

The event carries ids, not DOM nodes. Query for the slot yourself.

### What a consumer does

```js
document.addEventListener( 'tbt-notes:lesson-view', function ( e ) {
    var slot = document.querySelector( '[data-tbt-slot="lesson-foot"]' );
    if ( ! slot ) {
        return;
    }
    mountMyForm( slot, {
        classId: e.detail.classId,
        lessonId: e.detail.lessonId
    } );
} );
```

That is the whole contract. The ids you get here are a hint about what to
render; your own route still resolves them server-side through
`tbt_notes_lesson_context()` before it trusts them.

---

## Related, and deliberately separate

`tbt_notes_class_extras` is a different door: it contributes links into the
class sidebar, and Notes re-sanitises everything it returns. It is unaffected by
this API and neither one replaces the other.
