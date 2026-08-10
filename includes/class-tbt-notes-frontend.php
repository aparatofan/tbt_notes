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
	 * Whether the bundled fallback copies of the TBT-Hub shared stylesheets had to
	 * be registered because Hub did not register them itself. Drives the admin
	 * notice; the styles themselves are always registered under the Hub handles.
	 *
	 * @var bool
	 */
	protected $shared_styles_fallback = false;

	/**
	 * Hook front-end output.
	 */
	public function register() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'wp_footer', array( $this, 'render_container' ) );
		add_shortcode( 'tbt_notes', array( $this, 'render_shortcode' ) );
		add_shortcode( 'tbt_notes_page', array( $this, 'render_page_shortcode' ) );
		add_action( 'admin_notices', array( $this, 'shared_styles_notice' ) );
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
		$this->render_hero();
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
	 * Print the canonical Tool Hero for Page Mode.
	 *
	 * This is the page's identity — the same component Swipe and Matching Game
	 * use, straight from tbt-components.css with no plugin-local variant. It is
	 * rendered once, outside #tbt-notes-app, so the app's re-renders never touch
	 * it, and it appears at full size on both screens (class list and class view).
	 * It deliberately does not stick: the sticky class strip replaces it on scroll.
	 *
	 * Per the Style Spec, no page title is rendered beneath it — the hero owns
	 * page identity.
	 */
	protected function render_hero() {
		/**
		 * Filter the Page Mode hero eyebrow (the small line above the title).
		 *
		 * @param string $eyebrow Eyebrow text.
		 */
		$eyebrow = (string) apply_filters( 'tbt_notes_hero_eyebrow', __( 'THE BLUE TREE TEACHER TOOLS', 'tbt-notes' ) );

		/**
		 * Filter the Page Mode hero title.
		 *
		 * @param string $title Hero title.
		 */
		$title = (string) apply_filters( 'tbt_notes_hero_title', __( 'LESSON NOTES', 'tbt-notes' ) );

		/**
		 * Filter the Page Mode hero supporting line.
		 *
		 * @param string $support Supporting line.
		 */
		$support = (string) apply_filters( 'tbt_notes_hero_support', __( 'Every class, every lesson — notes written in the lesson and ready to read the moment it ends.', 'tbt-notes' ) );

		$logo = $this->logo_url();
		?>
		<div class="tbt-tool">
			<header class="tbt-tool-hero">
				<div class="tbt-tool-hero__content">
					<?php if ( '' !== $eyebrow ) : ?>
						<p class="tbt-tool-hero__eyebrow"><?php echo esc_html( $eyebrow ); ?></p>
					<?php endif; ?>
					<h1 class="tbt-tool-hero__title"><?php echo esc_html( $title ); ?></h1>
					<?php if ( '' !== $support ) : ?>
						<p class="tbt-tool-hero__support"><?php echo esc_html( $support ); ?></p>
					<?php endif; ?>
				</div>
				<?php if ( '' !== $logo ) : ?>
					<img class="tbt-tool-hero__logo" src="<?php echo esc_url( $logo ); ?>" alt="" aria-hidden="true">
				<?php endif; ?>
			</header>
		</div>
		<?php
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

		// The canonical tokens and components must be parsed before our own sheet,
		// so they are a hard dependency rather than a separate enqueue.
		$this->ensure_shared_styles();

		$style_deps  = array( 'tbt-components' );
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

		/**
		 * Fires after Notes has enqueued its own front-end assets.
		 *
		 * The companion to the tbt_notes_class_extras filter: a plugin that
		 * contributes to the panel can add its scripts here instead of having to
		 * work out on its own which pages Notes is running on. It fires only
		 * where the panel actually loads, so a contributor's assets never end up
		 * on a page that has no Notes on it.
		 *
		 * @param array $context Request context. Currently 'is_manager' (bool).
		 */
		do_action(
			'tbt_notes_frontend_assets',
			array(
				'is_manager' => (bool) $is_teacher,
			)
		);
	}

	/**
	 * Guarantee that the canonical TBT-Hub stylesheets are registered.
	 *
	 * TBT-Hub owns `tbt-tokens` and `tbt-components` and registers them on
	 * wp_enqueue_scripts at priority 5. If Hub is inactive (or has not registered
	 * yet) we register the bundled fallback copies under **the same handles**, so
	 * a later Hub activation replaces them wholesale and no page can ever load two
	 * copies of the design system under different handles.
	 */
	protected function ensure_shared_styles() {
		$this->shared_styles_fallback = false;

		if ( ! wp_style_is( 'tbt-tokens', 'registered' ) ) {
			wp_register_style(
				'tbt-tokens',
				TBT_NOTES_PLUGIN_URL . 'assets/vendor/tbt/tbt-tokens.css',
				array(),
				$this->asset_version( 'assets/vendor/tbt/tbt-tokens.css' )
			);
			$this->shared_styles_fallback = true;
		}

		if ( ! wp_style_is( 'tbt-components', 'registered' ) ) {
			wp_register_style(
				'tbt-components',
				TBT_NOTES_PLUGIN_URL . 'assets/vendor/tbt/tbt-components.css',
				array( 'tbt-tokens' ),
				$this->asset_version( 'assets/vendor/tbt/tbt-components.css' )
			);
			$this->shared_styles_fallback = true;
		}

		// Hub registers on a front-end hook, so wp-admin cannot ask the same
		// question and get a meaningful answer. Record what the front end saw and
		// let the notice read that instead of guessing.
		$stored = get_option( 'tbt_notes_shared_styles_fallback' ) ? true : false;
		if ( $stored !== $this->shared_styles_fallback ) {
			update_option( 'tbt_notes_shared_styles_fallback', $this->shared_styles_fallback ? 1 : 0 );
		}
	}

	/**
	 * Warn an administrator when Notes had to fall back to its bundled copy of the
	 * design system. The page still renders correctly; the risk is drift, because
	 * the bundled copy only updates when this plugin is updated.
	 */
	public function shared_styles_notice() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		if ( ! $this->shared_styles_fallback && ! get_option( 'tbt_notes_shared_styles_fallback' ) ) {
			return;
		}
		echo '<div class="notice notice-warning"><p>';
		echo esc_html__( 'TBT Notes: the shared TBT design system (tbt-tokens / tbt-components) was not registered by TBT-Hub, so the bundled fallback copy is being used. Activate TBT-Hub so every tool stays on one source of truth.', 'tbt-notes' );
		echo '</p></div>';
	}

	/**
	 * URL of the white TBT logo used by the Page Mode hero and the class cards.
	 *
	 * Single filterable source: PHP owns the value and hands it to the script, so
	 * it is never hardcoded in two places.
	 *
	 * @return string
	 */
	protected function logo_url() {
		/**
		 * Filter the white TBT logo used in the Notes hero and on class cards.
		 *
		 * @param string $url Logo URL.
		 */
		return (string) apply_filters( 'tbt_notes_logo_url', 'https://thebluetree.pl/wp-content/uploads/2020/12/TBT-white-logo.png' );
	}

	/**
	 * Selectors for elements that may be fixed to the top of the viewport above
	 * the workspace (the WP admin bar and the theme's fixed menus). The sticky
	 * class header measures these at scroll time to work out where it can sit.
	 *
	 * Kept in PHP so theme-specific selectors never end up hardcoded in the JS.
	 *
	 * @return array
	 */
	protected function sticky_selectors() {
		/**
		 * Filter the selectors measured when positioning the sticky class header.
		 *
		 * @param array $selectors CSS selectors, outermost/topmost first.
		 */
		return (array) apply_filters(
			'tbt_notes_sticky_selectors',
			array( '#wpadminbar', '#main-header', '#top-header', '.et-fixed-header' )
		);
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
			'logoUrl'         => esc_url_raw( $this->logo_url() ),
			'stickySelectors' => array_values( array_filter( array_map( 'strval', $this->sticky_selectors() ) ) ),
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
			// Whether students may self-generate flashcards and audio. Drives the
			// student generate buttons; the per-item can_generate flag from the
			// server is the authoritative gate (it already folds in this switch).
			'studentGeneration' => (bool) TBT_Notes_Capabilities::students_can_generate(),
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
			// Contributed extras panel. Polish by design: these labels sit next to
			// links students open in class, and the classroom language is Polish.
			'extrasCopy'        => __( 'Kopiuj link', 'tbt-notes' ),
			'extrasCopied'      => __( 'Skopiowano', 'tbt-notes' ),
			'extrasOpenDeck'    => __( 'Pokaż fiszki', 'tbt-notes' ),
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
			'copyLink'          => __( 'Copy link', 'tbt-notes' ),
			'openLink'          => __( 'Open link', 'tbt-notes' ),
			'orderedList'       => __( 'Numbered list', 'tbt-notes' ),
			'bulletList'        => __( 'Bulleted list', 'tbt-notes' ),
			'indent'            => __( 'Increase indent', 'tbt-notes' ),
			'outdent'           => __( 'Decrease indent', 'tbt-notes' ),
			'heading2'          => __( 'H2', 'tbt-notes' ),
			'heading3'          => __( 'H3', 'tbt-notes' ),
			'removeHighlight'   => __( 'No highlight', 'tbt-notes' ),
			// Image upload.
			'addPhoto'          => __( 'Add photo', 'tbt-notes' ),
			'replacePhoto'      => __( 'Replace', 'tbt-notes' ),
			'deletePhoto'       => __( 'Delete', 'tbt-notes' ),
			'imageUploading'    => __( 'Uploading…', 'tbt-notes' ),
			'imageUploadingSave' => __( 'Uploading image…', 'tbt-notes' ),
			'imageTypeError'    => __( 'Please choose a JPG or PNG image.', 'tbt-notes' ),
			'imageTooLarge'     => __( 'The image is too large. Please choose an image under 8 MB.', 'tbt-notes' ),
			'imageError'        => __( 'Could not upload the image. Please try again.', 'tbt-notes' ),
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
