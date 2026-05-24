/**
 * Shared types for spotify-control.
 *
 * AccessToken shape mirrors @spotify/web-api-ts-sdk's AccessToken so we can
 * hand it directly to SpotifyApi.withAccessToken().
 */

export interface SpotifyAccessToken {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
	/**
	 * Absolute epoch-ms at which the access_token expires.
	 * Spotify only gives us a relative expires_in; we compute this at issue
	 * time so a stale refresh schedule after restart still works.
	 */
	expires_at?: number;
}

export interface SpotifyControlSettings {
	/** Spotify Developer app client ID. PKCE flow — no secret needed. */
	clientId: string;

	/** Last issued access + refresh tokens. Stored in data.json (gitignored). */
	tokens: SpotifyAccessToken | null;

	/** Polling interval in ms for the now-playing sidebar. */
	pollIntervalMs: number;

	/** Template for "insert now playing" command. {{name}} {{artist}} {{url}} {{album}} */
	insertTemplate: string;

	/**
	 * Hover-reveal mode: prev/play/next live inside an overlay on the album
	 * art and only appear on hover. When false, those controls stay always-
	 * visible in a row below the art.
	 *
	 * Shuffle, repeat, and device picker stay always-visible in both modes.
	 */
	hoverRevealControls: boolean;

	/** Enable lyrics fetching via LRCLIB. Off → lyrics toggle button hidden. */
	enableLyrics: boolean;

	/**
	 * Where the lyrics + queue panels appear when toggled on.
	 *   "replace": panel replaces the album art in the same square area (compact)
	 *   "below":   panel appears between the album art and the title/controls,
	 *              filling remaining sidebar height. Art stays visible above.
	 *
	 * Default is "below" — most users want art + lyrics simultaneously visible.
	 */
	lyricsPosition: 'replace' | 'below';

	/** Enable queue panel toggle (shows upcoming tracks). */
	enableQueue: boolean;

	/**
	 * Show a thin progress bar at the bottom edge of the album art. When on,
	 * the separate seek row is hidden. Click the bar to seek.
	 */
	progressOnArt: boolean;

	/**
	 * Show a volume button at the bottom-right corner of the album art with
	 * a popover slider. When on, the separate volume row is hidden.
	 */
	volumeOnArt: boolean;

	/**
	 * Where the "Open Spotify Web Player" command opens open.spotify.com.
	 *   "external": OS default browser (recommended — has Widevine, plays audio)
	 *   "obsidian": Obsidian's built-in web viewer (UI works, audio doesn't
	 *               because of the same Widevine limitation as Phase 2)
	 */
	webPlayerMode: 'external' | 'obsidian';
}

export const DEFAULT_SETTINGS: SpotifyControlSettings = {
	clientId: '',
	tokens: null,
	pollIntervalMs: 3000,
	insertTemplate: '> [!music] Now playing\n> [{{name}} — {{artist}}]({{url}})',
	hoverRevealControls: true,
	enableLyrics: true,
	lyricsPosition: 'below',
	enableQueue: true,
	progressOnArt: false,
	volumeOnArt: false,
	webPlayerMode: 'external',
};

/** Spotify Web Player scopes needed across all features (Phase 1 + Phase 2). */
export const SCOPES = [
	// Playback state + control
	'user-read-playback-state',
	'user-modify-playback-state',
	'user-read-currently-playing',
	// Web Playback SDK (Phase 2)
	'streaming',
	'user-read-email',
	'user-read-private',
	// Library + playlists (search results, queue context)
	'user-library-read',
	'user-library-modify',
	'playlist-read-private',
	'playlist-read-collaborative',
	// Recently played + top tracks (future feature hooks)
	'user-read-recently-played',
	'user-top-read',
].join(' ');

export const REDIRECT_URI = 'obsidian://spotify-control/auth';
