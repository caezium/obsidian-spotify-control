/**
 * Lyrics fetching + LRC parsing.
 *
 * Source: LRCLIB (lrclib.net) — a free, no-auth, community-driven database
 * of time-synced lyrics built specifically for music players. ToS-friendly
 * unlike scraping Spotify's private color-lyrics endpoint, and unlike
 * Musixmatch it doesn't truncate to 30% of the lyric without a paid plan.
 *
 * Strategy:
 *   - GET /api/get with track + artist + album + duration; returns either
 *     synced LRC, plain text, or 404.
 *   - In-memory cache keyed by Spotify URI so we never refetch the same
 *     track within a session.
 *   - LRC parser handles [mm:ss.xx] and [mm:ss.xxx] timestamps, skips
 *     metadata tags ([ar:], [ti:], etc), and treats blank lines as
 *     instrumental gaps (rendered as empty rows for visual breathing room).
 *
 * Pure logic — fetcher is injected at construction (see src/lyrics-fetcher.ts
 * for the production impl that uses Obsidian's requestUrl). This module has
 * zero Obsidian dependencies so it can run under the node:test runner.
 */

export interface LyricsTrack {
	uri: string; // Spotify URI — used as cache key
	trackName: string;
	artist: string;
	album: string;
	durationMs: number;
}

export interface SyncedLine {
	timeMs: number;
	text: string;
}

export interface LyricsResult {
	/** Empty when the track is instrumental or no lyrics exist. */
	lines: SyncedLine[];
	/** Plain-text fallback when synced lyrics aren't available. */
	plainText: string | null;
	/** "synced" | "plain" | "instrumental" | "none". */
	kind: 'synced' | 'plain' | 'instrumental' | 'none';
}

export const LYRICS_NONE: LyricsResult = { lines: [], plainText: null, kind: 'none' };
const LYRICS_INSTRUMENTAL: LyricsResult = {
	lines: [],
	plainText: null,
	kind: 'instrumental',
};

interface LrclibResponse {
	id?: number;
	instrumental?: boolean;
	plainLyrics?: string | null;
	syncedLyrics?: string | null;
}

/** Fetcher signature so tests can inject a stub. */
export type LyricsFetcher = (url: string) => Promise<{ status: number; json?: unknown }>;

export class LyricsService {
	private cache = new Map<string, LyricsResult>();
	private inflight = new Map<string, Promise<LyricsResult>>();
	private fetcher: LyricsFetcher;

	constructor(fetcher: LyricsFetcher) {
		this.fetcher = fetcher;
	}

	/**
	 * Return cached lyrics if present, else fetch. Concurrent calls for the
	 * same URI share one in-flight promise.
	 */
	async get(track: LyricsTrack): Promise<LyricsResult> {
		const key = track.uri || `${track.artist}::${track.trackName}`;
		const cached = this.cache.get(key);
		if (cached) return cached;
		const existing = this.inflight.get(key);
		if (existing) return existing;
		const p = this.fetch(track).then((result) => {
			this.cache.set(key, result);
			this.inflight.delete(key);
			return result;
		});
		this.inflight.set(key, p);
		return p;
	}

	private async fetch(track: LyricsTrack): Promise<LyricsResult> {
		const url = buildLrclibUrl(track);
		try {
			const resp = await this.fetcher(url);
			if (resp.status === 404) return LYRICS_NONE;
			if (resp.status >= 400) {
				console.warn('[spotify-control] lyrics fetch HTTP', resp.status);
				return LYRICS_NONE;
			}
			const body = resp.json as LrclibResponse | undefined;
			if (!body) return LYRICS_NONE;
			if (body.instrumental) return LYRICS_INSTRUMENTAL;
			if (body.syncedLyrics) {
				const lines = parseLrc(body.syncedLyrics);
				if (lines.length > 0) {
					return { lines, plainText: body.plainLyrics ?? null, kind: 'synced' };
				}
			}
			if (body.plainLyrics) {
				return { lines: [], plainText: body.plainLyrics, kind: 'plain' };
			}
			return LYRICS_NONE;
		} catch (e) {
			console.warn('[spotify-control] lyrics fetch failed', e);
			return LYRICS_NONE;
		}
	}

	/** Drop everything. Settings tab calls this if user toggles lyrics off. */
	clear() {
		this.cache.clear();
		this.inflight.clear();
	}
}

export function buildLrclibUrl(track: LyricsTrack): string {
	const params = new URLSearchParams({
		track_name: track.trackName,
		artist_name: stripFeaturedArtists(track.artist),
		album_name: track.album,
		duration: String(Math.round(track.durationMs / 1000)),
	});
	return `https://lrclib.net/api/get?${params.toString()}`;
}

/**
 * Drop "feat." / "ft." / "with" tails from artist strings — LRCLIB's match
 * is artist-name-exact, so "ROSÉ, Bruno Mars" misses tracks credited just
 * to "ROSÉ" in the database. Keep the primary artist.
 */
function stripFeaturedArtists(s: string): string {
	const first = s.split(/,| feat\.?| ft\.?| with /i)[0];
	return first.trim();
}

/**
 * Parse an LRC string into time-stamped lines.
 *
 * Handles:
 *   - [mm:ss.xx] and [mm:ss.xxx] timestamps
 *   - Multiple timestamps on one line (repeated lyric)
 *   - Metadata tags ([ar:], [ti:], [al:], [length:]) — skipped
 *   - Blank lyric text (instrumental break) — kept as empty line so the UI
 *     can render breathing room
 *   - Lines are sorted by time (LRC files aren't guaranteed to be sorted)
 */
/** Defensive cap on LRC body size. Real lyrics are well under 20 KB; longer
 * input is either an error or malicious. Avoids worst-case regex backtracking
 * on pathological strings of many `[` characters. */
const MAX_LRC_BYTES = 64 * 1024;

export function parseLrc(lrc: string): SyncedLine[] {
	const input = lrc.length > MAX_LRC_BYTES ? lrc.slice(0, MAX_LRC_BYTES) : lrc;
	const out: SyncedLine[] = [];
	const timeRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
	const metadataTags = new Set([
		'ar', 'ti', 'al', 'length', 'by', 'offset', 're', 've', 'au', 'la',
	]);

	for (const rawLine of input.split(/\r?\n/)) {
		if (!rawLine.trim()) continue;

		// Skip metadata tags like [ar:ROSÉ] — they have alpha keys.
		const metaMatch = rawLine.match(/^\[([a-z]+):/i);
		if (metaMatch && metadataTags.has(metaMatch[1].toLowerCase())) continue;

		// Collect every timestamp on this line.
		const stamps: number[] = [];
		let lastEnd = 0;
		let m: RegExpExecArray | null;
		timeRe.lastIndex = 0;
		while ((m = timeRe.exec(rawLine)) !== null) {
			const min = parseInt(m[1], 10);
			const sec = parseInt(m[2], 10);
			const fracStr = m[3] ?? '0';
			// Normalize fraction: ".5" → 500ms, ".50" → 500ms, ".500" → 500ms
			const frac = parseInt(fracStr.padEnd(3, '0').slice(0, 3), 10);
			stamps.push(min * 60_000 + sec * 1000 + frac);
			lastEnd = m.index + m[0].length;
		}
		if (stamps.length === 0) continue;

		const text = rawLine.slice(lastEnd).trim();
		for (const t of stamps) out.push({ timeMs: t, text });
	}

	out.sort((a, b) => a.timeMs - b.timeMs);
	return out;
}

/**
 * Binary-search the active line index for a given playback position.
 * Returns -1 if the position is before the first line.
 */
export function activeLineIndex(lines: SyncedLine[], positionMs: number): number {
	if (lines.length === 0 || positionMs < lines[0].timeMs) return -1;
	let lo = 0;
	let hi = lines.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lines[mid].timeMs <= positionMs) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

