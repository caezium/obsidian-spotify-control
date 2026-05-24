/**
 * Spotify OAuth via PKCE (Proof Key for Code Exchange).
 *
 * Why PKCE instead of Authorization Code + client_secret:
 *   - Obsidian is an "untrusted" client. A client_secret stored in data.json
 *     on disk isn't actually secret; PKCE is what Spotify recommends for native
 *     and SPA clients.
 *   - Users only need to paste the Client ID, not the Secret. Simpler setup.
 *
 * Flow:
 *   1. Generate code_verifier (random) + code_challenge (sha256(verifier), base64url)
 *   2. Open browser to /authorize with the challenge
 *   3. Spotify redirects to obsidian://spotify-control/auth with ?code=...&state=...
 *   4. Plugin's protocol handler exchanges code + verifier for tokens at /api/token
 *   5. Schedule a refresh ~60s before the access token expires.
 *
 * Reliability features:
 *   - Refresh is deduped — concurrent callers share one in-flight POST so we
 *     never accidentally invalidate a freshly-rotated refresh token.
 *   - 4xx on refresh = terminal (clear tokens, prompt re-login). 5xx/network
 *     = transient (exponential backoff retry up to 5 min).
 *   - Custom IAuthStrategy means the SDK never tries to refresh on its own,
 *     so we don't need to monkey-patch its internals.
 */

import { Notice, requestUrl } from 'obsidian';
import type SpotifyControlPlugin from './main';
import { REDIRECT_URI, SCOPES, SpotifyAccessToken } from './types';
import { randomString, sha256Base64Url } from './util';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** In-flight PKCE state. Lives only between "login clicked" and "redirect received". */
interface PendingAuth {
	state: string;
	codeVerifier: string;
}

export class SpotifyAuth {
	private plugin: SpotifyControlPlugin;
	private pending: PendingAuth | null = null;
	private refreshTimer: number | null = null;
	/** Backoff counter for transient refresh failures. */
	private consecutiveRefreshFailures = 0;
	/** In-flight refresh promise — concurrent callers await this one. */
	private inflightRefresh: Promise<void> | null = null;
	/**
	 * Convenience: whether we currently have a usable access token. The
	 * @spotify/web-api-ts-sdk used to live here as `api`; now removed in
	 * favor of plugin.api (our SpotifyDirectApi) for all reads + writes,
	 * saving ~50KB of bundle.
	 */
	get isAuthed(): boolean {
		return !!this.plugin.settings.tokens?.access_token;
	}

	constructor(plugin: SpotifyControlPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Called from Plugin.onload(). Restores SDK from stored tokens, schedules refresh.
	 */
	async restore() {
		const tokens = this.plugin.settings.tokens;
		if (!tokens?.refresh_token) return;
		// If access token is expired or near-expired, refresh immediately.
		if (this.isExpired(tokens)) {
			await this.refresh().catch((e) => {
				console.error('[spotify-control] refresh on restore failed', e);
			});
		} else {
			this.scheduleRefresh(tokens);
		}
		// Cache Premium tier in the background — non-blocking.
		this.detectPremiumTier();
	}

	/**
	 * Build the authorize URL and open it in the user's browser.
	 * Stores verifier + state in `pending` so the redirect handler can match.
	 */
	async beginLogin() {
		const clientId = this.plugin.settings.clientId.trim();
		if (!clientId) {
			new Notice('Set your Spotify Client ID in plugin settings first.');
			return;
		}
		const codeVerifier = randomString(64);
		const codeChallenge = await sha256Base64Url(codeVerifier);
		const state = randomString(32);
		this.pending = { state, codeVerifier };

		const url = new URL(AUTHORIZE_URL);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', clientId);
		url.searchParams.set('redirect_uri', REDIRECT_URI);
		url.searchParams.set('scope', SCOPES);
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('code_challenge', codeChallenge);

		// Open in OS default browser via Electron's shell handler.
		// noopener,noreferrer hardens against window.opener back-references.
		window.open(url.toString(), '_blank', 'noopener,noreferrer');
		new Notice('Spotify login opened in your browser.');
	}

	/**
	 * Handler registered with Plugin.registerObsidianProtocolHandler('spotify-control/auth').
	 * Exchanges the auth code for tokens.
	 */
	async handleRedirect(params: Record<string, string>) {
		if (!this.pending) {
			new Notice('Spotify: unexpected auth callback (no pending login).');
			return;
		}
		if (params.state !== this.pending.state) {
			new Notice('Spotify: state mismatch — possible CSRF, login aborted.');
			this.pending = null;
			return;
		}
		if (params.error) {
			new Notice(`Spotify auth error: ${params.error}`);
			this.pending = null;
			return;
		}
		const code = params.code;
		if (!code) {
			new Notice('Spotify: no code in callback.');
			this.pending = null;
			return;
		}

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT_URI,
			client_id: this.plugin.settings.clientId,
			code_verifier: this.pending.codeVerifier,
		}).toString();

		try {
			const resp = await requestUrl({
				url: TOKEN_URL,
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
				throw: false,
			});
			if (resp.status >= 400) {
				new Notice(`Spotify token exchange failed: ${resp.status}`);
				console.error('[spotify-control] token exchange', resp.status, resp.text);
				return;
			}
			const data = resp.json as SpotifyAccessToken;
			data.expires_at = Date.now() + data.expires_in * 1000;
			this.plugin.settings.tokens = data;
			await this.plugin.saveSettings();

			this.consecutiveRefreshFailures = 0;
			this.scheduleRefresh(data);
			new Notice('Spotify connected.');
			this.plugin.onAuthChanged();
			// Detect Premium tier once on connection so the API layer can
			// distinguish "you're on Free, this is genuinely disallowed"
			// from "transient restriction, please retry".
			this.detectPremiumTier();
		} finally {
			this.pending = null;
		}
	}

	/**
	 * Fetch /me once and cache the `product` field on the plugin so the
	 * api layer can surface "Premium required" instead of silently
	 * swallowing restriction-violated errors for Free-tier users.
	 */
	private async detectPremiumTier() {
		try {
			const me = await this.plugin.api.getCurrentUser();
			this.plugin.isPremium = me?.product === 'premium';
		} catch (e) {
			// Non-fatal — default false means we'll show clearer messaging
			// even if we couldn't confirm. Better than over-claiming Premium.
			console.warn('[spotify-control] tier detection failed', e);
			this.plugin.isPremium = false;
		}
	}

	/**
	 * Refresh the access token using the refresh_token.
	 *
	 * Concurrency-safe: if a refresh is already in flight, returns the same
	 * promise. Prevents two concurrent POSTs which could end with one
	 * invalidating the other's refresh token (Spotify rotates them sometimes).
	 *
	 * Retry policy:
	 *   - 4xx: terminal. The refresh token is no good (revoked, expired,
	 *     client_id mismatch). Clear tokens, notify the user, stop retrying.
	 *   - 5xx / network error: transient. Exponential backoff: 30s, 60s, 2m, 5m, 5m…
	 */
	/**
	 * Proper sequential mutex. The previous version had a theoretical race:
	 * two callers could BOTH pass the null check at the same tick before
	 * either assigned `this.inflightRefresh`. JS's event loop made that
	 * essentially impossible in practice, but this version is provably
	 * safe — we assign the promise BEFORE awaiting anything, and chain
	 * subsequent calls onto the existing chain. Truly serialized.
	 */
	async refresh(): Promise<void> {
		const chain = this.inflightRefresh ?? Promise.resolve();
		const next = chain.then(() => this.doRefresh()).finally(() => {
			// Clear only if we're still the tail of the chain. If another
			// caller queued behind us, leave inflightRefresh pointing to
			// their (newer) promise.
			if (this.inflightRefresh === next) this.inflightRefresh = null;
		});
		this.inflightRefresh = next;
		return next;
	}

	private async doRefresh(): Promise<void> {
		const tokens = this.plugin.settings.tokens;
		if (!tokens?.refresh_token) return;
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: tokens.refresh_token,
			client_id: this.plugin.settings.clientId,
		}).toString();
		let resp;
		try {
			resp = await requestUrl({
				url: TOKEN_URL,
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
				throw: false,
			});
		} catch (e) {
			// Network error — transient. Back off and retry.
			console.error('[spotify-control] refresh network error', e);
			this.scheduleBackoffRetry();
			return;
		}
		if (resp.status >= 500) {
			console.error('[spotify-control] refresh 5xx', resp.status, resp.text);
			this.scheduleBackoffRetry();
			return;
		}
		if (resp.status >= 400) {
			// 400/401 — refresh token is dead. Don't loop forever.
			console.error(
				'[spotify-control] refresh terminal failure',
				resp.status,
				resp.text,
			);
			this.clearTimer();
			this.plugin.settings.tokens = null;
			await this.plugin.saveSettings();
			
			this.consecutiveRefreshFailures = 0;
			new Notice(
				'Spotify session expired and re-login is required (settings → Spotify Control → Log in).',
				15_000,
			);
			this.plugin.onAuthChanged();
			return;
		}
		const data = resp.json as SpotifyAccessToken;
		// Spotify may not return a new refresh_token on every refresh — keep the old one.
		if (!data.refresh_token) data.refresh_token = tokens.refresh_token;
		data.expires_at = Date.now() + data.expires_in * 1000;
		this.plugin.settings.tokens = data;
		await this.plugin.saveSettings();
		
		this.consecutiveRefreshFailures = 0;
		this.scheduleRefresh(data);
	}

	async logout() {
		this.clearTimer();
		// Best-effort token revocation on Spotify's side. PKCE clients can
		// revoke their refresh token via the /api/token/revoke endpoint; this
		// makes the token unusable even if the data.json leaks AFTER logout.
		// Fire-and-forget — if Spotify is unreachable or doesn't accept the
		// request, we still clear local state.
		const tokens = this.plugin.settings.tokens;
		if (tokens?.refresh_token) {
			this.revokeRefreshTokenBestEffort(tokens.refresh_token);
		}
		this.plugin.settings.tokens = null;
		this.consecutiveRefreshFailures = 0;
		await this.plugin.saveSettings();
		this.plugin.onAuthChanged();
		new Notice('Spotify disconnected.');
	}

	/** Don't await — if it fails, that's fine, local state is already cleared. */
	private revokeRefreshTokenBestEffort(refreshToken: string): void {
		const body = new URLSearchParams({
			token: refreshToken,
			token_type_hint: 'refresh_token',
			client_id: this.plugin.settings.clientId,
		}).toString();
		requestUrl({
			url: 'https://accounts.spotify.com/api/token/revoke',
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
			throw: false,
		}).catch((e) => {
			// Spotify's revoke endpoint isn't formally documented for PKCE
			// clients and returns 404 in some setups. Non-fatal.
			console.warn('[spotify-control] token revoke attempt failed (non-fatal)', e);
		});
	}

	onUnload() {
		this.clearTimer();
	}

	/** Used by IAuthStrategy adapter so the SDK can fetch current token. */
	getCurrentTokens(): SpotifyAccessToken | null {
		return this.plugin.settings.tokens;
	}

	/** Used by IAuthStrategy adapter to refresh inline if SDK detects expiry. */
	async ensureFreshToken(): Promise<SpotifyAccessToken | null> {
		const t = this.plugin.settings.tokens;
		if (!t) return null;
		if (this.isExpired(t)) await this.refresh();
		return this.plugin.settings.tokens;
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private isExpired(t: SpotifyAccessToken): boolean {
		if (!t.expires_at) return true;
		// Treat anything within 30s of expiry as expired so we refresh proactively.
		return Date.now() > t.expires_at - 30_000;
	}

	private scheduleRefresh(tokens: SpotifyAccessToken) {
		this.clearTimer();
		const expiresAt = tokens.expires_at ?? Date.now() + tokens.expires_in * 1000;
		// Refresh 60s before expiry. Clamp to a minimum of 30s in case of clock skew.
		const delay = Math.max(30_000, expiresAt - Date.now() - 60_000);
		this.refreshTimer = window.setTimeout(() => {
			this.refresh().catch((e) =>
				console.error('[spotify-control] scheduled refresh failed', e),
			);
		}, delay);
	}

	private scheduleBackoffRetry() {
		this.clearTimer();
		this.consecutiveRefreshFailures++;
		// 30s, 60s, 120s, 300s, 300s…  (cap at 5 min)
		const schedule = [30_000, 60_000, 120_000, 300_000];
		const delay =
			schedule[Math.min(this.consecutiveRefreshFailures - 1, schedule.length - 1)];
		console.warn(
			`[spotify-control] retry refresh in ${delay / 1000}s (attempt ${this.consecutiveRefreshFailures})`,
		);
		this.refreshTimer = window.setTimeout(() => this.refresh(), delay);
	}

	private clearTimer() {
		if (this.refreshTimer != null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

// (PluginAuthStrategy + emptyAccessToken removed — were only needed by
// @spotify/web-api-ts-sdk's IAuthStrategy interface. SDK is gone now.)
