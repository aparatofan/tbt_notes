<?php
/**
 * Uninstall handler for TBT Notes.
 *
 * Runs only when the plugin is deleted from the WordPress admin. This is the
 * single destructive cleanup point: it drops the custom tables, removes the
 * capability, and clears options. Deactivation does NOT do this.
 *
 * @package TBT_Notes
 */

// If uninstall is not called from WordPress, bail.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

$classes_table = $wpdb->prefix . 'tbt_classes';
$lessons_table = $wpdb->prefix . 'tbt_lessons';

// phpcs:disable WordPress.DB.PreparedSQL.NotPrepared -- table names cannot be parameterised.
$wpdb->query( "DROP TABLE IF EXISTS {$lessons_table}" );
$wpdb->query( "DROP TABLE IF EXISTS {$classes_table}" );
// phpcs:enable WordPress.DB.PreparedSQL.NotPrepared

delete_option( 'tbt_notes_db_version' );
delete_option( 'tbt_notes_show_launcher' );
delete_option( 'tbt_notes_manager_roles' );

// Revoke the capability from any specific users it was granted to, then clear.
$manager_users = (array) get_option( 'tbt_notes_manager_users', array() );
foreach ( $manager_users as $uid ) {
	$user = get_userdata( (int) $uid );
	if ( $user ) {
		$user->remove_cap( 'manage_tbt_notes' );
	}
}
delete_option( 'tbt_notes_manager_users' );

// Remove the management capability from every role.
$cap = 'manage_tbt_notes';
$wp_roles = wp_roles();
if ( $wp_roles ) {
	foreach ( array_keys( $wp_roles->roles ) as $role_slug ) {
		$role = get_role( $role_slug );
		if ( $role && $role->has_cap( $cap ) ) {
			$role->remove_cap( $cap );
		}
	}
}
