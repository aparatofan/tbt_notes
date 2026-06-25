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
		classes: [],
		view: 'root',
		currentClass: null,
		lessons: [],
		loadingLessons: false,
		currentLesson: null,
		sidebarFolded: false,
		highlightFilter: 'full',
		error: '',
	};

	var activeSaver = null;
	var unloading = false;

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
	 * The default title generated for a brand-new note. At creation there is no
	 * lesson title yet, so this is the dated fallback form. The teacher can edit it.
	 *
	 * @return {string}
	 */
	function defaultNoteTitle() {
		return t( 'lessonNotesTitle', 'Lesson Notes' ) + ' — ' + formatLongDate( new Date() );
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

	// Deterministic branded gradients for class-card headers, built from the
	// official TBT colours. The same class always maps to the same gradient.
	var classGradients = [
		'linear-gradient(135deg, #0859C6, #663366)',
		'linear-gradient(135deg, #008080, #0859C6)',
		'linear-gradient(135deg, #660000, #CC9933)',
		'linear-gradient(135deg, #006600, #008080)',
		'linear-gradient(135deg, #663366, #660000)',
		'linear-gradient(135deg, #CC9933, #0859C6)',
	];

	function getGradientForClass( cls ) {
		var source = '' + ( ( cls && cls.id ) || ( cls && cls.title ) || '' );
		var hash = 0;
		for ( var i = 0; i < source.length; i++ ) {
			hash += source.charCodeAt( i );
		}
		return classGradients[ hash % classGradients.length ];
	}

	var TBT_LOGO_URL = 'https://thebluetree.pl/wp-content/uploads/2020/12/TBT-white-logo.png';

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

	function iconButton( symbol, label, onClick ) {
		var b = el( 'button', 'tbt-notes-iconbtn' );
		b.type = 'button';
		b.setAttribute( 'aria-label', label );
		b.title = label;
		b.textContent = symbol;
		b.addEventListener( 'click', onClick );
		return b;
	}

	function buildTopbar( opts ) {
		var bar = el( 'div', 'tbt-notes-topbar' );
		var inner = el( 'div', 'tbt-notes-topbar__inner' );
		
		if ( opts.onBack ) {
			inner.appendChild( iconButton( '‹', t( 'back', 'Back' ), opts.onBack ) );
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
			inner.appendChild( iconButton( btn.symbol, btn.label, btn.onClick ) );
		} );
		// Page mode has no overlay to dismiss, so omit the close button (the back
		// button for class → classes navigation is added separately and stays).
		if ( ! isPageMode ) {
			inner.appendChild( iconButton( '✕', t( 'close', 'Close' ), closePanel ) );
		}
		bar.appendChild( inner );
		
		return bar;
	}

	function emptyBlock( msg ) {
		return el( 'div', 'tbt-notes-empty', msg );
	}

	function errorBlock( msg ) {
		return el( 'div', 'tbt-notes-inlinemsg tbt-notes-inlinemsg--error', msg );
	}

	/* --------------------------------------------------------------- Render root */

	function render() {
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
		var newBtn = el( 'button', 'tbt-notes-btn tbt-notes-newclass-btn', '+ ' + t( 'newClass', 'New class' ) );
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
		var search = el( 'input', 'tbt-notes-input tbt-notes-classsearch' );
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
				grid.appendChild( el( 'div', 'tbt-notes-empty', t( 'noResults', 'No matches' ) ) );
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
		var del = el( 'button', 'tbt-notes-classcard__delete' );
		del.type = 'button';
		del.textContent = '🗑';
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
		var b = el( 'button', 'tbt-notes-listitem__delete' );
		b.type = 'button';
		b.setAttribute( 'aria-label', label );
		b.title = label;
		b.textContent = '🗑';
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

	/* ------------------------------------------------------- Master/detail view */

	function renderClassView( isTeacher ) {
		var cls = state.currentClass;

		var buttons = [
			{ symbol: '☰', label: t( 'toggleLessons', 'Show/hide lessons' ), onClick: toggleSidebar },
			{ symbol: '⎙', label: t( 'print', 'Print' ), onClick: function () {
				window.print();
			} },
		];
		if ( isTeacher ) {
			buttons.push( { symbol: '⚙', label: t( 'manageClass', 'Class settings' ), onClick: function () {
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
			var addLesson = el( 'button', 'tbt-notes-btn', t( 'newLessonShort', '+ NEW' ) );
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
			var prompt = el( 'div', 'tbt-notes-empty' );
			prompt.appendChild( el( 'p', null, t( 'noLessons', 'No lessons yet.' ) ) );
			var first = el( 'button', 'tbt-notes-btn', t( 'newLesson', 'New lesson' ) );
			first.type = 'button';
			first.addEventListener( 'click', createLessonFlow );
			prompt.appendChild( first );
			detail.appendChild( prompt );
		} else {
			detail.appendChild( emptyBlock( t( 'noLessons', 'No lessons yet.' ) ) );
		}
		split.appendChild( detail );

		content.appendChild( split );
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
	 * Play button (audio exists) or, for teachers only, a Generate audio button.
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
		} else if ( isTeacher ) {
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
	 * Regenerate). Student: a static, read-only approved card.
	 */
	function expressionCardItem( lesson, item, isTeacher ) {
		var li = el( 'li', 'tbt-expression-item' );

		// ---- Student: static approved card only. ----
		if ( ! isTeacher ) {
			li.appendChild( el( 'div', 'tbt-expression-text tbt-hl-blue', item.text ) );
			var card = el( 'div', 'tbt-expression-card' );
			var pRow = el( 'div', 'tbt-expression-readrow' );
			pRow.appendChild( el( 'strong', null, t( 'polishLabel', 'Polish' ) + ': ' ) );
			pRow.appendChild( document.createTextNode( item.polish_translation || '' ) );
			card.appendChild( pRow );
			var eRow = el( 'div', 'tbt-expression-readrow' );
			eRow.appendChild( el( 'strong', null, t( 'exampleLabel', 'Example' ) + ': ' ) );
			eRow.appendChild( document.createTextNode( item.example_sentence || '' ) );
			card.appendChild( eRow );
			li.appendChild( card );
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
		}

		paint( item );
		return li;
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
		// New notes start with a generated default title and the default lesson
		// template pre-inserted. Both become normal editable content immediately.
		api( 'POST', 'classes/' + state.currentClass.id + '/lessons', {
			header: defaultNoteTitle(),
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

		// 3. Link.
		var g2 = group();
		g2.appendChild( qbtn( 'ql-link', null, t( 'link', 'Link' ) ) );
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

	/* ----------------------------------------------------------- AI Quick Note */

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
			responseText.textContent = answer;
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
			// insertText preserves the answer's line breaks (\n -> new lines) and is
			// flagged 'user' so autosave picks it up.
			quill.insertText( at, answer, 'user' );
			quill.setSelection( at + answer.length, 0, 'silent' );
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
		bootstrap();
	} else {
		if ( launcher ) {
			launcher.addEventListener( 'click', function () {
				if ( root.classList.contains( 'is-open' ) ) {
					closePanel();
				} else {
					openPanel( launcher );
				}
			} );
		}

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
