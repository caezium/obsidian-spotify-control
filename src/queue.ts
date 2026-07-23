/**
 * Spotify queue fetching.
 *
 * Endpoint: GET /me/player/queue — returns currently_playing + an array of
 * upcoming items (tracks or episodes). Requires user-read-currently-playing
 * scope (we already have it).
 *
 * Strategy:
 *   - Light TTL cache (a few seconds) so opening/closing the panel rapidly
 *     doesn't hit the API every time.
 *   - Refetch when current track changes (the queue reorders when you play
 *     a new context anyway).
 *   - Pure logic — fetcher injected so tests can stub it and the runtime
 *     uses Obsidian's requestUrl via src/queue-fetcher.ts.
 */

export interface QueueItem {
	name: string;
	artist: string;
	album: string;
	uri: string;
	imageUrl: string | null;
	durationMs: number;
	kind: 'track' | 'episode';
}

export interface QueueSnapshot {
	upcoming: QueueItem[];
	/** URI of the currently-playing track when this snapshot was taken.
	 * Used to invalidate the cache when the user skips tracks externally
	 * (manually via Spotify app) so the next get() refetches instead of
	 * serving stale "this is what's coming next" data. */
	currentTrackUri: string | null;
	fetchedAt: number;
}

const CACHE_TTL_MS = 5_000;

/** Fetcher signature — returns parsed JSON body. */
export type QueueFetcher = () => Promise<{ status: number; json?: unknown }>;

export class QueueService {
	private fetcher: QueueFetcher;
	private cache: QueueSnapshot | null = null;
	private inflight: Promise<QueueSnapshot> | null = null;

	constructor(fetcher: QueueFetcher) {
		this.fetcher = fetcher;
	}

	/**
	 * Get the upcoming queue. Uses TTL cache + in-flight dedupe.
	 *
	 * `currentTrackUri` (optional): URI of what's currently playing. When
	 * provided, the cache is invalidated if the current track differs from
	 * the snapshot's recorded track — covers the case where the user
	 * manually skipped tracks in the Spotify app between our polls.
	 *
	 * Pass force=true to bypass the cache entirely.
	 */
	async get(force = false, currentTrackUri?: string | null): Promise<QueueSnapshot> {
		const trackChanged =
			currentTrackUri !== undefined &&
			this.cache !== null &&
			currentTrackUri !== this.cache.currentTrackUri;
		if (
			!force &&
			!trackChanged &&
			this.cache &&
			Date.now() - this.cache.fetchedAt < CACHE_TTL_MS
		) {
			return this.cache;
		}
		if (this.inflight) return this.inflight;
		this.inflight = this.fetch(currentTrackUri ?? null).then((snap) => {
			this.cache = snap;
			this.inflight = null;
			return snap;
		});
		return this.inflight;
	}

	clear() {
		this.cache = null;
	}

	private async fetch(fallbackTrackUri: string | null): Promise<QueueSnapshot> {
		const empty: QueueSnapshot = {
			upcoming: [],
			currentTrackUri: fallbackTrackUri,
			fetchedAt: Date.now(),
		};
		try {
			const resp = await this.fetcher();
			if (resp.status >= 400) {
				console.warn('[spotify-control] queue fetch HTTP', resp.status);
				return empty;
			}
			const body = parseQueueResponse(resp.json);
			if (!body) return empty;
			return {
				upcoming: body.queue,
				currentTrackUri: body.currentTrackUri ?? fallbackTrackUri,
				fetchedAt: Date.now(),
			};
		} catch (e) {
			console.warn('[spotify-control] queue fetch failed', e);
			return empty;
		}
	}
}

interface ParsedQueueResponse {
	currentTrackUri: string | null;
	queue: QueueItem[];
}

function parseQueueResponse(value: unknown): ParsedQueueResponse | null {
	if (!isRecord(value) || !Array.isArray(value.queue)) return null;
	const currentTrackUri = isRecord(value.currently_playing)
		? optionalString(value.currently_playing.uri)
		: null;
	return {
		currentTrackUri,
		queue: value.queue
			.map(normalizeItem)
			.filter((item): item is QueueItem => item !== null),
	};
}

function normalizeItem(raw: unknown): QueueItem | null {
	if (!isRecord(raw)) return null;
	const uri = optionalString(raw.uri);
	if (!uri) return null;
	const show = isRecord(raw.show) ? raw.show : null;
	const album = isRecord(raw.album) ? raw.album : null;
	const isEpisode = raw.type === 'episode' || show !== null;
	return {
		name: optionalString(raw.name) ?? '(unknown)',
		artist: artistNames(raw.artists) ?? optionalString(show?.name) ?? '',
		album: optionalString(album?.name) ?? optionalString(show?.publisher) ?? '',
		uri,
		imageUrl: firstImageUrl(album?.images) ?? firstImageUrl(raw.images),
		durationMs: optionalNumber(raw.duration_ms) ?? 0,
		kind: isEpisode ? 'episode' : 'track',
	};
}

function artistNames(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const names = value
		.map((artist) => isRecord(artist) ? optionalString(artist.name) : null)
		.filter((name): name is string => name !== null);
	return names.length > 0 ? names.join(', ') : null;
}

function firstImageUrl(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const first: unknown = value[0];
	return isRecord(first) ? optionalString(first.url) : null;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
