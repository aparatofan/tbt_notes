<?php
/**
 * AI Quick Note service for TBT Notes.
 *
 * Powers the in-editor "✨ Ask AI" panel (opened by typing `/ai` or clicking the
 * toolbar button). The teacher types a short prompt during a live lesson and gets
 * a concise, lesson-friendly answer back to paste into the note.
 *
 * Design mirrors the pink Pronunciation and blue Expression-card services:
 *
 *  - the request is teacher-only and runs entirely server-side,
 *  - the OpenAI key lives server-side only (constant or filter) and is never
 *    printed, logged, localized, or sent to the browser,
 *  - the front end calls the WordPress REST endpoint, which calls OpenAI,
 *  - a per-user hourly rate limit caps accidental spend.
 *
 * Unlike the expression cards, the answer is free-form text (not stored): it is
 * generated on demand and either inserted into the note or discarded by the
 * teacher.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_AI_Quick_Note
 */
class TBT_Notes_AI_Quick_Note {

	/**
	 * Max characters allowed for a single prompt.
	 */
	const MAX_PROMPT_LENGTH = 2000;

	/**
	 * Max characters of surrounding-note context accepted from the client. The
	 * context only ever sharpens the answer, so an overlong value is trimmed
	 * rather than rejected.
	 */
	const MAX_CONTEXT_LENGTH = 4000;

	/**
	 * Max AI requests per logged-in user per hour (spec §12).
	 */
	const RATE_LIMIT = 20;

	/**
	 * Default CEFR level used when the client does not specify one.
	 */
	const DEFAULT_LEVEL = 'B1/B2';

	/* --------------------------------------------------------------------- *
	 * Configuration
	 *
	 * Per the project's "API key handling" decision, this feature reads its own
	 * TBT_AI_QUICK_NOTE_API_KEY / TBT_AI_QUICK_NOTE_MODEL constants (defined in a
	 * server-side PHP snippet). For convenience on installs that already wired up
	 * the shared TBT_NOTES_OPENAI_API_KEY for expression cards, we fall back to
	 * that constant/filter so a teacher does not have to configure two keys.
	 * --------------------------------------------------------------------- */

	/**
	 * Resolve the OpenAI API key. Never exposed to the front end.
	 *
	 * @return string
	 */
	protected static function api_key() {
		$key = '';
		if ( defined( 'TBT_AI_QUICK_NOTE_API_KEY' ) ) {
			$key = TBT_AI_QUICK_NOTE_API_KEY;
		} elseif ( defined( 'TBT_NOTES_OPENAI_API_KEY' ) ) {
			// Fall back to the shared key used by the expression-card service.
			$key = TBT_NOTES_OPENAI_API_KEY;
		}

		/**
		 * Filter the AI Quick Note OpenAI API key (lets a Code Snippets plugin
		 * provide it). Defaults to the shared expression-card key filter so a
		 * single configured key powers every AI feature.
		 *
		 * @param string $key The API key.
		 */
		$key = apply_filters( 'tbt_ai_quick_note_api_key', apply_filters( 'tbt_notes_openai_api_key', $key ) );

		// Guard against the documentation placeholder being left in place.
		$key = is_string( $key ) ? trim( $key ) : '';
		if ( 'PASTE_TBT_AI_QUICK_NOTE_KEY_HERE' === $key ) {
			return '';
		}
		return $key;
	}

	/**
	 * Whether an API key is configured (without revealing it).
	 *
	 * @return bool
	 */
	public static function has_api_key() {
		return '' !== self::api_key();
	}

	/**
	 * Resolve the OpenAI model. Defaults to gpt-4.1-mini per the project decision.
	 *
	 * @return string
	 */
	protected static function model() {
		$model = '';
		if ( defined( 'TBT_AI_QUICK_NOTE_MODEL' ) ) {
			$model = TBT_AI_QUICK_NOTE_MODEL;
		} elseif ( defined( 'TBT_NOTES_OPENAI_MODEL' ) ) {
			$model = TBT_NOTES_OPENAI_MODEL;
		}
		$model = is_string( $model ) ? trim( $model ) : '';
		if ( '' === $model ) {
			$model = 'gpt-4.1-mini';
		}

		/**
		 * Filter the OpenAI model used for AI Quick Note.
		 *
		 * @param string $model The model identifier.
		 */
		$model = apply_filters( 'tbt_ai_quick_note_model', $model );
		return is_string( $model ) && '' !== trim( $model ) ? trim( $model ) : 'gpt-4.1-mini';
	}

	/* --------------------------------------------------------------------- *
	 * Presets
	 *
	 * Each preset adds a focused instruction in front of the teacher's text. The
	 * front end only ever sends the preset *key*; the wording lives here so it
	 * can be tuned without touching the client. Keep keys in sync with
	 * preset_choices() (exposed to the UI).
	 * --------------------------------------------------------------------- */

	/**
	 * Instruction fragment for each supported preset.
	 *
	 * @return array<string,string> Map of preset key => instruction.
	 */
	protected static function preset_instructions() {
		return array(
			'define'   => 'Define this word or phrase for an English lesson. Include the part of speech if relevant, a short simple definition, a natural Polish translation, and one B1/B2 example sentence.',
			'translate' => 'Translate the following between English and Polish, choosing the natural translation rather than a literal one. If it is a single word or short phrase, add one short B1/B2 example sentence.',
			'example'  => 'Give 2–3 natural example sentences that use the following word or phrase at B1/B2 level. Do not add definitions or explanations.',
			'flashcard' => 'Create one vocabulary flashcard for the following word or phrase in exactly this format:' . "\n" . 'Phonetic: Translation: Example: Keep the example at B1/B2 level.',
			'questions' => 'Create 3 short B1/B2 discussion questions about the following topic. Return them as a numbered list with nothing else.',
			'compare'  => 'Compare the two words or expressions from the teacher request. Explain the difference in simple B1 English. Give one short example sentence for each item. Keep the answer short and practical for an English lesson. Do not add a long introduction.',
		);
	}

	/**
	 * Preset choices for the UI: key + human label. Labels are translatable.
	 *
	 * @return array[] List of array{key:string,label:string}.
	 */
	public static function preset_choices() {
		return array(
			array(
				'key'   => 'define',
				'label' => __( 'Define', 'tbt-notes' ),
			),
			array(
				'key'   => 'translate',
				'label' => __( 'Translate', 'tbt-notes' ),
			),
			array(
				'key'   => 'example',
				'label' => __( 'Example', 'tbt-notes' ),
			),
			array(
				'key'   => 'flashcard',
				'label' => __( 'Flashcard', 'tbt-notes' ),
			),
			array(
				'key'   => 'questions',
				'label' => __( 'Questions', 'tbt-notes' ),
			),
			array(
				'key'   => 'compare',
				'label' => __( 'Compare', 'tbt-notes' ),
			),
		);
	}

	/**
	 * Normalise a requested preset to a known key, or '' if none/unknown.
	 *
	 * @param string $preset Raw preset value.
	 * @return string
	 */
	protected static function normalize_preset( $preset ) {
		$preset = is_string( $preset ) ? strtolower( trim( $preset ) ) : '';
		$known  = self::preset_instructions();
		return isset( $known[ $preset ] ) ? $preset : '';
	}

	/* --------------------------------------------------------------------- *
	 * Text helpers
	 * --------------------------------------------------------------------- */

	/**
	 * Collapse whitespace runs to single spaces and trim. Used for the prompt.
	 *
	 * @param string $text Raw text.
	 * @return string
	 */
	protected static function clean_prompt( $text ) {
		$text = is_string( $text ) ? $text : '';
		// Strip any markup a paste might have carried in; the model wants plain text.
		$text = function_exists( 'wp_strip_all_tags' ) ? wp_strip_all_tags( $text ) : strip_tags( $text );
		$text = preg_replace( '/[ \t]+/u', ' ', $text );
		if ( null === $text ) {
			$text = '';
		}
		// Collapse 3+ newlines to a single blank line, then trim.
		$text = preg_replace( '/\n{3,}/', "\n\n", $text );
		return trim( (string) $text );
	}

	/**
	 * Character length helper (multibyte aware).
	 *
	 * @param string $text Text.
	 * @return int
	 */
	protected static function text_length( $text ) {
		$text = (string) $text;
		return function_exists( 'mb_strlen' ) ? mb_strlen( $text, 'UTF-8' ) : strlen( $text );
	}

	/**
	 * Trim free-form context to a safe length without rejecting the request.
	 *
	 * @param string $text  Raw context.
	 * @param int    $limit Max characters.
	 * @return string
	 */
	protected static function trim_context( $text, $limit ) {
		$text = is_string( $text ) ? $text : '';
		$text = function_exists( 'wp_strip_all_tags' ) ? wp_strip_all_tags( $text ) : strip_tags( $text );
		$text = trim( preg_replace( '/\s+/u', ' ', (string) $text ) );
		if ( '' === $text ) {
			return '';
		}
		if ( self::text_length( $text ) <= $limit ) {
			return $text;
		}
		return function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $limit, 'UTF-8' ) : substr( $text, 0, $limit );
	}

	/**
	 * Reduce an AI answer to safe text. The answer is inserted into the note as
	 * plain text by the client, so we strip markup and normalise newlines but
	 * keep the visible line structure.
	 *
	 * @param mixed $value Raw value.
	 * @return string
	 */
	protected static function clean_answer( $value ) {
		$value = is_string( $value ) ? $value : '';
		$value = function_exists( 'wp_strip_all_tags' ) ? wp_strip_all_tags( $value ) : strip_tags( $value );
		$value = str_replace( "\r\n", "\n", $value );
		$value = str_replace( "\r", "\n", $value );
		$value = preg_replace( '/\n{3,}/', "\n\n", $value );
		// Trim trailing spaces on each line.
		$value = preg_replace( '/[ \t]+(\n)/', '$1', (string) $value );
		return trim( (string) $value );
	}

	/* --------------------------------------------------------------------- *
	 * Prompt construction
	 * --------------------------------------------------------------------- */

	/**
	 * Base system instruction shared by every request (spec §14).
	 *
	 * @param string $level Requested CEFR level.
	 * @return string
	 */
	protected static function system_instruction( $level ) {
		$level = '' !== trim( (string) $level ) ? trim( (string) $level ) : self::DEFAULT_LEVEL;
		return 'You are an assistant for an English teacher using The Blue Tree lesson notes during live lessons. '
			. 'Give concise, practical, lesson-friendly answers. '
			. 'Default to ' . $level . ' English unless the user asks for another level. '
			. 'When explaining vocabulary, include a simple definition, a natural Polish translation, and one example sentence. '
			. 'Avoid long explanations. '
			. 'Do not add introductions like "Certainly" or "Here is the answer". '
			. 'Return only the answer, formatted so it can be pasted directly into a lesson note.';
	}

	/**
	 * Assemble the user-facing prompt from the preset, the teacher's text, and
	 * any optional note context.
	 *
	 * @param array $args term/prompt, preset, selected_text, note_title, note_context.
	 * @return string
	 */
	protected static function build_user_prompt( array $args ) {
		$parts = array();

		$preset = self::normalize_preset( isset( $args['preset'] ) ? $args['preset'] : '' );
		if ( '' !== $preset ) {
			$instructions = self::preset_instructions();
			$parts[]      = $instructions[ $preset ];
		}

		$selected = isset( $args['selected_text'] ) ? trim( (string) $args['selected_text'] ) : '';
		if ( '' !== $selected ) {
			$parts[] = "Selected text from the note:\n" . $selected;
		}

		$parts[] = "Teacher's request:\n" . $args['prompt'];

		// Optional context only sharpens the answer; clearly mark it as background.
		$note_title = isset( $args['note_title'] ) ? trim( (string) $args['note_title'] ) : '';
		if ( '' !== $note_title ) {
			$parts[] = 'Lesson title (for context only): ' . $note_title;
		}
		$note_context = isset( $args['note_context'] ) ? trim( (string) $args['note_context'] ) : '';
		if ( '' !== $note_context ) {
			$parts[] = "Surrounding note text (for context only, do not repeat it):\n" . $note_context;
		}

		return implode( "\n\n", $parts );
	}

	/* --------------------------------------------------------------------- *
	 * Public entry point
	 * --------------------------------------------------------------------- */

	/**
	 * Generate an answer for a teacher prompt.
	 *
	 * @param array $args {
	 *     Request arguments.
	 *
	 *     @type string $prompt        Required. The teacher's free-text prompt.
	 *     @type string $preset        Optional. A preset key (define, translate, …).
	 *     @type string $level         Optional. CEFR level, defaults to B1/B2.
	 *     @type string $selected_text Optional. Text the teacher selected in the note.
	 *     @type string $note_title    Optional. The lesson title for context.
	 *     @type string $note_context  Optional. Surrounding note text for context.
	 * }
	 * @return array|WP_Error array{ answer:string } on success.
	 */
	public static function answer( array $args ) {
		$prompt = self::clean_prompt( isset( $args['prompt'] ) ? $args['prompt'] : '' );
		if ( '' === $prompt ) {
			return new WP_Error( 'tbt_ai_empty_prompt', __( 'Please type a prompt for the AI.', 'tbt-notes' ), array( 'status' => 400 ) );
		}
		if ( self::text_length( $prompt ) > self::MAX_PROMPT_LENGTH ) {
			return new WP_Error( 'tbt_ai_prompt_too_long', __( 'That prompt is too long. Please shorten it and try again.', 'tbt-notes' ), array( 'status' => 400 ) );
		}

		if ( '' === self::api_key() ) {
			return new WP_Error( 'tbt_ai_no_api_key', __( 'AI is not available at the moment. Please try again.', 'tbt-notes' ), array( 'status' => 500 ) );
		}

		$rate = self::check_rate_limit();
		if ( is_wp_error( $rate ) ) {
			return $rate;
		}

		$level = isset( $args['level'] ) ? (string) $args['level'] : self::DEFAULT_LEVEL;

		$user_prompt = self::build_user_prompt(
			array(
				'prompt'        => $prompt,
				'preset'        => isset( $args['preset'] ) ? $args['preset'] : '',
				'selected_text' => self::trim_context( isset( $args['selected_text'] ) ? $args['selected_text'] : '', self::MAX_CONTEXT_LENGTH ),
				'note_title'    => isset( $args['note_title'] ) ? $args['note_title'] : '',
				'note_context'  => self::trim_context( isset( $args['note_context'] ) ? $args['note_context'] : '', self::MAX_CONTEXT_LENGTH ),
			)
		);

		$answer = self::call_openai( self::system_instruction( $level ), $user_prompt );
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}

		// Only count successful generations against the quota.
		self::bump_rate_limit();

		return array( 'answer' => $answer );
	}

	/* --------------------------------------------------------------------- *
	 * OpenAI call + parsing
	 * --------------------------------------------------------------------- */

	/**
	 * Call the OpenAI Responses API and return the answer text.
	 *
	 * @param string $system Developer/system instruction.
	 * @param string $prompt Assembled user prompt.
	 * @return string|WP_Error
	 */
	protected static function call_openai( $system, $prompt ) {
		$key   = self::api_key();
		$model = self::model();

		$body = array(
			'model' => $model,
			'input' => array(
				array(
					'role'    => 'system',
					'content' => array(
						array(
							'type' => 'input_text',
							'text' => $system,
						),
					),
				),
				array(
					'role'    => 'user',
					'content' => array(
						array(
							'type' => 'input_text',
							'text' => $prompt,
						),
					),
				),
			),
		);

		$response = wp_remote_post(
			'https://api.openai.com/v1/responses',
			array(
				'timeout' => 45,
				'headers' => array(
					'Authorization' => 'Bearer ' . $key,
					'Content-Type'  => 'application/json',
				),
				'body'    => wp_json_encode( $body ),
			)
		);

		if ( is_wp_error( $response ) ) {
			$transport = $response->get_error_message();
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- diagnostics only; not exposed to the browser.
			error_log( sprintf( '[TBT Notes] AI Quick Note request failed (transport): model=%s error=%s', $model, $transport ) );
			return new WP_Error( 'tbt_ai_http', __( 'The request took too long. Please try again.', 'tbt-notes' ), array( 'status' => 502 ) );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$raw  = wp_remote_retrieve_body( $response );
		if ( 200 !== $code || '' === $raw ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- diagnostics only; not exposed to the browser.
			error_log( sprintf( '[TBT Notes] AI Quick Note error: http_status=%d model=%s body=%s', $code, $model, $raw ) );
			return new WP_Error( 'tbt_ai_api', __( 'AI is not available at the moment. Please try again.', 'tbt-notes' ), array( 'status' => 502 ) );
		}

		return self::parse_openai_response( $raw );
	}

	/**
	 * Pull the answer text out of an OpenAI Responses API body. Robust to the
	 * several shapes the API can return (flattened output_text, or output[] ->
	 * content[] chunks).
	 *
	 * @param string $response Raw JSON response body.
	 * @return string|WP_Error
	 */
	protected static function parse_openai_response( $response ) {
		$decoded = json_decode( (string) $response, true );
		if ( ! is_array( $decoded ) ) {
			return self::parse_error( $response );
		}

		$text = '';

		// 1. Prefer a flattened output_text if the API provided one.
		if ( isset( $decoded['output_text'] ) && is_string( $decoded['output_text'] ) && '' !== trim( $decoded['output_text'] ) ) {
			$text = $decoded['output_text'];
		} elseif ( isset( $decoded['output_text'] ) && is_array( $decoded['output_text'] ) ) {
			$text = implode( '', array_filter( $decoded['output_text'], 'is_string' ) );
		}

		// 2. Otherwise walk output[] -> content[] collecting every text payload.
		if ( '' === trim( $text ) && isset( $decoded['output'] ) && is_array( $decoded['output'] ) ) {
			$chunks = array();
			foreach ( $decoded['output'] as $item ) {
				if ( ! is_array( $item ) || empty( $item['content'] ) || ! is_array( $item['content'] ) ) {
					continue;
				}
				foreach ( $item['content'] as $chunk ) {
					if ( is_array( $chunk ) && isset( $chunk['text'] ) && is_string( $chunk['text'] ) && '' !== trim( $chunk['text'] ) ) {
						$chunks[] = $chunk['text'];
					}
				}
			}
			$text = implode( "\n", $chunks );
		}

		$answer = self::clean_answer( $text );
		if ( '' === $answer ) {
			return self::parse_error( $response );
		}

		return $answer;
	}

	/**
	 * Shared "could not read the AI response" error. The raw body is logged for
	 * diagnostics only — it is never returned to the browser.
	 *
	 * @param string $raw Raw OpenAI response body, if available.
	 * @return WP_Error
	 */
	protected static function parse_error( $raw = '' ) {
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- diagnostics only; not exposed to the browser.
		error_log( sprintf( '[TBT Notes] AI Quick Note response could not be parsed: model=%s body=%s', self::model(), (string) $raw ) );
		return new WP_Error( 'tbt_ai_parse', __( 'Could not read the AI response. Please try again.', 'tbt-notes' ), array( 'status' => 502 ) );
	}

	/* --------------------------------------------------------------------- *
	 * Rate limiting (per user, per hour) — spec §12
	 * --------------------------------------------------------------------- */

	/**
	 * Transient key for the current user's hourly counter.
	 *
	 * @return string
	 */
	protected static function rate_key() {
		return 'tbt_ai_quick_note_rate_user_' . get_current_user_id();
	}

	/**
	 * Refuse generation if the user is over their hourly quota.
	 *
	 * @return true|WP_Error
	 */
	protected static function check_rate_limit() {
		$count = (int) get_transient( self::rate_key() );
		if ( $count >= self::RATE_LIMIT ) {
			return new WP_Error( 'tbt_ai_rate', __( 'You have reached the hourly limit for AI requests. Please try again later.', 'tbt-notes' ), array( 'status' => 429 ) );
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
