/**
 * Pure helpers shared by now-playing note and lyrics capture commands.
 *
 * This module deliberately has no Obsidian dependency so path, template, and
 * export behavior can be tested outside the app.
 */

import type { SpotifyEpisode, SpotifyTrack } from './api';
import type { LyricsResult } from './lyrics';
import { renderTemplate } from './util';

export interface NowPlayingTemplateVariables {
	[key: string]: string | undefined;
	name: string;
	artist: string;
	album: string;
	show: string;
	publisher: string;
	url: string;
	uri: string;
	lyrics?: string;
	lrc?: string;
}

export interface NowPlayingDetails {
	isEpisode: boolean;
	durationMs: number;
	variables: NowPlayingTemplateVariables;
}

export function buildNowPlayingDetails(
	item: SpotifyTrack | SpotifyEpisode,
): NowPlayingDetails {
	const isEpisode = !('artists' in item);
	const showName = isEpisode ? item.show?.name ?? '' : '';
	const publisher = isEpisode ? item.show?.publisher ?? '' : '';
	const artist = isEpisode
		? showName
		: item.artists.map((entry) => entry.name).join(', ');
	const album = isEpisode ? publisher : item.album.name;

	return {
		isEpisode,
		durationMs: item.duration_ms,
		variables: {
			name: item.name,
			artist,
			album,
			show: showName,
			publisher,
			url: item.external_urls?.spotify ?? '',
			uri: item.uri,
		},
	};
}

/** Human-readable lyrics for note insertion and clipboard capture. */
export function lyricsForInsertion(result: LyricsResult): string {
	if (result.plainText) return result.plainText.trim();
	return result.lines.map((line) => line.text).join('\n').trim();
}

export interface LyricsExportFile {
	extension: 'lrc' | 'txt';
	content: string;
}

/** Select the richest portable lyrics file LRCLIB made available. */
export function lyricsExportFile(result: LyricsResult): LyricsExportFile | null {
	if (result.syncedText) {
		return { extension: 'lrc', content: result.syncedText };
	}
	const plainText = lyricsForInsertion(result);
	if (plainText) {
		return { extension: 'txt', content: plainText };
	}
	return null;
}

export function withLyricsVariables(
	variables: NowPlayingTemplateVariables,
	result: LyricsResult,
): NowPlayingTemplateVariables {
	return {
		...variables,
		lyrics: lyricsForInsertion(result),
		lrc: result.syncedText ?? '',
	};
}

export type CaptureFileExtension = 'md' | 'lrc' | 'txt';

export function buildCapturePath(
	folder: string,
	fileNameTemplate: string,
	variables: NowPlayingTemplateVariables,
	extension: CaptureFileExtension,
): string {
	const fileName = sanitizeFileName(renderTemplate(fileNameTemplate, variables));
	const folderPath = folder
		.replace(/\\/g, '/')
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment && segment !== '.' && segment !== '..')
		.map(sanitizeFileName)
		.join('/');
	return `${folderPath ? `${folderPath}/` : ''}${fileName}.${extension}`;
}

export function sanitizeFileName(value: string): string {
	const withoutControlCharacters = Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
		})
		.join('');
	const clean = withoutControlCharacters
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/-+/g, '-')
		.replace(/^[.\s]+|[-.\s]+$/g, '');
	if (!clean) return 'Untitled';
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(clean)) {
		return `_${clean}`;
	}
	return clean;
}

export interface CaptureTarget<T> {
	id: string | null;
	value: T;
}

/**
 * Resolve the editor a capture command should write to.
 *
 * Macro runners can invoke our global command while the previous note is
 * still active, then switch leaves a moment later. Give that transition a
 * bounded grace period and prefer any target whose identity changed.
 */
export async function settleCaptureTarget<T>(
	initialTargetId: string | null,
	readTarget: () => CaptureTarget<T> | null,
	wait: (milliseconds: number) => Promise<void>,
): Promise<T | null> {
	const pollIntervalMs = 50;
	const unchangedTargetGraceMs = 400;
	const targetAppearTimeoutMs = 750;
	const initial = readTarget();
	if (initial && initial.id !== initialTargetId) return initial.value;

	for (
		let elapsed = pollIntervalMs;
		elapsed <= targetAppearTimeoutMs;
		elapsed += pollIntervalMs
	) {
		await wait(pollIntervalMs);
		const current = readTarget();
		if (current) {
			if (current.id !== initialTargetId) return current.value;
			if (elapsed >= unchangedTargetGraceMs) return current.value;
		}
	}
	return readTarget()?.value ?? null;
}

export function withCaptureIdentity(content: string, spotifyUri: string): string {
	const body = content.endsWith('\n') ? content : `${content}\n`;
	return `${body}<!-- spotify-control-uri: ${spotifyUri} -->\n`;
}

export function captureContentMatches(
	content: string,
	variables: NowPlayingTemplateVariables,
): boolean {
	const marker = `<!-- spotify-control-uri: ${variables.uri} -->`;
	return (
		content.includes(marker) ||
		content.includes(variables.uri) ||
		(!!variables.url && content.includes(variables.url))
	);
}

export function addCapturePathSuffix(path: string, index: number): string {
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	const extensionStart = dot > slash ? dot : path.length;
	return `${path.slice(0, extensionStart)} (${index})${path.slice(extensionStart)}`;
}
