<?php
/**
 * Pronunciation audio service for TBT Notes.
 *
 * Turns pink ("Pronunciation") highlights into playable ElevenLabs audio.
 * Generation is teacher-only, manual, server-side, and quota-protected:
 *
 *  - the ElevenLabs key lives server-side only (constant or filter),
 *  - requested text must currently be highlighted pink in the lesson,
 *  - audio is cached (lesson_id + voice_id + normalised-text hash) and reused,
 *  - a per-user hourly rate limit caps accidental spend.
 *
 * Students never reach generation; they only play already-generated files.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Pronunciation
 */
class TBT_Notes_Pronunciation {

	/**
	 * Fixed ElevenLabs voice ID for this plugin.
	 */
	const VOICE_ID = 'UaYTS0wayjmO9KD1LR4R';

	/**
	 * ElevenLabs model.
	 */
	const MODEL_ID = 'eleven_multilingual_v2';

	/**
	 * Max characters allowed for a single pronunciation item.
	 */
	const MAX_TEXT_LENGTH = 200;

	/**
	 * Uploads subfolder for generated audio.
	 */
	const SUBDIR = 'tbt-notes-pronunciation';

	/**
	 * Max generations per user per hour.
	 */
	const RATE_LIMIT = 30;

	/* --------------------------------------------------------------------- *
	 * Configuration
	 * --------------------------------------------------------------------- */

	/**
	 * Resolve the ElevenLabs API key from a PHP constant or a filter. Never
	 * exposed to the front end.
	 *
	 * @return string
	 */
	protected static function elevenlabs_api_key() {
		$key = defined( 'TBT_NOTES_ELEVENLABS_API_KEY' ) ? TBT_NOTES_ELEVENLABS_API_KEY : '';
		/**
		 * Filter the ElevenLabs API key (lets a Code Snippets plugin provide it).
		 *
		 * @param string $key The API key.
		 */
		$key = apply_filters( 'tbt_notes_elevenlabs_api_key', $key );
		return is_string( $key ) ? trim( $key ) : '';
	}

	/**
	 * Whether an API key is configured (without revealing it).
	 *
	 * @return bool
	 */
	public static function has_api_key() {
		return '' !== self::elevenlabs_api_key();
	}

	/* --------------------------------------------------------------------- *
	 * Text helpers (no WordPress dependency — also unit-tested standalone)
	 * --------------------------------------------------------------------- */

	/**
	 * Collapse whitespace runs to single spaces and trim. This is the canonical
	 * form used for comparison, hashing and storage.
	 *
	 * @param string $text Raw text.
	 * @return string
	 */
	public static function normalize_text( $text ) {
		$text = (string) $text;
		$text = preg_replace( '/\s+/u', ' ', $text );
		if ( null === $text ) {
			// preg failure on invalid UTF-8 — fall back to ASCII-only collapse.
			$text = preg_replace( '/\s+/', ' ', (string) $text );
		}
		return trim( (string) $text );
	}

	/**
	 * Stable hash of the normalised text (used for caching + filenames).
	 *
	 * @param string $text Raw text.
	 * @return string SHA-256 hex.
	 */
	public static function text_hash( $text ) {
		return hash( 'sha256', self::normalize_text( $text ) );
	}

	/**
	 * Character length of the normalised text.
	 *
	 * @param string $text Raw text.
	 * @return int
	 */
	protected static function text_length( $text ) {
		$text = self::normalize_text( $text );
		return function_exists( 'mb_strlen' ) ? mb_strlen( $text, 'UTF-8' ) : strlen( $text );
	}

	/**
	 * Is the (normalised) text longer than the allowed limit?
	 *
	 * @param string $text Raw text.
	 * @return bool
	 */
	public static function exceeds_length_limit( $text ) {
		return self::text_length( $text ) > self::MAX_TEXT_LENGTH;
	}

	/* --------------------------------------------------------------------- *
	 * Pink-highlight extraction (server-side source of truth)
	 * --------------------------------------------------------------------- */

	/**
	 * Extract the distinct pink-highlight (tbt-hl-pink) fragments from a lesson
	 * body: text content, normalised, non-empty, de-duplicated, in document
	 * order. Mirrors the client extractor so teacher and server agree.
	 *
	 * @param string $html Lesson body HTML.
	 * @return string[]
	 */
	public static function extract_pink_highlights( $html ) {
		$html = (string) $html;
		if ( '' === trim( $html ) ) {
			return array();
		}

		$raw = class_exists( 'DOMDocument' )
			? self::extract_pink_dom( $html )
			: self::extract_pink_regex( $html );

		$out  = array();
		$seen = array();
		foreach ( $raw as $text ) {
			$norm = self::normalize_text( $text );
			if ( '' === $norm || isset( $seen[ $norm ] ) ) {
				continue;
			}
			$seen[ $norm ] = true;
			$out[]         = $norm;
		}
		return $out;
	}

	/**
	 * DOM-based extraction of pink-highlight text.
	 *
	 * @param string $html Lesson body HTML.
	 * @return string[]
	 */
	protected static function extract_pink_dom( $html ) {
		// Encode non-ASCII as numeric entities so DOMDocument keeps UTF-8.
		$wrapped = '<div data-tbt-root="1">' . $html . '</div>';
		if ( function_exists( 'mb_encode_numericentity' ) ) {
			$wrapped = mb_encode_numericentity( $wrapped, array( 0x80, 0x10FFFF, 0, 0x10FFFF ), 'UTF-8' );
		}

		$dom = new DOMDocument();
		libxml_use_internal_errors( true );
		$dom->loadHTML( $wrapped, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD );
		libxml_clear_errors();

		$xpath = new DOMXPath( $dom );
		$nodes = $xpath->query( "//*[contains(concat(' ', normalize-space(@class), ' '), ' tbt-hl-pink ')]" );

		$out = array();
		if ( $nodes ) {
			foreach ( $nodes as $node ) {
				$out[] = $node->textContent;
			}
		}
		return $out;
	}

	/**
	 * Regex fallback used only when ext-dom is unavailable.
	 *
	 * @param string $html Lesson body HTML.
	 * @return string[]
	 */
	protected static function extract_pink_regex( $html ) {
		$out = array();
		if ( preg_match_all( '/<([a-z0-9]+)\b[^>]*class="[^"]*\btbt-hl-pink\b[^"]*"[^>]*>(.*?)<\/\1>/is', $html, $m ) ) {
			foreach ( $m[2] as $inner ) {
				$inner = preg_replace( '/<[^>]*>/', '', $inner );
				$out[] = html_entity_decode( $inner, ENT_QUOTES, 'UTF-8' );
			}
		}
		return $out;
	}

	/* --------------------------------------------------------------------- *
	 * Uploads folder
	 * --------------------------------------------------------------------- */

	/**
	 * Resolve the audio folder's base dir + URL (without creating it).
	 *
	 * @return array{dir:string,url:string}|null Null if uploads are unavailable.
	 */
	public static function upload_paths() {
		$upload = wp_upload_dir();
		if ( empty( $upload ) || ! empty( $upload['error'] ) || empty( $upload['basedir'] ) ) {
			return null;
		}
		return array(
			'dir' => trailingslashit( $upload['basedir'] ) . self::SUBDIR . '/',
			'url' => trailingslashit( $upload['baseurl'] ) . self::SUBDIR . '/',
		);
	}

	/**
	 * Ensure the audio folder exists (creating it + an index.html guard).
	 *
	 * @return array{dir:string,url:string}|null Null on failure.
	 */
	protected static function ensure_dir() {
		$paths = self::upload_paths();
		if ( ! $paths ) {
			return null;
		}
		if ( ! wp_mkdir_p( $paths['dir'] ) ) {
			return null;
		}
		$index = $paths['dir'] . 'index.html';
		if ( ! file_exists( $index ) ) {
			// Discourage directory listing. Best-effort; ignore failure.
			@file_put_contents( $index, '<!doctype html><title></title>' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		}
		return $paths;
	}

	/* --------------------------------------------------------------------- *
	 * Listing for the REST layer
	 * --------------------------------------------------------------------- */

	/**
	 * Build the pronunciation list for a lesson.
	 *
	 * Teacher: every current pink-highlight item, each flagged with whether
	 * audio exists. Student who may self-generate: the same full list, so they
	 * can generate the ones without audio yet. Read-only student: only current
	 * pink items that already have audio.
	 *
	 * @param int      $lesson_id    Lesson ID.
	 * @param bool     $for_teacher  Whether the viewer can manage notes.
	 * @param bool|null $can_generate Whether the viewer may generate audio. When
	 *                                unspecified, a can-generate viewer is exactly
	 *                                a teacher (back-compat with existing callers).
	 * @return array[]
	 */
	public static function list_for_lesson( $lesson_id, $for_teacher, $can_generate = null ) {
		// Back-compat: when unspecified, a can-generate viewer is exactly a teacher.
		if ( null === $can_generate ) {
			$can_generate = (bool) $for_teacher;
		}

		$lesson = TBT_Notes_DB::get_lesson( (int) $lesson_id );
		if ( ! $lesson ) {
			return array();
		}

		$records = TBT_Notes_DB::get_pronunciations_for_lesson( (int) $lesson_id );
		$by_hash = array();
		foreach ( $records as $rec ) {
			if ( self::VOICE_ID === $rec['voice_id'] ) {
				$by_hash[ $rec['text_hash'] ] = $rec;
			}
		}

		$pink = self::extract_pink_highlights( $lesson['body'] );
		$out  = array();

		foreach ( $pink as $text ) {
			$hash = self::text_hash( $text );
			$rec  = isset( $by_hash[ $hash ] ) ? $by_hash[ $hash ] : null;

			if ( $for_teacher || $can_generate ) {
				// Teachers and can-generate students both see every current pink
				// highlight, with a Generate affordance on the ones without audio.
				$out[] = array(
					'text'         => $text,
					'has_audio'    => (bool) $rec,
					'audio_id'     => $rec ? (int) $rec['id'] : null,
					'audio_url'    => $rec ? $rec['audio_url'] : null,
					'can_generate' => true,
				);
			} elseif ( $rec ) {
				// Read-only students only ever see generated, currently-pink items.
				$out[] = array(
					'text'      => $text,
					'has_audio' => true,
					'audio_url' => $rec['audio_url'],
				);
			}
		}

		return $out;
	}

	/* --------------------------------------------------------------------- *
	 * Generation
	 * --------------------------------------------------------------------- */

	/**
	 * Generate (or reuse cached) audio for one pink-highlight item.
	 *
	 * @param int    $lesson_id Lesson ID.
	 * @param string $text      Requested text (must be a current pink highlight).
	 * @return array|WP_Error Shaped pronunciation record, or an error.
	 */
	public static function generate( $lesson_id, $text ) {
		$lesson_id = (int) $lesson_id;
		$lesson    = TBT_Notes_DB::get_lesson( $lesson_id );
		if ( ! $lesson ) {
			return new WP_Error( 'tbt_notes_not_found', __( 'Lesson not found.', 'tbt-notes' ), array( 'status' => 404 ) );
		}

		$norm = self::normalize_text( $text );
		if ( '' === $norm ) {
			return new WP_Error( 'tbt_notes_pron_empty', __( 'There is no text to generate audio for.', 'tbt-notes' ), array( 'status' => 400 ) );
		}
		if ( self::exceeds_length_limit( $norm ) ) {
			return new WP_Error( 'tbt_notes_pron_too_long', __( 'This pronunciation item is too long to generate audio.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		// Source of truth: the text must currently be a pink highlight.
		if ( ! in_array( $norm, self::extract_pink_highlights( $lesson['body'] ), true ) ) {
			return new WP_Error( 'tbt_notes_pron_not_pink', __( 'This text is no longer marked as a pronunciation item.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		$hash = self::text_hash( $norm );

		// Cache: reuse existing audio, never regenerate.
		$existing = TBT_Notes_DB::get_pronunciation( $lesson_id, self::VOICE_ID, $hash );
		if ( $existing ) {
			return $existing;
		}

		$key = self::elevenlabs_api_key();
		if ( '' === $key ) {
			return new WP_Error( 'tbt_notes_no_api_key', __( 'ElevenLabs API key is not configured.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$rate = self::check_rate_limit();
		if ( is_wp_error( $rate ) ) {
			return $rate;
		}

		$paths = self::ensure_dir();
		if ( ! $paths ) {
			return new WP_Error( 'tbt_notes_pron_dir', __( 'Audio file could not be saved.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$endpoint = 'https://api.elevenlabs.io/v1/text-to-speech/' . rawurlencode( self::VOICE_ID ) . '?output_format=mp3_44100_128';
		$response = wp_remote_post(
			$endpoint,
			array(
				'timeout' => 45,
				'headers' => array(
					'xi-api-key'   => $key,
					'Content-Type' => 'application/json',
					'Accept'       => 'audio/mpeg',
				),
				'body'    => wp_json_encode(
					array(
						'text'          => $norm,
						'model_id'      => self::MODEL_ID,
						'language_code' => 'en',
					)
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'tbt_notes_pron_http', __( 'Could not generate audio. Please try again.', 'tbt-notes' ), array( 'status' => 502 ) );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = wp_remote_retrieve_body( $response );
		if ( 200 !== $code || '' === $body ) {
			return new WP_Error( 'tbt_notes_pron_api', __( 'Could not generate audio. Please try again.', 'tbt-notes' ), array( 'status' => 502 ) );
		}

		// Unguessable filename; no personal data in the name.
		$filename = sanitize_file_name( 'lesson-' . $lesson_id . '-' . substr( $hash, 0, 16 ) . '-' . wp_generate_password( 8, false, false ) . '.mp3' );
		$abs      = $paths['dir'] . $filename;

		$written = file_put_contents( $abs, $body ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		if ( false === $written || ! file_exists( $abs ) ) {
			return new WP_Error( 'tbt_notes_pron_write', __( 'Audio file could not be saved.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		self::bump_rate_limit();

		$record_id = TBT_Notes_DB::insert_pronunciation(
			array(
				'lesson_id'      => $lesson_id,
				'voice_id'       => self::VOICE_ID,
				'text_hash'      => $hash,
				'text'           => $norm,
				'audio_rel_path' => self::SUBDIR . '/' . $filename,
				'audio_url'      => $paths['url'] . $filename,
				'mime_type'      => 'audio/mpeg',
			)
		);

		if ( ! $record_id ) {
			@unlink( $abs ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.unlink_unlink
			return new WP_Error( 'tbt_notes_pron_db', __( 'Audio file could not be saved.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		return TBT_Notes_DB::get_pronunciation_by_id( $record_id );
	}

	/* --------------------------------------------------------------------- *
	 * Rate limiting (per user, per hour)
	 * --------------------------------------------------------------------- */

	/**
	 * Transient key for the current user's hourly counter.
	 *
	 * @return string
	 */
	protected static function rate_key() {
		return 'tbt_notes_pron_rl_' . get_current_user_id();
	}

	/**
	 * Refuse generation if the user is over their hourly quota.
	 *
	 * @return true|WP_Error
	 */
	protected static function check_rate_limit() {
		$count = (int) get_transient( self::rate_key() );
		if ( $count >= self::RATE_LIMIT ) {
			return new WP_Error( 'tbt_notes_pron_rate', __( 'You have reached the hourly audio generation limit. Please try again later.', 'tbt-notes' ), array( 'status' => 429 ) );
		}
		return true;
	}

	/**
	 * Increment the current user's hourly counter.
	 */
	protected static function bump_rate_limit() {
		$key   = self::rate_key();
		$count = (int) get_transient( $key );
		set_transient( $key, $count + 1, HOUR_IN_SECONDS );
	}
}
