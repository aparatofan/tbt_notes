<?php
/**
 * The public read-only API other TBT plugins call.
 *
 * Notes owns the ownership rule; everything built beside it asks rather than
 * re-derives. A companion plugin storing its own rows against a lesson needs
 * two things Notes already knows — may this user see this lesson, and what is
 * it called — and there is no honest way for it to answer either without
 * reading Notes' tables. This class is that answer, so the second copy of the
 * rule is never written.
 *
 * Three constraints hold for every method here, and they are the whole point:
 *
 * 1. Read-only. Nothing in this file writes, and no companion plugin ever
 *    writes through Notes.
 * 2. No permission logic of its own. Each decision is delegated to
 *    TBT_Notes_REST::user_can_view_class() or ::user_can_manage_class(), given
 *    a class row assembled exactly as the REST permission callbacks assemble
 *    it. If that rule changes once, it changes everywhere.
 * 3. It grants nothing. Returning a row is not permission to show it: the
 *    caller reads the flags and decides. A caller that ignores can_view has a
 *    security bug of its own making.
 *
 * A contributing plugin is not a trusted source. Everything handed in here is
 * cast to integers before it reaches a query, and everything handed back is
 * Notes' own data, never the caller's echoed to it.
 *
 * Callers use the file-level wrappers in tbt-notes.php — tbt_notes_*() — and
 * not this class directly.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_API
 */
class TBT_Notes_API {

	/**
	 * Most lesson ids honoured in one lessons_brief() call. A queue page asks
	 * about the rows it is showing; anything past this is a caller bug or an
	 * attempt to make Notes do unbounded work, and the surplus is ignored
	 * rather than refused so a slightly over-eager caller still gets an answer.
	 */
	const MAX_BRIEF_IDS = 200;

	/**
	 * Does this lesson exist, and what may this user do with it?
	 *
	 * The submit-time question. A lesson that exists but is not the caller's
	 * comes back as a full row with both flags false — the row's presence is
	 * not permission, the flags are, and a caller that does not read them has
	 * a security bug of its own making.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @param int $user_id   User ID, or 0 for the current user.
	 * @return array|null Context array, or null when the lesson does not exist.
	 */
	public static function lesson_context( int $lesson_id, int $user_id = 0 ): ?array {
		$lesson_id = (int) $lesson_id;
		$user_id   = self::resolve_user( $user_id );
		if ( $lesson_id <= 0 ) {
			return null;
		}

		$lesson = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return null;
		}

		$class_id = (int) $lesson['class_id'];
		$class    = self::class_for_permission_check( $class_id );

		return array(
			'lesson_id'    => (int) $lesson['id'],
			'class_id'     => $class_id,
			'lesson_title' => (string) $lesson['header'],
			'class_title'  => $class ? (string) $class['title'] : '',
			'created_at'   => (string) $lesson['created_at'],
			// A lesson whose class has gone is visible to nobody: there is no
			// class row left to prove membership or ownership against.
			'can_view'     => $class ? (bool) TBT_Notes_REST::user_can_view_class( $class, $user_id ) : false,
			'can_manage'   => $class ? (bool) TBT_Notes_REST::user_can_manage_class( $class, $user_id ) : false,
		);
	}

	/**
	 * The class ids this user manages — their own classes, or every class for
	 * an administrator.
	 *
	 * Empty for a student and empty for a logged-out visitor, because
	 * TBT_Notes_Roster::classes_for_user() returns nothing to a non-manager.
	 * This is what lets a companion plugin build a teacher's queue without ever
	 * touching a Notes table: it stores class_id on each of its own rows and
	 * asks here for the ids it is allowed to read.
	 *
	 * @param int $user_id User ID, or 0 for the current user.
	 * @return int[] Class IDs, possibly empty.
	 */
	public static function class_ids_for_manager( int $user_id = 0 ): array {
		$user_id = self::resolve_user( $user_id );
		if ( $user_id <= 0 ) {
			return array();
		}

		$ids = array();
		foreach ( TBT_Notes_Roster::classes_for_user( $user_id ) as $class ) {
			$id = isset( $class['id'] ) ? (int) $class['id'] : 0;
			if ( $id > 0 ) {
				$ids[] = $id;
			}
		}

		return array_values( array_unique( $ids ) );
	}

	/**
	 * Display titles in bulk, for a queue or a dossier holding many rows.
	 *
	 * Ids the user may not view are OMITTED from the result rather than
	 * returned empty, so a caller listing its own rows cannot leak a title by
	 * accident: an absent key means "not yours or not there", and the caller
	 * never has to tell those two apart.
	 *
	 * The per-class work — the class row and its roster — is resolved once per
	 * distinct class rather than once per lesson, so a page of submissions from
	 * one or two classes costs a handful of lookups on top of the lesson rows
	 * themselves.
	 *
	 * @param int[] $lesson_ids Lesson IDs. Capped at self::MAX_BRIEF_IDS.
	 * @param int   $user_id    User ID, or 0 for the current user.
	 * @return array[] Keyed by lesson ID; viewable lessons only.
	 */
	public static function lessons_brief( array $lesson_ids, int $user_id = 0 ): array {
		$user_id = self::resolve_user( $user_id );

		$ids = array();
		foreach ( $lesson_ids as $raw ) {
			$id = (int) $raw;
			if ( $id > 0 ) {
				$ids[ $id ] = true;
			}
		}
		$ids = array_slice( array_keys( $ids ), 0, self::MAX_BRIEF_IDS );
		if ( empty( $ids ) ) {
			return array();
		}

		$out     = array();
		$classes = array();
		$allowed = array();

		foreach ( $ids as $lesson_id ) {
			$lesson = TBT_Notes_DB::get_lesson( $lesson_id );
			if ( ! $lesson ) {
				continue;
			}

			$class_id = (int) $lesson['class_id'];
			if ( ! array_key_exists( $class_id, $allowed ) ) {
				$class                = self::class_for_permission_check( $class_id );
				$classes[ $class_id ] = $class;
				$allowed[ $class_id ] = $class ? (bool) TBT_Notes_REST::user_can_view_class( $class, $user_id ) : false;
			}
			if ( ! $allowed[ $class_id ] ) {
				continue;
			}

			$out[ (int) $lesson['id'] ] = array(
				'lesson_title' => (string) $lesson['header'],
				'class_id'     => $class_id,
				'class_title'  => (string) $classes[ $class_id ]['title'],
				'created_at'   => (string) $lesson['created_at'],
			);
		}

		return $out;
	}

	/**
	 * Resolve the caller's 0 to the current user.
	 *
	 * @param int $user_id Requested user ID.
	 * @return int
	 */
	protected static function resolve_user( int $user_id ): int {
		$user_id = (int) $user_id;
		return $user_id > 0 ? $user_id : (int) get_current_user_id();
	}

	/**
	 * A class row carrying its student_ids, shaped for the permission helpers.
	 *
	 * Assembled exactly as the REST permission callbacks assemble it — fetch
	 * the class, then fill student_ids from the membership table — because
	 * user_can_view_class() reads that key to decide whether a student belongs.
	 * Handing it a class row without student_ids would quietly read every
	 * student as an outsider.
	 *
	 * @param int $class_id Class ID.
	 * @return array|null Shaped class row, or null when the class is gone.
	 */
	protected static function class_for_permission_check( int $class_id ): ?array {
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return null;
		}

		$class = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return null;
		}

		$class['student_ids'] = TBT_Notes_DB::get_student_ids_for_class( $class_id );
		return $class;
	}
}
