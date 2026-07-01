<?php
/**
 * Sanitisation for TBT Notes.
 *
 * Lesson bodies are semantic HTML produced by the bundled Quill editor
 * (quill.getSemanticHTML(): nested <ol>/<ul> lists, class-based highlights,
 * standard inline tags). We never trust that HTML: it is run through a strict
 * wp_kses allowlist (which also blocks dangerous URL protocols and inline
 * styles) and then normalised so every link opens safely in a new tab and only
 * the five approved highlight classes survive.
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
	 * CSS classes allowed to remain on body elements. These back the five
	 * semantic highlight categories required by the spec; nothing else is
	 * permitted.
	 *
	 * @return string[]
	 */
	public static function allowed_classes() {
		return array(
			'tbt-hl-blue',
			'tbt-hl-red',
			'tbt-hl-yellow',
			'tbt-hl-pink',
			'tbt-hl-green',
		);
	}

	/**
	 * CSS classes allowed to remain on <img> elements. Images get their own,
	 * separate allowlist so the single approved layout class survives while the
	 * highlight classes (which are inline-text categories) never leak onto images.
	 *
	 * @return string[]
	 */
	public static function allowed_image_classes() {
		return array(
			'tbt-notes-image',
		);
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
			// Uploaded lesson photos. src is further constrained in normalize()
			// to the site's own uploads directory; no style attribute is allowed.
			'img'        => array(
				'src'     => true,
				'alt'     => true,
				'title'   => true,
				'width'   => true,
				'height'  => true,
				'loading' => true,
				'class'   => true,
			),
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

		$allowed_classes       = self::allowed_classes();
		$allowed_image_classes = self::allowed_image_classes();

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

		// Images: only our own uploaded photos survive. Anything with an empty
		// src, or a src outside this site's uploads directory (external images,
		// tracking pixels, data: URLs), is removed entirely. Everything that stays
		// is forced to lazy-load and stripped of non-numeric dimensions.
		$uploads_base = self::uploads_base_url();
		foreach ( iterator_to_array( $xpath->query( '//img' ) ) as $img ) {
			/** @var DOMElement $img */
			$src = trim( $img->getAttribute( 'src' ) );
			if ( '' === $src || ! self::is_local_upload_url( $src, $uploads_base ) ) {
				if ( $img->parentNode ) {
					$img->parentNode->removeChild( $img );
				}
				continue;
			}

			$img->setAttribute( 'loading', 'lazy' );

			foreach ( array( 'width', 'height' ) as $dim ) {
				if ( $img->hasAttribute( $dim ) && ! ctype_digit( $img->getAttribute( $dim ) ) ) {
					$img->removeAttribute( $dim );
				}
			}
		}

		// Classes: keep only approved classes. Images use their own single-class
		// allowlist; every other element uses the highlight-class allowlist.
		foreach ( $xpath->query( '//*[@class]' ) as $el ) {
			/** @var DOMElement $el */
			$permitted = ( 'img' === strtolower( $el->nodeName ) ) ? $allowed_image_classes : $allowed_classes;
			$classes   = preg_split( '/\s+/', trim( $el->getAttribute( 'class' ) ) );
			$kept      = array();
			foreach ( (array) $classes as $class ) {
				if ( '' !== $class && in_array( $class, $permitted, true ) ) {
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
	 * The site's uploads base URL, or '' if unavailable. Used to confirm an image
	 * really is one of ours before it is allowed to remain in a lesson body.
	 *
	 * @return string
	 */
	protected static function uploads_base_url() {
		if ( ! function_exists( 'wp_upload_dir' ) ) {
			return '';
		}
		$uploads = wp_upload_dir();
		return ( is_array( $uploads ) && ! empty( $uploads['baseurl'] ) ) ? $uploads['baseurl'] : '';
	}

	/**
	 * Is $src a URL inside this site's uploads directory? The scheme is ignored so
	 * an http/https mismatch (common behind proxies/CDNs) does not reject our own
	 * images. If the uploads base URL is unknown we cannot vouch for the image, so
	 * we treat it as not-local and let the caller drop it.
	 *
	 * @param string $src  Image src attribute.
	 * @param string $base Uploads base URL (may be '').
	 * @return bool
	 */
	protected static function is_local_upload_url( $src, $base ) {
		if ( '' === $base ) {
			return false;
		}
		$strip = function ( $url ) {
			return preg_replace( '#^https?:#i', '', trim( (string) $url ) );
		};
		return 0 === strpos( $strip( $src ), $strip( $base ) );
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
