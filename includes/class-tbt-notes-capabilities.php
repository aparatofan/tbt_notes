<?php
/**
 * Capability management for TBT Notes.
 *
 * The entire teacher/admin permission surface hangs off a single capability,
 * TBT_NOTES_CAP ("manage_tbt_notes"). v1 grants it to administrators only, but
 * because nothing is hard-coded to a user ID, a future "teacher" role can be
 * granted the same capability to gain full authoring rights.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Capabilities
 */
class TBT_Notes_Capabilities {

	/**
	 * Roles that should receive the management capability on activation.
	 *
	 * Filterable so additional roles (e.g. a future "teacher" role) can be
	 * granted authoring rights without code changes.
	 *
	 * @return string[]
	 */
	public static function managing_roles() {
		/**
		 * Filter the list of roles granted the TBT Notes management capability.
		 *
		 * @param string[] $roles Role slugs.
		 */
		return (array) apply_filters( 'tbt_notes_managing_roles', array( 'administrator' ) );
	}

	/**
	 * Grant the management capability to the configured roles.
	 */
	public static function add_caps() {
		foreach ( self::managing_roles() as $role_slug ) {
			$role = get_role( $role_slug );
			if ( $role && ! $role->has_cap( TBT_NOTES_CAP ) ) {
				$role->add_cap( TBT_NOTES_CAP );
			}
		}
	}

	/**
	 * Remove the management capability from every role. Used on uninstall.
	 */
	public static function remove_caps() {
		$roles = wp_roles();
		if ( ! $roles ) {
			return;
		}
		foreach ( array_keys( $roles->roles ) as $role_slug ) {
			$role = get_role( $role_slug );
			if ( $role && $role->has_cap( TBT_NOTES_CAP ) ) {
				$role->remove_cap( TBT_NOTES_CAP );
			}
		}
	}

	/**
	 * Can the current (or a given) user manage notes (teacher/admin side)?
	 *
	 * @param int|null $user_id Optional user ID. Defaults to current user.
	 * @return bool
	 */
	public static function user_can_manage( $user_id = null ) {
		if ( null === $user_id ) {
			return current_user_can( TBT_NOTES_CAP );
		}
		return user_can( $user_id, TBT_NOTES_CAP );
	}
}
