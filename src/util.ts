/**
 * Pure utility functions with no Obsidian dependencies.
 *
 * Living here (rather than scattered across feature files) so they can be
 * imported into the test runner, which uses node:test and can't load `obsidian`.
 */

// ── Time / formatting ───────────────────────────────────────────────────────

/** "0:00", "1:23", "10:05". Returns "0:00" for non-positive input. */
export function formatTime(ms: number): string {
	if (!ms || ms < 0) return '0:00';
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Spotify URI/URL parsing ─────────────────────────────────────────────────

const SPOTIFY_URI_RE = /spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)/;
// `(?:intl-[a-z]+\/)?` handles localized share URLs like
// https://open.spotify.com/intl-en/track/abc — Spotify started inserting
// these for international users in 2024. The `[A-Za-z0-9]+` ID group stops
// naturally at `?` so `?si=share-token` query params are handled too.
const SPOTIFY_URL_RE =
	/https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/;

export type SpotifyResourceKind =
	| 'track'
	| 'album'
	| 'playlist'
	| 'artist'
	| 'episode'
	| 'show';

export interface SpotifyResource {
	raw: string;
	uri: string; // canonical spotify:type:id form
	kind: SpotifyResourceKind;
	id: string;
}

/**
 * Extract the first Spotify resource found in a string. Returns null if none.
 *
 * Uses the regex capture group for the type rather than substring matching,
 * so a URL like `…/album/track-suit-xyz` correctly parses as an album, not a
 * track. (This was bug #13 in the audit.)
 */
export function parseSpotifyResource(s: string): SpotifyResource | null {
	const uriMatch = s.match(SPOTIFY_URI_RE);
	if (uriMatch) {
		const [raw, kind, id] = uriMatch;
		return { raw, uri: raw, kind: kind as SpotifyResourceKind, id };
	}
	const urlMatch = s.match(SPOTIFY_URL_RE);
	if (urlMatch) {
		const [raw, kind, id] = urlMatch;
		return {
			raw,
			uri: `spotify:${kind}:${id}`,
			kind: kind as SpotifyResourceKind,
			id,
		};
	}
	return null;
}

// ── PKCE primitives ─────────────────────────────────────────────────────────

const PKCE_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * Cryptographically random string of `length` characters from the PKCE
 * unreserved-character set.
 *
 * Uses rejection sampling to avoid the modulo bias `bytes[i] % 66` would
 * introduce. With a 256-value alphabet and 66 valid characters, 256 % 66 = 58,
 * so naive modulo gives characters 0-57 a slightly higher probability than
 * 58-65. We discard bytes ≥ floor(256/66)*66 = 198 and resample.
 *
 * In practice you'd need ~10^58 samples to detect the bias for a 64-char
 * verifier, so the original code was secure; this is just cosmetically clean.
 */
export function randomString(length: number): string {
	const alphabetLen = PKCE_ALPHABET.length;
	// Largest multiple of alphabetLen ≤ 256.
	const acceptBelow = Math.floor(256 / alphabetLen) * alphabetLen;
	let out = '';
	// Generate in chunks. Most bytes are accepted; only ~22% rejected.
	const buf = new Uint8Array(length * 2);
	while (out.length < length) {
		const cryptoObj = getCrypto();
		cryptoObj.getRandomValues(buf);
		for (let i = 0; i < buf.length && out.length < length; i++) {
			if (buf[i] < acceptBelow) {
				out += PKCE_ALPHABET[buf[i] % alphabetLen];
			}
		}
	}
	return out;
}

/** SHA-256 → base64url (RFC 4648 §5, no padding). */
export async function sha256Base64Url(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const cryptoObj = getCrypto();
	const hash = await cryptoObj.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Get a Web Crypto-compatible object.
 *
 *   - Obsidian's Electron renderer always has `globalThis.crypto`.
 *   - The Node 18 test runner doesn't (Web Crypto became a default global
 *     in Node 19+). For that case we fall back to `node:crypto.webcrypto`,
 *     which has the same shape.
 *
 * `node:crypto` is listed as `external` in esbuild.config.mjs so the bundler
 * emits `require("node:crypto")` rather than trying to inline it. That call
 * works in Node and in Electron's renderer; the fallback branch only
 * executes when `globalThis.crypto` is missing.
 */
function getCrypto(): Crypto {
	if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto?.subtle) {
		return globalThis.crypto;
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodeCrypto = require('node:crypto') as { webcrypto: Crypto };
	return nodeCrypto.webcrypto;
}

/** Bytes → base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	// btoa is available in browsers; in Node we polyfill via Buffer below.
	const b64 =
		typeof btoa !== 'undefined' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Replace `{{key}}` tokens in template with values from the map.
 * Missing keys render as empty string, not the literal {{key}}.
 */
export function renderTemplate(
	template: string,
	vars: Record<string, string | undefined>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
