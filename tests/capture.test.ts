/**
 * Tests for now-playing note and lyrics capture behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	addCapturePathSuffix,
	buildCapturePath,
	buildNowPlayingDetails,
	captureContentMatches,
	lyricsExportFile,
	lyricsForInsertion,
	sanitizeFileName,
	settleCaptureTarget,
	withCaptureIdentity,
	withLyricsVariables,
} from '../src/capture';

test('buildNowPlayingDetails: exposes track fields as template variables', () => {
	const details = buildNowPlayingDetails({
		name: 'Night Shift',
		uri: 'spotify:track:abc',
		duration_ms: 283_000,
		artists: [{ name: 'Lucy Dacus' }],
		album: {
			name: 'Historian',
			uri: 'spotify:album:def',
			images: [],
			artists: [{ name: 'Lucy Dacus' }],
		},
		external_urls: { spotify: 'https://open.spotify.com/track/abc' },
	});

	assert.equal(details.isEpisode, false);
	assert.equal(details.durationMs, 283_000);
	assert.deepEqual(details.variables, {
		name: 'Night Shift',
		artist: 'Lucy Dacus',
		album: 'Historian',
		show: '',
		publisher: '',
		url: 'https://open.spotify.com/track/abc',
		uri: 'spotify:track:abc',
	});
});

test('buildNowPlayingDetails: maps podcast show fields to artist and album fallbacks', () => {
	const details = buildNowPlayingDetails({
		name: 'A Strange Story',
		uri: 'spotify:episode:episode-id',
		duration_ms: 1_800_000,
		show: { name: 'The Example Show', publisher: 'Example Audio' },
		external_urls: { spotify: 'https://open.spotify.com/episode/episode-id' },
	});

	assert.equal(details.isEpisode, true);
	assert.equal(details.variables.artist, 'The Example Show');
	assert.equal(details.variables.album, 'Example Audio');
	assert.equal(details.variables.show, 'The Example Show');
	assert.equal(details.variables.publisher, 'Example Audio');
});

test('lyricsForInsertion: prefers LRCLIB plain lyrics over timestamped content', () => {
	const text = lyricsForInsertion({
		kind: 'synced',
		lines: [
			{ timeMs: 1_000, text: 'First line' },
			{ timeMs: 3_000, text: 'Second line' },
		],
		plainText: 'First line\nSecond line',
		syncedText: '[00:01.00]First line\n[00:03.00]Second line',
	});

	assert.equal(text, 'First line\nSecond line');
});

test('lyricsForInsertion: falls back to parsed synchronized lines', () => {
	const text = lyricsForInsertion({
		kind: 'synced',
		lines: [
			{ timeMs: 1_000, text: 'First line' },
			{ timeMs: 3_000, text: '' },
			{ timeMs: 5_000, text: 'Second line' },
		],
		plainText: null,
		syncedText: '[00:01.00]First line\n[00:03.00]\n[00:05.00]Second line',
	});

	assert.equal(text, 'First line\n\nSecond line');
});

test('lyricsExportFile: exports the untouched synchronized payload as LRC', () => {
	const syncedText = '[ar:Example]\n[00:01.00]First line';
	const exported = lyricsExportFile({
		kind: 'synced',
		lines: [{ timeMs: 1_000, text: 'First line' }],
		plainText: 'First line',
		syncedText,
	});

	assert.deepEqual(exported, {
		extension: 'lrc',
		content: syncedText,
	});
});

test('lyricsExportFile: falls back to a plain text file', () => {
	const exported = lyricsExportFile({
		kind: 'plain',
		lines: [],
		plainText: 'First line\nSecond line',
		syncedText: null,
	});

	assert.deepEqual(exported, {
		extension: 'txt',
		content: 'First line\nSecond line',
	});
});

test('withLyricsVariables: exposes plain and synchronized lyrics to templates', () => {
	const details = buildNowPlayingDetails({
		name: 'Song',
		uri: 'spotify:track:abc',
		duration_ms: 60_000,
		artists: [{ name: 'Artist' }],
		album: { name: 'Album', uri: 'spotify:album:def', images: [], artists: [] },
	});
	const variables = withLyricsVariables(details.variables, {
		kind: 'synced',
		lines: [{ timeMs: 1_000, text: 'First line' }],
		plainText: 'First line',
		syncedText: '[00:01.00]First line',
	});

	assert.equal(variables.name, 'Song');
	assert.equal(variables.lyrics, 'First line');
	assert.equal(variables.lrc, '[00:01.00]First line');
});

test('buildCapturePath: renders templates and makes a cross-platform-safe vault path', () => {
	const path = buildCapturePath(
		'Media//Song Notes/',
		'{{artist}} / {{name}}?',
		{
			name: 'Night: Shift',
			artist: 'Lucy Dacus',
			album: 'Historian',
			show: '',
			publisher: '',
			url: '',
			uri: 'spotify:track:abc',
		},
		'md',
	);

	assert.equal(path, 'Media/Song Notes/Lucy Dacus - Night- Shift.md');
});

test('sanitizeFileName: protects Windows reserved device names', () => {
	assert.equal(sanitizeFileName('CON'), '_CON');
	assert.equal(sanitizeFileName('lpt1'), '_lpt1');
});

test('settleCaptureTarget: follows a macro transition instead of using the old note', async () => {
	let active = { id: 'Notes/old.md', value: 'old editor' };
	const result = await settleCaptureTarget(
		'Notes/old.md',
		() => active,
		async () => {
			active = { id: 'Media/new.md', value: 'new editor' };
		},
	);

	assert.equal(result, 'new editor');
});

test('settleCaptureTarget: never returns an editor that is no longer active', async () => {
	let active: { id: string; value: string } | null = {
		id: 'Notes/old.md',
		value: 'stale editor',
	};
	const result = await settleCaptureTarget(
		'Notes/old.md',
		() => active,
		async () => {
			active = null;
		},
	);

	assert.equal(result, null);
});

test('capture identity: distinguishes a saved song note from a filename collision', () => {
	const variables = {
		name: 'Song',
		artist: 'Artist',
		album: 'Album',
		show: '',
		publisher: '',
		url: 'https://open.spotify.com/track/abc',
		uri: 'spotify:track:abc',
	};
	const saved = withCaptureIdentity('# Song\n', variables.uri);

	assert.equal(captureContentMatches(saved, variables), true);
	assert.equal(captureContentMatches('# An unrelated note\n', variables), false);
});

test('withCaptureIdentity: keeps YAML frontmatter at the start of the note', () => {
	const content = '---\ntags: [music]\n---\n\n# Song\n';
	const saved = withCaptureIdentity(content, 'spotify:track:abc');

	assert.ok(saved.startsWith('---\n'));
	assert.ok(saved.endsWith('<!-- spotify-control-uri: spotify:track:abc -->\n'));
});

test('addCapturePathSuffix: adds a numeric suffix before the extension', () => {
	assert.equal(
		addCapturePathSuffix('Media/Lucy Dacus - Night Shift.md', 2),
		'Media/Lucy Dacus - Night Shift (2).md',
	);
});
