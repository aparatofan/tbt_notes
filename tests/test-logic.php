<?php
/**
 * Standalone logic tests for TBT Notes.
 *
 * These cover the two things that must not regress: the body sanitiser's
 * normalisation (safe links + highlight-only classes + nbsp handling) and the
 * server-side visibility rule (a student sees only their own class).
 *
 * WordPress is not loaded here, so a few WP functions are stubbed. wp_kses is
 * stubbed as a pass-through: it is WordPress's own well-tested code, so these
 * tests focus on OUR logic. The allowlist itself is asserted separately to
 * prove dangerous tags are never permitted.
 *
 * Run: php tests/test-logic.php
 *
 * @package TBT_Notes
 */

error_reporting( E_ALL );

define( 'ABSPATH', __DIR__ . '/' );
define( 'TBT_NOTES_CAP', 'manage_tbt_notes' );

/* ----------------------------------------------------------- WP function stubs */

$GLOBALS['__cur_can']  = false;
$GLOBALS['__user_can'] = array();

function wp_unslash( $value ) {
	return is_string( $value ) ? stripslashes( $value ) : $value;
}

function sanitize_text_field( $str ) {
	$str = (string) $str;
	$str = wp_strip_all_tags_simple( $str );
	$str = preg_replace( '/[\r\n\t ]+/', ' ', $str );
	return trim( $str );
}

function wp_strip_all_tags_simple( $str ) {
	return trim( preg_replace( '/<[^>]*>/', '', $str ) );
}

/**
 * Pass-through stub. Real WordPress wp_kses enforces the allowlist; we trust it
 * and instead assert the allowlist's contents directly (see test_allowlist).
 */
function wp_kses( $html, $allowed ) {
	$GLOBALS['__last_kses_allowed'] = $allowed;
	return $html;
}

function current_user_can( $cap ) {
	return ! empty( $GLOBALS['__cur_can'] );
}

/**
 * Cap-aware stub: a user's value may be `true` (all caps) or an array of
 * specific cap slugs.
 */
function user_can( $user_id, $cap ) {
	$map = $GLOBALS['__user_can'];
	if ( ! isset( $map[ (int) $user_id ] ) ) {
		return false;
	}
	$val = $map[ (int) $user_id ];
	if ( true === $val ) {
		return true;
	}
	if ( is_array( $val ) ) {
		return in_array( $cap, $val, true );
	}
	return (bool) $val;
}

/* ----------------------------------------------------------------- Load code */

require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-capabilities.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-sanitizer.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-pronunciation.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-rest.php';

/* ------------------------------------------------------------- Tiny test kit */

$GLOBALS['__pass'] = 0;
$GLOBALS['__fail'] = 0;

function ok( $cond, $label ) {
	if ( $cond ) {
		$GLOBALS['__pass']++;
		echo "  PASS: $label\n";
	} else {
		$GLOBALS['__fail']++;
		echo "  FAIL: $label\n";
	}
}

function contains( $haystack, $needle ) {
	return strpos( $haystack, $needle ) !== false;
}

function call_normalize( $html ) {
	$m = new ReflectionMethod( 'TBT_Notes_Sanitizer', 'normalize' );
	$m->setAccessible( true );
	return $m->invoke( null, $html );
}

/* ------------------------------------------------------------------- Tests */

echo "Allowlist:\n";
function test_allowlist() {
	$allowed = TBT_Notes_Sanitizer::allowed_html();
	ok( ! isset( $allowed['script'] ), 'script tag is not allowed' );
	ok( ! isset( $allowed['style'] ), 'style tag is not allowed' );
	ok( ! isset( $allowed['iframe'] ), 'iframe is not allowed' );
	ok( ! isset( $allowed['img'] ), 'img is not allowed (no images in v1)' );
	ok( isset( $allowed['a']['href'], $allowed['a']['target'], $allowed['a']['rel'] ), 'links allow href/target/rel' );
	ok( ! isset( $allowed['a']['style'] ), 'links do not allow inline style' );
	ok( isset( $allowed['span']['class'] ), 'span allows class (for highlights)' );
	ok( isset( $allowed['ol'], $allowed['ul'], $allowed['li'] ), 'lists are allowed' );
	ok( isset( $allowed['strong'], $allowed['em'], $allowed['h2'] ), 'bold/italic/heading allowed' );
	ok( isset( $allowed['u'], $allowed['s'] ), 'underline + strikethrough allowed' );
	ok( isset( $allowed['blockquote'] ), 'blockquote allowed' );

	$classes = TBT_Notes_Sanitizer::allowed_classes();
	ok( $classes === array( 'tbt-hl-blue', 'tbt-hl-red', 'tbt-hl-yellow', 'tbt-hl-pink', 'tbt-hl-green' ), 'five highlight classes (blue/red/yellow/pink/green)' );
}
test_allowlist();

echo "Normalize — links:\n";
function test_links() {
	$out = call_normalize( '<p><a href="https://example.com">x</a></p>' );
	ok( contains( $out, 'target="_blank"' ), 'adds target=_blank' );
	ok( contains( $out, 'rel="noopener noreferrer"' ), 'adds rel=noopener noreferrer' );

	// Pre-existing unsafe rel/target is replaced.
	$out2 = call_normalize( '<a href="https://e.com" target="_self" rel="opener">y</a>' );
	ok( contains( $out2, 'target="_blank"' ), 'overrides target=_self' );
	ok( ! contains( $out2, 'target="_self"' ), 'removes target=_self' );
	ok( ! contains( $out2, 'rel="opener"' ), 'removes rel=opener' );
}
test_links();

echo "Normalize — highlight classes:\n";
function test_classes() {
	$out = call_normalize( '<span class="tbt-hl-blue sneaky-class">h</span>' );
	ok( contains( $out, 'tbt-hl-blue' ), 'keeps approved highlight class' );
	ok( ! contains( $out, 'sneaky-class' ), 'drops non-approved class' );

	$out2 = call_normalize( '<span class="totally-random">h</span>' );
	ok( ! contains( $out2, 'class=' ), 'removes class attribute when nothing approved remains' );

	$out3 = call_normalize( '<span class="tbt-hl-yellow">h</span>' );
	ok( contains( $out3, 'tbt-hl-yellow' ), 'keeps yellow highlight' );

	// Pink is a real semantic category and must survive normalisation.
	$out_pink = call_normalize( '<span class="tbt-hl-pink">pronunciation</span>' );
	ok( contains( $out_pink, 'tbt-hl-pink' ), 'keeps pink highlight (pronunciation)' );

	// A fake colour outside the allowlist must be stripped.
	$out_purple = call_normalize( '<span class="tbt-hl-purple">bad</span>' );
	ok( ! contains( $out_purple, 'tbt-hl-purple' ), 'drops fake tbt-hl-purple class' );

	// An injected fake highlight value is not in the allowlist.
	$out4 = call_normalize( '<span class="tbt-hl-evil">h</span>' );
	ok( ! contains( $out4, 'tbt-hl-evil' ), 'drops fake highlight colour' );
}
test_classes();

echo "Normalize — nested lists survive:\n";
function test_lists() {
	$out = call_normalize( '<ol><li>a<ol><li>b</li></ol></li></ol><ul><li>c</li></ul>' );
	ok( contains( $out, '<ol>' ) && contains( $out, '<ul>' ), 'ol and ul preserved' );
	ok( substr_count( $out, '<li>' ) === 3, 'all three list items preserved' );
}
test_lists();

echo "Body — full pipeline (nbsp + normalize):\n";
function test_body() {
	$out = TBT_Notes_Sanitizer::body( 'a&nbsp;b' );
	ok( contains( $out, 'a b' ) && ! contains( $out, '&nbsp;' ), 'replaces &nbsp; entity with space' );

	$out2 = TBT_Notes_Sanitizer::body( "a\xc2\xa0b" );
	ok( contains( $out2, 'a b' ), 'replaces U+00A0 with space' );

	$out3 = TBT_Notes_Sanitizer::body( '<a href="https://e.com">x</a>' );
	ok( contains( $out3, 'target="_blank"' ), 'body() applies link normalisation' );

	ok( TBT_Notes_Sanitizer::body( '' ) === '', 'empty body stays empty' );
	ok( TBT_Notes_Sanitizer::body( '   ' ) === '', 'whitespace-only body becomes empty' );
}
test_body();

echo "Visibility rule (the security model):\n";
function test_visibility() {
	$teacher_id = 10;
	$student_id = 20;
	$other_id   = 30;

	$GLOBALS['__user_can'] = array( $teacher_id => true ); // Only 10 can manage.

	$class = array( 'id' => 1, 'student_ids' => array( $student_id ) );

	ok( TBT_Notes_REST::user_can_view_class( $class, $teacher_id ) === true, 'teacher can view any class' );
	ok( TBT_Notes_REST::user_can_view_class( $class, $student_id ) === true, 'a member student can view their class' );
	ok( TBT_Notes_REST::user_can_view_class( $class, $other_id ) === false, 'a non-member cannot view it' );
	ok( TBT_Notes_REST::user_can_view_class( $class, 0 ) === false, 'logged-out (id 0) cannot view' );

	// Many students per class: every member sees it; outsiders do not.
	$group = array( 'id' => 5, 'student_ids' => array( $student_id, $other_id, 99 ) );
	ok( TBT_Notes_REST::user_can_view_class( $group, $student_id ) === true, 'group member 1 can view' );
	ok( TBT_Notes_REST::user_can_view_class( $group, $other_id ) === true, 'group member 2 can view' );
	ok( TBT_Notes_REST::user_can_view_class( $group, 12345 ) === false, 'non-member cannot view the group' );

	$empty_class = array( 'id' => 2, 'student_ids' => array() );
	ok( TBT_Notes_REST::user_can_view_class( $empty_class, $teacher_id ) === true, 'teacher sees a class with no students' );
	ok( TBT_Notes_REST::user_can_view_class( $empty_class, $student_id ) === false, 'student cannot see a class they are not in' );

	ok( TBT_Notes_REST::user_can_view_class( array(), $student_id ) === false, 'empty class array is not viewable' );

	// Administrators (manage_options) always manage, even without the custom cap.
	$admin_id = 40;
	$GLOBALS['__user_can'] = array( $admin_id => array( 'manage_options' ) );
	$someones_class = array( 'id' => 9, 'student_ids' => array( 99 ) );
	ok( TBT_Notes_REST::user_can_view_class( $someones_class, $admin_id ) === true, 'manage_options admin sees any class' );

	// A plain user with no relevant caps sees only a class they belong to.
	$plain_id = 50;
	$GLOBALS['__user_can'] = array( $plain_id => array( 'read' ) );
	ok( TBT_Notes_REST::user_can_view_class( $someones_class, $plain_id ) === false, 'plain user cannot view others' );
	ok( TBT_Notes_REST::user_can_view_class( array( 'id' => 9, 'student_ids' => array( $plain_id ) ), $plain_id ) === true, 'plain user can view their own class' );
}
test_visibility();

echo "Pronunciation — pink extraction:\n";
function test_pink_extraction() {
	$html = '<p>Say <span class="tbt-hl-pink">moment of levity</span> and '
		. '<span class="tbt-hl-blue">find your bearings</span>.</p>'
		. '<p><span class="tbt-hl-pink">moment of levity</span> again, plus '
		. '<span class="tbt-hl-pink">  read   the room </span> and '
		. '<span class="tbt-hl-red">I am agree</span>.</p>'
		. '<p><span class="tbt-hl-pink">   </span></p>';

	$items = TBT_Notes_Pronunciation::extract_pink_highlights( $html );

	ok( in_array( 'moment of levity', $items, true ), 'extracts pink text' );
	ok( in_array( 'read the room', $items, true ), 'normalises whitespace inside pink text' );
	ok( ! in_array( 'find your bearings', $items, true ), 'ignores blue highlights' );
	ok( ! in_array( 'I am agree', $items, true ), 'ignores red highlights' );

	// Deduplicated: "moment of levity" appears twice but should be listed once.
	$count = 0;
	foreach ( $items as $i ) {
		if ( 'moment of levity' === $i ) {
			$count++;
		}
	}
	ok( 1 === $count, 'deduplicates repeated pink text' );

	// Empty/whitespace-only pink spans are dropped.
	foreach ( $items as $i ) {
		ok( '' !== trim( $i ), 'no empty items: "' . $i . '"' );
	}

	ok( array() === TBT_Notes_Pronunciation::extract_pink_highlights( '' ), 'empty html yields no items' );
}
test_pink_extraction();

echo "Pronunciation — text hash consistency:\n";
function test_text_hash() {
	$a = TBT_Notes_Pronunciation::text_hash( 'moment of levity' );
	$b = TBT_Notes_Pronunciation::text_hash( '  moment   of  levity  ' );
	ok( $a === $b, 'same normalised text gives same hash' );
	ok( 64 === strlen( $a ), 'hash is a 64-char sha-256 hex string' );

	$c = TBT_Notes_Pronunciation::text_hash( 'read the room' );
	ok( $a !== $c, 'different text gives a different hash' );
}
test_text_hash();

echo "Pronunciation — length validation:\n";
function test_length_validation() {
	$short = 'a perfectly normal phrase';
	ok( ! TBT_Notes_Pronunciation::exceeds_length_limit( $short ), 'short text is accepted' );

	$long = str_repeat( 'a', 201 );
	ok( TBT_Notes_Pronunciation::exceeds_length_limit( $long ), 'overlong text is rejected' );

	$boundary = str_repeat( 'a', 200 );
	ok( ! TBT_Notes_Pronunciation::exceeds_length_limit( $boundary ), 'text at the 200-char limit is accepted' );
}
test_length_validation();

/* ----------------------------------------------------------------- Summary */

echo "\n----------------------------------------\n";
echo 'Passed: ' . $GLOBALS['__pass'] . '  Failed: ' . $GLOBALS['__fail'] . "\n";
exit( $GLOBALS['__fail'] > 0 ? 1 : 0 );
