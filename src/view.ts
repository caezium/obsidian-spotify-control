/**
 * Now-playing sidebar.
 *
 * Architecture:
 *   - Renders once in onOpen() with stable element references stored on `this`.
 *   - Polls Spotify /me/player via chained setTimeout (NOT setInterval — that
 *     can queue up overlapping requests on slow networks).
 *   - Stops polling when the view is hidden or the document visibility changes
 *     to hidden. Resumes on visible.
 *   - Player writes go through plugin.api (direct requestUrl) to avoid the
 *     SDK's broken 204 deserializer. Reads stay on the SDK (it works fine
 *     for JSON-returning endpoints).
 *   - Optimistic UI: control actions update local state immediately and hold
 *     a "grace period" so the next poll doesn't snap sliders back to
 *     pre-propagation values.
 *
 * Layout:
 *   - Album art with optional hover overlay containing prev/play/next.
 *   - Title (large/bold), artist (medium), album (small) below the art.
 *   - Seek bar with elapsed/total times.
 *   - Shuffle | repeat | volume row (always visible).
 *   - Custom device dropdown (not the native <select>) showing the active
 *     device name; click to open a list of available devices.
 *
 * Spotify Web API rate limit: ~180 req/min per token. At 3s polling + every
 * 5th poll fetches devices, that's ~24 req/min, plenty of headroom.
 */

import { ItemView, Platform, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type SpotifyControlPlugin from './main';
import { formatTime } from './util';
import { activeLineIndex, LyricsResult, LYRICS_NONE } from './lyrics';
import { QueueItem } from './queue';

export const SPOTIFY_VIEW_TYPE = 'spotify-control-view';

const MAX_BACKOFF_MS = 30_000;
const SLIDER_GRACE_MS = 3000;
const PENDING_VOLUME_TIMEOUT_MS = 5000;
const PENDING_VOLUME_MATCH_TOLERANCE = 2;
const LOCAL_PROGRESS_TICK_MS = 500;
/** Pause auto-scroll for this long after a manual scroll in the lyrics panel. */
const LYRICS_MANUAL_SCROLL_GRACE_MS = 4000;

interface PlaybackState {
	isPlaying: boolean;
	trackName: string;
	artist: string;
	album: string;
	trackUri: string;
	/** Spotify URI of the surrounding context (playlist/album/etc.). null if
	 * the user is playing a single track in isolation. Used by the queue
	 * panel to "play this track" without breaking the rest of the playlist. */
	contextUri: string | null;
	albumArtUrl: string | null;
	trackUrl: string | null;
	progressMs: number;
	durationMs: number;
	shuffle: boolean;
	repeat: 'off' | 'context' | 'track';
	volumePercent: number;
	deviceId: string | null;
	deviceName: string | null;
	hasActiveDevice: boolean;
	/** True when the current item is a Spotify podcast episode. Drives the
	 * "is-episode" class on the root, which CSS uses to reveal the -15s/+15s
	 * buttons and the description panel in place of "no lyrics" placeholder. */
	isEpisode: boolean;
	/** Episode description (formatted plain text with paragraph breaks).
	 * Empty for tracks. Sourced from `html_description` when available so
	 * paragraph structure survives — Spotify's plain `description` field
	 * strips the line breaks. */
	episodeDescription: string;
	/** ISO date "YYYY-MM-DD" for the album row replacement on podcasts. */
	episodeReleaseDate: string;
}

interface Device {
	id: string;
	name: string;
	type: string;
	is_active: boolean;
}

const EMPTY_STATE: PlaybackState = {
	isPlaying: false,
	trackName: '',
	artist: '',
	album: '',
	trackUri: '',
	contextUri: null,
	albumArtUrl: null,
	trackUrl: null,
	progressMs: 0,
	durationMs: 0,
	shuffle: false,
	repeat: 'off',
	volumePercent: 50,
	deviceId: null,
	deviceName: null,
	hasActiveDevice: false,
	isEpisode: false,
	episodeDescription: '',
	episodeReleaseDate: '',
};

export class SpotifyView extends ItemView {
	private plugin: SpotifyControlPlugin;
	private lastState: PlaybackState = EMPTY_STATE;
	private cachedDevices: Device[] = [];
	private pollTick = 0;
	private lastHeaderTrack = '';

	// Polling state
	private pollTimer: number | null = null;
	private consecutivePollFailures = 0;
	private pollingStopped = false;

	// Visibility tracking
	private visibilityListener: (() => void) | null = null;
	private outsideClickListener: ((e: MouseEvent) => void) | null = null;
	private outsideKeydownListener: ((e: KeyboardEvent) => void) | null = null;
	private volumePopoverOutsideListener: ((e: MouseEvent) => void) | null = null;

	// Cached element refs (set in build())
	private rootEl!: HTMLElement;
	private artWrapEl!: HTMLDivElement;
	private artEl!: HTMLImageElement;
	private artPlaceholderEl!: HTMLDivElement;
	private artOverlayEl!: HTMLDivElement;
	private titleEl!: HTMLDivElement;
	private artistEl!: HTMLDivElement;
	private albumEl!: HTMLDivElement;
	private overlayPlayBtn!: HTMLButtonElement;
	private overlayPlayIconEl!: HTMLSpanElement;
	private overlayPauseIconEl!: HTMLSpanElement;
	// Overlay prev/next buttons are created in build() but their references
	// aren't kept — they're click-handler-only, no state updates needed.
	private transportRowEl!: HTMLDivElement;
	private playBtn!: HTMLButtonElement;
	private playIconEl!: HTMLSpanElement;
	private pauseIconEl!: HTMLSpanElement;
	private prevBtn!: HTMLButtonElement;
	private nextBtn!: HTMLButtonElement;
	private shuffleBtn!: HTMLButtonElement;
	private repeatBtn!: HTMLButtonElement;
	/** Podcast-only: -15s / +15s seek buttons. Created always; CSS hides them
	 * when the root lacks .is-episode. Click handler seeks ±15000 ms within
	 * the current item rather than skipping to a different track. */
	private skipBack15Btn!: HTMLButtonElement;
	private skipForward15Btn!: HTMLButtonElement;
	private seekBar!: HTMLInputElement;
	private elapsedEl!: HTMLSpanElement;
	private totalEl!: HTMLSpanElement;
	private volumeBar!: HTMLInputElement;
	private deviceWrap!: HTMLDivElement;
	private deviceButton!: HTMLButtonElement;
	private deviceLabelEl!: HTMLSpanElement;
	private devicePopover!: HTMLDivElement;
	private emptyEl!: HTMLDivElement;
	private emptyTextEl!: HTMLDivElement;
	private emptyActionsEl!: HTMLDivElement;
	private playerEl!: HTMLDivElement;
	private statusEl!: HTMLDivElement;

	// Panel state — only one of {art, lyrics, queue} is visible at a time.
	// Both lyrics and queue panels get reparented between the art-stack
	// (replace mode) and the below-slot (below mode) when settings change.
	private currentPanel: 'art' | 'lyrics' | 'queue' = 'art';

	// Lyrics
	private lyricsPanelEl!: HTMLDivElement;
	private lyricsScrollEl!: HTMLDivElement;
	private lyricsToggleBtn!: HTMLButtonElement;
	private lyricsToggleBtnStatic!: HTMLButtonElement; // duplicate in transport row
	private lyricsBelowSlot!: HTMLDivElement;
	private lyricsCurrentTrackUri = '';
	private lyricsData: LyricsResult = LYRICS_NONE;
	private lyricsLineEls: HTMLDivElement[] = [];
	private lyricsActiveIdx = -1;
	private lyricsAutoScrollUntil = 0;

	// Queue
	private queuePanelEl!: HTMLDivElement;
	private queueScrollEl!: HTMLDivElement;
	private queueToggleBtn!: HTMLButtonElement;
	private queueToggleBtnStatic!: HTMLButtonElement;
	private queueLoadedSig = ''; // signature of last-rendered queue to avoid re-render churn

	// Overlay shuffle/repeat (duplicates of transport-row buttons, shown when
	// hover-mode is on so the user can toggle them without leaving the art).
	private overlayShuffleBtn!: HTMLButtonElement;
	private overlayRepeatBtn!: HTMLButtonElement;

	// Optional controls-on-art elements
	private artProgressEl: HTMLDivElement | null = null;
	private artProgressFillEl: HTMLDivElement | null = null;
	private artVolumeBtn: HTMLButtonElement | null = null;
	private artVolumePopover: HTMLDivElement | null = null;
	private artVolumeSlider: HTMLInputElement | null = null;

	// Memoized snapshot of last-rendered values so render() can skip DOM
	// writes for fields that haven't changed since the previous poll.
	// At 20+ polls/min with ~10 fields each, this saves a lot of unneeded
	// setText / toggleClass calls.
	private lastRendered: {
		title: string;
		artist: string;
		album: string;
		titleClickable: boolean;
		isPlaying: boolean;
		shuffle: boolean;
		repeat: 'off' | 'context' | 'track';
		deviceText: string;
	} = {
		title: '',
		artist: '',
		album: '',
		titleClickable: false,
		isPlaying: false,
		shuffle: false,
		repeat: 'off',
		deviceText: '',
	};

	// Local progress-bar animation between polls.
	private localProgressTimer: number | null = null;
	private localProgressBaseMs = 0;
	private localProgressStartedAt = 0;

	// Slider input guards. *Active=true means polling should not overwrite the
	// user's value. We extend the active flag for SLIDER_GRACE_MS after release
	// so Spotify has time to propagate the change before the next poll arrives.
	private seekingActive = false;
	private volumingActive = false;
	private seekGraceTimer: number | null = null;
	private volumeGraceTimer: number | null = null;
	private pendingVolume: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SpotifyControlPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return SPOTIFY_VIEW_TYPE;
	}
	getDisplayText() {
		const s = this.lastState;
		if (s.hasActiveDevice && s.trackName) {
			return `Spotify: ${s.trackName}`;
		}
		return 'Spotify';
	}
	getIcon() {
		return 'play-circle';
	}

	async onOpen() {
		this.build();
		this.attachVisibilityListener();
		this.attachOutsideClickListener();
		this.applyHoverModeClass();
		this.startPolling();
	}

	async onClose() {
		this.stopPolling();
		this.stopLocalProgress();
		this.detachVisibilityListener();
		this.detachOutsideClickListener();
	}

	onAuthChanged() {
		this.consecutivePollFailures = 0;
		this.poll();
	}

	/** Called when the plugin's settings change (e.g., hover-mode toggle). */
	onSettingsChanged() {
		this.applyHoverModeClass();
	}

	// ── DOM ─────────────────────────────────────────────────────────────────

	private build() {
		this.rootEl = this.containerEl.children[1] as HTMLElement;
		this.rootEl.empty();
		this.rootEl.addClass('spotify-control-view');

		// Empty state — shown when not authed OR no active device.
		// Includes inline action buttons (Log in / Open settings) so the user
		// doesn't have to navigate away for first-time setup.
		this.emptyEl = this.rootEl.createDiv({ cls: 'sc-empty' });
		this.emptyEl.createDiv({ cls: 'sc-empty-icon', text: '🎵' });
		this.emptyTextEl = this.emptyEl.createDiv({
			cls: 'sc-empty-text',
			text: 'Not connected.',
		});
		this.emptyActionsEl = this.emptyEl.createDiv({ cls: 'sc-empty-actions' });

		// Main player container
		this.playerEl = this.rootEl.createDiv({ cls: 'sc-player' });

		// Album art + lyrics/queue-panel container. The panels are sized the
		// same as the art so the layout below doesn't jump when toggling.
		const artStack = this.playerEl.createDiv({ cls: 'sc-art-stack' });

		this.artWrapEl = artStack.createDiv({ cls: 'sc-art-wrap' });
		this.artEl = this.artWrapEl.createEl('img', { cls: 'sc-art' });
		this.artEl.style.display = 'none';
		this.artPlaceholderEl = this.artWrapEl.createDiv({ cls: 'sc-art-placeholder' });
		setIcon(this.artPlaceholderEl, 'music');

		// Panels — initially in art-stack (for "replace" mode).
		// applyLyricsPosition() moves them to the below-slot when mode is "below".
		this.lyricsPanelEl = artStack.createDiv({ cls: 'sc-lyrics-panel sc-panel' });
		this.lyricsScrollEl = this.lyricsPanelEl.createDiv({ cls: 'sc-lyrics-scroll' });
		this.lyricsScrollEl.addEventListener('scroll', () => {
			this.lyricsAutoScrollUntil = Date.now() + LYRICS_MANUAL_SCROLL_GRACE_MS;
		}, { passive: true });

		this.queuePanelEl = artStack.createDiv({ cls: 'sc-queue-panel sc-panel' });
		this.queueScrollEl = this.queuePanelEl.createDiv({ cls: 'sc-queue-scroll' });

		// Toggle-button cluster (top-right corner of art). Hidden by default
		// in hover mode (revealed on art hover); always visible when
		// hoverRevealControls is off.
		const togglesEl = artStack.createDiv({ cls: 'sc-panel-toggles' });
		this.lyricsToggleBtn = this.makeToggleButton(
			togglesEl,
			'mic-vocal',
			'Show / hide lyrics',
			'sc-lyrics-toggle',
			() => this.togglePanel('lyrics'),
		);
		this.queueToggleBtn = this.makeToggleButton(
			togglesEl,
			'list-music',
			'Show / hide queue',
			'sc-queue-toggle',
			() => this.togglePanel('queue'),
		);

		// Hover overlay. Top row: shuffle + repeat (also in transport row, this
		// copy lets users toggle without leaving the art when in hover mode).
		// Center row: prev / play / next.
		this.artOverlayEl = this.artWrapEl.createDiv({ cls: 'sc-art-overlay' });
		const overlayTop = this.artOverlayEl.createDiv({ cls: 'sc-overlay-top' });
		this.overlayShuffleBtn = this.makeOverlayCornerButton(
			overlayTop,
			'shuffle',
			'Shuffle',
			() => this.callDirect(
				() => this.plugin.api.shuffle(!this.lastState.shuffle),
				'shuffle',
			),
		);
		this.overlayRepeatBtn = this.makeOverlayCornerButton(
			overlayTop,
			'repeat',
			'Repeat',
			() => {
				const order = ['off', 'context', 'track'] as const;
				const idx = order.indexOf(this.lastState.repeat);
				const nextMode = order[(idx + 1) % order.length];
				return this.callDirect(() => this.plugin.api.repeat(nextMode), 'repeat');
			},
		);

		const overlayCenter = this.artOverlayEl.createDiv({ cls: 'sc-overlay-center' });
		this.overlayIconButton(overlayCenter, 'skip-back', 'Previous', () =>
			this.callDirect(() => this.plugin.api.previous(), 'prev'),
		);
		[this.overlayPlayBtn, this.overlayPlayIconEl, this.overlayPauseIconEl] =
			this.overlayPlayButton(overlayCenter);
		this.overlayIconButton(overlayCenter, 'skip-forward', 'Next', () =>
			this.callDirect(() => this.plugin.api.next(), 'next'),
		);

		// Slot for lyrics/queue panel in "below" mode. Lives BETWEEN art and
		// title — so when a panel opens, the controls stay anchored at the
		// bottom and the panel fills the middle. Reparenting happens in
		// applyLyricsPosition().
		this.lyricsBelowSlot = this.playerEl.createDiv({ cls: 'sc-lyrics-below-slot' });

		// Track info
		const infoEl = this.playerEl.createDiv({ cls: 'sc-info' });
		this.titleEl = infoEl.createDiv({ cls: 'sc-title' });
		this.titleEl.addEventListener('click', () => {
			const url = this.lastState.trackUrl;
			if (url) window.open(url, '_blank', 'noopener,noreferrer');
		});
		this.artistEl = infoEl.createDiv({ cls: 'sc-artist' });
		this.albumEl = infoEl.createDiv({ cls: 'sc-album' });

		// Seek bar
		const seekRow = this.playerEl.createDiv({ cls: 'sc-seek-row' });
		this.elapsedEl = seekRow.createSpan({ cls: 'sc-time', text: '0:00' });
		this.seekBar = seekRow.createEl('input', { cls: 'sc-seek' });
		this.seekBar.type = 'range';
		this.seekBar.min = '0';
		this.seekBar.max = '100';
		this.seekBar.value = '0';
		this.totalEl = seekRow.createSpan({ cls: 'sc-time', text: '0:00' });

		this.seekBar.addEventListener('mousedown', () => {
			this.seekingActive = true;
		});
		this.seekBar.addEventListener('touchstart', () => {
			this.seekingActive = true;
		});
		this.seekBar.addEventListener('change', async () => {
			const pct = Number(this.seekBar.value);
			const positionMs = Math.round((pct / 100) * this.lastState.durationMs);
			this.holdSeekGrace();
			await this.callDirect(() => this.plugin.api.seek(positionMs), 'seek');
			this.startLocalProgress(positionMs);
		});
		this.seekBar.addEventListener('input', () => {
			const pct = Number(this.seekBar.value);
			const ms = Math.round((pct / 100) * this.lastState.durationMs);
			this.elapsedEl.setText(formatTime(ms));
		});

		// Transport row — shown only in always-visible mode (not hover mode).
		// In hover mode this stays in DOM but CSS hides prev/play/next via
		// .is-hover-mode class; shuffle/repeat stay visible in both modes.
		this.transportRowEl = this.playerEl.createDiv({ cls: 'sc-transport' });
		this.shuffleBtn = this.iconButton(this.transportRowEl, 'shuffle', 'Shuffle', () =>
			this.callDirect(() => this.plugin.api.shuffle(!this.lastState.shuffle), 'shuffle'),
		);
		this.shuffleBtn.addClass('sc-hide-in-hover-mode');
		// Podcast-only -15s. Sits before prev (outside the prev/next bracket);
		// CSS reveals it via .is-episode. The 'rotate-ccw' icon is the curved
		// arrow that matches Spotify's 15s rewind glyph; CSS draws the "15"
		// label on top.
		// NOTE: Intentionally *not* tagged sc-hide-in-hover-mode — the 15s
		// skip buttons should appear in the transport row whether hover-mode
		// is on or off; they're podcast-specific controls, orthogonal to the
		// classic hover-overlay vs always-visible distinction.
		this.skipBack15Btn = this.iconButton(this.transportRowEl, 'rotate-ccw', '−15 seconds', () =>
			this.seekBy(-15000),
		);
		this.skipBack15Btn.addClasses(['sc-skip15', 'sc-skip15-back']);
		this.prevBtn = this.iconButton(this.transportRowEl, 'skip-back', 'Previous', () =>
			this.callDirect(() => this.plugin.api.previous(), 'prev'),
		);
		this.prevBtn.addClass('sc-hide-in-hover-mode');
		this.playBtn = this.buildPlayButton(this.transportRowEl);
		this.playBtn.addClass('sc-hide-in-hover-mode');
		this.nextBtn = this.iconButton(this.transportRowEl, 'skip-forward', 'Next', () =>
			this.callDirect(() => this.plugin.api.next(), 'next'),
		);
		this.nextBtn.addClass('sc-hide-in-hover-mode');
		// Podcast-only +15s. Mirror of skipBack15Btn, sits after next. Same
		// "no sc-hide-in-hover-mode" reasoning as the -15s sibling above.
		this.skipForward15Btn = this.iconButton(this.transportRowEl, 'rotate-cw', '+15 seconds', () =>
			this.seekBy(15000),
		);
		this.skipForward15Btn.addClasses(['sc-skip15', 'sc-skip15-forward']);
		this.repeatBtn = this.iconButton(this.transportRowEl, 'repeat', 'Repeat', () => {
			const order = ['off', 'context', 'track'] as const;
			const idx = order.indexOf(this.lastState.repeat);
			const nextMode = order[(idx + 1) % order.length];
			return this.callDirect(() => this.plugin.api.repeat(nextMode), 'repeat');
		});
		this.repeatBtn.addClass('sc-hide-in-hover-mode');

		// Static (always-visible) lyrics + queue toggles for when
		// hoverRevealControls is OFF. CSS shows/hides these vs the
		// art-corner copies based on hover-mode class.
		this.lyricsToggleBtnStatic = this.iconButton(
			this.transportRowEl,
			'mic-vocal',
			'Show / hide lyrics',
			() => this.togglePanel('lyrics'),
		);
		this.lyricsToggleBtnStatic.addClasses(['sc-show-when-static', 'sc-lyrics-toggle-static']);
		this.queueToggleBtnStatic = this.iconButton(
			this.transportRowEl,
			'list-music',
			'Show / hide queue',
			() => this.togglePanel('queue'),
		);
		this.queueToggleBtnStatic.addClasses(['sc-show-when-static', 'sc-queue-toggle-static']);

		// Volume row
		const volRow = this.playerEl.createDiv({ cls: 'sc-volume-row' });
		setIcon(volRow.createSpan({ cls: 'sc-vol-icon' }), 'volume-1');
		this.volumeBar = volRow.createEl('input', { cls: 'sc-volume' });
		this.volumeBar.type = 'range';
		this.volumeBar.min = '0';
		this.volumeBar.max = '100';
		this.volumeBar.value = '50';
		this.volumeBar.addEventListener('mousedown', () => {
			this.volumingActive = true;
		});
		this.volumeBar.addEventListener('change', async () => {
			const v = Number(this.volumeBar.value);
			this.pendingVolume = v;
			this.holdVolumeGrace();
			await this.callDirect(() => this.plugin.api.volume(v), 'volume');
		});

		// Custom device picker (replaces native <select> for visual consistency
		// with the rest of the plugin's controls and to support animations,
		// custom hit areas, etc.).
		this.buildDevicePicker();

		// Status line — only for transient errors/offline indicators.
		// The device name is shown by the device picker, no duplication.
		this.statusEl = this.rootEl.createDiv({ cls: 'sc-status' });

		this.render(EMPTY_STATE, /* connected */ false, /* hasDevices */ true);
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl('button', {
			cls: 'sc-btn',
			attr: { 'aria-label': label, title: label },
		});
		setIcon(btn, icon);
		btn.addEventListener('click', onClick);
		return btn;
	}

	private overlayIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl('button', {
			cls: 'sc-overlay-btn',
			attr: { 'aria-label': label, title: label },
		});
		setIcon(btn, icon);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	/** Small overlay button intended for top-corner placement (shuffle/repeat). */
	private makeOverlayCornerButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl('button', {
			cls: 'sc-overlay-corner-btn',
			attr: { 'aria-label': label, title: label },
		});
		setIcon(btn, icon);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	/** Toggle button used for lyrics + queue panel toggles. */
	private makeToggleButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		cls: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl('button', {
			cls: `sc-panel-toggle ${cls}`,
			attr: { 'aria-label': label, title: label },
		});
		setIcon(btn, icon);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	/**
	 * Build the main play/pause button with both icons stacked. The
	 * `is-playing` class on the button toggles which icon's `sc-icon-visible`
	 * class is set; CSS cross-fades between them.
	 */
	private buildPlayButton(parent: HTMLElement): HTMLButtonElement {
		const btn = parent.createEl('button', {
			cls: 'sc-btn sc-play-main',
			attr: { 'aria-label': 'Play/pause', title: 'Play / pause' },
		});
		const stack = btn.createDiv({ cls: 'sc-icon-stack' });
		this.playIconEl = stack.createSpan({ cls: 'sc-icon sc-icon-play sc-icon-visible' });
		this.pauseIconEl = stack.createSpan({ cls: 'sc-icon sc-icon-pause' });
		setIcon(this.playIconEl, 'play');
		setIcon(this.pauseIconEl, 'pause');
		btn.addEventListener('click', () => this.togglePlay());
		return btn;
	}

	private overlayPlayButton(parent: HTMLElement): [HTMLButtonElement, HTMLSpanElement, HTMLSpanElement] {
		const btn = parent.createEl('button', {
			cls: 'sc-overlay-btn sc-overlay-play',
			attr: { 'aria-label': 'Play/pause', title: 'Play / pause' },
		});
		const stack = btn.createDiv({ cls: 'sc-icon-stack' });
		const playIcon = stack.createSpan({ cls: 'sc-icon sc-icon-play sc-icon-visible' });
		const pauseIcon = stack.createSpan({ cls: 'sc-icon sc-icon-pause' });
		setIcon(playIcon, 'play');
		setIcon(pauseIcon, 'pause');
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.togglePlay();
		});
		return [btn, playIcon, pauseIcon];
	}

	private buildDevicePicker() {
		const deviceRow = this.playerEl.createDiv({ cls: 'sc-device-row' });
		setIcon(deviceRow.createSpan({ cls: 'sc-dev-icon' }), 'speaker');
		this.deviceWrap = deviceRow.createDiv({ cls: 'sc-device-wrap' });
		this.deviceButton = this.deviceWrap.createEl('button', {
			cls: 'sc-device-btn',
			attr: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
		});
		this.deviceLabelEl = this.deviceButton.createSpan({
			cls: 'sc-device-label',
			text: 'No device',
		});
		const chevron = this.deviceButton.createSpan({ cls: 'sc-device-chevron' });
		setIcon(chevron, 'chevron-down');
		this.deviceButton.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleDevicePopover();
		});
		this.devicePopover = this.deviceWrap.createDiv({ cls: 'sc-device-popover' });
		this.devicePopover.setAttr('role', 'listbox');
	}

	private toggleDevicePopover() {
		const open = this.deviceWrap.hasClass('is-open');
		if (open) this.closeDevicePopover();
		else this.openDevicePopover();
	}

	private openDevicePopover() {
		this.deviceWrap.addClass('is-open');
		this.deviceButton.setAttr('aria-expanded', 'true');
		// Always fetch fresh on open — devices change rarely and polling
		// for them every few seconds was wasted bandwidth. Cached list
		// shows immediately; the refetch updates if it changed.
		this.refreshDevices().then(() => {
			this.populateDevices(this.cachedDevices, this.lastState.deviceId);
		});
	}

	/**
	 * Fetch the available-devices list and update cachedDevices. Errors are
	 * non-fatal — the old cached list (if any) keeps showing.
	 */
	private async refreshDevices() {
		if (!this.plugin.auth.isAuthed) return;
		try {
			const d = await this.plugin.api.getAvailableDevices();
			this.cachedDevices = (d.devices ?? []) as Device[];
		} catch (e) {
			console.warn('[spotify-control] device fetch failed (non-fatal)', e);
		}
	}

	private closeDevicePopover() {
		this.deviceWrap.removeClass('is-open');
		this.deviceButton.setAttr('aria-expanded', 'false');
	}

	// ── Visibility / outside-click ──────────────────────────────────────────

	private attachVisibilityListener() {
		this.visibilityListener = () => {
			if (document.visibilityState === 'hidden') {
				this.stopPolling();
				this.stopLocalProgress();
			} else {
				this.startPolling();
				if (this.lastState.isPlaying) {
					this.startLocalProgress(this.lastState.progressMs);
				}
			}
		};
		document.addEventListener('visibilitychange', this.visibilityListener);
	}

	private detachVisibilityListener() {
		if (this.visibilityListener) {
			document.removeEventListener('visibilitychange', this.visibilityListener);
			this.visibilityListener = null;
		}
	}

	private attachOutsideClickListener() {
		this.outsideClickListener = (e: MouseEvent) => {
			if (!this.deviceWrap?.hasClass('is-open')) return;
			if (!this.deviceWrap.contains(e.target as Node)) {
				this.closeDevicePopover();
			}
		};
		this.outsideKeydownListener = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (this.deviceWrap?.hasClass('is-open')) this.closeDevicePopover();
				if (this.artVolumePopover?.hasClass('is-open')) {
					this.artVolumePopover.removeClass('is-open');
				}
			}
		};
		document.addEventListener('click', this.outsideClickListener);
		document.addEventListener('keydown', this.outsideKeydownListener);
	}

	private detachOutsideClickListener() {
		if (this.outsideClickListener) {
			document.removeEventListener('click', this.outsideClickListener);
			this.outsideClickListener = null;
		}
		if (this.outsideKeydownListener) {
			document.removeEventListener('keydown', this.outsideKeydownListener);
			this.outsideKeydownListener = null;
		}
		if (this.volumePopoverOutsideListener) {
			document.removeEventListener('click', this.volumePopoverOutsideListener);
			this.volumePopoverOutsideListener = null;
		}
	}

	private applyHoverModeClass() {
		if (!this.rootEl) return;
		const s = this.plugin.settings;
		// Touch devices have no hover — the on-art overlay would be unreachable
		// (no way to reveal prev/play/next). Force the class off on mobile
		// regardless of the stored setting; the duplicate transport row below
		// the art carries the controls.
		this.rootEl.toggleClass('is-hover-mode', s.hoverRevealControls && !Platform.isMobile);
		this.rootEl.toggleClass('is-lyrics-enabled', s.enableLyrics);
		this.rootEl.toggleClass('is-queue-enabled', s.enableQueue);
		this.rootEl.toggleClass('is-progress-on-art', s.progressOnArt);
		this.rootEl.toggleClass('is-volume-on-art', s.volumeOnArt);

		// Snap closed if the user disabled the feature behind the open panel.
		if (
			(this.currentPanel === 'lyrics' && !s.enableLyrics) ||
			(this.currentPanel === 'queue' && !s.enableQueue)
		) {
			this.setCurrentPanel('art');
		}
		this.applyPanelClasses();
		this.applyLyricsPosition();
		this.rebuildControlsOnArt();
	}

	private applyPanelClasses() {
		this.rootEl.toggleClass('is-panel-lyrics', this.currentPanel === 'lyrics');
		this.rootEl.toggleClass('is-panel-queue', this.currentPanel === 'queue');
		this.rootEl.toggleClass(
			'is-panel-open',
			this.currentPanel !== 'art',
		);
		// Active state on toggle buttons.
		this.lyricsToggleBtn?.toggleClass('is-active', this.currentPanel === 'lyrics');
		this.queueToggleBtn?.toggleClass('is-active', this.currentPanel === 'queue');
		this.lyricsToggleBtnStatic?.toggleClass(
			'is-active',
			this.currentPanel === 'lyrics',
		);
		this.queueToggleBtnStatic?.toggleClass(
			'is-active',
			this.currentPanel === 'queue',
		);
	}

	/**
	 * Move the lyrics panel between the art-stack (replace mode) and the
	 * below-slot (below mode). Done by JS rather than CSS so the same node
	 * keeps its scroll position / pending fetch state across mode switches.
	 */
	private applyLyricsPosition() {
		if (!this.lyricsPanelEl || !this.lyricsBelowSlot) return;
		const mode = this.plugin.settings.lyricsPosition;
		this.rootEl.toggleClass('is-lyrics-replace', mode === 'replace');
		this.rootEl.toggleClass('is-lyrics-below', mode === 'below');
		const targetParent =
			mode === 'below'
				? this.lyricsBelowSlot
				: (this.artWrapEl.parentElement as HTMLElement); // sc-art-stack
		// Move both lyrics + queue panels into the chosen container.
		for (const panel of [this.lyricsPanelEl, this.queuePanelEl]) {
			if (panel && panel.parentElement !== targetParent) {
				targetParent.appendChild(panel);
			}
		}
	}

	/**
	 * Create progress / volume DOM on the art when the user enables those
	 * settings. Tear them down when the settings turn off. Called from
	 * applyHoverModeClass() so the DOM reflects current settings at all times.
	 */
	private rebuildControlsOnArt() {
		const s = this.plugin.settings;

		// Progress on art
		if (s.progressOnArt && !this.artProgressEl) {
			this.artProgressEl = this.artWrapEl.createDiv({ cls: 'sc-art-progress' });
			this.artProgressFillEl = this.artProgressEl.createDiv({
				cls: 'sc-art-progress-fill',
			});
			this.artProgressEl.addEventListener('click', (e) => {
				if (!this.lastState.durationMs) return;
				const rect = this.artProgressEl!.getBoundingClientRect();
				const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
				const positionMs = Math.round(pct * this.lastState.durationMs);
				this.holdSeekGrace();
				this.callDirect(() => this.plugin.api.seek(positionMs), 'seek');
				this.startLocalProgress(positionMs);
			});
		} else if (!s.progressOnArt && this.artProgressEl) {
			this.artProgressEl.remove();
			this.artProgressEl = null;
			this.artProgressFillEl = null;
		}

		// Volume on art
		if (s.volumeOnArt && !this.artVolumeBtn) {
			this.artVolumeBtn = this.artWrapEl.createEl('button', {
				cls: 'sc-art-volume-btn',
				attr: { 'aria-label': 'Volume', title: 'Volume' },
			});
			setIcon(this.artVolumeBtn, 'volume-2');
			this.artVolumePopover = this.artWrapEl.createDiv({
				cls: 'sc-art-volume-popover',
			});
			this.artVolumeSlider = this.artVolumePopover.createEl('input', {
				cls: 'sc-art-volume-slider',
			});
			this.artVolumeSlider.type = 'range';
			this.artVolumeSlider.min = '0';
			this.artVolumeSlider.max = '100';
			this.artVolumeSlider.value = '50';
			// Vertical orientation via CSS (writing-mode trick + reverse).
			this.artVolumeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.artVolumePopover!.toggleClass(
					'is-open',
					!this.artVolumePopover!.hasClass('is-open'),
				);
			});
			this.artVolumeSlider.addEventListener('mousedown', () => {
				this.volumingActive = true;
			});
			this.artVolumeSlider.addEventListener('change', async () => {
				const v = Number(this.artVolumeSlider!.value);
				this.pendingVolume = v;
				this.holdVolumeGrace();
				await this.callDirect(() => this.plugin.api.volume(v), 'volume');
			});
			// Close popover when clicking outside it. Stored in a field
			// (not anonymous) so rebuildControlsOnArt() can remove it on
			// teardown — otherwise toggling the setting would pile up
			// listeners over time.
			this.volumePopoverOutsideListener = (e: MouseEvent) => {
				if (!this.artVolumePopover) return;
				if (!this.artVolumePopover.hasClass('is-open')) return;
				if (
					this.artVolumePopover.contains(e.target as Node) ||
					this.artVolumeBtn?.contains(e.target as Node)
				)
					return;
				this.artVolumePopover.removeClass('is-open');
			};
			document.addEventListener('click', this.volumePopoverOutsideListener);
		} else if (!s.volumeOnArt && this.artVolumeBtn) {
			this.artVolumeBtn.remove();
			this.artVolumePopover?.remove();
			this.artVolumeBtn = null;
			this.artVolumePopover = null;
			this.artVolumeSlider = null;
			// Detach the outside-click listener so it's not held against a
			// removed popover for the rest of the session.
			if (this.volumePopoverOutsideListener) {
				document.removeEventListener('click', this.volumePopoverOutsideListener);
				this.volumePopoverOutsideListener = null;
			}
		}
	}

	// ── Polling (chained setTimeout, with backoff) ──────────────────────────

	private startPolling() {
		this.pollingStopped = false;
		if (this.pollTimer != null) return;
		this.scheduleNextPoll(0);
	}

	private stopPolling() {
		this.pollingStopped = true;
		if (this.pollTimer != null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private scheduleNextPoll(delayMs: number) {
		if (this.pollingStopped) return;
		if (this.pollTimer != null) window.clearTimeout(this.pollTimer);
		this.pollTimer = window.setTimeout(async () => {
			this.pollTimer = null;
			await this.poll();
			if (!this.pollingStopped) {
				const interval =
					this.consecutivePollFailures > 0
						? Math.min(
								MAX_BACKOFF_MS,
								this.plugin.settings.pollIntervalMs *
									Math.pow(2, this.consecutivePollFailures - 1),
							)
						: this.plugin.settings.pollIntervalMs;
				this.scheduleNextPoll(interval);
			}
		}, delayMs);
	}

	private async poll() {
		if (!this.plugin.auth.isAuthed) {
			this.render(EMPTY_STATE, false, true);
			return;
		}
		try {
			const playback = await this.plugin.api.getPlaybackState();
			this.consecutivePollFailures = 0;

			this.pollTick++;
			// Devices: fetch once on first poll (so empty-state has options),
			// then ONLY when the user opens the picker (see openDevicePopover).
			// /me/player/devices was costing 4 req/min for data nobody was
			// looking at most of the time; pull on-demand instead.
			if (this.cachedDevices.length === 0 && this.pollTick === 1) {
				await this.refreshDevices();
			}

			if (!playback || !playback.device) {
				this.render(EMPTY_STATE, true, this.cachedDevices.length > 0);
				this.populateDevices(this.cachedDevices, null);
				return;
			}
			const item = playback.item as any;
			// Episode detection — three independent signals, any one is sufficient:
			//   1. `currently_playing_type` on the response root (authoritative;
			//      set by Spotify regardless of additional_types)
			//   2. `item.type === 'episode'` (on the item itself when
			//      additional_types=episode was honored)
			//   3. URI prefix / show field on item (defensive fallbacks)
			// Using all three so a single missing field doesn't break detection.
			const cpt = (playback as any).currently_playing_type;
			const isEpisode =
				cpt === 'episode' ||
				item?.type === 'episode' ||
				item?.uri?.startsWith?.('spotify:episode:') === true ||
				!!item?.show;
			const state: PlaybackState = {
				isPlaying: playback.is_playing,
				trackName: item?.name ?? '',
				artist:
					item?.artists?.map((a: any) => a.name).join(', ') ?? item?.show?.name ?? '',
				album: item?.album?.name ?? item?.show?.publisher ?? '',
				trackUri: item?.uri ?? '',
				contextUri: (playback as any)?.context?.uri ?? null,
				albumArtUrl:
					item?.album?.images?.[0]?.url ?? item?.images?.[0]?.url ?? null,
				trackUrl: item?.external_urls?.spotify ?? null,
				progressMs: playback.progress_ms ?? 0,
				durationMs: item?.duration_ms ?? 0,
				shuffle: playback.shuffle_state,
				repeat: playback.repeat_state as PlaybackState['repeat'],
				volumePercent: playback.device.volume_percent ?? 50,
				deviceId: playback.device.id,
				deviceName: playback.device.name,
				hasActiveDevice: true,
				isEpisode,
				episodeDescription: isEpisode
					? htmlDescriptionToText(item?.html_description) || item?.description || ''
					: '',
				episodeReleaseDate: isEpisode ? (item?.release_date ?? '') : '',
			};
			const prevTrackUri = this.lastState.trackUri;
			this.render(state, true, true);

			if (state.trackUri && state.trackUri !== prevTrackUri) {
				this.onTrackChanged(state);
			}
			this.populateDevices(this.cachedDevices, state.deviceId);

			if (state.isPlaying) this.startLocalProgress(state.progressMs);
			else this.stopLocalProgress();
		} catch (e: any) {
			this.consecutivePollFailures++;
			console.error('[spotify-control] poll failed', e);
			this.statusEl.setText(
				this.consecutivePollFailures > 1
					? `Offline? (retry ${this.consecutivePollFailures}, backing off)`
					: `Error: ${e?.message ?? e}`,
			);
		}
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private render(state: PlaybackState, connected: boolean, hasDevices: boolean) {
		this.lastState = state;

		// Tab title refresh (Obsidian only auto-calls getDisplayText on layout
		// change; force it when the track actually changes).
		const headerTrack = state.hasActiveDevice ? state.trackName : '';
		if (headerTrack !== this.lastHeaderTrack) {
			this.lastHeaderTrack = headerTrack;
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		}

		if (!connected) {
			this.emptyEl.style.display = 'block';
			this.renderEmptyState();
			this.playerEl.style.display = 'none';
			this.statusEl.setText('');
			return;
		}
		if (!state.hasActiveDevice) {
			this.emptyEl.style.display = 'block';
			this.emptyTextEl.setText(
				hasDevices
					? 'No active Spotify device. Start Spotify on a device, or pick one below.'
					: 'No Spotify devices found. Open Spotify somewhere first.',
			);
			// Connected but no device: offer a quick "open web player" button as
			// the path of least friction.
			this.emptyActionsEl.empty();
			const openBtn = this.emptyActionsEl.createEl('button', {
				cls: 'sc-empty-btn sc-empty-btn-secondary',
				text: 'Open Spotify Web Player',
			});
			openBtn.addEventListener('click', () => this.plugin.openSpotifyWebPlayer());
			this.playerEl.style.display = hasDevices ? 'flex' : 'none';
			return;
		}

		this.emptyEl.style.display = 'none';
		this.playerEl.style.display = 'flex';

		// Album art
		if (state.albumArtUrl) {
			if (this.artEl.src !== state.albumArtUrl) this.artEl.src = state.albumArtUrl;
			this.artEl.style.display = 'block';
			this.artPlaceholderEl.style.display = 'none';
		} else {
			this.artEl.style.display = 'none';
			this.artPlaceholderEl.style.display = 'flex';
		}

		// Text — only setText when value actually changed. setText still works
		// per-tick if everything's unchanged, but skipping the call avoids
		// browser's text-node mutation work (small but adds up at 20+ polls/min).
		const prev = this.lastRendered;
		const titleText = state.trackName || '—';
		if (prev.title !== titleText) {
			this.titleEl.setText(titleText);
			prev.title = titleText;
		}
		if (prev.artist !== state.artist) {
			this.artistEl.setText(state.artist);
			prev.artist = state.artist;
		}
		// Album row formatting:
		//   - Tracks: album name (e.g., "Random Access Memories")
		//   - Episodes: "Oct 24, 2025  •  50 min 44 sec left" so the row
		//     surfaces the date + how much of the episode is left, which is
		//     what listeners actually want to see (rather than the publisher
		//     name, which is just a corporate label).
		const albumText = state.isEpisode
			? formatEpisodeMeta(state.episodeReleaseDate, state.progressMs, state.durationMs)
			: state.album;
		if (prev.album !== albumText) {
			this.albumEl.setText(albumText);
			prev.album = albumText;
		}
		// Toggle the .is-episode class so CSS can swap the 15s skip buttons in
		// (and the description panel takes over the lyrics slot).
		this.rootEl.toggleClass('is-episode', state.isEpisode);
		// When transitioning out of an episode, clear the cached description
		// so the next episode (or the no-podcast placeholder) repaints.
		if (!state.isEpisode && this.lastRenderedEpisodeDesc !== null) {
			this.lastRenderedEpisodeDesc = null;
		}
		const clickable = !!state.trackUrl;
		if (prev.titleClickable !== clickable) {
			this.titleEl.toggleClass('sc-title-clickable', clickable);
			prev.titleClickable = clickable;
		}

		// Play/pause icons — only flip when state changed.
		if (prev.isPlaying !== state.isPlaying) {
			this.playBtn.toggleClass('is-playing', state.isPlaying);
			this.playIconEl.toggleClass('sc-icon-visible', !state.isPlaying);
			this.pauseIconEl.toggleClass('sc-icon-visible', state.isPlaying);
			this.overlayPlayBtn.toggleClass('is-playing', state.isPlaying);
			this.overlayPlayIconEl.toggleClass('sc-icon-visible', !state.isPlaying);
			this.overlayPauseIconEl.toggleClass('sc-icon-visible', state.isPlaying);
			prev.isPlaying = state.isPlaying;
		}

		// Seek bar (unless user is dragging or in grace period)
		if (!this.seekingActive) {
			const pct = state.durationMs ? (state.progressMs / state.durationMs) * 100 : 0;
			this.seekBar.value = String(pct);
			this.elapsedEl.setText(formatTime(state.progressMs));
			this.totalEl.setText(formatTime(state.durationMs));
		}

		// Volume
		if (this.pendingVolume !== null) {
			if (
				Math.abs(state.volumePercent - this.pendingVolume) <=
				PENDING_VOLUME_MATCH_TOLERANCE
			) {
				this.pendingVolume = null;
				this.volumeBar.value = String(state.volumePercent);
			}
		} else if (!this.volumingActive) {
			this.volumeBar.value = String(state.volumePercent);
		}

		// Active state — gate on actual change.
		if (prev.shuffle !== state.shuffle) {
			this.shuffleBtn.toggleClass('is-active', state.shuffle);
			this.overlayShuffleBtn?.toggleClass('is-active', state.shuffle);
			prev.shuffle = state.shuffle;
		}
		if (prev.repeat !== state.repeat) {
			const repeatOn = state.repeat !== 'off';
			const repeatOne = state.repeat === 'track';
			this.repeatBtn.toggleClass('is-active', repeatOn);
			this.repeatBtn.toggleClass('is-repeat-one', repeatOne);
			this.overlayRepeatBtn?.toggleClass('is-active', repeatOn);
			this.overlayRepeatBtn?.toggleClass('is-repeat-one', repeatOne);
			prev.repeat = state.repeat;
		}

		// Art-progress fill (when progress-on-art is enabled)
		if (this.artProgressFillEl && state.durationMs && !this.seekingActive) {
			const pct = (state.progressMs / state.durationMs) * 100;
			this.artProgressFillEl.style.width = `${pct}%`;
		}

		// Art-volume slider (when volume-on-art is enabled)
		if (this.artVolumeSlider && this.pendingVolume === null && !this.volumingActive) {
			this.artVolumeSlider.value = String(state.volumePercent);
		}

		// Device label
		const deviceText = state.deviceName ?? 'No device';
		if (prev.deviceText !== deviceText) {
			this.deviceLabelEl.setText(deviceText);
			prev.deviceText = deviceText;
		}

		// Status: only clear when there's no error showing. (Errors are
		// written by poll() catch; render() shouldn't stomp them every tick.)
		if (this.consecutivePollFailures === 0 && this.statusEl.textContent) {
			this.statusEl.setText('');
		}
	}

	/**
	 * Render the "not connected" empty state with inline action buttons.
	 * Three sub-states:
	 *   - No clientId set → "Open Settings" (user needs full setup flow)
	 *   - clientId set, no tokens → "Log in" + "Open Settings" fallback
	 *   - (logged in cases handled elsewhere)
	 */
	private renderEmptyState() {
		this.emptyActionsEl.empty();
		const hasClientId = !!this.plugin.settings.clientId.trim();

		if (!hasClientId) {
			this.emptyTextEl.setText('Spotify Control needs a one-time setup.');
			const setupBtn = this.emptyActionsEl.createEl('button', {
				cls: 'sc-empty-btn sc-empty-btn-primary',
				text: 'Set up',
			});
			setupBtn.addEventListener('click', () => this.plugin.openSettings());
			return;
		}

		this.emptyTextEl.setText('Not logged in to Spotify.');
		const loginBtn = this.emptyActionsEl.createEl('button', {
			cls: 'sc-empty-btn sc-empty-btn-primary',
			text: 'Log in',
		});
		loginBtn.addEventListener('click', () => this.plugin.auth.beginLogin());
		const settingsBtn = this.emptyActionsEl.createEl('button', {
			cls: 'sc-empty-btn sc-empty-btn-secondary',
			text: 'Settings',
		});
		settingsBtn.addEventListener('click', () => this.plugin.openSettings());
	}

	/**
	 * Repopulate the device popover only if the device list changed.
	 * Preserves user's open/scroll state mid-poll.
	 */
	private populateDevices(devices: Device[], activeId: string | null) {
		const sig = devices.map((d) => `${d.id}:${d.is_active ? '1' : '0'}`).join('|');
		const prevSig = this.devicePopover.dataset.sig ?? '';
		if (sig === prevSig) return;
		this.devicePopover.dataset.sig = sig;
		this.devicePopover.empty();
		if (devices.length === 0) {
			this.devicePopover.createDiv({
				cls: 'sc-device-empty',
				text: 'No devices found',
			});
			return;
		}
		for (const d of devices) {
			const item = this.devicePopover.createEl('button', {
				cls: 'sc-device-item',
				attr: { role: 'option' },
			});
			const isActive = d.id === activeId;
			if (isActive) item.addClass('is-active');
			const dot = item.createSpan({ cls: 'sc-device-dot' });
			if (isActive) dot.addClass('is-active');
			const labelWrap = item.createDiv({ cls: 'sc-device-item-label' });
			labelWrap.createDiv({ cls: 'sc-device-item-name', text: d.name });
			labelWrap.createDiv({
				cls: 'sc-device-item-type',
				text: d.type.toLowerCase(),
			});
			item.addEventListener('click', async (e) => {
				e.stopPropagation();
				this.closeDevicePopover();
				if (isActive) return;
				await this.callDirect(
					() => this.plugin.api.transferTo(d.id, /* startPlaying */ true),
					'transfer',
				);
			});
		}
	}

	// ── Smooth progress between polls ───────────────────────────────────────

	private startLocalProgress(baseMs: number) {
		this.stopLocalProgress();
		if (document.visibilityState === 'hidden') return;
		this.localProgressBaseMs = baseMs;
		this.localProgressStartedAt = Date.now();
		this.localProgressTimer = window.setInterval(() => {
			// Mid-flight visibility check. startLocalProgress() bails at start
			// if the document is hidden, but the user might minimize the
			// window AFTER the timer is set up — in which case the timer
			// keeps firing every 500ms with no UI to update. Cheap to bail.
			if (document.visibilityState === 'hidden') return;
			if (this.seekingActive || !this.lastState.isPlaying) return;
			const elapsed = Date.now() - this.localProgressStartedAt;
			const ms = Math.min(
				this.lastState.durationMs,
				this.localProgressBaseMs + elapsed,
			);
			this.elapsedEl.setText(formatTime(ms));
			if (this.lastState.durationMs) {
				const pct = (ms / this.lastState.durationMs) * 100;
				this.seekBar.value = String(pct);
				if (this.artProgressFillEl) {
					this.artProgressFillEl.style.width = `${pct}%`;
				}
			}
			// Episode metadata row ("X min Y sec left") needs to tick with the
			// local timer too — otherwise "left" only updates every 3 seconds
			// at poll cadence, which feels stuck. Re-render only when the
			// formatted text actually changes (i.e., when the seconds-bucket
			// crosses), so we're not setText-ing an unchanged string at 2Hz.
			if (this.lastState.isEpisode) {
				const meta = formatEpisodeMeta(
					this.lastState.episodeReleaseDate,
					ms,
					this.lastState.durationMs,
				);
				if (this.lastRendered.album !== meta) {
					this.albumEl.setText(meta);
					this.lastRendered.album = meta;
				}
			}
			// Sync lyrics highlight to the same tick.
			if (this.currentPanel === 'lyrics' && this.lyricsData.kind === 'synced') {
				this.updateActiveLyric(ms);
			}
		}, LOCAL_PROGRESS_TICK_MS);
	}

	private stopLocalProgress() {
		if (this.localProgressTimer != null) {
			window.clearInterval(this.localProgressTimer);
			this.localProgressTimer = null;
		}
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	/**
	 * Toggle play/pause based on `lastState.isPlaying` rather than an extra
	 * round-trip. lastState is kept fresh by polling (every 3s by default)
	 * AND by the re-poll scheduled 400ms after every action — so on the
	 * first click after the sidebar opens it may briefly be EMPTY_STATE
	 * (isPlaying: false). In that initial-load case we fall back to a
	 * fetch; otherwise we trust lastState. Saves one API request per click.
	 */
	private async togglePlay() {
		if (!this.plugin.settings.tokens) {
			new Notice('Spotify not connected.');
			return;
		}
		// If we haven't polled yet (no active device known), fetch real
		// state once so we make the right decision.
		if (!this.lastState.hasActiveDevice) {
			try {
				const state = await this.plugin.api.getPlaybackState();
				if (state?.is_playing) {
					return this.callDirect(() => this.plugin.api.pause(), 'pause');
				}
				return this.callDirect(() => this.plugin.api.play(), 'play');
			} catch (e: any) {
				new Notice(`Play/pause: ${e?.message ?? e}`);
				return;
			}
		}
		if (this.lastState.isPlaying) {
			await this.callDirect(() => this.plugin.api.pause(), 'pause');
		} else {
			await this.callDirect(() => this.plugin.api.play(), 'play');
		}
	}

	private async callDirect(fn: () => Promise<unknown>, label: string) {
		if (!this.plugin.settings.tokens) {
			new Notice('Spotify not connected.');
			return;
		}
		try {
			await fn();
			window.setTimeout(() => this.poll(), 400);
		} catch (e: any) {
			console.error(`[spotify-control] ${label} failed`, e);
			new Notice(`Spotify ${label}: ${e?.message ?? e}`);
		}
	}

	// ── Lyrics ─────────────────────────────────────────────────────────────

	/** Toggle a specific panel; clicking the same toggle again returns to art. */
	togglePanel(panel: 'lyrics' | 'queue') {
		if (panel === 'lyrics' && !this.plugin.settings.enableLyrics) {
			new Notice('Enable lyrics in Spotify Control settings first.');
			return;
		}
		if (panel === 'queue' && !this.plugin.settings.enableQueue) {
			new Notice('Enable queue in Spotify Control settings first.');
			return;
		}
		this.setCurrentPanel(this.currentPanel === panel ? 'art' : panel);
	}

	private setCurrentPanel(next: 'art' | 'lyrics' | 'queue') {
		if (this.currentPanel === next) return;
		this.currentPanel = next;
		this.applyPanelClasses();
		if (next === 'lyrics' && this.lastState.trackUri) {
			// Episode-aware routing. LRCLIB is music-only, so calling
			// fetchAndRenderLyrics for a podcast both wastes an HTTP and
			// races against the synchronous renderLyricsForEpisode below
			// (the async "no lyrics found" wins and overwrites the
			// description).
			if (this.lastState.isEpisode) {
				this.renderLyricsForEpisode();
			} else {
				this.fetchAndRenderLyrics(this.lastState);
			}
		} else if (next === 'queue') {
			this.fetchAndRenderQueue();
		}
	}

	private async fetchAndRenderQueue() {
		this.queueScrollEl.empty();
		this.queueScrollEl.createDiv({ cls: 'sc-queue-status', text: 'Loading queue…' });
		try {
			const snap = await this.plugin.queue.get(
				/* force */ true,
				this.lastState.trackUri,
			);
			if (this.currentPanel !== 'queue') return;
			this.renderQueueContent(snap.upcoming);
		} catch (e) {
			console.error('[spotify-control] queue fetch failed', e);
			this.queueScrollEl.empty();
			this.queueScrollEl.createDiv({
				cls: 'sc-queue-status',
				text: 'Could not load queue.',
			});
		}
	}

	private renderQueueContent(items: QueueItem[]) {
		const sig = items.map((i) => i.uri).join('|');
		if (sig === this.queueLoadedSig) return;
		this.queueLoadedSig = sig;
		this.queueScrollEl.empty();
		if (items.length === 0) {
			this.queueScrollEl.createDiv({
				cls: 'sc-queue-status',
				text: 'Queue is empty.',
			});
			return;
		}
		// Preload all visible queue thumbnails up-front. They're tiny (~36px
		// album covers) and warming the cache means scrolling the queue
		// feels instant instead of staggered-loading on view.
		for (const item of items) {
			if (item.imageUrl) preloadImage(item.imageUrl);
		}
		for (const item of items) {
			const row = this.queueScrollEl.createDiv({ cls: 'sc-queue-item' });
			if (item.imageUrl) {
				const img = row.createEl('img', { cls: 'sc-queue-thumb' });
				img.src = item.imageUrl;
			} else {
				row.createDiv({ cls: 'sc-queue-thumb sc-queue-thumb-placeholder' });
			}
			const body = row.createDiv({ cls: 'sc-queue-body' });
			body.createDiv({ cls: 'sc-queue-name', text: item.name });
			body.createDiv({ cls: 'sc-queue-sub', text: item.artist });
			row.createSpan({
				cls: 'sc-queue-duration',
				text: formatTime(item.durationMs),
			});
			// Clicking a queue track plays it WITHIN the current context
			// (playlist/album/etc.) so the rest of the queue keeps playing
			// after this track ends. Falls back to single-track play only
			// if there's no context (e.g. user was playing a single track
			// in isolation to begin with).
			row.addEventListener('click', () => {
				const ctx = this.lastState.contextUri;
				if (ctx) {
					this.callDirect(
						() => this.plugin.api.play({
							contextUri: ctx,
							offset: { uri: item.uri },
						}),
						'play',
					);
				} else {
					this.callDirect(
						() => this.plugin.api.play({ uris: [item.uri] }),
						'play',
					);
				}
			});
		}
	}

	/**
	 * Called from poll() when the playing track changes. Handles three
	 * background prefetches so the user gets instant panel-open + smooth
	 * track transitions:
	 *
	 *   1. Lyrics: warm the LyricsService cache for the new track. If the
	 *      lyrics panel is already open, also re-render. Single-flight
	 *      dedupe inside LyricsService means both paths share one fetch.
	 *   2. Queue: refresh in the background so a panel-open right after a
	 *      track change shows fresh data immediately. (Spotify reorders
	 *      the queue when context changes.)
	 *   3. Album art: preload the next 1-2 upcoming tracks' images via
	 *      new Image() so the browser cache is warm. When the user actually
	 *      advances to that track, art switches with no network latency.
	 *
	 * All three are fire-and-forget — failures don't block anything.
	 */
	private onTrackChanged(state: PlaybackState) {
		// 0. Warm the current track's art in the browser cache. It's already
		// rendered in <img> but other surfaces (queue thumbnails) benefit.
		if (state.albumArtUrl) preloadImage(state.albumArtUrl);

		// 0.5. Auto-open the lyrics panel for podcast episodes so the
		// description is visible without an extra click. Conditions:
		//   - Lyrics feature enabled (we reuse the lyrics panel slot for
		//     show notes; if the feature is off there's no panel to open)
		//   - The user hasn't manually opened a different panel (queue) —
		//     respect their context. We only auto-take-over the closed/
		//     "art" state, never override an intentional choice.
		// Fires once per track-uri change, so closing the panel and leaving
		// it closed stays closed for the rest of the episode. The next
		// episode resets the cycle.
		if (
			state.isEpisode &&
			this.plugin.settings.enableLyrics &&
			this.currentPanel === 'art'
		) {
			this.setCurrentPanel('lyrics');
		}

		// 1. Lyrics: render if panel is open, otherwise just warm the cache.
		// Skip podcasts entirely — episodes never have LRCLIB entries, so
		// firing the request is a guaranteed 404 (and the panel showing stale
		// lyrics from the previous song would be misleading).
		const isTrack = state.trackUri.startsWith('spotify:track:');
		if (this.plugin.settings.enableLyrics && state.trackUri && isTrack) {
			if (this.currentPanel === 'lyrics') {
				this.fetchAndRenderLyrics(state);
			} else {
				this.plugin.lyrics
					.get({
						uri: state.trackUri,
						trackName: state.trackName,
						artist: state.artist,
						album: state.album,
						durationMs: state.durationMs,
					})
					.catch((e) => {
						console.warn('[spotify-control] lyrics prefetch failed', e);
					});
			}
		} else if (
			this.plugin.settings.enableLyrics &&
			!isTrack &&
			this.currentPanel === 'lyrics'
		) {
			// Episode playing and panel was open — replace the stale-from-last-
			// track lyrics with an explicit empty state.
			this.renderLyricsForEpisode();
		}

		// 2. Queue: background refresh so next panel-open is instant.
		// Pass new trackUri so the cache-invalidation check uses the
		// fresh value (and queue.get's internal logic doesn't think the
		// cached-from-old-track snapshot is still valid).
		if (this.plugin.settings.enableQueue) {
			this.plugin.queue
				.get(/* force */ true, state.trackUri)
				.then((snap) => {
					// 3. Preload first 2 upcoming tracks' album art.
					for (const item of snap.upcoming.slice(0, 2)) {
						if (item.imageUrl) preloadImage(item.imageUrl);
					}
					// Also re-render queue panel if it's currently open
					// (so it reflects the new queue without waiting for
					// the user to close + reopen).
					if (this.currentPanel === 'queue') {
						this.renderQueueContent(snap.upcoming);
					}
				})
				.catch((e) => {
					console.warn('[spotify-control] queue prefetch failed', e);
				});
		}
	}

	/**
	 * Fetch lyrics for the current track and rebuild the lyrics DOM.
	 * Idempotent — calling for the same track twice hits the in-memory cache.
	 */
	private async fetchAndRenderLyrics(state: PlaybackState) {
		this.lyricsCurrentTrackUri = state.trackUri;
		this.renderLyricsLoading();
		try {
			const result = await this.plugin.lyrics.get({
				uri: state.trackUri,
				trackName: state.trackName,
				artist: state.artist,
				album: state.album,
				durationMs: state.durationMs,
			});
			// Race guard: user may have skipped tracks while we were fetching.
			if (this.lyricsCurrentTrackUri !== state.trackUri) return;
			this.lyricsData = result;
			this.renderLyricsContent();
		} catch (e) {
			console.error('[spotify-control] lyrics fetch failed', e);
			this.lyricsData = LYRICS_NONE;
			this.renderLyricsContent();
		}
	}

	private renderLyricsLoading() {
		this.lyricsScrollEl.empty();
		this.lyricsScrollEl.createDiv({
			cls: 'sc-lyrics-status',
			text: 'Loading lyrics…',
		});
		this.lyricsLineEls = [];
		this.lyricsActiveIdx = -1;
	}

	/**
	 * "No lyrics for podcasts" placeholder. Shown when the lyrics panel is
	 * open and the user switches to / starts a podcast episode, so the panel
	 * doesn't keep displaying the previous track's lyrics.
	 */
	/**
	 * Render the episode description in the lyrics panel slot (when an
	 * episode is playing). If the description is empty or unavailable,
	 * falls back to the original "no lyrics" placeholder.
	 *
	 * Tracks the last-rendered description so re-renders inside the same
	 * episode don't re-paint the DOM every poll (descriptions can be 500+
	 * chars; repainting at 20Hz would be wasteful).
	 */
	private renderLyricsForEpisode() {
		const desc = this.lastState.episodeDescription;
		if (this.lastRenderedEpisodeDesc === desc) return;
		this.lastRenderedEpisodeDesc = desc;
		this.lyricsScrollEl.empty();
		this.lyricsLineEls = [];
		this.lyricsActiveIdx = -1;
		if (!desc) {
			this.lyricsScrollEl.createDiv({
				cls: 'sc-lyrics-status',
				text: '🎙️ No lyrics for podcasts.',
			});
			return;
		}
		// Render as a single block of text in the same scroll container as
		// lyrics. Whitespace-pre-line preserves the paragraph breaks Spotify
		// puts in description text.
		const box = this.lyricsScrollEl.createDiv({ cls: 'sc-episode-description' });
		box.setText(desc);
	}

	private lastRenderedEpisodeDesc: string | null = null;

	private renderLyricsContent() {
		this.lyricsScrollEl.empty();
		this.lyricsLineEls = [];
		this.lyricsActiveIdx = -1;
		this.lyricsAutoScrollUntil = 0;

		const { lines, plainText, kind } = this.lyricsData;

		if (kind === 'instrumental') {
			this.lyricsScrollEl.createDiv({
				cls: 'sc-lyrics-status',
				text: '🎼 Instrumental track',
			});
			return;
		}
		if (kind === 'none') {
			this.lyricsScrollEl.createDiv({
				cls: 'sc-lyrics-status',
				text: 'No lyrics found on LRCLIB for this track.',
			});
			return;
		}

		if (kind === 'synced') {
			// Top + bottom padding so the first / last line can center.
			this.lyricsScrollEl.createDiv({ cls: 'sc-lyrics-padding' });
			for (const line of lines) {
				const el = this.lyricsScrollEl.createDiv({
					cls: 'sc-lyrics-line sc-lyrics-line-clickable',
					text: line.text || ' ', // nbsp so empty lines have height
				});
				el.setAttr('role', 'button');
				el.setAttr('title', 'Jump to this line');
				// Click -> seek to this line timestamp. Restart local progress
				// so the highlight snaps to the clicked line immediately
				// instead of waiting for the next /me/player poll.
				el.addEventListener('click', () => {
					this.callDirect(
						() => this.plugin.api.seek(line.timeMs),
						'seek',
					);
					this.startLocalProgress(line.timeMs);
					this.updateActiveLyric(line.timeMs);
				});
				this.lyricsLineEls.push(el);
			}
			this.lyricsScrollEl.createDiv({ cls: 'sc-lyrics-padding' });
			// Initial highlight based on current progress.
			this.updateActiveLyric(this.lastState.progressMs);
			return;
		}

		// kind === 'plain' — no timestamps, just dump the text.
		if (plainText) {
			for (const para of plainText.split(/\r?\n/)) {
				this.lyricsScrollEl.createDiv({
					cls: 'sc-lyrics-line sc-lyrics-line-plain',
					text: para || ' ',
				});
			}
		}
	}

	private updateActiveLyric(progressMs: number) {
		const idx = activeLineIndex(this.lyricsData.lines, progressMs);
		if (idx === this.lyricsActiveIdx) return;

		if (this.lyricsActiveIdx >= 0 && this.lyricsLineEls[this.lyricsActiveIdx]) {
			this.lyricsLineEls[this.lyricsActiveIdx].removeClass('is-active');
		}
		this.lyricsActiveIdx = idx;
		if (idx >= 0 && this.lyricsLineEls[idx]) {
			this.lyricsLineEls[idx].addClass('is-active');
			// Only auto-scroll when not in user-scroll grace period.
			if (Date.now() >= this.lyricsAutoScrollUntil) {
				this.lyricsLineEls[idx].scrollIntoView({
					behavior: 'smooth',
					block: 'center',
				});
			}
		}
	}

	/**
	 * Seek relative to the current position. Used by the podcast -15s / +15s
	 * buttons. Clamps to [0, duration] so the API doesn't reject an out-of-
	 * range request. Holds the seek-grace window like the slider does so the
	 * next poll doesn't briefly snap the progress bar back to the pre-seek
	 * position before the local-progress timer catches up.
	 */
	private async seekBy(deltaMs: number) {
		const dur = this.lastState.durationMs;
		if (!dur) return;
		const next = Math.max(0, Math.min(dur, this.lastState.progressMs + deltaMs));
		this.holdSeekGrace();
		await this.callDirect(() => this.plugin.api.seek(next), 'seek');
		this.startLocalProgress(next);
	}

	// ── Slider grace timers ────────────────────────────────────────────────

	private holdSeekGrace() {
		this.seekingActive = true;
		if (this.seekGraceTimer != null) window.clearTimeout(this.seekGraceTimer);
		this.seekGraceTimer = window.setTimeout(() => {
			this.seekingActive = false;
			this.seekGraceTimer = null;
		}, SLIDER_GRACE_MS);
	}

	private holdVolumeGrace() {
		this.volumingActive = true;
		if (this.volumeGraceTimer != null) window.clearTimeout(this.volumeGraceTimer);
		this.volumeGraceTimer = window.setTimeout(() => {
			this.volumingActive = false;
			this.volumeGraceTimer = null;
			this.pendingVolume = null;
		}, PENDING_VOLUME_TIMEOUT_MS);
	}
}

/**
 * Warm the browser's image cache for a URL. When the same URL is later
 * assigned to an <img>.src, it loads from cache with no network latency.
 *
 * Uses a detached Image element — no DOM insertion, just triggers a fetch.
 * `loading="eager"` is the default for Image(); we set decoding="async" so
 * it doesn't block any subsequent rendering work.
 *
 * In-flight dedupe + browser-level caching mean calling this with the same
 * URL multiple times is free.
 */
/**
 * Convert Spotify's `html_description` to plain text with paragraph
 * breaks preserved. Spotify's HTML descriptions use `<p>`, `<br>`, `<a>`,
 * `<em>`, `<strong>` mostly; we strip all tags but turn block-level
 * structure into `\n` characters. The lyrics-panel scroll container uses
 * `white-space: pre-line` to render the `\n`s as actual breaks.
 *
 * Avoids rendering raw HTML (XSS surface) and avoids pulling in a DOM
 * parser — a small regex pipeline is enough since we control the
 * markup vocabulary (it's a known set from Spotify's API).
 *
 * Returns empty string for empty/missing input. The caller falls back to
 * the plain `description` field in that case.
 */
function htmlDescriptionToText(html: string | undefined): string {
	if (!html) return '';
	let s = html
		// Block-level structure → newlines.
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<p[^>]*>/gi, '')
		// Strip every remaining tag.
		.replace(/<[^>]+>/g, '')
		// Decode the handful of HTML entities Spotify actually uses.
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
	// Collapse 3+ consecutive newlines (from nested tags) down to 2.
	s = s.replace(/\n{3,}/g, '\n\n');
	return s.trim();
}

/**
 * Format the metadata row for a podcast episode: "Oct 24, 2025  •  50 min
 * 44 sec left". Either half may be omitted if its source data is missing
 * (no release date, or live/unknown-length stream).
 */
function formatEpisodeMeta(
	releaseDateIso: string,
	progressMs: number,
	durationMs: number,
): string {
	const parts: string[] = [];
	const date = formatReleaseDate(releaseDateIso);
	if (date) parts.push(date);
	const remaining = Math.max(0, durationMs - progressMs);
	if (durationMs > 0) parts.push(`${formatLongDuration(remaining)} left`);
	return parts.join('  •  ');
}

/** ISO date "2025-10-24" → "Oct 24, 2025". Returns the input unchanged
 * (or '' for empty) if it doesn't match the expected shape. */
function formatReleaseDate(iso: string): string {
	if (!iso) return '';
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const month = months[parseInt(m[2], 10) - 1] ?? '';
	const day = parseInt(m[3], 10);
	return `${month} ${day}, ${m[1]}`;
}

/** Verbose-format a duration for the episode metadata row.
 *   3661000 → "1 hr 1 min"
 *    61000  → "1 min 1 sec"
 *     500   → "0 sec"
 * Skips sub-units that are zero. Used for "X left" display where the
 * familiar conversational format is more readable than "61:01". */
function formatLongDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h} hr ${m} min`;
	if (m > 0) return `${m} min ${s} sec`;
	return `${s} sec`;
}

const _preloadedUrls = new Set<string>();
function preloadImage(url: string): void {
	if (_preloadedUrls.has(url)) return;
	_preloadedUrls.add(url);
	// Bounded set so very-long sessions don't slowly grow it forever.
	if (_preloadedUrls.size > 100) {
		const first = _preloadedUrls.values().next().value;
		if (first) _preloadedUrls.delete(first);
	}
	const img = new Image();
	img.decoding = 'async';
	img.src = url;
}

