<?php
/**
 * REST API for TBT Notes.
 *
 * This is the security boundary. Every route declares a permission callback;
 * read routes additionally verify ownership (the logged-in user is the assigned
 * student of the class, or can manage notes) *before* the handler runs. All
 * writes require the manage capability. Cookie-authenticated requests are nonce
 * protected by WordPress core (X-WP-Nonce).
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_REST
 */
class TBT_Notes_REST {

	/**
	 * Hook route registration.
	 */
	public function register() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Register all routes under the plugin namespace.
	 */
	public function register_routes() {
		$ns = TBT_NOTES_REST_NAMESPACE;

		register_rest_route(
			$ns,
			'/me',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_me' ),
				'permission_callback' => array( $this, 'require_login' ),
			)
		);

		register_rest_route(
			$ns,
			'/students',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_students' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		register_rest_route(
			$ns,
			'/classes',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'create_class' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		register_rest_route(
			$ns,
			'/classes/(?P<id>\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::EDITABLE,
					'callback'            => array( $this, 'update_class' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
				array(
					'methods'             => WP_REST_Server::DELETABLE,
					'callback'            => array( $this, 'delete_class' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
			)
		);

		register_rest_route(
			$ns,
			'/classes/(?P<id>\d+)/lessons',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( $this, 'get_lessons' ),
					'permission_callback' => array( $this, 'can_read_class' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'create_lesson' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
			)
		);

		register_rest_route(
			$ns,
			'/classes/(?P<id>\d+)/students',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'add_student' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		register_rest_route(
			$ns,
			'/classes/(?P<id>\d+)/students/(?P<user_id>\d+)',
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( $this, 'remove_student' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		register_rest_route(
			$ns,
			'/lessons/(?P<id>\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::EDITABLE,
					'callback'            => array( $this, 'update_lesson' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
				array(
					'methods'             => WP_REST_Server::DELETABLE,
					'callback'            => array( $this, 'delete_lesson' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
			)
		);

		// Lesson image upload (Option 1 photo notes). Teacher/admin only, like
		// every other lesson write. Accepts a multipart `file` field.
		register_rest_route(
			$ns,
			'/lessons/(?P<id>\d+)/image',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'upload_lesson_image' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		// Pronunciation audio for pink highlights. Reads follow the lesson's
		// class visibility rule; generation is teacher/admin only.
		register_rest_route(
			$ns,
			'/lessons/(?P<id>\d+)/pronunciations',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( $this, 'get_pronunciations' ),
					'permission_callback' => array( $this, 'can_read_lesson' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'create_pronunciation' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
			)
		);

		// Expression cards for blue ("Useful expression") highlights. Reads follow
		// the lesson's class visibility rule; generation/edit/approve are
		// teacher/admin only.
		register_rest_route(
			$ns,
			'/lessons/(?P<id>\d+)/expression-cards',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( $this, 'get_expression_cards' ),
					'permission_callback' => array( $this, 'can_read_lesson' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'create_expression_card' ),
					'permission_callback' => array( $this, 'require_manage' ),
				),
			)
		);

		register_rest_route(
			$ns,
			'/expression-cards/(?P<id>\d+)',
			array(
				'methods'             => WP_REST_Server::EDITABLE,
				'callback'            => array( $this, 'update_expression_card' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		register_rest_route(
			$ns,
			'/expression-cards/(?P<id>\d+)/approve',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'approve_expression_card' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);

		// AI Quick Note: a teacher asks for short, lesson-friendly help from inside
		// the editor. Server-side only — the OpenAI key never reaches the browser.
		// Teacher/admin only, like every other write/generation route.
		register_rest_route(
			$ns,
			'/ai-quick-note',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'ai_quick_note' ),
				'permission_callback' => array( $this, 'require_manage' ),
			)
		);
	}

	/* --------------------------------------------------------------------- *
	 * Permission callbacks
	 * --------------------------------------------------------------------- */

	/**
	 * Require a logged-in user.
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
	 * Require the manage capability (teacher/admin).
	 *
	 * @return true|WP_Error
	 */
	public function require_manage() {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'tbt_notes_unauthenticated', __( 'You must be logged in.', 'tbt-notes' ), array( 'status' => 401 ) );
		}
		if ( ! TBT_Notes_Capabilities::user_can_manage() ) {
			return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to manage notes.', 'tbt-notes' ), array( 'status' => 403 ) );
		}
		return true;
	}

	/**
	 * Can the current user read the class named in the route? This is the
	 * visibility rule: managers see all; a student sees only their own class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public function can_read_class( WP_REST_Request $request ) {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'tbt_notes_unauthenticated', __( 'You must be logged in.', 'tbt-notes' ), array( 'status' => 401 ) );
		}

		$class_id = (int) $request['id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}

		// Attach membership so the ownership decision is self-contained/testable.
		$class['student_ids'] = TBT_Notes_DB::get_student_ids_for_class( $class_id );

		if ( ! self::user_can_view_class( $class, get_current_user_id() ) ) {
			return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to view this class.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		return true;
	}

	/**
	 * Can the current user read the lesson named in the route? Resolves the
	 * lesson's class and applies the same visibility rule as can_read_class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public function can_read_lesson( WP_REST_Request $request ) {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'tbt_notes_unauthenticated', __( 'You must be logged in.', 'tbt-notes' ), array( 'status' => 401 ) );
		}

		$lesson = TBT_Notes_DB::get_lesson( (int) $request['id'] );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}

		$class = TBT_Notes_DB::get_class( (int) $lesson['class_id'] );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$class['student_ids'] = TBT_Notes_DB::get_student_ids_for_class( (int) $lesson['class_id'] );

		if ( ! self::user_can_view_class( $class, get_current_user_id() ) ) {
			return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to view this lesson.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		return true;
	}

	/**
	 * Can a teacher/admin manage (create-inside, edit, delete) this class? Site
	 * administrators manage every class; an ordinary teacher manages only the
	 * classes they created. This is the ownership rule that keeps one teacher out
	 * of another teacher's classes.
	 *
	 * @param array $class   Shaped class row including a 'teacher_id'.
	 * @param int   $user_id Current user ID.
	 * @return bool
	 */
	public static function user_can_manage_class( $class, $user_id ) {
		$user_id = (int) $user_id;
		if ( $user_id <= 0 || empty( $class ) ) {
			return false;
		}
		if ( ! TBT_Notes_Capabilities::user_can_manage( $user_id ) ) {
			return false;
		}
		// Administrators oversee every class regardless of who created it.
		if ( TBT_Notes_Capabilities::user_can_manage_all( $user_id ) ) {
			return true;
		}
		// A teacher owns only the classes they created.
		return isset( $class['teacher_id'] ) && (int) $class['teacher_id'] === $user_id;
	}

	/**
	 * Core ownership decision used across read paths. Managers see the classes
	 * they own (admins see all); a student sees only the class they belong to.
	 *
	 * @param array $class   Shaped class row including a 'student_ids' array.
	 * @param int   $user_id Current user ID.
	 * @return bool
	 */
	public static function user_can_view_class( $class, $user_id ) {
		$user_id = (int) $user_id;
		if ( $user_id <= 0 || empty( $class ) ) {
			return false;
		}
		if ( TBT_Notes_Capabilities::user_can_manage( $user_id ) ) {
			return self::user_can_manage_class( $class, $user_id );
		}
		$student_ids = isset( $class['student_ids'] ) ? array_map( 'intval', (array) $class['student_ids'] ) : array();
		return in_array( $user_id, $student_ids, true );
	}

	/**
	 * Guard a teacher/admin write against class ownership. Returns null when the
	 * current user may manage the class, or a 403 WP_Error when not. Used by the
	 * write handlers, whose permission callback only proves the manage capability
	 * — this adds the per-class ownership check on top.
	 *
	 * @param array $class Shaped class row including a 'teacher_id'.
	 * @return WP_Error|null
	 */
	protected function guard_class_ownership( $class ) {
		if ( self::user_can_manage_class( $class, get_current_user_id() ) ) {
			return null;
		}
		return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to manage this class.', 'tbt-notes' ), array( 'status' => 403 ) );
	}

	/**
	 * Guard a teacher/admin write on a lesson (or its generated content) against
	 * the ownership of the class the lesson belongs to. Returns null when
	 * allowed, or a WP_Error (403/404) when not.
	 *
	 * @param array $lesson Shaped lesson row including a 'class_id'.
	 * @return WP_Error|null
	 */
	protected function guard_lesson_ownership( $lesson ) {
		$class = TBT_Notes_DB::get_class( (int) $lesson['class_id'] );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		return $this->guard_class_ownership( $class );
	}

	/**
	 * Guard a teacher/admin write on an expression card against the ownership of
	 * the class the card's lesson belongs to. Returns null when allowed (or when
	 * the card/lesson no longer exists, leaving the service to report that), or a
	 * WP_Error (403) when the current user does not own the class.
	 *
	 * @param int $card_id Expression card ID.
	 * @return WP_Error|null
	 */
	protected function guard_card_ownership( $card_id ) {
		$card = TBT_Notes_DB::get_expression_card_by_id( (int) $card_id );
		if ( ! $card ) {
			return null;
		}
		$lesson = TBT_Notes_DB::get_lesson( (int) $card['lesson_id'] );
		if ( ! $lesson ) {
			return null;
		}
		return $this->guard_lesson_ownership( $lesson );
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — reads
	 * --------------------------------------------------------------------- */

	/**
	 * Bootstrap payload for the current user.
	 *
	 * @return WP_REST_Response
	 */
	public function get_me() {
		$is_teacher = TBT_Notes_Capabilities::user_can_manage();

		if ( $is_teacher ) {
			// Administrators oversee every class; an ordinary teacher sees only
			// the classes they created, never another teacher's.
			if ( TBT_Notes_Capabilities::user_can_manage_all() ) {
				$classes = TBT_Notes_DB::get_all_classes();
			} else {
				$classes = TBT_Notes_DB::get_classes_for_teacher( get_current_user_id() );
			}
		} else {
			$own     = TBT_Notes_DB::get_class_for_student( get_current_user_id() );
			$classes = $own ? array( $own ) : array();
		}

		return rest_ensure_response(
			array(
				'is_teacher' => $is_teacher,
				'user_id'    => get_current_user_id(),
				'classes'    => array_map( array( $this, 'present_class' ), $classes ),
			)
		);
	}

	/**
	 * List lessons for a class (newest first). Ownership already verified in
	 * the permission callback.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function get_lessons( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$lessons  = TBT_Notes_DB::get_lessons_for_class( $class_id );

		return rest_ensure_response(
			array(
				'class_id' => $class_id,
				'lessons'  => array_map( array( $this, 'present_lesson' ), $lessons ),
			)
		);
	}

	/**
	 * Search assignable students by username/display name (teacher only).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function get_students( WP_REST_Request $request ) {
		$search = trim( (string) $request->get_param( 'search' ) );
		$number = (int) $request->get_param( 'number' );
		if ( $number <= 0 || $number > 50 ) {
			$number = 20;
		}

		$args = array(
			'orderby' => 'display_name',
			'order'   => 'ASC',
			'number'  => $number,
			'fields'  => array( 'ID', 'display_name', 'user_login', 'user_email' ),
		);
		if ( '' !== $search ) {
			// Search by username, display name, nicename and email.
			$args['search']         = '*' . $search . '*';
			$args['search_columns'] = array( 'user_login', 'display_name', 'user_nicename', 'user_email' );
		}

		$users = get_users( $args );

		$out = array();
		foreach ( $users as $user ) {
			$uid = (int) $user->ID;

			// Teachers/admins are not students; keep them out of the list.
			if ( TBT_Notes_Capabilities::user_can_manage( $uid ) ) {
				continue;
			}

			$assigned_class_id = TBT_Notes_DB::get_class_id_of_student( $uid );
			$assigned_class    = $assigned_class_id ? TBT_Notes_DB::get_class( $assigned_class_id ) : null;

			$out[] = array(
				'id'                  => $uid,
				'name'                => $user->display_name ? $user->display_name : $user->user_login,
				'username'            => $user->user_login,
				'email'               => $user->user_email,
				'assigned_class_id'   => $assigned_class_id ? $assigned_class_id : null,
				'assigned_class_name' => $assigned_class ? $assigned_class['title'] : '',
			);
		}

		return rest_ensure_response( array( 'students' => $out ) );
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — class writes
	 * --------------------------------------------------------------------- */

	/**
	 * Create a class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_class( WP_REST_Request $request ) {
		$title = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'title' ) );

		// Stamp the creating teacher as the owner so only they (and admins) can
		// see and manage the class.
		$new_id = TBT_Notes_DB::create_class( $title, get_current_user_id() );
		if ( ! $new_id ) {
			return new WP_Error( 'tbt_notes_create_failed', __( 'Could not create the class.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$class = TBT_Notes_DB::get_class( $new_id );
		return rest_ensure_response( array( 'class' => $this->present_class( $class ) ) );
	}

	/**
	 * Update a class (rename and/or reassign student).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function update_class( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_class_ownership( $class );
		if ( $denied ) {
			return $denied;
		}

		$fields = array();

		if ( null !== $request->get_param( 'title' ) ) {
			$fields['title'] = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'title' ) );
		}

		$ok = TBT_Notes_DB::update_class( $class_id, $fields );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_update_failed', __( 'Could not update the class.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$class = TBT_Notes_DB::get_class( $class_id );
		return rest_ensure_response( array( 'class' => $this->present_class( $class ) ) );
	}

	/**
	 * Delete a class and its lessons.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function delete_class( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_class_ownership( $class );
		if ( $denied ) {
			return $denied;
		}

		$ok = TBT_Notes_DB::delete_class( $class_id );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_delete_failed', __( 'Could not delete the class.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		return rest_ensure_response( array( 'deleted' => true, 'id' => $class_id ) );
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — class membership
	 * --------------------------------------------------------------------- */

	/**
	 * Add a student to a class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function add_student( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_class_ownership( $class );
		if ( $denied ) {
			return $denied;
		}

		$user_id = (int) $request->get_param( 'user_id' );
		$user    = $user_id > 0 ? get_userdata( $user_id ) : false;
		if ( ! $user ) {
			return new WP_Error( 'tbt_notes_invalid_student', __( 'That student does not exist.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Teachers/admins are not students.
		if ( TBT_Notes_Capabilities::user_can_manage( $user_id ) ) {
			return new WP_Error( 'tbt_notes_invalid_student', __( 'That account manages notes and cannot be assigned as a student.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Enforce one class per student.
		$existing = TBT_Notes_DB::get_class_id_of_student( $user_id );
		if ( $existing && $existing !== $class_id ) {
			$other = TBT_Notes_DB::get_class( $existing );
			return new WP_Error(
				'tbt_notes_student_taken',
				sprintf(
					/* translators: %s: class title. */
					__( 'That student is already in another class (%s). Remove them there first.', 'tbt-notes' ),
					$other && '' !== $other['title'] ? $other['title'] : __( 'Untitled', 'tbt-notes' )
				),
				array( 'status' => 409 )
			);
		}

		TBT_Notes_DB::add_student_to_class( $class_id, $user_id );

		return rest_ensure_response( array( 'students' => TBT_Notes_DB::get_students_for_class( $class_id ) ) );
	}

	/**
	 * Remove a student from a class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function remove_student( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$user_id  = (int) $request['user_id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_class_ownership( $class );
		if ( $denied ) {
			return $denied;
		}

		TBT_Notes_DB::remove_student_from_class( $class_id, $user_id );

		return rest_ensure_response( array( 'students' => TBT_Notes_DB::get_students_for_class( $class_id ) ) );
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — lesson writes
	 * --------------------------------------------------------------------- */

	/**
	 * Create a lesson inside a class.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_lesson( WP_REST_Request $request ) {
		$class_id = (int) $request['id'];
		$class    = TBT_Notes_DB::get_class( $class_id );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_class_ownership( $class );
		if ( $denied ) {
			return $denied;
		}

		$header = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'header' ) );
		$body   = TBT_Notes_Sanitizer::body( (string) $request->get_param( 'body' ) );

		// No header supplied (the "New lesson" flow) → auto-number it: the highest
		// leading integer among this class's existing headers, plus one, followed by
		// today's date. Server-side is authoritative and avoids collisions if two
		// lessons are created in quick succession. The value stays fully editable.
		if ( '' === $header ) {
			$header = self::default_lesson_header( $class_id );
		}

		$new_id = TBT_Notes_DB::create_lesson( $class_id, $header, $body );
		if ( ! $new_id ) {
			return new WP_Error( 'tbt_notes_create_failed', __( 'Could not create the lesson.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$lesson = TBT_Notes_DB::get_lesson( $new_id );
		return rest_ensure_response( array( 'lesson' => $this->present_lesson( $lesson ) ) );
	}

	/**
	 * The auto-generated header for a brand-new lesson: "{number} - {date}", e.g.
	 * "12 - 8 July 2026". The number is one above the highest leading integer among
	 * the class's existing headers (1 when the class is empty or none start with a
	 * digit); the date matches the long form the editor has always used.
	 *
	 * @param int $class_id Class ID.
	 * @return string
	 */
	protected static function default_lesson_header( $class_id ) {
		$headers = TBT_Notes_DB::get_lesson_headers_for_class( $class_id );
		$number  = self::next_lesson_number_from_headers( $headers );
		return $number . ' - ' . self::format_long_date();
	}

	/**
	 * Compute the next lesson number from a set of existing headers: the maximum
	 * leading integer (parsed with ^\s*(\d+)) plus one, or 1 when nothing matches.
	 * Headers whose text does not start with a digit are ignored by design — the
	 * next lesson simply follows the highest numeric header present.
	 *
	 * @param string[] $headers Existing lesson headers.
	 * @return int
	 */
	public static function next_lesson_number_from_headers( array $headers ) {
		$max = 0;
		foreach ( $headers as $header ) {
			if ( preg_match( '/^\s*(\d+)/', (string) $header, $m ) ) {
				$n = (int) $m[1];
				if ( $n > $max ) {
					$max = $n;
				}
			}
		}
		return $max + 1;
	}

	/**
	 * Long English date, e.g. "8 July 2026" — the same format the editor's default
	 * note title has always produced (day, full English month, year), kept in
	 * English regardless of site locale so it reads consistently. Mirrors
	 * formatLongDate() in tbt-notes.js.
	 *
	 * @param int|null $timestamp Unix timestamp; defaults to the site's local time.
	 * @return string
	 */
	public static function format_long_date( $timestamp = null ) {
		if ( null === $timestamp ) {
			$timestamp = function_exists( 'current_time' ) ? (int) current_time( 'timestamp' ) : time();
		}
		$months = array(
			'January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December',
		);
		$day   = (int) gmdate( 'j', $timestamp );
		$month = $months[ (int) gmdate( 'n', $timestamp ) - 1 ];
		$year  = (int) gmdate( 'Y', $timestamp );
		return $day . ' ' . $month . ' ' . $year;
	}

	/**
	 * Update a lesson (header and/or body). This is the autosave endpoint.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function update_lesson( WP_REST_Request $request ) {
		$lesson_id = (int) $request['id'];
		$lesson    = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_lesson_ownership( $lesson );
		if ( $denied ) {
			return $denied;
		}

		$fields = array();
		if ( null !== $request->get_param( 'header' ) ) {
			$fields['header'] = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'header' ) );
		}
		if ( null !== $request->get_param( 'body' ) ) {
			$fields['body'] = TBT_Notes_Sanitizer::body( (string) $request->get_param( 'body' ) );
		}

		$ok = TBT_Notes_DB::update_lesson( $lesson_id, $fields );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_update_failed', __( 'Could not save the lesson.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$lesson = TBT_Notes_DB::get_lesson( $lesson_id );
		return rest_ensure_response(
			array(
				'lesson'    => $this->present_lesson( $lesson ),
				'saved_at'  => $lesson['updated_at'],
			)
		);
	}

	/**
	 * Delete a lesson.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function delete_lesson( WP_REST_Request $request ) {
		$lesson_id = (int) $request['id'];
		$lesson    = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_lesson_ownership( $lesson );
		if ( $denied ) {
			return $denied;
		}

		$ok = TBT_Notes_DB::delete_lesson( $lesson_id );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_delete_failed', __( 'Could not delete the lesson.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		return rest_ensure_response( array( 'deleted' => true, 'id' => $lesson_id ) );
	}

	/**
	 * Upload an image (JPG/PNG) for a lesson and store it in the Media Library.
	 *
	 * Teacher/admin only (permission callback). The uploaded URL is returned so
	 * the editor can embed it; the body sanitiser later confirms the src really is
	 * one of our uploads before it is allowed to persist. Kept deliberately small
	 * and reusable so a future paste-from-clipboard flow can hit the same route.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function upload_lesson_image( WP_REST_Request $request ) {
		$lesson_id = (int) $request['id'];
		$lesson    = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_lesson_ownership( $lesson );
		if ( $denied ) {
			return $denied;
		}

		$files = $request->get_file_params();
		$file  = isset( $files['file'] ) ? $files['file'] : null;

		if ( empty( $file ) || empty( $file['tmp_name'] ) ) {
			return new WP_Error( 'tbt_notes_no_image', __( 'Please choose a JPG or PNG image.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Surface PHP's own upload errors (e.g. file exceeded upload_max_filesize).
		if ( isset( $file['error'] ) && UPLOAD_ERR_OK !== (int) $file['error'] ) {
			$err = (int) $file['error'];
			if ( UPLOAD_ERR_INI_SIZE === $err || UPLOAD_ERR_FORM_SIZE === $err ) {
				return new WP_Error( 'tbt_notes_image_too_large', __( 'The image is too large. Please choose an image under 8 MB.', 'tbt-notes' ), array( 'status' => 400 ) );
			}
			return new WP_Error( 'tbt_notes_upload_failed', __( 'Could not upload the image. Please try again.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Hard size cap: 8 MB. Big enough for phone photos of paper notes.
		$max_bytes = 8 * 1024 * 1024;
		if ( isset( $file['size'] ) && (int) $file['size'] > $max_bytes ) {
			return new WP_Error( 'tbt_notes_image_too_large', __( 'The image is too large. Please choose an image under 8 MB.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Only JPG/PNG, validated by content + extension (not the client-sent type).
		$allowed_mimes = array(
			'jpg|jpeg' => 'image/jpeg',
			'png'      => 'image/png',
		);
		$check = wp_check_filetype_and_ext( $file['tmp_name'], $file['name'], $allowed_mimes );
		if ( empty( $check['ext'] ) || empty( $check['type'] ) || ! in_array( $check['type'], array( 'image/jpeg', 'image/png' ), true ) ) {
			return new WP_Error( 'tbt_notes_bad_image_type', __( 'Please choose a JPG or PNG image.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';

		$overrides = array(
			'test_form' => false,
			'mimes'     => $allowed_mimes,
		);

		$moved = wp_handle_upload( $file, $overrides );
		if ( ! is_array( $moved ) || isset( $moved['error'] ) || empty( $moved['url'] ) || empty( $moved['file'] ) ) {
			return new WP_Error( 'tbt_notes_upload_failed', __( 'Could not upload the image. Please try again.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$title = sanitize_file_name( pathinfo( $file['name'], PATHINFO_FILENAME ) );
		if ( '' === $title ) {
			/* translators: %d: lesson id. */
			$title = sprintf( __( 'Lesson %d image', 'tbt-notes' ), $lesson_id );
		}

		$attachment = array(
			'post_mime_type' => isset( $moved['type'] ) ? $moved['type'] : $check['type'],
			'post_title'     => $title,
			'post_content'   => '',
			'post_status'    => 'inherit',
		);

		// Lessons are custom DB rows, not WP posts, so there is no post parent (0).
		$attach_id = wp_insert_attachment( $attachment, $moved['file'], 0 );
		if ( ! $attach_id || is_wp_error( $attach_id ) ) {
			return new WP_Error( 'tbt_notes_upload_failed', __( 'Could not upload the image. Please try again.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$meta = wp_generate_attachment_metadata( $attach_id, $moved['file'] );
		wp_update_attachment_metadata( $attach_id, $meta );

		// Link the attachment back to its lesson for future housekeeping.
		update_post_meta( $attach_id, '_tbt_notes_lesson_id', $lesson_id );

		$width  = ( is_array( $meta ) && isset( $meta['width'] ) ) ? (int) $meta['width'] : null;
		$height = ( is_array( $meta ) && isset( $meta['height'] ) ) ? (int) $meta['height'] : null;

		return rest_ensure_response(
			array(
				'image' => array(
					'id'     => (int) $attach_id,
					'url'    => wp_get_attachment_url( $attach_id ),
					'alt'    => '',
					'width'  => $width,
					'height' => $height,
				),
			)
		);
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — pronunciation audio
	 * --------------------------------------------------------------------- */

	/**
	 * List pronunciation items for a lesson. Teachers get every current pink
	 * highlight (with a has_audio flag); students get only generated ones.
	 * Ownership already verified in the permission callback.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function get_pronunciations( WP_REST_Request $request ) {
		$lesson_id  = (int) $request['id'];
		$is_teacher = TBT_Notes_Capabilities::user_can_manage();

		$response = array(
			'lesson_id'    => $lesson_id,
			'items'        => TBT_Notes_Pronunciation::list_for_lesson( $lesson_id, $is_teacher ),
			'can_generate' => $is_teacher,
		);

		// Surface key-configuration status to teachers only (never the key).
		if ( $is_teacher ) {
			$response['api_key_configured'] = TBT_Notes_Pronunciation::has_api_key();
		}

		return rest_ensure_response( $response );
	}

	/**
	 * Generate (or reuse cached) audio for one pink-highlight item.
	 * Teacher/admin only (enforced by the permission callback). All validation,
	 * the pink-membership check, caching and the ElevenLabs call live in the
	 * pronunciation service.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_pronunciation( WP_REST_Request $request ) {
		$lesson_id = (int) $request['id'];
		$text      = (string) $request->get_param( 'text' );

		$lesson = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_lesson_ownership( $lesson );
		if ( $denied ) {
			return $denied;
		}

		$record = TBT_Notes_Pronunciation::generate( $lesson_id, $text );
		if ( is_wp_error( $record ) ) {
			return $record;
		}

		return rest_ensure_response(
			array(
				'item' => array(
					'text'         => $record['text'],
					'has_audio'    => true,
					'audio_id'     => (int) $record['id'],
					'audio_url'    => $record['audio_url'],
					'can_generate' => true,
				),
			)
		);
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — expression cards
	 * --------------------------------------------------------------------- */

	/**
	 * List expression-card items for a lesson. Teachers get every current blue
	 * highlight (each flagged with whether a card exists and its contents);
	 * students get only currently-blue highlights with an approved card.
	 * Ownership already verified in the permission callback.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function get_expression_cards( WP_REST_Request $request ) {
		$lesson_id  = (int) $request['id'];
		$is_teacher = TBT_Notes_Capabilities::user_can_manage();

		$response = array(
			'lesson_id'    => $lesson_id,
			'items'        => TBT_Notes_Expression_Cards::list_for_lesson( $lesson_id, $is_teacher ),
			'can_generate' => $is_teacher,
		);

		// Surface key-configuration status to teachers only (never the key).
		if ( $is_teacher ) {
			$response['api_key_configured'] = TBT_Notes_Expression_Cards::has_api_key();
		}

		return rest_ensure_response( $response );
	}

	/**
	 * Generate (or reuse/regenerate) an expression card for one blue-highlight
	 * item. Teacher/admin only. All validation, the blue-membership check and the
	 * OpenAI call live in the expression-card service.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_expression_card( WP_REST_Request $request ) {
		$lesson_id = (int) $request['id'];
		$text      = (string) $request->get_param( 'text' );
		$force     = (bool) $request->get_param( 'force' );

		$lesson = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}
		$denied = $this->guard_lesson_ownership( $lesson );
		if ( $denied ) {
			return $denied;
		}

		$record = TBT_Notes_Expression_Cards::generate( $lesson_id, $text, $force );
		if ( is_wp_error( $record ) ) {
			return $record;
		}

		return rest_ensure_response( array( 'item' => $this->present_expression_card( $record ) ) );
	}

	/**
	 * Update an expression card (translation, example, and/or status). Status is
	 * validated to draft|approved in the service. Teacher/admin only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function update_expression_card( WP_REST_Request $request ) {
		$card_id = (int) $request['id'];

		$denied = $this->guard_card_ownership( $card_id );
		if ( $denied ) {
			return $denied;
		}

		$fields = array();
		if ( null !== $request->get_param( 'polish_translation' ) ) {
			$fields['polish_translation'] = (string) $request->get_param( 'polish_translation' );
		}
		if ( null !== $request->get_param( 'example_sentence' ) ) {
			$fields['example_sentence'] = (string) $request->get_param( 'example_sentence' );
		}
		if ( null !== $request->get_param( 'status' ) ) {
			$fields['status'] = (string) $request->get_param( 'status' );
		}

		$record = TBT_Notes_Expression_Cards::update_card( $card_id, $fields );
		if ( is_wp_error( $record ) ) {
			return $record;
		}

		return rest_ensure_response( array( 'item' => $this->present_expression_card( $record ) ) );
	}

	/**
	 * Approve an expression card (status = approved). Teacher/admin only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function approve_expression_card( WP_REST_Request $request ) {
		$card_id = (int) $request['id'];

		$denied = $this->guard_card_ownership( $card_id );
		if ( $denied ) {
			return $denied;
		}

		$record = TBT_Notes_Expression_Cards::approve_card( $card_id );
		if ( is_wp_error( $record ) ) {
			return $record;
		}

		return rest_ensure_response( array( 'item' => $this->present_expression_card( $record ) ) );
	}

	/* --------------------------------------------------------------------- *
	 * Handlers — AI Quick Note
	 * --------------------------------------------------------------------- */

	/**
	 * Generate a short, lesson-friendly AI answer for a teacher prompt. The
	 * OpenAI call, validation and rate limiting all live in the service; the key
	 * is only ever read server-side. Teacher/admin only (permission callback).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function ai_quick_note( WP_REST_Request $request ) {
		$result = TBT_Notes_AI_Quick_Note::answer(
			array(
				'prompt'        => (string) $request->get_param( 'prompt' ),
				'preset'        => (string) $request->get_param( 'preset' ),
				'level'         => (string) $request->get_param( 'level' ),
				'selected_text' => (string) $request->get_param( 'selectedText' ),
				'note_title'    => (string) $request->get_param( 'noteTitle' ),
				'note_context'  => (string) $request->get_param( 'noteContext' ),
			)
		);

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return rest_ensure_response(
			array(
				'success' => true,
				'answer'  => $result['answer'],
			)
		);
	}

	/* --------------------------------------------------------------------- *
	 * Helpers
	 * --------------------------------------------------------------------- */

	/**
	 * Shape an expression-card record for the teacher UI.
	 *
	 * @param array $record Shaped card row.
	 * @return array
	 */
	protected function present_expression_card( $record ) {
		return array(
			'text'               => $record['text'],
			'has_card'           => true,
			'card_id'            => (int) $record['id'],
			'polish_translation' => $record['polish_translation'],
			'example_sentence'   => $record['example_sentence'],
			'level'              => $record['level'],
			'status'             => $record['status'],
			'can_generate'       => true,
		);
	}

	/**
	 * Shape a class for output. The student roster is only exposed to managers.
	 *
	 * @param array $class Shaped class row.
	 * @return array
	 */
	protected function present_class( $class ) {
		$out = array(
			'id'    => (int) $class['id'],
			'title' => $class['title'],
		);

		// Only teachers need to see who is in a class. The class-card grid is a
		// teacher-only surface, so the student/note counts ride along here.
		if ( TBT_Notes_Capabilities::user_can_manage() ) {
			$students             = TBT_Notes_DB::get_students_for_class( (int) $class['id'] );
			$out['students']      = $students;
			$out['student_count'] = count( $students );
			$out['note_count']    = TBT_Notes_DB::count_lessons_for_class( (int) $class['id'] );
		}

		return $out;
	}

	/**
	 * Shape a lesson for output.
	 *
	 * @param array $lesson Shaped lesson row.
	 * @return array
	 */
	protected function present_lesson( $lesson ) {
		return array(
			'id'         => (int) $lesson['id'],
			'class_id'   => (int) $lesson['class_id'],
			'header'     => $lesson['header'],
			'body'       => $lesson['body'],
			'created_at' => $lesson['created_at'],
			'updated_at' => $lesson['updated_at'],
		);
	}
}
