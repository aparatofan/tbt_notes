<?php
/**
 * The roster resolver.
 *
 * One place that answers "which students may the current user see". Everything
 * built on top of the roster — the live-progress panel, its polling route, the
 * activity write — calls this rather than comparing a teacher_id itself.
 *
 * Three things this deliberately does NOT do:
 *
 * 1. It does not re-implement the ownership rule. The manager decision is
 *    TBT_Notes_REST::user_can_manage_class(), called directly, so the roster
 *    and the REST layer cannot drift apart. That rule includes the
 *    manage_options fallback, which is why tbt_hub_is_teacher() is not used
 *    here: Hub's helper tests manage_tbt_notes alone and reads a site
 *    administrator without that capability as a student.
 *
 * 2. It does not answer the student's question. Notes' existing
 *    user_can_view_class() still governs a student seeing their own class;
 *    this resolver is the teacher-side view and returns nothing at all to a
 *    non-manager. Failing closed is the point: a student must never be able to
 *    enumerate their classmates through a roster call.
 *
 * 3. It does not require a TBT Students row. The level is a decoration read
 *    through that plugin's public API when the plugin is active, and null
 *    otherwise. A class whose students have no level rows is normal, not an
 *    error.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Roster
 */
class TBT_Notes_Roster {

	/**
	 * The classes the current user may see.
	 *
	 * Mirrors the split TBT_Notes_REST::get_me() already makes: an
	 * administrator oversees every class, an ordinary teacher sees only the
	 * classes they created, and anyone else sees none.
	 *
	 * @return array[] Shaped class rows, newest first. Empty for non-managers.
	 */
	public static function classes_for_current_user(): array {
		return self::classes_for_user( get_current_user_id() );
	}

	/**
	 * The classes a given user may see.
	 *
	 * Split out from classes_for_current_user() so the decision can be tested
	 * without a logged-in session, in the same way the REST class exposes
	 * user_can_manage_class( $class, $user_id ).
	 *
	 * @param int $user_id User ID.
	 * @return array[]
	 */
	public static function classes_for_user( $user_id ): array {
		$user_id = (int) $user_id;
		if ( $user_id <= 0 ) {
			return array();
		}
		if ( ! TBT_Notes_Capabilities::user_can_manage( $user_id ) ) {
			return array();
		}
		if ( TBT_Notes_Capabilities::user_can_manage_all( $user_id ) ) {
			return TBT_Notes_DB::get_all_classes();
		}
		return TBT_Notes_DB::get_classes_for_teacher( $user_id );
	}

	/**
	 * Every student the current user may see, across every class they may see.
	 *
	 * @return array[] Each: user_id, display_name, level.
	 */
	public static function students_for_current_user(): array {
		$class_ids = array();
		foreach ( self::classes_for_current_user() as $class ) {
			$class_ids[] = (int) $class['id'];
		}
		if ( empty( $class_ids ) ) {
			return array();
		}
		return self::shape_students( TBT_Notes_DB::get_student_ids_for_classes( $class_ids ) );
	}

	/**
	 * The students in one class, or an empty array when the current user may
	 * not see that class.
	 *
	 * Fails closed on every uncertainty — an unknown class, an unowned class,
	 * a class belonging to another teacher — following the same reasoning as
	 * TBTS_Classes::user_owns_class() in TBT Swipe: an unverifiable class is
	 * never a readable one. The caller cannot tell "you may not see this" from
	 * "this class is empty", and deliberately so.
	 *
	 * @param int $class_id Class ID.
	 * @return array[] Each: user_id, display_name, level.
	 */
	public static function students_in_class( int $class_id ): array {
		if ( ! self::current_user_may_see_class( $class_id ) ) {
			return array();
		}
		return self::shape_students( TBT_Notes_DB::get_student_ids_for_class( $class_id ) );
	}

	/**
	 * May the current user see this class at all?
	 *
	 * Exposed because the polling route has to answer it before it reads any
	 * activity, and a permission check that returns rows is the wrong shape.
	 *
	 * @param int $class_id Class ID.
	 * @return bool
	 */
	public static function current_user_may_see_class( int $class_id ): bool {
		if ( $class_id <= 0 ) {
			return false;
		}
		$class = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return false;
		}
		return TBT_Notes_REST::user_can_manage_class( $class, get_current_user_id() );
	}

	/**
	 * May the current user see this student?
	 *
	 * A student who belongs to no class is visible to nobody, which is the
	 * same answer the activity write route gives when it cannot resolve a
	 * class: without a class there is no teacher to show the work to.
	 *
	 * @param int $student_id Student user ID.
	 * @return bool
	 */
	public static function current_user_may_see( int $student_id ): bool {
		if ( $student_id <= 0 ) {
			return false;
		}
		$class = TBT_Notes_DB::get_class_for_student( $student_id );
		if ( ! $class ) {
			return false;
		}
		return TBT_Notes_REST::user_can_manage_class( $class, get_current_user_id() );
	}

	/**
	 * Turn a list of user IDs into roster rows.
	 *
	 * One get_users() call rather than get_userdata() per student: this runs
	 * behind a ten-second poll, so an N+1 here is N+1 every ten seconds for
	 * every teacher with the panel open.
	 *
	 * A membership row whose WordPress user no longer exists is dropped rather
	 * than rendered as a blank name — the membership table is not authoritative
	 * about who still has an account.
	 *
	 * @param int[] $user_ids Student user IDs.
	 * @return array[] Each: user_id, display_name, level.
	 */
	protected static function shape_students( array $user_ids ): array {
		$user_ids = array_values( array_unique( array_filter( array_map( 'intval', $user_ids ) ) ) );
		if ( empty( $user_ids ) ) {
			return array();
		}

		// 'include' with an empty array would mean "every user on the site",
		// which is why the guard above is not merely an optimisation.
		$users = get_users(
			array(
				'include' => $user_ids,
				'fields'  => array( 'ID', 'display_name' ),
				'orderby' => 'display_name',
				'order'   => 'ASC',
			)
		);

		$out = array();
		foreach ( (array) $users as $user ) {
			$id = isset( $user->ID ) ? (int) $user->ID : 0;
			if ( $id <= 0 ) {
				continue;
			}
			$name = isset( $user->display_name ) ? trim( (string) $user->display_name ) : '';
			$out[] = array(
				'user_id'      => $id,
				'display_name' => $name,
				'level'        => self::level_for( $id ),
			);
		}
		return $out;
	}

	/**
	 * A student's CEFR level, or null when there isn't one.
	 *
	 * TBT Students is an optional integration, checked the way TBT Swipe
	 * checks Notes: the class and the method, not the plugin file. Its public
	 * API answers '' for a user with no level and for a user it has never
	 * heard of; both mean "no level to show" here, and neither is an error.
	 * The PwC class has no TBT Students rows at all.
	 *
	 * @param int $user_id Student user ID.
	 * @return string|null
	 */
	protected static function level_for( int $user_id ) {
		if ( ! class_exists( 'TBT_Students' ) || ! method_exists( 'TBT_Students', 'get_level' ) ) {
			return null;
		}
		$level = TBT_Students::get_level( $user_id );
		$level = is_string( $level ) ? trim( $level ) : '';
		return '' === $level ? null : $level;
	}
}
