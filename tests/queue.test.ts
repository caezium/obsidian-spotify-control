import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../src/queue';

test('QueueService maps track and episode payloads without trusting response JSON', async () => {
	const service = new QueueService(async () => ({
		status: 200,
		json: {
			currently_playing: { uri: 'spotify:track:current' },
			queue: [
				{
					type: 'track',
					name: 'Track',
					uri: 'spotify:track:next',
					duration_ms: 123_000,
					artists: [{ name: 'Artist one' }, { name: 'Artist two' }],
					album: { name: 'Album', images: [{ url: 'https://example.com/track.jpg' }] },
				},
				{
					type: 'episode',
					name: 'Episode',
					uri: 'spotify:episode:next',
					duration_ms: 456_000,
					show: { name: 'Show', publisher: 'Publisher' },
					images: [{ url: 'https://example.com/episode.jpg' }],
				},
			],
		},
	}));

	const snapshot = await service.get();

	assert.equal(snapshot.currentTrackUri, 'spotify:track:current');
	assert.deepEqual(snapshot.upcoming, [
		{
			name: 'Track',
			artist: 'Artist one, Artist two',
			album: 'Album',
			uri: 'spotify:track:next',
			imageUrl: 'https://example.com/track.jpg',
			durationMs: 123_000,
			kind: 'track',
		},
		{
			name: 'Episode',
			artist: 'Show',
			album: 'Publisher',
			uri: 'spotify:episode:next',
			imageUrl: 'https://example.com/episode.jpg',
			durationMs: 456_000,
			kind: 'episode',
		},
	]);
});

test('QueueService ignores malformed queue entries and preserves its fallback URI', async () => {
	const service = new QueueService(async () => ({
		status: 200,
		json: {
			currently_playing: { uri: 42 },
			queue: [null, 'bad', {}, { uri: 7 }, { uri: 'spotify:track:ok' }],
		},
	}));

	const snapshot = await service.get(false, 'spotify:track:fallback');

	assert.equal(snapshot.currentTrackUri, 'spotify:track:fallback');
	assert.deepEqual(snapshot.upcoming, [
		{
			name: '(unknown)',
			artist: '',
			album: '',
			uri: 'spotify:track:ok',
			imageUrl: null,
			durationMs: 0,
			kind: 'track',
		},
	]);
});

test('QueueService treats a non-object response as an empty queue', async () => {
	const service = new QueueService(async () => ({ status: 200, json: ['unexpected'] }));

	const snapshot = await service.get(false, 'spotify:track:fallback');

	assert.equal(snapshot.currentTrackUri, 'spotify:track:fallback');
	assert.deepEqual(snapshot.upcoming, []);
});
