/**
 * Production lyrics fetcher implementation.
 *
 * Lives in its own file so src/lyrics.ts can stay Obsidian-free and run
 * under node:test. main.ts imports this and passes it to the LyricsService.
 */

import { requestUrl } from 'obsidian';
import type { LyricsFetcher } from './lyrics';

export const obsidianLyricsFetcher: LyricsFetcher = async (url) => {
	const resp = await requestUrl({ url, method: 'GET', throw: false });
	return { status: resp.status, json: resp.json };
};
