<?php
/**
 * Front-end integration for TBT Notes.
 *
 * Renders the left-rail launcher and the slide-out panel mount point, and loads
 * the assets. The panel is a single role-aware surface: students get a
 * read-only view, the teacher gets inline management + the Quill editor. Quill
 * itself is only loaded for users who can manage notes — students never download
 * the editor.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Frontend
 */
class TBT_Notes_Frontend {

	/**
	 * Whether the inline Page Mode workspace ([tbt_notes_page]) has been rendered
	 * on this request. When true, the footer overlay version is suppressed so the
	 * two never collide on duplicate IDs (#tbt-notes-app, #tbt-notes-panel).
	 *
	 * @var bool
	 */
	protected $page_mode_rendered = false;

	/**
	 * Whether assets have already been enqueued this request, so a second call
	 * (e.g. Page Mode forcing them) does not localize the script twice.
	 *
	 * @var bool
	 */
	protected $assets_enqueued = false;

	/**
	 * Hook front-end output.
	 */
	public function register() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'wp_footer', array( $this, 'render_container' ) );
		add_shortcode( 'tbt_notes', array( $this, 'render_shortcode' ) );
		add_shortcode( 'tbt_notes_page', array( $this, 'render_page_shortcode' ) );
	}

	/**
	 * Should the floating launcher tab be shown? Off when the teacher opens the
	 * panel from their own menu instead.
	 *
	 * @return bool
	 */
	protected function show_launcher() {
		$show = get_option( 'tbt_notes_show_launcher', '1' ) !== '0';
		/**
		 * Filter whether the floating Notes launcher tab is shown.
		 *
		 * @param bool $show Whether to show the tab.
		 */
		return (bool) apply_filters( 'tbt_notes_show_launcher', $show );
	}

	/**
	 * Shortcode: a button that opens the Notes panel. Use it in a page, widget
	 * or block, e.g. [tbt_notes label="Notes"].
	 *
	 * @param array $atts Shortcode attributes.
	 * @return string
	 */
	public function render_shortcode( $atts ) {
		if ( ! is_user_logged_in() ) {
			return '';
		}
		$atts = shortcode_atts(
			array(
				'label' => __( 'Notes', 'tbt-notes' ),
				'class' => '',
			),
			$atts,
			'tbt_notes'
		);

		$extra = '';
		if ( ! empty( $atts['class'] ) ) {
			$parts = array_filter( array_map( 'sanitize_html_class', explode( ' ', $atts['class'] ) ) );
			$extra = $parts ? ' ' . implode( ' ', $parts ) : '';
		}

		return '<button type="button" class="tbt-notes-trigger tbt-notes-shortcode-btn' . esc_attr( $extra ) . '" data-tbt-notes-open>' . esc_html( $atts['label'] ) . '</button>';
	}

	/**
	 * Shortcode: render the full Notes workspace inline as normal page content
	 * ("Page Mode"). Unlike [tbt_notes] (an opener button for the overlay), this
	 * renders the app itself directly in the page so the browser window scrolls
	 * normally — the foundation for a future student-facing app.
	 *
	 * Place [tbt_notes_page] on a dedicated page. The footer overlay is suppressed
	 * on the same request so the two never share duplicate IDs, and the floating
	 * launcher is not shown.
	 *
	 * @return string
	 */
	public function render_page_shortcode() {
		if ( ! is_user_logged_in() ) {
			return '';
		}

		// Suppress the footer overlay for this request (see render_container).
		$this->page_mode_rendered = true;

		// Make sure assets are present even if should_load() was filtered off. This
		// is in time for the footer-printed script; enqueue calls are idempotent.
		$this->enqueue_assets( true );

		ob_start();
		?>
		<div id="tbt-notes-app" class="tbt-notes-app tbt-notes-app--page" data-tbt-notes data-tbt-mode="page">
			<main id="tbt-notes-panel" class="tbt-notes-panel tbt-notes-panel--page" aria-label="<?php echo esc_attr__( 'Notes', 'tbt-notes' ); ?>">
				<div class="tbt-notes-panel__inner" data-tbt-content>
					<div class="tbt-notes-loading"><?php echo esc_html__( 'Loading…', 'tbt-notes' ); ?></div>
				</div>
			</main>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	/**
	 * Should the notes UI load for the current request?
	 *
	 * Only for logged-in users on the front end. Filterable so a site could,
	 * for example, restrict it to certain pages.
	 *
	 * @return bool
	 */
	protected function should_load() {
		$load = is_user_logged_in() && ! is_admin();
		/**
		 * Filter whether the TBT Notes panel loads on this request.
		 *
		 * @param bool $load Whether to load.
		 */
		return (bool) apply_filters( 'tbt_notes_should_load', $load );
	}

	/**
	 * Enqueue styles and scripts.
	 *
	 * @param bool $force Skip the should_load() gate (used by Page Mode, which is
	 *                    explicitly opted into by placing the shortcode).
	 */
	public function enqueue_assets( $force = false ) {
		if ( $this->assets_enqueued ) {
			return;
		}
		if ( ! $force && ! $this->should_load() ) {
			return;
		}
		$this->assets_enqueued = true;

		$is_teacher = TBT_Notes_Capabilities::user_can_manage();

		$style_deps  = array();
		$script_deps = array();

		// Only the teacher edits, so only the teacher needs Quill (engine +
		// Snow theme). Students store/read self-contained semantic HTML and
		// never download the editor.
		if ( $is_teacher ) {
			wp_enqueue_style(
				'tbt-quill',
				TBT_NOTES_PLUGIN_URL . 'assets/vendor/quill/quill.snow.css',
				array(),
				'2.0.3'
			);
			$style_deps[] = 'tbt-quill';

			wp_register_script(
				'tbt-quill',
				TBT_NOTES_PLUGIN_URL . 'assets/vendor/quill/quill.js',
				array(),
				'2.0.3',
				true
			);
			$script_deps[] = 'tbt-quill';
		}

		wp_enqueue_style(
			'tbt-notes',
			TBT_NOTES_PLUGIN_URL . 'assets/css/tbt-notes.css',
			$style_deps,
			$this->asset_version( 'assets/css/tbt-notes.css' )
		);

		wp_register_script(
			'tbt-notes',
			TBT_NOTES_PLUGIN_URL . 'assets/js/tbt-notes.js',
			$script_deps,
			$this->asset_version( 'assets/js/tbt-notes.js' ),
			true
		);

		wp_localize_script( 'tbt-notes', 'TBTNotes', $this->localized_data( $is_teacher ) );
		wp_enqueue_script( 'tbt-notes' );
	}

	/**
	 * Cache-busting version for one of the plugin's own assets. Uses the file's
	 * modification time so a freshly uploaded CSS/JS file is always re-fetched
	 * (the ?ver= query changes), falling back to the plugin version if the file
	 * cannot be stat'd.
	 *
	 * @param string $relative_path Path under the plugin dir, e.g. 'assets/js/tbt-notes.js'.
	 * @return string
	 */
	protected function asset_version( $relative_path ) {
		$full = TBT_NOTES_PLUGIN_DIR . ltrim( $relative_path, '/' );
		$mtime = is_readable( $full ) ? filemtime( $full ) : false;
		return $mtime ? (string) $mtime : TBT_NOTES_VERSION;
	}

	/**
	 * Data handed to the front-end script.
	 *
	 * @param bool $is_teacher Whether current user can manage notes.
	 * @return array
	 */
	protected function localized_data( $is_teacher ) {
		return array(
			'restUrl'         => esc_url_raw( rest_url( TBT_NOTES_REST_NAMESPACE . '/' ) ),
			'nonce'           => wp_create_nonce( 'wp_rest' ),
			'isTeacher'       => (bool) $is_teacher,
			'currentUserId'   => get_current_user_id(),
			'highlightColors' => array(
				array(
					'key'   => 'blue',
					'label' => __( 'Useful expression', 'tbt-notes' ),
				),
				array(
					'key'   => 'red',
					'label' => __( 'Mistake / correction', 'tbt-notes' ),
				),
				array(
					'key'   => 'yellow',
					'label' => __( 'Important idea', 'tbt-notes' ),
				),
				array(
					'key'   => 'pink',
					'label' => __( 'Pronunciation', 'tbt-notes' ),
				),
				array(
					'key'   => 'green',
					'label' => __( 'Grammar', 'tbt-notes' ),
				),
			),
			'i18n'            => $this->strings(),
			// AI Quick Note presets are teacher-only (it is a teacher feature). The
			// instruction wording lives server-side; only key + label cross to JS.
			'aiPresets'       => $is_teacher ? TBT_Notes_AI_Quick_Note::preset_choices() : array(),
			'aiEnabled'       => (bool) $is_teacher,
		);
	}

	/**
	 * Translatable UI strings for the JS app.
	 *
	 * @return array
	 */
	protected function strings() {
		return array(
			'panelTitle'        => __( 'Notes', 'tbt-notes' ),
			'headerStatic'      => __( 'LESSON NOTES:', 'tbt-notes' ),
			'headerClasses'     => __( 'CLASSES', 'tbt-notes' ),
			'open'              => __( 'Open notes', 'tbt-notes' ),
			'close'             => __( 'Close', 'tbt-notes' ),
			'back'              => __( 'Back', 'tbt-notes' ),
			'loading'          => __( 'Loading…', 'tbt-notes' ),
			'noClassStudent'    => __( 'You have no notes assigned yet.', 'tbt-notes' ),
			'noLessons'         => __( 'No lessons yet.', 'tbt-notes' ),
			'noClassesTeacher'  => __( 'No classes yet. Create one to get started.', 'tbt-notes' ),
			'newClass'          => __( 'New class', 'tbt-notes' ),
			'newLesson'         => __( 'New lesson', 'tbt-notes' ),
			'newLessonShort'    => __( '+ NEW', 'tbt-notes' ),
			'searchClasses'     => __( 'Search classes…', 'tbt-notes' ),
			'classTitle'        => __( 'Class title', 'tbt-notes' ),
			'classTitlePh'      => __( 'e.g. Iwona Wróbel', 'tbt-notes' ),
			'assignedStudent'   => __( 'Assigned student', 'tbt-notes' ),
			'students'          => __( 'Students', 'tbt-notes' ),
			'noStudents'        => __( 'No students in this class yet.', 'tbt-notes' ),
			'oneStudent'        => __( '1 student', 'tbt-notes' ),
			'nStudents'         => __( 'students', 'tbt-notes' ),
			'oneNote'           => __( '1 note', 'tbt-notes' ),
			'nNotes'            => __( 'notes', 'tbt-notes' ),
			'lessonNotesTitle'  => __( 'Lesson Notes', 'tbt-notes' ),
			'notesTabPrefix'    => __( 'TBT Notes', 'tbt-notes' ),
			'siteName'          => __( 'The Blue Tree', 'tbt-notes' ),
			'lessons'           => __( 'Lessons', 'tbt-notes' ),
			'toggleLessons'     => __( 'Show / hide lessons', 'tbt-notes' ),
			'print'             => __( 'Print', 'tbt-notes' ),
			'searchStudents'    => __( 'Search by username, name or email…', 'tbt-notes' ),
			'searchHint'        => __( 'Type to find a student to add.', 'tbt-notes' ),
			'noResults'         => __( 'No matches.', 'tbt-notes' ),
			'added'             => __( 'added', 'tbt-notes' ),
			'unassign'          => __( 'Remove student', 'tbt-notes' ),
			'alreadyIn'         => __( 'in: ', 'tbt-notes' ),
			'deleteClass'       => __( 'Delete class', 'tbt-notes' ),
			'deleteLesson'      => __( 'Delete lesson', 'tbt-notes' ),
			'confirmClass'      => __( 'Delete this class and all of its lessons? This cannot be undone.', 'tbt-notes' ),
			'confirmLesson'     => __( 'Delete this lesson? This cannot be undone.', 'tbt-notes' ),
			'lessonHeader'      => __( 'Lesson header', 'tbt-notes' ),
			'lessonHeaderPh'    => __( 'e.g. Lesson 12 — 14 May, or LC', 'tbt-notes' ),
			'untitledClass'     => __( 'Untitled class', 'tbt-notes' ),
			'untitledLesson'    => __( 'Untitled lesson', 'tbt-notes' ),
			'saving'            => __( 'Saving…', 'tbt-notes' ),
			'saved'             => __( 'All changes saved', 'tbt-notes' ),
			'saveError'         => __( 'Save failed — retrying…', 'tbt-notes' ),
			'genericError'      => __( 'Something went wrong. Please try again.', 'tbt-notes' ),
			'selectClass'       => __( 'Select a class', 'tbt-notes' ),
			'manageClass'       => __( 'Class settings', 'tbt-notes' ),
			'bold'              => __( 'Bold', 'tbt-notes' ),
			'italic'            => __( 'Italic', 'tbt-notes' ),
			'underline'         => __( 'Underline', 'tbt-notes' ),
			'strike'            => __( 'Strikethrough', 'tbt-notes' ),
			'blockquote'        => __( 'Quote', 'tbt-notes' ),
			'highlight'         => __( 'Highlight', 'tbt-notes' ),
			'link'              => __( 'Link', 'tbt-notes' ),
			'orderedList'       => __( 'Numbered list', 'tbt-notes' ),
			'bulletList'        => __( 'Bulleted list', 'tbt-notes' ),
			'indent'            => __( 'Increase indent', 'tbt-notes' ),
			'outdent'           => __( 'Decrease indent', 'tbt-notes' ),
			'heading2'          => __( 'H2', 'tbt-notes' ),
			'heading3'          => __( 'H3', 'tbt-notes' ),
			'removeHighlight'   => __( 'No highlight', 'tbt-notes' ),
			'show'              => __( 'Show', 'tbt-notes' ),
			'fullNote'          => __( 'Full note', 'tbt-notes' ),
			'allHighlights'     => __( 'All highlights', 'tbt-notes' ),
			'noHighlightsFound' => __( 'No highlighted items in this category.', 'tbt-notes' ),
			'highlightsFromNote' => __( 'Highlights from this lesson', 'tbt-notes' ),
			'pronunciation'     => __( 'Pronunciation', 'tbt-notes' ),
			'generateAudio'     => __( 'Generate audio', 'tbt-notes' ),
			'generating'        => __( 'Generating…', 'tbt-notes' ),
			'play'              => __( 'Play', 'tbt-notes' ),
			'playing'           => __( 'Playing…', 'tbt-notes' ),
			'noPronAudio'       => __( 'No pronunciation audio has been added yet.', 'tbt-notes' ),
			'audioError'        => __( 'Could not generate audio. Please try again.', 'tbt-notes' ),
			'usefulExpression'  => __( 'Useful expression', 'tbt-notes' ),
			'generateCard'      => __( 'Generate card', 'tbt-notes' ),
			'regenerate'        => __( 'Regenerate', 'tbt-notes' ),
			'save'              => __( 'Save', 'tbt-notes' ),
			'approve'           => __( 'Approve', 'tbt-notes' ),
			'polishLabel'       => __( 'Polish', 'tbt-notes' ),
			'exampleLabel'      => __( 'Example', 'tbt-notes' ),
			'statusLabel'       => __( 'Status', 'tbt-notes' ),
			'statusDraft'       => __( 'Draft', 'tbt-notes' ),
			'statusApproved'    => __( 'Approved', 'tbt-notes' ),
			'cardError'         => __( 'Could not generate the expression card. Please try again.', 'tbt-notes' ),
			'cardSaved'         => __( 'Saved', 'tbt-notes' ),
			'noExpressionCards' => __( 'No useful expression cards have been added yet.', 'tbt-notes' ),
			// AI Quick Note.
			'aiAsk'             => __( 'Ask AI', 'tbt-notes' ),
			'aiPanelTitle'      => __( 'Ask AI', 'tbt-notes' ),
			'aiPlaceholder'     => __( 'Ask AI: define a word, explain a concept, create examples…', 'tbt-notes' ),
			'aiSubmit'          => __( 'Ask', 'tbt-notes' ),
			'aiThinking'        => __( 'Thinking…', 'tbt-notes' ),
			'aiInsert'          => __( 'Insert', 'tbt-notes' ),
			'aiRegenerate'      => __( 'Regenerate', 'tbt-notes' ),
			'aiDiscard'         => __( 'Discard', 'tbt-notes' ),
			'aiClose'           => __( 'Close', 'tbt-notes' ),
			'aiError'           => __( 'AI is not available at the moment. Please try again.', 'tbt-notes' ),
			'aiEmptyPrompt'     => __( 'Please type a prompt for the AI.', 'tbt-notes' ),
		);
	}

	/**
	 * Print the launcher button and the panel mount point in the footer.
	 */
	public function render_container() {
		// In Page Mode the workspace is already rendered inline; rendering the
		// overlay too would duplicate #tbt-notes-app / #tbt-notes-panel.
		if ( $this->page_mode_rendered ) {
			return;
		}
		if ( ! $this->should_load() ) {
			return;
		}
		?>
		<div id="tbt-notes-app" class="tbt-notes-app" data-tbt-notes>
			<?php if ( $this->show_launcher() ) : ?>
				<?php
				/**
				 * Filter the URL the Lesson Notes launcher links to.
				 *
				 * The launcher opens the dedicated Page Mode workspace rather than the
				 * in-page overlay.
				 *
				 * @param string $url Destination URL.
				 */
				$launcher_url = apply_filters( 'tbt_notes_launcher_url', 'https://thebluetree.pl/tbt-notes/' );
				?>
				<a id="tbt-notes-launcher" class="tbt-notes-launcher" href="<?php echo esc_url( $launcher_url ); ?>" target="_blank" rel="noopener noreferrer" aria-label="<?php echo esc_attr__( 'Lesson notes (opens in a new tab)', 'tbt-notes' ); ?>">
					<svg class="tbt-notes-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
						<path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.6H8V12Zm0 3.4h8V17H8v-1.6ZM8 8.6h4v1.6H8V8.6Z"/>
					</svg>
					<span class="tbt-notes-launcher-label"><?php echo esc_html__( 'LESSON NOTES', 'tbt-notes' ); ?></span>
				</a>
			<?php endif; ?>

			<div id="tbt-notes-overlay" class="tbt-notes-overlay" hidden></div>

			<aside id="tbt-notes-panel" class="tbt-notes-panel" role="dialog" aria-modal="false" aria-label="<?php echo esc_attr__( 'Notes', 'tbt-notes' ); ?>" aria-hidden="true">
				<div class="tbt-notes-panel__inner" data-tbt-content>
					<div class="tbt-notes-loading"><?php echo esc_html__( 'Loading…', 'tbt-notes' ); ?></div>
				</div>
			</aside>
		</div>
		<?php
	}
}
