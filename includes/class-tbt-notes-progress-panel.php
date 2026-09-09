<?php
/**
 * The teacher's live progress panel.
 *
 * A docked panel showing, for one class, who has finished a piece of work
 * today, who is working right now, and who has not started. It polls; nothing
 * about it is pushed.
 *
 * Loading is gated twice. The capability check is cheap and runs first; the
 * roster resolver then decides whether this user has any class to look at, and
 * a user with none gets no markup, no script and no stylesheet. A student must
 * never receive this code, so the gate is ownership, not a CSS rule.
 *
 * The panel is deliberately separate from Notes' own front-end bundle. It loads
 * only on the Notes page — the page carrying the [tbt_notes_page] shortcode —
 * and nowhere else on the site. Keeping the assets apart from the Notes bundle
 * means the two surfaces cannot start depending on each other's load order.
 *
 * Which class it watches is not asked for: Notes announces the open class on a
 * `tbt-notes:class-change` DOM event and the panel follows it, showing nothing
 * at all while no class is open. That event is a hint about what to watch and
 * never a grant of access — the ownership gate below and the REST route's own
 * checks are what decide who may see a roster.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Progress_Panel
 */
class TBT_Notes_Progress_Panel {

	/**
	 * Seconds between polls.
	 */
	const POLL_SECONDS = 10;

	/**
	 * Classes this teacher may see, resolved once per request.
	 *
	 * @var array[]|null
	 */
	protected $classes = null;

	/**
	 * Whether the assets went out on this request.
	 *
	 * @var bool
	 */
	protected $enqueued = false;

	/**
	 * Hook the panel up.
	 */
	public function register() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'wp_footer', array( $this, 'render' ) );
	}

	/**
	 * Should this request carry the panel at all?
	 *
	 * @return bool
	 */
	protected function should_load() {
		if ( is_admin() || ! is_user_logged_in() ) {
			return false;
		}
		if ( ! TBT_Notes_Capabilities::user_can_manage() ) {
			return false;
		}

		/**
		 * Filter whether the live progress panel loads on this request.
		 *
		 * The panel belongs to the Notes page and is noise everywhere else, so
		 * the default is the Notes-page test. A site with a different idea of
		 * where the panel belongs can say so here without touching the plugin.
		 *
		 * @param bool $load Whether to load.
		 */
		if ( ! apply_filters( 'tbt_notes_progress_should_load', $this->is_notes_page() ) ) {
			return false;
		}

		// The resolver has the final word: a manager with no classes has
		// nothing to watch, and gets nothing.
		return ! empty( $this->teacher_classes() );
	}

	/**
	 * Is this request the Notes page?
	 *
	 * Page Mode enqueues its own assets when the shortcode renders, which is
	 * after `wp_enqueue_scripts` has already run. This panel cannot wait for
	 * that, so it reads the post content directly rather than watching for the
	 * shortcode to fire.
	 *
	 * @return bool
	 */
	protected function is_notes_page() {
		if ( ! is_singular() ) {
			return false;
		}
		$post = get_post();
		if ( ! $post instanceof WP_Post ) {
			return false;
		}
		return has_shortcode( (string) $post->post_content, 'tbt_notes_page' );
	}

	/**
	 * The classes the current user may see, resolved once.
	 *
	 * @return array[]
	 */
	protected function teacher_classes() {
		if ( null === $this->classes ) {
			$this->classes = TBT_Notes_Roster::classes_for_current_user();
		}
		return $this->classes;
	}

	/**
	 * Enqueue the panel's own stylesheet and script.
	 */
	public function enqueue_assets() {
		if ( $this->enqueued || ! $this->should_load() ) {
			return;
		}
		$this->enqueued = true;

		// The shared vocabulary must be parsed before this sheet: every colour,
		// radius and shadow here is a token, and the panel defines none of its
		// own. Notes' front-end controller owns the fallback registration, so
		// this only has to make sure it has happened.
		$this->ensure_shared_styles();

		wp_enqueue_style(
			'tbt-notes-progress',
			TBT_NOTES_PLUGIN_URL . 'assets/css/tbt-progress.css',
			array( 'tbt-tokens' ),
			$this->asset_version( 'assets/css/tbt-progress.css' )
		);

		wp_register_script(
			'tbt-notes-progress',
			TBT_NOTES_PLUGIN_URL . 'assets/js/tbt-progress.js',
			array(),
			$this->asset_version( 'assets/js/tbt-progress.js' ),
			true
		);

		wp_localize_script( 'tbt-notes-progress', 'TBTNotesProgress', $this->localized_data() );
		wp_enqueue_script( 'tbt-notes-progress' );
	}

	/**
	 * Data the panel needs before it can ask a question.
	 *
	 * No class list travels with it. The panel watches whichever class Notes
	 * says is open, and the id it is given is re-checked server-side on every
	 * request, so nothing here decides what a teacher may look at.
	 *
	 * @return array
	 */
	protected function localized_data() {
		return array(
			'restBase'     => esc_url_raw( rest_url( TBT_NOTES_REST_NAMESPACE . '/activity' ) ),
			'nonce'        => wp_create_nonce( 'wp_rest' ),
			'pollSeconds'  => self::POLL_SECONDS,
			'i18n'         => array(
				'title'       => __( 'CLASS PROGRESS', 'tbt-notes' ),
				'done'        => __( 'Done', 'tbt-notes' ),
				'working'     => __( 'Working', 'tbt-notes' ),
				'idle'        => __( 'Not started', 'tbt-notes' ),
				/* translators: 1: students finished, 2: students in the class. */
				'count'       => __( '%1$d of %2$d done', 'tbt-notes' ),
				/* translators: 1: students finished, 2: students in the class. */
				'ringLabel'   => __( '%1$d of %2$d students done. Show class progress.', 'tbt-notes' ),
				'finished'    => __( 'finished', 'tbt-notes' ),
				'dismiss'     => __( 'Dismiss', 'tbt-notes' ),
				/* translators: %d: further completions not shown as their own toast. */
				'andMore'     => __( 'and %d more', 'tbt-notes' ),
				'empty'       => __( 'No students in this class yet.', 'tbt-notes' ),
				'offline'     => __( 'Reconnecting…', 'tbt-notes' ),
				'collapse'    => __( 'Collapse', 'tbt-notes' ),
				'expand'      => __( 'Expand', 'tbt-notes' ),
			),
		);
	}

	/**
	 * The panel's shell.
	 *
	 * Deliberately empty of student data: everything inside is built by the
	 * script from a permission-checked response, so a cached page can never
	 * carry one class's roster into another teacher's view.
	 */
	public function render() {
		if ( ! $this->enqueued ) {
			return;
		}
		?>
		<div class="tbtp-dock">
		<div class="tbtp-toasts" data-tbtp-toasts aria-live="polite" aria-atomic="false"></div>
		<section class="tbtp" id="tbtp-panel" hidden>
			<button type="button" class="tbtp__head" id="tbtp-head" aria-expanded="false" aria-controls="tbtp-body">
				<svg class="tbtp__ring" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
					<circle class="tbtp__ring-track" cx="32" cy="32" r="25" fill="none" stroke-width="5"/>
					<circle class="tbtp__ring-fill" cx="32" cy="32" r="25" fill="none" stroke-width="5" stroke-linecap="round" data-tbtp-ring />
				</svg>
				<span class="tbtp__bubble-count" data-tbtp-bubble aria-hidden="true"></span>
				<span class="tbtp__label">
					<span class="tbtp__eyebrow"><?php echo esc_html__( 'CLASS PROGRESS', 'tbt-notes' ); ?></span>
					<span class="tbtp__class" data-tbtp-classname></span>
				</span>
				<span class="tbtp__count" data-tbtp-count></span>
				<svg class="tbtp__chev" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
					<path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<div class="tbtp__body" id="tbtp-body">
				<div class="tbtp__roster" data-tbtp-roster></div>
			</div>
		</section>
		</div>
		<?php
	}

	/**
	 * Make sure the canonical token stylesheet is registered.
	 *
	 * TBT-Hub owns `tbt-tokens`. If it has not registered the handle, Notes'
	 * bundled fallback stands in under the same handle so a later Hub
	 * activation replaces it wholesale.
	 */
	protected function ensure_shared_styles() {
		if ( wp_style_is( 'tbt-tokens', 'registered' ) ) {
			return;
		}
		wp_register_style(
			'tbt-tokens',
			TBT_NOTES_PLUGIN_URL . 'assets/vendor/tbt/tbt-tokens.css',
			array(),
			$this->asset_version( 'assets/vendor/tbt/tbt-tokens.css' )
		);
	}

	/**
	 * Cache-busting version for a bundled asset.
	 *
	 * @param string $relative_path Path relative to the plugin directory.
	 * @return string
	 */
	protected function asset_version( $relative_path ) {
		$file = TBT_NOTES_PLUGIN_DIR . $relative_path;
		$time = file_exists( $file ) ? filemtime( $file ) : 0;
		return $time ? TBT_NOTES_VERSION . '.' . $time : TBT_NOTES_VERSION;
	}
}
