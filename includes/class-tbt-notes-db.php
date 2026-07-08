<?php
/**
 * Data layer for TBT Notes.
 *
 * Custom tables (rather than custom post types) keep the visibility rule the
 * whole security model: nothing leaks through WordPress's public surfaces.
 *
 * A class can have MANY students (a group). Each student belongs to at most one
 * class — enforced by the membership table using user_id as its primary key.
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
	 * Classes table name.
	 *
	 * @return string
	 */
	public static function table_classes() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_classes';
	}

	/**
	 * Lessons table name.
	 *
	 * @return string
	 */
	public static function table_lessons() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_lessons';
	}

	/**
	 * Class/student membership table name.
	 *
	 * @return string
	 */
	public static function table_class_students() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_class_students';
	}

	/**
	 * Pronunciation audio table name.
	 *
	 * @return string
	 */
	public static function table_pronunciations() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_note_pronunciations';
	}

	/**
	 * Expression cards table name.
	 *
	 * @return string
	 */
	public static function table_expression_cards() {
		global $wpdb;
		return $wpdb->prefix . 'tbt_note_expression_cards';
	}

	/**
	 * Create or update the database schema.
	 */
	public static function install() {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate  = $wpdb->get_charset_collate();
		$classes          = self::table_classes();
		$lessons          = self::table_lessons();
		$members          = self::table_class_students();
		$pronunciations   = self::table_pronunciations();
		$expression_cards = self::table_expression_cards();

		$sql_classes = "CREATE TABLE {$classes} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  title varchar(255) NOT NULL DEFAULT '',
  teacher_id bigint(20) unsigned NOT NULL DEFAULT 0,
  student_id bigint(20) unsigned DEFAULT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  KEY teacher_id (teacher_id),
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

		// user_id is the primary key: a student can be in only one class.
		$sql_members = "CREATE TABLE {$members} (
  user_id bigint(20) unsigned NOT NULL,
  class_id bigint(20) unsigned NOT NULL,
  created_at datetime NOT NULL,
  PRIMARY KEY  (user_id),
  KEY class_id (class_id)
) {$charset_collate};";

		// Generated ElevenLabs audio for pink ("Pronunciation") highlights. One
		// row per (lesson, voice, normalised-text hash); the unique key both
		// enforces and powers the cache lookup.
		$sql_pronunciations = "CREATE TABLE {$pronunciations} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  lesson_id bigint(20) unsigned NOT NULL,
  voice_id varchar(64) NOT NULL,
  text_hash varchar(64) NOT NULL,
  text text NOT NULL,
  audio_rel_path text NOT NULL,
  audio_url text NOT NULL,
  mime_type varchar(100) NOT NULL DEFAULT 'audio/mpeg',
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY lesson_voice_text (lesson_id, voice_id, text_hash),
  KEY lesson_id (lesson_id)
) {$charset_collate};";

		// AI-generated English–Polish flashcards for blue ("Useful expression")
		// highlights. One row per (lesson, normalised-text hash); the unique key
		// both enforces and powers the lookup. Cards start as 'draft' and are only
		// shown to students once a teacher sets them 'approved'.
		$sql_expression_cards = "CREATE TABLE {$expression_cards} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  lesson_id bigint(20) unsigned NOT NULL,
  text_hash varchar(64) NOT NULL,
  text text NOT NULL,
  context text NOT NULL,
  polish_translation text NOT NULL,
  example_sentence text NOT NULL,
  level varchar(20) NOT NULL DEFAULT 'B1/B2',
  status varchar(20) NOT NULL DEFAULT 'draft',
  provider varchar(50) NOT NULL DEFAULT 'openai',
  model varchar(100) NOT NULL DEFAULT '',
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY lesson_text (lesson_id, text_hash),
  KEY lesson_id (lesson_id),
  KEY status (status)
) {$charset_collate};";

		dbDelta( $sql_classes );
		dbDelta( $sql_lessons );
		dbDelta( $sql_members );
		dbDelta( $sql_pronunciations );
		dbDelta( $sql_expression_cards );
	}

	/**
	 * One-time migration from the old single-student column to the membership
	 * table. Idempotent: it copies any remaining single assignments, then clears
	 * the legacy column so re-runs do nothing.
	 */
	public static function migrate_single_to_membership() {
		global $wpdb;
		$classes = self::table_classes();
		$members = self::table_class_students();
		$now     = self::now();

		// phpcs:disable WordPress.DB.PreparedSQL.NotPrepared -- table names, static query.
		$wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$members} (user_id, class_id, created_at)
				 SELECT student_id, id, %s FROM {$classes} WHERE student_id IS NOT NULL AND student_id > 0",
				$now
			)
		);
		$wpdb->query( "UPDATE {$classes} SET student_id = NULL WHERE student_id IS NOT NULL" );
		// phpcs:enable WordPress.DB.PreparedSQL.NotPrepared
	}

	/**
	 * Backfill ownership for classes that predate the teacher_id column. Any
	 * class still left unowned (teacher_id = 0) is assigned to $owner_id. Safe to
	 * re-run: it only touches unowned rows, and newly created classes always
	 * carry a real owner.
	 *
	 * @param int $owner_id User ID to claim the unowned classes.
	 * @return int Number of classes updated.
	 */
	public static function assign_orphan_classes_to_owner( $owner_id ) {
		global $wpdb;
		$owner_id = (int) $owner_id;
		if ( $owner_id <= 0 ) {
			return 0;
		}
		$table = self::table_classes();
		// phpcs:disable WordPress.DB.PreparedSQL.NotPrepared -- table name is internal.
		$updated = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET teacher_id = %d WHERE teacher_id = 0",
				$owner_id
			)
		);
		// phpcs:enable WordPress.DB.PreparedSQL.NotPrepared
		return (int) $updated;
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
	 * @return array|null
	 */
	public static function get_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return null;
		}
		$table = self::table_classes();
		$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $class_id ), ARRAY_A );
		return $row ? self::shape_class( $row ) : null;
	}

	/**
	 * All classes, newest first.
	 *
	 * @return array[]
	 */
	public static function get_all_classes() {
		global $wpdb;
		$table = self::table_classes();
		$rows  = $wpdb->get_results( "SELECT * FROM {$table} ORDER BY created_at DESC, id DESC", ARRAY_A );
		return array_map( array( __CLASS__, 'shape_class' ), $rows ? $rows : array() );
	}

	/**
	 * Classes created by a given teacher, newest first. This is the per-teacher
	 * visibility list: a teacher sees only their own classes, never another
	 * teacher's.
	 *
	 * @param int $teacher_id Owner (teacher) user ID.
	 * @return array[]
	 */
	public static function get_classes_for_teacher( $teacher_id ) {
		global $wpdb;
		$teacher_id = (int) $teacher_id;
		if ( $teacher_id <= 0 ) {
			return array();
		}
		$table = self::table_classes();
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE teacher_id = %d ORDER BY created_at DESC, id DESC", $teacher_id ),
			ARRAY_A
		);
		return array_map( array( __CLASS__, 'shape_class' ), $rows ? $rows : array() );
	}

	/**
	 * Create a class owned by a teacher.
	 *
	 * @param string $title      Free-text title.
	 * @param int    $teacher_id Owner (teacher) user ID.
	 * @return int|false New class ID or false.
	 */
	public static function create_class( $title, $teacher_id = 0 ) {
		global $wpdb;
		$now = self::now();
		$ok  = $wpdb->insert(
			self::table_classes(),
			array(
				'title'      => (string) $title,
				'teacher_id' => (int) $teacher_id,
				'created_at' => $now,
				'updated_at' => $now,
			),
			array( '%s', '%d', '%s', '%s' )
		);
		return $ok ? (int) $wpdb->insert_id : false;
	}

	/**
	 * Update a class's title.
	 *
	 * @param int   $class_id Class ID.
	 * @param array $fields   Any of: title.
	 * @return bool
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
		if ( empty( $data ) ) {
			return true;
		}
		$data['updated_at'] = self::now();
		$formats[]          = '%s';

		$result = $wpdb->update( self::table_classes(), $data, array( 'id' => $class_id ), $formats, array( '%d' ) );
		return false !== $result;
	}

	/**
	 * Delete a class, its lessons, and its memberships.
	 *
	 * @param int $class_id Class ID.
	 * @return bool
	 */
	public static function delete_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return false;
		}
		// Clean up pronunciation audio (rows + files) and expression cards for
		// every lesson first.
		foreach ( self::get_lessons_for_class( $class_id ) as $lesson ) {
			self::delete_pronunciations_for_lesson( $lesson['id'] );
			self::delete_expression_cards_for_lesson( $lesson['id'] );
		}
		$wpdb->delete( self::table_lessons(), array( 'class_id' => $class_id ), array( '%d' ) );
		$wpdb->delete( self::table_class_students(), array( 'class_id' => $class_id ), array( '%d' ) );
		$result = $wpdb->delete( self::table_classes(), array( 'id' => $class_id ), array( '%d' ) );
		return false !== $result;
	}

	/* --------------------------------------------------------------------- *
	 * Membership (students in a class)
	 * --------------------------------------------------------------------- */

	/**
	 * IDs of students in a class.
	 *
	 * @param int $class_id Class ID.
	 * @return int[]
	 */
	public static function get_student_ids_for_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return array();
		}
		$table = self::table_class_students();
		$ids   = $wpdb->get_col( $wpdb->prepare( "SELECT user_id FROM {$table} WHERE class_id = %d ORDER BY created_at ASC", $class_id ) );
		return array_map( 'intval', $ids ? $ids : array() );
	}

	/**
	 * Students in a class, shaped for display (id, name, username).
	 *
	 * @param int $class_id Class ID.
	 * @return array[]
	 */
	public static function get_students_for_class( $class_id ) {
		$out = array();
		foreach ( self::get_student_ids_for_class( $class_id ) as $uid ) {
			$user = get_userdata( $uid );
			if ( $user ) {
				$out[] = array(
					'id'       => (int) $uid,
					'name'     => $user->display_name ? $user->display_name : $user->user_login,
					'username' => $user->user_login,
				);
			}
		}
		return $out;
	}

	/**
	 * The class a student belongs to (or null).
	 *
	 * @param int $user_id User ID.
	 * @return array|null Shaped class.
	 */
	public static function get_class_for_student( $user_id ) {
		global $wpdb;
		$user_id = (int) $user_id;
		if ( $user_id <= 0 ) {
			return null;
		}
		$classes = self::table_classes();
		$members = self::table_class_students();
		$row     = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT c.* FROM {$classes} c INNER JOIN {$members} m ON m.class_id = c.id WHERE m.user_id = %d LIMIT 1",
				$user_id
			),
			ARRAY_A
		);
		return $row ? self::shape_class( $row ) : null;
	}

	/**
	 * The class ID a student is currently in (0 if none).
	 *
	 * @param int $user_id User ID.
	 * @return int
	 */
	public static function get_class_id_of_student( $user_id ) {
		global $wpdb;
		$user_id = (int) $user_id;
		if ( $user_id <= 0 ) {
			return 0;
		}
		$table = self::table_class_students();
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT class_id FROM {$table} WHERE user_id = %d", $user_id ) );
	}

	/**
	 * Is a user a student of a class?
	 *
	 * @param int $class_id Class ID.
	 * @param int $user_id  User ID.
	 * @return bool
	 */
	public static function is_student_of_class( $class_id, $user_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		$user_id  = (int) $user_id;
		if ( $class_id <= 0 || $user_id <= 0 ) {
			return false;
		}
		$table = self::table_class_students();
		return (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$table} WHERE class_id = %d AND user_id = %d", $class_id, $user_id ) );
	}

	/**
	 * Add a student to a class.
	 *
	 * @param int $class_id Class ID.
	 * @param int $user_id  User ID.
	 * @return bool
	 */
	public static function add_student_to_class( $class_id, $user_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		$user_id  = (int) $user_id;
		if ( $class_id <= 0 || $user_id <= 0 ) {
			return false;
		}
		$ok = $wpdb->replace(
			self::table_class_students(),
			array(
				'user_id'    => $user_id,
				'class_id'   => $class_id,
				'created_at' => self::now(),
			),
			array( '%d', '%d', '%s' )
		);
		return false !== $ok;
	}

	/**
	 * Remove a student from a class.
	 *
	 * @param int $class_id Class ID.
	 * @param int $user_id  User ID.
	 * @return bool
	 */
	public static function remove_student_from_class( $class_id, $user_id ) {
		global $wpdb;
		$result = $wpdb->delete(
			self::table_class_students(),
			array(
				'class_id' => (int) $class_id,
				'user_id'  => (int) $user_id,
			),
			array( '%d', '%d' )
		);
		return false !== $result;
	}

	/* --------------------------------------------------------------------- *
	 * Lessons
	 * --------------------------------------------------------------------- */

	/**
	 * Fetch a lesson.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return array|null
	 */
	public static function get_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return null;
		}
		$table = self::table_lessons();
		$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $lesson_id ), ARRAY_A );
		return $row ? self::shape_lesson( $row ) : null;
	}

	/**
	 * Lessons for a class, newest first.
	 *
	 * @param int $class_id Class ID.
	 * @return array[]
	 */
	public static function get_lessons_for_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return array();
		}
		$table = self::table_lessons();
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE class_id = %d ORDER BY created_at DESC, id DESC", $class_id ),
			ARRAY_A
		);
		return array_map( array( __CLASS__, 'shape_lesson' ), $rows ? $rows : array() );
	}

	/**
	 * Count the lessons (notes) in a class. Used for the class-card note count.
	 *
	 * @param int $class_id Class ID.
	 * @return int
	 */
	public static function count_lessons_for_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return 0;
		}
		$table = self::table_lessons();
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE class_id = %d", $class_id ) );
	}

	/**
	 * The headers of every lesson in a class. Used to auto-number a new lesson
	 * (max leading integer + 1). Kept lean — no bodies — as it can run on every
	 * lesson creation.
	 *
	 * @param int $class_id Class ID.
	 * @return string[]
	 */
	public static function get_lesson_headers_for_class( $class_id ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return array();
		}
		$table = self::table_lessons();
		$headers = $wpdb->get_col( $wpdb->prepare( "SELECT header FROM {$table} WHERE class_id = %d", $class_id ) );
		return $headers ? array_map( 'strval', $headers ) : array();
	}

	/**
	 * Create a lesson.
	 *
	 * @param int    $class_id Class ID.
	 * @param string $header   Header text.
	 * @param string $body     Sanitised body HTML.
	 * @return int|false
	 */
	public static function create_lesson( $class_id, $header = '', $body = '' ) {
		global $wpdb;
		$class_id = (int) $class_id;
		if ( $class_id <= 0 ) {
			return false;
		}
		$now = self::now();
		$ok  = $wpdb->insert(
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
	 * Update a lesson (autosave target).
	 *
	 * @param int   $lesson_id Lesson ID.
	 * @param array $fields    Any of: header, body.
	 * @return bool
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

		$result = $wpdb->update( self::table_lessons(), $data, array( 'id' => $lesson_id ), $formats, array( '%d' ) );
		return false !== $result;
	}

	/**
	 * Delete a lesson.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return bool
	 */
	public static function delete_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return false;
		}
		self::delete_pronunciations_for_lesson( $lesson_id );
		self::delete_expression_cards_for_lesson( $lesson_id );
		$result = $wpdb->delete( self::table_lessons(), array( 'id' => $lesson_id ), array( '%d' ) );
		return false !== $result;
	}

	/* --------------------------------------------------------------------- *
	 * Pronunciation audio
	 * --------------------------------------------------------------------- */

	/**
	 * Fetch one pronunciation record by its natural key (the cache lookup).
	 *
	 * @param int    $lesson_id Lesson ID.
	 * @param string $voice_id  Voice ID.
	 * @param string $text_hash Normalised-text hash.
	 * @return array|null
	 */
	public static function get_pronunciation( $lesson_id, $voice_id, $text_hash ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return null;
		}
		$table = self::table_pronunciations();
		$row   = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE lesson_id = %d AND voice_id = %s AND text_hash = %s",
				$lesson_id,
				(string) $voice_id,
				(string) $text_hash
			),
			ARRAY_A
		);
		return $row ? self::shape_pronunciation( $row ) : null;
	}

	/**
	 * Fetch one pronunciation record by ID.
	 *
	 * @param int $id Record ID.
	 * @return array|null
	 */
	public static function get_pronunciation_by_id( $id ) {
		global $wpdb;
		$id = (int) $id;
		if ( $id <= 0 ) {
			return null;
		}
		$table = self::table_pronunciations();
		$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $id ), ARRAY_A );
		return $row ? self::shape_pronunciation( $row ) : null;
	}

	/**
	 * All pronunciation records for a lesson.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return array[]
	 */
	public static function get_pronunciations_for_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return array();
		}
		$table = self::table_pronunciations();
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE lesson_id = %d ORDER BY id ASC", $lesson_id ),
			ARRAY_A
		);
		return array_map( array( __CLASS__, 'shape_pronunciation' ), $rows ? $rows : array() );
	}

	/**
	 * Insert a pronunciation record.
	 *
	 * @param array $data lesson_id, voice_id, text_hash, text, audio_rel_path,
	 *                    audio_url, mime_type.
	 * @return int|false New ID or false.
	 */
	public static function insert_pronunciation( array $data ) {
		global $wpdb;
		$now = self::now();
		$ok  = $wpdb->insert(
			self::table_pronunciations(),
			array(
				'lesson_id'      => (int) $data['lesson_id'],
				'voice_id'       => (string) $data['voice_id'],
				'text_hash'      => (string) $data['text_hash'],
				'text'           => (string) $data['text'],
				'audio_rel_path' => (string) $data['audio_rel_path'],
				'audio_url'      => (string) $data['audio_url'],
				'mime_type'      => isset( $data['mime_type'] ) ? (string) $data['mime_type'] : 'audio/mpeg',
				'created_at'     => $now,
				'updated_at'     => $now,
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s' )
		);
		return $ok ? (int) $wpdb->insert_id : false;
	}

	/**
	 * Delete all pronunciation records for a lesson, removing the audio files
	 * too. Used when a lesson (or its class) is deleted.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return void
	 */
	public static function delete_pronunciations_for_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return;
		}
		$records = self::get_pronunciations_for_lesson( $lesson_id );
		if ( $records && function_exists( 'wp_upload_dir' ) ) {
			$upload = wp_upload_dir();
			$base   = ( ! empty( $upload['basedir'] ) ) ? trailingslashit( $upload['basedir'] ) : '';
			foreach ( $records as $rec ) {
				if ( $base && ! empty( $rec['audio_rel_path'] ) ) {
					$path = $base . ltrim( $rec['audio_rel_path'], '/' );
					if ( is_file( $path ) ) {
						@unlink( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.unlink_unlink
					}
				}
			}
		}
		$wpdb->delete( self::table_pronunciations(), array( 'lesson_id' => $lesson_id ), array( '%d' ) );
	}

	/* --------------------------------------------------------------------- *
	 * Expression cards
	 * --------------------------------------------------------------------- */

	/**
	 * Fetch one expression card by its natural key (lesson + normalised-text
	 * hash). This is the cache/lookup key.
	 *
	 * @param int    $lesson_id Lesson ID.
	 * @param string $text_hash Normalised-text hash.
	 * @return array|null
	 */
	public static function get_expression_card( $lesson_id, $text_hash ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return null;
		}
		$table = self::table_expression_cards();
		$row   = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE lesson_id = %d AND text_hash = %s",
				$lesson_id,
				(string) $text_hash
			),
			ARRAY_A
		);
		return $row ? self::shape_expression_card( $row ) : null;
	}

	/**
	 * Fetch one expression card by ID.
	 *
	 * @param int $id Card ID.
	 * @return array|null
	 */
	public static function get_expression_card_by_id( $id ) {
		global $wpdb;
		$id = (int) $id;
		if ( $id <= 0 ) {
			return null;
		}
		$table = self::table_expression_cards();
		$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $id ), ARRAY_A );
		return $row ? self::shape_expression_card( $row ) : null;
	}

	/**
	 * All expression cards for a lesson.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return array[]
	 */
	public static function get_expression_cards_for_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return array();
		}
		$table = self::table_expression_cards();
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE lesson_id = %d ORDER BY id ASC", $lesson_id ),
			ARRAY_A
		);
		return array_map( array( __CLASS__, 'shape_expression_card' ), $rows ? $rows : array() );
	}

	/**
	 * Insert an expression card.
	 *
	 * @param array $data lesson_id, text_hash, text, context, polish_translation,
	 *                    example_sentence, level, status, provider, model.
	 * @return int|false New ID or false.
	 */
	public static function insert_expression_card( array $data ) {
		global $wpdb;
		$now = self::now();
		$ok  = $wpdb->insert(
			self::table_expression_cards(),
			array(
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
				'created_at'         => $now,
				'updated_at'         => $now,
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s' )
		);
		return $ok ? (int) $wpdb->insert_id : false;
	}

	/**
	 * Update an expression card. Accepts any of: text, context,
	 * polish_translation, example_sentence, level, status, provider, model.
	 *
	 * @param int   $id     Card ID.
	 * @param array $fields Fields to update.
	 * @return bool
	 */
	public static function update_expression_card( $id, array $fields ) {
		global $wpdb;
		$id = (int) $id;
		if ( $id <= 0 ) {
			return false;
		}

		$allowed = array(
			'text'               => '%s',
			'context'            => '%s',
			'polish_translation' => '%s',
			'example_sentence'   => '%s',
			'level'              => '%s',
			'status'             => '%s',
			'provider'           => '%s',
			'model'              => '%s',
		);

		$data    = array();
		$formats = array();
		foreach ( $allowed as $key => $format ) {
			if ( array_key_exists( $key, $fields ) ) {
				$data[ $key ] = (string) $fields[ $key ];
				$formats[]    = $format;
			}
		}
		if ( empty( $data ) ) {
			return true;
		}
		$data['updated_at'] = self::now();
		$formats[]          = '%s';

		$result = $wpdb->update( self::table_expression_cards(), $data, array( 'id' => $id ), $formats, array( '%d' ) );
		return false !== $result;
	}

	/**
	 * Delete all expression cards for a lesson. Used when a lesson (or its class)
	 * is deleted.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return void
	 */
	public static function delete_expression_cards_for_lesson( $lesson_id ) {
		global $wpdb;
		$lesson_id = (int) $lesson_id;
		if ( $lesson_id <= 0 ) {
			return;
		}
		$wpdb->delete( self::table_expression_cards(), array( 'lesson_id' => $lesson_id ), array( '%d' ) );
	}

	/* --------------------------------------------------------------------- *
	 * Shaping
	 * --------------------------------------------------------------------- */

	/**
	 * Normalise a class row (without students; load those separately).
	 *
	 * @param array $row Raw row.
	 * @return array
	 */
	protected static function shape_class( array $row ) {
		return array(
			'id'         => (int) $row['id'],
			'title'      => (string) $row['title'],
			'teacher_id' => isset( $row['teacher_id'] ) ? (int) $row['teacher_id'] : 0,
			'created_at' => (string) $row['created_at'],
			'updated_at' => (string) $row['updated_at'],
		);
	}

	/**
	 * Normalise a lesson row.
	 *
	 * @param array $row Raw row.
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

	/**
	 * Normalise a pronunciation row.
	 *
	 * @param array $row Raw row.
	 * @return array
	 */
	protected static function shape_pronunciation( array $row ) {
		return array(
			'id'             => (int) $row['id'],
			'lesson_id'      => (int) $row['lesson_id'],
			'voice_id'       => (string) $row['voice_id'],
			'text_hash'      => (string) $row['text_hash'],
			'text'           => (string) $row['text'],
			'audio_rel_path' => (string) $row['audio_rel_path'],
			'audio_url'      => (string) $row['audio_url'],
			'mime_type'      => (string) $row['mime_type'],
			'created_at'     => (string) $row['created_at'],
			'updated_at'     => (string) $row['updated_at'],
		);
	}

	/**
	 * Normalise an expression card row.
	 *
	 * @param array $row Raw row.
	 * @return array
	 */
	protected static function shape_expression_card( array $row ) {
		return array(
			'id'                 => (int) $row['id'],
			'lesson_id'          => (int) $row['lesson_id'],
			'text_hash'          => (string) $row['text_hash'],
			'text'               => (string) $row['text'],
			'context'            => (string) $row['context'],
			'polish_translation' => (string) $row['polish_translation'],
			'example_sentence'   => (string) $row['example_sentence'],
			'level'              => (string) $row['level'],
			'status'             => (string) $row['status'],
			'provider'           => (string) $row['provider'],
			'model'              => (string) $row['model'],
			'created_at'         => (string) $row['created_at'],
			'updated_at'         => (string) $row['updated_at'],
		);
	}
}
