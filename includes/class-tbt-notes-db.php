<?php
/**
 * Data layer for TBT Notes.
 *
 * Owns the custom tables and every query against them. Custom tables (rather
 * than custom post types) are deliberate: the visibility rule is the whole
 * security model, and custom tables expose nothing through WordPress's public
 * surfaces (REST, search, archives, feeds, sitemaps). Every read goes through
 * one ownership check.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_DB
 */
class TBT_Notes_DB {

	/**
	 * Fully-qualified classes table name.
	 *
	 * @return string
	 */
	public static function table_classes() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_classes';
	}

	/**
	 * Fully-qualified lessons table name.
	 *
	 * @return string
	 */
	public static function table_lessons() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_lessons';
	}

	/**
	 * Create or update the database schema.
	 */
	public static function install() {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$classes         = self::table_classes();
		$lessons         = self::table_lessons();

		// Note: dbDelta is whitespace/format sensitive (two spaces after
		// PRIMARY KEY, each definition on its own line).
		$sql_classes = "CREATE TABLE {$classes} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  title varchar(255) NOT NULL DEFAULT '',
  student_id bigint(20) unsigned DEFAULT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY student_id (student_id),
  KEY created_at (created_at)
) {$charset_collate};";

		$sql_lessons = "CREATE TABLE {$lessons} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  class_id bigint(20) unsigned NOT NULL,
  header varchar(255) NOT NULL DEFAULT '',
  body longtext NOT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  KEY class_id (class_id),
  KEY class_order (class_id, created_at)
) {$charset_collate};";

		dbDelta( $sql_classes );
		dbDelta( $sql_lessons );
	}

	/**
	 * Current GMT timestamp in MySQL format.
	 *
	 * @return string
	 */
	protected static function now() {
		return gmdate( 'Y-m-d H:i:s' );
	}

	/* --------------------------------------------------------------------- *
	 * Classes
	 * --------------------------------------------------------------------- */

	/**
	 * Fetch a single class row by ID.
	 *
	 * @param int $class_id Class ID.
	 * @return array|null Raw row as associative array, or null if not found.
	 */
	public static function get_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return null;
		}
		$table = self::table_classes();
		$row   = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $class_id ),
			ARRAY_A
		);
		return $row ? self::shape_class( $row ) : null;
	}

	/**
	 * Fetch all classes (teacher view), newest first.
	 *
	 * @return array[] List of shaped class rows.
	 */
	public static function get_all_classes() {
		global $wpdb;
		$table = self::table_classes();
		$rows  = $wpdb->get_results( "SELECT * FROM {$table} ORDER BY created_at DESC, id DESC", ARRAY_A );
		return array_map( array( __CLASS__, 'shape_class' ), $rows ? $rows : array() );
	}

	/**
	 * Fetch the single class assigned to a given student, if any.
	 *
	 * @param int $student_id WordPress user ID.
	 * @return array|null Shaped class row or null.
	 */
	public static function get_class_for_student( $student_id ) {
		global $wpdb;
		$student_id = (int) $student_id;
		if ( $student_id <= 0 ) {
			return null;
		}
		$table = self::table_classes();
		$row   = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE student_id = %d LIMIT 1", $student_id ),
			ARRAY_A
		);
		return $row ? self::shape_class( $row ) : null;
	}

	/**
	 * Find the class currently assigned to a student, excluding one class ID.
	 * Used to enforce the "one student per class" invariant before assigning.
	 *
	 * @param int $student_id       WordPress user ID.
	 * @param int $exclude_class_id Class ID to ignore (the one being edited).
	 * @return array|null Shaped class row of the conflicting class, or null.
	 */
	public static function get_conflicting_class_for_student( $student_id, $exclude_class_id = 0 ) {
		global $wpdb;
		$student_id       = (int) $student_id;
		$exclude_class_id = (int) $exclude_class_id;
		if ( $student_id <= 0 ) {
			return null;
		}
		$table = self::table_classes();
		$row   = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE student_id = %d AND id <> %d LIMIT 1",
				$student_id,
				$exclude_class_id
			),
			ARRAY_A
		);
		return $row ? self::shape_class( $row ) : null;
	}

	/**
	 * Create a class.
	 *
	 * @param string   $title      Free-text class title.
	 * @param int|null $student_id Assigned student user ID, or null/0 for none.
	 * @return int|false New class ID on success, false on failure.
	 */
	public static function create_class( $title, $student_id = null ) {
		global $wpdb;
		$now        = self::now();
		$student_id = $student_id ? (int) $student_id : null;

		$ok = $wpdb->insert(
			self::table_classes(),
			array(
				'title'      => $title,
				'student_id' => $student_id,
				'created_at' => $now,
				'updated_at' => $now,
			),
			array( '%s', $student_id === null ? '%s' : '%d', '%s', '%s' )
		);

		return $ok ? (int) $wpdb->insert_id : false;
	}

	/**
	 * Update a class's title and/or assigned student.
	 *
	 * @param int   $class_id Class ID.
	 * @param array $fields   Associative array, any of: title, student_id.
	 *                        Pass student_id = null to unassign.
	 * @return bool True on success.
	 */
	public static function update_class( $class_id, array $fields ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return false;
		}

		$data    = array();
		$formats = array();

		if ( array_key_exists( 'title', $fields ) ) {
			$data['title'] = (string) $fields['title'];
			$formats[]     = '%s';
		}
		if ( array_key_exists( 'student_id', $fields ) ) {
			$student_id          = $fields['student_id'] ? (int) $fields['student_id'] : null;
			$data['student_id']  = $student_id;
			$formats[]           = $student_id === null ? '%s' : '%d'; // null written as NULL.
		}

		if ( empty( $data ) ) {
			return true; // Nothing to change.
		}

		$data['updated_at'] = self::now();
		$formats[]          = '%s';

		$result = $wpdb->update(
			self::table_classes(),
			$data,
			array( 'id' => $class_id ),
			$formats,
			array( '%d' )
		);

		return false !== $result;
	}

	/**
	 * Delete a class and all of its lessons.
	 *
	 * @param int $class_id Class ID.
	 * @return bool True on success.
	 */
	public static function delete_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return false;
		}

		// Remove child lessons first to avoid orphans.
		$wpdb->delete( self::table_lessons(), array( 'class_id' => $class_id ), array( '%d' ) );
		$result = $wpdb->delete( self::table_classes(), array( 'id' => $class_id ), array( '%d' ) );

		return false !== $result;
	}

	/* --------------------------------------------------------------------- *
	 * Lessons
	 * --------------------------------------------------------------------- */

	/**
	 * Fetch a single lesson row by ID.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return array|null Shaped lesson row or null.
	 */
	public static function get_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return null;
		}
		$table = self::table_lessons();
		$row   = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $lesson_id ),
			ARRAY_A
		);
		return $row ? self::shape_lesson( $row ) : null;
	}

	/**
	 * Fetch all lessons for a class, ordered latest first.
	 *
	 * @param int $class_id Class ID.
	 * @return array[] List of shaped lesson rows.
	 */
	public static function get_lessons_for_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return array();
		}
		$table = self::table_lessons();
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE class_id = %d ORDER BY created_at DESC, id DESC",
				$class_id
			),
			ARRAY_A
		);
		return array_map( array( __CLASS__, 'shape_lesson' ), $rows ? $rows : array() );
	}

	/**
	 * Create an (initially empty) lesson inside a class.
	 *
	 * @param int    $class_id Class ID.
	 * @param string $header   Optional header text.
	 * @param string $body     Optional sanitized body HTML.
	 * @return int|false New lesson ID or false.
	 */
	public static function create_lesson( $class_id, $header = '', $body = '' ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return false;
		}
		$now = self::now();

		$ok = $wpdb->insert(
			self::table_lessons(),
			array(
				'class_id'   => $class_id,
				'header'     => (string) $header,
				'body'       => (string) $body,
				'created_at' => $now,
				'updated_at' => $now,
			),
			array( '%d', '%s', '%s', '%s', '%s' )
		);

		return $ok ? (int) $wpdb->insert_id : false;
	}

	/**
	 * Update a lesson's header and/or body. This is the autosave target.
	 *
	 * @param int   $lesson_id Lesson ID.
	 * @param array $fields    Any of: header, body.
	 * @return bool True on success.
	 */
	public static function update_lesson( $lesson_id, array $fields ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return false;
		}

		$data    = array();
		$formats = array();

		if ( array_key_exists( 'header', $fields ) ) {
			$data['header'] = (string) $fields['header'];
			$formats[]      = '%s';
		}
		if ( array_key_exists( 'body', $fields ) ) {
			$data['body'] = (string) $fields['body'];
			$formats[]    = '%s';
		}

		if ( empty( $data ) ) {
			return true;
		}

		$data['updated_at'] = self::now();
		$formats[]          = '%s';

		$result = $wpdb->update(
			self::table_lessons(),
			$data,
			array( 'id' => $lesson_id ),
			$formats,
			array( '%d' )
		);

		return false !== $result;
	}

	/**
	 * Delete a single lesson.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return bool True on success.
	 */
	public static function delete_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return false;
		}
		$result = $wpdb->delete( self::table_lessons(), array( 'id' => $lesson_id ), array( '%d' ) );
		return false !== $result;
	}

	/* --------------------------------------------------------------------- *
	 * Shaping
	 * --------------------------------------------------------------------- */

	/**
	 * Normalise a raw class row into typed values plus derived display fields.
	 *
	 * @param array $row Raw DB row.
	 * @return array
	 */
	protected static function shape_class( array $row ) {
		$student_id   = isset( $row['student_id'] ) && null !== $row['student_id'] ? (int) $row['student_id'] : null;
		$student_name = '';
		if ( $student_id ) {
			$user = get_userdata( $student_id );
			if ( $user ) {
				$student_name = $user->display_name;
			}
		}

		return array(
			'id'           => (int) $row['id'],
			'title'        => (string) $row['title'],
			'student_id'   => $student_id,
			'student_name' => $student_name,
			'created_at'   => (string) $row['created_at'],
			'updated_at'   => (string) $row['updated_at'],
		);
	}

	/**
	 * Normalise a raw lesson row into typed values.
	 *
	 * @param array $row Raw DB row.
	 * @return array
	 */
	protected static function shape_lesson( array $row ) {
		return array(
			'id'         => (int) $row['id'],
			'class_id'   => (int) $row['class_id'],
			'header'     => (string) $row['header'],
			'body'       => (string) $row['body'],
			'created_at' => (string) $row['created_at'],
			'updated_at' => (string) $row['updated_at'],
		);
	}
}
