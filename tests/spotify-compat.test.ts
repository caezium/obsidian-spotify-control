import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REDIRECT_URI, SCOPES } from '../src/types';
import { spotifyPlayerRestrictionMessage } from '../src/util';

test('OAuth requests only the scopes used by Spotify Control', () => {
	assert.deepEqual(SCOPES.split(' '), [
		'user-read-playback-state',
		'user-modify-playback-state',
		'user-read-currently-playing',
	]);
});

test('OAuth uses the registered Obsidian callback', () => {
	assert.equal(REDIRECT_URI, 'obsidian://spotify-control/auth');
});

test('persistent player restrictions get tier-neutral guidance', () => {
	const message = spotifyPlayerRestrictionMessage();
	assert.match(message, /require Premium/);
	assert.match(message, /temporarily/);
});
