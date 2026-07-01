<?php
/**
 * Plugin Name:       TBT Notes
 * Plugin URI:        https://thebluetree.example/
 * Description:       Per-class lesson notes for The Blue Tree. A teacher writes notes per class; each logged-in student sees only the notes for the class they are assigned to, in a slide-out side panel.
 * Version:           1.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            The Blue Tree
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       tbt-notes
 * Domain Path:       /languages
 *
 * @package TBT_Notes
 */

// Exit if accessed directly.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Plugin version. Bump on release.
 */
define( 'TBT_NOTES_VERSION', '1.2.0' );

/**
 * Database schema version. Bump when the table structure changes so that
 * activation/upgrade can run dbDelta again.
 */
define( 'TBT_NOTES_DB_VERSION', '5' );

/**
 * Capability that gates all teacher/admin functionality (creating classes,
 * assigning students, writing notes). Kept as a capability rather than a
 * hard-coded user ID so a future "teacher" role can be granted the same
 * rights without reworking the model.
 */
define( 'TBT_NOTES_CAP', 'manage_tbt_notes' );

define( 'TBT_NOTES_PLUGIN_FILE', __FILE__ );
define( 'TBT_NOTES_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'TBT_NOTES_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'TBT_NOTES_REST_NAMESPACE', 'tbt-notes/v1' );

require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-db.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-capabilities.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-sanitizer.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-pronunciation.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-expression-cards.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-ai-quick-note.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-rest.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-frontend.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-admin.php';
require_once TBT_NOTES_PLUGIN_DIR . 'includes/class-tbt-notes-plugin.php';

/**
 * Activation: create tables and grant the capability to administrators.
 */
function tbt_notes_activate() {
	TBT_Notes_DB::install();
	TBT_Notes_DB::migrate_single_to_membership();
	TBT_Notes_Capabilities::add_caps();
	// Stamp the version so we can detect upgrades on later loads.
	update_option( 'tbt_notes_db_version', TBT_NOTES_DB_VERSION );
}
register_activation_hook( __FILE__, 'tbt_notes_activate' );

/**
 * Deactivation: intentionally non-destructive. We do not drop tables or
 * remove notes here — that only happens on uninstall.
 */
function tbt_notes_deactivate() {
	// Reserved for future cleanup (e.g. flushing rewrite rules). No-op for now.
}
register_deactivation_hook( __FILE__, 'tbt_notes_deactivate' );

/**
 * Boot the plugin once all plugins are loaded.
 */
function tbt_notes_bootstrap() {
	// Run a lightweight upgrade check in case the plugin files were updated
	// without a fresh activation (e.g. deployed over the top).
	if ( get_option( 'tbt_notes_db_version' ) !== TBT_NOTES_DB_VERSION ) {
		TBT_Notes_DB::install();
		TBT_Notes_DB::migrate_single_to_membership();
		TBT_Notes_Capabilities::add_caps();
		update_option( 'tbt_notes_db_version', TBT_NOTES_DB_VERSION );
	}

	TBT_Notes_Plugin::instance()->run();
}
add_action( 'plugins_loaded', 'tbt_notes_bootstrap' );
