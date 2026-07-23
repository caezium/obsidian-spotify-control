/**
 * Hotkey-bindable transport commands.
 *
 * All commands work whether or not the sidebar is open. They no-op (with a
 * Notice) if the user isn't logged in. Player writes go through plugin.api
 * (direct requestUrl) so they don't hit the SDK's 204-body parse bug; reads
 * still use the SDK because typed shapes are nicer for getPlaybackState etc.
 */

import { Editor, Notice } from 'obsidian';
import type SpotifyControlPlugin from './main';
import { registerCaptureCommands } from './capture-commands';
import { SpotifySearchModal } from './search';
import { SpotifyView, SPOTIFY_VIEW_TYPE } from './view';
import { errorMessage, parseSpotifyResource } from './util';

export function registerCommands(plugin: SpotifyControlPlugin) {
	const requireAuth = () => {
		if (!plugin.settings.tokens) {
			new Notice('Spotify not connected. Open settings to log in.');
			return false;
		}
		return true;
	};

	plugin.addCommand({
		id: 'open-sidebar',
		name: 'Open Spotify sidebar',
		callback: () => plugin.activateView(),
	});

	plugin.addCommand({
		id: 'open-web-player',
		name: 'Open Spotify web player',
		callback: () => plugin.openSpotifyWebPlayer(),
	});

	plugin.addCommand({
		id: 'toggle-lyrics',
		name: 'Toggle lyrics view',
		callback: () => {
			if (!plugin.settings.enableLyrics) {
				new Notice('Lyrics are disabled in Spotify Control settings.');
				return;
			}
			// Find the sidebar view and toggle its lyrics panel.
			const leaves = plugin.app.workspace.getLeavesOfType(SPOTIFY_VIEW_TYPE);
			if (leaves.length === 0) {
				plugin.activateView().catch((error: unknown) => {
					console.error('[spotify-control] open sidebar failed', error);
					new Notice(`Could not open the Spotify sidebar: ${errorMessage(error)}`);
				});
				new Notice('Open the Spotify sidebar first.');
				return;
			}
			const view = leaves[0].view;
			if (view instanceof SpotifyView) view.togglePanel('lyrics');
		},
	});

	plugin.addCommand({
		id: 'toggle-playback',
		name: 'Play / pause',
		callback: async () => {
			if (!requireAuth()) return;
			try {
				const state = await plugin.api.getPlaybackState();
				if (state?.is_playing) await plugin.api.pause();
				else await plugin.api.play();
			} catch (error: unknown) {
				new Notice(`Play/pause: ${errorMessage(error)}`);
			}
		},
	});

	plugin.addCommand({
		id: 'next-track',
		name: 'Next track',
		callback: async () => {
			if (!requireAuth()) return;
			try {
				await plugin.api.next();
			} catch (error: unknown) {
				new Notice(`Next: ${errorMessage(error)}`);
			}
		},
	});

	plugin.addCommand({
		id: 'previous-track',
		name: 'Previous track',
		callback: async () => {
			if (!requireAuth()) return;
			try {
				await plugin.api.previous();
			} catch (error: unknown) {
				new Notice(`Previous: ${errorMessage(error)}`);
			}
		},
	});

	plugin.addCommand({
		id: 'volume-up',
		name: 'Volume up (+10%)',
		callback: () => adjustVolume(plugin, +10),
	});
	plugin.addCommand({
		id: 'volume-down',
		name: 'Volume down (−10%)',
		callback: () => adjustVolume(plugin, -10),
	});

	plugin.addCommand({
		id: 'toggle-shuffle',
		name: 'Toggle shuffle',
		callback: async () => {
			if (!requireAuth()) return;
			try {
				const state = await plugin.api.getPlaybackState();
				const next = !state?.shuffle_state;
				await plugin.api.shuffle(next);
				new Notice(`Shuffle ${next ? 'on' : 'off'}`);
			} catch (error: unknown) {
				new Notice(`Shuffle: ${errorMessage(error)}`);
			}
		},
	});

	plugin.addCommand({
		id: 'search',
		name: 'Search Spotify…',
		callback: () => {
			if (!requireAuth()) return;
			new SpotifySearchModal(plugin.app, plugin).open();
		},
	});

	plugin.addCommand({
		id: 'play-uri-under-cursor',
		name: 'Play Spotify URI/URL under cursor',
		editorCallback: async (editor: Editor) => {
			if (!requireAuth()) return;
			const line = editor.getLine(editor.getCursor().line);
			const resource = parseSpotifyResource(line);
			if (!resource) {
				new Notice('No Spotify URI or URL found on this line.');
				return;
			}
			try {
				// Tracks + episodes play as items; albums/playlists/artists/shows
				// play as context. (Type comes from the regex capture group, not
				// substring matching — so an album named "track suit" doesn't
				// accidentally play as a single track.)
				if (resource.kind === 'track' || resource.kind === 'episode') {
					await plugin.api.play({ uris: [resource.uri] });
				} else {
					await plugin.api.play({ contextUri: resource.uri });
				}
				new Notice('Spotify: playing.');
			} catch (error: unknown) {
				new Notice(`Play failed: ${errorMessage(error)}`);
			}
		},
	});

	registerCaptureCommands(plugin, requireAuth);
}

async function adjustVolume(plugin: SpotifyControlPlugin, delta: number) {
	if (!plugin.settings.tokens) {
		new Notice('Spotify not connected.');
		return;
	}
	try {
		const state = await plugin.api.getPlaybackState();
		const cur = state?.device?.volume_percent ?? 50;
		const next = Math.max(0, Math.min(100, cur + delta));
		await plugin.api.volume(next);
		new Notice(`Volume: ${next}%`);
	} catch (error: unknown) {
		new Notice(`Volume: ${errorMessage(error)}`);
	}
}

export { SPOTIFY_VIEW_TYPE };
