/**
 * Spotify search palette.
 *
 * Uses Obsidian's SuggestModal so it feels like the command palette.
 * Debounces input by 250ms to avoid hammering /search.
 * Results mix tracks + albums + playlists + episodes + shows. Selecting
 * prompts play-now vs add-to-queue for items that play as a single URI
 * (tracks, episodes). Items that play as contexts (albums, playlists,
 * shows) always "play now".
 *
 * Reads use the SDK (returns proper JSON). Writes (play, queue) go through
 * plugin.api to avoid the SDK's 204 deserialize bug.
 */

import { App, Modal, Notice, SuggestModal, Setting } from 'obsidian';
import type SpotifyControlPlugin from './main';

type Kind = 'track' | 'album' | 'playlist' | 'episode' | 'show';

/**
 * How an item is played by Spotify's API.
 *   - "uri" → POST /play with `uris: [uri]` (single item; supports queue)
 *   - "context" → POST /play with `context_uri: uri` (starts a collection)
 */
type PlayShape = 'uri' | 'context';

const PLAY_SHAPE: Record<Kind, PlayShape> = {
	track: 'uri',
	episode: 'uri',
	album: 'context',
	playlist: 'context',
	show: 'context',
};

interface Result {
	kind: Kind;
	name: string;
	subtitle: string;
	uri: string;
	imageUrl: string | null;
}

export class SpotifySearchModal extends SuggestModal<Result> {
	private plugin: SpotifyControlPlugin;
	private debounceHandle: number | null = null;
	private latestQuery = '';
	private queryGeneration = 0;

	constructor(app: App, plugin: SpotifyControlPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Search Spotify — tracks, albums, playlists, podcasts…');
		this.emptyStateText = 'No results.';
	}

	/**
	 * Returns results for the current query. Guards against out-of-order
	 * resolution: each call increments a generation counter, and when an
	 * in-flight fetch finally resolves, it checks whether a newer call has
	 * superseded it. Without this, fast typing could cause an older,
	 * slower-returning fetch to overwrite the newer one's results.
	 */
	getSuggestions(query: string): Promise<Result[]> {
		this.latestQuery = query;
		const myGen = ++this.queryGeneration;
		return new Promise((resolve) => {
			if (this.debounceHandle != null) window.clearTimeout(this.debounceHandle);
			this.debounceHandle = window.setTimeout(async () => {
				if (myGen !== this.queryGeneration || query !== this.latestQuery) {
					resolve([]);
					return;
				}
				if (!this.plugin.auth.isAuthed || query.trim().length === 0) {
					resolve([]);
					return;
				}
				try {
					const r = await this.plugin.api.search(
						query,
						['track', 'album', 'playlist', 'episode', 'show'],
						5,
					);
					// Generation check AFTER await — a newer query may have
					// fired while we waited for the API. Discard stale results.
					if (myGen !== this.queryGeneration) {
						resolve([]);
						return;
					}
					const results: Result[] = [];
					for (const t of r.tracks?.items ?? []) {
						results.push({
							kind: 'track',
							name: t.name,
							subtitle: `${t.artists.map((a) => a.name).join(', ')} — ${t.album.name}`,
							uri: t.uri,
							imageUrl: t.album.images?.[0]?.url ?? null,
						});
					}
					for (const a of r.albums?.items ?? []) {
						results.push({
							kind: 'album',
							name: a.name,
							subtitle: `Album — ${a.artists.map((x) => x.name).join(', ')}`,
							uri: a.uri,
							imageUrl: a.images?.[0]?.url ?? null,
						});
					}
					for (const p of r.playlists?.items ?? []) {
						// Spotify sometimes returns null entries in playlist results
						// (deleted playlists, etc.) — narrow with a type guard
						// instead of .filter(Boolean) which TS can't track.
						if (!p) continue;
						results.push({
							kind: 'playlist',
							name: p.name,
							subtitle: `Playlist — ${p.owner?.display_name ?? ''}`,
							uri: p.uri,
							imageUrl: p.images?.[0]?.url ?? null,
						});
					}
					for (const e of r.episodes?.items ?? []) {
						// Same null-entry guard — Spotify includes nulls for
						// region-blocked or removed episodes/shows.
						if (!e) continue;
						const desc = e.description?.trim();
						results.push({
							kind: 'episode',
							name: e.name,
							subtitle: desc
								? `Episode — ${truncate(desc, 80)}`
								: 'Episode',
							uri: e.uri,
							imageUrl: e.images?.[0]?.url ?? null,
						});
					}
					for (const s of r.shows?.items ?? []) {
						if (!s) continue;
						results.push({
							kind: 'show',
							name: s.name,
							subtitle: s.publisher
								? `Podcast — ${s.publisher}`
								: 'Podcast',
							uri: s.uri,
							imageUrl: s.images?.[0]?.url ?? null,
						});
					}
					resolve(results);
				} catch (e: any) {
					console.error('[spotify-control] search failed', e);
					new Notice(`Search failed: ${e?.message ?? e}`);
					resolve([]);
				}
			}, 250);
		});
	}

	renderSuggestion(item: Result, el: HTMLElement): void {
		el.addClass('sc-search-item');
		if (item.imageUrl) {
			const img = el.createEl('img', { cls: 'sc-search-thumb' });
			img.src = item.imageUrl;
		} else {
			el.createDiv({ cls: 'sc-search-thumb sc-search-thumb-placeholder' });
		}
		const body = el.createDiv({ cls: 'sc-search-body' });
		body.createDiv({ cls: 'sc-search-name', text: item.name });
		body.createDiv({ cls: 'sc-search-sub', text: item.subtitle });
		const kindEl = el.createDiv({ cls: 'sc-search-kind', text: item.kind });
		kindEl.addClass(`sc-kind-${item.kind}`);
	}

	async onChooseSuggestion(item: Result): Promise<void> {
		if (!this.plugin.settings.tokens) return;
		// Items that play as a single URI (tracks, episodes) get the
		// play-now-vs-add-to-queue prompt. Items that play as a context
		// (albums, playlists, shows) just play now.
		if (PLAY_SHAPE[item.kind] === 'uri') {
			new TrackActionModal(this.app, item, this.plugin).open();
		} else {
			try {
				await this.plugin.api.play({ contextUri: item.uri });
				new Notice(`Playing ${item.kind}: ${item.name}`);
			} catch (e: any) {
				new Notice(`Couldn't play: ${e?.message ?? e}`);
			}
		}
	}
}

/** Tight ellipsis truncation for episode descriptions. */
function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}

class TrackActionModal extends Modal {
	private track: Result;
	private plugin: SpotifyControlPlugin;

	constructor(app: App, track: Result, plugin: SpotifyControlPlugin) {
		super(app);
		this.track = track;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.track.name });
		contentEl.createEl('p', { text: this.track.subtitle });
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Play now')
					.setCta()
					.onClick(async () => {
						await this.act('play');
						this.close();
					}),
			)
			.addButton((b) =>
				b.setButtonText('Add to queue').onClick(async () => {
					await this.act('queue');
					this.close();
				}),
			);
	}

	async act(kind: 'play' | 'queue') {
		if (!this.plugin.settings.tokens) return;
		try {
			if (kind === 'play') {
				await this.plugin.api.play({ uris: [this.track.uri] });
				new Notice(`Playing: ${this.track.name}`);
			} else {
				await this.plugin.api.queue(this.track.uri);
				new Notice(`Queued: ${this.track.name}`);
			}
		} catch (e: any) {
			new Notice(`Failed: ${e?.message ?? e}`);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
