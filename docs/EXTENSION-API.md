# TBT Notes — extension API

A contributing plugin is not a trusted source, and neither is Notes. Notes
re-checks everything handed to it through the extras filter; this document is
the other half of that bargain, and everything Notes hands back through the API
below is an **answer**, never a grant. A caller that reads a row and shows it
without checking the flags on it has a security bug of its own making.

Notes opens two doors and stops there:

1. A PHP API for asking who may see what — read-only, except for one write to
   the activity log (since 1.22.0).
2. An empty slot under a student's note, plus an event when the view changes,
   so another plugin can mount something there.

Everything else — routes, tables, UI, policy — belongs to the plugin that calls
these. Apart from activity-log rows recorded through
`tbt_notes_record_activity()`, Notes stores nothing on anyone else's behalf.

Available since **TBT Notes 1.18.0**. `tbt_notes_record_activity()` and the
`tbt_notes_activity_recorded` action are available since **TBT Notes 1.22.0**.

---

## What this API is not

- **It is not a permission.** `tbt_notes_lesson_context()` returns a row for a
  lesson that exists, whether or not the caller may see it. The `can_view` and
  `can_manage` flags are the answer; the presence of the row is not.
- **It writes in one place only.** Since 1.22.0 another plugin may add a row to
  the activity log with `tbt_notes_record_activity()`. Every other part of this
  API stays read-only, and Notes still stores nothing else on anyone's behalf.
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

Four file-level functions, all `function_exists`-guarded. The three readers
each take `$user_id = 0` meaning "the current user". The fourth,
`tbt_notes_record_activity()`, is the only write and has no such default.

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

### `tbt_notes_record_activity( array $args ): int|WP_Error`

*Available since TBT Notes 1.22.0.*

Adds one row to the activity log (`{prefix}tbt_activity`) for a piece of
finished work. It exists for plugins that decide **on the server** that work is
finished — a submitted test attempt, a mark a teacher has given — and therefore
cannot use the browser route, which takes the user from the session. Returns the
new row's id, or a `WP_Error`.

| Key | Required | Notes |
|---|---|---|
| `user_id` | yes | The student. Must be > 0 and an existing user |
| `tool` | yes | Slug, as on the REST route (`test`, `homework`, …). Lowercased, max 20 chars |
| `object_ref` | yes | The activity's own id, e.g. the test id — **not** the attempt id. TBT Results groups rows by `tool` + `object_ref`. Max 64 chars |
| `object_title` | no | Plain text, max 190 chars |
| `post_id` | no | A post that does not exist is stored as 0 |
| `score`, `score_max` | no | Non-negative integers. Null (or omitted) means "done, no score" — not zero |
| `duration_seconds` | no | Non-negative integer |
| `created_at` | no | UTC `Y-m-d H:i:s`. Omitted means now. A malformed value, an impossible date, or one more than 60 seconds in the future is ignored and now is used |

The arguments pass through the same sanitising and limits as the REST route.
Class, teacher and name are never taken from the arguments; Notes resolves them:

- A student **in a class** is recorded with that class and its teacher.
- A student **in no class** is recorded with `class_id` 0 and `teacher_id` 0.
  No class panel or teacher feed ever shows such a row.
- A teacher or administrator **in no class** is not recorded:
  `tbt_notes_no_class` (403).

Other errors: `tbt_notes_bad_user` (400) for a missing or unknown user,
`tbt_notes_bad_request` (400) when `tool` or `object_ref` is empty,
`tbt_notes_write_failed` (500).

> **Never pass a `user_id` taken from a browser.** This is PHP: there is no
> nonce and no capability check. Take the user from your own stored records or
> from the session. A `user_id` read from a request parameter lets anyone record
> work in anyone's name.

There is **no duplicate guard**. The REST route refuses a repeat of the same
completion within ten seconds; this function does not, because a server-side
caller knows what counts as one completion. Call it once per completion.

Example — Test Maker recording a finished attempt:

```php
// Inside Test Maker, after an attempt has been marked finished. $attempt is
// Test Maker's own row; its user_id was stored from the session when the
// attempt started, never read from this request.
if ( function_exists( 'tbt_notes_record_activity' ) ) {
    $result = tbt_notes_record_activity(
        array(
            'user_id'      => (int) $attempt->user_id,
            'tool'         => 'test',
            'object_ref'   => (string) $test->id,   // the test, not the attempt
            'object_title' => $test->title,
            'score'        => (int) $attempt->score,
            'score_max'    => (int) $attempt->total,
        )
    );
    if ( is_wp_error( $result ) && 'tbt_notes_no_class' !== $result->get_error_code() ) {
        error_log( 'Test Maker: activity not recorded: ' . $result->get_error_message() );
    }
}
```

### Action: `tbt_notes_activity_recorded( int $id, array $row )`

*Available since TBT Notes 1.22.0.*

Fires after every row added to the activity log, whether it came from the
browser route or from `tbt_notes_record_activity()`. `$row` is the inserted row
with `id` added: `user_id`, `class_id`, `teacher_id`, `student_name`, `tool`,
`object_ref`, `object_title`, `post_id`, `event`, `score`, `score_max`,
`duration_seconds`, `created_at` (UTC). Notes itself does not listen to it.

```php
add_action( 'tbt_notes_activity_recorded', function ( int $id, array $row ) {
    // e.g. award points for $row['user_id'].
}, 10, 2 );
```

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
