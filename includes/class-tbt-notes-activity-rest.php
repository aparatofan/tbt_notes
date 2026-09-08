<?php
/**
 * REST API for live activity.
 *
 * Three routes, with three different threat models:
 *
 * - POST /activity is the one untrusted write in this feature. A student posts
 *   their own completed work. Nothing about who they are, which class they are
 *   in, or whose teacher sees it is taken from the payload — all of it is
 *   resolved server-side from the session and the membership table. This
 *   follows TBT_Notes_REST::can_read_lesson(), where the permission callback
 *   proves visibility and the handler re-checks everything it depends on, and
 *   the learning-history write (inc/post-operations.php), whose rule is that
 *   the user is the session and never the request.
 *
 * - GET /activity is the teacher poll, gated on the roster resolver.
 *
 * - POST /activity/presence is a heartbeat that writes to a transient and
 *   never to the database. A twelve-person class beating every twenty seconds
 *   would otherwise produce thousands of worthless rows an hour.
 *
 * Cookie-authenticated requests are nonce protected by WordPress core: an
 * invalid or missing X-WP-Nonce makes rest_cookie_check_errors() reject the
 * request before any callback here runs, which is what makes
 * is_user_logged_in() meaningful in a REST context. That is the same
 * protection every other Notes route relies on, and re-checking a nonce from
 * the body here would both duplicate it and break non-cookie authentication.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Activity_REST
 */
class TBT_Notes_Activity_REST {

	/**
	 * Rows returned by one poll.
	 */
	const POLL_LIMIT = 50;

	/**
	 * How long a heartbeat counts as "still working", in seconds. Three times
	 * the twenty-second beat, so one dropped request does not blank a student.
	 */
	const PRESENCE_TTL = 60;

	/**
	 * Window in which a repeat of the same completion is refused, in seconds.
	 */
	const DUPLICATE_WINDOW = 10;

	/**
	 * Hook route registration.
	 */
	public function register() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Register the activity routes under the plugin namespace.
	 */
	public function register_routes() {
		$ns = TBT_NOTES_REST_NAMESPACE;

		register_rest_route(
			$ns,
			'/activity',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( $this, 'get_activity' ),
					'permission_callback' => array( $this, 'can_read_class_activity' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'create_activity' ),
					'permission_callback' => array( $this, 'require_login' ),
				),
			)
		);

		register_rest_route(
			$ns,
			'/activity/presence',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'post_presence' ),
				'permission_callback' => array( $this, 'require_login' ),
			)
		);
	}

	/* --------------------------------------------------------------------- *
	 * Permission
	 * --------------------------------------------------------------------- */

	/**
	 * Require a logged-in user. No nopriv twin exists for any route here.
	 *
	 * @return true|WP_Error
	 */
	public function require_login() {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'tbt_notes_unauthenticated', __( 'You must be logged in.', 'tbt-notes' ), array( 'status' => 401 ) );
		}
		return true;
	}

	/**
	 * May the current user poll this class?
	 *
	 * Answered by the roster resolver rather than by comparing a teacher_id
	 * here. The no-cache headers are sent from this callback because it runs
	 * before the handler on every request, including the ones that never reach
	 * a handler: a cached 403 is as damaging as a cached feed.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public function can_read_class_activity( WP_REST_Request $request ) {
		$this->no_cache_headers();

		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'tbt_notes_unauthenticated', __( 'You must be logged in.', 'tbt-notes' ), array( 'status' => 401 ) );
		}

		$class_id = (int) $request->get_param( 'class_id' );
		if ( $class_id <= 0 ) {
			return new WP_Error( 'tbt_notes_bad_request', __( 'A class is required.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		if ( ! TBT_Notes_Roster::current_user_may_see_class( $class_id ) ) {
			return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to view this class.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		return true;
	}

	/* --------------------------------------------------------------------- *
	 * Handlers
	 * --------------------------------------------------------------------- */

	/**
	 * Record the current user's completed work.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_activity( WP_REST_Request $request ) {
		$user_id = get_current_user_id();

		// The class and its teacher come from the membership table, never from
		// the payload. A student who is in no class has no teacher to show the
		// work to, so there is nothing to record and nothing to log.
		$class = TBT_Notes_DB::get_class_for_student( $user_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_no_class', __( 'You are not in a class.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		$clean = self::sanitize_payload( (array) $request->get_params() );

		if ( '' === $clean['tool'] || '' === $clean['object_ref'] ) {
			return new WP_Error( 'tbt_notes_bad_request', __( 'A tool and an object reference are required.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// A post reference that does not resolve is dropped rather than
		// refused: the completion really happened, only the link is junk.
		if ( $clean['post_id'] > 0 && ! get_post( $clean['post_id'] ) ) {
			$clean['post_id'] = 0;
		}

		$guard = self::duplicate_key( $user_id, $clean['tool'], $clean['object_ref'] );
		if ( get_transient( $guard ) ) {
			return new WP_Error(
				'tbt_notes_duplicate',
				__( 'That work was just recorded.', 'tbt-notes' ),
				array( 'status' => 429 )
			);
		}

		$user = wp_get_current_user();
		$name = $user ? trim( (string) $user->display_name ) : '';

		$id = TBT_Notes_DB::insert_activity(
			array(
				'user_id'          => $user_id,
				'class_id'         => (int) $class['id'],
				'teacher_id'       => (int) $class['teacher_id'],
				'student_name'     => self::clip( $name, 190 ),
				'tool'             => $clean['tool'],
				'object_ref'       => $clean['object_ref'],
				'object_title'     => $clean['object_title'],
				'post_id'          => $clean['post_id'],
				'event'            => 'completed',
				'score'            => $clean['score'],
				'score_max'        => $clean['score_max'],
				'duration_seconds' => $clean['duration_seconds'],
			)
		);

		if ( ! $id ) {
			return new WP_Error( 'tbt_notes_write_failed', __( 'Could not record that work.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		set_transient( $guard, 1, self::DUPLICATE_WINDOW );

		// The heartbeat stops at completion, so clear the student's presence
		// rather than leaving them reading as "working" for another minute.
		delete_transient( self::presence_key( (int) $class['id'], $user_id ) );

		return rest_ensure_response(
			array(
				'id'       => $id,
				'recorded' => true,
			)
		);
	}

	/**
	 * The class's recent activity, plus who is working right now.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function get_activity( WP_REST_Request $request ) {
		$this->no_cache_headers();

		$class_id = (int) $request->get_param( 'class_id' );
		$since    = self::parse_since( $request->get_param( 'since' ) );

		$rows = TBT_Notes_DB::get_activity_for_class( $class_id, $since['id'], $since['time'], self::POLL_LIMIT );

		// Newest first, so the first row carries the highest ID. On a poll that
		// returns nothing the cursor has to come from the table, or a client
		// starting on a quiet class would re-ask from zero forever.
		$last_id = $rows ? (int) $rows[0]['id'] : TBT_Notes_DB::get_latest_activity_id( $class_id );

		return rest_ensure_response(
			array(
				'class_id'    => $class_id,
				'activity'    => $rows,
				'presence'    => self::presence_for_class( $class_id ),
				'last_id'     => $last_id,
				'server_time' => gmdate( 'Y-m-d H:i:s' ),
			)
		);
	}

	/**
	 * Note that the current user is still working.
	 *
	 * Takes no payload: the user is the session, and the class is whichever
	 * one they belong to. Writes a transient and never a row.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public function post_presence() {
		$user_id = get_current_user_id();

		$class_id = TBT_Notes_DB::get_class_id_of_student( $user_id );
		if ( $class_id <= 0 ) {
			return new WP_Error( 'tbt_notes_no_class', __( 'You are not in a class.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		set_transient( self::presence_key( $class_id, $user_id ), time(), self::PRESENCE_TTL );

		return rest_ensure_response( array( 'ok' => true ) );
	}

	/* --------------------------------------------------------------------- *
	 * Presence storage
	 * --------------------------------------------------------------------- */

	/**
	 * Transient name for one student's heartbeat in one class.
	 *
	 * One key per student rather than one map per class on purpose. A single
	 * per-class transient would have every student in a twelve-person lesson
	 * doing a read-modify-write of the same value every twenty seconds, and
	 * lost updates there read on the panel as a student who stopped working.
	 * Per-student keys cannot collide; the cost is one read per student per
	 * poll, bounded by class size.
	 *
	 * @param int $class_id Class ID.
	 * @param int $user_id  Student user ID.
	 * @return string
	 */
	public static function presence_key( $class_id, $user_id ) {
		return 'tbtn_pres_' . (int) $class_id . '_' . (int) $user_id;
	}

	/**
	 * Guard key for a repeated completion.
	 *
	 * @param int    $user_id    Student user ID.
	 * @param string $tool       Tool slug.
	 * @param string $object_ref Tool's own identifier.
	 * @return string
	 */
	public static function duplicate_key( $user_id, $tool, $object_ref ) {
		return 'tbtn_act_' . md5( (int) $user_id . '|' . $tool . '|' . $object_ref );
	}

	/**
	 * The students in a class with a live heartbeat.
	 *
	 * The transient's own expiry is the test: if it is still there, the beat
	 * was within PRESENCE_TTL seconds.
	 *
	 * @param int $class_id Class ID.
	 * @return int[] User IDs.
	 */
	protected static function presence_for_class( $class_id ) {
		$out = array();
		foreach ( TBT_Notes_DB::get_student_ids_for_class( $class_id ) as $user_id ) {
			if ( get_transient( self::presence_key( $class_id, $user_id ) ) ) {
				$out[] = (int) $user_id;
			}
		}
		return $out;
	}

	/* --------------------------------------------------------------------- *
	 * Input
	 * --------------------------------------------------------------------- */

	/**
	 * Normalise an activity payload.
	 *
	 * Everything the caller may send, and nothing else: user, class, teacher,
	 * name and event are all decided server-side, and `meta` has no producer
	 * yet so it is not accepted from the browser either. Required fields come
	 * back as '' when absent; the caller decides what to do about that.
	 *
	 * @param array $raw Raw request params.
	 * @return array
	 */
	public static function sanitize_payload( array $raw ) {
		return array(
			'tool'             => self::clip( self::slug( $raw['tool'] ?? '' ), 20 ),
			'object_ref'       => self::clip( sanitize_text_field( (string) ( $raw['object_ref'] ?? '' ) ), 64 ),
			'object_title'     => self::clip( sanitize_text_field( (string) ( $raw['object_title'] ?? '' ) ), 190 ),
			'post_id'          => absint( $raw['post_id'] ?? 0 ),
			'score'            => self::nullable_uint( $raw['score'] ?? null ),
			'score_max'        => self::nullable_uint( $raw['score_max'] ?? null ),
			'duration_seconds' => self::nullable_uint( $raw['duration_seconds'] ?? null ),
		);
	}

	/**
	 * Reduce a value to a lowercase slug.
	 *
	 * Not an allowlist: Drag & Drop and Matching Games will post their own
	 * tool names in later phases, and a list here would have to be edited for
	 * each. The column is twenty characters and the shape is fixed, which is
	 * what stops junk without deciding the vocabulary early.
	 *
	 * @param mixed $value Raw value.
	 * @return string
	 */
	protected static function slug( $value ) {
		return preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $value ) );
	}

	/**
	 * A non-negative integer, or null when there is no value to store.
	 *
	 * '' and a missing key both mean "this tool has no such number", which is
	 * not the same claim as zero — a deck completed with a score of 0 is a
	 * real result. Clamped to the column's range so an absurd value cannot
	 * fail the insert.
	 *
	 * @param mixed $value Raw value.
	 * @return int|null
	 */
	protected static function nullable_uint( $value ) {
		if ( null === $value || '' === $value || is_array( $value ) || ! is_numeric( $value ) ) {
			return null;
		}
		return max( 0, min( 4294967295, (int) $value ) );
	}

	/**
	 * Cut a string to a column width without splitting a multibyte character.
	 *
	 * @param string $value Value.
	 * @param int    $limit Maximum length.
	 * @return string
	 */
	protected static function clip( $value, $limit ) {
		$value = (string) $value;
		return function_exists( 'mb_substr' ) ? mb_substr( $value, 0, $limit ) : substr( $value, 0, $limit );
	}

	/**
	 * Read the `since` cursor.
	 *
	 * An integer is a row ID and is exact. Anything else is treated as a UTC
	 * datetime, which is second-resolution and can therefore miss a completion
	 * written in the same second as the cursor — the twelve-students-finish-
	 * together case. Both are supported; a client that has a previous response
	 * should always send back the ID.
	 *
	 * @param mixed $raw Raw parameter.
	 * @return array{id:int,time:string}
	 */
	public static function parse_since( $raw ) {
		$none = array(
			'id'   => 0,
			'time' => '',
		);

		if ( is_array( $raw ) || null === $raw ) {
			return $none;
		}

		$raw = trim( (string) $raw );
		if ( '' === $raw ) {
			return $none;
		}

		if ( ctype_digit( $raw ) ) {
			return array(
				'id'   => (int) $raw,
				'time' => '',
			);
		}

		$ts = strtotime( $raw . ' UTC' );
		if ( false === $ts ) {
			return $none;
		}

		return array(
			'id'   => 0,
			'time' => gmdate( 'Y-m-d H:i:s', $ts ),
		);
	}

	/* --------------------------------------------------------------------- *
	 * Caching
	 * --------------------------------------------------------------------- */

	/**
	 * Defeat LiteSpeed and other page/edge caches for this route.
	 *
	 * Byte-for-byte the approach TBT Swipe uses on its deck endpoint
	 * (class-tbts-rest.php). The LiteSpeed header is the load-bearing one:
	 * its page cache decides for itself and ignores Cache-Control on a
	 * response it has already claimed, and a cached poll would show a teacher
	 * a frozen roster with no way to tell.
	 */
	protected function no_cache_headers() {
		if ( headers_sent() ) {
			return;
		}
		nocache_headers();
		header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0' );
		header( 'X-LiteSpeed-Cache-Control: no-cache' );
	}
}
