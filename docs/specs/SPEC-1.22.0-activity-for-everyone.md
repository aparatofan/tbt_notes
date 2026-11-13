# TBT Notes 1.22.0 — Activity for everyone, and one server-side write

## Why

A new plugin, **TBT Results** (`aparatofan/tbt-results`), will show every piece of work a student finishes on The Blue Tree, for teachers and for the student. A points system (TBT Points) will be built on the same rows later. The data source for both is the activity table, `{prefix}tbt_activity`.

Two gaps stop that today:

1. `create_activity()` refuses a student who is in no class (`tbt_notes_no_class`, 403). Self-study members' work is never recorded.
2. Test Maker and Homework decide on the server that work is finished (a finished attempt; a mark given by the teacher). They cannot use the browser route, which takes the user from the session. They need a PHP way to write a row.

## Scope

| In | Out |
|---|---|
| A student in no class is recorded with `class_id` 0 and `teacher_id` 0 | The presence route (`/activity/presence`) stays class-only |
| A teacher or administrator in no class is still not recorded (unchanged) | The Class Progress panel and every class/teacher reader: unchanged, and they must never show class-0 rows |
| New PHP function `tbt_notes_record_activity()` | Updating or deleting activity rows |
| New action `tbt_notes_activity_recorded` | Any Results or Points UI |
| `docs/EXTENSION-API.md` updated | Schema changes: none. `TBT_NOTES_DB_VERSION` does not change |

## Files

| File | Change |
|---|---|
| `tbt-notes.php` | Header `Version` and `TBT_NOTES_VERSION` → `1.22.0`; global wrapper `tbt_notes_record_activity()` next to the existing ones |
| `includes/class-tbt-notes-activity-rest.php` | One recording path, `record()`; `create_activity()` calls it |
| `includes/class-tbt-notes-db.php` | `insert_activity()` accepts an optional `created_at` |
| `includes/class-tbt-notes-api.php` | `TBT_Notes_API::record_activity()` |
| `docs/EXTENSION-API.md` | The write door, documented |
| `tests/test-logic.php` | Cases for the new pure helpers |
| `readme.txt` | Stable tag and changelog |

---

## Phase 0 — read-only inventory (stop and report)

1. **Writers.** Confirm `create_activity()` is the only caller of `TBT_Notes_DB::insert_activity()`, and nothing else writes the activity table.
2. **Readers.** List every function that reads the activity table (expected: `get_activity_for_class()`, `count_activity_today()`, `get_latest_activity_id()`, and anything the panel or REST `get_activity()` uses). For each, confirm it filters by a `class_id` greater than 0 (or by a class the reader may see), so a row with `class_id` 0 can never reach a class panel or a teacher's feed.
3. **Wrappers.** Report how the existing global wrappers (`tbt_notes_lesson_context()` etc., `tbt-notes.php` ~L160–200) are declared and guarded, so the new one follows the same pattern.
4. **Clients.** Confirm none of the reporting tools treats `tbt_notes_no_class` specially in JavaScript. Expected: Swipe, Matching Game, Drag & Drop and Translation Drill send for any logged-in user and ignore the answer. (Those repos are not part of this task; a grep is enough if they are not available, or say so.)
5. **Tests.** Report what `test_activity_payload()` covers today.

**Hard stop** if any reader in item 2 would show a class-0 row to a teacher or in a class panel, or if anything else contradicts this spec. Otherwise end with the report and wait for Mariusz to say go.

---

## Task 1 — One recording path (`class-tbt-notes-activity-rest.php`)

Add:

```php
public static function record( int $user_id, array $clean, ?string $created_at = null )
// returns int (inserted row ID) | WP_Error
```

`$clean` is the output of `sanitize_payload()`. In order:

1. **User.** `get_userdata( $user_id )` must return a user, else `WP_Error( 'tbt_notes_bad_user', … , 400 )`.
2. **Required fields.** `tool` and `object_ref` non-empty, else the existing `tbt_notes_bad_request` error and message.
3. **Post.** The existing rule moves here unchanged: a `post_id` that does not resolve becomes 0.
4. **Class.** `TBT_Notes_DB::get_class_for_student( $user_id )`.
   - Found: `class_id` and `teacher_id` from the class, exactly as today.
   - Not found, and `TBT_Notes_Capabilities::user_can_manage( $user_id )` is true: return the existing `tbt_notes_no_class` error (403, same message). Teachers and administrators stay unrecorded, as today.
   - Not found, otherwise: `class_id` 0, `teacher_id` 0.
5. **Name.** `student_name` from that user's `display_name`, clipped to 190, as today.
6. **Time.** `created_at` = `self::valid_created_at( $created_at )` (Task 2), or null for "now".
7. **Insert** through `TBT_Notes_DB::insert_activity()`. False → the existing `tbt_notes_write_failed` error.
8. **Event.** After a successful insert:
   ```php
   do_action( 'tbt_notes_activity_recorded', $id, $row );
   ```
   `$row` is the array that was inserted, with `id` added. Nothing in Notes listens to it; TBT Points will.
9. Return the ID.

Then make `create_activity()` use it:

- Sanitize as now.
- Keep the duplicate guard where it is, **before** recording, unchanged.
- Call `self::record( get_current_user_id(), $clean )`. A `WP_Error` is returned as is.
- On success set the guard as now, and clear presence **only when the row has a class** (`class_id` > 0).
- The response shape does not change.
- Update the comment at the top of the method: a student in no class is now recorded without a class; a teacher in no class is not.

## Task 2 — Time (`class-tbt-notes-activity-rest.php`, `class-tbt-notes-db.php`)

Add a pure helper next to `nullable_uint()`:

```php
public static function valid_created_at( $value ): ?string
```

It returns the value only when it is a string in the form `Y-m-d H:i:s`, is a real date, and is not more than 60 seconds in the future (UTC). Anything else returns null. Callers pass UTC.

In `insert_activity()`: `'created_at' => ! empty( $data['created_at'] ) ? (string) $data['created_at'] : self::now()`. The format array does not change. Validation lives in `record()`, not here.

The browser route never passes a time: only the PHP function (Task 3) can. This exists so Test Maker can copy its past attempts across once, with their real dates.

## Task 3 — The PHP function (`class-tbt-notes-api.php`, `tbt-notes.php`)

```php
TBT_Notes_API::record_activity( array $args )   // int|WP_Error
tbt_notes_record_activity( array $args )         // global wrapper, same guard style as the others
```

Arguments:

| Key | Required | Notes |
|---|---|---|
| `user_id` | yes | The student. Must be > 0 |
| `tool` | yes | Slug, as the REST route (`test`, `homework`, …) |
| `object_ref` | yes | The activity's own ID, e.g. the test ID. Not the attempt ID: Results groups rows by `tool` + `object_ref` |
| `object_title` | no | |
| `post_id` | no | |
| `score`, `score_max` | no | Null means "no score" (done only), as on the route |
| `duration_seconds` | no | |
| `created_at` | no | UTC `Y-m-d H:i:s`; omitted means now |

It runs the arguments through `sanitize_payload()` (same limits as the route), then `record()`. There is **no** duplicate guard here: server-side callers decide what counts as one completion. There is no nonce or capability check either: it is PHP, and the docblock must say plainly that a caller must never pass a `user_id` taken from a browser.

Notes never calls this function itself.

## Task 4 — Docs (`docs/EXTENSION-API.md`)

1. Replace the bullet "**It never writes.** …" with: "**It writes in one place only.** Since 1.22.0 another plugin may add a row to the activity log with `tbt_notes_record_activity()`. Every other part of this API stays read-only, and Notes still stores nothing else on anyone's behalf."
2. Add a section `### tbt_notes_record_activity( array $args ): int|WP_Error` under **PHP API**: the arguments table, the class rule (class-less students recorded with class 0; teachers and administrators in no class not recorded), the warning about `user_id`, and a short example: Test Maker recording a finished attempt with score and total.
3. Add the action `tbt_notes_activity_recorded( int $id, array $row )`.
4. "Available since" note: 1.22.0 for these two.

## Task 5 — Tests (`tests/test-logic.php`)

Add cases for `valid_created_at()`: a valid past time passes; a malformed string, `2026-02-30 10:00:00`, an array and a time an hour ahead all return null. Extend the payload test only if the suite can reach it without WordPress.

## Task 6 — Version

`tbt-notes.php` header and `TBT_NOTES_VERSION` → `1.22.0`. `readme.txt`: Stable tag `1.22.0` and a changelog entry:

```
= 1.22.0 =
* Students who are not in a class now have their finished work recorded (no class, no teacher), so TBT Results can show it.
* New: tbt_notes_record_activity() lets another plugin record finished work from the server, and the tbt_notes_activity_recorded action fires after every recorded row.
```

## Validation

Run the checks in `CLAUDE.md`: `php tests/test-logic.php`, and `php -l` on every changed PHP file. No JavaScript changes.

---

## Acceptance checklist (live site, after Mariusz runs the manual deploy)

Mariusz needs one student account that is **not in any class** for this.

Check rows in phpMyAdmin with:

```sql
SELECT id, user_id, class_id, teacher_id, student_name, tool, object_title, score, score_max, created_at
FROM wp_tbt_activity ORDER BY id DESC LIMIT 10;
```

(Use the site's table prefix if it is not `wp_`.)

- [ ] A student **in** a class finishes a Swipe deck: a row as before, and that class's progress panel shows it as before.
- [ ] A student **in no class** finishes a Swipe deck: a new row with `class_id` 0, `teacher_id` 0, their name and score. No error in the browser console.
- [ ] The same student finishes a Matching Game, a Drag & Drop exercise and a Translation Drill: one row each (the drill with no score).
- [ ] A teacher account that is in no class finishes a deck: no row (unchanged).
- [ ] Every class's progress panel looks exactly as before; no class-0 row appears in any of them.
- [ ] Hard refresh shows `?ver=1.22.0` on Notes assets.
