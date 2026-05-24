/**
 * Tests for src/util.ts — pure functions, no Obsidian dependency.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	formatTime,
	parseSpotifyResource,
	randomString,
	sha256Base64Url,
	base64UrlEncode,
	renderTemplate,
} from '../src/util';

// ── formatTime ──────────────────────────────────────────────────────────────

test('formatTime: zero', () => {
	assert.equal(formatTime(0), '0:00');
});

test('formatTime: negative input', () => {
	assert.equal(formatTime(-1000), '0:00');
});

test('formatTime: single-digit seconds zero-padded', () => {
	assert.equal(formatTime(5000), '0:05');
});

test('formatTime: minutes', () => {
	assert.equal(formatTime(83_000), '1:23');
});

test('formatTime: ten minutes', () => {
	assert.equal(formatTime(605_000), '10:05');
});

test('formatTime: hours render as minutes (no h marker)', () => {
	// 90 minutes = 5400s. We don't try to format hours; just minutes.
	assert.equal(formatTime(90 * 60 * 1000), '90:00');
});

// ── parseSpotifyResource ────────────────────────────────────────────────────

test('parseSpotifyResource: spotify:track:ID uri', () => {
	const r = parseSpotifyResource(
		'check out spotify:track:6rqhFgbbKwnb9MLmUQDhG6 friends',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'track');
	assert.equal(r!.id, '6rqhFgbbKwnb9MLmUQDhG6');
	assert.equal(r!.uri, 'spotify:track:6rqhFgbbKwnb9MLmUQDhG6');
});

test('parseSpotifyResource: open.spotify.com/album URL becomes URI', () => {
	const r = parseSpotifyResource(
		'https://open.spotify.com/album/2ANVost0y2y52ema1E9xAZ?si=xyz',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'album');
	assert.equal(r!.id, '2ANVost0y2y52ema1E9xAZ');
	assert.equal(r!.uri, 'spotify:album:2ANVost0y2y52ema1E9xAZ');
});

test('parseSpotifyResource: playlist URL', () => {
	const r = parseSpotifyResource('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
	assert.ok(r);
	assert.equal(r!.kind, 'playlist');
});

test('parseSpotifyResource: NO false-positive on album with "track" in name', () => {
	// Regression test for audit issue #13: substring matching would have
	// classified this as a track.
	const r = parseSpotifyResource(
		'https://open.spotify.com/album/track9999999999999999999',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'album', 'should be album, not track');
});

test('parseSpotifyResource: no match returns null', () => {
	assert.equal(parseSpotifyResource('plain text no link'), null);
	assert.equal(parseSpotifyResource('https://example.com/track/foo'), null);
});

test('parseSpotifyResource: handles ?si= share-token query params', () => {
	const r = parseSpotifyResource(
		'https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc123',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'track');
	assert.equal(r!.id, '4iV5W9uYEdYUVa79Axb7Rh');
	assert.equal(r!.uri, 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh');
});

test('parseSpotifyResource: handles intl-en/ locale prefix', () => {
	const r = parseSpotifyResource(
		'https://open.spotify.com/intl-en/track/4iV5W9uYEdYUVa79Axb7Rh',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'track');
	assert.equal(r!.id, '4iV5W9uYEdYUVa79Axb7Rh');
});

test('parseSpotifyResource: intl prefix + query params combined', () => {
	const r = parseSpotifyResource(
		'https://open.spotify.com/intl-fr/album/2ANVost0y2y52ema1E9xAZ?si=xyz',
	);
	assert.ok(r);
	assert.equal(r!.kind, 'album');
	assert.equal(r!.id, '2ANVost0y2y52ema1E9xAZ');
});

test('parseSpotifyResource: episode URI', () => {
	const r = parseSpotifyResource('spotify:episode:abc123XYZ');
	assert.ok(r);
	assert.equal(r!.kind, 'episode');
});

// ── randomString ────────────────────────────────────────────────────────────

test('randomString: produces requested length', () => {
	for (const n of [1, 16, 64, 128]) {
		assert.equal(randomString(n).length, n, `length ${n}`);
	}
});

test('randomString: uses only PKCE-allowed characters', () => {
	const allowed = /^[A-Za-z0-9\-._~]+$/;
	for (let i = 0; i < 20; i++) {
		const s = randomString(64);
		assert.ok(allowed.test(s), `unexpected char in ${s}`);
	}
});

test('randomString: two calls produce different output', () => {
	const a = randomString(64);
	const b = randomString(64);
	assert.notEqual(a, b);
});

// ── sha256Base64Url + base64UrlEncode ───────────────────────────────────────

test('base64UrlEncode: round-trips empty', () => {
	assert.equal(base64UrlEncode(new Uint8Array()), '');
});

test('base64UrlEncode: uses URL-safe alphabet (no + / =)', () => {
	// Bytes designed to produce + / = in standard base64.
	const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xfe]);
	const out = base64UrlEncode(bytes);
	assert.ok(!out.includes('+'), 'no plus sign');
	assert.ok(!out.includes('/'), 'no slash');
	assert.ok(!out.includes('='), 'no padding');
});

test('sha256Base64Url: known vector', async () => {
	// echo -n "" | shasum -a 256 | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
	const expected = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
	const got = await sha256Base64Url('');
	assert.equal(got, expected);
});

test('sha256Base64Url: another known vector', async () => {
	// SHA256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
	const expected = 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ';
	const got = await sha256Base64Url('hello');
	assert.equal(got, expected);
});

// ── renderTemplate ──────────────────────────────────────────────────────────

test('renderTemplate: basic substitution', () => {
	assert.equal(
		renderTemplate('{{name}} by {{artist}}', { name: 'Toxic', artist: 'Britney' }),
		'Toxic by Britney',
	);
});

test('renderTemplate: missing var renders empty', () => {
	assert.equal(renderTemplate('{{a}}{{b}}', { a: 'X' }), 'X');
});

test('renderTemplate: leaves non-matching braces alone', () => {
	// Template should only replace {{key}}, not { key } or other patterns.
	assert.equal(renderTemplate('{x} {{y}}', { y: 'Y' }), '{x} Y');
});

test('renderTemplate: handles multi-line template', () => {
	const out = renderTemplate('> [!music]\n> {{name}}', { name: 'Test' });
	assert.equal(out, '> [!music]\n> Test');
});

test('renderTemplate: same key multiple times', () => {
	assert.equal(renderTemplate('{{x}} {{x}} {{x}}', { x: 'a' }), 'a a a');
});
