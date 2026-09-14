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
 * At rest the panel is its own header: the class name on the left and the
 * day's tally on the right, with the list folded away underneath. Clicking it
 * opens the roster and takes the tally with it, because the list then says the
 * same thing in more detail.
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
	var classNameEl = panel.querySelector( '[data-tbtp-classname]' );

	var STORE_OPEN = 'tbtNotesProgressOpen';
	var TOAST_LIFE = 6000;
	var TOAST_MAX = 3;
	var BASE_INTERVAL = ( parseInt( cfg.pollSeconds, 10 ) || 10 ) * 1000;
	var MAX_INTERVAL = 120000;

	/* The site's UTC offset in milliseconds, or null when the page carried none.
	   Localized values arrive as strings, so a site on UTC ("0") has to stay
	   distinguishable from a missing one. */
	var SITE_OFFSET = isNaN( parseInt( cfg.tzOffset, 10 ) ) ? null : parseInt( cfg.tzOffset, 10 ) * 1000;

	/* State for the class currently on screen. `done` maps a student ID to the
	   title of the last thing they finished today; `presence` is the set of
	   students with a live heartbeat. */
	var classId = 0;
	var students = [];
	var done = {};
	var presence = {};
	var lastId = 0;
	var seeded = false;

	/* Bumped every time a completion is recorded, and stamped on the record.
	   It is what lets the finished group sort newest-first, so a completion
	   arriving mid-lesson lands at the top of the list rather than wherever
	   the student's name happens to fall in the alphabet. */
	var doneSeq = 0;

	/* Tasks finished by this class today, counted by the server. Not derived
	   from `done`, which holds one record per student and would read 1 for a
	   student who finished four things. */
	var completedToday = 0;

	var timer = null;
	var interval = BASE_INTERVAL;
	var inFlight = false;

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
	   time. "Today" is the site's day, not the server's and not the laptop's: a
	   lesson at nine in the morning in Warsaw must not read as yesterday's work,
	   and the count beside this roster is taken from site-local midnight
	   server-side, so a seed asking from the browser's own midnight would
	   contradict it for a teacher working from another timezone. Without an
	   offset to work from, the browser's midnight is the best guess left. */
	function startOfTodayUtc() {
		var d = new Date();

		if ( null === SITE_OFFSET ) {
			d.setHours( 0, 0, 0, 0 );
		} else {
			// Shifted into site time, midnight is taken with the UTC getters and
			// shifted back, so the browser's own zone never enters the arithmetic.
			d = new Date( d.getTime() + SITE_OFFSET );
			d.setUTCHours( 0, 0, 0, 0 );
			d = new Date( d.getTime() - SITE_OFFSET );
		}

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
				completedToday = parseInt( data.completed_today, 10 ) || 0;
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
				completedToday = parseInt( data.completed_today, 10 ) || 0;
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
				name: row.student_name || '',
				// Null for Swipe and Matching Game, which have no score to
				// give. Kept apart from a zero: 0 of 10 is a real result and
				// must still show.
				score: null === row.score || undefined === row.score ? null : parseInt( row.score, 10 ),
				scoreMax: null === row.score_max || undefined === row.score_max ? null : parseInt( row.score_max, 10 ),
				// Monotonic, and assigned in the order the work happened
				// because this loop runs oldest-first. A student who finishes
				// a second thing gets a fresh one and moves back to the top.
				seq: ++doneSeq
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

	/* Presence is asked first, and the order is the whole point.

	   `done` holds everyone who finished anything since midnight, so testing it
	   first meant a student's first completion of the day froze her as done and
	   every later heartbeat was discarded — she could play three more games and
	   the panel would still be showing the first one.

	   A heartbeat means the last sixty seconds. The server clears a student's
	   presence the moment it records a completion, and the tools stop beating at
	   the same time, so "finished and sitting still" has no heartbeat and still
	   reads as done. A heartbeat after that means she has started something
	   new, which is what the teacher needs to see. */
	function stateOf( student ) {
		if ( presence[ student.user_id ] ) {
			return 'working';
		}
		if ( Object.prototype.hasOwnProperty.call( done, student.user_id ) ) {
			return 'done';
		}
		return 'idle';
	}

	/* --------------------------------------------------------------- Render */

	var ORDER = { done: 0, working: 1, idle: 2 };

	function render() {
		/* Read before the wipe and written back after it. Rebuilding the list
		   would otherwise send it back to the top on every poll, and a teacher
		   reading a row halfway down would lose her place every ten seconds.
		   Restoring a remembered 0 is the same statement as staying pinned to
		   the top, so the two cases need no separate branch — and the list is
		   never scrolled on the teacher's behalf either way. */
		var keepScroll = rosterEl.scrollTop;

		rosterEl.textContent = '';

		// With no class open the panel is hidden anyway, so there is nothing to
		// say and no hint to offer — the roster simply empties.
		if ( ! classId ) {
			countEl.textContent = '';
			return;
		}

		if ( ! students.length ) {
			rosterEl.appendChild( el( 'p', 'tbtp__empty', i18n.empty || '' ) );
			countEl.textContent = '';
			return;
		}

		// The resolver already returned the class alphabetically and the sort
		// is stable, so returning 0 leaves a group in that order. Only the
		// finished group asks for something else: newest completion first, so
		// the freshest news is the row at the top of the list. The other two
		// groups have no comparable moment to sort by and stay alphabetical.
		var rows = students.slice();
		rows.sort( function ( a, b ) {
			var byState = ORDER[ stateOf( a ) ] - ORDER[ stateOf( b ) ];
			if ( byState ) {
				return byState;
			}
			if ( 'done' !== stateOf( a ) ) {
				return 0;
			}
			return ( done[ b.user_id ].seq || 0 ) - ( done[ a.user_id ].seq || 0 );
		} );

		// `finished` counts students, not work: it is the "1 of 1" half of the
		// counter, while the tasks half is the server's own count.
		//
		// Counted from `done` rather than from stateOf(). The two ask different
		// questions: the status column says what she is doing right now, this
		// says whether she has finished anything today. Deriving one from the
		// other is what made a class with two completed tasks read "0 of 1
		// done" — she was working again, so her earlier completion stopped
		// being counted. Sorting still ranks by stateOf(), which is correct: a
		// student who is working sorts as working.
		var finished = 0;
		for ( var i = 0; i < rows.length; i++ ) {
			var state = stateOf( rows[ i ] );
			if ( Object.prototype.hasOwnProperty.call( done, rows[ i ].user_id ) ) {
				finished++;
			}
			rosterEl.appendChild( studentRow( rows[ i ], state ) );
		}

		countEl.textContent = fmt(
			1 === completedToday ? i18n.countOne : i18n.count,
			[ completedToday, finished, rows.length ]
		);

		rosterEl.scrollTop = keepScroll;
	}

	/* One row, four cells, one line: dot, name, task, status. The task is a
	   column of its own rather than a second line under the name — a row is
	   32px tall and anything that wrapped would break the pitch the list is
	   built on. Each cell truncates on its own. */
	function studentRow( student, state ) {
		var row = el( 'div', 'tbtp-student is-' + state );

		row.appendChild( el( 'span', 'tbtp-student__dot' ) );
		row.appendChild( el( 'span', 'tbtp-student__name', student.display_name || '' ) );

		// The task column is what she last finished, whether or not she has
		// since started something else — tying it to the `done` state meant
		// starting a second task erased the record of the first from the panel.
		// Otherwise it is her level when there is one. A level is never
		// invented: an absent one leaves the cell empty rather than showing a
		// dash.
		//
		// The tick is load-bearing, not decoration. Without it a working
		// student with a finished task behind her reads as working *on* that
		// task, which is the opposite of what the row is saying. It is applied
		// in the done state too, where the status already says Done: one rule
		// that always holds beats two that depend on state.
		//
		// The score follows when the tool sent one. Drag & Drop reports a real
		// score with every completion, so "done" on a ten-gap exercise can mean
		// 2/10 as easily as 10/10. Null and 0 must not be conflated — a student
		// who filled every gap and got none right scores 0 of 10, and that row
		// has to read 0/10 rather than hide its score like a Swipe deck.
		var record = done[ student.user_id ];
		if ( record && record.title ) {
			var label = '✓ ' + record.title;
			if ( null !== record.score && null !== record.scoreMax ) {
				label += ' · ' + record.score + '/' + record.scoreMax;
			}
			row.appendChild( el( 'span', 'tbtp-student__task', label ) );
		} else if ( student.level ) {
			row.appendChild( el( 'span', 'tbtp-student__level', student.level ) );
		} else {
			// The grid places cells by order, so the status needs the task
			// column filled even when there is nothing to put in it.
			row.appendChild( el( 'span', 'tbtp-student__task' ) );
		}

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
		completedToday = 0;
		doneSeq = 0;
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

	/* No aria-label either way: the head's own text names it better than
	   anything written here could. Collapsed that text is the class name and
	   the day's tally, expanded it is the class name with the list it controls
	   sitting underneath, and `aria-expanded` says which of the two it is. */
	function setCollapsed( collapsed ) {
		panel.classList.toggle( 'is-collapsed', collapsed );
		head.setAttribute( 'aria-expanded', String( ! collapsed ) );
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
