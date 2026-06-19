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
		if ( opener ) {
			lastOpener = opener;
		}
		root.classList.add( 'is-open' );
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
		flushActiveSaver();
		root.classList.remove( 'is-open' );
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
		inner.appendChild( iconButton( '✕', t( 'close', 'Close' ), closePanel ) );
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
		content.appendChild( buildTopbar( { title: t( 'headerClasses', 'CLASSES' ) } ) );
		var body = el( 'div', 'tbt-notes-body' );

		var newBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--block', t( 'newClass', 'New class' ) );
		newBtn.type = 'button';
		newBtn.addEventListener( 'click', createClassFlow );
		var row = el( 'div', 'tbt-notes-toolbar-row' );
		row.appendChild( newBtn );
		body.appendChild( row );

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

		var list = el( 'ul', 'tbt-notes-list' );
		body.appendChild( list );

		function renderList( term ) {
			clear( list );
			var q = ( term || '' ).trim().toLowerCase();
			var matches = state.classes.filter( function ( cls ) {
				return ! q || ( cls.title || '' ).toLowerCase().indexOf( q ) !== -1;
			} );
			if ( ! matches.length ) {
				var li = el( 'li' );
				li.appendChild( el( 'div', 'tbt-notes-empty', t( 'noResults', 'No matches' ) ) );
				list.appendChild( li );
				return;
			}
			matches.forEach( function ( cls ) {
				list.appendChild( classListItem( cls ) );
			} );
		}

		search.addEventListener( 'input', function () {
			renderList( search.value );
		} );
		renderList( '' );

		content.appendChild( body );
	}

	function classListItem( cls ) {
		var li = el( 'li', 'tbt-notes-listitem' );
		var main = el( 'button', 'tbt-notes-listitem__main' );
		main.type = 'button';
		main.appendChild( el( 'span', 'tbt-notes-listitem__title', cls.title || t( 'untitledClass', 'Untitled class' ) ) );
		var count = cls.student_count != null ? cls.student_count : ( cls.students ? cls.students.length : 0 );
		var meta = count === 1 ? t( 'oneStudent', '1 student' ) : ( '' + count + ' ' + t( 'nStudents', 'students' ) );
		main.appendChild( el( 'span', 'tbt-notes-listitem__meta', meta ) );
		main.addEventListener( 'click', function () {
			openClass( cls );
		} );
		li.appendChild( main );
		li.appendChild( iconDelete( t( 'deleteClass', 'Delete class' ), function () {
			deleteClassFlow( cls );
		} ) );
		return li;
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
			subtitle: !isTeacher && state.currentLesson ? state.currentLesson.header : null,
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
		main.appendChild( el( 'span', 'tbt-notes-listitem__title', lesson.header || t( 'untitledLesson', 'Untitled lesson' ) ) );
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

	function createLessonFlow() {
		api( 'POST', 'classes/' + state.currentClass.id + '/lessons', { header: '', body: '' } ).then( function ( data ) {
			state.lessons.unshift( data.lesson );
			state.currentLesson = data.lesson;
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

		quill.on( 'text-change', function ( delta, old, source ) {
			if ( source !== 'user' ) {
				return;
			}
			var html = quill.getSemanticHTML();
			lesson.body = html;
			saver.queue( { body: html } );
		} );

		headerInput.addEventListener( 'input', function () {
			lesson.header = headerInput.value;
			saver.queue( { header: headerInput.value } );
			// Reflect the header in the sidebar nav item live.
			var navTitle = content.querySelector( '.tbt-notes-listitem__main.is-active .tbt-notes-listitem__title' );
			if ( navTitle ) {
				navTitle.textContent = headerInput.value || t( 'untitledLesson', 'Untitled lesson' );
			}
		} );

		window.setTimeout( function () {
			if ( ! lesson.header ) {
				headerInput.focus();
			} else {
				quill.focus();
			}
		}, 60 );
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

	window.addEventListener( 'beforeunload', function () {
		unloading = true;
		if ( activeSaver && activeSaver.isPending() ) {
			activeSaver.flush();
		}
	} );
}() );
