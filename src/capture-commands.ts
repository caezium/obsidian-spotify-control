/**
 * Note and lyrics capture commands.
 *
 * Kept separate from transport commands because these workflows coordinate
 * Spotify reads, editor handoff, templating, and vault writes.
 */

import {
	MarkdownView,
	normalizePath,
	Notice,
	TFile,
	TFolder,
} from 'obsidian';
import type SpotifyControlPlugin from './main';
import {
	addCapturePathSuffix,
	buildCapturePath,
	buildNowPlayingDetails,
	captureContentMatches,
	lyricsExportFile,
	lyricsForInsertion,
	settleCaptureTarget,
	withCaptureIdentity,
	withLyricsVariables,
} from './capture';
import type {
	NowPlayingDetails,
	NowPlayingTemplateVariables,
} from './capture';
import type { LyricsResult } from './lyrics';
import { renderTemplate } from './util';

type RequireAuth = () => boolean;

export function registerCaptureCommands(
	plugin: SpotifyControlPlugin,
	requireAuth: RequireAuth,
): void {
	const guarded =
		(failureLabel: string, action: () => Promise<void>) => async (): Promise<void> => {
			if (!requireAuth()) return;
			try {
				await action();
			} catch (error: unknown) {
				new Notice(`${failureLabel}: ${errorMessage(error)}`);
			}
		};

	plugin.addCommand({
		id: 'insert-now-playing',
		name: 'Insert now-playing into note',
		callback: guarded('Insert failed', async () => {
			const initialTargetId = activeMarkdownTargetId(plugin);
			const details = await getNowPlayingDetails(plugin);
			if (!details) return;
			const variables = await variablesForTemplate(
				plugin,
				details,
				plugin.settings.insertTemplate,
			);
			const text = renderTemplate(plugin.settings.insertTemplate, variables);
			await insertIntoActiveNote(plugin, text, initialTargetId);
		}),
	});

	plugin.addCommand({
		id: 'create-now-playing-note',
		name: 'Create note from now playing',
		callback: guarded('Create note failed', async () => {
			const details = await getNowPlayingDetails(plugin);
			if (!details) return;
			const basePath = normalizePath(
				buildCapturePath(
					plugin.settings.nowPlayingNoteFolder,
					plugin.settings.nowPlayingNoteNameTemplate,
					details.variables,
					'md',
				),
			);
			const destination = await resolveNowPlayingNote(
				plugin,
				basePath,
				details.variables,
			);
			if (destination.existing) {
				await openFile(plugin, destination.existing);
				new Notice(`Opened existing note: ${destination.path}`);
				return;
			}

			const variables = await variablesForTemplate(
				plugin,
				details,
				plugin.settings.nowPlayingNoteTemplate,
			);
			const rendered = renderTemplate(
				plugin.settings.nowPlayingNoteTemplate,
				variables,
			);
			const content = withCaptureIdentity(rendered, details.variables.uri);
			await ensureParentFolder(plugin, destination.path);
			const file = await plugin.app.vault.create(destination.path, content);
			await openFile(plugin, file);
			new Notice(`Created now-playing note: ${destination.path}`);
		}),
	});

	plugin.addCommand({
		id: 'insert-now-playing-lyrics',
		name: 'Insert now-playing lyrics into note',
		callback: guarded('Insert lyrics failed', async () => {
			const initialTargetId = activeMarkdownTargetId(plugin);
			const capture = await getNowPlayingWithLyrics(plugin);
			if (!capture) return;
			const variables = withLyricsVariables(
				capture.details.variables,
				capture.lyrics,
			);
			const text = renderTemplate(
				plugin.settings.lyricsInsertTemplate,
				variables,
			);
			await insertIntoActiveNote(plugin, text, initialTargetId);
		}),
	});

	plugin.addCommand({
		id: 'copy-now-playing-lyrics',
		name: 'Copy now-playing lyrics',
		callback: guarded('Copy lyrics failed', async () => {
			const capture = await getNowPlayingWithLyrics(plugin);
			if (!capture) return;
			await navigator.clipboard.writeText(lyricsForInsertion(capture.lyrics));
			new Notice('Copied now-playing lyrics.');
		}),
	});

	plugin.addCommand({
		id: 'save-now-playing-lyrics',
		name: 'Save now-playing lyrics file',
		callback: guarded('Save lyrics failed', async () => {
			const capture = await getNowPlayingWithLyrics(plugin);
			if (!capture) return;
			const exported = lyricsExportFile(capture.lyrics);
			if (!exported) {
				new Notice('No lyrics found for the current track.');
				return;
			}
			const basePath = normalizePath(
				buildCapturePath(
					plugin.settings.lyricsFolder,
					plugin.settings.nowPlayingNoteNameTemplate,
					capture.details.variables,
					exported.extension,
				),
			);
			const destination = await resolveLyricsFile(
				plugin,
				basePath,
				exported.content,
			);
			if (destination.existing) {
				new Notice(`Lyrics file already exists: ${destination.path}`);
				return;
			}
			await ensureParentFolder(plugin, destination.path);
			await plugin.app.vault.create(destination.path, exported.content);
			new Notice(`Saved lyrics: ${destination.path}`);
		}),
	});
}

async function getNowPlayingDetails(
	plugin: SpotifyControlPlugin,
): Promise<NowPlayingDetails | null> {
	const state = await plugin.api.getPlaybackState();
	if (!state?.item) {
		new Notice('Nothing is playing.');
		return null;
	}
	return buildNowPlayingDetails(state.item);
}

async function variablesForTemplate(
	plugin: SpotifyControlPlugin,
	details: NowPlayingDetails,
	template: string,
): Promise<NowPlayingTemplateVariables> {
	if (!/\{\{(?:lyrics|lrc)\}\}/.test(template)) return details.variables;
	if (details.isEpisode) {
		return { ...details.variables, lyrics: '', lrc: '' };
	}
	const lyrics = await fetchLyrics(plugin, details);
	if (!hasLyrics(lyrics)) {
		new Notice('No lyrics found; continuing without lyrics.');
		return { ...details.variables, lyrics: '', lrc: '' };
	}
	return withLyricsVariables(details.variables, lyrics);
}

async function getNowPlayingWithLyrics(
	plugin: SpotifyControlPlugin,
): Promise<{ details: NowPlayingDetails; lyrics: LyricsResult } | null> {
	const details = await getNowPlayingDetails(plugin);
	if (!details) return null;
	if (details.isEpisode) {
		new Notice('Lyrics are not available for podcast episodes.');
		return null;
	}
	const lyrics = await fetchLyrics(plugin, details);
	if (!hasLyrics(lyrics)) {
		const message =
			lyrics.kind === 'instrumental'
				? 'This track is marked instrumental.'
				: 'No lyrics found for the current track.';
		new Notice(message);
		return null;
	}
	return { details, lyrics };
}

function fetchLyrics(
	plugin: SpotifyControlPlugin,
	details: NowPlayingDetails,
): Promise<LyricsResult> {
	return plugin.lyrics.get({
		uri: details.variables.uri,
		trackName: details.variables.name,
		artist: details.variables.artist,
		album: details.variables.album,
		durationMs: details.durationMs,
	});
}

function hasLyrics(result: LyricsResult): boolean {
	return !!(result.syncedText || lyricsForInsertion(result));
}

function activeMarkdownTargetId(plugin: SpotifyControlPlugin): string | null {
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	return view?.file?.path ?? null;
}

async function insertIntoActiveNote(
	plugin: SpotifyControlPlugin,
	text: string,
	initialTargetId: string | null,
): Promise<void> {
	const view = await settleCaptureTarget(
		initialTargetId,
		() => {
			const active = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			return active
				? { id: active.file?.path ?? null, value: active }
				: null;
		},
		(milliseconds) =>
			new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
	);
	if (!view) {
		new Notice('No active Markdown note. Open the target note and try again.');
		return;
	}
	view.editor.replaceSelection(text);
}

async function resolveNowPlayingNote(
	plugin: SpotifyControlPlugin,
	basePath: string,
	variables: NowPlayingTemplateVariables,
): Promise<{ path: string; existing: TFile | null }> {
	for (let index = 1; index <= 999; index++) {
		const path = index === 1 ? basePath : addCapturePathSuffix(basePath, index);
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		if (!existing) return { path, existing: null };
		if (existing instanceof TFile) {
			const content = await plugin.app.vault.cachedRead(existing);
			if (captureContentMatches(content, variables)) {
				return { path, existing };
			}
		}
	}
	throw new Error('Could not find an available filename for this track.');
}

async function resolveLyricsFile(
	plugin: SpotifyControlPlugin,
	basePath: string,
	content: string,
): Promise<{ path: string; existing: TFile | null }> {
	for (let index = 1; index <= 999; index++) {
		const path = index === 1 ? basePath : addCapturePathSuffix(basePath, index);
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		if (!existing) return { path, existing: null };
		if (
			existing instanceof TFile &&
			(await plugin.app.vault.cachedRead(existing)) === content
		) {
			return { path, existing };
		}
	}
	throw new Error('Could not find an available filename for these lyrics.');
}

async function ensureParentFolder(
	plugin: SpotifyControlPlugin,
	filePath: string,
): Promise<void> {
	const parts = filePath.split('/');
	parts.pop();
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = plugin.app.vault.getAbstractFileByPath(current);
		if (existing) {
			if (!(existing instanceof TFolder)) {
				throw new Error(`${current} is a file, not a folder.`);
			}
			continue;
		}
		await plugin.app.vault.createFolder(current);
	}
}

async function openFile(plugin: SpotifyControlPlugin, file: TFile): Promise<void> {
	const leaf = plugin.app.workspace.getLeaf(false);
	await leaf.openFile(file, { active: true });
	plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
