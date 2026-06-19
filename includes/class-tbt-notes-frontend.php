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
	 * Hook front-end output.
	 */
	public function register() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'wp_footer', array( $this, 'render_container' ) );
		add_shortcode( 'tbt_notes', array( $this, 'render_shortcode' ) );
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
	 */
	public function enqueue_assets() {
		if ( ! $this->should_load() ) {
			return;
		}

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
			TBT_NOTES_VERSION
		);

		wp_register_script(
			'tbt-notes',
			TBT_NOTES_PLUGIN_URL . 'assets/js/tbt-notes.js',
			$script_deps,
			TBT_NOTES_VERSION,
			true
		);

		wp_localize_script( 'tbt-notes', 'TBTNotes', $this->localized_data( $is_teacher ) );
		wp_enqueue_script( 'tbt-notes' );
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
		);
	}

	/**
	 * Print the launcher button and the panel mount point in the footer.
	 */
	public function render_container() {
		if ( ! $this->should_load() ) {
			return;
		}
		?>
		<div id="tbt-notes-app" class="tbt-notes-app" data-tbt-notes>
			<?php if ( $this->show_launcher() ) : ?>
				<button type="button" id="tbt-notes-launcher" class="tbt-notes-launcher" aria-haspopup="dialog" aria-expanded="false" aria-controls="tbt-notes-panel" aria-label="<?php echo esc_attr__( 'Open notes', 'tbt-notes' ); ?>">
					<svg class="tbt-notes-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
						<path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.6H8V12Zm0 3.4h8V17H8v-1.6ZM8 8.6h4v1.6H8V8.6Z"/>
					</svg>
					<span class="tbt-notes-launcher-label"><?php echo esc_html__( 'LESSON NOTES', 'tbt-notes' ); ?></span>
				</button>
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
