<?php
/**
 * Main plugin orchestrator.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Plugin
 */
class TBT_Notes_Plugin {

	/**
	 * Singleton instance.
	 *
	 * @var TBT_Notes_Plugin|null
	 */
	protected static $instance = null;

	/**
	 * REST controller.
	 *
	 * @var TBT_Notes_REST
	 */
	protected $rest;

	/**
	 * Front-end controller.
	 *
	 * @var TBT_Notes_Frontend
	 */
	protected $frontend;

	/**
	 * Admin controller.
	 *
	 * @var TBT_Notes_Admin
	 */
	protected $admin;

	/**
	 * Get the singleton.
	 *
	 * @return TBT_Notes_Plugin
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Constructor wires up collaborators.
	 */
	protected function __construct() {
		$this->rest     = new TBT_Notes_REST();
		$this->frontend = new TBT_Notes_Frontend();
		$this->admin    = new TBT_Notes_Admin();
	}

	/**
	 * Register hooks.
	 */
	public function run() {
		$this->rest->register();
		$this->frontend->register();

		if ( is_admin() ) {
			$this->admin->register();
		}

		add_action( 'init', array( $this, 'load_textdomain' ) );
	}

	/**
	 * Load translations.
	 */
	public function load_textdomain() {
		load_plugin_textdomain( 'tbt-notes', false, dirname( plugin_basename( TBT_NOTES_PLUGIN_FILE ) ) . '/languages' );
	}
}
