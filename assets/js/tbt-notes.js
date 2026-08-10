/**
 * TBT Notes — front-end application.
 *
 * A full-screen, role-aware notes surface. Inside a class it's a master/detail
 * layout: a collapsible lessons list on the left, the selected lesson on the
 * right (read-only for students, Quill editor with autosave for the teacher).
 * All authority is enforced server-side; this script reflects what the REST API
 * allows.
 */
( function () {
	'use strict';

	var cfg = window.TBTNotes;
	if ( ! cfg ) {
		return;
	}
	var i18n = cfg.i18n || {};

	/* ------------------------------------------------------------------ DOM */

	var root = document.getElementById( 'tbt-notes-app' );
	var launcher = document.getElementById( 'tbt-notes-launcher' );
	var overlay = document.getElementById( 'tbt-notes-overlay' );
	var panel = document.getElementById( 'tbt-notes-panel' );
	if ( ! root || ! panel ) {
		return;
	}
	var content = panel.querySelector( '[data-tbt-content]' );
	var lastOpener = null;

	// Two render modes. "overlay" (default): a fixed slide-out panel opened from a
	// launcher, with body scroll-lock and Escape-to-close. "page": the workspace
	// is rendered inline as normal page content ([tbt_notes_page] shortcode) so the
	// browser window scrolls normally — no overlay, launcher, scroll-lock or modal
	// behaviour.
	var mode = root.getAttribute( 'data-tbt-mode' ) || 'overlay';
	var isPageMode = mode === 'page';

	/* ---------------------------------------------------------------- State */

	var state = {
		loaded: false,
		isTeacher: !! cfg.isTeacher,
		studentGeneration: !! cfg.studentGeneration,
		classes: [],
		view: 'root',
		currentClass: null,
		lessons: [],
		loadingLessons: false,
		currentLesson: null,
		// Contributed extras for the open class (see "Class extras" below).
		extras: [],
		extrasClassId: 0,
		extrasOpenGroups: {},
		extrasOpenItem: '',
		extrasOpenLesson: 0,
		sidebarFolded: false,
		highlightFilter: 'full',
		error: '',
	};

	var activeSaver = null;
	var unloading = false;
	// Page Mode only: the sticky class-header controller (see initPageStickyHeader).
	var pageSticky = null;

	/* --------------------------------------------------------------- Helpers */

	function el( tag, cls, text ) {
		var e = document.createElement( tag );
		if ( cls ) {
			e.className = cls;
		}
		if ( text != null ) {
			e.textContent = text;
		}
		return e;
	}

	function clear( node ) {
		while ( node.firstChild ) {
			node.removeChild( node.firstChild );
		}
	}

	/**
	 * Pick a class list per render mode.
	 *
	 * Page Mode is migrated to the canonical TBT components (.tbt-button,
	 * .tbt-input, .tbt-empty, .tbt-notice, .tbt-icon-button); overlay mode has not
	 * been migrated and must keep rendering exactly what it renders today. Every
	 * shared control therefore names both variants here rather than growing a
	 * second copy of the markup.
	 *
	 * @param {string} pageCls    Classes to use in Page Mode.
	 * @param {string} overlayCls Classes to use in overlay mode.
	 * @return {string}
	 */
	function modeCls( pageCls, overlayCls ) {
		return isPageMode ? pageCls : overlayCls;
	}

	var SVG_NS = 'http://www.w3.org/2000/svg';

	/**
	 * Page Mode icon set — one stroked family, drawn rather than typed.
	 *
	 * Typed glyphs were unreliable: U+2399 (the print symbol) is missing from
	 * almost every system font and rendered as nothing at all, and an emoji bin
	 * ignores currentColor, so it could not take the quiet-until-hover treatment
	 * the Style Spec asks of a destructive control. Paths are Feather Icons (MIT).
	 *
	 * @type {Object}
	 */
	var ICON_PATHS = {
		back: [ 'M15 18l-6-6 6-6' ],
		lessons: [ 'M3 6h18', 'M3 12h18', 'M3 18h18' ],
		print: [ 'M6 9V3h12v6', 'M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2', 'M6 14h12v7H6z' ],
		settings: [ 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' ],
		close: [ 'M18 6L6 18', 'M6 6l12 12' ],
		trash: [ 'M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6' ],
	};

	/**
	 * Build one of the icons above. Strokes use currentColor, so an icon always
	 * follows its button's hover and focus colours.
	 *
	 * @param {string} name Key in ICON_PATHS.
	 * @return {SVGElement|null}
	 */
	function icon( name ) {
		var paths = ICON_PATHS[ name ];
		if ( ! paths ) {
			return null;
		}
		var svg = document.createElementNS( SVG_NS, 'svg' );
		svg.setAttribute( 'viewBox', '0 0 24 24' );
		svg.setAttribute( 'width', '20' );
		svg.setAttribute( 'height', '20' );
		svg.setAttribute( 'fill', 'none' );
		svg.setAttribute( 'stroke', 'currentColor' );
		svg.setAttribute( 'stroke-width', '2' );
		svg.setAttribute( 'stroke-linecap', 'round' );
		svg.setAttribute( 'stroke-linejoin', 'round' );
		svg.setAttribute( 'aria-hidden', 'true' );
		svg.setAttribute( 'focusable', 'false' );
		paths.forEach( function ( d ) {
			var path = document.createElementNS( SVG_NS, 'path' );
			path.setAttribute( 'd', d );
			svg.appendChild( path );
		} );
		return svg;
	}

	function t( key, fallback ) {
		return i18n[ key ] != null ? i18n[ key ] : ( fallback || '' );
	}

	function fmtDate( s ) {
		if ( ! s ) {
			return '';
		}
		var d = new Date( s.replace( ' ', 'T' ) + 'Z' );
		if ( isNaN( d.getTime() ) ) {
			return '';
		}
		try {
			return d.toLocaleDateString( undefined, { year: 'numeric', month: 'short', day: 'numeric' } );
		} catch ( e ) {
			return d.toDateString();
		}
	}

	var MONTHS = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December',
	];

	/**
	 * Parse a stored MySQL GMT timestamp into a Date (today's date as a fallback).
	 *
	 * @param {string} s Timestamp like "2026-06-23 14:30:00".
	 * @return {Date}
	 */
	function parseDbDate( s ) {
		if ( ! s ) {
			return new Date();
		}
		var d = new Date( s.replace( ' ', 'T' ) + 'Z' );
		return isNaN( d.getTime() ) ? new Date() : d;
	}

	/**
	 * Long English date, e.g. "23 June 2026". Used in default/fallback note titles
	 * so they read the same regardless of the visitor's locale.
	 *
	 * @param {Date} d Date.
	 * @return {string}
	 */
	function formatLongDate( d ) {
		d = d || new Date();
		return d.getDate() + ' ' + MONTHS[ d.getMonth() ] + ' ' + d.getFullYear();
	}

	/* ----------------------------------------------------------- Note templates */

	// Default lesson-notes template, inserted into the body of a brand-new note.
	// Hardcoded for this iteration (a template editor can come later). Once
	// inserted the note is normal editable content — changing this template never
	// touches existing notes. Kept as semantic HTML (the editor's native format)
	// so headings and the nested list survive the sanitiser untouched.
	var noteTemplates = [
		{
			id: 'default-template',
			name: 'Default Template',
			html:
				'<h3>LESSON PLAN</h3>' +
				'<ol><li>Update on work and life<ol><li>one good thing</li></ol></li>' +
				'<li>Warmup</li></ol>' +
				'<h3>OPTIONS</h3><p><br></p>' +
				'<h3>LESSON NOTES</h3><p><br></p>' +
				'<h3>NEXT STEPS</h3><p><br></p>' +
				'<h3>HOMEWORK</h3><p><br></p>',
		},
	];

	function defaultNoteTemplateHtml() {
		return noteTemplates[ 0 ].html;
	}

	/* ---------------------------------------------------------------- Note title */

	/**
	 * The lesson-specific part of a note's title. Uses the editable header when
	 * set; otherwise a safe, dated fallback so even untitled/legacy notes read
	 * sensibly ("Lesson Notes — 23 June 2026").
	 *
	 * @param {Object} lesson Lesson object.
	 * @return {string}
	 */
	function lessonTitlePart( lesson ) {
		var header = lesson && lesson.header ? ( '' + lesson.header ).trim() : '';
		if ( header ) {
			return header;
		}
		var when = lesson && lesson.created_at ? parseDbDate( lesson.created_at ) : new Date();
		return t( 'lessonNotesTitle', 'Lesson Notes' ) + ' — ' + formatLongDate( when );
	}

	/**
	 * The full note title: "[class] — [lesson]". The class name is composed at
	 * display time (never stored on the note) so renaming a class keeps every note
	 * title current.
	 *
	 * @param {Object} cls    Class object.
	 * @param {Object} lesson Lesson object (optional).
	 * @return {string}
	 */
	function fullNoteTitle( cls, lesson ) {
		var className = cls && cls.title ? ( '' + cls.title ).trim() : '';
		if ( ! className ) {
			className = t( 'untitledClass', 'Untitled class' );
		}
		if ( ! lesson ) {
			return className;
		}
		return className + ' — ' + lessonTitlePart( lesson );
	}

	/* ----------------------------------------------------------- Browser tab title */

	// Remembered so we can restore it when notes close (helps tell TBT Notes tabs
	// apart from other tabs when screen-sharing in Microsoft Teams).
	var originalDocTitle = null;

	/**
	 * Site-name suffix for the tab title, reused from the host page's own title
	 * ("… | THE BLUE TREE") so it matches the rest of the site; falls back to the
	 * configured site name.
	 *
	 * @return {string}
	 */
	function siteTitleSuffix() {
		if ( originalDocTitle && originalDocTitle.indexOf( '|' ) !== -1 ) {
			var parts = originalDocTitle.split( '|' );
			var last = parts[ parts.length - 1 ].trim();
			if ( last ) {
				return last;
			}
		}
		return t( 'siteName', 'The Blue Tree' );
	}

	/**
	 * Set the browser tab title to reflect the open note, e.g.
	 * "TBT Notes — Iwona Wróbel — Gerund or Infinitive | The Blue Tree".
	 */
	function updateDocTitle() {
		if ( originalDocTitle === null ) {
			originalDocTitle = document.title;
		}
		var label = t( 'notesTabPrefix', 'TBT Notes' );
		if ( state.currentClass && state.currentClass.title ) {
			label += ' — ' + fullNoteTitle( state.currentClass, state.currentLesson );
		}
		document.title = label + ' | ' + siteTitleSuffix();
	}

	/**
	 * Restore the page title captured before notes opened.
	 */
	function restoreDocTitle() {
		if ( originalDocTitle !== null ) {
			document.title = originalDocTitle;
			originalDocTitle = null;
		}
	}

	/* --------------------------------------------------------------- Gradients */

	// Deterministic two-hue gradients for class-card headers. The same class
	// always maps to the same gradient.
	//
	// DECORATIVE ONLY. The gradient is picked by a hash of the class ID: it does
	// NOT mean the class belongs to a content domain, and nothing in the UI may
	// infer a category from it. Do not read meaning back out of this array, and
	// never reuse one of these colours for a state, an error or a destructive
	// action — coral is decoration, --tbt-error is danger (TBT-STYLE-SPEC.md §1).
	//
	// Written as literals rather than var(--tbt-le) etc. because these strings go
	// into an inline style: a token that a given site's TBT-Hub has not shipped
	// yet would make the whole declaration invalid and blank the header. They
	// mirror the domain hues plus the decorative palette in tbt-tokens.css.
	var classGradients = [
		'linear-gradient(135deg, #660000, #CC9933)', /* maroon → gold   */
		'linear-gradient(135deg, #663366, #FF6B6B)', /* purple → coral  */
		'linear-gradient(135deg, #006600, #008080)', /* green  → teal   */
		'linear-gradient(135deg, #008080, #663366)', /* teal   → purple */
		'linear-gradient(135deg, #CC9933, #660000)', /* gold   → maroon */
		'linear-gradient(135deg, #FF6B6B, #CC9933)', /* coral  → gold   */
		'linear-gradient(135deg, #663366, #008080)', /* purple → teal   */
		'linear-gradient(135deg, #006600, #CC9933)', /* green  → gold   */
	];

	function getGradientForClass( cls ) {
		var source = '' + ( ( cls && cls.id ) || ( cls && cls.title ) || '' );
		// Scatter, don't accumulate. Summing character codes made consecutive
		// class IDs land on consecutive gradients, so a freshly created run of
		// classes stepped through the palette in order instead of looking
		// unrelated. Shift-and-subtract over the characters (kept in int32 by the
		// |0), then a murmur3 finalizer — without that last avalanche step a
		// one- or two-digit ID barely differs from its neighbour and the run
		// still comes out in order.
		var hash = 0;
		for ( var i = 0; i < source.length; i++ ) {
			hash = ( ( hash << 5 ) - hash + source.charCodeAt( i ) ) | 0;
		}
		hash ^= hash >>> 16;
		hash = Math.imul( hash, 0x85ebca6b );
		hash ^= hash >>> 13;
		hash = Math.imul( hash, 0xc2b2ae35 );
		hash ^= hash >>> 16;
		return classGradients[ ( hash >>> 0 ) % classGradients.length ];
	}

	// Owned by PHP (filterable via tbt_notes_logo_url) so the hero and the class
	// cards can never drift apart.
	var TBT_LOGO_URL = cfg.logoUrl || '';

	function api( method, path, body ) {
		var opts = {
			method: method,
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': cfg.nonce,
			},
			credentials: 'same-origin',
		};
		if ( body !== undefined ) {
			opts.body = JSON.stringify( body );
		}
		if ( unloading ) {
			opts.keepalive = true;
		}
		return fetch( cfg.restUrl + path, opts ).then( function ( res ) {
			return res.json().catch( function () {
				return null;
			} ).then( function ( data ) {
				if ( ! res.ok ) {
					var err = new Error( ( data && data.message ) || t( 'genericError', 'Error' ) );
					err.status = res.status;
					throw err;
				}
				return data;
			} );
		} );
	}

	/* ------------------------------------------------------------ Image upload */

	var IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB, matching the server cap.

	/**
	 * Upload one image file to a lesson via multipart/form-data. Kept separate
	 * from api() (which is JSON-only) and free of a Content-Type header so the
	 * browser sets the multipart boundary. Reusable by a future paste flow: it
	 * only needs a lesson id and a File/Blob.
	 *
	 * @param {number} lessonId Lesson id.
	 * @param {File}   file     Image file.
	 * @return {Promise<Object>} Resolves with the parsed { image } response.
	 */
	function uploadLessonImage( lessonId, file ) {
		var form = new FormData();
		form.append( 'file', file );

		return fetch( cfg.restUrl + 'lessons/' + lessonId + '/image', {
			method: 'POST',
			headers: {
				'X-WP-Nonce': cfg.nonce,
			},
			credentials: 'same-origin',
			body: form,
		} ).then( function ( res ) {
			return res.json().catch( function () {
				return null;
			} ).then( function ( data ) {
				if ( ! res.ok ) {
					var err = new Error( ( data && data.message ) || t( 'imageError', 'Could not upload the image. Please try again.' ) );
					err.status = res.status;
					throw err;
				}
				return data;
			} );
		} );
	}

	/**
	 * Client-side pre-check for a chosen image. UX only — the server remains the
	 * authority. Returns an error message string, or '' when the file looks OK.
	 *
	 * @param {File} file Chosen file.
	 * @return {string}
	 */
	function validateImageFile( file ) {
		if ( ! file ) {
			return t( 'imageTypeError', 'Please choose a JPG or PNG image.' );
		}
		var type = ( file.type || '' ).toLowerCase();
		var name = ( file.name || '' ).toLowerCase();
		var extOk = /\.(jpe?g|png)$/.test( name );

		if ( type ) {
			// Trust the reported MIME type when the browser gives us one.
			if ( type !== 'image/jpeg' && type !== 'image/png' ) {
				return t( 'imageTypeError', 'Please choose a JPG or PNG image.' );
			}
		} else if ( ! extOk ) {
			// No type (some phones) — fall back to the file extension.
			return t( 'imageTypeError', 'Please choose a JPG or PNG image.' );
		}

		if ( file.size > IMAGE_MAX_BYTES ) {
			return t( 'imageTooLarge', 'The image is too large. Please choose an image under 8 MB.' );
		}
		return '';
	}

	/* ---------------------------------------------------------- Panel open/close */

	function openPanel( opener ) {
		// In page mode the app is always open; opening is a no-op.
		if ( isPageMode ) {
			return;
		}
		if ( opener ) {
			lastOpener = opener;
		}
		root.classList.add( 'is-open' );
		// Full-screen workspace: lock the background page so only the notes
		// content scrolls, and flag the tab so it's identifiable when shared.
		document.body.classList.add( 'tbt-notes-open' );
		updateDocTitle();
		if ( launcher ) {
			launcher.setAttribute( 'aria-expanded', 'true' );
		}
		panel.setAttribute( 'aria-hidden', 'false' );
		if ( overlay ) {
			overlay.hidden = false;
		}
		document.addEventListener( 'keydown', onKeydown );
		if ( ! state.loaded ) {
			bootstrap();
		}
		window.setTimeout( function () {
			var focusable = panel.querySelector( '.tbt-notes-iconbtn, button, [tabindex]' );
			if ( focusable ) {
				focusable.focus();
			}
		}, 50 );
	}

	function closePanel() {
		// Page mode has no overlay to close; just persist any pending edits.
		if ( isPageMode ) {
			flushActiveSaver();
			return;
		}
		flushActiveSaver();
		root.classList.remove( 'is-open' );
		// Restore normal page scrolling and the original tab title.
		document.body.classList.remove( 'tbt-notes-open' );
		restoreDocTitle();
		if ( launcher ) {
			launcher.setAttribute( 'aria-expanded', 'false' );
		}
		panel.setAttribute( 'aria-hidden', 'true' );
		if ( overlay ) {
			overlay.hidden = true;
		}
		document.removeEventListener( 'keydown', onKeydown );
		var returnTo = lastOpener || launcher;
		if ( returnTo && typeof returnTo.focus === 'function' ) {
			returnTo.focus();
		}
	}

	function onKeydown( e ) {
		if ( e.key === 'Escape' ) {
			closePanel();
		}
	}

	/* ---------------------------------------------------------------- Bootstrap */

	function bootstrap() {
		state.loaded = false;
		render();
		api( 'GET', 'me' ).then( function ( data ) {
			state.classes = data.classes || [];
			state.loaded = true;
			if ( state.isTeacher ) {
				state.view = 'root';
				render();
			} else if ( state.classes.length ) {
				openClass( state.classes[ 0 ] );
			} else {
				state.view = 'empty';
				render();
			}
		} ).catch( function ( err ) {
			state.loaded = true;
			state.error = err.message;
			render();
		} );
	}

	/* ------------------------------------------------------------------ Chrome */

	/**
	 * A square icon-only control. Page Mode draws the icon; overlay mode keeps the
	 * typed glyph it has always used.
	 *
	 * @param {string}   symbol   Glyph for overlay mode.
	 * @param {string}   label    Accessible name. Required — the control has no text.
	 * @param {Function} onClick  Click handler.
	 * @param {string}   iconName Key in ICON_PATHS, used in Page Mode.
	 * @return {HTMLElement}
	 */
	function iconButton( symbol, label, onClick, iconName ) {
		var b = el( 'button', 'tbt-notes-iconbtn' );
		b.type = 'button';
		b.setAttribute( 'aria-label', label );
		b.title = label;
		var drawn = isPageMode ? icon( iconName ) : null;
		if ( drawn ) {
			b.appendChild( drawn );
		} else {
			b.textContent = symbol;
		}
		b.addEventListener( 'click', onClick );
		return b;
	}

	function buildTopbar( opts ) {
		var bar = el( 'div', 'tbt-notes-topbar' );
		var inner = el( 'div', 'tbt-notes-topbar__inner' );
		
		if ( opts.onBack ) {
			inner.appendChild( iconButton( '‹', t( 'back', 'Back' ), opts.onBack, 'back' ) );
		}

		// Centered Title Container
		var titleWrap = el( 'div', 'tbt-notes-topbar__title-wrap' );
		
		if ( opts.title ) {
			titleWrap.appendChild( el( 'div', 'tbt-notes-topbar__title', opts.title ) );
		}
		
		// Subtitle (either an input field for teachers, or plain text for students)
		if ( opts.subtitleEl ) {
			titleWrap.appendChild( opts.subtitleEl );
		} else if ( opts.subtitle ) {
			titleWrap.appendChild( el( 'div', 'tbt-notes-topbar__subtitle', opts.subtitle ) );
		}
		inner.appendChild( titleWrap );

		( opts.buttons || [] ).forEach( function ( btn ) {
			inner.appendChild( iconButton( btn.symbol, btn.label, btn.onClick, btn.icon ) );
		} );
		// Page mode has no overlay to dismiss, so omit the close button (the back
		// button for class → classes navigation is added separately and stays).
		if ( ! isPageMode ) {
			inner.appendChild( iconButton( '✕', t( 'close', 'Close' ), closePanel, 'close' ) );
		}
		bar.appendChild( inner );
		
		return bar;
	}

	function emptyBlock( msg ) {
		if ( ! isPageMode ) {
			return el( 'div', 'tbt-notes-empty', msg );
		}
		var box = el( 'div', 'tbt-empty' );
		box.appendChild( el( 'p', 'tbt-empty__text', msg ) );
		return box;
	}

	function errorBlock( msg ) {
		return el( 'div', modeCls(
			'tbt-notice tbt-notice--error',
			'tbt-notes-inlinemsg tbt-notes-inlinemsg--error'
		), msg );
	}

	/* --------------------------------------------------------------- Render root */

	/**
	 * Re-render the whole surface.
	 *
	 * In Page Mode this replaces the class strip and the editor wholesale, so
	 * anything the sticky controller has pinned is put back into the document
	 * first — otherwise it would be torn away from its spacer and left orphaned
	 * inside the fixed host. Afterwards the controller re-measures, so switching
	 * lesson while scrolled down re-pins the new strip and toolbar immediately.
	 */
	function render() {
		if ( pageSticky ) {
			pageSticky.unpinAll();
		}
		renderView();
		if ( pageSticky ) {
			pageSticky.update();
		}
	}

	function renderView() {
		clear( content );

		// Keep the browser tab title in step with whatever is on screen.
		if ( root.classList.contains( 'is-open' ) ) {
			updateDocTitle();
		}

		if ( ! state.loaded ) {
			content.appendChild( buildTopbar( {} ) );
			content.appendChild( el( 'div', 'tbt-notes-loading', t( 'loading', 'Loading…' ) ) );
			return;
		}

		if ( state.error ) {
			content.appendChild( buildTopbar( {} ) );
			var b = el( 'div', 'tbt-notes-body' );
			b.appendChild( errorBlock( state.error ) );
			content.appendChild( b );
			return;
		}

		if ( state.isTeacher ) {
			if ( state.view === 'class' ) {
				renderClassView( true );
			} else if ( state.view === 'classSettings' ) {
				renderClassSettings();
			} else {
				renderTeacherRoot();
			}
		} else if ( state.view === 'class' ) {
			renderClassView( false );
		} else {
			renderStudentEmpty();
		}
	}

	/* ------------------------------------------------------------ Student empty */

	function renderStudentEmpty() {
		content.appendChild( buildTopbar( { title: '' } ) );
		var body = el( 'div', 'tbt-notes-body' );
		body.appendChild( emptyBlock( t( 'noClassStudent', 'You have no notes assigned yet.' ) ) );
		content.appendChild( body );
	}

	/* ------------------------------------------------------------- Teacher root */

	function renderTeacherRoot() {
		// In page mode the "CLASSES" banner (logo / title) is provided by the
		// surrounding page (e.g. Divi), so we omit the branded in-app header here.
		if ( ! isPageMode ) {
			content.appendChild( buildTopbar( { title: t( 'headerClasses', 'CLASSES' ) } ) );
		}
		var body = el( 'div', 'tbt-notes-body tbt-notes-body--classes' );

		// A small "New class" action sits near the page header (the big "CLASSES"
		// lives in the branded top bar), rather than a heavy full-width button.
		var head = el( 'div', 'tbt-notes-classes-head' );
		var newBtn = el( 'button', modeCls(
			'tbt-button tbt-button--primary tbt-notes-newclass-btn',
			'tbt-notes-btn tbt-notes-newclass-btn'
		), '+ ' + t( 'newClass', 'New class' ) );
		newBtn.type = 'button';
		newBtn.addEventListener( 'click', createClassFlow );
		head.appendChild( newBtn );
		body.appendChild( head );

		if ( ! state.classes.length ) {
			body.appendChild( emptyBlock( t( 'noClassesTeacher', 'No classes yet.' ) ) );
			content.appendChild( body );
			return;
		}

		// Filter-as-you-type search (classes are already loaded client-side).
		var search = el( 'input', modeCls(
			'tbt-input tbt-notes-classsearch',
			'tbt-notes-input tbt-notes-classsearch'
		) );
		search.type = 'text';
		search.placeholder = t( 'searchClasses', 'Search classes…' );
		search.setAttribute( 'autocomplete', 'off' );
		body.appendChild( search );

		var grid = el( 'div', 'tbt-notes-classes-grid' );
		body.appendChild( grid );

		function renderGrid( term ) {
			clear( grid );
			var q = ( term || '' ).trim().toLowerCase();
			var matches = state.classes.filter( function ( cls ) {
				return ! q || ( cls.title || '' ).toLowerCase().indexOf( q ) !== -1;
			} );
			if ( ! matches.length ) {
				grid.appendChild( emptyBlock( t( 'noResults', 'No matches' ) ) );
				return;
			}
			matches.forEach( function ( cls ) {
				grid.appendChild( classCard( cls ) );
			} );
		}

		search.addEventListener( 'input', function () {
			renderGrid( search.value );
		} );
		renderGrid( '' );

		content.appendChild( body );
	}

	/**
	 * A single class card: a branded gradient header with a decorative TBT logo,
	 * then the class title and student/note counts. The whole card opens the
	 * class; the corner button deletes it.
	 */
	function classCard( cls ) {
		var card = el( 'div', 'tbt-notes-classcard' );

		var open = el( 'button', 'tbt-notes-classcard__open' );
		open.type = 'button';
		open.addEventListener( 'click', function () {
			openClass( cls );
		} );

		// Gradient header (deterministic per class) + decorative logo.
		var header = el( 'div', 'tbt-notes-classcard__header' );
		header.style.background = getGradientForClass( cls );
		// The logo is decorative: skip it entirely if the site has filtered it away
		// rather than requesting the current page as an image.
		if ( TBT_LOGO_URL ) {
			var logo = el( 'img', 'tbt-notes-classcard__logo' );
			logo.src = TBT_LOGO_URL;
			logo.alt = '';
			logo.setAttribute( 'aria-hidden', 'true' );
			logo.setAttribute( 'loading', 'lazy' );
			// If the remote logo ever fails, just drop it — the card still looks good.
			logo.addEventListener( 'error', function () {
				logo.style.display = 'none';
			} );
			header.appendChild( logo );
		}
		open.appendChild( header );

		// Body: title + metadata on separate lines, grammatically correct.
		var cbody = el( 'div', 'tbt-notes-classcard__body' );
		cbody.appendChild( el( 'div', 'tbt-notes-classcard__title', cls.title || t( 'untitledClass', 'Untitled class' ) ) );

		var students = cls.student_count != null ? cls.student_count : ( cls.students ? cls.students.length : 0 );
		var notes = cls.note_count != null ? cls.note_count : 0;
		var meta = el( 'div', 'tbt-notes-classcard__meta' );
		meta.appendChild( el( 'span', null, students === 1
			? t( 'oneStudent', '1 student' )
			: ( students + ' ' + t( 'nStudents', 'students' ) ) ) );
		meta.appendChild( el( 'span', null, notes === 1
			? t( 'oneNote', '1 note' )
			: ( notes + ' ' + t( 'nNotes', 'notes' ) ) ) );
		cbody.appendChild( meta );
		open.appendChild( cbody );

		card.appendChild( open );

		// Delete stays available (edit lives behind opening the class → settings).
		var del = el( 'button', modeCls(
			'tbt-notes-classcard__delete tbt-icon-button tbt-icon-button--danger',
			'tbt-notes-classcard__delete'
		) );
		del.type = 'button';
		if ( isPageMode ) {
			del.appendChild( icon( 'trash' ) );
		} else {
			del.textContent = '🗑';
		}
		del.title = t( 'deleteClass', 'Delete class' );
		del.setAttribute( 'aria-label', t( 'deleteClass', 'Delete class' ) );
		del.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			deleteClassFlow( cls );
		} );
		card.appendChild( del );

		return card;
	}

	function iconDelete( label, onClick ) {
		var b = el( 'button', modeCls(
			'tbt-notes-listitem__delete tbt-icon-button tbt-icon-button--danger',
			'tbt-notes-listitem__delete'
		) );
		b.type = 'button';
		b.setAttribute( 'aria-label', label );
		b.title = label;
		if ( isPageMode ) {
			b.appendChild( icon( 'trash' ) );
		} else {
			b.textContent = '🗑';
		}
		b.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			onClick();
		} );
		return b;
	}

	/* ----------------------------------------------------------- Open a class */

	function openClass( cls ) {
		state.currentClass = cls;
		state.lessons = [];
		state.currentLesson = null;
		state.highlightFilter = 'full';
		state.view = 'class';
		state.loadingLessons = true;
		render();
		// Fired alongside the lessons request, never before or instead of it.
		loadExtras( cls.id );
		api( 'GET', 'classes/' + cls.id + '/lessons' ).then( function ( data ) {
			state.lessons = data.lessons || [];
			state.currentLesson = state.lessons.length ? state.lessons[ 0 ] : null;
			state.loadingLessons = false;
			render();
		} ).catch( function ( err ) {
			state.loadingLessons = false;
			state.error = err.message;
			render();
		} );
	}

	/* ------------------------------------------------------------- Class extras */

	/*
	 * "Extras" is the generic extension point: another plugin contributes groups
	 * of links for a class, Notes renders them without knowing what produced
	 * them. Three rules shape everything below.
	 *
	 * 1. The request runs in parallel with the lessons fetch and must never hold
	 *    it up, so the response paints itself into the sidebar rather than
	 *    triggering render() — a full re-render would re-mount the teacher's
	 *    editor mid-edit.
	 * 2. Failure and emptiness are silent. No error, no placeholder heading:
	 *    with no contributors installed the panel looks exactly as it always did.
	 * 3. Item text comes from teacher input, so it is only ever written as text
	 *    nodes (el() sets textContent) — never innerHTML.
	 *
	 * An item that names a lesson is drawn on that lesson's row. Everything else
	 * falls through to the group list below the lessons, which is the safety net
	 * described at renderExtrasGroups(): an item must never simply disappear.
	 */

	function loadExtras( classId ) {
		state.extras = [];
		state.extrasClassId = classId;
		state.extrasOpenGroups = {};
		state.extrasOpenItem = '';
		state.extrasOpenLesson = 0;

		api( 'GET', 'classes/' + classId + '/extras' ).then( function ( data ) {
			// The user may have moved to another class while this was in flight.
			if ( state.extrasClassId !== classId ) {
				return;
			}
			state.extras = Array.isArray( data ) ? data : [];
			paintExtras();
		} ).catch( function () {
			// Optional by design: on failure the class simply has no extras.
		} );
	}

	/**
	 * Every contributed item, flattened and tagged with the group it came from
	 * and a stable key. The key identifies an item across both surfaces (lesson
	 * row and fallback group), which is what keeps "only one open at a time"
	 * true when the two are mixed.
	 *
	 * @return {Array} Entries of { group, item, key, lessonId }.
	 */
	function extrasEntries() {
		var out = [];
		state.extras.forEach( function ( group ) {
			if ( ! group || ! group.key || ! Array.isArray( group.items ) ) {
				return;
			}
			group.items.forEach( function ( item, i ) {
				if ( ! item ) {
					return;
				}
				out.push( {
					group: group,
					item: item,
					key: group.key + ':' + i,
					lessonId: parseInt( item.lesson_id, 10 ) || 0
				} );
			} );
		} );
		return out;
	}

	/**
	 * Entries anchored to a lesson that is actually on screen, keyed by lesson
	 * ID. An item naming a lesson that no longer exists — deleted since the deck
	 * was made — is deliberately excluded so it falls through to the group list
	 * instead of pointing at a row that is not there.
	 *
	 * @return {Object} lessonId → entries.
	 */
	function extrasByLesson() {
		var known = {};
		state.lessons.forEach( function ( lesson ) {
			known[ lesson.id ] = true;
		} );

		var map = {};
		extrasEntries().forEach( function ( entry ) {
			if ( ! entry.lessonId || ! known[ entry.lessonId ] ) {
				return;
			}
			if ( ! map[ entry.lessonId ] ) {
				map[ entry.lessonId ] = [];
			}
			map[ entry.lessonId ].push( entry );
		} );
		return map;
	}

	/**
	 * Only http(s) links are ever rendered. The server already drops anything
	 * else (esc_url_raw), so this is a second line of defence against a
	 * contributed javascript: URL reaching an href.
	 *
	 * @param {string} url Candidate URL.
	 * @return {string} The URL, or '' if it is not safe to link to.
	 */
	function safeExtrasUrl( url ) {
		return /^https?:\/\//i.test( String( url || '' ) ) ? String( url ) : '';
	}

	/**
	 * Repaint both extras surfaces: the icons on the lesson rows and the group
	 * list below them.
	 *
	 * @param {string} focusKey Optional data-tbt-extras-key to restore focus to,
	 *                          so keyboard users are not dropped to the top of
	 *                          the panel when a section opens or closes.
	 */
	function paintExtras( focusKey ) {
		paintLessonExtras();
		paintExtrasGroups();

		if ( focusKey ) {
			var target = content.querySelector( '[data-tbt-extras-key="' + focusKey + '"]' );
			if ( target ) {
				target.focus();
			}
		}
	}

	/**
	 * Draw the per-lesson controls onto the rows that have items.
	 *
	 * Rows are found in the DOM rather than re-rendered, because this runs when
	 * the extras response lands — after the lessons list is already on screen
	 * and possibly while the teacher is typing in the editor beside it.
	 */
	function paintLessonExtras() {
		var nav = content.querySelector( '.tbt-notes-lesson-nav' );
		if ( ! nav ) {
			return;
		}

		// Clear first: this is a repaint, and a lesson may have lost its items.
		Array.prototype.forEach.call( nav.querySelectorAll( '.tbt-notes-lesson-extras, .tbt-notes-lesson-extras__panel' ), function ( node ) {
			node.parentNode.removeChild( node );
		} );

		var byLesson = extrasByLesson();

		Array.prototype.forEach.call( nav.querySelectorAll( '[data-tbt-lesson-id]' ), function ( row ) {
			var lessonId = parseInt( row.getAttribute( 'data-tbt-lesson-id' ), 10 ) || 0;
			var entries = byLesson[ lessonId ];
			if ( ! entries || ! entries.length ) {
				row.classList.remove( 'has-extras', 'is-extras-open' );
				return;
			}

			var isOpen = state.extrasOpenLesson === lessonId;
			row.classList.add( 'has-extras' );
			row.classList.toggle( 'is-extras-open', isOpen );

			// Before the delete control, so the destructive action stays last.
			var deleteBtn = row.querySelector( '.tbt-notes-listitem__delete' );
			var button = lessonExtrasButton( lessonId, entries, isOpen );
			if ( deleteBtn ) {
				row.insertBefore( button, deleteBtn );
			} else {
				row.appendChild( button );
			}

			if ( isOpen ) {
				row.appendChild( lessonExtrasPanel( entries ) );
			}
		} );
	}

	/**
	 * The control on a lesson row: the contributor's mark, plus a count when the
	 * lesson has more than one item.
	 *
	 * @param {number} lessonId Lesson the row belongs to.
	 * @param {Array}  entries  Items anchored to it.
	 * @param {boolean} isOpen  Whether its panel is showing.
	 * @return {HTMLElement}
	 */
	function lessonExtrasButton( lessonId, entries, isOpen ) {
		var button = el( 'button', 'tbt-notes-lesson-extras' + ( isOpen ? ' is-open' : '' ) );
		button.type = 'button';
		button.setAttribute( 'aria-expanded', isOpen ? 'true' : 'false' );
		button.setAttribute( 'data-tbt-extras-key', 'l:' + lessonId );
		button.setAttribute( 'aria-label', t( 'extrasOpenDeck', 'Pokaż fiszki' ) );
		button.title = t( 'extrasOpenDeck', 'Pokaż fiszki' );

		button.appendChild( extrasIcon( entries[ 0 ].group ) );
		if ( entries.length > 1 ) {
			button.appendChild( el( 'span', 'tbt-notes-lesson-extras__count', String( entries.length ) ) );
		}

		button.addEventListener( 'click', function ( e ) {
			// The row itself opens the note. Without this, one tap would both
			// switch the note and open the deck.
			e.stopPropagation();
			var wasOpen = state.extrasOpenLesson === lessonId;
			state.extrasOpenLesson = wasOpen ? 0 : lessonId;
			// Opening one closes every other, on either surface.
			state.extrasOpenItem = ( ! wasOpen && entries.length === 1 ) ? entries[ 0 ].key : '';
			paintExtras( 'l:' + lessonId );
		} );

		return button;
	}

	/**
	 * What a lesson row expands to. One item opens straight to its QR and link;
	 * several become a short list, one open at a time.
	 *
	 * @param {Array} entries Items anchored to this lesson.
	 * @return {HTMLElement}
	 */
	function lessonExtrasPanel( entries ) {
		var panel = el( 'div', 'tbt-notes-lesson-extras__panel' );

		if ( entries.length === 1 ) {
			var entry = entries[ 0 ];
			panel.appendChild( el( 'div', 'tbt-notes-extras__title', entry.item.title || '' ) );
			if ( entry.item.subtitle ) {
				panel.appendChild( el( 'div', 'tbt-notes-extras__subtitle', entry.item.subtitle ) );
			}
			panel.appendChild( extrasDetail( entry.item ) );
			return panel;
		}

		var list = el( 'ul', 'tbt-notes-extras__list' );
		entries.forEach( function ( entry ) {
			list.appendChild( extrasItem( entry.item, entry.key, true ) );
		} );
		panel.appendChild( list );
		return panel;
	}

	/**
	 * The contributor's icon, or a neutral built-in one.
	 *
	 * The supplied markup has already been through an SVG allowlist server-side.
	 * It is parsed here rather than assigned as innerHTML, and re-checked on the
	 * way through, so even a mistake in that allowlist cannot put a handler or a
	 * script into the page. Anything unexpected falls back to the built-in mark,
	 * which keeps the row's control working.
	 *
	 * @param {Object} group Group the item came from.
	 * @return {HTMLElement}
	 */
	function extrasIcon( group ) {
		var raw = group && typeof group.icon === 'string' ? group.icon : '';

		if ( raw && window.DOMParser ) {
			try {
				var parsed = new window.DOMParser().parseFromString( raw, 'text/html' );
				var svg = parsed.body ? parsed.body.querySelector( 'svg' ) : null;
				if ( svg && scrubSvg( svg ) ) {
					svg.setAttribute( 'aria-hidden', 'true' );
					svg.setAttribute( 'focusable', 'false' );
					svg.classList.add( 'tbt-notes-lesson-extras__icon' );
					return document.importNode( svg, true );
				}
			} catch ( e ) {
				// Fall through to the built-in mark.
			}
		}

		return defaultExtrasIcon();
	}

	/**
	 * Strip anything executable or fetching from a parsed icon.
	 *
	 * @param {Element} svg Parsed <svg>.
	 * @return {boolean} False if the icon is not worth rendering.
	 */
	function scrubSvg( svg ) {
		var banned = svg.querySelectorAll( 'script, foreignObject, use, image, a, style, animate, set, iframe, object, embed' );
		Array.prototype.forEach.call( banned, function ( node ) {
			node.parentNode.removeChild( node );
		} );

		var all = [ svg ].concat( Array.prototype.slice.call( svg.querySelectorAll( '*' ) ) );
		all.forEach( function ( node ) {
			Array.prototype.slice.call( node.attributes ).forEach( function ( attr ) {
				var name = attr.name.toLowerCase();
				if ( name.indexOf( 'on' ) === 0 || name === 'href' || name === 'xlink:href' || name === 'src' || name === 'style' ) {
					node.removeAttribute( attr.name );
				}
			} );
		} );

		// An icon with no shapes left is not an icon.
		return !! svg.querySelector( 'path, circle, rect, polygon, g' );
	}

	/**
	 * Neutral stand-in when a contributor supplies no usable icon: two stacked
	 * cards, drawn as elements so no markup is ever parsed.
	 *
	 * @return {SVGElement}
	 */
	function defaultExtrasIcon() {
		var NS = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS( NS, 'svg' );
		svg.setAttribute( 'viewBox', '0 0 24 24' );
		svg.setAttribute( 'width', '18' );
		svg.setAttribute( 'height', '18' );
		svg.setAttribute( 'aria-hidden', 'true' );
		svg.setAttribute( 'focusable', 'false' );
		svg.setAttribute( 'class', 'tbt-notes-lesson-extras__icon' );

		[ [ 3, 7 ], [ 7, 3 ] ].forEach( function ( xy ) {
			var rect = document.createElementNS( NS, 'rect' );
			rect.setAttribute( 'x', xy[ 0 ] );
			rect.setAttribute( 'y', xy[ 1 ] );
			rect.setAttribute( 'width', '14' );
			rect.setAttribute( 'height', '14' );
			rect.setAttribute( 'rx', '3' );
			rect.setAttribute( 'fill', 'none' );
			rect.setAttribute( 'stroke', 'currentColor' );
			rect.setAttribute( 'stroke-width', '1.6' );
			svg.appendChild( rect );
		} );

		return svg;
	}

	/**
	 * The group list under the lessons.
	 *
	 * It now renders only what no lesson row claimed: items with no lesson, and
	 * items naming a lesson that no longer exists. In day-to-day use it is
	 * empty and draws nothing. That is the point of keeping it — an item whose
	 * anchor has gone stale still has somewhere to appear, and quietly vanishing
	 * is the one failure here that looks like nothing at all.
	 */
	function paintExtrasGroups() {
		var host = content.querySelector( '[data-tbt-extras]' );
		if ( ! host ) {
			return;
		}
		clear( host );

		var claimed = extrasByLesson();
		var anchored = {};
		Object.keys( claimed ).forEach( function ( lessonId ) {
			claimed[ lessonId ].forEach( function ( entry ) {
				anchored[ entry.key ] = true;
			} );
		} );

		state.extras.forEach( function ( group ) {
			if ( ! group || ! group.key || ! Array.isArray( group.items ) ) {
				return;
			}
			var leftover = extrasEntries().filter( function ( entry ) {
				return entry.group === group && ! anchored[ entry.key ];
			} );
			// A group with nothing left over is dropped rather than shown empty.
			if ( ! leftover.length ) {
				return;
			}
			host.appendChild( extrasGroup( group, leftover ) );
		} );
	}

	function extrasGroup( group, entries ) {
		var isOpen = !! state.extrasOpenGroups[ group.key ];
		var section = el( 'section', 'tbt-notes-extras__group' + ( isOpen ? ' is-open' : '' ) );

		var toggle = el( 'button', 'tbt-notes-extras__toggle' );
		toggle.type = 'button';
		toggle.setAttribute( 'aria-expanded', isOpen ? 'true' : 'false' );
		toggle.setAttribute( 'data-tbt-extras-key', 'g:' + group.key );
		toggle.appendChild( el( 'span', 'tbt-notes-extras__caret', isOpen ? '▾' : '▸' ) );
		toggle.appendChild( el( 'span', 'tbt-notes-extras__label', group.label || '' ) );
		toggle.appendChild( el( 'span', 'tbt-notes-extras__count', '(' + entries.length + ')' ) );
		toggle.addEventListener( 'click', function () {
			state.extrasOpenGroups[ group.key ] = ! isOpen;
			paintExtras( 'g:' + group.key );
		} );
		section.appendChild( toggle );

		// Collapsed by default: the lessons list stays the focus of the sidebar.
		if ( isOpen ) {
			var list = el( 'ul', 'tbt-notes-extras__list' );
			entries.forEach( function ( entry ) {
				list.appendChild( extrasItem( entry.item, entry.key ) );
			} );
			section.appendChild( list );
		}

		return section;
	}

	/**
	 * One item row plus its expanded detail.
	 *
	 * @param {Object}  item          Contributed item.
	 * @param {string}  itemKey       Stable key, unique across both surfaces.
	 * @param {boolean} inLessonPanel True when rendered inside a lesson row's
	 *                                panel, where closing the lesson is the
	 *                                caller's business, not this row's.
	 * @return {HTMLElement}
	 */
	function extrasItem( item, itemKey, inLessonPanel ) {
		var isOpen = state.extrasOpenItem === itemKey;
		var li = el( 'li', 'tbt-notes-extras__item' + ( isOpen ? ' is-open' : '' ) );

		var row = el( 'button', 'tbt-notes-extras__row' );
		row.type = 'button';
		row.setAttribute( 'aria-expanded', isOpen ? 'true' : 'false' );
		row.setAttribute( 'data-tbt-extras-key', 'i:' + itemKey );
		row.appendChild( el( 'span', 'tbt-notes-extras__title', item.title || '' ) );
		if ( item.subtitle ) {
			row.appendChild( el( 'span', 'tbt-notes-extras__subtitle', item.subtitle ) );
		}
		row.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			// One open item at a time, counting both surfaces: opening an item
			// in the group list closes whatever a lesson row had open.
			state.extrasOpenItem = isOpen ? '' : itemKey;
			if ( ! inLessonPanel ) {
				state.extrasOpenLesson = 0;
			}
			paintExtras( 'i:' + itemKey );
		} );
		li.appendChild( row );

		if ( isOpen ) {
			li.appendChild( extrasDetail( item ) );
		}

		return li;
	}

	/**
	 * The expanded row: QR code and link, both visible at once. QR comes first
	 * because the classroom flow is students scanning it off a screen.
	 *
	 * @param {Object} item Extras item.
	 * @return {HTMLElement}
	 */
	function extrasDetail( item ) {
		var detail = el( 'div', 'tbt-notes-extras__detail' );
		var url = safeExtrasUrl( item.url );
		if ( ! url ) {
			return detail;
		}

		// Notes ships no QR library. Whichever plugin contributed the item may
		// provide one; if none did, the row degrades to the link alone — no
		// broken image, no console error.
		if ( window.TBTNotesQR && typeof window.TBTNotesQR.render === 'function' ) {
			var qr = el( 'div', 'tbt-notes-extras__qr' );
			detail.appendChild( qr );
			try {
				window.TBTNotesQR.render( qr, url );
			} catch ( e ) {
				// A broken adapter must not take the panel down with it.
				detail.removeChild( qr );
			}
		}

		var linkRow = el( 'div', 'tbt-notes-extras__linkrow' );

		var link = el( 'a', 'tbt-notes-extras__link', url );
		link.href = url;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		linkRow.appendChild( link );

		var copy = el( 'button', 'tbt-notes-btn tbt-notes-extras__copy', t( 'extrasCopy', 'Kopiuj link' ) );
		copy.type = 'button';
		copy.addEventListener( 'click', function () {
			if ( ! navigator.clipboard || ! navigator.clipboard.writeText ) {
				return;
			}
			navigator.clipboard.writeText( url ).then( function () {
				// Brief, non-intrusive confirmation, as in the editor tooltip.
				copy.textContent = t( 'extrasCopied', 'Skopiowano' );
				copy.classList.add( 'is-copied' );
				window.setTimeout( function () {
					copy.textContent = t( 'extrasCopy', 'Kopiuj link' );
					copy.classList.remove( 'is-copied' );
				}, 1200 );
			} ).catch( function () {
				// Clipboard blocked/denied: the link itself is still right there.
			} );
		} );
		linkRow.appendChild( copy );

		detail.appendChild( linkRow );
		return detail;
	}

	/* ------------------------------------------------------- Master/detail view */

	function renderClassView( isTeacher ) {
		var cls = state.currentClass;

		var buttons = [
			{ symbol: '☰', icon: 'lessons', label: t( 'toggleLessons', 'Show/hide lessons' ), onClick: toggleSidebar },
			{ symbol: '⎙', icon: 'print', label: t( 'print', 'Print' ), onClick: function () {
				window.print();
			} },
		];
		if ( isTeacher ) {
			buttons.push( { symbol: '⚙', icon: 'settings', label: t( 'manageClass', 'Class settings' ), onClick: function () {
				state.view = 'classSettings';
				render();
			} } );
		}

		// Create the input field for the top bar if the teacher is editing a lesson
		var headerInput = null;
		if ( isTeacher && state.currentLesson ) {
			headerInput = el( 'input', 'tbt-notes-topbar__subtitle-input' );
			headerInput.type = 'text';
			headerInput.value = state.currentLesson.header || '';
			headerInput.placeholder = t( 'lessonHeaderPh', '' );
			headerInput.setAttribute( 'aria-label', t( 'lessonHeader', 'Lesson header' ) );
		}

		content.appendChild( buildTopbar( {
			title: cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '',
			subtitle: !isTeacher && state.currentLesson ? lessonTitlePart( state.currentLesson ) : null,
			subtitleEl: headerInput,
			onBack: isTeacher ? function () {
				flushActiveSaver();
				state.view = 'root';
				state.currentClass = null;
				state.lessons = [];
				state.currentLesson = null;
				render();
			} : null,
			buttons: buttons,
		} ) );

		var split = el( 'div', 'tbt-notes-split' + ( state.sidebarFolded ? ' is-folded' : '' ) );

		/* Sidebar: lessons list. */
		var sidebar = el( 'div', 'tbt-notes-sidebar' );
		var sbHead = el( 'div', 'tbt-notes-sidebar__head' );
		sbHead.appendChild( el( 'span', 'tbt-notes-sidebar__title', t( 'lessons', 'Lessons' ) ) );
		if ( isTeacher ) {
			var addLesson = el( 'button', modeCls(
				'tbt-button tbt-button--small',
				'tbt-notes-btn'
			), t( 'newLessonShort', '+ NEW' ) );
			addLesson.type = 'button';
			addLesson.addEventListener( 'click', createLessonFlow );
			sbHead.appendChild( addLesson );
		}
		sidebar.appendChild( sbHead );

		if ( state.loadingLessons ) {
			sidebar.appendChild( el( 'div', 'tbt-notes-loading', t( 'loading', 'Loading…' ) ) );
		} else if ( ! state.lessons.length ) {
			sidebar.appendChild( emptyBlock( t( 'noLessons', 'No lessons yet.' ) ) );
		} else {
			var nav = el( 'ul', 'tbt-notes-lesson-nav' );
			state.lessons.forEach( function ( lesson ) {
				nav.appendChild( lessonNavItem( lesson, isTeacher ) );
			} );
			sidebar.appendChild( nav );
		}

		// Contributed extras stack under the lessons list. The container is
		// always mounted so a late response can paint into it without a
		// re-render, and stays empty when there is nothing to show.
		var extrasHost = el( 'div', 'tbt-notes-extras' );
		extrasHost.setAttribute( 'data-tbt-extras', '' );
		sidebar.appendChild( extrasHost );

		split.appendChild( sidebar );

		/* Detail: selected lesson. */
		var detail = el( 'div', 'tbt-notes-detail' );

		/* Print-only header: class name + lesson and print date. Hidden on
		   screen, shown by the @media print rules in the stylesheet. */
		var printHead = el( 'div', 'tbt-notes-print-head' );
		printHead.appendChild( el( 'div', 'tbt-notes-print-head__class',
			cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '' ) );
		var printMeta = [];
		if ( state.currentLesson && state.currentLesson.header ) {
			printMeta.push( state.currentLesson.header );
		}
		printMeta.push( new Date().toLocaleDateString() );
		printHead.appendChild( el( 'div', 'tbt-notes-print-head__meta', printMeta.join( ' — ' ) ) );
		detail.appendChild( printHead );

		if ( state.loadingLessons ) {
			detail.appendChild( el( 'div', 'tbt-notes-loading', t( 'loading', 'Loading…' ) ) );
		} else if ( state.currentLesson ) {
			if ( isTeacher ) {
				// The filter lives inside the Quill toolbar; the editor stays
				// mounted and we toggle the extracted summary over it.
				renderEditorInto( detail, state.currentLesson, headerInput );
			} else {
				// Students have no toolbar, so keep a simple filter bar above the
				// read-only note and swap the content below it.
				var contentArea = el( 'div', 'tbt-notes-lesson-content' );
				detail.appendChild( buildFilterBar( state.currentLesson, contentArea ) );
				detail.appendChild( contentArea );
				renderLessonContent( contentArea, state.currentLesson );
			}
		} else if ( isTeacher ) {
			var prompt = el( 'div', modeCls( 'tbt-empty', 'tbt-notes-empty' ) );
			prompt.appendChild( el( 'p', modeCls( 'tbt-empty__text', null ), t( 'noLessons', 'No lessons yet.' ) ) );
			var first = el( 'button', modeCls(
				'tbt-button tbt-button--primary',
				'tbt-notes-btn'
			), t( 'newLesson', 'New lesson' ) );
			first.type = 'button';
			first.addEventListener( 'click', createLessonFlow );
			prompt.appendChild( first );
			detail.appendChild( prompt );
		} else {
			detail.appendChild( emptyBlock( t( 'noLessons', 'No lessons yet.' ) ) );
		}
		split.appendChild( detail );

		content.appendChild( split );

		// Now that the sidebar is in the document, fill in whatever extras have
		// already arrived (a re-render for another reason must not lose them).
		paintExtras();
	}

	function toggleSidebar() {
		state.sidebarFolded = ! state.sidebarFolded;
		var split = content.querySelector( '.tbt-notes-split' );
		if ( split ) {
			split.classList.toggle( 'is-folded', state.sidebarFolded );
		}
	}

	function lessonNavItem( lesson, isTeacher ) {
		var li = el( 'li', 'tbt-notes-listitem' );
		// How paintLessonExtras() finds this row when the extras response lands.
		li.setAttribute( 'data-tbt-lesson-id', lesson.id );
		var active = state.currentLesson && state.currentLesson.id === lesson.id;
		var main = el( 'button', 'tbt-notes-listitem__main' + ( active ? ' is-active' : '' ) );
		main.type = 'button';
		// Lesson title only — the header is already a date, so no separate date line.
		// Untitled/legacy notes fall back to a safe dated title.
		main.appendChild( el( 'span', 'tbt-notes-listitem__title', lessonTitlePart( lesson ) ) );
		main.addEventListener( 'click', function () {
			selectLesson( lesson );
		} );
		li.appendChild( main );
		if ( isTeacher ) {
			li.appendChild( iconDelete( t( 'deleteLesson', 'Delete lesson' ), function () {
				deleteLessonFlow( lesson );
			} ) );
		}
		return li;
	}

	function selectLesson( lesson ) {
		if ( state.currentLesson && state.currentLesson.id === lesson.id ) {
			return;
		}
		flushActiveSaver();
		state.currentLesson = lesson;
		state.highlightFilter = 'full';
		render();
	}

	/* -------------------------------------------------------------- Read view */

	function renderReadInto( container, lesson ) {
		var wrap = el( 'div', 'tbt-notes-detail__scroll' );
		var read = el( 'div', 'tbt-notes-read' );
		read.innerHTML = lesson.body || ''; // Server-sanitised semantic HTML.
		wrap.appendChild( read );
		container.appendChild( wrap );
	}

	/* ----------------------------------------------------- Highlight filtering */

	/**
	 * Pull the highlighted fragments out of a lesson body, grouped by semantic
	 * category. Duplicates within a category are collapsed (keyed by normalised
	 * text) so a phrase highlighted twice only appears once.
	 *
	 * @param {string} html Lesson body HTML.
	 * @return {Object} Map of category key → { key, label, className, items }.
	 */
	function extractHighlights( html ) {
		var tmp = document.createElement( 'div' );
		tmp.innerHTML = html || '';
		var groups = {};
		( cfg.highlightColors || [] ).forEach( function ( c ) {
			groups[ c.key ] = {
				key: c.key,
				label: c.label,
				className: 'tbt-hl-' + c.key,
				items: [],
			};
		} );
		Object.keys( groups ).forEach( function ( key ) {
			var group = groups[ key ];
			var nodes = tmp.querySelectorAll( '.' + group.className );
			var seen = {};
			Array.prototype.forEach.call( nodes, function ( node ) {
				var text = ( node.textContent || '' ).replace( /\s+/g, ' ' ).trim();
				if ( text && ! Object.prototype.hasOwnProperty.call( seen, text ) ) {
					seen[ text ] = true;
					group.items.push( text );
				}
			} );
		} );
		return groups;
	}

	/**
	 * Reusable "Show: [Full note ▼]" control. Options come from cfg.highlightColors
	 * so the dropdown always matches the toolbar's semantic categories. The select
	 * is a plain custom control (no ql-* class) so Quill leaves it alone when it
	 * sits inside the editor toolbar. `onChange` runs after state is updated.
	 */
	function buildHighlightFilterSelect( onChange ) {
		var wrap = el( 'label', 'tbt-notes-filter-inline' );
		wrap.appendChild( el( 'span', null, t( 'show', 'Show' ) + ':' ) );

		var select = el( 'select', 'tbt-notes-filter-select' );
		var options = [
			{ value: 'full', label: t( 'fullNote', 'Full note' ) },
			{ value: 'all', label: t( 'allHighlights', 'All highlights' ) },
		];
		( cfg.highlightColors || [] ).forEach( function ( c ) {
			options.push( { value: c.key, label: c.label } );
		} );
		options.forEach( function ( o ) {
			var opt = el( 'option', null, o.label );
			opt.value = o.value;
			if ( o.value === ( state.highlightFilter || 'full' ) ) {
				opt.selected = true;
			}
			select.appendChild( opt );
		} );
		select.addEventListener( 'change', function () {
			state.highlightFilter = select.value;
			if ( onChange ) {
				onChange();
			}
		} );

		wrap.appendChild( select );
		return wrap;
	}

	/**
	 * Student-only filter bar: the filter select above the read-only note.
	 */
	function buildFilterBar( lesson, contentArea ) {
		var bar = el( 'div', 'tbt-notes-filterbar' );
		bar.appendChild( buildHighlightFilterSelect( function () {
			renderLessonContent( contentArea, lesson );
		} ) );
		return bar;
	}

	/**
	 * Render the read-only lesson content for the current filter: the full note
	 * when 'full', otherwise an extracted-highlights list. (Students only — the
	 * teacher editor toggles its summary in place without re-rendering Quill.)
	 */
	function renderLessonContent( container, lesson ) {
		clear( container );
		var filter = state.highlightFilter || 'full';
		if ( filter === 'full' ) {
			renderReadInto( container, lesson );
		} else {
			renderHighlightSummaryInto( container, lesson, filter, false );
		}
	}

	/**
	 * Render the extracted highlights as a grouped list. `filter` is either 'all'
	 * (every category) or a single category key. The 'pink' (Pronunciation)
	 * category is special: it shows a playable audio list instead of plain text.
	 */
	function renderHighlightSummaryInto( container, lesson, filter, isTeacher ) {
		if ( filter === 'pink' ) {
			renderPronunciationInto( container, lesson, !! isTeacher );
			return;
		}

		if ( filter === 'blue' ) {
			renderExpressionCardsInto( container, lesson, !! isTeacher );
			return;
		}

		var wrap = el( 'div', 'tbt-notes-detail__scroll' );
		var summary = el( 'div', 'tbt-notes-highlight-summary' );
		var groups = extractHighlights( lesson.body || '' );

		var keys = filter === 'all'
			? ( cfg.highlightColors || [] ).map( function ( c ) {
				return c.key;
			} )
			: [ filter ];

		var any = false;
		keys.forEach( function ( key ) {
			var group = groups[ key ];
			if ( ! group || ! group.items.length ) {
				return;
			}
			any = true;
			var section = el( 'section', 'tbt-notes-highlight-group' );
			section.appendChild( el( 'h2', null, group.label ) );
			var ul = el( 'ul' );
			group.items.forEach( function ( text ) {
				var li = el( 'li' );
				li.appendChild( el( 'span', group.className, text ) );
				ul.appendChild( li );
			} );
			section.appendChild( ul );
			summary.appendChild( section );
		} );

		if ( ! any ) {
			summary.appendChild( emptyBlock( t( 'noHighlightsFound', 'No highlighted items in this category.' ) ) );
		}

		wrap.appendChild( summary );
		container.appendChild( wrap );
	}

	/* ------------------------------------------------------ Pronunciation audio */

	/**
	 * Pronunciation (pink) view. Fetches the lesson's pronunciation items from
	 * the server (teacher: every pink item with audio flags; student: only
	 * generated ones) and renders a playable list. Audio is never shown in the
	 * full note — only here, under the Pronunciation filter.
	 */
	function renderPronunciationInto( container, lesson, isTeacher ) {
		var wrap = el( 'div', 'tbt-notes-detail__scroll' );
		var summary = el( 'div', 'tbt-notes-highlight-summary' );
		var section = el( 'section', 'tbt-notes-highlight-group' );
		section.appendChild( el( 'h2', null, t( 'pronunciation', 'Pronunciation' ) ) );
		var list = el( 'ul', 'tbt-pronunciation-list' );
		section.appendChild( list );
		summary.appendChild( section );
		wrap.appendChild( summary );
		container.appendChild( wrap );

		list.appendChild( el( 'li', 'tbt-notes-empty', t( 'loading', 'Loading…' ) ) );

		api( 'GET', 'lessons/' + lesson.id + '/pronunciations' ).then( function ( data ) {
			clear( list );
			var items = ( data && data.items ) || [];
			if ( ! items.length ) {
				var msg = isTeacher
					? t( 'noHighlightsFound', 'No highlighted items in this category.' )
					: t( 'noPronAudio', 'No pronunciation audio has been added yet.' );
				list.appendChild( el( 'li', 'tbt-notes-empty', msg ) );
				return;
			}
			items.forEach( function ( item ) {
				list.appendChild( pronunciationItem( lesson, item, isTeacher ) );
			} );
		} ).catch( function ( err ) {
			clear( list );
			var li = el( 'li' );
			li.appendChild( errorBlock( err.message ) );
			list.appendChild( li );
		} );
	}

	/**
	 * One row in the pronunciation list: the pink-highlighted text plus either a
	 * Play button (audio exists) or a Generate audio button. The Generate button
	 * is driven by the per-item can_generate flag from the server (which folds in
	 * the student-generation switch), not by isTeacher.
	 */
	function pronunciationItem( lesson, item, isTeacher ) {
		var li = el( 'li', 'tbt-pronunciation-item' );
		li.appendChild( el( 'span', 'tbt-pronunciation-text tbt-hl-pink', item.text ) );
		var actions = el( 'span', 'tbt-pronunciation-actions' );
		li.appendChild( actions );

		function renderPlay( url ) {
			clear( actions );
			var btn = el( 'button', 'tbt-notes-btn tbt-notes-btn--ghost tbt-pronunciation-play' );
			btn.type = 'button';
			btn.textContent = '▶ ' + t( 'play', 'Play' );
			var audio = null;
			btn.addEventListener( 'click', function () {
				if ( ! audio ) {
					audio = new Audio( url );
					audio.addEventListener( 'ended', function () {
						btn.textContent = '▶ ' + t( 'play', 'Play' );
					} );
					audio.addEventListener( 'error', function () {
						btn.textContent = '▶ ' + t( 'play', 'Play' );
					} );
				}
				if ( ! audio.paused ) {
					audio.pause();
					audio.currentTime = 0;
					btn.textContent = '▶ ' + t( 'play', 'Play' );
					return;
				}
				btn.textContent = t( 'playing', 'Playing…' );
				audio.play().catch( function () {
					btn.textContent = '▶ ' + t( 'play', 'Play' );
				} );
			} );
			actions.appendChild( btn );
		}

		function renderGenerate() {
			clear( actions );
			var btn = el( 'button', 'tbt-notes-btn tbt-pronunciation-generate' );
			btn.type = 'button';
			btn.textContent = t( 'generateAudio', 'Generate audio' );
			btn.addEventListener( 'click', function () {
				btn.disabled = true;
				btn.textContent = t( 'generating', 'Generating…' );
				api( 'POST', 'lessons/' + lesson.id + '/pronunciations', { text: item.text } ).then( function ( data ) {
					if ( data && data.item && data.item.audio_url ) {
						renderPlay( data.item.audio_url );
					} else {
						throw new Error( t( 'audioError', 'Could not generate audio. Please try again.' ) );
					}
				} ).catch( function ( err ) {
					btn.disabled = false;
					btn.textContent = t( 'generateAudio', 'Generate audio' );
					actions.appendChild( el( 'span', 'tbt-pronunciation-error', err.message ) );
				} );
			} );
			actions.appendChild( btn );
		}

		if ( item.has_audio && item.audio_url ) {
			renderPlay( item.audio_url );
		} else if ( item.can_generate ) {
			renderGenerate();
		}
		return li;
	}

	/* ------------------------------------------------------ Expression cards */

	/**
	 * Expression-card (blue) view. Fetches the lesson's blue "Useful expression"
	 * items from the server (teacher: every blue item with card flags; student:
	 * only approved cards) and renders them. Cards never appear in the full note —
	 * only here, under the Useful expression filter.
	 */
	function renderExpressionCardsInto( container, lesson, isTeacher ) {
		var wrap = el( 'div', 'tbt-notes-detail__scroll' );
		var summary = el( 'div', 'tbt-notes-highlight-summary' );
		var section = el( 'section', 'tbt-notes-highlight-group' );
		section.appendChild( el( 'h2', null, t( 'usefulExpression', 'Useful expression' ) ) );
		var list = el( 'ul', 'tbt-expression-list' );
		section.appendChild( list );
		summary.appendChild( section );
		wrap.appendChild( summary );
		container.appendChild( wrap );

		list.appendChild( el( 'li', 'tbt-notes-empty', t( 'loading', 'Loading…' ) ) );

		api( 'GET', 'lessons/' + lesson.id + '/expression-cards' ).then( function ( data ) {
			clear( list );
			var items = ( data && data.items ) || [];
			if ( ! items.length ) {
				var msg = isTeacher
					? t( 'noHighlightsFound', 'No highlighted items in this category.' )
					: t( 'noExpressionCards', 'No useful expression cards have been added yet.' );
				list.appendChild( el( 'li', 'tbt-notes-empty', msg ) );
				return;
			}
			items.forEach( function ( item ) {
				list.appendChild( expressionCardItem( lesson, item, isTeacher ) );
			} );
		} ).catch( function ( err ) {
			clear( list );
			var li = el( 'li' );
			li.appendChild( errorBlock( err.message ) );
			list.appendChild( li );
		} );
	}

	/**
	 * One row in the expression-card list.
	 *
	 * Teacher: the blue text plus either a "Generate card" button (no card yet) or
	 * an editable card (Polish + example textareas, status, Save/Approve/
	 * Regenerate). Student: a static, read-only card (any status); when the server
	 * allows it (item.can_generate on a cardless item) a "Generate card" button
	 * that produces the same read-only card in place.
	 */
	function expressionCardItem( lesson, item, isTeacher ) {
		var li = el( 'li', 'tbt-expression-item' );

		// ---- Student: read-only card, plus (when allowed) a Generate button. ----
		if ( ! isTeacher ) {
			// Same head structure as the teacher card, so the add-to-dictionary
			// control sits in the same right-aligned actions slot in both views.
			var studentHead = el( 'div', 'tbt-expression-head' );
			studentHead.appendChild( el( 'span', 'tbt-expression-text tbt-hl-blue', item.text ) );
			var studentActions = el( 'span', 'tbt-expression-actions' );
			studentHead.appendChild( studentActions );
			li.appendChild( studentHead );
			var studentBody = el( 'div', 'tbt-expression-body' );
			li.appendChild( studentBody );

			// Read-only Polish + Example rows. Reads only polish_translation /
			// example_sentence; status and card_id are ignored for students.
			function renderStudentCard( data ) {
				clear( studentBody );
				var card = el( 'div', 'tbt-expression-card' );
				var pRow = el( 'div', 'tbt-expression-readrow' );
				pRow.appendChild( el( 'strong', null, t( 'polishLabel', 'Polish' ) + ': ' ) );
				pRow.appendChild( document.createTextNode( data.polish_translation || '' ) );
				card.appendChild( pRow );
				var eRow = el( 'div', 'tbt-expression-readrow' );
				eRow.appendChild( el( 'strong', null, t( 'exampleLabel', 'Example' ) + ': ' ) );
				eRow.appendChild( document.createTextNode( data.example_sentence || '' ) );
				card.appendChild( eRow );
				studentBody.appendChild( card );
				// Any card a student can see is addable: read-only students only
				// ever receive approved cards, and can-generate students see their
				// own fresh cards, whose status the server deliberately omits.
				clear( studentActions );
				studentActions.appendChild( dictAddControl( lesson, item.text, function () {
					return data.polish_translation || '';
				} ) );
			}

			if ( item.has_card ) {
				renderStudentCard( item );
			} else if ( item.can_generate ) {
				var genBtn = el( 'button', 'tbt-notes-btn tbt-expression-generate' );
				genBtn.type = 'button';
				genBtn.textContent = t( 'generateCard', 'Generate card' );
				genBtn.addEventListener( 'click', function () {
					genBtn.disabled = true;
					genBtn.textContent = t( 'generating', 'Generating…' );
					api( 'POST', 'lessons/' + lesson.id + '/expression-cards', { text: item.text } ).then( function ( data ) {
						if ( data && data.item && data.item.has_card ) {
							renderStudentCard( data.item );
						} else {
							throw new Error( t( 'cardError', 'Could not generate the expression card. Please try again.' ) );
						}
					} ).catch( function ( err ) {
						genBtn.disabled = false;
						genBtn.textContent = t( 'generateCard', 'Generate card' );
						studentBody.appendChild( el( 'span', 'tbt-expression-error', err.message ) );
					} );
				} );
				studentBody.appendChild( genBtn );
			}
			// else: no card and generation is off → render nothing extra (the
			// server won't send cardless items to students in that case anyway).
			return li;
		}

		// ---- Teacher: header (text + optional inline action) and a body. ----
		var head = el( 'div', 'tbt-expression-head' );
		head.appendChild( el( 'span', 'tbt-expression-text tbt-hl-blue', item.text ) );
		var headActions = el( 'span', 'tbt-expression-actions' );
		head.appendChild( headActions );
		li.appendChild( head );

		var body = el( 'div', 'tbt-expression-body' );
		li.appendChild( body );

		// Re-render the row's body for the given item state.
		function paint( current ) {
			clear( headActions );
			clear( body );
			if ( current.has_card ) {
				renderCard( current );
			} else {
				renderGenerate();
			}
		}

		function renderGenerate() {
			var btn = el( 'button', 'tbt-notes-btn tbt-expression-generate' );
			btn.type = 'button';
			btn.textContent = t( 'generateCard', 'Generate card' );
			btn.addEventListener( 'click', function () {
				btn.disabled = true;
				btn.textContent = t( 'generating', 'Generating…' );
				api( 'POST', 'lessons/' + lesson.id + '/expression-cards', { text: item.text } ).then( function ( data ) {
					if ( data && data.item && data.item.has_card ) {
						paint( data.item );
					} else {
						throw new Error( t( 'cardError', 'Could not generate the expression card. Please try again.' ) );
					}
				} ).catch( function ( err ) {
					btn.disabled = false;
					btn.textContent = t( 'generateCard', 'Generate card' );
					headActions.appendChild( el( 'span', 'tbt-expression-error', err.message ) );
				} );
			} );
			headActions.appendChild( btn );
		}

		function renderCard( current ) {
			var card = el( 'div', 'tbt-expression-card' );

			// Polish field.
			var pField = el( 'div', 'tbt-expression-field' );
			pField.appendChild( el( 'label', null, t( 'polishLabel', 'Polish' ) ) );
			var pArea = el( 'textarea' );
			pArea.value = current.polish_translation || '';
			pField.appendChild( pArea );
			card.appendChild( pField );

			// Example field.
			var eField = el( 'div', 'tbt-expression-field' );
			eField.appendChild( el( 'label', null, t( 'exampleLabel', 'Example' ) ) );
			var eArea = el( 'textarea' );
			eArea.value = current.example_sentence || '';
			eField.appendChild( eArea );
			card.appendChild( eField );

			// Status line.
			var statusRow = el( 'div', 'tbt-expression-status' );
			statusRow.appendChild( el( 'span', null, t( 'statusLabel', 'Status' ) + ': ' ) );
			var isApproved = current.status === 'approved';
			var badge = el(
				'span',
				'tbt-expression-status--' + ( isApproved ? 'approved' : 'draft' ),
				isApproved ? t( 'statusApproved', 'Approved' ) : t( 'statusDraft', 'Draft' )
			);
			statusRow.appendChild( badge );
			card.appendChild( statusRow );

			// Actions.
			var actions = el( 'div', 'tbt-expression-actions' );
			var msgSlot = el( 'span', 'tbt-expression-msg' );

			var saveBtn = el( 'button', 'tbt-notes-btn' );
			saveBtn.type = 'button';
			saveBtn.textContent = t( 'save', 'Save' );

			var approveBtn = null;
			if ( ! isApproved ) {
				approveBtn = el( 'button', 'tbt-notes-btn' );
				approveBtn.type = 'button';
				approveBtn.textContent = t( 'approve', 'Approve' );
			}

			var regenBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--ghost' );
			regenBtn.type = 'button';
			regenBtn.textContent = t( 'regenerate', 'Regenerate' );

			function setBusy( busy ) {
				saveBtn.disabled = busy;
				if ( approveBtn ) {
					approveBtn.disabled = busy;
				}
				regenBtn.disabled = busy;
			}

			function showError( text ) {
				clear( msgSlot );
				msgSlot.className = 'tbt-expression-error';
				msgSlot.textContent = text;
			}

			function showSaved() {
				clear( msgSlot );
				msgSlot.className = 'tbt-expression-msg';
				msgSlot.textContent = t( 'cardSaved', 'Saved' );
			}

			// Save keeps the current status (preferred v1 behaviour).
			saveBtn.addEventListener( 'click', function () {
				setBusy( true );
				clear( msgSlot );
				api( 'PATCH', 'expression-cards/' + current.card_id, {
					polish_translation: pArea.value,
					example_sentence: eArea.value
				} ).then( function ( data ) {
					if ( data && data.item ) {
						paint( data.item );
					} else {
						setBusy( false );
						showSaved();
					}
				} ).catch( function ( err ) {
					setBusy( false );
					showError( err.message );
				} );
			} );

			if ( approveBtn ) {
				// Approve saves any edits first, then sets status=approved.
				approveBtn.addEventListener( 'click', function () {
					setBusy( true );
					clear( msgSlot );
					api( 'PATCH', 'expression-cards/' + current.card_id, {
						polish_translation: pArea.value,
						example_sentence: eArea.value,
						status: 'approved'
					} ).then( function ( data ) {
						paint( ( data && data.item ) || current );
					} ).catch( function ( err ) {
						setBusy( false );
						showError( err.message );
					} );
				} );
			}

			regenBtn.addEventListener( 'click', function () {
				setBusy( true );
				clear( msgSlot );
				regenBtn.textContent = t( 'generating', 'Generating…' );
				api( 'POST', 'lessons/' + lesson.id + '/expression-cards', {
					text: item.text,
					force: true
				} ).then( function ( data ) {
					paint( ( data && data.item ) || current );
				} ).catch( function ( err ) {
					setBusy( false );
					regenBtn.textContent = t( 'regenerate', 'Regenerate' );
					showError( err.message );
				} );
			} );

			actions.appendChild( saveBtn );
			if ( approveBtn ) {
				actions.appendChild( approveBtn );
			}
			actions.appendChild( regenBtn );
			actions.appendChild( msgSlot );
			card.appendChild( actions );

			body.appendChild( card );

			// Approved cards get the add-to-dictionary control in the head row
			// (paint() cleared it, so approval state is always current — a
			// regenerated card drops back to draft and loses the +). Polish is
			// read from the textarea at click time, so unsaved edits carry over.
			if ( isApproved ) {
				headActions.appendChild( dictAddControl( lesson, item.text, function () {
					return pArea.value;
				} ) );
			}
		}

		paint( item );
		return li;
	}

	/* ------------------------------------ Add to Personal Dictionary (blue) */

	// Bridge to the Personal Dictionary plugin: every operation is one
	// admin-ajax action (action=ays_pd_ajax) with a `function` selector, cookie
	// authenticated (no nonce — the plugin's own handlers use none and scope all
	// reads/writes to get_current_user_id() server-side).

	// Expressions added this session, keyed by lesson + expression text, so a
	// re-render (filter change, card repaint) keeps the "Added ✓" state and a
	// second click cannot double-insert. Deliberately not persisted — the
	// dictionary itself has no duplicate check, and a page reload resetting the
	// affordance is acceptable per spec.
	var dictAdded = {};

	function dictKey( lesson, word ) {
		return ( lesson && lesson.id ) + '\u0001' + word;
	}

	var DICT_ERR = 'Could not add to your dictionary. Please try again.';

	// Same inline-SVG approach as TOOLTIP_ICONS: a static, trusted string.
	var DICT_ADD_ICON =
		'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M12 5v14"/><path d="M5 12h14"/></svg>';

	/**
	 * Resolve admin-ajax.php. Prefer Personal Dictionary's own localized URL when
	 * its script happens to be on the page; otherwise derive it from our REST
	 * root (which always sits alongside wp-admin), covering both pretty
	 * (…/wp-json/…) and plain (…?rest_route=…) permalinks.
	 */
	function pdAjaxUrl() {
		var pd = window.aysPersonalDictionaryAjaxPublic;
		if ( pd && pd.ajaxUrl ) {
			return pd.ajaxUrl;
		}
		var rest = '' + ( cfg.restUrl || '' );
		var m = rest.match( /^(.*?)wp-json\// );
		if ( ! m ) {
			m = rest.match( /^(.*?)\?rest_route=/ );
		}
		if ( m ) {
			return m[ 1 ] + 'wp-admin/admin-ajax.php';
		}
		return '/wp-admin/admin-ajax.php';
	}

	/**
	 * POST one Personal Dictionary operation. Mirrors api()'s conventions
	 * (fetch, same-origin credentials, JSON-or-error) but form-encoded, which is
	 * what admin-ajax handlers read.
	 */
	function pdAjax( fn, fields ) {
		var params = new URLSearchParams();
		params.set( 'action', 'ays_pd_ajax' );
		params.set( 'function', fn );
		Object.keys( fields || {} ).forEach( function ( key ) {
			params.set( key, fields[ key ] );
		} );
		return fetch( pdAjaxUrl(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			credentials: 'same-origin',
			body: params.toString(),
		} ).then( function ( res ) {
			if ( ! res.ok ) {
				throw new Error( t( 'dictError', DICT_ERR ) );
			}
			return res.json().catch( function () {
				throw new Error( t( 'dictError', DICT_ERR ) );
			} );
		} );
	}

	/**
	 * The learner's dictionary groups, newest first: [{ id, name }].
	 */
	function pdFetchGroups() {
		return pdAjax( 'ays_groups_pd' ).then( function ( data ) {
			var rows = ( data && data.status && Array.isArray( data.results ) ) ? data.results : [];
			var out = [];
			rows.forEach( function ( row ) {
				var id = parseInt( row && row.id, 10 );
				if ( id > 0 ) {
					out.push( { id: id, name: String( ( row && row.name ) || '' ) } );
				}
			} );
			return out;
		} );
	}

	/**
	 * Insert one word. The handler only reports added_words when the insert
	 * really ran (missing/empty fields fall through to a bare status:true), so
	 * added_words >= 1 — not status — is the success signal.
	 */
	function pdAddWord( groupId, word, translation ) {
		return pdAjax( 'ays_words_add_ajax', {
			category_id: groupId,
			word: word,
			translation: translation,
		} ).then( function ( data ) {
			if ( ! data || ! ( parseInt( data.added_words, 10 ) >= 1 ) ) {
				throw new Error( t( 'dictError', DICT_ERR ) );
			}
			return data;
		} );
	}

	/**
	 * Create a group and resolve its id. Current Personal Dictionary (2.7.x)
	 * returns the new id as last_id; older builds did not, so fall back to
	 * re-fetching the (newest-first) group list.
	 */
	function pdCreateGroup( name ) {
		return pdAjax( 'ays_groups_add_ajax', { value: name } ).then( function ( data ) {
			if ( ! data || ! ( parseInt( data.added_group, 10 ) >= 1 ) ) {
				throw new Error( t( 'dictError', DICT_ERR ) );
			}
			var id = parseInt( data.last_id, 10 );
			if ( id > 0 ) {
				return id;
			}
			return pdFetchGroups().then( function ( groups ) {
				if ( ! groups.length ) {
					throw new Error( t( 'dictError', DICT_ERR ) );
				}
				return groups[ 0 ].id;
			} );
		} );
	}

	/* -- Group-picker menu: one shared floating panel, anchored to a + button -- */

	var dictMenuEl = null;
	var dictMenuState = null; // { anchor, onPick, busy }

	function ensureDictMenu() {
		if ( dictMenuEl ) {
			return dictMenuEl;
		}
		// Lives on <body>: the notes panel is transformed (overlay slide), which
		// would re-anchor position:fixed descendants, and its scroll containers
		// would clip an absolutely positioned menu. The tbt-notes-app class is
		// carried along so the --tbt-* design tokens still apply.
		dictMenuEl = el( 'div', 'tbt-notes-app tbt-dict-menu' );
		dictMenuEl.hidden = true;
		// Same guard as the highlight popup: pressing inside the menu must not
		// blur the editor or drop a Quill selection. The new-group input is
		// exempt so it can still take focus.
		dictMenuEl.addEventListener( 'mousedown', function ( e ) {
			if ( ! e.target || 'INPUT' !== e.target.tagName ) {
				e.preventDefault();
			}
		} );
		document.body.appendChild( dictMenuEl );
		return dictMenuEl;
	}

	/**
	 * Anchor the menu to the + button: right-aligned below it, flipped above
	 * when it would overflow the viewport bottom — the same measure-then-flip
	 * approach as the selection highlight popup, in fixed coordinates.
	 */
	function positionDictMenu( anchor ) {
		var rect = anchor.getBoundingClientRect();
		dictMenuEl.hidden = false; // Must be visible to measure its size.
		var mw = dictMenuEl.offsetWidth;
		var mh = dictMenuEl.offsetHeight;
		var left = rect.right - mw;
		var maxLeft = window.innerWidth - mw - 8;
		if ( left > maxLeft ) {
			left = maxLeft;
		}
		if ( left < 8 ) {
			left = 8;
		}
		var top = rect.bottom + 6;
		if ( top + mh > window.innerHeight - 8 ) {
			top = rect.top - mh - 6;
			if ( top < 8 ) {
				top = rect.bottom + 6;
			}
		}
		dictMenuEl.style.left = left + 'px';
		dictMenuEl.style.top = top + 'px';
	}

	function onDictDocMousedown( e ) {
		var anchor = dictMenuState && dictMenuState.anchor;
		if ( dictMenuEl.contains( e.target ) || ( anchor && anchor.contains( e.target ) ) ) {
			return;
		}
		closeDictMenu();
	}

	function onDictDocKeydown( e ) {
		if ( 'Escape' === e.key ) {
			// Capture-phase + stopPropagation so Escape closes only the menu, not
			// the notes overlay behind it.
			e.stopPropagation();
			closeDictMenu();
		}
	}

	function onDictReflow( e ) {
		// Scrolling the group list itself must not dismiss it; any outer scroll
		// or resize closes the menu (its fixed anchor point is gone).
		if ( e && 'scroll' === e.type && e.target && 1 === e.target.nodeType && dictMenuEl.contains( e.target ) ) {
			return;
		}
		closeDictMenu();
	}

	function closeDictMenu() {
		if ( ! dictMenuState ) {
			return;
		}
		var anchor = dictMenuState.anchor;
		dictMenuState = null;
		dictMenuEl.hidden = true;
		clear( dictMenuEl );
		if ( anchor ) {
			anchor.setAttribute( 'aria-expanded', 'false' );
		}
		document.removeEventListener( 'mousedown', onDictDocMousedown, true );
		document.removeEventListener( 'keydown', onDictDocKeydown, true );
		window.removeEventListener( 'scroll', onDictReflow, true );
		window.removeEventListener( 'resize', onDictReflow );
	}

	/**
	 * Open the picker for one + button. onPick( {id, name} ) performs the add
	 * and resolves on success; the menu shows Adding…/errors around it.
	 */
	function openDictMenu( anchor, onPick ) {
		if ( dictMenuState && dictMenuState.anchor === anchor ) {
			closeDictMenu(); // Second click on the same + toggles the menu shut.
			return;
		}
		closeDictMenu();
		ensureDictMenu();

		var state = { anchor: anchor, onPick: onPick, busy: false };
		dictMenuState = state;
		anchor.setAttribute( 'aria-expanded', 'true' );

		document.addEventListener( 'mousedown', onDictDocMousedown, true );
		document.addEventListener( 'keydown', onDictDocKeydown, true );
		window.addEventListener( 'scroll', onDictReflow, true );
		window.addEventListener( 'resize', onDictReflow );

		renderDictMenuMessage( t( 'loading', 'Loading…' ), false );
		positionDictMenu( anchor );

		pdFetchGroups().then( function ( groups ) {
			if ( dictMenuState !== state ) {
				return;
			}
			renderDictMenuGroups( state, groups );
			positionDictMenu( anchor );
		} ).catch( function ( err ) {
			if ( dictMenuState !== state ) {
				return;
			}
			renderDictMenuMessage( ( err && err.message ) || t( 'dictError', DICT_ERR ), true );
			positionDictMenu( anchor );
		} );
	}

	function renderDictMenuMessage( text, isError ) {
		clear( dictMenuEl );
		dictMenuEl.appendChild(
			el( 'div', 'tbt-dict-menu__msg' + ( isError ? ' tbt-dict-menu__msg--error' : '' ), text )
		);
	}

	/**
	 * Menu content: a row per group, or — for a learner with no groups yet — an
	 * inline "＋ New group" name input that creates the group and continues the
	 * same add in one interaction.
	 */
	function renderDictMenuGroups( state, groups ) {
		clear( dictMenuEl );
		dictMenuEl.appendChild( el( 'div', 'tbt-dict-menu__label', t( 'dictGroupsLabel', 'Add to dictionary group' ) ) );

		var msg = el( 'div', 'tbt-dict-menu__msg' );
		msg.hidden = true;

		function showMsg( text, isError ) {
			msg.hidden = false;
			msg.className = 'tbt-dict-menu__msg' + ( isError ? ' tbt-dict-menu__msg--error' : '' );
			msg.textContent = text;
		}

		function setDisabled( disabled ) {
			var controls = dictMenuEl.querySelectorAll( 'button, input' );
			for ( var i = 0; i < controls.length; i++ ) {
				controls[ i ].disabled = disabled;
			}
		}

		function beginBusy() {
			state.busy = true;
			setDisabled( true );
			showMsg( t( 'dictAdding', 'Adding…' ), false );
			positionDictMenu( state.anchor );
		}

		function failBusy( err ) {
			state.busy = false;
			if ( dictMenuState !== state ) {
				return;
			}
			setDisabled( false );
			showMsg( ( err && err.message ) || t( 'dictError', DICT_ERR ), true );
			positionDictMenu( state.anchor );
		}

		// Run the actual add; close on success, report + re-enable on failure.
		function runAdd( group ) {
			state.onPick( group ).then( function () {
				if ( dictMenuState === state ) {
					closeDictMenu();
				}
			} ).catch( failBusy );
		}

		function groupRow( group ) {
			var row = el( 'button', 'tbt-dict-menu__item', group.name );
			row.type = 'button';
			row.addEventListener( 'click', function () {
				if ( state.busy ) {
					return;
				}
				beginBusy();
				runAdd( group );
			} );
			return row;
		}

		if ( groups.length ) {
			var list = el( 'div', 'tbt-dict-menu__list' );
			groups.forEach( function ( group ) {
				list.appendChild( groupRow( group ) );
			} );
			dictMenuEl.appendChild( list );
		} else {
			var wrap = el( 'div', 'tbt-dict-menu__new' );
			var input = el( 'input', 'tbt-notes-input tbt-dict-menu__input' );
			input.type = 'text';
			input.placeholder = t( 'dictNewGroupPh', 'New group name' );
			input.setAttribute( 'aria-label', t( 'dictNewGroup', '＋ New group' ) );
			var createBtn = el( 'button', 'tbt-notes-btn tbt-dict-menu__create', t( 'dictCreate', 'Create' ) );
			createBtn.type = 'button';

			function submitNewGroup() {
				if ( state.busy ) {
					return;
				}
				var name = input.value.trim();
				if ( '' === name ) {
					input.focus();
					return;
				}
				beginBusy();
				pdCreateGroup( name ).then( function ( groupId ) {
					if ( dictMenuState !== state ) {
						return;
					}
					// The group now exists: swap the form for a normal pick row so
					// a failed add can be retried without duplicating the group.
					var group = { id: groupId, name: name };
					var list = el( 'div', 'tbt-dict-menu__list' );
					list.appendChild( groupRow( group ) );
					dictMenuEl.replaceChild( list, wrap );
					setDisabled( true );
					runAdd( group );
				} ).catch( failBusy );
			}

			createBtn.addEventListener( 'click', submitNewGroup );
			input.addEventListener( 'keydown', function ( e ) {
				if ( 'Enter' === e.key ) {
					e.preventDefault();
					submitNewGroup();
				}
			} );

			wrap.appendChild( input );
			wrap.appendChild( createBtn );
			dictMenuEl.appendChild( wrap );
		}

		dictMenuEl.appendChild( msg );
	}

	function dictAddedBadge() {
		var badge = el( 'span', 'tbt-dict-added', t( 'dictAdded', 'Added ✓' ) );
		badge.title = t( 'dictAddedTitle', 'Added to your dictionary' );
		return badge;
	}

	/**
	 * The per-card control: a hover-revealed + (link-tooltip icon-button style)
	 * that opens the group picker, or the session "Added ✓" badge once the
	 * expression is in the dictionary. `getTranslation` is read at click time so
	 * the teacher's unsaved Polish edits carry over. The Example is intentionally
	 * never sent.
	 */
	function dictAddControl( lesson, word, getTranslation ) {
		if ( dictAdded[ dictKey( lesson, word ) ] ) {
			return dictAddedBadge();
		}

		var btn = el( 'button', 'tbt-dict-add' );
		btn.type = 'button';
		btn.title = t( 'dictAdd', 'Add to my dictionary' );
		btn.setAttribute( 'aria-label', t( 'dictAdd', 'Add to my dictionary' ) );
		btn.setAttribute( 'aria-haspopup', 'true' );
		btn.setAttribute( 'aria-expanded', 'false' );
		btn.innerHTML = DICT_ADD_ICON;
		// Same guard as the highlight popup: pressing the control must not blur
		// the editor, drop a Quill selection, or steal focus from a card field.
		btn.addEventListener( 'mousedown', function ( e ) {
			e.preventDefault();
		} );
		btn.addEventListener( 'click', function () {
			openDictMenu( btn, function ( group ) {
				return pdAddWord( group.id, word, getTranslation() ).then( function () {
					dictAdded[ dictKey( lesson, word ) ] = true;
					if ( btn.parentNode ) {
						btn.parentNode.replaceChild( dictAddedBadge(), btn );
					}
				} );
			} );
		} );
		return btn;
	}

	/* ---------------------------------------------------------- Class settings */

	function renderClassSettings() {
		var cls = state.currentClass;
		content.appendChild( buildTopbar( {
			title: cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '',
			onBack: function () {
				state.view = 'class';
				render();
			},
		} ) );

		var body = el( 'div', 'tbt-notes-body' );

		// Title.
		var titleField = el( 'div', 'tbt-notes-field' );
		titleField.appendChild( el( 'label', 'tbt-notes-field__label', t( 'classTitle', 'Class title' ) ) );
		var titleInput = el( 'input', 'tbt-notes-input' );
		titleInput.type = 'text';
		titleInput.value = cls.title || '';
		titleInput.placeholder = t( 'classTitlePh', '' );
		var titleTimer = null;
		titleInput.addEventListener( 'input', function () {
			clearTimeout( titleTimer );
			titleTimer = setTimeout( function () {
				saveClassField( cls, { title: titleInput.value } );
			}, 500 );
		} );
		titleField.appendChild( titleInput );
		body.appendChild( titleField );

		// Students (multi).
		var studentField = el( 'div', 'tbt-notes-field' );
		studentField.appendChild( el( 'label', 'tbt-notes-field__label', t( 'students', 'Students' ) ) );
		buildStudentPicker( studentField, cls );
		body.appendChild( studentField );

		// Delete.
		var del = el( 'button', 'tbt-notes-btn tbt-notes-btn--danger tbt-notes-btn--block', t( 'deleteClass', 'Delete class' ) );
		del.type = 'button';
		del.style.marginTop = '8px';
		del.addEventListener( 'click', function () {
			deleteClassFlow( cls );
		} );
		body.appendChild( del );

		content.appendChild( body );
	}

	/**
	 * Multi-student picker: current students as removable chips + a username/
	 * name/email search to add more.
	 */
	function buildStudentPicker( container, cls ) {
		cls.students = cls.students || [];
		var chips = el( 'div', 'tbt-notes-chips' );
		var input = el( 'input', 'tbt-notes-input' );
		input.type = 'text';
		input.placeholder = t( 'searchStudents', 'Search by username, name or email…' );
		input.setAttribute( 'autocomplete', 'off' );
		var results = el( 'ul', 'tbt-notes-userresults' );
		results.hidden = true;
		var hint = el( 'p', 'tbt-notes-hint', t( 'searchHint', 'Type to find a student to add.' ) );
		var msg = el( 'div' );

		function syncClass() {
			// Keep the cached class object's roster in step for list meta.
			for ( var i = 0; i < state.classes.length; i++ ) {
				if ( state.classes[ i ].id === cls.id ) {
					state.classes[ i ].students = cls.students;
					state.classes[ i ].student_count = cls.students.length;
				}
			}
		}

		function renderChips() {
			clear( chips );
			if ( ! cls.students.length ) {
				chips.appendChild( el( 'p', 'tbt-notes-hint', t( 'noStudents', 'No students in this class yet.' ) ) );
				return;
			}
			cls.students.forEach( function ( s ) {
				var chip = el( 'div', 'tbt-notes-chip' );
				chip.appendChild( el( 'span', 'tbt-notes-chip__name', s.name || s.username ) );
				var rm = el( 'button', 'tbt-notes-chip__remove' );
				rm.type = 'button';
				rm.textContent = '✕';
				rm.setAttribute( 'aria-label', t( 'unassign', 'Remove student' ) );
				rm.addEventListener( 'click', function () {
					removeStudent( s.id );
				} );
				chip.appendChild( rm );
				chips.appendChild( chip );
			} );
		}

		function addStudent( id ) {
			clear( msg );
			api( 'POST', 'classes/' + cls.id + '/students', { user_id: id } ).then( function ( data ) {
				cls.students = data.students || [];
				syncClass();
				input.value = '';
				results.hidden = true;
				clear( results );
				renderChips();
			} ).catch( function ( err ) {
				msg.appendChild( errorBlock( err.message ) );
			} );
		}

		function removeStudent( id ) {
			clear( msg );
			api( 'DELETE', 'classes/' + cls.id + '/students/' + id ).then( function ( data ) {
				cls.students = data.students || [];
				syncClass();
				renderChips();
			} ).catch( function ( err ) {
				msg.appendChild( errorBlock( err.message ) );
			} );
		}

		function inThisClass( id ) {
			for ( var i = 0; i < cls.students.length; i++ ) {
				if ( cls.students[ i ].id === id ) {
					return true;
				}
			}
			return false;
		}

		function renderResults( students ) {
			clear( results );
			if ( ! students.length ) {
				var none = el( 'li' );
				none.appendChild( el( 'div', 'tbt-notes-userresult', t( 'noResults', 'No matches' ) ) );
				results.appendChild( none );
				results.hidden = false;
				return;
			}
			students.forEach( function ( s ) {
				var li = el( 'li' );
				var b = el( 'button', 'tbt-notes-userresult' );
				b.type = 'button';
				b.appendChild( el( 'span', 'tbt-notes-userresult__user', s.name || s.username ) );
				var sub = '@' + s.username + ( s.email ? ' · ' + s.email : '' );
				if ( inThisClass( s.id ) ) {
					b.disabled = true;
					sub += ' · ' + t( 'added', 'added' );
				} else if ( s.assigned_class_id && s.assigned_class_id !== cls.id ) {
					b.disabled = true;
					sub += ' · ' + t( 'alreadyIn', 'in: ' ) + ( s.assigned_class_name || '' );
				}
				b.appendChild( document.createElement( 'br' ) );
				b.appendChild( el( 'span', 'tbt-notes-userresult__sub', sub ) );
				if ( ! b.disabled ) {
					b.addEventListener( 'click', function () {
						addStudent( s.id );
					} );
				}
				li.appendChild( b );
				results.appendChild( li );
			} );
			results.hidden = false;
		}

		var timer = null;
		input.addEventListener( 'input', function () {
			clearTimeout( timer );
			var term = input.value.trim();
			if ( ! term ) {
				results.hidden = true;
				clear( results );
				return;
			}
			timer = setTimeout( function () {
				api( 'GET', 'students?search=' + encodeURIComponent( term ) + '&number=20' ).then( function ( data ) {
					renderResults( data.students || [] );
				} ).catch( function ( err ) {
					clear( results );
					var li = el( 'li' );
					li.appendChild( errorBlock( err.message ) );
					results.appendChild( li );
					results.hidden = false;
				} );
			}, 250 );
		} );

		container.appendChild( chips );
		container.appendChild( input );
		container.appendChild( results );
		container.appendChild( hint );
		container.appendChild( msg );
		renderChips();
	}

	function saveClassField( cls, fields ) {
		return api( 'PATCH', 'classes/' + cls.id, fields ).then( function ( data ) {
			if ( data && data.class ) {
				for ( var i = 0; i < state.classes.length; i++ ) {
					if ( state.classes[ i ].id === data.class.id ) {
						// Preserve the roster we track locally.
						data.class.students = cls.students || state.classes[ i ].students;
						state.classes[ i ] = data.class;
					}
				}
				cls.title = data.class.title;
			}
			return data;
		} );
	}

	/* ----------------------------------------------------------------- Flows */

	function createClassFlow() {
		api( 'POST', 'classes', { title: '' } ).then( function ( data ) {
			data.class.students = data.class.students || [];
			state.classes.unshift( data.class );
			state.currentClass = data.class;
			state.lessons = [];
			state.currentLesson = null;
			state.view = 'classSettings';
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	function deleteClassFlow( cls ) {
		if ( ! window.confirm( t( 'confirmClass', 'Delete this class and all its lessons?' ) ) ) {
			return;
		}
		api( 'DELETE', 'classes/' + cls.id ).then( function () {
			state.classes = state.classes.filter( function ( c ) {
				return c.id !== cls.id;
			} );
			state.currentClass = null;
			state.lessons = [];
			state.currentLesson = null;
			state.view = 'root';
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	/**
	 * Keep the cached class's note count in step with the loaded lessons so the
	 * class-card grid shows an accurate "N notes" when the teacher navigates back.
	 */
	function syncCurrentClassNoteCount() {
		if ( ! state.currentClass ) {
			return;
		}
		var count = state.lessons.length;
		state.currentClass.note_count = count;
		for ( var i = 0; i < state.classes.length; i++ ) {
			if ( state.classes[ i ].id === state.currentClass.id ) {
				state.classes[ i ].note_count = count;
			}
		}
	}

	function createLessonFlow() {
		// New notes start with the default lesson template pre-inserted and an
		// auto-numbered header ("{n} - {date}") the server computes from the class's
		// existing lessons — sending an empty header opts into that. Both the header
		// and body become normal editable content immediately.
		api( 'POST', 'classes/' + state.currentClass.id + '/lessons', {
			header: '',
			body: defaultNoteTemplateHtml(),
		} ).then( function ( data ) {
			state.lessons.unshift( data.lesson );
			state.currentLesson = data.lesson;
			syncCurrentClassNoteCount();
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	function deleteLessonFlow( lesson ) {
		if ( ! window.confirm( t( 'confirmLesson', 'Delete this lesson?' ) ) ) {
			return;
		}
		api( 'DELETE', 'lessons/' + lesson.id ).then( function () {
			state.lessons = state.lessons.filter( function ( l ) {
				return l.id !== lesson.id;
			} );
			if ( state.currentLesson && state.currentLesson.id === lesson.id ) {
				state.currentLesson = state.lessons.length ? state.lessons[ 0 ] : null;
			}
			syncCurrentClassNoteCount();
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	/* --------------------------------------------------------------- Editor */

	function renderEditorInto( container, lesson, headerInput ) {
		var wrap = el( 'div', 'tbt-notes-editorwrap' );

		// Quill toolbar + (summary panel | editor). The summary panel sits below
		// the toolbar and overlays the editor when a highlight filter is active;
		// the editor stays mounted so Quill is never re-initialised.
		var quillWrap = el( 'div', 'tbt-notes-editor-quillwrap' );
		var summaryPanel = el( 'div', 'tbt-notes-filter-summary' );
		summaryPanel.hidden = true;
		var editorEl = el( 'div' );

		var toolbar = buildToolbar();

		quillWrap.appendChild( toolbar );
		quillWrap.appendChild( summaryPanel );
		quillWrap.appendChild( editorEl );
		wrap.appendChild( quillWrap );

		// Footer: save indicator + delete.
		var footer = el( 'div', 'tbt-notes-editor-footer' );
		var indicator = el( 'span', 'tbt-notes-saveind is-saved', t( 'saved', 'All changes saved' ) );
		footer.appendChild( indicator );
		var del = el( 'button', 'tbt-notes-btn tbt-notes-btn--danger', t( 'deleteLesson', 'Delete lesson' ) );
		del.type = 'button';
		del.addEventListener( 'click', function () {
			deleteLessonFlow( lesson );
		} );
		footer.appendChild( del );
		wrap.appendChild( footer );

		container.appendChild( wrap );

		initEditor( editorEl, toolbar, headerInput, lesson, indicator );

		// Insert the filter control AFTER Quill is built: the Snow theme runs
		// buildPickers() over every <select> in the toolbar at construction time
		// and would turn our native filter select into a broken, empty picker.
		// Adding it now (right after the highlight colours) keeps it untouched.
		var filterGroup = el( 'span', 'ql-formats tbt-filter-group' );
		filterGroup.appendChild( buildHighlightFilterSelect( function () {
			applyTeacherFilter( lesson, editorEl, summaryPanel );
		} ) );
		var hlGroup = toolbar.querySelector( '.tbt-hl-group' );
		if ( hlGroup ) {
			toolbar.insertBefore( filterGroup, hlGroup.nextSibling );
		} else {
			toolbar.insertBefore( filterGroup, toolbar.firstChild );
		}

		// Honour any pre-selected filter (normally reset to 'full' per lesson).
		applyTeacherFilter( lesson, editorEl, summaryPanel );
	}

	/**
	 * Teacher view: toggle between the live editor and the extracted-highlights
	 * summary without tearing Quill down. 'full' shows the editor; any other
	 * filter shows a summary rebuilt from the latest lesson.body.
	 */
	function applyTeacherFilter( lesson, editorEl, summaryPanel ) {
		var filter = state.highlightFilter || 'full';
		if ( filter === 'full' ) {
			summaryPanel.hidden = true;
			clear( summaryPanel );
			editorEl.style.display = '';
			return;
		}
		clear( summaryPanel );
		renderHighlightSummaryInto( summaryPanel, lesson, filter, true );
		summaryPanel.hidden = false;
		editorEl.style.display = 'none';
	}

	function buildToolbar() {
		var bar = el( 'div', 'tbt-notes-quill-toolbar' );

		function group() {
			return el( 'span', 'ql-formats' );
		}
		function qbtn( cls, value, label ) {
			var b = el( 'button' );
			b.type = 'button';
			b.className = cls;
			if ( value != null ) {
				b.value = value;
			}
			if ( label ) {
				b.setAttribute( 'aria-label', label );
				b.title = label;
			}
			return b;
		}

		// 1. Highlight colours + clear. (The filter dropdown is inserted right
		//    after this group once Quill has initialised — see renderEditorInto.)
		var gh = group();
		gh.className = 'ql-formats tbt-hl-group';
		( cfg.highlightColors || [] ).forEach( function ( c, i ) {
			var b = el( 'button', 'tbt-hl-btn' );
			b.type = 'button';
			b.setAttribute( 'data-color', c.key );
			// Swatches map to Alt+1..Alt+5 in config order; surface the hint.
			var hint = c.label + ' — Alt+' + ( i + 1 );
			b.setAttribute( 'aria-label', t( 'highlight', 'Highlight' ) + ': ' + hint );
			b.title = t( 'highlight', 'Highlight' ) + ': ' + hint;
			gh.appendChild( b );
		} );
		var clearBtn = el( 'button', 'tbt-hl-clear' );
		clearBtn.type = 'button';
		clearBtn.textContent = '✕';
		clearBtn.setAttribute( 'data-color', '' );
		clearBtn.setAttribute( 'aria-label', t( 'removeHighlight', 'No highlight' ) + ' — Alt+0' );
		clearBtn.title = t( 'removeHighlight', 'No highlight' ) + ' — Alt+0';
		gh.appendChild( clearBtn );
		bar.appendChild( gh );

		// 2. Inline text tools.
		var g1 = group();
		g1.appendChild( qbtn( 'ql-bold', null, t( 'bold', 'Bold' ) ) );
		g1.appendChild( qbtn( 'ql-italic', null, t( 'italic', 'Italic' ) ) );
		g1.appendChild( qbtn( 'ql-underline', null, t( 'underline', 'Underline' ) ) );
		g1.appendChild( qbtn( 'ql-strike', null, t( 'strike', 'Strikethrough' ) ) );
		bar.appendChild( g1 );

		// 3. Link + photo upload. A custom (non-ql) image button so we never get
		//    Quill's default "paste an image URL" prompt: uploads go through our
		//    own file picker + REST route instead (wired up in initEditor).
		var g2 = group();
		g2.appendChild( qbtn( 'ql-link', null, t( 'link', 'Link' ) ) );
		var imgBtn = el( 'button', 'tbt-image-trigger' );
		imgBtn.type = 'button';
		imgBtn.setAttribute( 'aria-label', t( 'addPhoto', 'Add photo' ) );
		imgBtn.title = t( 'addPhoto', 'Add photo' );
		imgBtn.textContent = '🖼';
		g2.appendChild( imgBtn );
		bar.appendChild( g2 );

		// 4. Lists + indentation.
		var g3 = group();
		g3.appendChild( qbtn( 'ql-list', 'ordered', t( 'orderedList', 'Numbered list' ) ) );
		g3.appendChild( qbtn( 'ql-list', 'bullet', t( 'bulletList', 'Bulleted list' ) ) );
		g3.appendChild( qbtn( 'ql-indent', '-1', t( 'outdent', 'Decrease indent' ) ) );
		g3.appendChild( qbtn( 'ql-indent', '+1', t( 'indent', 'Increase indent' ) ) );
		bar.appendChild( g3 );

		// 5. Structure: headings + blockquote.
		var g4 = group();
		g4.appendChild( qbtn( 'ql-header', '2', t( 'heading2', 'H2' ) ) );
		g4.appendChild( qbtn( 'ql-header', '3', t( 'heading3', 'H3' ) ) );
		g4.appendChild( qbtn( 'ql-blockquote', null, t( 'blockquote', 'Quote' ) ) );
		bar.appendChild( g4 );

		// 6. AI Quick Note launcher. Plain (non-ql) button so the Snow theme
		//    leaves it alone; wired up after Quill is built (see initEditor).
		if ( cfg.aiEnabled ) {
			var g5 = group();
			var ai = el( 'button', 'tbt-ai-trigger' );
			ai.type = 'button';
			ai.setAttribute( 'aria-label', t( 'aiAsk', 'Ask AI' ) );
			ai.title = t( 'aiAsk', 'Ask AI' ) + ' — /ai';
			ai.appendChild( el( 'span', 'tbt-ai-trigger__icon', '✨' ) );
			ai.appendChild( el( 'span', 'tbt-ai-trigger__label', t( 'aiAsk', 'Ask AI' ) ) );
			g5.appendChild( ai );
			bar.appendChild( g5 );
		}

		return bar;
	}

	var highlightRegistered = false;

	function registerHighlightFormat() {
		if ( highlightRegistered || typeof window.Quill === 'undefined' ) {
			return;
		}
		var Parchment = window.Quill.import( 'parchment' );
		var HighlightClass = new Parchment.ClassAttributor( 'highlight', 'tbt-hl', {
			scope: Parchment.Scope.INLINE,
			whitelist: ( cfg.highlightColors || [] ).map( function ( c ) {
				return c.key;
			} ),
		} );
		window.Quill.register( HighlightClass, true );
		highlightRegistered = true;
	}

	/**
	 * Apply (or toggle off) a highlight colour over a range, exactly as a swatch
	 * click does. Shared by the toolbar swatches and the Alt+number shortcuts.
	 * `color` '' clears the highlight.
	 */
	function applyHighlightFormat( quill, color, range ) {
		if ( ! range ) {
			return;
		}
		if ( range.length > 0 ) {
			var value = color ? color : false;
			if ( color ) {
				var fmt = quill.getFormat( range.index, range.length );
				if ( fmt.highlight === color ) {
					value = false; // Re-applying the same colour toggles it off.
				}
			}
			quill.formatText( range.index, range.length, 'highlight', value, 'user' );
			quill.setSelection( range.index, range.length, 'silent' );
		} else {
			quill.format( 'highlight', color ? color : false, 'user' );
		}
	}

	// Inline SVGs for the link-tooltip actions (no icon font / CDN). These are
	// static, trusted strings, so innerHTML is safe here.
	var TOOLTIP_ICONS = {
		copy:
			'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<rect x="9" y="9" width="12" height="12" rx="2"/>' +
			'<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
		check:
			'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M20 6 9 17l-5-5"/></svg>',
		open:
			'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
			'<path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
	};

	/**
	 * Extend Quill's built-in Snow link tooltip (Edit + Remove) with Copy and Open,
	 * Notion-style. The native Edit/Remove elements and handlers are left untouched;
	 * we only add two icon buttons and read the currently targeted link's href from
	 * the tooltip's preview anchor (which Quill points at the clicked link).
	 */
	function enhanceLinkTooltip( quill ) {
		var tooltip = quill.theme && quill.theme.tooltip ? quill.theme.tooltip.root : null;
		if ( ! tooltip && quill.container ) {
			tooltip = quill.container.querySelector( '.ql-tooltip' );
		}
		if ( ! tooltip || tooltip.querySelector( '.ql-tbt-copy' ) ) {
			return;
		}
		var preview = tooltip.querySelector( 'a.ql-preview' );
		var action = tooltip.querySelector( 'a.ql-action' );
		if ( ! preview || ! action ) {
			return;
		}

		function currentHref() {
			return preview.getAttribute( 'href' ) || preview.textContent || '';
		}

		var copyBtn = el( 'a', 'ql-tbt-copy' );
		copyBtn.setAttribute( 'role', 'button' );
		copyBtn.setAttribute( 'aria-label', t( 'copyLink', 'Copy link' ) );
		copyBtn.title = t( 'copyLink', 'Copy link' );
		copyBtn.innerHTML = TOOLTIP_ICONS.copy;
		var copyRevert = null;
		copyBtn.addEventListener( 'click', function ( e ) {
			e.preventDefault();
			var href = currentHref();
			if ( ! href || ! navigator.clipboard || ! navigator.clipboard.writeText ) {
				return;
			}
			navigator.clipboard.writeText( href ).then( function () {
				// Brief, non-intrusive confirmation: swap to a check for ~1s.
				copyBtn.innerHTML = TOOLTIP_ICONS.check;
				copyBtn.classList.add( 'is-copied' );
				window.clearTimeout( copyRevert );
				copyRevert = window.setTimeout( function () {
					copyBtn.innerHTML = TOOLTIP_ICONS.copy;
					copyBtn.classList.remove( 'is-copied' );
				}, 1000 );
			} ).catch( function () {
				// Clipboard blocked/denied: fail quietly, leave the tooltip intact.
			} );
		} );

		var openBtn = el( 'a', 'ql-tbt-open' );
		openBtn.setAttribute( 'role', 'button' );
		openBtn.setAttribute( 'aria-label', t( 'openLink', 'Open link' ) );
		openBtn.title = t( 'openLink', 'Open link' );
		openBtn.innerHTML = TOOLTIP_ICONS.open;
		openBtn.addEventListener( 'click', function ( e ) {
			e.preventDefault();
			var href = currentHref();
			if ( href ) {
				// Mirror the plugin's link policy (target="_blank" rel="noopener…").
				window.open( href, '_blank', 'noopener,noreferrer' );
			}
		} );

		// Order left-to-right: Copy, Open, Edit, Remove — insert ours before Edit.
		tooltip.insertBefore( copyBtn, action );
		tooltip.insertBefore( openBtn, action );
	}

	/**
	 * A floating highlight popup: on a non-empty selection inside the editor, show
	 * the five colour swatches + a remove control just above the selection. Each
	 * control routes through the same applyHighlightFormat() the keyboard shortcuts
	 * use, so the markup is identical. Teacher editor only (wired to the editable
	 * Quill instance).
	 */
	function setupSelectionHighlightPopup( quill, quillWrap ) {
		if ( ! quillWrap ) {
			return;
		}

		var popup = el( 'div', 'tbt-hl-popup' );
		popup.hidden = true;
		// A mousedown inside the popup must not blur the editor or drop the
		// selection before the format is applied (Quill selection-preservation).
		popup.addEventListener( 'mousedown', function ( e ) {
			e.preventDefault();
		} );

		var savedRange = null;

		function applyFromPopup( color ) {
			var range = savedRange || quill.getSelection();
			if ( ! range || range.length === 0 ) {
				return;
			}
			applyHighlightFormat( quill, color, range );
			// applyHighlightFormat re-selects the range ('silent'), which fires a
			// selection-change that keeps the popup in place for another colour.
			savedRange = quill.getSelection() || range;
		}

		( cfg.highlightColors || [] ).forEach( function ( c, i ) {
			var sw = el( 'button', 'tbt-hl-popup__swatch' );
			sw.type = 'button';
			sw.setAttribute( 'data-color', c.key );
			var hint = c.label + ' — Alt+' + ( i + 1 );
			sw.setAttribute( 'aria-label', hint );
			sw.title = hint;
			sw.addEventListener( 'click', function () {
				applyFromPopup( c.key );
			} );
			popup.appendChild( sw );
		} );

		var removeBtn = el( 'button', 'tbt-hl-popup__remove' );
		removeBtn.type = 'button';
		removeBtn.textContent = '✕';
		removeBtn.setAttribute( 'data-color', '' );
		removeBtn.setAttribute( 'aria-label', t( 'removeHighlight', 'No highlight' ) + ' — Alt+0' );
		removeBtn.title = t( 'removeHighlight', 'No highlight' ) + ' — Alt+0';
		removeBtn.addEventListener( 'click', function () {
			applyFromPopup( '' );
		} );
		popup.appendChild( removeBtn );

		quillWrap.appendChild( popup );

		function hide() {
			if ( ! popup.hidden ) {
				popup.hidden = true;
			}
		}

		function position( range ) {
			if ( ! range || range.length === 0 || ! quill.hasFocus() ) {
				hide();
				return;
			}
			var bounds = quill.getBounds( range.index, range.length );
			if ( ! bounds ) {
				hide();
				return;
			}
			// Bounds are relative to quill.container; hide when the selection has
			// scrolled out of the editor's visible area.
			var containerRect = quill.container.getBoundingClientRect();
			if ( bounds.bottom < 0 || bounds.top > containerRect.height ) {
				hide();
				return;
			}
			popup.hidden = false; // Must be visible to measure its size.
			var pw = popup.offsetWidth;
			var ph = popup.offsetHeight;
			var wrapRect = quillWrap.getBoundingClientRect();
			var selTopVp = containerRect.top + bounds.top;
			var selBottomVp = containerRect.top + bounds.bottom;
			var centerXVp = containerRect.left + bounds.left + bounds.width / 2;
			var leftAbs = ( centerXVp - wrapRect.left ) - pw / 2;
			var topAbs = ( selTopVp - wrapRect.top ) - ph - 8;
			// If it would overflow above the editor, flip below the selection.
			if ( selTopVp - ph - 8 < containerRect.top ) {
				topAbs = ( selBottomVp - wrapRect.top ) + 8;
			}
			// Keep it inside the wrapper horizontally (itself within the viewport).
			var maxLeft = wrapRect.width - pw - 4;
			if ( leftAbs > maxLeft ) {
				leftAbs = maxLeft;
			}
			if ( leftAbs < 4 ) {
				leftAbs = 4;
			}
			popup.style.left = leftAbs + 'px';
			popup.style.top = topAbs + 'px';
		}

		// Show on a non-empty focused selection; hide on collapse, blur or typing
		// (typing replaces the selection, which fires a collapsed selection-change).
		quill.on( 'selection-change', function ( range ) {
			if ( range && range.length > 0 && quill.hasFocus() ) {
				savedRange = range;
				position( range );
			} else {
				savedRange = null;
				hide();
			}
		} );

		// Keep it glued to the selection as the editor or page scrolls / resizes.
		// position() re-shows or hides depending on whether the selection is still
		// in view, so a scroll-out then scroll-back behaves sensibly.
		function reflow() {
			if ( savedRange ) {
				position( savedRange );
			}
		}
		window.addEventListener( 'scroll', reflow, true );
		window.addEventListener( 'resize', reflow );
	}

	function initEditor( editorEl, toolbar, headerInput, lesson, indicator ) {
		if ( typeof window.Quill === 'undefined' ) {
			editorEl.appendChild( errorBlock( t( 'genericError', 'Editor failed to load.' ) ) );
			return;
		}
		registerHighlightFormat();

		var quill = new window.Quill( editorEl, {
			theme: 'snow',
			modules: { toolbar: toolbar },
			formats: [
				'bold',
				'italic',
				'underline',
				'strike',
				'link',
				'list',
				'indent',
				'header',
				'blockquote',
				'highlight',
				'image',
			],
		} );

		if ( lesson.body && lesson.body.trim() ) {
			quill.clipboard.dangerouslyPasteHTML( 0, lesson.body, 'silent' );
		}

		var saver = createSaver( lesson, indicator );
		activeSaver = saver;

		var lastRange = null;
		quill.on( 'selection-change', function ( range ) {
			if ( range ) {
				lastRange = range;
			}
		} );

		function highlightWithFallbackRange( color ) {
			var range = quill.getSelection() || lastRange;
			if ( ! range ) {
				quill.focus();
				range = quill.getSelection();
			}
			applyHighlightFormat( quill, color, range );
		}

		var swatches = toolbar.querySelectorAll( '.tbt-hl-btn, .tbt-hl-clear' );
		Array.prototype.forEach.call( swatches, function ( btn ) {
			btn.addEventListener( 'mousedown', function ( e ) {
				e.preventDefault();
			} );
			btn.addEventListener( 'click', function () {
				highlightWithFallbackRange( btn.getAttribute( 'data-color' ) );
			} );
		} );

		// Keyboard shortcuts: Alt+1..5 apply highlight colours, Alt+0 clears.
		// Keyed off e.code (physical key) so they work whatever character Alt
		// produces, and bound to the editor root so they never fire in other
		// inputs/selects or elsewhere on the site.
		var shortcutMap = {};
		( cfg.highlightColors || [] ).forEach( function ( c, i ) {
			shortcutMap[ 'Digit' + ( i + 1 ) ] = c.key;
			shortcutMap[ 'Numpad' + ( i + 1 ) ] = c.key;
		} );
		shortcutMap.Digit0 = '';
		shortcutMap.Numpad0 = '';
		quill.root.addEventListener( 'keydown', function ( e ) {
			if ( ! e.altKey || e.ctrlKey || e.metaKey ) {
				return;
			}
			if ( ! Object.prototype.hasOwnProperty.call( shortcutMap, e.code ) ) {
				return;
			}
			e.preventDefault();
			highlightWithFallbackRange( shortcutMap[ e.code ] );
		} );

		// Mouse-driven highlighting: a floating popup over the current selection,
		// and Copy/Open on the link tooltip. Both are editor-only (this instance).
		setupSelectionHighlightPopup( quill, editorEl.parentNode );
		enhanceLinkTooltip( quill );

		var ai = cfg.aiEnabled ? createAiQuickNote( quill, editorEl.parentNode, lesson, headerInput ) : null;
		if ( ai ) {
			var aiBtn = toolbar.querySelector( '.tbt-ai-trigger' );
			if ( aiBtn ) {
				aiBtn.addEventListener( 'mousedown', function ( e ) {
					e.preventDefault();
				} );
				aiBtn.addEventListener( 'click', function () {
					ai.openFromButton();
				} );
			}
		}

		quill.on( 'text-change', function ( delta, old, source ) {
			if ( source !== 'user' ) {
				return;
			}
			var html = quill.getSemanticHTML();
			lesson.body = html;
			saver.queue( { body: html } );

			// Typing "/ai" opens the AI Quick Note panel (and removes the trigger).
			if ( ai ) {
				ai.maybeTriggerSlash();
			}
		} );

		setupImageUpload( quill, toolbar, editorEl, lesson, saver, indicator );

		headerInput.addEventListener( 'input', function () {
			lesson.header = headerInput.value;
			saver.queue( { header: headerInput.value } );
			// Reflect the header in the sidebar nav item live.
			var navTitle = content.querySelector( '.tbt-notes-listitem__main.is-active .tbt-notes-listitem__title' );
			if ( navTitle ) {
				navTitle.textContent = lessonTitlePart( lesson );
			}
			// Keep the shared tab title (Teams) current as the teacher types.
			updateDocTitle();
		} );

		window.setTimeout( function () {
			if ( ! lesson.header ) {
				headerInput.focus();
			} else {
				quill.focus();
			}
		}, 60 );
	}

	/**
	 * Wire the toolbar photo button to a hidden file input and the upload route,
	 * and add a small "Replace / Delete" overlay that appears when the teacher
	 * clicks an image in the editor. Selecting a JPG/PNG uploads it, inserts it at
	 * the caret (or replaces the selected image), and lets the existing autosave
	 * persist the new body. The upload path (uploadLessonImage + insertUploadedImage)
	 * is deliberately generic so a future paste-from-clipboard feature can reuse it
	 * with a File pulled from clipboardData.
	 */
	function setupImageUpload( quill, toolbar, editorEl, lesson, saver, indicator ) {
		var imgBtn = toolbar.querySelector( '.tbt-image-trigger' );
		var wrap = editorEl.parentNode || editorEl;

		// Hidden native picker: JPG/PNG only. Lives in the editor wrapper so it is
		// torn down with the editor.
		var imageInput = document.createElement( 'input' );
		imageInput.type = 'file';
		imageInput.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
		imageInput.hidden = true;
		wrap.appendChild( imageInput );

		// Floating Replace/Delete controls, shown over the clicked image. Anchored
		// inside the (position:relative) editor wrap.
		var controls = el( 'div', 'tbt-notes-image-controls' );
		controls.hidden = true;
		var replaceBtn = el( 'button', 'tbt-notes-image-controls__btn', t( 'replacePhoto', 'Replace' ) );
		replaceBtn.type = 'button';
		var deleteBtn = el( 'button', 'tbt-notes-image-controls__btn tbt-notes-image-controls__btn--danger', t( 'deletePhoto', 'Delete' ) );
		deleteBtn.type = 'button';
		controls.appendChild( replaceBtn );
		controls.appendChild( deleteBtn );
		wrap.appendChild( controls );

		var uploading = false;
		var selectedImg = null;   // Image currently showing the controls.
		var replaceTarget = null; // Image being replaced by the next upload.

		function setBusy( busy ) {
			uploading = busy;
			if ( imgBtn ) {
				imgBtn.disabled = busy;
				imgBtn.title = busy ? t( 'imageUploading', 'Uploading…' ) : t( 'addPhoto', 'Add photo' );
			}
			if ( indicator && busy ) {
				indicator.className = 'tbt-notes-saveind is-saving';
				indicator.textContent = t( 'imageUploadingSave', 'Uploading image…' );
			}
		}

		// Resolve an <img> DOM node to its Quill document index (or -1).
		function imageIndex( node ) {
			if ( ! node || typeof window.Quill === 'undefined' || ! window.Quill.find ) {
				return -1;
			}
			var blot = window.Quill.find( node );
			if ( ! blot ) {
				return -1;
			}
			try {
				return quill.getIndex( blot );
			} catch ( e ) {
				return -1;
			}
		}

		function positionControls() {
			if ( ! selectedImg ) {
				return;
			}
			// Hide the controls if the image has scrolled out of the editor viewport.
			var contRect = editorEl.getBoundingClientRect();
			var imgRect = selectedImg.getBoundingClientRect();
			if ( imgRect.bottom < contRect.top || imgRect.top > contRect.bottom ) {
				controls.hidden = true;
				return;
			}
			controls.hidden = false;
			var wrapRect = wrap.getBoundingClientRect();
			var top = Math.max( imgRect.top - wrapRect.top + 8, contRect.top - wrapRect.top + 8 );
			var left = imgRect.right - wrapRect.left - controls.offsetWidth - 8;
			controls.style.top = top + 'px';
			controls.style.left = Math.max( left, 8 ) + 'px';
		}

		function selectImage( node ) {
			if ( selectedImg && selectedImg !== node ) {
				selectedImg.classList.remove( 'is-selected' );
			}
			selectedImg = node;
			selectedImg.classList.add( 'is-selected' );
			controls.hidden = false;
			positionControls();
		}

		function deselectImage() {
			if ( selectedImg ) {
				selectedImg.classList.remove( 'is-selected' );
			}
			selectedImg = null;
			controls.hidden = true;
		}

		// Click an image to select it; click anywhere else in the editor to clear.
		quill.root.addEventListener( 'click', function ( e ) {
			if ( e.target && 'IMG' === e.target.tagName ) {
				selectImage( e.target );
			} else {
				deselectImage();
			}
		} );

		// Keep the overlay glued to the image as the editor scrolls or reflows.
		editorEl.addEventListener( 'scroll', function () {
			if ( selectedImg ) {
				positionControls();
			}
		}, true );
		window.addEventListener( 'resize', function () {
			if ( selectedImg ) {
				positionControls();
			}
		} );
		quill.on( 'text-change', function () {
			if ( ! selectedImg ) {
				return;
			}
			// The selected image may have been removed (e.g. undo); drop the overlay.
			if ( ! selectedImg.parentNode ) {
				deselectImage();
			} else {
				positionControls();
			}
		} );
		quill.root.addEventListener( 'keydown', function ( e ) {
			if ( 'Escape' === e.key && selectedImg ) {
				deselectImage();
			}
		} );

		// Don't let a mousedown on the controls steal focus/selection from Quill.
		controls.addEventListener( 'mousedown', function ( e ) {
			e.preventDefault();
		} );

		deleteBtn.addEventListener( 'click', function () {
			if ( ! selectedImg ) {
				return;
			}
			var index = imageIndex( selectedImg );
			deselectImage();
			if ( index < 0 ) {
				return;
			}
			quill.deleteText( index, 1, 'user' );
			// deleteText('user') fires text-change (body + autosave); belt-and-braces.
			var html = quill.getSemanticHTML();
			lesson.body = html;
			saver.queue( { body: html } );
		} );

		replaceBtn.addEventListener( 'click', function () {
			if ( uploading || ! selectedImg ) {
				return;
			}
			replaceTarget = selectedImg; // Remember which image to swap.
			deselectImage();
			imageInput.click();
		} );

		if ( imgBtn ) {
			// Keep the editor selection while clicking the toolbar button.
			imgBtn.addEventListener( 'mousedown', function ( e ) {
				e.preventDefault();
			} );
			imgBtn.addEventListener( 'click', function () {
				if ( ! uploading ) {
					replaceTarget = null; // Toolbar button always inserts a new image.
					imageInput.click();
				}
			} );
		}

		imageInput.addEventListener( 'change', function () {
			var file = imageInput.files && imageInput.files[ 0 ];
			if ( ! file ) {
				return;
			}
			var problem = validateImageFile( file );
			if ( problem ) {
				window.alert( problem );
				imageInput.value = ''; // Allow re-selecting the same file later.
				replaceTarget = null;
				return;
			}

			var target = replaceTarget; // Capture for the async callback.
			replaceTarget = null;
			setBusy( true );
			uploadLessonImage( lesson.id, file ).then( function ( data ) {
				if ( ! data || ! data.image || ! data.image.url ) {
					throw new Error( t( 'imageError', 'Could not upload the image. Please try again.' ) );
				}
				insertUploadedImage( quill, lesson, saver, data.image, imageIndex( target ) );
			} ).catch( function ( err ) {
				window.alert( ( err && err.message ) || t( 'imageError', 'Could not upload the image. Please try again.' ) );
			} ).then( function () {
				// Runs on success and failure alike (finally).
				setBusy( false );
				imageInput.value = '';
			} );
		} );
	}

	/**
	 * Insert an already-uploaded image into Quill, then make sure the new body is
	 * queued for autosave. When replaceIndex points at an existing image (>= 0),
	 * that image is swapped in place; otherwise the image is inserted at the
	 * current caret (or the end of the document). Only trusted, server-returned
	 * upload URLs are ever inserted — never a local blob: or data: URL.
	 */
	function insertUploadedImage( quill, lesson, saver, image, replaceIndex ) {
		if ( replaceIndex != null && replaceIndex >= 0 ) {
			// Swap in place: drop the old embed, drop a new one where it stood. The
			// trailing newline after the old image is left untouched.
			quill.deleteText( replaceIndex, 1, 'user' );
			quill.insertEmbed( replaceIndex, 'image', image.url, 'user' );
			quill.setSelection( replaceIndex + 1, 0, 'silent' );
		} else {
			var range = quill.getSelection( true );
			var index = range ? range.index : quill.getLength();
			quill.insertEmbed( index, 'image', image.url, 'user' );
			quill.insertText( index + 1, '\n', 'user' );
			quill.setSelection( index + 2, 0, 'silent' );
		}

		// insertEmbed/deleteText with source 'user' fires text-change (which updates
		// lesson.body + queues a save); do it explicitly too so the change is never
		// left unsaved.
		var html = quill.getSemanticHTML();
		lesson.body = html;
		saver.queue( { body: html } );
	}

	/* ----------------------------------------------------------- AI Quick Note */

	/**
	 * HTML-escape a string for safe insertion into innerHTML / pasted markup.
	 *
	 * @param {string} s Raw text.
	 * @return {string}
	 */
	function escapeHtml( s ) {
		var d = document.createElement( 'div' );
		d.textContent = String( s == null ? '' : s );
		return d.innerHTML;
	}

	/**
	 * Convert the small Markdown subset the AI returns into HTML so Quill renders
	 * real formatting instead of literal "###"/"**" characters. Supported:
	 *   - "## " / "# "  -> <h2>   (note title)
	 *   - "### "+        -> <h3>   (subheadings)
	 *   - "**bold**"     -> <strong>
	 * Every other non-empty line becomes a <p>, so presets that return plain text
	 * (define, translate, …) are unaffected beyond paragraph wrapping. The text is
	 * escaped before the inline markers are applied, so it is safe to paste.
	 *
	 * @param {string} answer The AI answer text.
	 * @return {string} HTML markup.
	 */
	function answerToHtml( answer ) {
		var lines = String( answer == null ? '' : answer ).split( /\r?\n/ );
		var html = '';
		for ( var i = 0; i < lines.length; i++ ) {
			var line = lines[ i ].trim();
			if ( '' === line ) {
				continue;
			}
			var tag = 'p';
			var m = line.match( /^(#{1,6})\s+(.*)$/ );
			if ( m ) {
				// The note only styles two heading levels: # / ## -> h2, ### -> h3.
				tag = m[ 1 ].length <= 2 ? 'h2' : 'h3';
				line = m[ 2 ];
			}
			var content = escapeHtml( line ).replace( /\*\*([^*]+)\*\*/g, '<strong>$1</strong>' );
			html += '<' + tag + '>' + content + '</' + tag + '>';
		}
		return html;
	}

	/**
	 * In-editor "Ask AI" helper. Opened by typing `/ai` or clicking the toolbar
	 * button. The teacher types a short prompt, gets a concise answer from the
	 * server-side endpoint, and inserts it into the note (or discards it). The
	 * OpenAI key never touches the browser — this only talks to our REST route.
	 *
	 * @param {object} quill      The Quill instance.
	 * @param {Element} quillWrap The positioned wrapper the panel is mounted in.
	 * @param {object} lesson     The current lesson (for title context, future use).
	 * @param {Element} headerInput The lesson header field.
	 * @return {{ openFromButton: Function, maybeTriggerSlash: Function }}
	 */
	function createAiQuickNote( quill, quillWrap, lesson, headerInput ) {
		var panel = null;
		var input = null;
		var statusEl = null;
		var responseEl = null;
		var responseText = null;
		var submitBtn = null;
		var presetButtons = [];
		var insertIndex = 0;     // Where Insert will drop the answer.
		var activePreset = '';   // Currently selected preset key, or ''.
		var busy = false;        // A request is in flight.
		var suppress = false;    // Guards against our own edits re-triggering /ai.
		var lastAnswer = '';

		function ensurePanel() {
			if ( panel ) {
				return;
			}
			panel = el( 'div', 'tbt-ai-panel' );
			panel.setAttribute( 'role', 'dialog' );
			panel.setAttribute( 'aria-label', t( 'aiPanelTitle', 'Ask AI' ) );

			// Header: title + close.
			var head = el( 'div', 'tbt-ai-panel__head' );
			head.appendChild( el( 'span', 'tbt-ai-panel__title', '✨ ' + t( 'aiPanelTitle', 'Ask AI' ) ) );
			var closeBtn = el( 'button', 'tbt-ai-panel__close' );
			closeBtn.type = 'button';
			closeBtn.textContent = '✕';
			closeBtn.setAttribute( 'aria-label', t( 'aiClose', 'Close' ) );
			closeBtn.title = t( 'aiClose', 'Close' );
			closeBtn.addEventListener( 'click', close );
			head.appendChild( closeBtn );
			panel.appendChild( head );

			// Preset chips (define, translate, …). Optional; backend keeps the wording.
			var presets = cfg.aiPresets || [];
			if ( presets.length ) {
				var presetRow = el( 'div', 'tbt-ai-presets' );
				presets.forEach( function ( p ) {
					var b = el( 'button', 'tbt-ai-preset', p.label );
					b.type = 'button';
					b.setAttribute( 'data-preset', p.key );
					b.addEventListener( 'click', function () {
						setPreset( activePreset === p.key ? '' : p.key );
						input.focus();
					} );
					presetRow.appendChild( b );
					presetButtons.push( b );
				} );
				panel.appendChild( presetRow );
			}

			// Prompt input + submit.
			var inputRow = el( 'div', 'tbt-ai-input-row' );
			input = el( 'textarea', 'tbt-ai-input' );
			input.rows = 2;
			input.placeholder = t( 'aiPlaceholder', 'Ask AI…' );
			input.addEventListener( 'keydown', function ( e ) {
				// Enter submits; Shift+Enter inserts a newline.
				if ( e.key === 'Enter' && ! e.shiftKey ) {
					e.preventDefault();
					submit();
				}
			} );
			inputRow.appendChild( input );
			submitBtn = el( 'button', 'tbt-notes-btn tbt-ai-submit', t( 'aiSubmit', 'Ask' ) );
			submitBtn.type = 'button';
			submitBtn.addEventListener( 'click', submit );
			inputRow.appendChild( submitBtn );
			panel.appendChild( inputRow );

			// Status (loading / error) and response card.
			statusEl = el( 'div', 'tbt-ai-status' );
			statusEl.hidden = true;
			panel.appendChild( statusEl );

			responseEl = el( 'div', 'tbt-ai-response' );
			responseEl.hidden = true;
			responseText = el( 'div', 'tbt-ai-response__text' );
			responseEl.appendChild( responseText );
			var actions = el( 'div', 'tbt-ai-response__actions' );
			var insertBtn = el( 'button', 'tbt-notes-btn', t( 'aiInsert', 'Insert' ) );
			insertBtn.type = 'button';
			insertBtn.addEventListener( 'click', function () {
				insertAnswer( lastAnswer );
			} );
			var regenBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--ghost', t( 'aiRegenerate', 'Regenerate' ) );
			regenBtn.type = 'button';
			regenBtn.addEventListener( 'click', submit );
			var discardBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--ghost', t( 'aiDiscard', 'Discard' ) );
			discardBtn.type = 'button';
			discardBtn.addEventListener( 'click', close );
			actions.appendChild( insertBtn );
			actions.appendChild( regenBtn );
			actions.appendChild( discardBtn );
			responseEl.appendChild( actions );
			panel.appendChild( responseEl );

			// Escape closes the AI panel only (not the whole Notes panel).
			panel.addEventListener( 'keydown', function ( e ) {
				if ( e.key === 'Escape' ) {
					e.stopPropagation();
					close();
				}
			} );

			quillWrap.appendChild( panel );
		}

		function setPreset( key ) {
			activePreset = key || '';
			presetButtons.forEach( function ( b ) {
				if ( b.getAttribute( 'data-preset' ) === activePreset ) {
					b.classList.add( 'is-active' );
				} else {
					b.classList.remove( 'is-active' );
				}
			} );
		}

		function showStatus( msg, isError ) {
			responseEl.hidden = true;
			statusEl.hidden = false;
			statusEl.textContent = msg;
			statusEl.className = 'tbt-ai-status' + ( isError ? ' is-error' : '' );
		}

		function clearStatus() {
			statusEl.hidden = true;
			statusEl.textContent = '';
		}

		function showResponse( answer ) {
			lastAnswer = answer;
			clearStatus();
			// Preview the formatted result (headings/bold) so it matches what Insert
			// will drop into the note. Safe: server-cleaned text, re-escaped here.
			responseText.innerHTML = answerToHtml( answer );
			responseEl.hidden = false;
			// The panel just grew; re-clamp so the answer doesn't push it off-screen.
			position();
		}

		function position() {
			// Anchor just below the caret, clamped to the wrapper on both axes so the
			// panel never spills off the editor area. Falls back to the top-left of
			// the editor if Quill cannot report bounds.
			panel.style.top = '8px';
			panel.style.left = '8px';
			try {
				var b = quill.getBounds( insertIndex );
				if ( ! b ) {
					return;
				}
				var contRect = quill.container.getBoundingClientRect();
				var wrapRect = quillWrap.getBoundingClientRect();

				var left = ( contRect.left - wrapRect.left ) + b.left;
				var maxLeft = quillWrap.clientWidth - panel.offsetWidth - 12;
				if ( left > maxLeft ) {
					left = maxLeft;
				}
				if ( left < 8 ) {
					left = 8;
				}

				var top = ( contRect.top - wrapRect.top ) + b.top + b.height + 8;
				var maxTop = quillWrap.clientHeight - panel.offsetHeight - 12;
				if ( top > maxTop ) {
					top = maxTop;
				}
				if ( top < 8 ) {
					top = 8;
				}

				panel.style.top = top + 'px';
				panel.style.left = left + 'px';
			} catch ( e ) {
				// Keep the fallback position.
			}
		}

		function open( index ) {
			ensurePanel();
			insertIndex = typeof index === 'number' ? index : quill.getLength();
			clearStatus();
			responseEl.hidden = true;
			lastAnswer = '';
			panel.hidden = false;
			position();
			window.setTimeout( function () {
				input.focus();
			}, 0 );
		}

		function close() {
			if ( ! panel ) {
				return;
			}
			panel.hidden = true;
			busy = false;
			setBusy( false );
			// Return focus to the editor so the teacher keeps typing.
			quill.focus();
		}

		function setBusy( on ) {
			busy = on;
			if ( submitBtn ) {
				submitBtn.disabled = on;
			}
		}

		function submit() {
			if ( busy ) {
				return;
			}
			var prompt = input.value.trim();
			if ( ! prompt ) {
				showStatus( t( 'aiEmptyPrompt', 'Please type a prompt for the AI.' ), true );
				input.focus();
				return;
			}

			setBusy( true );
			showStatus( t( 'aiThinking', 'Thinking…' ), false );

			// MVP sends prompt + preset only. Note title / selected text / surrounding
			// text are accepted by the backend but intentionally not wired here yet
			// (see spec §21 "Future features": use selected text / note title as context).
			var payload = { prompt: prompt };
			if ( activePreset ) {
				payload.preset = activePreset;
			}

			api( 'POST', 'ai-quick-note', payload ).then( function ( data ) {
				setBusy( false );
				if ( ! data || ! data.answer ) {
					showStatus( t( 'aiError', 'AI is not available at the moment. Please try again.' ), true );
					return;
				}
				showResponse( data.answer );
			} ).catch( function ( err ) {
				setBusy( false );
				showStatus( ( err && err.message ) || t( 'aiError', 'AI is not available at the moment. Please try again.' ), true );
			} );
		}

		function insertAnswer( answer ) {
			if ( ! answer ) {
				return;
			}
			quill.focus();
			var at = Math.min( insertIndex, quill.getLength() );
			suppress = true;
			// Render the answer's Markdown headings/bold as real formatting (h2/h3,
			// <strong>); plain-text presets just become paragraphs. Pasted as 'user'
			// so autosave picks it up — mirrors how the lesson body is loaded.
			var before = quill.getLength();
			quill.clipboard.dangerouslyPasteHTML( at, answerToHtml( answer ), 'user' );
			var added = Math.max( quill.getLength() - before, 0 );
			quill.setSelection( at + added, 0, 'silent' );
			suppress = false;
			close();
		}

		function openFromButton() {
			var range = quill.getSelection();
			open( range ? range.index : quill.getLength() );
		}

		function maybeTriggerSlash() {
			if ( suppress ) {
				return;
			}
			var range = quill.getSelection();
			if ( ! range || range.length !== 0 ) {
				return;
			}
			var index = range.index;
			if ( index < 3 ) {
				return;
			}
			if ( quill.getText( index - 3, 3 ) !== '/ai' ) {
				return;
			}
			// Only at a word boundary so it never fires mid-word (e.g. "a/air").
			if ( index - 3 > 0 ) {
				var before = quill.getText( index - 4, 1 );
				if ( before && ! /\s/.test( before ) ) {
					return;
				}
			}

			suppress = true;
			quill.deleteText( index - 3, 3, 'user' );
			suppress = false;

			open( index - 3 );
		}

		return {
			openFromButton: openFromButton,
			maybeTriggerSlash: maybeTriggerSlash,
		};
	}

	/* ---------------------------------------------------- Sticky header (page) */

	/**
	 * Page-mode sticky class header — a single, persistent controller bound at
	 * startup. It re-finds the live elements on every scroll, so it does not
	 * depend on the render lifecycle.
	 *
	 * Two members pin, in this order, as an ordered group:
	 *
	 *   1. the class title strip (.tbt-notes-topbar) — so the class name is
	 *      visible at every scroll position;
	 *   2. the Quill editor toolbar (.ql-toolbar).
	 *
	 * Each member is optional: students have no toolbar, and the strip still pins
	 * on its own.
	 *
	 * Both are MOVED (never cloned) into a position:fixed host mounted on <body>,
	 * with an in-flow spacer holding each one's place. Cloning would silently
	 * break them — the strip carries the live lesson-header input bound to the
	 * autosave controller, and the toolbar is bound to the Quill instance. The
	 * host lives on <body> rather than using position:sticky because a theme
	 * wrapper (e.g. a Divi element with overflow or transform) creates a
	 * containing block that traps a sticky element; see the matching note in
	 * tbt-notes.css.
	 *
	 * @return {Object} Controller with update() and unpinAll().
	 */
	function initPageStickyHeader() {
		var host = null;
		var toolbarSlot = null;
		var lastOffset = null;

		// Ordered group, top to bottom. `find` locates the live element, `owner`
		// the block it belongs to (once that block has scrolled past, the member
		// unpins), and `mount` puts it in the right slot inside the host.
		var members = [
			{
				name: 'topbar',
				spacerCls: 'tbt-notes-topbar-spacer',
				find: function ( appEl ) {
					return appEl.querySelector( '.tbt-notes-topbar' );
				},
				owner: function ( elm ) {
					return elm.parentNode;
				},
				mount: function ( elm ) {
					// Always ahead of the toolbar slot, whatever order they pin in.
					host.insertBefore( elm, toolbarSlot );
				},
				el: null,
				spacer: null,
				box: null,
			},
			{
				name: 'toolbar',
				spacerCls: 'tbt-notes-toolbar-spacer',
				find: function ( appEl ) {
					return appEl.querySelector( '.tbt-notes-editor-quillwrap .ql-toolbar' );
				},
				owner: function ( elm ) {
					return elm.closest( '.tbt-notes-editor-quillwrap' );
				},
				mount: function ( elm ) {
					toolbarSlot.appendChild( elm );
				},
				el: null,
				spacer: null,
				box: null,
			},
		];

		function ensureHost() {
			if ( host ) {
				return;
			}
			// The app classes come along so the moved elements keep their Page Mode
			// styling and can still resolve the --tbtn-* variables.
			host = el( 'div', 'tbt-notes-app tbt-notes-app--page tbt-notes-sticky-host' );
			// The toolbar's own styling is written against this wrapper.
			toolbarSlot = el( 'div', 'tbt-notes-editor-quillwrap' );
			host.appendChild( toolbarSlot );
			document.body.appendChild( host );
		}

		/**
		 * Distance from the top of the viewport to the first pixel this strip may
		 * occupy: the bottom edge of whatever is currently fixed above it (the WP
		 * admin bar, the theme's fixed menu, or both).
		 *
		 * Recomputed on every tick rather than cached, because a fixed theme header
		 * that shrinks on scroll makes any value measured at load wrong within one
		 * screen of scrolling.
		 *
		 * Uses the largest bottom edge rather than a sum of heights: an admin bar
		 * and a fixed menu are already stacked, so summing double-counts.
		 */
		function topOffset() {
			var total = 0;
			var selectors = cfg.stickySelectors && cfg.stickySelectors.length
				? cfg.stickySelectors
				: [ '#wpadminbar' ];
			selectors.forEach( function ( sel ) {
				var elm;
				try {
					elm = document.querySelector( sel );
				} catch ( e ) {
					return; // A filtered-in selector that the browser cannot parse.
				}
				if ( ! elm ) {
					return;
				}
				var cs = window.getComputedStyle( elm );
				if ( cs.position !== 'fixed' || cs.display === 'none' ) {
					return;
				}
				var r = elm.getBoundingClientRect();
				if ( r.top > 4 ) {
					return; // Fixed, but not pinned to the top of the viewport.
				}
				total = Math.max( total, r.bottom );
			} );
			return total;
		}

		// Published so CSS can react to the same measurement instead of the page
		// growing a second, independently drifting one.
		function publishOffset( offset ) {
			if ( offset === lastOffset ) {
				return;
			}
			lastOffset = offset;
			document.documentElement.style.setProperty( '--tbtn-offset-top', offset + 'px' );
		}

		function pin( member, elm, box, height ) {
			ensureHost();
			var spacer = el( 'div', member.spacerCls );
			spacer.style.height = height + 'px';
			elm.parentNode.insertBefore( spacer, elm );
			member.mount( elm );
			member.el = elm;
			member.spacer = spacer;
			member.box = box;
		}

		function unpin( member ) {
			if ( member.el ) {
				// Back to where the spacer is holding its place. If the spacer is gone
				// (the view was rebuilt under us), drop the orphan instead.
				if ( member.spacer && member.spacer.parentNode ) {
					member.spacer.parentNode.insertBefore( member.el, member.spacer );
					member.spacer.parentNode.removeChild( member.spacer );
				} else if ( member.el.parentNode ) {
					member.el.parentNode.removeChild( member.el );
				}
			}
			member.el = null;
			member.spacer = null;
			member.box = null;
		}

		function unpinAll() {
			members.forEach( unpin );
			if ( host ) {
				host.style.display = 'none';
			}
		}

		function update() {
			var offset = topOffset();
			publishOffset( offset );

			var appEl = document.getElementById( 'tbt-notes-app' );
			if ( ! appEl ) {
				unpinAll();
				return;
			}

			var appRect = appEl.getBoundingClientRect();
			var stackTop = offset;
			var pinnedAny = false;

			members.forEach( function ( member ) {
				if ( member.el ) {
					// A re-render detaches our spacer (and the owning block). Nothing
					// left to return the element to, so let it go.
					if ( ! member.spacer || ! member.spacer.isConnected ||
						! member.box || ! member.box.isConnected ) {
						unpin( member );
						return;
					}
					var height = member.el.offsetHeight;
					var spacerTop = member.spacer.getBoundingClientRect().top;
					var boxBottom = member.box.getBoundingClientRect().bottom;
					// Stay pinned while the original position is still above the line
					// and the block it belongs to has not scrolled past.
					if ( spacerTop <= stackTop + 1 && boxBottom > stackTop + height ) {
						stackTop += height;
						pinnedAny = true;
						placeMember( member, appRect );
					} else {
						unpin( member );
					}
					return;
				}

				var elm = member.find( appEl );
				if ( ! elm ) {
					return;
				}
				var box = member.owner( elm );
				if ( ! box ) {
					return;
				}
				var h = elm.offsetHeight;
				if ( elm.getBoundingClientRect().top <= stackTop &&
					box.getBoundingClientRect().bottom > stackTop + h ) {
					pin( member, elm, box, h );
					stackTop += h;
					pinnedAny = true;
					placeMember( member, appRect );
				}
			} );

			if ( ! host ) {
				return;
			}
			if ( pinnedAny ) {
				host.style.top = offset + 'px';
				host.style.left = appRect.left + 'px';
				host.style.width = appRect.width + 'px';
				host.style.display = 'block';
			} else {
				host.style.display = 'none';
			}
		}

		/**
		 * The strip spans the workspace, but the toolbar has to keep the width and
		 * inset of the editor column it came from, so its slot is offset inside the
		 * host rather than filling it.
		 */
		function placeMember( member, appRect ) {
			if ( member.name !== 'toolbar' ) {
				return;
			}
			var boxRect = member.box.getBoundingClientRect();
			toolbarSlot.style.marginLeft = ( boxRect.left - appRect.left ) + 'px';
			toolbarSlot.style.width = boxRect.width + 'px';
		}

		window.addEventListener( 'scroll', update, true );
		window.addEventListener( 'resize', update );

		return {
			update: update,
			unpinAll: unpinAll,
		};
	}

	/* --------------------------------------------------------------- Autosave */

	function createSaver( lesson, indicator ) {
		var dirty = {};
		var inFlight = false;
		var timer = null;
		var retry = 0;

		function setStatus( s ) {
			indicator.className = 'tbt-notes-saveind';
			if ( s === 'saving' ) {
				indicator.classList.add( 'is-saving' );
				indicator.textContent = t( 'saving', 'Saving…' );
			} else if ( s === 'saved' ) {
				indicator.classList.add( 'is-saved' );
				indicator.textContent = t( 'saved', 'All changes saved' );
			} else if ( s === 'error' ) {
				indicator.classList.add( 'is-error' );
				indicator.textContent = t( 'saveError', 'Save failed — retrying…' );
			}
		}

		function hasDirty() {
			for ( var k in dirty ) {
				if ( Object.prototype.hasOwnProperty.call( dirty, k ) ) {
					return true;
				}
			}
			return false;
		}

		function run() {
			if ( inFlight || ! hasDirty() ) {
				return;
			}
			var fields = dirty;
			dirty = {};
			inFlight = true;
			setStatus( 'saving' );
			api( 'PATCH', 'lessons/' + lesson.id, fields ).then( function () {
				inFlight = false;
				retry = 0;
				if ( hasDirty() ) {
					schedule( 250 );
				} else {
					setStatus( 'saved' );
				}
			} ).catch( function () {
				for ( var k in fields ) {
					if ( Object.prototype.hasOwnProperty.call( fields, k ) && ! ( k in dirty ) ) {
						dirty[ k ] = fields[ k ];
					}
				}
				inFlight = false;
				retry++;
				setStatus( 'error' );
				var backoff = Math.min( 1000 * Math.pow( 2, retry ), 15000 );
				clearTimeout( timer );
				timer = setTimeout( run, backoff );
			} );
		}

		function schedule( delay ) {
			clearTimeout( timer );
			setStatus( 'saving' );
			timer = setTimeout( run, delay == null ? 700 : delay );
		}

		return {
			queue: function ( fields ) {
				for ( var k in fields ) {
					if ( Object.prototype.hasOwnProperty.call( fields, k ) ) {
						dirty[ k ] = fields[ k ];
					}
				}
				schedule();
			},
			flush: function () {
				clearTimeout( timer );
				run();
			},
			isPending: function () {
				return inFlight || hasDirty();
			},
		};
	}

	function flushActiveSaver() {
		if ( activeSaver && activeSaver.isPending() ) {
			activeSaver.flush();
		}
		activeSaver = null;
	}

	/* ----------------------------------------------------------------- Events */

	if ( isPageMode ) {
		// The workspace is rendered inline and is always "open": mark it open and
		// bootstrap immediately. No launcher, overlay, scroll-lock, Escape handler
		// or focus trap — the browser window scrolls normally.
		root.classList.add( 'is-open' );
		panel.setAttribute( 'aria-hidden', 'false' );
		// Bound before the first render so render() can hand it the new DOM.
		pageSticky = initPageStickyHeader();
		bootstrap();
	} else {
		// The launcher is a plain link to the Page Mode workspace; let the browser
		// handle navigation. Other triggers below still open the in-page overlay.

		document.addEventListener( 'click', function ( e ) {
			if ( ! e.target || ! e.target.closest ) {
				return;
			}
			var trigger = e.target.closest( '[data-tbt-notes-open], .tbt-notes-trigger, a[href$="#tbt-notes"]' );
			if ( ! trigger || trigger.id === 'tbt-notes-launcher' ) {
				return;
			}
			e.preventDefault();
			if ( root.classList.contains( 'is-open' ) ) {
				closePanel();
			} else {
				openPanel( trigger );
			}
		} );

		if ( overlay ) {
			overlay.addEventListener( 'click', closePanel );
		}
	}

	window.addEventListener( 'beforeunload', function () {
		unloading = true;
		if ( activeSaver && activeSaver.isPending() ) {
			activeSaver.flush();
		}
	} );
}() );
