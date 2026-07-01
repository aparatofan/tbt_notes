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
 * Stub the uploads location so the sanitiser can tell our own images from
 * external ones. Only the base URL matters for normalisation.
 */
function wp_upload_dir() {
	return array( 'baseurl' => 'https://example.com/wp-content/uploads' );
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

/**
 * Minimal i18n + error stubs used by the expression-card service. WordPress is
 * not loaded; these mimic just enough behaviour for our logic.
 */
function __( $text, $domain = 'default' ) {
	return $text;
}

function wp_strip_all_tags( $str ) {
	return trim( preg_replace( '/<[^>]*>/', '', (string) $str ) );
}

/**
 * Tiny WP_Error stand-in: stores a code + message so tests can assert on them.
 */
class WP_Error {
	public $code;
	public $message;
	public $data;
	public function __construct( $code = '', $message = '', $data = array() ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
	public function get_error_code() {
		return $this->code;
	}
	public function get_error_message() {
		return $this->message;
	}
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}

/**
 * In-memory stand-in for TBT_Notes_DB, covering only the lesson + expression-card
 * methods the service touches. Lets us exercise list/generate/delete logic
 * without a database.
 */
class TBT_Notes_DB {
	public static $lessons      = array();
	public static $cards        = array();
	public static $next_card_id = 1;

	public static function reset() {
		self::$lessons      = array();
		self::$cards        = array();
		self::$next_card_id = 1;
	}

	public static function set_lesson( $id, $header, $body ) {
		self::$lessons[ (int) $id ] = array(
			'id'     => (int) $id,
			'header' => (string) $header,
			'body'   => (string) $body,
		);
	}

	public static function get_lesson( $id ) {
		return isset( self::$lessons[ (int) $id ] ) ? self::$lessons[ (int) $id ] : null;
	}

	public static function get_expression_cards_for_lesson( $lesson_id ) {
		$out = array();
		foreach ( self::$cards as $c ) {
			if ( (int) $c['lesson_id'] === (int) $lesson_id ) {
				$out[] = $c;
			}
		}
		return $out;
	}

	public static function get_expression_card( $lesson_id, $hash ) {
		foreach ( self::$cards as $c ) {
			if ( (int) $c['lesson_id'] === (int) $lesson_id && $c['text_hash'] === $hash ) {
				return $c;
			}
		}
		return null;
	}

	public static function get_expression_card_by_id( $id ) {
		return isset( self::$cards[ (int) $id ] ) ? self::$cards[ (int) $id ] : null;
	}

	public static function insert_expression_card( array $data ) {
		$id   = self::$next_card_id++;
		$card = array(
			'id'                 => $id,
			'lesson_id'          => (int) $data['lesson_id'],
			'text_hash'          => (string) $data['text_hash'],
			'text'               => (string) $data['text'],
			'context'            => isset( $data['context'] ) ? (string) $data['context'] : '',
			'polish_translation' => (string) $data['polish_translation'],
			'example_sentence'   => (string) $data['example_sentence'],
			'level'              => isset( $data['level'] ) ? (string) $data['level'] : 'B1/B2',
			'status'             => isset( $data['status'] ) ? (string) $data['status'] : 'draft',
			'provider'           => isset( $data['provider'] ) ? (string) $data['provider'] : 'openai',
			'model'              => isset( $data['model'] ) ? (string) $data['model'] : '',
		);
		self::$cards[ $id ] = $card;
		return $id;
	}

	public static function update_expression_card( $id, array $fields ) {
		if ( ! isset( self::$cards[ (int) $id ] ) ) {
			return false;
		}
		foreach ( $fields as $k => $v ) {
			self::$cards[ (int) $id ][ $k ] = $v;
		}
		return true;
	}

	public static function delete_expression_cards_for_lesson( $lesson_id ) {
		foreach ( self::$cards as $id => $c ) {
			if ( (int) $c['lesson_id'] === (int) $lesson_id ) {
				unset( self::$cards[ $id ] );
			}
		}
	}
}

/* ----------------------------------------------------------------- Load code */

require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-capabilities.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-sanitizer.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-pronunciation.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-expression-cards.php';
require_once dirname( __DIR__ ) . '/includes/class-tbt-notes-ai-quick-note.php';
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
	ok( isset( $allowed['img'] ), 'img is allowed (lesson photo upload)' );
	ok( isset( $allowed['img']['src'], $allowed['img']['alt'], $allowed['img']['loading'] ), 'img allows src/alt/loading' );
	ok( ! isset( $allowed['img']['style'], $allowed['img']['onerror'] ), 'img does not allow style/onerror' );
	ok( isset( $allowed['a']['href'], $allowed['a']['target'], $allowed['a']['rel'] ), 'links allow href/target/rel' );
	ok( ! isset( $allowed['a']['style'] ), 'links do not allow inline style' );
	ok( isset( $allowed['span']['class'] ), 'span allows class (for highlights)' );
	ok( isset( $allowed['ol'], $allowed['ul'], $allowed['li'] ), 'lists are allowed' );
	ok( isset( $allowed['strong'], $allowed['em'], $allowed['h2'] ), 'bold/italic/heading allowed' );
	ok( isset( $allowed['u'], $allowed['s'] ), 'underline + strikethrough allowed' );
	ok( isset( $allowed['blockquote'] ), 'blockquote allowed' );

	$classes = TBT_Notes_Sanitizer::allowed_classes();
	ok( $classes === array( 'tbt-hl-blue', 'tbt-hl-red', 'tbt-hl-yellow', 'tbt-hl-pink', 'tbt-hl-green' ), 'five highlight classes (blue/red/yellow/pink/green)' );

	$img_classes = TBT_Notes_Sanitizer::allowed_image_classes();
	ok( $img_classes === array( 'tbt-notes-image' ), 'one approved image class (tbt-notes-image)' );
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

echo "Normalize — lesson images:\n";
function test_images() {
	$base = 'https://example.com/wp-content/uploads/2026/07/note.jpg';

	// Our own upload survives and is forced to lazy-load.
	$out = call_normalize( '<p><img src="' . $base . '" alt="Notes"></p>' );
	ok( contains( $out, 'src="' . $base . '"' ), 'keeps an image from our uploads dir' );
	ok( contains( $out, 'loading="lazy"' ), 'forces loading=lazy on kept images' );
	ok( contains( $out, 'alt="Notes"' ), 'keeps the alt text' );

	// A scheme mismatch (http vs https) must not reject our own image.
	$out_http = call_normalize( '<img src="http://example.com/wp-content/uploads/a.png">' );
	ok( contains( $out_http, 'wp-content/uploads/a.png' ), 'ignores http/https scheme mismatch for own uploads' );

	// External images are removed entirely.
	$out_ext = call_normalize( '<p><img src="https://evil.example/tracker.png"></p>' );
	ok( ! contains( $out_ext, 'evil.example' ), 'drops an external image (tracking pixel)' );

	// data: URLs are not our uploads and must go.
	$out_data = call_normalize( '<img src="data:image/png;base64,AAAA">' );
	ok( ! contains( $out_data, 'data:image' ), 'drops a data: URL image' );

	// Empty src is removed.
	$out_empty = call_normalize( '<img src="">' );
	ok( ! contains( $out_empty, '<img' ), 'drops an image with an empty src' );

	// Only the approved image class survives; sneaky classes are stripped.
	$out_cls = call_normalize( '<img src="' . $base . '" class="tbt-notes-image sneaky">' );
	ok( contains( $out_cls, 'tbt-notes-image' ), 'keeps the approved image class' );
	ok( ! contains( $out_cls, 'sneaky' ), 'drops non-approved image classes' );

	// A highlight class must not ride along on an image.
	$out_hl = call_normalize( '<img src="' . $base . '" class="tbt-hl-blue">' );
	ok( ! contains( $out_hl, 'tbt-hl-blue' ), 'highlight classes are not allowed on images' );

	// Non-numeric dimensions are dropped.
	$out_dim = call_normalize( '<img src="' . $base . '" width="100" height="abc">' );
	ok( contains( $out_dim, 'width="100"' ), 'keeps numeric width' );
	ok( ! contains( $out_dim, 'height="abc"' ), 'drops non-numeric height' );
}
test_images();

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

	// A plain teacher: has the manage cap but is NOT a site administrator.
	$GLOBALS['__user_can'] = array( $teacher_id => array( 'manage_tbt_notes' ) );

	// A class this teacher created (teacher_id === 10).
	$own = array( 'id' => 1, 'teacher_id' => $teacher_id, 'student_ids' => array( $student_id ) );

	ok( TBT_Notes_REST::user_can_view_class( $own, $teacher_id ) === true, 'teacher can view a class they created' );
	ok( TBT_Notes_REST::user_can_view_class( $own, $student_id ) === true, 'a member student can view their class' );
	ok( TBT_Notes_REST::user_can_view_class( $own, $other_id ) === false, 'a non-member cannot view it' );
	ok( TBT_Notes_REST::user_can_view_class( $own, 0 ) === false, 'logged-out (id 0) cannot view' );

	// The core bug fix: a class created by a DIFFERENT teacher is invisible.
	$others = array( 'id' => 7, 'teacher_id' => 999, 'student_ids' => array() );
	ok( TBT_Notes_REST::user_can_view_class( $others, $teacher_id ) === false, "teacher cannot view another teacher's class" );
	ok( TBT_Notes_REST::user_can_manage_class( $others, $teacher_id ) === false, "teacher cannot manage another teacher's class" );
	ok( TBT_Notes_REST::user_can_manage_class( $own, $teacher_id ) === true, 'teacher can manage a class they created' );

	// A class with a missing/zero owner (legacy row) is not owned by any teacher.
	$legacy = array( 'id' => 8, 'teacher_id' => 0, 'student_ids' => array() );
	ok( TBT_Notes_REST::user_can_view_class( $legacy, $teacher_id ) === false, 'teacher does not own an unowned (legacy) class' );

	// Many students per class: every member sees it; outsiders do not.
	$group = array( 'id' => 5, 'teacher_id' => $teacher_id, 'student_ids' => array( $student_id, $other_id, 99 ) );
	ok( TBT_Notes_REST::user_can_view_class( $group, $student_id ) === true, 'group member 1 can view' );
	ok( TBT_Notes_REST::user_can_view_class( $group, $other_id ) === true, 'group member 2 can view' );
	ok( TBT_Notes_REST::user_can_view_class( $group, 12345 ) === false, 'non-member cannot view the group' );

	$empty_class = array( 'id' => 2, 'teacher_id' => $teacher_id, 'student_ids' => array() );
	ok( TBT_Notes_REST::user_can_view_class( $empty_class, $teacher_id ) === true, 'teacher sees their own class with no students' );
	ok( TBT_Notes_REST::user_can_view_class( $empty_class, $student_id ) === false, 'student cannot see a class they are not in' );

	ok( TBT_Notes_REST::user_can_view_class( array(), $student_id ) === false, 'empty class array is not viewable' );

	// Administrators (manage_options) oversee every class, whoever created it.
	$admin_id = 40;
	$GLOBALS['__user_can'] = array( $admin_id => array( 'manage_options' ) );
	$someones_class = array( 'id' => 9, 'teacher_id' => 999, 'student_ids' => array( 99 ) );
	ok( TBT_Notes_REST::user_can_view_class( $someones_class, $admin_id ) === true, 'manage_options admin sees any class' );
	ok( TBT_Notes_REST::user_can_manage_class( $someones_class, $admin_id ) === true, 'manage_options admin manages any class' );

	// A plain user with no relevant caps sees only a class they belong to.
	$plain_id = 50;
	$GLOBALS['__user_can'] = array( $plain_id => array( 'read' ) );
	ok( TBT_Notes_REST::user_can_view_class( $someones_class, $plain_id ) === false, 'plain user cannot view others' );
	ok( TBT_Notes_REST::user_can_view_class( array( 'id' => 9, 'teacher_id' => 999, 'student_ids' => array( $plain_id ) ), $plain_id ) === true, 'plain user can view their own class' );
	ok( TBT_Notes_REST::user_can_manage_class( $someones_class, $plain_id ) === false, 'plain user cannot manage any class' );
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

echo "Expression cards — blue extraction:\n";
function test_blue_extraction() {
	$html = '<p>Use <span class="tbt-hl-blue">in the zone</span> and '
		. '<span class="tbt-hl-pink">moment of levity</span>.</p>'
		. '<p><span class="tbt-hl-blue">in the zone</span> again, plus '
		. '<span class="tbt-hl-blue">  find   your bearings </span> and '
		. '<span class="tbt-hl-red">I am agree</span>.</p>'
		. '<p><span class="tbt-hl-blue">   </span></p>';

	$items = TBT_Notes_Expression_Cards::extract_blue_highlights( $html );

	ok( in_array( 'in the zone', $items, true ), 'extracts blue text' );
	ok( in_array( 'find your bearings', $items, true ), 'normalises whitespace inside blue text' );
	ok( ! in_array( 'moment of levity', $items, true ), 'ignores pink highlights' );
	ok( ! in_array( 'I am agree', $items, true ), 'ignores red highlights' );

	$count = 0;
	foreach ( $items as $i ) {
		if ( 'in the zone' === $i ) {
			$count++;
		}
	}
	ok( 1 === $count, 'deduplicates repeated blue text' );

	foreach ( $items as $i ) {
		ok( '' !== trim( $i ), 'no empty items: "' . $i . '"' );
	}

	ok( array() === TBT_Notes_Expression_Cards::extract_blue_highlights( '' ), 'empty html yields no items' );
}
test_blue_extraction();

echo "Expression cards — normalisation + hashing:\n";
function test_expr_normalize() {
	ok( 'in the zone' === TBT_Notes_Expression_Cards::normalize_text( "  in   the\tzone  " ), 'collapses whitespace runs' );

	$a = TBT_Notes_Expression_Cards::text_hash( 'in the zone' );
	$b = TBT_Notes_Expression_Cards::text_hash( '  in   the  zone ' );
	ok( $a === $b, 'same normalised text gives same hash' );
	ok( 64 === strlen( $a ), 'hash is a 64-char sha-256 hex string' );

	ok( ! TBT_Notes_Expression_Cards::exceeds_length_limit( str_repeat( 'a', 200 ) ), 'text at the 200-char limit is accepted' );
	ok( TBT_Notes_Expression_Cards::exceeds_length_limit( str_repeat( 'a', 201 ) ), 'overlong text is rejected' );
}
test_expr_normalize();

echo "Expression cards — teacher list (all blue, with/without cards):\n";
function test_expr_teacher_list() {
	TBT_Notes_DB::reset();
	$body = '<p><span class="tbt-hl-blue">in the zone</span> and '
		. '<span class="tbt-hl-blue">find your bearings</span>.</p>';
	TBT_Notes_DB::set_lesson( 1, 'Lesson 1', $body );

	// Only one of the two blue items has a card so far.
	TBT_Notes_DB::insert_expression_card( array(
		'lesson_id'          => 1,
		'text_hash'          => TBT_Notes_Expression_Cards::text_hash( 'in the zone' ),
		'text'               => 'in the zone',
		'context'            => 'ctx',
		'polish_translation' => 'w rytmie pracy',
		'example_sentence'   => 'I was in the zone.',
		'status'             => 'draft',
	) );

	$items = TBT_Notes_Expression_Cards::list_for_lesson( 1, true );
	ok( count( $items ) === 2, 'teacher sees every current blue highlight (2)' );

	$by_text = array();
	foreach ( $items as $it ) {
		$by_text[ $it['text'] ] = $it;
	}
	ok( isset( $by_text['in the zone'] ) && $by_text['in the zone']['has_card'] === true, 'item with a card is flagged has_card=true' );
	ok( isset( $by_text['find your bearings'] ) && $by_text['find your bearings']['has_card'] === false, 'item without a card is flagged has_card=false' );
	ok( $by_text['find your bearings']['can_generate'] === true, 'cardless item can be generated' );
	ok( $by_text['in the zone']['status'] === 'draft', 'card status is surfaced to the teacher' );
}
test_expr_teacher_list();

echo "Expression cards — student list (approved only, drafts hidden):\n";
function test_expr_student_list() {
	TBT_Notes_DB::reset();
	$body = '<p><span class="tbt-hl-blue">in the zone</span>, '
		. '<span class="tbt-hl-blue">find your bearings</span>, '
		. '<span class="tbt-hl-blue">read the room</span>.</p>';
	TBT_Notes_DB::set_lesson( 2, 'Lesson 2', $body );

	TBT_Notes_DB::insert_expression_card( array(
		'lesson_id'          => 2,
		'text_hash'          => TBT_Notes_Expression_Cards::text_hash( 'in the zone' ),
		'text'               => 'in the zone',
		'context'            => 'ctx',
		'polish_translation' => 'w rytmie pracy',
		'example_sentence'   => 'I was in the zone.',
		'status'             => 'approved',
	) );
	TBT_Notes_DB::insert_expression_card( array(
		'lesson_id'          => 2,
		'text_hash'          => TBT_Notes_Expression_Cards::text_hash( 'find your bearings' ),
		'text'               => 'find your bearings',
		'context'            => 'ctx',
		'polish_translation' => 'odnaleźć się',
		'example_sentence'   => 'It took a week to find my bearings.',
		'status'             => 'draft',
	) );
	// "read the room" has no card at all.

	$items = TBT_Notes_Expression_Cards::list_for_lesson( 2, false );
	ok( count( $items ) === 1, 'student sees only the one approved card' );
	ok( $items[0]['text'] === 'in the zone', 'student sees the approved expression' );
	ok( $items[0]['status'] === 'approved', 'student card is approved' );

	$texts = array();
	foreach ( $items as $it ) {
		$texts[] = $it['text'];
	}
	ok( ! in_array( 'find your bearings', $texts, true ), 'draft cards are hidden from students' );
	ok( ! in_array( 'read the room', $texts, true ), 'cardless blue items are hidden from students' );
}
test_expr_student_list();

echo "Expression cards — generation requires a current blue highlight:\n";
function test_expr_generate_guard() {
	TBT_Notes_DB::reset();
	$body = '<p><span class="tbt-hl-blue">in the zone</span>.</p>';
	TBT_Notes_DB::set_lesson( 3, 'Lesson 3', $body );

	// Not a blue highlight in this lesson — must be refused before any API call.
	$err = TBT_Notes_Expression_Cards::generate( 3, 'totally unrelated phrase' );
	ok( is_wp_error( $err ), 'generation refused for non-blue text' );
	ok( $err->get_error_code() === 'tbt_notes_expr_not_blue', 'correct error code for non-blue text' );

	// Overlong text is rejected before the blue check too.
	$long = str_repeat( 'a', 201 );
	$err2 = TBT_Notes_Expression_Cards::generate( 3, $long );
	ok( is_wp_error( $err2 ) && $err2->get_error_code() === 'tbt_notes_expr_too_long', 'overlong expression rejected' );
}
test_expr_generate_guard();

echo "Expression cards — cards deleted with their lesson:\n";
function test_expr_delete_with_lesson() {
	TBT_Notes_DB::reset();
	TBT_Notes_DB::set_lesson( 4, 'Lesson 4', '<p><span class="tbt-hl-blue">in the zone</span></p>' );
	TBT_Notes_DB::insert_expression_card( array(
		'lesson_id'          => 4,
		'text_hash'          => TBT_Notes_Expression_Cards::text_hash( 'in the zone' ),
		'text'               => 'in the zone',
		'context'            => 'ctx',
		'polish_translation' => 'w rytmie pracy',
		'example_sentence'   => 'I was in the zone.',
		'status'             => 'approved',
	) );

	ok( count( TBT_Notes_DB::get_expression_cards_for_lesson( 4 ) ) === 1, 'card exists before deletion' );
	TBT_Notes_DB::delete_expression_cards_for_lesson( 4 );
	ok( count( TBT_Notes_DB::get_expression_cards_for_lesson( 4 ) ) === 0, 'cards removed when the lesson is deleted' );
}
test_expr_delete_with_lesson();

/* ----------------------------------------------- AI Quick Note (logic only) */

/**
 * Invoke a protected static method on the AI Quick Note service.
 *
 * @param string $method Method name.
 * @param array  $args   Positional arguments.
 * @return mixed
 */
function call_ai_static( $method, array $args = array() ) {
	$m = new ReflectionMethod( 'TBT_Notes_AI_Quick_Note', $method );
	$m->setAccessible( true );
	return $m->invokeArgs( null, $args );
}

echo "AI Quick Note — presets:\n";
function test_ai_presets() {
	$choices = TBT_Notes_AI_Quick_Note::preset_choices();
	$keys    = array();
	foreach ( $choices as $c ) {
		$keys[] = $c['key'];
	}
	$expected = array( 'define', 'translate', 'example', 'flashcard', 'questions', 'compare' );
	ok( $keys === $expected, 'all six preset choices are exposed in order' );

	ok( call_ai_static( 'normalize_preset', array( 'Define' ) ) === 'define', 'preset keys are case-insensitive' );
	ok( call_ai_static( 'normalize_preset', array( '  flashcard ' ) ) === 'flashcard', 'preset keys are trimmed' );
	ok( call_ai_static( 'normalize_preset', array( 'nonsense' ) ) === '', 'unknown presets are dropped' );
	ok( call_ai_static( 'normalize_preset', array( '' ) ) === '', 'empty preset is dropped' );
}
test_ai_presets();

echo "AI Quick Note — prompt + answer cleaning:\n";
function test_ai_cleaning() {
	ok( 'a b c' === call_ai_static( 'clean_prompt', array( "a   b\tc" ) ), 'clean_prompt collapses spaces/tabs' );
	ok( 'hello' === call_ai_static( 'clean_prompt', array( '<b>hello</b>' ) ), 'clean_prompt strips tags' );
	ok( "one\n\ntwo" === call_ai_static( 'clean_prompt', array( "one\n\n\n\ntwo" ) ), 'clean_prompt caps blank lines' );

	$ans = call_ai_static( 'clean_answer', array( "  line1  \n\n\n\nline2  \n  " ) );
	ok( "line1\n\nline2" === $ans, 'clean_answer trims, caps blank lines, drops trailing spaces' );
	ok( 'plain' === call_ai_static( 'clean_answer', array( '<p>plain</p>' ) ), 'clean_answer strips markup' );
}
test_ai_cleaning();

echo "AI Quick Note — prompt assembly:\n";
function test_ai_build_prompt() {
	$base = call_ai_static( 'build_user_prompt', array( array( 'prompt' => 'prolific' ) ) );
	ok( contains( $base, 'prolific' ), 'plain prompt is included' );
	ok( ! contains( $base, 'Define this word' ), 'no preset instruction when none chosen' );

	$with = call_ai_static( 'build_user_prompt', array( array( 'prompt' => 'prolific', 'preset' => 'define' ) ) );
	ok( contains( $with, 'Define this word or phrase' ), 'define preset prepends its instruction' );
	ok( contains( $with, 'prolific' ), 'preset prompt still includes the teacher text' );

	$compare = call_ai_static( 'build_user_prompt', array( array(
		'prompt' => 'rule vs principle',
		'preset' => 'compare',
	) ) );
	ok( contains( $compare, 'Compare the two words or expressions' ), 'compare preset prepends its instruction' );
	ok( contains( $compare, 'rule vs principle' ), 'compare prompt still includes the teacher text' );

	$ctx = call_ai_static( 'build_user_prompt', array( array(
		'prompt'        => 'explain',
		'note_title'    => 'Lesson 12',
		'note_context'  => 'some surrounding text',
		'selected_text' => 'ambition',
	) ) );
	ok( contains( $ctx, 'Lesson 12' ), 'note title is included as context' );
	ok( contains( $ctx, 'some surrounding text' ), 'note context is included' );
	ok( contains( $ctx, 'ambition' ), 'selected text is included' );

	$sys = call_ai_static( 'system_instruction', array( 'B1/B2' ) );
	ok( contains( $sys, 'The Blue Tree' ), 'system instruction is The Blue Tree flavoured' );
	ok( contains( $sys, 'B1/B2' ), 'system instruction honours the requested level' );
	$sys_c1 = call_ai_static( 'system_instruction', array( 'C1' ) );
	ok( contains( $sys_c1, 'C1' ), 'system instruction reflects a custom level' );
}
test_ai_build_prompt();

echo "AI Quick Note — request validation (before any API call):\n";
function test_ai_validation() {
	$empty = TBT_Notes_AI_Quick_Note::answer( array( 'prompt' => '   ' ) );
	ok( is_wp_error( $empty ) && $empty->get_error_code() === 'tbt_ai_empty_prompt', 'empty prompt is rejected' );

	$blank = TBT_Notes_AI_Quick_Note::answer( array() );
	ok( is_wp_error( $blank ) && $blank->get_error_code() === 'tbt_ai_empty_prompt', 'missing prompt is rejected' );

	$long = TBT_Notes_AI_Quick_Note::answer( array( 'prompt' => str_repeat( 'a', 2001 ) ) );
	ok( is_wp_error( $long ) && $long->get_error_code() === 'tbt_ai_prompt_too_long', 'overlong prompt is rejected' );
}
test_ai_validation();

/* ----------------------------------------------------------------- Summary */

echo "\n----------------------------------------\n";
echo 'Passed: ' . $GLOBALS['__pass'] . '  Failed: ' . $GLOBALS['__fail'] . "\n";
exit( $GLOBALS['__fail'] > 0 ? 1 : 0 );
