/**
 * Direct Spotify Web API wrappers for player control endpoints.
 *
 * Why this exists instead of using @spotify/web-api-ts-sdk:
 *   The SDK's response deserializer calls JSON.parse on the response body
 *   unconditionally when it has non-zero length. Player endpoints (play, pause,
 *   skip, seek, volume, shuffle, repeat, transfer) return 204 No Content on
 *   success, but in Obsidian's renderer context the body comes back with some
 *   stray bytes (looks like Cloudflare anti-bot tracking IDs). JSON.parse then
 *   throws and the SDK surfaces it as "Unexpected token" errors.
 *
 *   Using Obsidian's requestUrl directly:
 *     - Goes through Node's HTTP stack (not the renderer fetch), so CF tracking
 *       injections don't apply
 *     - Lets us explicitly handle empty/204 responses
 *     - Lets us implement NO_ACTIVE_DEVICE auto-retry in one place
 *     - Lets us do a one-shot 401 retry after refresh
 *
 *   We keep the SDK for *read* endpoints (search, getPlaybackState, devices)
 *   where its typed return shapes and error handling work fine.
 */

import { requestUrl, RequestUrlResponse, Notice } from 'obsidian';
import type SpotifyControlPlugin from './main';

const BASE = 'https://api.spotify.com/v1';

// ── Minimal Spotify response types ──────────────────────────────────────────
// Replacing @spotify/web-api-ts-sdk (which shipped ~50KB of types covering
// every endpoint). We only use 4 read endpoints — these inline types cover
// just what we actually access. Less code, smaller bundle, fewer surprises
// when the SDK changes shapes.

export interface SpotifyImage { url: string; width?: number; height?: number }
export interface SpotifyArtist { name: string; uri?: string }
export interface SpotifyAlbum {
	name: string;
	uri: string;
	images: SpotifyImage[];
	artists: SpotifyArtist[];
}
export interface SpotifyTrack {
	name: string;
	uri: string;
	duration_ms: number;
	artists: SpotifyArtist[];
	album: SpotifyAlbum;
	external_urls?: { spotify?: string };
}
export interface SpotifyEpisode {
	name: string;
	uri: string;
	duration_ms: number;
	images?: SpotifyImage[];
	show?: { name: string; publisher: string };
	external_urls?: { spotify?: string };
	/** Plain-text description. Spotify strips paragraph breaks from this
	 * field — for a readable rendering use `html_description` instead. */
	description?: string;
	/** Same description with `<p>`, `<br>`, `<a>` etc. tags intact. This is
	 * what the official Spotify clients use to render show notes; we
	 * convert it to plain text + newlines for display in the lyrics panel
	 * slot. (Raw HTML would be an XSS surface; we only extract structure.) */
	html_description?: string;
	/** ISO date "YYYY-MM-DD". Used in the metadata row in place of the
	 * album name for podcasts. */
	release_date?: string;
}

export interface SpotifyDevice {
	id: string;
	name: string;
	type: string;
	is_active: boolean;
	volume_percent?: number;
}

export interface SpotifyPlaybackState {
	device: SpotifyDevice;
	is_playing: boolean;
	progress_ms: number | null;
	item: SpotifyTrack | SpotifyEpisode | null;
	shuffle_state: boolean;
	repeat_state: 'off' | 'context' | 'track';
	context: { uri: string; type: string } | null;
	/** Authoritative item-type field on the playback root. Use this in
	 * preference to URI prefix sniffing when distinguishing episodes from
	 * tracks — Spotify only populates `item` correctly when our request
	 * includes `additional_types=episode`, but `currently_playing_type`
	 * is set regardless. */
	currently_playing_type?: 'track' | 'episode' | 'ad' | 'unknown';
}

export interface SpotifyDevicesResponse {
	devices: SpotifyDevice[];
}

export interface SpotifyPlaylist {
	name: string;
	uri: string;
	images: SpotifyImage[];
	owner: { display_name?: string };
}

/** Search response shape for episodes — distinct from playback's SpotifyEpisode
 * because search results don't nest the show object (it's a sibling of the
 * episode in the response). `description` doubles as a useful subtitle. */
export interface SpotifyEpisodeSearchItem {
	name: string;
	uri: string;
	images?: SpotifyImage[];
	description?: string;
	duration_ms?: number;
}

export interface SpotifyShowSearchItem {
	name: string;
	uri: string;
	images?: SpotifyImage[];
	publisher?: string;
	description?: string;
}

export interface SpotifySearchResponse {
	tracks?: { items: SpotifyTrack[] };
	albums?: { items: SpotifyAlbum[] };
	playlists?: { items: (SpotifyPlaylist | null)[] };
	episodes?: { items: (SpotifyEpisodeSearchItem | null)[] };
	shows?: { items: (SpotifyShowSearchItem | null)[] };
}

export interface SpotifyUserProfile {
	id: string;
	display_name: string;
	email?: string;
	/** "free" | "premium" | "open" — used to detect Premium-required restrictions */
	product?: 'free' | 'premium' | 'open';
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

interface RequestOpts {
	method: Method;
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
}

interface SpotifyError {
	status: number;
	message: string;
	reason?: string;
}

export class SpotifyDirectApi {
	private plugin: SpotifyControlPlugin;

	constructor(plugin: SpotifyControlPlugin) {
		this.plugin = plugin;
	}

	// ── Public surface ──────────────────────────────────────────────────────

	/**
	 * Start or resume playback.
	 *
	 * Three ways to use:
	 *   - {} → resume current playback at current position.
	 *   - { uris: [trackUri] } → play a single track in isolation (NOT
	 *     part of any context — when it ends, nothing plays after).
	 *   - { contextUri: 'spotify:playlist:abc', offset: { uri: trackUri } }
	 *     → play the playlist starting at that track. The queue continues
	 *     after the chosen track finishes. This is what you want when the
	 *     user picks a track from the queue panel — they expect the rest
	 *     of the playlist to keep playing.
	 *   - { contextUri, offset: { position: N } } → same with index instead.
	 */
	play(opts: {
		contextUri?: string;
		uris?: string[];
		positionMs?: number;
		offset?: { uri?: string; position?: number };
	} = {}) {
		const body: Record<string, unknown> = {};
		if (opts.contextUri) body.context_uri = opts.contextUri;
		if (opts.uris) body.uris = opts.uris;
		if (opts.offset !== undefined) body.offset = opts.offset;
		if (opts.positionMs !== undefined) body.position_ms = opts.positionMs;
		return this.withDeviceRetry({
			method: 'PUT',
			path: '/me/player/play',
			body: Object.keys(body).length ? body : undefined,
		});
	}

	pause() {
		return this.withDeviceRetry({ method: 'PUT', path: '/me/player/pause' });
	}

	next() {
		return this.withDeviceRetry({ method: 'POST', path: '/me/player/next' });
	}

	previous() {
		return this.withDeviceRetry({ method: 'POST', path: '/me/player/previous' });
	}

	seek(positionMs: number) {
		return this.withDeviceRetry({
			method: 'PUT',
			path: '/me/player/seek',
			query: { position_ms: Math.round(positionMs) },
		});
	}

	volume(percent: number) {
		const clamped = Math.max(0, Math.min(100, Math.round(percent)));
		return this.withDeviceRetry({
			method: 'PUT',
			path: '/me/player/volume',
			query: { volume_percent: clamped },
		});
	}

	shuffle(on: boolean) {
		return this.withDeviceRetry({
			method: 'PUT',
			path: '/me/player/shuffle',
			query: { state: on },
		});
	}

	repeat(mode: 'off' | 'context' | 'track') {
		return this.withDeviceRetry({
			method: 'PUT',
			path: '/me/player/repeat',
			query: { state: mode },
		});
	}

	queue(uri: string) {
		return this.withDeviceRetry({
			method: 'POST',
			path: '/me/player/queue',
			query: { uri },
		});
	}

	// ── Read endpoints ──────────────────────────────────────────────────────
	// These used to live in @spotify/web-api-ts-sdk; we now hit Spotify
	// directly via requestUrl for consistency + smaller bundle. Each method
	// is a one-line wrapper that types the response shape.

	/** GET /me/player — current playback state, or null if nothing is active.
	 *
	 * `additional_types=episode` is required for Spotify to include podcast
	 * episode data in the `item` field. Without it, episodes come back as
	 * `item: null` and the entire sidebar render chain blanks out when the
	 * user is listening to a podcast. */
	async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
		const r = await this.request({
			method: 'GET',
			path: '/me/player',
			query: { additional_types: 'episode' },
		});
		return r as SpotifyPlaybackState | null;
	}

	/** GET /me/player/devices — list of available devices. */
	async getAvailableDevices(): Promise<SpotifyDevicesResponse> {
		const r = await this.request({ method: 'GET', path: '/me/player/devices' });
		return (r as SpotifyDevicesResponse) ?? { devices: [] };
	}

	/** GET /search — multi-type search. */
	async search(
		q: string,
		types: Array<'track' | 'album' | 'playlist' | 'artist' | 'episode' | 'show'>,
		limit = 20,
	): Promise<SpotifySearchResponse> {
		const r = await this.request({
			method: 'GET',
			path: '/search',
			query: { q, type: types.join(','), limit },
		});
		return (r as SpotifySearchResponse) ?? {};
	}

	/** GET /me — current user profile (includes product = free|premium|open). */
	async getCurrentUser(): Promise<SpotifyUserProfile | null> {
		const r = await this.request({ method: 'GET', path: '/me' });
		return r as SpotifyUserProfile | null;
	}

	/** Transfer playback to a device. If startPlaying is true, also begins playback. */
	transferTo(deviceId: string, startPlaying = false) {
		return this.request({
			method: 'PUT',
			path: '/me/player',
			body: { device_ids: [deviceId], play: startPlaying },
		});
	}

	// ── Auto-transfer wrapper ───────────────────────────────────────────────

	/**
	 * Run a player command with two levels of resilience:
	 *
	 *  1. NO_ACTIVE_DEVICE → transfer to first available device, then retry.
	 *  2. Restriction violated → Spotify is transitioning between states
	 *     (track loading, device just woke up, ad playing). Retry once after
	 *     a short delay; if still restricted, retry once more after a longer
	 *     delay before giving up. Most of the time the original command got
	 *     queued server-side and executes anyway, which is why playback
	 *     "just starts" a few seconds after the user clicks even when we
	 *     threw an error.
	 *
	 * Returns null on silent give-up (command may still execute server-side)
	 * rather than throwing, so the caller doesn't show a noisy Notice for
	 * what's effectively a transient race condition.
	 */
	private async withDeviceRetry(opts: RequestOpts): Promise<unknown> {
		try {
			return await this.request(opts);
		} catch (e) {
			const err = e as SpotifyError;

			// Path 1: device not awake yet.
			if (err?.reason === 'NO_ACTIVE_DEVICE') {
				const transferred = await this.transferToFirstAvailable();
				if (!transferred) {
					throw new Error(
						'No Spotify devices available. Open Spotify somewhere first.',
					);
				}
				await sleep(400);
				try {
					return await this.request(opts);
				} catch (e2) {
					// Common: device just woke up but hasn't finished provisioning.
					// Wait longer and try one more time silently. If even that fails,
					// the original command is usually queued server-side and will
					// execute when the device is ready — don't bother the user.
					if (isRestrictionViolated(e2 as SpotifyError)) {
						return await this.silentRetryAfter(opts, 1200);
					}
					throw e2;
				}
			}

			// Path 2: restriction violated without prior transfer. Could be an
			// ad, a track transition, or a genuinely disallowed action. One
			// short delay + retry handles transition cases. If it persists,
			// surface a friendly message instead of "Restriction violated".
			if (isRestrictionViolated(err)) {
				// If the user is on Spotify Free, restriction-violated means
				// "this feature requires Premium" — DON'T silently retry,
				// surface a clear message immediately. Premium tier is
				// detected by auth.detectPremiumTier() shortly after login.
				if (this.plugin.isPremium === false) {
					throw new Error(
						'Spotify Premium required for this action (skip / play / shuffle / etc.).',
					);
				}
				await sleep(800);
				try {
					return await this.request(opts);
				} catch (e2) {
					if (isRestrictionViolated(e2 as SpotifyError)) {
						console.warn(
							'[spotify-control] command restricted, may execute server-side',
							opts.path,
						);
						return null;
					}
					throw e2;
				}
			}

			throw e;
		}
	}

	private async silentRetryAfter(opts: RequestOpts, delayMs: number): Promise<unknown> {
		await sleep(delayMs);
		try {
			return await this.request(opts);
		} catch (e) {
			// Spotify often still executes the queued command after a wake-up,
			// even though the API call returned an error. Log for debugging
			// but don't throw — the user gets natural feedback when the next
			// /me/player poll shows playback running.
			console.warn(
				'[spotify-control] silent retry gave up; command may still execute',
				opts.path,
				e,
			);
			return null;
		}
	}

	/**
	 * Pick a device to wake up. Returns the device ID transferred to, or null
	 * if there are no devices.
	 */
	private async transferToFirstAvailable(): Promise<string | null> {
		try {
			const resp = await this.request({
				method: 'GET',
				path: '/me/player/devices',
			});
			const devices =
				(resp as { devices?: Array<{ id: string; name: string; is_active: boolean }> })?.devices ?? [];
			if (devices.length === 0) return null;
			const target = devices.find((d) => d.is_active) ?? devices[0];
			await this.transferTo(target.id, /* startPlaying */ false);
			new Notice(`Spotify: woke up "${target.name}".`);
			return target.id;
		} catch (e) {
			console.error('[spotify-control] transfer fallback failed', e);
			return null;
		}
	}

	// ── HTTP plumbing ───────────────────────────────────────────────────────

	/**
	 * Issue one HTTP request. On 401, trigger a token refresh and retry once
	 * with the new token (so a just-expired access token doesn't bubble an
	 * error to the user when refresh would have fixed it transparently).
	 */
	private async request(opts: RequestOpts): Promise<unknown> {
		const token = this.plugin.settings.tokens?.access_token;
		if (!token) throw new Error('Not authenticated.');

		const resp = await this.doFetch(opts, token);

		if (resp.status >= 200 && resp.status < 300) {
			return parseResponseBody(resp);
		}

		if (resp.status === 401) {
			await this.plugin.auth.refresh().catch(() => undefined);
			const newToken = this.plugin.settings.tokens?.access_token;
			if (newToken && newToken !== token) {
				const retry = await this.doFetch(opts, newToken);
				if (retry.status >= 200 && retry.status < 300) {
					return parseResponseBody(retry);
				}
				throwSpotifyError(retry);
			}
		}

		throwSpotifyError(resp);
	}

	private async doFetch(opts: RequestOpts, token: string): Promise<RequestUrlResponse> {
		const url = new URL(BASE + opts.path);
		if (opts.query) {
			for (const [k, v] of Object.entries(opts.query)) {
				if (v === undefined) continue;
				url.searchParams.set(k, String(v));
			}
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
		};
		let body: string | undefined;
		if (opts.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(opts.body);
		}
		return requestUrl({
			url: url.toString(),
			method: opts.method,
			headers,
			body,
			throw: false,
		});
	}
}

function parseResponseBody(resp: RequestUrlResponse): unknown {
	const text = resp.text?.trim() ?? '';
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		// 204 endpoints sometimes return whitespace/empty-ish bodies. Treat as null.
		return null;
	}
}

function throwSpotifyError(resp: RequestUrlResponse): never {
	let parsed: { error?: { status?: number; message?: string; reason?: string } } = {};
	try {
		parsed = JSON.parse(resp.text ?? '');
	} catch {
		/* non-JSON error body, fall through */
	}
	const err: SpotifyError & Error = Object.assign(
		new Error(parsed.error?.message ?? `Spotify ${resp.status}`),
		{
			status: parsed.error?.status ?? resp.status,
			message: parsed.error?.message ?? `Spotify ${resp.status}`,
			reason: parsed.error?.reason,
		},
	);
	throw err;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Detect Spotify's generic "Player command failed: Restriction violated" 403.
 * Spotify sends this for a range of transient + permanent restrictions:
 *   - Device just woke up via transfer and isn't ready
 *   - An ad is playing
 *   - The track is loading or transitioning
 *   - The user is on Free tier (genuinely disallowed)
 * Most are transient. We match on message text because `reason` is usually
 * "UNKNOWN" for this class of error.
 */
function isRestrictionViolated(err: SpotifyError | null | undefined): boolean {
	if (!err) return false;
	if (err.status !== 403) return false;
	return /restriction violated/i.test(err.message ?? '');
}
