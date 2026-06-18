<?php
/**
 * Sanitisation for TBT Notes.
 *
 * Lesson bodies are semantic HTML produced by the bundled Quill editor
 * (quill.getSemanticHTML(): nested <ol>/<ul> lists, class-based highlights,
 * standard inline tags). We never trust that HTML: it is run through a strict
 * wp_kses allowlist (which also blocks dangerous URL protocols and inline
 * styles) and then normalised so every link opens safely in a new tab and only
 * the three approved highlight classes survive.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Sanitizer
 */
class TBT_Notes_Sanitizer {

	/**
	 * CSS classes allowed to remain on body elements. These back the three
	 * highlight colours required by the spec; nothing else is permitted.
	 *
	 * @return string[]
	 */
	public static function allowed_classes() {
		return array( 'tbt-hl-blue', 'tbt-hl-yellow', 'tbt-hl-red', 'tbt-hl-green' );
	}

	/**
	 * The wp_kses tag/attribute allowlist for lesson bodies. Deliberately tight:
	 * exactly what the editor toolbar can produce. No `style` attribute, so
	 * highlights must be class-based and cannot smuggle arbitrary CSS.
	 *
	 * @return array
	 */
	public static function allowed_html() {
		return array(
			'p'          => array(),
			'br'         => array(),
			'strong'     => array(),
			'b'          => array(),
			'em'         => array(),
			'i'          => array(),
			'u'          => array(),
			's'          => array(),
			'a'          => array(
				'href'   => true,
				'target' => true,
				'rel'    => true,
				'title'  => true,
			),
			'ul'         => array(),
			'ol'         => array(),
			'li'         => array(),
			'span'       => array(
				'class' => true,
			),
			'h1'         => array(),
			'h2'         => array(),
			'h3'         => array(),
			'blockquote' => array(),
		);
	}

	/**
	 * Sanitise a plain-text field (class title, lesson header).
	 *
	 * @param string $text Raw input.
	 * @return string
	 */
	public static function text( $text ) {
		// REST params are not slashed by WordPress, so we must not unslash here
		// (doing so would strip backslashes the teacher actually typed).
		return sanitize_text_field( (string) $text );
	}

	/**
	 * Sanitise a lesson body (HTML from the editor).
	 *
	 * @param string $html Raw HTML.
	 * @return string Safe HTML.
	 */
	public static function body( $html ) {
		$html = (string) $html;

		// Quill's semantic HTML encodes every space as a non-breaking space,
		// which would stop text wrapping in the narrow panel. Restore normal
		// spaces before anything else.
		$html = str_replace( array( '&nbsp;', "\xc2\xa0" ), ' ', $html );

		// 1. Structural safety: strip anything outside the allowlist, including
		//    inline styles, event handlers and unsafe URL protocols.
		$html = wp_kses( $html, self::allowed_html() );

		// 2. Normalise: force-safe links and restrict classes to the allowlist.
		$html = self::normalize( $html );

		return $html;
	}

	/**
	 * Post-kses normalisation: ensure links open in a new tab with a safe rel,
	 * and drop any class that is not an approved highlight class.
	 *
	 * @param string $html Already kses-filtered HTML.
	 * @return string
	 */
	protected static function normalize( $html ) {
		if ( '' === trim( $html ) ) {
			return '';
		}

		// Fall back to a lightweight regex pass if ext-dom is unavailable.
		if ( ! class_exists( 'DOMDocument' ) ) {
			return self::normalize_fallback( $html );
		}

		$allowed_classes = self::allowed_classes();

		// Encode non-ASCII as numeric entities so DOMDocument preserves UTF-8
		// without us having to inject an XML/meta declaration.
		$wrapped = '<div data-tbt-root="1">' . $html . '</div>';
		if ( function_exists( 'mb_encode_numericentity' ) ) {
			$wrapped = mb_encode_numericentity( $wrapped, array( 0x80, 0x10FFFF, 0, 0x10FFFF ), 'UTF-8' );
		}

		$dom = new DOMDocument();
		libxml_use_internal_errors( true );
		$dom->loadHTML( $wrapped, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD );
		libxml_clear_errors();

		$xpath = new DOMXPath( $dom );

		// Links: always open in a new tab, never leak the opener.
		foreach ( $xpath->query( '//a' ) as $a ) {
			/** @var DOMElement $a */
			$a->setAttribute( 'target', '_blank' );
			$a->setAttribute( 'rel', 'noopener noreferrer' );
		}

		// Classes: keep only approved highlight classes.
		foreach ( $xpath->query( '//*[@class]' ) as $el ) {
			/** @var DOMElement $el */
			$classes = preg_split( '/\s+/', trim( $el->getAttribute( 'class' ) ) );
			$kept    = array();
			foreach ( (array) $classes as $class ) {
				if ( '' !== $class && in_array( $class, $allowed_classes, true ) ) {
					$kept[] = $class;
				}
			}
			if ( $kept ) {
				$el->setAttribute( 'class', implode( ' ', $kept ) );
			} else {
				$el->removeAttribute( 'class' );
			}
		}

		$root = $dom->documentElement;
		if ( ! $root ) {
			return '';
		}

		$inner = '';
		foreach ( $root->childNodes as $child ) {
			$inner .= $dom->saveHTML( $child );
		}

		return trim( $inner );
	}

	/**
	 * Regex-based normalisation used only when DOMDocument is unavailable.
	 *
	 * @param string $html kses-filtered HTML.
	 * @return string
	 */
	protected static function normalize_fallback( $html ) {
		// Ensure all anchors carry safe target/rel attributes.
		$html = preg_replace_callback(
			'/<a\b([^>]*)>/i',
			function ( $m ) {
				$attrs = preg_replace( '/\s+(target|rel)="[^"]*"/i', '', $m[1] );
				return '<a' . $attrs . ' target="_blank" rel="noopener noreferrer">';
			},
			$html
		);
		return $html;
	}
}
