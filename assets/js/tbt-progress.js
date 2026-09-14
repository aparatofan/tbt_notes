/**
 * TBT Notes — live progress panel.
 *
 * Shows one class at a time as a feed: every piece of work finished since the
 * teacher opened the class, who is working right now, and who has not started.
 * It polls every ten seconds and toasts each completion as it arrives.
 *
 * Three rules shape most of what follows.
 *
 * The first response after choosing a class SEEDS state and toasts nothing. A
 * toast means "this just happened", so only the incremental polls raise them.
 *
 * The list is a feed, not a roster. One row per completed task, newest at the
 * top — a student who finishes four things gets four rows. The `done` map still
 * exists and still answers "has this student finished anything", which is what
 * the status column and the counter need; it simply stopped being what the list
 * is built from, because a map keyed by student can only ever hold one title
 * per student and the second deck overwrote the first.
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
 * At rest the panel is a circle in the corner — the CP Mini — carrying no
 * class name, no counter and no dot, because at rest there is nothing to read.
 * Clicking it opens the full panel; the chevron in the header closes it again.
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
	var toastsEl = document.querySelector( '[data-tbtp-toasts]' );
	var classNameEl = panel.querySelector( '[data-tbtp-classname]' );

	var STORE_OPEN = 'tbtNotesProgressOpen';
	/* Prefix, not a key: the cursor is per class, so the stored name carries
	   the class ID. See forgetOtherSeeds(). */
	var STORE_SEED = 'tbtNotesProgressSeed';
	var TOAST_LIFE = 6000;
	var TOAST_MAX = 3;
	var BASE_INTERVAL = ( parseInt( cfg.pollSeconds, 10 ) || 10 ) * 1000;
	var MAX_INTERVAL = 120000;

	/* State for the class currently on screen.

	   `events` is the feed: one entry per activity row, newest first, and the
	   only thing the completion rows are built from. `done` maps a student ID
	   to the last thing they finished — a different question, asked by
	   stateOf() and by the counter. `presence` is the set of students with a
	   live heartbeat. */
	var classId = 0;
	var students = [];
	var events = [];
	var done = {};
	var presence = {};
	var lastId = 0;
	var seeded = false;

	/* Activity row IDs already in `events`. A poll that overlaps a re-seed can
	   hand the same row over twice, and a row is a thing that happened once. */
	var eventIds = {};

	/* Bumped every time a completion is recorded, and stamped on the record so
	   a `done` entry carries the order it arrived in. */
	var doneSeq = 0;

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

	function forget( key ) {
		try {
			window.sessionStorage.removeItem( key );
		} catch ( e ) {}
	}

	/* ------------------------------------------------------- Feed cursor */

	/* Where this class's feed began, so a reload mid-lesson comes back to the
	   same starting point rather than to the moment of the reload. Per class,
	   because the answer is only ever about the class on screen. */
	function seedKey( id ) {
		return STORE_SEED + ':' + id;
	}

	function recallSeed( id ) {
		return parseInt( recall( seedKey( id ) ), 10 ) || 0;
	}

	/* Every other class's stored cursor is some earlier lesson's, and replaying
	   it would open that class on a feed of work that finished hours ago.
	   Opening a class is the moment they stop being worth keeping. */
	function forgetOtherSeeds( keep ) {
		var doomed = [];
		var store;

		try {
			store = window.sessionStorage;
			for ( var i = 0; i < store.length; i++ ) {
				var key = store.key( i );
				if ( key && 0 === key.indexOf( STORE_SEED + ':' ) && key !== seedKey( keep ) ) {
					doomed.push( key );
				}
			}
		} catch ( e ) {
			return;
		}

		// Removed in a second pass: deleting while walking the store shifts
		// the indices out from under the loop.
		for ( var d = 0; d < doomed.length; d++ ) {
			forget( doomed[ d ] );
		}
	}

	/* A second ago, as the UTC stamp the activity table stores.
	
	   Not "now". A datetime cursor is compared with a strict `>` at second
	   resolution, while the cursor the same response hands back is the table's
	   current highest ID — so a completion written in the very second the class
	   was opened falls between the two and would never appear in the feed at
	   all. One second of overlap costs, at worst, a row that is a second old. */
	function justNowUtc() {
		return new Date( Date.now() - 1000 ).toISOString().slice( 0, 19 ).replace( 'T', ' ' );
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

	/* The feed starts when the teacher opens the class, not at midnight: a
	   panel opened at two in the afternoon is asking what is happening in this
	   lesson, and the morning's work is what the counter is for.

	   So the seed asks from the current cursor and gets an empty list back —
	   unless this tab already watched this class today, in which case it asks
	   from where that lesson began and the completions come back. */
	function seed() {
		if ( ! classId ) {
			return;
		}
		var stored = recallSeed( classId );

		inFlight = true;
		request(
			[
				'class_id=' + encodeURIComponent( classId ),
				'roster=1',
				'since=' + encodeURIComponent( stored ? String( stored ) : justNowUtc() )
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
				events = [];
				eventIds = {};
				applyActivity( data.activity || [], false );
				applyPresence( data.presence || [] );
				lastId = parseInt( data.last_id, 10 ) || 0;
				// Written once per lesson and then left alone. Storing the new
				// cursor on every reload would walk the starting point forward
				// and the second reload would show less than the first.
				remember( seedKey( wanted ), stored || lastId );
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

	/* Rows arrive newest first. Walking them in reverse and pushing each onto
	   the front of the feed puts them back in newest-first order, gives the
	   toasts the order the work actually happened in, and leaves `done` holding
	   the newest title for each student.

	   Every row becomes its own feed entry, including a second one from a
	   student already marked done — she finished another deck, and that is
	   precisely the case the roster used to lose. */
	function applyActivity( rows, announce ) {
		var fresh = [];

		for ( var i = rows.length - 1; i >= 0; i-- ) {
			var row = rows[ i ];
			var uid = parseInt( row.user_id, 10 ) || 0;
			var rowId = parseInt( row.id, 10 ) || 0;
			if ( ! uid ) {
				continue;
			}
			// A re-seed can overlap a poll and replay rows the feed already
			// holds. The row's own ID is what makes the entry idempotent.
			if ( rowId && Object.prototype.hasOwnProperty.call( eventIds, rowId ) ) {
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
				// because this loop runs oldest-first.
				seq: ++doneSeq
			};
			done[ uid ] = record;

			events.unshift( {
				id: rowId,
				userId: uid,
				name: record.name,
				title: record.title,
				score: record.score,
				scoreMax: record.scoreMax
			} );
			if ( rowId ) {
				eventIds[ rowId ] = true;
			}

			// The toast carries the row's own title rather than reading it
			// back out of `done`, which by then holds only the newest.
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

	   `done` holds everyone who finished anything, so testing it first meant a
	   student's first completion froze her as done and every later heartbeat
	   was discarded — she could play three more games and the panel would still
	   be showing the first one.

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

	/* Three groups, in the order the roster used to sort into: what has been
	   finished, who is working, who has not started.

	   The first group is the feed and is counted in tasks; the other two are
	   counted in students. A student who is working and has finished things
	   appears in both — her working row says what she is doing now, her
	   completion rows say what she has already done, and neither answers for
	   the other. A student who has finished and stopped has her completion
	   rows and no student row at all: there is nothing left to report about
	   her that the rows above do not already say. */
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
			return;
		}

		if ( ! students.length ) {
			rosterEl.appendChild( el( 'p', 'tbtp__empty', i18n.empty || '' ) );
			return;
		}

		for ( var e = 0; e < events.length; e++ ) {
			rosterEl.appendChild( eventRow( events[ e ] ) );
		}

		// The resolver returns the class alphabetically, so filtering it keeps
		// both remaining groups in that order without a sort.
		var working = [];
		var idle = [];

		for ( var s = 0; s < students.length; s++ ) {
			var student = students[ s ];
			var state = stateOf( student );
			if ( 'working' === state ) {
				working.push( student );
			} else if ( 'idle' === state ) {
				idle.push( student );
			}
		}

		for ( var w = 0; w < working.length; w++ ) {
			rosterEl.appendChild( studentRow( working[ w ], 'working' ) );
		}
		for ( var n = 0; n < idle.length; n++ ) {
			rosterEl.appendChild( studentRow( idle[ n ], 'idle' ) );
		}

		rosterEl.scrollTop = keepScroll;
	}

	/* One row, four cells, one line: dot, name, task, status. The task is a
	   column of its own rather than a second line under the name — a row is
	   32px tall and anything that wrapped would break the pitch the list is
	   built on. Each cell truncates on its own. */
	function row( state ) {
		return el( 'div', 'tbtp-student is-' + state );
	}

	/* One completed task. Not one student: four decks from the same student are
	   four of these, each carrying its own title, newest at the top.
	   
	   The tick is load-bearing, not decoration. Without it the row reads as
	   working *on* that task, which is the opposite of what it is saying.
	   
	   The score follows when the tool sent one. Drag & Drop reports a real score
	   with every completion, so "done" on a ten-gap exercise can mean 2/10 as
	   easily as 10/10. Null and 0 must not be conflated — a student who filled
	   every gap and got none right scores 0 of 10, and that row has to read
	   0/10 rather than hide its score like a Swipe deck. */
	function eventRow( event ) {
		var node = row( 'done' );

		node.appendChild( el( 'span', 'tbtp-student__dot' ) );
		node.appendChild( el( 'span', 'tbtp-student__name', event.name || '' ) );

		var label = event.title ? '✓ ' + event.title : '✓';
		if ( null !== event.score && null !== event.scoreMax ) {
			label += ' · ' + event.score + '/' + event.scoreMax;
		}
		node.appendChild( el( 'span', 'tbtp-student__task', label ) );

		node.appendChild( el( 'span', 'tbtp-student__state', i18n.done || '' ) );
		return node;
	}

	/* One student who is working or has not started. The task column stays
	   empty: she has not finished anything to name in it, and her level is not
	   the panel's to tell — the teacher shares this screen with the class, and
	   the levels she has set are between her and each student. What the student
	   has finished is not repeated here either; it has its own rows above.

	   The empty cell is still appended. The grid places cells by order, so the
	   status column needs the task column filled even when there is nothing to
	   put in it. */
	function studentRow( student, state ) {
		var node = row( state );

		node.appendChild( el( 'span', 'tbtp-student__dot' ) );
		node.appendChild( el( 'span', 'tbtp-student__name', student.display_name || '' ) );
		node.appendChild( el( 'span', 'tbtp-student__task' ) );
		node.appendChild( el( 'span', 'tbtp-student__state', i18n[ state ] || '' ) );
		return node;
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
		events = [];
		eventIds = {};
		done = {};
		presence = {};
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
			forgetOtherSeeds( classId );
			seed();
		}
	}

	/* Expanded, the head's own text names it better than anything written here
	   could: the class name, with the list it controls sitting underneath, and
	   `aria-expanded` saying which of the two states it is in.

	   Collapsed there is no such text. The circle's two letters are a mark
	   rather than a word and are hidden from the accessibility tree, so the
	   button borrows a name for as long as it is a circle. */
	function setCollapsed( collapsed ) {
		panel.classList.toggle( 'is-collapsed', collapsed );
		head.setAttribute( 'aria-expanded', String( ! collapsed ) );
		if ( collapsed ) {
			head.setAttribute( 'aria-label', i18n.panel || 'Class progress' );
		} else {
			head.removeAttribute( 'aria-label' );
		}
		remember( STORE_OPEN, collapsed ? '0' : '1' );
	}

	head.addEventListener( 'click', function () {
		setCollapsed( ! panel.classList.contains( 'is-collapsed' ) );
	} );

	document.addEventListener( 'tbt-notes:class-change', function ( e ) {
		var detail = e.detail || {};
		var id = parseInt( detail.id, 10 ) || 0;
		// Same class, new name: relabel and leave the feed alone. Renaming a
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
