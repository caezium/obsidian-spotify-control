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

interface RawQueueResponse {
	currently_playing?: any;
	queue?: any[];
}

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
			const body = resp.json as RawQueueResponse | undefined;
			if (!body?.queue) return empty;
			return {
				upcoming: body.queue.map(normalizeItem).filter((x): x is QueueItem => !!x),
				currentTrackUri: body.currently_playing?.uri ?? fallbackTrackUri,
				fetchedAt: Date.now(),
			};
		} catch (e) {
			console.warn('[spotify-control] queue fetch failed', e);
			return empty;
		}
	}
}

function normalizeItem(raw: any): QueueItem | null {
	if (!raw?.uri) return null;
	const isEpisode = raw.type === 'episode' || !!raw.show;
	return {
		name: raw.name ?? '(unknown)',
		artist:
			raw.artists?.map((a: any) => a.name).join(', ') ?? raw.show?.name ?? '',
		album: raw.album?.name ?? raw.show?.publisher ?? '',
		uri: raw.uri,
		imageUrl:
			raw.album?.images?.[0]?.url ?? raw.images?.[0]?.url ?? null,
		durationMs: raw.duration_ms ?? 0,
		kind: isEpisode ? 'episode' : 'track',
	};
}
