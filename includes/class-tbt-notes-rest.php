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

		$class = TBT_Notes_DB::get_class( (int) $request['id'] );
		if ( ! $class ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Class not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}

		if ( ! self::user_can_view_class( $class, get_current_user_id() ) ) {
			return new WP_Error( 'tbt_notes_forbidden', __( 'You are not allowed to view this class.', 'tbt-notes' ), array( 'status' => 403 ) );
		}

		return true;
	}

	/**
	 * Core ownership decision used across read paths.
	 *
	 * @param array $class   Shaped class row.
	 * @param int   $user_id Current user ID.
	 * @return bool
	 */
	public static function user_can_view_class( $class, $user_id ) {
		$user_id = (int) $user_id;
		if ( $user_id <= 0 || empty( $class ) ) {
			return false;
		}
		if ( TBT_Notes_Capabilities::user_can_manage( $user_id ) ) {
			return true;
		}
		return isset( $class['student_id'] ) && (int) $class['student_id'] === $user_id;
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
			$classes = TBT_Notes_DB::get_all_classes();
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

		// Map of student_id => class currently assigned, to flag taken users.
		$assigned = array();
		foreach ( TBT_Notes_DB::get_all_classes() as $class ) {
			if ( ! empty( $class['student_id'] ) ) {
				$assigned[ (int) $class['student_id'] ] = $class;
			}
		}

		$args = array(
			'orderby' => 'display_name',
			'order'   => 'ASC',
			'number'  => $number,
			'fields'  => array( 'ID', 'display_name', 'user_login' ),
		);
		if ( '' !== $search ) {
			$args['search']         = '*' . $search . '*';
			$args['search_columns'] = array( 'user_login', 'display_name', 'user_nicename' );
		}

		$users = get_users( $args );

		$out = array();
		foreach ( $users as $user ) {
			// Teachers/admins are not students; keep them out of the list.
			if ( TBT_Notes_Capabilities::user_can_manage( (int) $user->ID ) ) {
				continue;
			}
			$uid          = (int) $user->ID;
			$assigned_row = isset( $assigned[ $uid ] ) ? $assigned[ $uid ] : null;
			$out[]        = array(
				'id'                  => $uid,
				'name'                => $user->display_name ? $user->display_name : $user->user_login,
				'username'            => $user->user_login,
				'assigned_class_id'   => $assigned_row ? (int) $assigned_row['id'] : null,
				'assigned_class_name' => $assigned_row ? $assigned_row['title'] : '',
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
		$title      = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'title' ) );
		$student_id = $this->resolve_student_id( $request->get_param( 'student_id' ) );

		if ( is_wp_error( $student_id ) ) {
			return $student_id;
		}

		if ( $student_id ) {
			$conflict = TBT_Notes_DB::get_conflicting_class_for_student( $student_id, 0 );
			if ( $conflict ) {
				return $this->student_conflict_error( $conflict );
			}
		}

		$new_id = TBT_Notes_DB::create_class( $title, $student_id );
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

		$fields = array();

		if ( null !== $request->get_param( 'title' ) ) {
			$fields['title'] = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'title' ) );
		}

		if ( $request->has_param( 'student_id' ) ) {
			$student_id = $this->resolve_student_id( $request->get_param( 'student_id' ) );
			if ( is_wp_error( $student_id ) ) {
				return $student_id;
			}
			if ( $student_id ) {
				$conflict = TBT_Notes_DB::get_conflicting_class_for_student( $student_id, $class_id );
				if ( $conflict ) {
					return $this->student_conflict_error( $conflict );
				}
			}
			$fields['student_id'] = $student_id; // May be null to unassign.
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

		$ok = TBT_Notes_DB::delete_class( $class_id );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_delete_failed', __( 'Could not delete the class.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		return rest_ensure_response( array( 'deleted' => true, 'id' => $class_id ) );
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

		$header = TBT_Notes_Sanitizer::text( (string) $request->get_param( 'header' ) );
		$body   = TBT_Notes_Sanitizer::body( (string) $request->get_param( 'body' ) );

		$new_id = TBT_Notes_DB::create_lesson( $class_id, $header, $body );
		if ( ! $new_id ) {
			return new WP_Error( 'tbt_notes_create_failed', __( 'Could not create the lesson.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$lesson = TBT_Notes_DB::get_lesson( $new_id );
		return rest_ensure_response( array( 'lesson' => $this->present_lesson( $lesson ) ) );
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

		$ok = TBT_Notes_DB::delete_lesson( $lesson_id );
		if ( ! $ok ) {
			return new WP_Error( 'tbt_notes_delete_failed', __( 'Could not delete the lesson.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		return rest_ensure_response( array( 'deleted' => true, 'id' => $lesson_id ) );
	}

	/* --------------------------------------------------------------------- *
	 * Helpers
	 * --------------------------------------------------------------------- */

	/**
	 * Validate and normalise a student_id parameter.
	 *
	 * @param mixed $raw Raw param value.
	 * @return int|null|WP_Error Integer user ID, null (unassigned), or error.
	 */
	protected function resolve_student_id( $raw ) {
		if ( null === $raw || '' === $raw || 0 === $raw || '0' === $raw ) {
			return null;
		}
		$student_id = (int) $raw;
		if ( $student_id <= 0 || ! get_userdata( $student_id ) ) {
			return new WP_Error( 'tbt_notes_invalid_student', __( 'That student does not exist.', 'tbt-notes' ), array( 'status' => 400 ) );
		}
		return $student_id;
	}

	/**
	 * Build a 409 error describing a one-student-per-class conflict.
	 *
	 * @param array $conflict The class the student is already assigned to.
	 * @return WP_Error
	 */
	protected function student_conflict_error( $conflict ) {
		return new WP_Error(
			'tbt_notes_student_taken',
			sprintf(
				/* translators: %s: class title. */
				__( 'That student is already assigned to another class (%s). Unassign them there first.', 'tbt-notes' ),
				$conflict['title'] !== '' ? $conflict['title'] : __( 'Untitled', 'tbt-notes' )
			),
			array(
				'status'            => 409,
				'conflict_class_id' => (int) $conflict['id'],
			)
		);
	}

	/**
	 * Shape a class for output. Student identity is only exposed to managers.
	 *
	 * @param array $class Shaped class row.
	 * @return array
	 */
	protected function present_class( $class ) {
		$is_teacher = TBT_Notes_Capabilities::user_can_manage();

		$out = array(
			'id'    => (int) $class['id'],
			'title' => $class['title'],
		);

		// Only teachers need to see who a class is assigned to.
		if ( $is_teacher ) {
			$out['student_id']   = $class['student_id'];
			$out['student_name'] = $class['student_name'];
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
