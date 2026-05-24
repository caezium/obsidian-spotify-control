/**
 * Tests for src/lyrics.ts — LRC parsing and active-line lookup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseLrc,
	activeLineIndex,
	buildLrclibUrl,
	LyricsService,
} from '../src/lyrics';

// ── parseLrc ────────────────────────────────────────────────────────────────

test('parseLrc: basic mm:ss.xx timestamps', () => {
	const lrc = `
[00:12.34]First line
[00:15.67]Second line
[01:23.45]Third line
`;
	const out = parseLrc(lrc);
	assert.equal(out.length, 3);
	assert.deepEqual(out[0], { timeMs: 12_340, text: 'First line' });
	assert.deepEqual(out[1], { timeMs: 15_670, text: 'Second line' });
	assert.deepEqual(out[2], { timeMs: 83_450, text: 'Third line' });
});

test('parseLrc: mm:ss.xxx (three-digit fraction)', () => {
	const out = parseLrc('[00:05.123]Hello');
	assert.deepEqual(out, [{ timeMs: 5_123, text: 'Hello' }]);
});

test('parseLrc: single-digit fraction normalizes', () => {
	// .5 should mean 500ms, not 5ms.
	const out = parseLrc('[00:05.5]Hi');
	assert.deepEqual(out, [{ timeMs: 5_500, text: 'Hi' }]);
});

test('parseLrc: multiple timestamps on one line emit separate entries', () => {
	const out = parseLrc('[00:10.00][00:30.00]repeated chorus');
	assert.equal(out.length, 2);
	assert.equal(out[0].text, 'repeated chorus');
	assert.equal(out[1].text, 'repeated chorus');
	assert.equal(out[0].timeMs, 10_000);
	assert.equal(out[1].timeMs, 30_000);
});

test('parseLrc: metadata tags are skipped', () => {
	const lrc = `
[ar:ROSÉ]
[ti:toxic till the end]
[al:rosie]
[length:02:36]
[00:01.00]actual lyric
`;
	const out = parseLrc(lrc);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, 'actual lyric');
});

test('parseLrc: lines without timestamps are dropped', () => {
	const out = parseLrc('no timestamp here\n[00:05.00]has one');
	assert.equal(out.length, 1);
	assert.equal(out[0].text, 'has one');
});

test('parseLrc: empty lyric text (instrumental gap) is preserved', () => {
	const out = parseLrc('[00:05.00]a\n[00:10.00]\n[00:15.00]b');
	assert.equal(out.length, 3);
	assert.equal(out[1].text, '');
});

test('parseLrc: result is sorted by timestamp', () => {
	const out = parseLrc('[00:30.00]later\n[00:10.00]earlier');
	assert.equal(out[0].timeMs, 10_000);
	assert.equal(out[1].timeMs, 30_000);
});

test('parseLrc: empty input returns empty array', () => {
	assert.deepEqual(parseLrc(''), []);
	assert.deepEqual(parseLrc('\n\n\n'), []);
});

// ── activeLineIndex ────────────────────────────────────────────────────────

test('activeLineIndex: before first line returns -1', () => {
	const lines = [{ timeMs: 1000, text: 'a' }];
	assert.equal(activeLineIndex(lines, 500), -1);
	assert.equal(activeLineIndex(lines, 0), -1);
});

test('activeLineIndex: exactly at timestamp picks that line', () => {
	const lines = [
		{ timeMs: 1000, text: 'a' },
		{ timeMs: 2000, text: 'b' },
	];
	assert.equal(activeLineIndex(lines, 1000), 0);
	assert.equal(activeLineIndex(lines, 2000), 1);
});

test('activeLineIndex: between timestamps picks the earlier', () => {
	const lines = [
		{ timeMs: 1000, text: 'a' },
		{ timeMs: 5000, text: 'b' },
	];
	assert.equal(activeLineIndex(lines, 3000), 0);
});

test('activeLineIndex: after last picks last', () => {
	const lines = [{ timeMs: 1000, text: 'a' }, { timeMs: 2000, text: 'b' }];
	assert.equal(activeLineIndex(lines, 99_999), 1);
});

test('activeLineIndex: empty array returns -1', () => {
	assert.equal(activeLineIndex([], 1000), -1);
});

// ── buildLrclibUrl ────────────────────────────────────────────────────────

test('buildLrclibUrl: strips "feat." from artist', () => {
	const url = buildLrclibUrl({
		uri: 'spotify:track:abc',
		trackName: 'APT.',
		artist: 'ROSÉ, Bruno Mars',
		album: 'APT.',
		durationMs: 169_000,
	});
	assert.ok(url.includes('artist_name=ROS%C3%89'));
	assert.ok(!url.includes('Bruno'));
});

test('buildLrclibUrl: encodes special characters', () => {
	const url = buildLrclibUrl({
		uri: 'spotify:track:abc',
		trackName: "don't wanna",
		artist: 'Ariana Grande',
		album: 'eternal sunshine',
		durationMs: 180_000,
	});
	assert.ok(url.includes("don%27t+wanna"));
	assert.ok(url.includes('duration=180'));
});

// ── LyricsService cache ────────────────────────────────────────────────────

test('LyricsService: caches by uri (no double-fetch)', async () => {
	let calls = 0;
	const svc = new LyricsService(async () => {
		calls++;
		return { status: 200, json: { instrumental: false, syncedLyrics: '[00:01.00]hi' } };
	});
	const track = {
		uri: 'spotify:track:xyz',
		trackName: 't',
		artist: 'a',
		album: 'al',
		durationMs: 60_000,
	};
	await svc.get(track);
	await svc.get(track);
	await svc.get(track);
	assert.equal(calls, 1);
});

test('LyricsService: dedupes concurrent fetches', async () => {
	let calls = 0;
	const svc = new LyricsService(async () => {
		calls++;
		// Simulate slow fetch
		await new Promise((r) => setTimeout(r, 30));
		return { status: 200, json: { instrumental: false, syncedLyrics: '[00:01.00]hi' } };
	});
	const track = {
		uri: 'spotify:track:xyz',
		trackName: 't',
		artist: 'a',
		album: 'al',
		durationMs: 60_000,
	};
	await Promise.all([svc.get(track), svc.get(track), svc.get(track)]);
	assert.equal(calls, 1);
});

test('LyricsService: instrumental flag', async () => {
	const svc = new LyricsService(async () => ({
		status: 200,
		json: { instrumental: true },
	}));
	const r = await svc.get({
		uri: 'a',
		trackName: 't',
		artist: 'a',
		album: 'al',
		durationMs: 60_000,
	});
	assert.equal(r.kind, 'instrumental');
});

test('LyricsService: 404 returns "none"', async () => {
	const svc = new LyricsService(async () => ({ status: 404 }));
	const r = await svc.get({
		uri: 'a',
		trackName: 't',
		artist: 'a',
		album: 'al',
		durationMs: 60_000,
	});
	assert.equal(r.kind, 'none');
});

test('LyricsService: plain-only response', async () => {
	const svc = new LyricsService(async () => ({
		status: 200,
		json: { instrumental: false, plainLyrics: 'just some text' },
	}));
	const r = await svc.get({
		uri: 'a',
		trackName: 't',
		artist: 'a',
		album: 'al',
		durationMs: 60_000,
	});
	assert.equal(r.kind, 'plain');
	assert.equal(r.plainText, 'just some text');
});
