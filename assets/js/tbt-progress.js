/**
 * TBT Notes — live progress panel.
 *
 * Shows one class at a time: who finished a piece of work today, who is
 * working right now, and who has not started. It polls every ten seconds and
 * toasts each completion as it arrives.
 *
 * Two rules shape most of what follows.
 *
 * The first response after choosing a class SEEDS state and toasts nothing.
 * Opening the panel at three in the afternoon must not fire a toast for every
 * completion since breakfast; a toast means "this just happened", so only the
 * incremental polls raise them.
 *
 * Nothing from the server is ever written as markup. Student names and deck
 * titles are other people's text, and they reach the page as text nodes.
 *
 * The panel does not ask which class to watch. Notes announces the open class
 * on a `tbt-notes:class-change` event and the panel follows it, hiding itself
 * and stopping the poll while nothing is open — there is no dropdown and no
 * remembered class. The announcement is a hint about what to watch, never a
 * grant of access: every request re-checks the class server-side.
 *
 * At rest the panel is a bubble: a ring around the completed fraction with the
 * count in the middle. Clicking it opens the full roster.
 */
( function () {
	'use strict';

	var cfg = window.TBTNotesProgress;
	if ( ! cfg || ! cfg.restBase ) {
		return;
	}
	var i18n = cfg.i18n || {};

	var panel = document.getElementById( 'tbtp-panel' );
	var head = document.getElementById( 'tbtp-head' );
	if ( ! panel || ! head ) {
		return;
	}

	var rosterEl = panel.querySelector( '[data-tbtp-roster]' );
	var countEl = panel.querySelector( '[data-tbtp-count]' );
	var toastsEl = document.querySelector( '[data-tbtp-toasts]' );
	var bubbleEl = panel.querySelector( '[data-tbtp-bubble]' );
	var ringEl = panel.querySelector( '[data-tbtp-ring]' );
	var classNameEl = panel.querySelector( '[data-tbtp-classname]' );

	// Matches r="25" on the ring circles in the panel's markup.
	var RING_CIRCUMFERENCE = 2 * Math.PI * 25;

	var STORE_OPEN = 'tbtNotesProgressOpen';
	var TOAST_LIFE = 6000;
	var TOAST_MAX = 3;
	var BASE_INTERVAL = ( parseInt( cfg.pollSeconds, 10 ) || 10 ) * 1000;
	var MAX_INTERVAL = 120000;

	/* State for the class currently on screen. `done` maps a student ID to the
	   title of the last thing they finished today; `presence` is the set of
	   students with a live heartbeat. */
	var classId = 0;
	var students = [];
	var done = {};
	var presence = {};
	var lastId = 0;
	var seeded = false;

	var timer = null;
	var interval = BASE_INTERVAL;
	var inFlight = false;

	/* The counts the bubble was last drawn with. Kept because the head's
	   accessible name depends on both them and whether the panel is collapsed,
	   and the two change independently. */
	var bubbleFinished = 0;
	var bubbleTotal = 0;

	/* --------------------------------------------------------------- Utils */

	function el( tag, cls, text ) {
		var node = document.createElement( tag );
		if ( cls ) {
			node.className = cls;
		}
		if ( undefined !== text && null !== text ) {
			node.textContent = String( text );
		}
		return node;
	}

	function fmt( template, values ) {
		var i = 0;
		return String( template || '' ).replace( /%(\d+\$)?[ds]/g, function ( match, position ) {
			var index = position ? parseInt( position, 10 ) - 1 : i++;
			return undefined === values[ index ] ? match : values[ index ];
		} );
	}

	/* sessionStorage is per-tab and can throw outright in a locked-down
	   browser, so every touch is guarded and a failure simply means the panel
	   forgets between page loads. */
	function remember( key, value ) {
		try {
			window.sessionStorage.setItem( key, String( value ) );
		} catch ( e ) {}
	}

	function recall( key ) {
		try {
			return window.sessionStorage.getItem( key );
		} catch ( e ) {
			return null;
		}
	}

	/* Local midnight, expressed in UTC, which is how the activity table stores
	   time. "Today" is the teacher's day, not the server's: a lesson at nine in
	   the morning in Warsaw must not read as yesterday's work. */
	function startOfTodayUtc() {
		var d = new Date();
		d.setHours( 0, 0, 0, 0 );
		return d.toISOString().slice( 0, 19 ).replace( 'T', ' ' );
	}

	/* --------------------------------------------------------------- Fetch */

	function request( params, onDone ) {
		var url = cfg.restBase + '?' + params.join( '&' );

		fetch( url, {
			method: 'GET',
			credentials: 'same-origin',
			cache: 'no-store',
			headers: {
				'Accept': 'application/json',
				'X-WP-Nonce': cfg.nonce
			}
		} )
			.then( function ( r ) {
				if ( ! r.ok ) {
					throw new Error( 'http' );
				}
				return r.json();
			} )
			.then( function ( data ) {
				interval = BASE_INTERVAL;
				onDone( data );
			} )
			.catch( function () {
				// Back off rather than hammer. A teacher whose wifi drops
				// mid-lesson should not have a tab retrying ten times a minute
				// for the rest of the hour.
				interval = Math.min( MAX_INTERVAL, interval * 2 );
			} )
			.then( function () {
				inFlight = false;
				schedule();
			} );
	}

	function seed() {
		if ( ! classId ) {
			return;
		}
		inFlight = true;
		request(
			[
				'class_id=' + encodeURIComponent( classId ),
				'roster=1',
				'since=' + encodeURIComponent( startOfTodayUtc() )
			],
			function ( data ) {
				var wanted = classId;
				// A response for a class the teacher has since switched away
				// from is stale by the time it lands; dropping it stops one
				// class's roster from painting over another's.
				if ( ! data || parseInt( data.class_id, 10 ) !== wanted ) {
					return;
				}
				students = ( data.students || [] ).slice();
				done = {};
				applyActivity( data.activity || [], false );
				applyPresence( data.presence || [] );
				lastId = parseInt( data.last_id, 10 ) || 0;
				seeded = true;
				render();
			}
		);
	}

	function poll() {
		if ( ! classId || ! seeded || inFlight ) {
			return;
		}
		inFlight = true;
		request(
			[
				'class_id=' + encodeURIComponent( classId ),
				'since=' + encodeURIComponent( lastId )
			],
			function ( data ) {
				if ( ! data || parseInt( data.class_id, 10 ) !== classId ) {
					return;
				}
				applyActivity( data.activity || [], true );
				applyPresence( data.presence || [] );
				var next = parseInt( data.last_id, 10 ) || 0;
				if ( next > lastId ) {
					lastId = next;
				}
				render();
			}
		);
	}

	/* ---------------------------------------------------------- Reductions */

	/* Rows arrive newest first. Walking them in reverse means that when a
	   student finished twice between polls, the newest title is the one that
	   survives, and the toasts appear in the order the work happened. */
	function applyActivity( rows, announce ) {
		var fresh = [];

		for ( var i = rows.length - 1; i >= 0; i-- ) {
			var row = rows[ i ];
			var uid = parseInt( row.user_id, 10 ) || 0;
			if ( ! uid ) {
				continue;
			}

			var record = {
				title: row.object_title || '',
				name: row.student_name || ''
			};
			done[ uid ] = record;

			// Every row is its own event, including a second one from a student
			// already marked done — they finished another deck. The toast
			// carries the row's own title rather than reading it back out of
			// `done`, which by then holds only the newest.
			if ( announce ) {
				fresh.push( record );
			}
		}

		if ( fresh.length ) {
			announceAll( fresh );
		}
	}

	function applyPresence( ids ) {
		presence = {};
		for ( var i = 0; i < ids.length; i++ ) {
			presence[ parseInt( ids[ i ], 10 ) ] = true;
		}
	}

	function stateOf( student ) {
		if ( Object.prototype.hasOwnProperty.call( done, student.user_id ) ) {
			return 'done';
		}
		if ( presence[ student.user_id ] ) {
			return 'working';
		}
		return 'idle';
	}

	/* --------------------------------------------------------------- Render */

	var ORDER = { done: 0, working: 1, idle: 2 };

	function render() {
		rosterEl.textContent = '';

		// With no class open the panel is hidden anyway, so there is nothing to
		// say and no hint to offer — the roster simply empties.
		if ( ! classId ) {
			countEl.textContent = '';
			setBubble( 0, 0 );
			return;
		}

		if ( ! students.length ) {
			rosterEl.appendChild( el( 'p', 'tbtp__empty', i18n.empty || '' ) );
			countEl.textContent = '';
			setBubble( 0, 0 );
			return;
		}

		// The resolver already returned the class alphabetically, so a stable
		// sort on the state alone leaves each group alphabetical inside itself.
		var rows = students.slice();
		rows.sort( function ( a, b ) {
			return ORDER[ stateOf( a ) ] - ORDER[ stateOf( b ) ];
		} );

		var finished = 0;
		for ( var i = 0; i < rows.length; i++ ) {
			var state = stateOf( rows[ i ] );
			if ( 'done' === state ) {
				finished++;
			}
			rosterEl.appendChild( studentRow( rows[ i ], state ) );
		}

		countEl.textContent = fmt( i18n.count, [ finished, rows.length ] );
		setBubble( finished, rows.length );
	}

	/* The collapsed face of the panel: the ring is the completed fraction and
	   the middle is the same count the header carries when open. `stroke-dasharray`
	   is the whole trick — a dash as long as the finished arc followed by a gap
	   as long as the circle leaves exactly that arc painted. */
	function setBubble( finished, total ) {
		bubbleFinished = finished;
		bubbleTotal = total;

		var fraction = total > 0 ? finished / total : 0;
		bubbleEl.textContent = total > 0 ? finished + '/' + total : '';
		ringEl.setAttribute(
			'stroke-dasharray',
			( fraction * RING_CIRCUMFERENCE ).toFixed( 2 ) + ' ' + RING_CIRCUMFERENCE.toFixed( 2 )
		);
		syncHeadLabel();
	}

	/* Collapsed, the ring is all there is to read, so the button is named from
	   the counts. Expanded, its own text — the eyebrow, the class name and the
	   count — is a better name than anything written here, so the attribute is
	   removed rather than left to override it. setCollapsed decides which of
	   the two applies; this only rebuilds the name that follows from it. */
	function syncHeadLabel() {
		if ( panel.classList.contains( 'is-collapsed' ) ) {
			head.setAttribute( 'aria-label', fmt( i18n.ringLabel, [ bubbleFinished, bubbleTotal ] ) );
			return;
		}
		head.removeAttribute( 'aria-label' );
	}

	function studentRow( student, state ) {
		var row = el( 'div', 'tbtp-student is-' + state );

		row.appendChild( el( 'span', 'tbtp-student__dot' ) );

		var name = el( 'span', 'tbtp-student__name', student.display_name || '' );

		// The sub-line is what they finished if they finished something, and
		// otherwise their level when there is one. A level is never invented:
		// an absent one leaves the line out entirely rather than showing a dash.
		if ( 'done' === state && done[ student.user_id ] && done[ student.user_id ].title ) {
			name.appendChild( el( 'span', 'tbtp-student__task', done[ student.user_id ].title ) );
		} else if ( student.level ) {
			name.appendChild( el( 'span', 'tbtp-student__level', student.level ) );
		}
		row.appendChild( name );

		row.appendChild( el( 'span', 'tbtp-student__state', i18n[ state ] || '' ) );
		return row;
	}

	/* --------------------------------------------------------------- Toasts */

	function announceAll( records ) {
		var shown = 0;
		var overflow = 0;
		var visible = toastsEl.querySelectorAll( '.tbtp-toast:not(.tbtp-toast--more)' ).length;

		for ( var i = 0; i < records.length; i++ ) {
			if ( visible + shown >= TOAST_MAX ) {
				overflow++;
				continue;
			}
			toast( records[ i ].name, records[ i ].title );
			shown++;
		}

		// Twelve students finishing together is a training session, not twelve
		// separate pieces of news. Past three, the rest become one line.
		if ( overflow ) {
			more( overflow );
		}
	}

	function toast( name, title ) {
		var node = el( 'div', 'tbtp-toast' );

		node.appendChild( el( 'span', 'tbtp-toast__tick', '✓' ) );

		var text = el( 'span', 'tbtp-toast__text' );
		text.appendChild( el( 'strong', '', name ) );
		text.appendChild( document.createTextNode( ' ' + ( i18n.finished || '' ) ) );
		if ( title ) {
			text.appendChild( el( 'span', 'tbtp-toast__task', title ) );
		}
		node.appendChild( text );

		var close = el( 'button', 'tbtp-toast__x', '×' );
		close.type = 'button';
		close.setAttribute( 'aria-label', i18n.dismiss || 'Dismiss' );
		close.addEventListener( 'click', function () {
			dismiss( node );
		} );
		node.appendChild( close );

		toastsEl.appendChild( node );
		window.setTimeout( function () {
			dismiss( node );
		}, TOAST_LIFE );
	}

	function more( count ) {
		var existing = toastsEl.querySelector( '.tbtp-toast--more' );
		if ( existing ) {
			existing.dataset.tbtpCount = String( ( parseInt( existing.dataset.tbtpCount, 10 ) || 0 ) + count );
			existing.textContent = fmt( i18n.andMore, [ existing.dataset.tbtpCount ] );
			return;
		}

		var node = el( 'div', 'tbtp-toast tbtp-toast--more', fmt( i18n.andMore, [ count ] ) );
		node.dataset.tbtpCount = String( count );
		toastsEl.appendChild( node );
		window.setTimeout( function () {
			dismiss( node );
		}, TOAST_LIFE );
	}

	function dismiss( node ) {
		if ( ! node.parentNode ) {
			return;
		}
		node.classList.add( 'is-out' );
		window.setTimeout( function () {
			if ( node.parentNode ) {
				node.parentNode.removeChild( node );
			}
		}, 240 );
	}

	/* -------------------------------------------------------------- Polling */

	function schedule() {
		stop();
		if ( ! classId || document.hidden ) {
			return;
		}
		timer = window.setTimeout( function () {
			timer = null;
			poll();
		}, interval );
	}

	function stop() {
		if ( timer ) {
			window.clearTimeout( timer );
			timer = null;
		}
	}

	document.addEventListener( 'visibilitychange', function () {
		if ( document.hidden ) {
			stop();
			return;
		}
		// Back from another tab: catch up at once rather than waiting out the
		// interval, then resume the normal cadence.
		interval = BASE_INTERVAL;
		if ( classId && seeded && ! inFlight ) {
			poll();
		} else {
			schedule();
		}
	} );

	/* --------------------------------------------------------------- Wiring */

	function choose( id, title ) {
		classId = parseInt( id, 10 ) || 0;
		students = [];
		done = {};
		presence = {};
		lastId = 0;
		seeded = false;
		interval = BASE_INTERVAL;
		stop();

		// A class change is a change of subject: toasts about the previous
		// class would be answering a question nobody is asking any more.
		if ( toastsEl ) {
			toastsEl.textContent = '';
		}

		classNameEl.textContent = title || '';
		panel.hidden = ! classId;
		render();

		if ( classId ) {
			seed();
		}
	}

	function setCollapsed( collapsed ) {
		panel.classList.toggle( 'is-collapsed', collapsed );
		head.setAttribute( 'aria-expanded', String( ! collapsed ) );
		syncHeadLabel();
		remember( STORE_OPEN, collapsed ? '0' : '1' );
	}

	head.addEventListener( 'click', function () {
		setCollapsed( ! panel.classList.contains( 'is-collapsed' ) );
	} );

	document.addEventListener( 'tbt-notes:class-change', function ( e ) {
		var detail = e.detail || {};
		var id = parseInt( detail.id, 10 ) || 0;
		// Same class, new name: relabel and leave the roster alone. Renaming a
		// class mid-lesson is not a change of subject, and running it through
		// choose() would wipe the completions already on screen.
		if ( id && id === classId ) {
			classNameEl.textContent = detail.title || '';
			return;
		}
		choose( id, detail.title );
	} );

	// Collapsed unless the teacher last left it open. The panel itself stays
	// hidden until Notes says a class is open, so nothing appears on a page
	// where there is nothing to watch.
	setCollapsed( '1' !== recall( STORE_OPEN ) );
	render();
} )();
