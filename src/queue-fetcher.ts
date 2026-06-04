/**
 * Production queue fetcher implementation.
 *
 * Lives in its own file so src/queue.ts can stay Obsidian-free.
 * Closes over the plugin instance to read the current access token.
 */

import { requestUrl } from 'obsidian';
import type SpotifyControlPlugin from './main';
import type { QueueFetcher } from './queue';

export function makeQueueFetcher(plugin: SpotifyControlPlugin): QueueFetcher {
	return async () => {
		const token = plugin.settings.tokens?.access_token;
		if (!token) return { status: 401 };
		// additional_types=episode is required for podcast episodes to show up
		// in `currently_playing` and `queue`. Without it the response omits
		// episode metadata and the queue panel goes blank during a podcast.
		const resp = await requestUrl({
			url: 'https://api.spotify.com/v1/me/player/queue?additional_types=episode',
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		return { status: resp.status, json: resp.json };
	};
}
