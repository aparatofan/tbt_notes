<?php
/**
 * Pure search helpers for TBT Notes.
 *
 * Static and side-effect free: no $wpdb, no options, no globals. The REST
 * search route uses these to turn a teacher's query into a cheap SQL prefilter
 * and then to confirm each candidate against the note's visible text, so the
 * same rules can be exercised directly by the logic tests.
 *
 * Folding matches the browser's fold(): ł is mapped by hand (it is not a
 * combining mark), then accents are removed and the text is lowercased, so
 * "przelozony" finds "przełożony".
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Search
 */
class TBT_Notes_Search {

	/**
	 * Most prefilter tokens sent to SQL. Each adds two LIKE clauses.
	 */
	const MAX_TOKENS = 6;

	/**
	 * Characters of context kept before and after the first hit in a snippet.
	 */
	const SNIPPET_BEFORE = 48;
	const SNIPPET_AFTER  = 72;

	/**
	 * Case- and diacritic-insensitive form of a string.
	 *
	 * @param string $s Raw text.
	 * @return string
	 */
	public static function fold( $s ) {
		$s = str_replace( array( 'ł', 'Ł' ), array( 'l', 'L' ), (string) $s );
		$s = remove_accents( $s );
		return mb_strtolower( $s, 'UTF-8' );
	}

	/**
	 * The visible text of a stored lesson body.
	 *
	 * Block ends and line breaks become spaces so words in adjacent paragraphs
	 * never run together; markup is removed before entities are decoded, so a
	 * search for "span" or "strong" can only ever match the words themselves.
	 *
	 * @param string $html Sanitised lesson HTML.
	 * @return string
	 */
	public static function plain_text( $html ) {
		$html = (string) $html;
		$html = preg_replace( '#(</(?:p|li|h[1-6]|blockquote|pre)\s*>|<br\s*/?>)#i', ' $1', $html );
		$text = wp_strip_all_tags( $html );
		$text = html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
		$text = str_replace( "\xc2\xa0", ' ', $text );
		$text = preg_replace( '/\s+/u', ' ', $text );
		return trim( (string) $text );
	}

	/**
	 * LIKE fragments for the SQL prefilter, without the surrounding %.
	 *
	 * The table collation folds case and most accents, but not ł, so every l
	 * becomes the single-character wildcard _ and matches either letter. Tokens
	 * hold only letters, digits and _, so no further LIKE escaping is needed.
	 *
	 * @param string $query Raw query.
	 * @return string[]
	 */
	public static function prefilter_tokens( $query ) {
		$parts  = preg_split( '/[^\p{L}\p{N}]+/u', self::fold( $query ), -1, PREG_SPLIT_NO_EMPTY );
		$tokens = array();
		foreach ( (array) $parts as $part ) {
			if ( mb_strlen( $part, 'UTF-8' ) < 2 ) {
				continue;
			}
			$part = str_replace( 'l', '_', $part );
			if ( ! in_array( $part, $tokens, true ) ) {
				$tokens[] = $part;
			}
			if ( count( $tokens ) >= self::MAX_TOKENS ) {
				break;
			}
		}
		return $tokens;
	}

	/**
	 * Find a query in plain text.
	 *
	 * @param string $text  Plain text (see plain_text()).
	 * @param string $query Raw query.
	 * @return array|null Null when there is no hit; otherwise count plus a
	 *                    snippet of the original text around the first hit.
	 */
	public static function match( $text, $query ) {
		$text   = (string) $text;
		$needle = self::fold( preg_replace( '/\s+/u', ' ', trim( (string) $query ) ) );
		if ( '' === $needle ) {
			return null;
		}
		$folded = self::fold_aligned( $text );
		$pos    = mb_strpos( $folded, $needle, 0, 'UTF-8' );
		if ( false === $pos ) {
			return null;
		}

		$len   = mb_strlen( $needle, 'UTF-8' );
		$total = mb_strlen( $text, 'UTF-8' );
		$count = 0;
		$at    = 0;
		while ( false !== ( $at = mb_strpos( $folded, $needle, $at, 'UTF-8' ) ) ) {
			++$count;
			$at += $len;
		}

		// Before: cut at a word boundary inside the window, if there is one.
		$start  = $pos - self::SNIPPET_BEFORE;
		$prefix = '';
		if ( $start > 0 ) {
			$window = mb_substr( $text, $start, $pos - $start, 'UTF-8' );
			$space  = mb_strpos( $window, ' ', 0, 'UTF-8' );
			if ( false !== $space ) {
				$start += $space + 1;
			}
			$prefix = '…';
		} else {
			$start = 0;
		}

		$end    = $pos + $len + self::SNIPPET_AFTER;
		$suffix = '';
		if ( $end < $total ) {
			$window = mb_substr( $text, $pos + $len, $end - $pos - $len, 'UTF-8' );
			$space  = mb_strrpos( $window, ' ', 0, 'UTF-8' );
			if ( false !== $space ) {
				$end = $pos + $len + $space;
			}
			$suffix = '…';
		} else {
			$end = $total;
		}

		return array(
			'count'  => $count,
			'before' => $prefix . mb_substr( $text, $start, $pos - $start, 'UTF-8' ),
			'match'  => mb_substr( $text, $pos, $len, 'UTF-8' ),
			'after'  => mb_substr( $text, $pos + $len, $end - $pos - $len, 'UTF-8' ) . $suffix,
		);
	}

	/**
	 * fold() with exactly one output character per input character, so
	 * positions found in the folded text apply to the original.
	 *
	 * Polish and English fold one to one already; the per-character pass only
	 * runs for the rare character that does not (ß, æ …), which is then kept
	 * lowercased rather than expanded.
	 *
	 * @param string $text Raw text.
	 * @return string
	 */
	protected static function fold_aligned( $text ) {
		$folded = self::fold( $text );
		if ( mb_strlen( $folded, 'UTF-8' ) === mb_strlen( $text, 'UTF-8' ) ) {
			return $folded;
		}
		$out = '';
		foreach ( preg_split( '//u', $text, -1, PREG_SPLIT_NO_EMPTY ) as $ch ) {
			$f = self::fold( $ch );
			if ( 1 !== mb_strlen( $f, 'UTF-8' ) ) {
				$f = mb_strtolower( $ch, 'UTF-8' );
				$f = 1 === mb_strlen( $f, 'UTF-8' ) ? $f : $ch;
			}
			$out .= $f;
		}
		return $out;
	}
}
