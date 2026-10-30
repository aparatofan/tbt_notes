<?php
/**
 * Example-sentence rules for TBT Notes.
 *
 * One place that writes the rules every AI-generated example sentence in Notes
 * follows: the expression cards (one sentence per blue highlight) and the AI
 * assistant shortcuts that write examples. The rules are Notes' own copy of
 * the ones TBT Swipe uses; Notes does not call or depend on Swipe.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It names no real person and no real place. A model shown a name in its
 *    instructions uses that name every time, so the rules describe the kind of
 *    person and place to choose and leave the choosing to the model.
 *
 * 2. It does not require TBT Students. The learner profile is read through
 *    that plugin's public API when it is active, and only for a one-to-one
 *    class. Every unknown answers '' and the sentence is written without a
 *    profile; nothing here blocks generation.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Examples
 */
class TBT_Notes_Examples {

	/**
	 * Longest profile note passed to the model, in characters.
	 */
	const PROFILE_MAX_LENGTH = 300;

	/**
	 * How many of $count sentences go into each group.
	 *
	 * With a profile, half (rounded up) are PROFILE; the rest are split
	 * between WORLD and EVERYDAY, WORLD taking the odd one.
	 *
	 * @param int  $count       Number of example sentences.
	 * @param bool $has_profile Whether a learner profile is available.
	 * @return array{world:int,everyday:int,profile:int}
	 */
	public static function strand_counts( $count, $has_profile ) {
		$general = max( 0, (int) $count );
		$profile = $has_profile ? (int) ceil( $general / 2 ) : 0;
		$rest    = $general - $profile;
		$world   = (int) ceil( $rest / 2 );
		return array(
			'world'    => $world,
			'everyday' => $rest - $world,
			'profile'  => $profile,
		);
	}

	/**
	 * The preferred connectors (B1 and B2), as one comma-separated string.
	 *
	 * @return string
	 */
	public static function connectors() {
		return 'although, while, unless, until, as soon as, so that, however, whereas, despite, '
			. 'even though, therefore, as long as, otherwise, which is why';
	}

	/**
	 * The group for one expression card.
	 *
	 * Cards are generated one at a time, so the group rotates with the number
	 * of other cards the lesson already has. Over a lesson this keeps the same
	 * ratio as strand_counts(): half PROFILE when there is a profile, the rest
	 * split between WORLD and EVERYDAY.
	 *
	 * @param int  $index       How many other cards the lesson already has.
	 * @param bool $has_profile Whether a learner profile is available.
	 * @return array{group:string,fallback:string}
	 */
	public static function card_group( $index, $has_profile ) {
		$index = max( 0, (int) $index );

		if ( $has_profile ) {
			$cycle = array(
				array( 'PROFILE', 'WORLD' ),
				array( 'WORLD', 'EVERYDAY' ),
				array( 'PROFILE', 'EVERYDAY' ),
				array( 'EVERYDAY', 'WORLD' ),
			);
		} else {
			$cycle = array(
				array( 'WORLD', 'EVERYDAY' ),
				array( 'EVERYDAY', 'WORLD' ),
			);
		}

		$pick = $cycle[ $index % count( $cycle ) ];
		return array(
			'group'    => $pick[0],
			'fallback' => $pick[1],
		);
	}

	/**
	 * The example-sentence rules, as prompt text.
	 *
	 * @param array $plan        One of:
	 *                           array( 'counts' => strand_counts(...) ) — several sentences;
	 *                           array( 'single' => array( 'group' => X, 'fallback' => Y ) ) — one sentence, set group;
	 *                           array( 'single' => 'choose' ) — one sentence, WORLD or EVERYDAY.
	 * @param bool  $has_profile Whether a learner profile is available.
	 * @return string
	 */
	public static function block( array $plan, $has_profile ) {
		$has_profile = (bool) $has_profile;

		if ( isset( $plan['counts'] ) && is_array( $plan['counts'] ) ) {
			$world    = isset( $plan['counts']['world'] ) ? max( 0, (int) $plan['counts']['world'] ) : 0;
			$everyday = isset( $plan['counts']['everyday'] ) ? max( 0, (int) $plan['counts']['everyday'] ) : 0;
			$profile  = $has_profile && isset( $plan['counts']['profile'] ) ? max( 0, (int) $plan['counts']['profile'] ) : 0;
			$total    = $world + $everyday + $profile;

			$numbers = 'WORLD ' . $world . ', EVERYDAY ' . $everyday;
			if ( $profile > 0 ) {
				$numbers .= ', PROFILE ' . $profile;
			}
			$groups_text = 'Your ' . $total . ' example sentences fall into these groups. Use exactly these numbers — '
				. $numbers . ' — and choose which sentence goes in which group yourself, putting each where it shows the meaning best:';
			$usable      = array(
				'WORLD'    => $world > 0,
				'EVERYDAY' => $everyday > 0,
				'PROFILE'  => $profile > 0,
			);
		} elseif ( isset( $plan['single'] ) && is_array( $plan['single'] ) ) {
			$known    = array( 'WORLD', 'EVERYDAY', 'PROFILE' );
			$group    = isset( $plan['single']['group'] ) ? strtoupper( (string) $plan['single']['group'] ) : '';
			$fallback = isset( $plan['single']['fallback'] ) ? strtoupper( (string) $plan['single']['fallback'] ) : '';
			if ( ! in_array( $group, $known, true ) || ( 'PROFILE' === $group && ! $has_profile ) ) {
				$group = 'WORLD';
			}
			if ( ! in_array( $fallback, $known, true ) || $fallback === $group || ( 'PROFILE' === $fallback && ! $has_profile ) ) {
				$fallback = 'WORLD' === $group ? 'EVERYDAY' : 'WORLD';
			}
			$groups_text = 'This sentence belongs to the ' . $group . ' group. If the item cannot show its meaning well there, use the '
				. $fallback . ' group instead.';
			$usable      = array(
				'WORLD'    => in_array( 'WORLD', array( $group, $fallback ), true ),
				'EVERYDAY' => in_array( 'EVERYDAY', array( $group, $fallback ), true ),
				'PROFILE'  => in_array( 'PROFILE', array( $group, $fallback ), true ),
			);
		} else {
			// 'choose' (and anything unrecognised): WORLD or EVERYDAY, no PROFILE.
			$groups_text = 'This sentence belongs to the WORLD or the EVERYDAY group, whichever shows the meaning best.';
			$usable      = array(
				'WORLD'    => true,
				'EVERYDAY' => true,
				'PROFILE'  => false,
			);
		}

		$definitions = array();
		if ( $usable['WORLD'] ) {
			$definitions[] = '- WORLD: set in the real world — a real person, a real place, or a real work (a book, a painting, a piece of music, a discovery, an invention, a building).';
		}
		if ( $usable['EVERYDAY'] ) {
			$definitions[] = '- EVERYDAY: an ordinary adult situation. These sentences may use the recurring characters Alita, Pete, Sven and Kat.';
		}
		if ( $has_profile && $usable['PROFILE'] ) {
			$definitions[] = "- PROFILE: set in the learner's world, as described in the learner context. A PROFILE sentence may also use a real person, place or work from that world, and that is encouraged.";
		}

		return "What the example sentences are for — follow these rules in order:\n\n"
			. '1. Meaning first. Each sentence must show what the item means. A learner who does not know the item should be able to roughly guess its meaning from the rest of the sentence. If almost any word of the same kind could replace the item and the sentence would still make sense, the sentence fails this rule, however correct or interesting it is. Use the item in its most natural collocation. This rule outranks every rule below.' . "\n\n"
			. '2. Groups. ' . $groups_text . "\n"
			. implode( "\n", $definitions ) . "\n\n"
			. '3. Real people. Prefer people who are no longer alive and whose work is admired: scientists, inventors, explorers, writers, artists, composers, musicians, philosophers, and statesmen remembered for constructive achievement. Use a living person only where the learner context clearly points to one, and never a living politician. Do not use religious figures or religious topics, or anyone known mainly for war, crime, scandal or cruelty. Each real person appears at most once in this answer. Vary the fields and the centuries.' . "\n\n"
			. "4. Facts. Use only facts that are widely known and that you are certain are true. Never put words in a real person's mouth: no quotations, no \"once said\", no invented thoughts or feelings. Avoid exact dates and figures unless they are famous. If you are not certain a fact is true, write about a place or a work instead, or use an EVERYDAY situation. A plain true sentence is better than a vivid doubtful one." . "\n\n"
			. '5. Real places. Name real places: Polish cities, towns, regions and landmarks often; also world cities, well-known travel destinations and national parks. Facts about places follow rule 4.' . "\n\n"
			. '6. Connectors. Link ideas with connectors and vary them. Prefer these: ' . self::connectors() . '. Simpler ones (and, but, because, so, when) are also allowed. Most sentences should contain a connector. No connector may appear more than once in this answer. A connector never makes a sentence long or hard to read.' . "\n\n"
			. "7. Variety. Do not begin two sentences with the same word, and do not begin most sentences with a person's name. The only invented names allowed are Alita, Pete, Sven and Kat; never invent any other name.";
	}

	/**
	 * The one-to-one student's profile note for a lesson, or ''.
	 *
	 * TBT Students is an optional integration, checked by class and method.
	 * Only a class with exactly one student has a profile: a group class, an
	 * empty class, a lesson without a class, a missing plugin or a profile
	 * that is not a string all answer ''. Fails open: never throws.
	 *
	 * @param int $lesson_id Lesson ID.
	 * @return string
	 */
	public static function profile_for_lesson( $lesson_id ) {
		if ( ! class_exists( 'TBT_Students' ) || ! method_exists( 'TBT_Students', 'get_profile' ) ) {
			return '';
		}
		return self::profile_from_lesson( $lesson_id, array( 'TBT_Students', 'get_profile' ) );
	}

	/**
	 * The lookup behind profile_for_lesson(), with the profile reader passed in
	 * so the lesson → class → one student → profile path can be tested without
	 * TBT Students.
	 *
	 * @param int      $lesson_id Lesson ID.
	 * @param callable $reader    Returns the profile for a user ID.
	 * @return string
	 */
	protected static function profile_from_lesson( $lesson_id, callable $reader ) {
		try {
			$lesson = TBT_Notes_DB::get_lesson( (int) $lesson_id );
			if ( ! is_array( $lesson ) || empty( $lesson['class_id'] ) ) {
				return '';
			}

			$student_ids = TBT_Notes_DB::get_student_ids_for_class( (int) $lesson['class_id'] );
			if ( ! is_array( $student_ids ) || 1 !== count( $student_ids ) ) {
				return '';
			}

			$profile = call_user_func( $reader, (int) reset( $student_ids ) );
			if ( ! is_string( $profile ) ) {
				return '';
			}

			$profile = preg_replace( '/\s+/u', ' ', $profile );
			if ( ! is_string( $profile ) ) {
				return '';
			}
			$profile = trim( str_replace( '"', "'", $profile ) );

			return mb_substr( $profile, 0, self::PROFILE_MAX_LENGTH );
		} catch ( \Throwable $e ) {
			return '';
		}
	}
}
