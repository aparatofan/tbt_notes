/**
 * TBT Notes — front-end application.
 *
 * A single role-aware slide-out panel. Students get a read-only view of their
 * one class (lesson list newest-first, then a formatted read view). The teacher
 * gets inline management: classes, student assignment, lessons, and a Quill
 * editor with autosave. All authority is enforced server-side; this script just
 * reflects what the REST API allows.
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
	// The launcher tab is optional (it can be opened from a shortcode/menu
	// instead), so only the panel itself is required.
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
		students: null,
		view: 'root',
		currentClass: null,
		lessons: [],
		loadingLessons: false,
		currentLesson: null,
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

	/**
	 * REST helper. Sends the cookie nonce; throws on non-2xx with a message.
	 */
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
					err.data = data;
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
		overlay.hidden = false;
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
		overlay.hidden = true;
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
		inner.appendChild( el( 'h2', 'tbt-notes-topbar__title', opts.title || '' ) );
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
			content.appendChild( buildTopbar( { title: t( 'panelTitle', 'Notes' ) } ) );
			content.appendChild( el( 'div', 'tbt-notes-loading', t( 'loading', 'Loading…' ) ) );
			return;
		}

		if ( state.error ) {
			content.appendChild( buildTopbar( { title: t( 'panelTitle', 'Notes' ) } ) );
			var b = el( 'div', 'tbt-notes-body' );
			b.appendChild( errorBlock( state.error ) );
			content.appendChild( b );
			return;
		}

		if ( state.isTeacher ) {
			if ( state.view === 'classList' ) {
				renderClassList( true );
			} else if ( state.view === 'classSettings' ) {
				renderClassSettings();
			} else if ( state.view === 'lessonEdit' ) {
				renderLessonEdit();
			} else {
				renderTeacherRoot();
			}
		} else if ( state.view === 'lessonRead' ) {
			renderLessonRead();
		} else if ( state.view === 'classList' ) {
			renderClassList( false );
		} else {
			renderStudentEmpty();
		}
	}

	/* ------------------------------------------------------------ Student views */

	function renderStudentEmpty() {
		content.appendChild( buildTopbar( { title: t( 'panelTitle', 'Notes' ) } ) );
		var body = el( 'div', 'tbt-notes-body' );
		body.appendChild( emptyBlock( t( 'noClassStudent', 'You have no notes assigned yet.' ) ) );
		content.appendChild( body );
	}

	/* ------------------------------------------------------------- Teacher root */

	function renderTeacherRoot() {
		content.appendChild( buildTopbar( { title: t( 'panelTitle', 'Notes' ) } ) );
		var body = el( 'div', 'tbt-notes-body' );

		var newBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--block', t( 'newClass', 'New class' ) );
		newBtn.type = 'button';
		newBtn.addEventListener( 'click', createClassFlow );
		var row = el( 'div', 'tbt-notes-toolbar-row' );
		row.appendChild( newBtn );
		body.appendChild( row );

		if ( ! state.classes.length ) {
			body.appendChild( emptyBlock( t( 'noClassesTeacher', 'No classes yet.' ) ) );
		} else {
			var list = el( 'ul', 'tbt-notes-list' );
			state.classes.forEach( function ( cls ) {
				list.appendChild( classListItem( cls ) );
			} );
			body.appendChild( list );
		}
		content.appendChild( body );
	}

	function classListItem( cls ) {
		var li = el( 'li', 'tbt-notes-listitem' );
		var main = el( 'button', 'tbt-notes-listitem__main' );
		main.type = 'button';
		main.appendChild( el( 'span', 'tbt-notes-listitem__title', cls.title || t( 'untitledClass', 'Untitled class' ) ) );
		var meta = cls.student_name ? ( t( 'assignedStudent', 'Assigned student' ) + ': ' + cls.student_name ) : t( 'unassigned', '— Not assigned —' );
		main.appendChild( el( 'span', 'tbt-notes-listitem__meta', meta ) );
		main.addEventListener( 'click', function () {
			openClass( cls );
		} );
		li.appendChild( main );

		var del = iconDelete( t( 'deleteClass', 'Delete class' ), function () {
			deleteClassFlow( cls );
		} );
		li.appendChild( del );
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

	/* ----------------------------------------------------------- Class lessons */

	function openClass( cls ) {
		state.currentClass = cls;
		state.lessons = [];
		state.view = 'classList';
		state.loadingLessons = true;
		render();
		api( 'GET', 'classes/' + cls.id + '/lessons' ).then( function ( data ) {
			state.lessons = data.lessons || [];
			state.loadingLessons = false;
			render();
		} ).catch( function ( err ) {
			state.loadingLessons = false;
			state.error = err.message;
			render();
		} );
	}

	function renderClassList( isTeacher ) {
		var cls = state.currentClass;
		var onBack = isTeacher ? function () {
			state.view = 'root';
			state.currentClass = null;
			state.lessons = [];
			render();
		} : null;

		content.appendChild( buildTopbar( { title: cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '', onBack: onBack } ) );
		var body = el( 'div', 'tbt-notes-body' );

		if ( isTeacher ) {
			var row = el( 'div', 'tbt-notes-toolbar-row' );
			var settingsBtn = el( 'button', 'tbt-notes-btn tbt-notes-btn--ghost', t( 'manageClass', 'Class settings' ) );
			settingsBtn.type = 'button';
			settingsBtn.addEventListener( 'click', function () {
				state.settingsIsNew = false;
				state.view = 'classSettings';
				render();
			} );
			var newLesson = el( 'button', 'tbt-notes-btn', t( 'newLesson', 'New lesson' ) );
			newLesson.type = 'button';
			newLesson.addEventListener( 'click', createLessonFlow );
			row.appendChild( settingsBtn );
			row.appendChild( newLesson );
			body.appendChild( row );
		}

		if ( state.loadingLessons ) {
			body.appendChild( el( 'div', 'tbt-notes-loading', t( 'loading', 'Loading…' ) ) );
		} else if ( ! state.lessons.length ) {
			body.appendChild( emptyBlock( t( 'noLessons', 'No lessons yet.' ) ) );
		} else {
			var list = el( 'ul', 'tbt-notes-list' );
			state.lessons.forEach( function ( lesson ) {
				list.appendChild( lessonListItem( lesson, isTeacher ) );
			} );
			body.appendChild( list );
		}
		content.appendChild( body );
	}

	function lessonListItem( lesson, isTeacher ) {
		var li = el( 'li', 'tbt-notes-listitem' );
		var main = el( 'button', 'tbt-notes-listitem__main' );
		main.type = 'button';
		main.appendChild( el( 'span', 'tbt-notes-listitem__title', lesson.header || t( 'untitledLesson', 'Untitled lesson' ) ) );
		main.appendChild( el( 'span', 'tbt-notes-listitem__meta', fmtDate( lesson.created_at ) ) );
		main.addEventListener( 'click', function () {
			if ( isTeacher ) {
				openLessonEdit( lesson );
			} else {
				openLessonRead( lesson );
			}
		} );
		li.appendChild( main );

		if ( isTeacher ) {
			li.appendChild( iconDelete( t( 'deleteLesson', 'Delete lesson' ), function () {
				deleteLessonFlow( lesson );
			} ) );
		}
		return li;
	}

	/* -------------------------------------------------------------- Read lesson */

	function openLessonRead( lesson ) {
		state.currentLesson = lesson;
		state.view = 'lessonRead';
		render();
	}

	function renderLessonRead() {
		var cls = state.currentClass;
		var lesson = state.currentLesson;
		content.appendChild( buildTopbar( {
			title: cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '',
			onBack: function () {
				state.view = 'classList';
				state.currentLesson = null;
				render();
			},
		} ) );

		var body = el( 'div', 'tbt-notes-body' );
		if ( lesson.header ) {
			body.appendChild( el( 'div', 'tbt-notes-read-header', lesson.header ) );
		}
		var read = el( 'div', 'tbt-notes-read' );
		// Body is server-sanitised semantic HTML (kses allowlist, safe links).
		read.innerHTML = lesson.body || '';
		body.appendChild( read );
		content.appendChild( body );
	}

	/* ---------------------------------------------------------- Class settings */

	function renderClassSettings() {
		var cls = state.currentClass;
		content.appendChild( buildTopbar( {
			title: t( 'manageClass', 'Class settings' ),
			onBack: function () {
				state.view = 'classList';
				render();
			},
		} ) );

		var body = el( 'div', 'tbt-notes-body' );

		// Title field.
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

		// Student field — username search (no giant dropdown).
		var studentField = el( 'div', 'tbt-notes-field' );
		studentField.appendChild( el( 'label', 'tbt-notes-field__label', t( 'assignedStudent', 'Assigned student' ) ) );
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

		if ( state.settingsIsNew ) {
			state.settingsIsNew = false;
			window.setTimeout( function () {
				titleInput.focus();
			}, 60 );
		}
	}

	/**
	 * Username-search picker for assigning a student to a class. Replaces the
	 * unwieldy full dropdown: type a username, pick a match.
	 */
	function buildStudentPicker( container, cls ) {
		var chipHolder = el( 'div' );
		var msg = el( 'div' );
		var input = el( 'input', 'tbt-notes-input' );
		input.type = 'text';
		input.placeholder = t( 'searchStudents', 'Search by username…' );
		input.setAttribute( 'autocomplete', 'off' );
		var results = el( 'ul', 'tbt-notes-userresults' );
		results.hidden = true;
		var hint = el( 'p', 'tbt-notes-hint', t( 'searchHint', 'Type a username to find a student.' ) );

		function renderChip() {
			clear( chipHolder );
			if ( cls.student_id ) {
				var chip = el( 'div', 'tbt-notes-chip' );
				chip.appendChild( el( 'span', 'tbt-notes-chip__name', cls.student_name || ( '#' + cls.student_id ) ) );
				var rm = el( 'button', 'tbt-notes-chip__remove' );
				rm.type = 'button';
				rm.textContent = '✕';
				rm.setAttribute( 'aria-label', t( 'unassign', 'Remove student' ) );
				rm.addEventListener( 'click', function () {
					assign( 0, '' );
				} );
				chip.appendChild( rm );
				chipHolder.appendChild( chip );
			}
		}

		function assign( id, name ) {
			clear( msg );
			saveClassField( cls, { student_id: id } ).then( function ( data ) {
				var updated = data && data.class ? data.class : null;
				cls.student_id = updated ? updated.student_id : ( id || null );
				cls.student_name = updated ? ( updated.student_name || '' ) : ( id ? name : '' );
				state.students = null;
				input.value = '';
				results.hidden = true;
				clear( results );
				renderChip();
			} ).catch( function ( err ) {
				msg.appendChild( errorBlock( err.message ) );
			} );
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
				var sub = s.username && s.username !== s.name ? ( '@' + s.username ) : '';
				if ( s.assigned_class_id && s.assigned_class_id !== cls.id ) {
					b.disabled = true;
					sub = ( sub ? sub + ' · ' : '' ) + t( 'alreadyIn', 'already assigned: ' ) + ( s.assigned_class_name || '' );
				}
				if ( sub ) {
					b.appendChild( document.createElement( 'br' ) );
					b.appendChild( el( 'span', 'tbt-notes-userresult__sub', sub ) );
				}
				if ( ! b.disabled ) {
					b.addEventListener( 'click', function () {
						assign( s.id, s.name || s.username );
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

		container.appendChild( chipHolder );
		container.appendChild( input );
		container.appendChild( results );
		container.appendChild( hint );
		container.appendChild( msg );
		renderChip();
	}

	function saveClassField( cls, fields ) {
		return api( 'PATCH', 'classes/' + cls.id, fields ).then( function ( data ) {
			if ( data && data.class ) {
				updateClassInState( data.class );
				state.currentClass = data.class;
			}
			return data;
		} );
	}

	function updateClassInState( updated ) {
		for ( var i = 0; i < state.classes.length; i++ ) {
			if ( state.classes[ i ].id === updated.id ) {
				state.classes[ i ] = updated;
				return;
			}
		}
	}

	/* ----------------------------------------------------------------- Flows */

	function createClassFlow() {
		api( 'POST', 'classes', { title: '', student_id: 0 } ).then( function ( data ) {
			state.classes.unshift( data.class );
			state.currentClass = data.class;
			state.lessons = [];
			state.settingsIsNew = true;
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
			state.students = null;
			state.view = 'root';
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	function createLessonFlow() {
		api( 'POST', 'classes/' + state.currentClass.id + '/lessons', { header: '', body: '' } ).then( function ( data ) {
			state.lessons.unshift( data.lesson );
			openLessonEdit( data.lesson );
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
			render();
		} ).catch( function ( err ) {
			window.alert( err.message );
		} );
	}

	/* --------------------------------------------------------------- Editor */

	function openLessonEdit( lesson ) {
		state.currentLesson = lesson;
		state.view = 'lessonEdit';
		render();
	}

	function renderLessonEdit() {
		var cls = state.currentClass;
		var lesson = state.currentLesson;

		content.appendChild( buildTopbar( {
			title: cls ? ( cls.title || t( 'untitledClass', 'Untitled class' ) ) : '',
			onBack: function () {
				flushActiveSaver();
				state.view = 'classList';
				state.currentLesson = null;
				render();
			},
		} ) );

		var body = el( 'div', 'tbt-notes-body tbt-notes-body--editor' );

		// Header field.
		var headerWrap = el( 'div', 'tbt-notes-editor-header' );
		var headerInput = el( 'input', 'tbt-notes-input' );
		headerInput.type = 'text';
		headerInput.value = lesson.header || '';
		headerInput.placeholder = t( 'lessonHeaderPh', '' );
		headerInput.setAttribute( 'aria-label', t( 'lessonHeader', 'Lesson header' ) );
		headerWrap.appendChild( headerInput );
		body.appendChild( headerWrap );

		// Quill wrapper: toolbar + editor.
		var quillWrap = el( 'div', 'tbt-notes-editor-quillwrap' );
		var toolbar = buildToolbar();
		var editorEl = el( 'div' );
		quillWrap.appendChild( toolbar );
		quillWrap.appendChild( editorEl );
		body.appendChild( quillWrap );

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
		body.appendChild( footer );

		content.appendChild( body );

		// Initialise editor + autosave once mounted.
		initEditor( editorEl, toolbar, headerInput, lesson, indicator );
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

		var g1 = group();
		g1.appendChild( qbtn( 'ql-bold', null, t( 'bold', 'Bold' ) ) );
		g1.appendChild( qbtn( 'ql-italic', null, t( 'italic', 'Italic' ) ) );
		bar.appendChild( g1 );

		// Highlight swatches (custom; wired after Quill init).
		var gh = group();
		gh.className = 'ql-formats tbt-hl-group';
		( cfg.highlightColors || [] ).forEach( function ( c ) {
			var b = el( 'button', 'tbt-hl-btn' );
			b.type = 'button';
			b.setAttribute( 'data-color', c.key );
			b.setAttribute( 'aria-label', t( 'highlight', 'Highlight' ) + ': ' + c.label );
			b.title = t( 'highlight', 'Highlight' ) + ': ' + c.label;
			gh.appendChild( b );
		} );
		var clearBtn = el( 'button', 'tbt-hl-clear' );
		clearBtn.type = 'button';
		clearBtn.textContent = '✕';
		clearBtn.setAttribute( 'data-color', '' );
		clearBtn.setAttribute( 'aria-label', t( 'removeHighlight', 'No highlight' ) );
		clearBtn.title = t( 'removeHighlight', 'No highlight' );
		gh.appendChild( clearBtn );
		bar.appendChild( gh );

		var g2 = group();
		g2.appendChild( qbtn( 'ql-link', null, t( 'link', 'Link' ) ) );
		bar.appendChild( g2 );

		var g3 = group();
		g3.appendChild( qbtn( 'ql-list', 'ordered', t( 'orderedList', 'Numbered list' ) ) );
		g3.appendChild( qbtn( 'ql-list', 'bullet', t( 'bulletList', 'Bulleted list' ) ) );
		g3.appendChild( qbtn( 'ql-indent', '-1', t( 'outdent', 'Decrease indent' ) ) );
		g3.appendChild( qbtn( 'ql-indent', '+1', t( 'indent', 'Increase indent' ) ) );
		bar.appendChild( g3 );

		var g4 = group();
		g4.appendChild( qbtn( 'ql-header', '2', t( 'heading', 'Heading' ) ) );
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

	function initEditor( editorEl, toolbar, headerInput, lesson, indicator ) {
		if ( typeof window.Quill === 'undefined' ) {
			editorEl.appendChild( errorBlock( t( 'genericError', 'Editor failed to load.' ) ) );
			return;
		}
		registerHighlightFormat();

		var quill = new window.Quill( editorEl, {
			theme: 'snow',
			modules: { toolbar: toolbar },
			formats: [ 'bold', 'italic', 'link', 'list', 'indent', 'header', 'highlight' ],
		} );

		// Load existing content without triggering autosave.
		if ( lesson.body && lesson.body.trim() ) {
			quill.clipboard.dangerouslyPasteHTML( 0, lesson.body, 'silent' );
		}

		var saver = createSaver( lesson, indicator );
		activeSaver = saver;

		// Track the last real selection so the highlight buttons can apply to it
		// even after focus moves to the toolbar button.
		var lastRange = null;
		quill.on( 'selection-change', function ( range ) {
			if ( range ) {
				lastRange = range;
			}
		} );

		// Wire highlight swatches. Applying with formatText on explicit indices
		// is reliable regardless of focus/selection timing.
		var swatches = toolbar.querySelectorAll( '.tbt-hl-btn, .tbt-hl-clear' );
		Array.prototype.forEach.call( swatches, function ( btn ) {
			btn.addEventListener( 'mousedown', function ( e ) {
				e.preventDefault();
			} );
			btn.addEventListener( 'click', function () {
				var color = btn.getAttribute( 'data-color' );
				var range = quill.getSelection() || lastRange;
				if ( ! range ) {
					quill.focus();
					range = quill.getSelection();
				}
				if ( ! range ) {
					return;
				}
				if ( range.length > 0 ) {
					var value = color ? color : false;
					if ( color ) {
						var fmt = quill.getFormat( range.index, range.length );
						if ( fmt.highlight === color ) {
							value = false; // Toggle off if the whole range already has it.
						}
					}
					quill.formatText( range.index, range.length, 'highlight', value, 'user' );
					quill.setSelection( range.index, range.length, 'silent' );
				} else {
					// Collapsed cursor: highlight the next typed text.
					quill.format( 'highlight', color ? color : false, 'user' );
				}
			} );
		} );

		// Autosave body on user edits.
		quill.on( 'text-change', function ( delta, old, source ) {
			if ( source !== 'user' ) {
				return;
			}
			var html = quill.getSemanticHTML();
			lesson.body = html;
			saver.queue( { body: html } );
		} );

		// Autosave header.
		headerInput.addEventListener( 'input', function () {
			lesson.header = headerInput.value;
			saver.queue( { header: headerInput.value } );
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
				// Requeue what we tried to send (without clobbering newer edits).
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

	// Open from anywhere: a shortcode button, a menu item linking to #tbt-notes,
	// or any element carrying the tbt-notes-trigger class / data-tbt-notes-open.
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

	overlay.addEventListener( 'click', closePanel );

	window.addEventListener( 'beforeunload', function () {
		unloading = true;
		if ( activeSaver && activeSaver.isPending() ) {
			activeSaver.flush();
		}
	} );
}() );
