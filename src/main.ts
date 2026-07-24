/**
 * spotify-control plugin entry point.
 *
 * Responsibilities:
 *   - Load + save settings (data.json), with tokens encrypted via OS keychain
 *     when available (else plaintext + warning).
 *   - Hold the SpotifyAuth (PKCE flow + token refresh) and SpotifyDirectApi
 *     (player writes) instances.
 *   - Register the sidebar view, commands, protocol handler, settings tab.
 *
 * Other modules import this class type-only to avoid circular imports.
 */

import {
	App,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	Notice,
	requireApiVersion,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { SpotifyAuth } from './auth';
import { SpotifyDirectApi } from './api';
import { SpotifyView, SPOTIFY_VIEW_TYPE } from './view';
import { registerCommands } from './commands';
import { SecureStorage, StoredSecret } from './secure-storage';
import { LyricsService } from './lyrics';
import { obsidianLyricsFetcher } from './lyrics-fetcher';
import { QueueService } from './queue';
import { makeQueueFetcher } from './queue-fetcher';
import {
	DEFAULT_SETTINGS,
	REDIRECT_URI,
	SpotifyControlSettings,
	SpotifyAccessToken,
} from './types';

/**
 * On-disk shape of plugin data. Differs from in-memory SpotifyControlSettings:
 * tokens are stored encrypted (or plain, if encryption is unavailable) via
 * StoredSecret rather than as a raw object.
 */
interface DiskSettings extends Omit<SpotifyControlSettings, 'tokens'> {
	tokensStored?: StoredSecret;
	/**
	 * Legacy field name: previous versions stored tokens here unencrypted.
	 * Read and migrate on first load, then never written again.
	 */
	tokens?: SpotifyAccessToken | null;
	/** Legacy fields from an earlier in-Obsidian playback SDK experiment;
	 * ignored on load, never written back. Kept here so the destructure
	 * in loadSettings doesn't carry them into the in-memory settings. */
	enableWebPlaybackSdk?: boolean;
	webPlaybackDeviceName?: string;
}

interface AppWithSettingsController extends App {
	setting?: {
		open?: () => void;
		openTabById?: (id: string) => void;
	};
}

const SPOTIFY_SETUP_DESCRIPTION =
	`Spotify Development Mode requires the app owner to have Premium. Create an app, add ${REDIRECT_URI} as its redirect URI, and paste the client ID below. Add any other login account under the app's Users Management page. No client secret is needed because this plugin uses PKCE.`;

export default class SpotifyControlPlugin extends Plugin {
	settings!: SpotifyControlSettings;
	auth!: SpotifyAuth;
	api!: SpotifyDirectApi;
	secure!: SecureStorage;
	lyrics!: LyricsService;
	queue!: QueueService;
	private settingTab: SpotifyControlSettingTab | null = null;

	async onload() {
		this.secure = new SecureStorage();
		await this.loadSettings();

		this.auth = new SpotifyAuth(this);
		this.api = new SpotifyDirectApi(this);
		this.lyrics = new LyricsService(obsidianLyricsFetcher);
		this.queue = new QueueService(makeQueueFetcher(this));

		this.registerView(
			SPOTIFY_VIEW_TYPE,
			(leaf) => new SpotifyView(leaf, this),
		);
		this.addRibbonIcon('play-circle', 'Open Spotify sidebar', () =>
			this.activateView(),
		);

		// OAuth callback handler. Spotify redirects to
		// obsidian://spotify-control/auth?code=…&state=…
		this.registerObsidianProtocolHandler('spotify-control/auth', (params) => {
			this.auth.handleRedirect(params).catch((e) => {
				console.error('[spotify-control] redirect handler failed', e);
				new Notice('Spotify auth callback failed — see console.');
			});
		});

		registerCommands(this);

		this.settingTab = new SpotifyControlSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		await this.auth.restore();
	}

	onunload() {
		this.auth?.onUnload();
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as DiskSettings;
		const {
			tokensStored,
			tokens: legacyTokens,
			enableWebPlaybackSdk: _unused1,
			webPlaybackDeviceName: _unused2,
			...rest
		} = raw;

		let tokens: SpotifyAccessToken | null = null;
		if (tokensStored) {
			tokens = this.secure.unwrap<SpotifyAccessToken>(tokensStored);
		} else if (legacyTokens) {
			tokens = legacyTokens;
		}

		this.settings = { ...DEFAULT_SETTINGS, ...rest, tokens };

		// Persist if we migrated legacy fields, upgraded encryption, OR the
		// stored token failed to decrypt (clear it so re-login can save fresh).
		const needsResave =
			legacyTokens ||
			(tokens && tokensStored === undefined) ||
			this.secure.lastDecryptionFailed;
		if (needsResave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		const { tokens, ...rest } = this.settings;
		const disk: DiskSettings = { ...rest };
		if (tokens) {
			disk.tokensStored = this.secure.wrap(tokens);
		} else {
			disk.tokensStored = undefined;
		}
		// Strip legacy field; we no longer write it.
		disk.tokens = undefined;
		await this.saveData(disk);
	}

	/** Called by SpotifyAuth after login/logout so the view can refresh. */
	onAuthChanged() {
		this.app.workspace
			.getLeavesOfType(SPOTIFY_VIEW_TYPE)
			.forEach((leaf) => (leaf.view as SpotifyView).onAuthChanged?.());
		this.settingTab?.refreshAuthState();
	}

	/** Called from settings tab when a UI-affecting setting changes. */
	notifyViewsSettingsChanged() {
		this.app.workspace
			.getLeavesOfType(SPOTIFY_VIEW_TYPE)
			.forEach((leaf) => (leaf.view as SpotifyView).onSettingsChanged?.());
	}

	/** Open the plugin's settings tab. Used by sidebar buttons. */
	openSettings() {
		// These settings-navigation methods are stable in the desktop app but
		// aren't part of Obsidian's public TypeScript surface.
		try {
			const setting = (this.app as AppWithSettingsController).setting;
			setting?.open?.();
			setting?.openTabById?.('spotify-control');
		} catch (e) {
			console.error('[spotify-control] openSettings failed', e);
			new Notice('Open settings → community plugins → Spotify Control.');
		}
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(SPOTIFY_VIEW_TYPE);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf)
				await leaf.setViewState({ type: SPOTIFY_VIEW_TYPE, active: true });
		}
		if (leaf) workspace.setActiveLeaf(leaf, { focus: true });
	}

	/**
	 * Open the Spotify Web Player according to webPlayerMode setting.
	 *
	 * External browser (default): always works — your browser has Widevine
	 * DRM, so audio plays.
	 * Obsidian web viewer: UI loads in an Obsidian tab, but track playback
	 * fails because Obsidian's Electron build doesn't ship Widevine. The
	 * settings UI warns about this; this command honors the user's choice.
	 */
	async openSpotifyWebPlayer() {
		const url = 'https://open.spotify.com';
		if (this.settings.webPlayerMode === 'obsidian') {
			// Try Obsidian's built-in web viewer core plugin.
			try {
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.setViewState({
					type: 'webviewer',
					state: { url, navigate: true },
					active: true,
				});
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
				new Notice('Opened Spotify in Obsidian (audio playback may not work).');
			} catch (e) {
				console.error('[spotify-control] webviewer failed, falling back', e);
				window.open(url, '_blank', 'noopener,noreferrer');
			}
		} else {
			window.open(url, '_blank', 'noopener,noreferrer');
		}
	}
}

class SpotifyControlSettingTab extends PluginSettingTab {
	plugin: SpotifyControlPlugin;

	constructor(app: App, plugin: SpotifyControlPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	refreshAuthState(): void {
		if (requireApiVersion('1.13.0')) this.update();
	}

	/**
	 * Obsidian 1.13+ renders and indexes these definitions. The imperative
	 * display() method below remains the fallback for Obsidian 1.4–1.12.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Setup',
				desc: SPOTIFY_SETUP_DESCRIPTION,
				render: (setting) => {
					setting
						.setName('Setup')
						.setDesc(SPOTIFY_SETUP_DESCRIPTION)
						.addButton((button) =>
							button
								.setButtonText('Open Spotify dashboard')
								.onClick(() => {
									window.open(
										'https://developer.spotify.com/dashboard',
										'_blank',
										'noopener,noreferrer',
									);
								}),
						);
				},
			},
			{
				name: 'Token storage',
				desc: this.plugin.secure.encryptionAvailable
					? 'Tokens are encrypted with the OS keychain.'
					: 'The OS keychain is unavailable, so tokens are stored in plaintext in data.json.',
			},
			{
				name: 'Mobile preview',
				desc: 'Hover-only controls are disabled, and tokens are stored in plaintext because the OS keychain is unavailable.',
				visible: () => Platform.isMobile,
			},
			{
				name: 'Spotify client ID',
				desc: 'From your Spotify developer dashboard.',
				control: {
					type: 'text',
					key: 'clientId',
					placeholder: 'abcdef1234567890…',
				},
			},
			{
				name: 'Account',
				desc: this.plugin.settings.tokens ? 'Logged in.' : 'Not logged in.',
				render: (setting) => {
					setting
						.setName('Account')
						.setDesc(
							this.plugin.settings.tokens ? 'Logged in.' : 'Not logged in.',
						)
						.addButton((button) =>
							button
								.setButtonText(
									this.plugin.settings.tokens ? 'Re-login' : 'Log in',
								)
								.setCta()
								.onClick(() => this.plugin.auth.beginLogin()),
						)
						.addButton((button) =>
							button.setButtonText('Log out').onClick(async () => {
								await this.plugin.auth.logout();
							}),
						);
				},
			},
			{
				name: 'Reveal controls on album art hover',
				desc: 'When enabled, previous, play, and next appear over the album art on hover. When disabled, they remain in the transport row.',
				visible: () => !Platform.isMobile,
				control: { type: 'toggle', key: 'hoverRevealControls' },
			},
			{
				name: 'Sidebar poll interval',
				desc: 'How often the sidebar asks Spotify for the current state, in milliseconds.',
				control: {
					type: 'number',
					key: 'pollIntervalMs',
					min: 500,
					step: 100,
					validate: (value) =>
						Number.isFinite(value) && value >= 500
							? undefined
							: 'Enter at least 500 milliseconds.',
				},
			},
			{
				type: 'group',
				heading: 'Now playing',
				items: [
					{
						name: 'Insert-now-playing template',
						desc: 'Variables: {{name}}, {{artist}}, {{album}}, {{url}}, {{uri}}, {{lyrics}}, {{lrc}}, {{show}}, and {{publisher}}.',
						control: {
							type: 'textarea',
							key: 'insertTemplate',
							rows: 4,
						},
					},
					{
						name: 'Now-playing note folder',
						desc: 'Missing folders are created automatically. Leave empty for the vault root.',
						control: {
							type: 'text',
							key: 'nowPlayingNoteFolder',
							placeholder: 'Media',
						},
					},
					{
						name: 'Now-playing note filename',
						desc: 'Filename template used for notes and lyrics files.',
						control: {
							type: 'text',
							key: 'nowPlayingNoteNameTemplate',
							placeholder: '{{artist}} - {{name}}',
						},
					},
					{
						name: 'Now-playing note template',
						desc: 'Full Markdown body for newly created notes, with the same variables as the insert template.',
						control: {
							type: 'textarea',
							key: 'nowPlayingNoteTemplate',
							rows: 7,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Lyrics and queue',
				items: [
					{
						name: 'Lyrics insert template',
						desc: 'Variables include {{lyrics}}, raw synchronized {{lrc}}, and all now-playing fields.',
						control: {
							type: 'textarea',
							key: 'lyricsInsertTemplate',
							rows: 4,
						},
					},
					{
						name: 'Lyrics export folder',
						desc: 'Synchronized lyrics are saved as .lrc; plain lyrics fall back to .txt.',
						control: {
							type: 'text',
							key: 'lyricsFolder',
							placeholder: 'Media/Lyrics',
						},
					},
					{
						name: 'Show lyrics button',
						desc: 'Fetches lyrics from LRCLIB and shows the lyrics toggle.',
						control: { type: 'toggle', key: 'enableLyrics' },
					},
					{
						name: 'Lyrics and queue panel position',
						control: {
							type: 'dropdown',
							key: 'lyricsPosition',
							options: {
								below: 'Below art',
								replace: 'Replace album art',
							},
						},
					},
					{
						name: 'Show queue button',
						desc: 'Shows upcoming tracks and lets you skip to one.',
						control: { type: 'toggle', key: 'enableQueue' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Controls on art (experimental)',
				items: [
					{
						name: 'Progress bar on album art',
						desc: 'Shows a clickable progress bar at the bottom of the album art.',
						control: { type: 'toggle', key: 'progressOnArt' },
					},
					{
						name: 'Volume button on album art',
						desc: 'Shows a volume button and popover slider on the album art.',
						control: { type: 'toggle', key: 'volumeOnArt' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Spotify web player',
				items: [
					{
						name: 'Open in',
						desc: 'The external browser is recommended because Obsidian does not include the Widevine module Spotify needs for audio playback.',
						control: {
							type: 'dropdown',
							key: 'webPlayerMode',
							options: {
								external: 'External browser (recommended)',
								obsidian: 'Obsidian tab (UI only, no audio)',
							},
						},
					},
					{
						name: 'Open Spotify web player',
						action: () => {
							this.plugin.openSpotifyWebPlayer().catch((error: unknown) => {
								console.error(
									'[spotify-control] open web player failed',
									error,
								);
							});
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case 'clientId': return this.plugin.settings.clientId;
			case 'pollIntervalMs': return this.plugin.settings.pollIntervalMs;
			case 'insertTemplate': return this.plugin.settings.insertTemplate;
			case 'nowPlayingNoteFolder': return this.plugin.settings.nowPlayingNoteFolder;
			case 'nowPlayingNoteNameTemplate':
				return this.plugin.settings.nowPlayingNoteNameTemplate;
			case 'nowPlayingNoteTemplate': return this.plugin.settings.nowPlayingNoteTemplate;
			case 'lyricsInsertTemplate': return this.plugin.settings.lyricsInsertTemplate;
			case 'lyricsFolder': return this.plugin.settings.lyricsFolder;
			case 'hoverRevealControls': return this.plugin.settings.hoverRevealControls;
			case 'enableLyrics': return this.plugin.settings.enableLyrics;
			case 'lyricsPosition': return this.plugin.settings.lyricsPosition;
			case 'enableQueue': return this.plugin.settings.enableQueue;
			case 'progressOnArt': return this.plugin.settings.progressOnArt;
			case 'volumeOnArt': return this.plugin.settings.volumeOnArt;
			case 'webPlayerMode': return this.plugin.settings.webPlayerMode;
			default: return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		let refreshViews = false;
		switch (key) {
			case 'clientId':
				if (typeof value !== 'string') return;
				this.plugin.settings.clientId = value.trim();
				break;
			case 'pollIntervalMs':
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 500) {
					return;
				}
				this.plugin.settings.pollIntervalMs = value;
				break;
			case 'insertTemplate':
			case 'nowPlayingNoteFolder':
			case 'nowPlayingNoteNameTemplate':
			case 'nowPlayingNoteTemplate':
			case 'lyricsInsertTemplate':
			case 'lyricsFolder':
				if (typeof value !== 'string') return;
				this.plugin.settings[key] = value;
				break;
			case 'hoverRevealControls':
			case 'progressOnArt':
			case 'volumeOnArt':
				if (typeof value !== 'boolean') return;
				this.plugin.settings[key] = value;
				refreshViews = true;
				break;
			case 'enableLyrics':
				if (typeof value !== 'boolean') return;
				this.plugin.settings.enableLyrics = value;
				refreshViews = true;
				if (!value) this.plugin.lyrics.clear();
				break;
			case 'lyricsPosition':
				if (value !== 'replace' && value !== 'below') return;
				this.plugin.settings.lyricsPosition = value;
				refreshViews = true;
				break;
			case 'enableQueue':
				if (typeof value !== 'boolean') return;
				this.plugin.settings.enableQueue = value;
				refreshViews = true;
				if (!value) this.plugin.queue.clear();
				break;
			case 'webPlayerMode':
				if (value !== 'external' && value !== 'obsidian') return;
				this.plugin.settings.webPlayerMode = value;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (refreshViews) this.plugin.notifyViewsSettingsChanged();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderSetupHelp(containerEl);

		// Mobile is best-effort: the architecture is cross-platform but the
		// plugin is primarily developed against desktop. Tell mobile users
		// up front so they know to file issues if anything misbehaves.
		if (Platform.isMobile) {
			const mobileEl = containerEl.createDiv({ cls: 'setting-item-description' });
			mobileEl.createEl('strong', { text: 'Mobile (preview): ' });
			mobileEl.createSpan({
				text:
					'hover-only controls are disabled (no touch hover) and tokens are stored in plaintext (no OS keychain). ' +
					'Please report any auth or layout issues on GitHub.',
			});
		}

		// Encryption status indicator
		const securityEl = containerEl.createDiv({ cls: 'setting-item-description' });
		const secLine = securityEl.createDiv();
		if (this.plugin.secure.encryptionAvailable) {
			secLine.createSpan({ text: '🔒 Tokens encrypted via OS keychain.' });
		} else {
			secLine.createSpan({
				text: '⚠️ OS keychain unavailable — tokens stored in plaintext in data.json. ',
			});
			const link = secLine.createEl('a', {
				text: 'Why?',
				href: 'https://github.com/caezium/obsidian-spotify-control#token-storage',
			});
			link.target = '_blank';
			link.rel = 'noopener';
		}

		// ── Client ID ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Spotify client ID')
			.setDesc('From your Spotify developer dashboard.')
			.addText((t) =>
				t
					.setPlaceholder('abcdef1234567890…')
					.setValue(this.plugin.settings.clientId)
					.onChange(async (v) => {
						this.plugin.settings.clientId = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		// ── Auth status + buttons ─────────────────────────────────────
		const authedEl = containerEl.createDiv();
		const refreshAuthStatus = () => {
			authedEl.empty();
			const tokens = this.plugin.settings.tokens;
			new Setting(authedEl)
				.setName('Account')
				.setDesc(tokens ? 'Logged in.' : 'Not logged in.')
				.addButton((b) =>
					b
						.setButtonText(tokens ? 'Re-login' : 'Log in')
						.setCta()
						.onClick(() => this.plugin.auth.beginLogin()),
				)
				.addButton((b) =>
					b.setButtonText('Log out').onClick(async () => {
						await this.plugin.auth.logout();
						refreshAuthStatus();
					}),
				);
		};
		refreshAuthStatus();

		// ── Hover-reveal controls ─────────────────────────────────────
		// Hover-reveal is meaningless on touch screens — the overlay would
		// be unreachable. Hide the setting on mobile entirely; the view also
		// force-falls-back to the always-visible transport row there.
		if (!Platform.isMobile) {
			new Setting(containerEl)
				.setName('Reveal controls on album art hover')
				.setDesc(
					'When on, prev/play/next appear as a floating overlay when you hover the album art, and the duplicate transport buttons below the art are hidden. When off, those controls stay always-visible in the transport row.',
				)
				.addToggle((t) =>
					t.setValue(this.plugin.settings.hoverRevealControls).onChange(async (v) => {
						this.plugin.settings.hoverRevealControls = v;
						await this.plugin.saveSettings();
						this.plugin.notifyViewsSettingsChanged();
					}),
				);
		}

		// ── Polling interval ──────────────────────────────────────────
		new Setting(containerEl)
			.setName('Sidebar poll interval (ms)')
			.setDesc(
				'How often the sidebar asks Spotify for current state. Lower = snappier, higher = fewer API calls. A value of 3000 is a good default.',
			)
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.pollIntervalMs))
					.onChange(async (v) => {
						const n = Number(v);
						if (!Number.isFinite(n) || n < 500) return;
						this.plugin.settings.pollIntervalMs = n;
						await this.plugin.saveSettings();
					}),
			);

		// ── Insert template ───────────────────────────────────────────
		new Setting(containerEl)
			.setName('Insert-now-playing template')
			.setDesc(
				'Template for the "Insert now-playing into note" command. Variables: {{name}} {{artist}} {{album}} {{url}} {{uri}} {{lyrics}} {{lrc}}. For podcasts: {{show}} {{publisher}} are also available; {{artist}} falls back to the show name and {{album}} to the publisher.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.addClass('sc-settings-textarea');
				t.setValue(this.plugin.settings.insertTemplate).onChange(async (v) => {
					this.plugin.settings.insertTemplate = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Now-playing note folder')
			.setDesc(
				'Destination for notes created from now playing. Missing folders are created automatically. Leave empty for the vault root.',
			)
			.addText((t) =>
				t
					.setPlaceholder('Media')
					.setValue(this.plugin.settings.nowPlayingNoteFolder)
					.onChange(async (v) => {
						this.plugin.settings.nowPlayingNoteFolder = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Now-playing note filename')
			.setDesc(
				'Filename template used for song notes and lyrics files. Variables: {{name}} {{artist}} {{album}} {{show}} {{publisher}} {{url}} {{uri}}.',
			)
			.addText((t) =>
				t
					.setPlaceholder('{{artist}} - {{name}}')
					.setValue(this.plugin.settings.nowPlayingNoteNameTemplate)
					.onChange(async (v) => {
						this.plugin.settings.nowPlayingNoteNameTemplate = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Now-playing note template')
			.setDesc(
				'Full Markdown body for newly created song notes. Uses the same variables as the insert template, including {{lyrics}} and {{lrc}}.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 7;
				t.inputEl.addClass('sc-settings-textarea');
				t.setValue(this.plugin.settings.nowPlayingNoteTemplate).onChange(async (v) => {
					this.plugin.settings.nowPlayingNoteTemplate = v;
					await this.plugin.saveSettings();
				});
			});

		// ── Lyrics ────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Lyrics insert template')
			.setDesc(
				'Template used by "Insert now-playing lyrics into note". Variables include {{lyrics}}, raw synchronized {{lrc}}, and all now-playing fields.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.addClass('sc-settings-textarea');
				t.setValue(this.plugin.settings.lyricsInsertTemplate).onChange(async (v) => {
					this.plugin.settings.lyricsInsertTemplate = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Lyrics export folder')
			.setDesc(
				'Destination for saved now-playing lyrics. Synced lyrics use .lrc; plain lyrics fall back to .txt.',
			)
			.addText((t) =>
				t
					.setPlaceholder('Media/Lyrics')
					.setValue(this.plugin.settings.lyricsFolder)
					.onChange(async (v) => {
						this.plugin.settings.lyricsFolder = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show lyrics button')
			.setDesc(
				'Enables a lyrics toggle on the album art (hover to reveal). Lyrics fetched from lrclib.net (free, no account, community-driven LRC database). When off, the toggle is hidden.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableLyrics).onChange(async (v) => {
					this.plugin.settings.enableLyrics = v;
					await this.plugin.saveSettings();
					this.plugin.notifyViewsSettingsChanged();
					if (!v) this.plugin.lyrics.clear();
				}),
			);

		new Setting(containerEl)
			.setName('Lyrics + queue panel position')
			.setDesc(
				'Below art (recommended): panel appears between the album art and the controls, filling remaining sidebar height. Replace art: panel takes over the art square (compact).',
			)
			.addDropdown((d) =>
				d
					.addOption('below', 'Below art')
					.addOption('replace', 'Replace album art')
					.setValue(this.plugin.settings.lyricsPosition)
					.onChange(async (v) => {
						this.plugin.settings.lyricsPosition = v as 'replace' | 'below';
						await this.plugin.saveSettings();
						this.plugin.notifyViewsSettingsChanged();
					}),
			);

		new Setting(containerEl)
			.setName('Show queue button')
			.setDesc(
				'Adds a queue toggle (next to lyrics) that shows upcoming tracks. Click a track to skip to it. Off hides the toggle.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableQueue).onChange(async (v) => {
					this.plugin.settings.enableQueue = v;
					await this.plugin.saveSettings();
					this.plugin.notifyViewsSettingsChanged();
					if (!v) this.plugin.queue.clear();
				}),
			);

		// ── Controls on art ───────────────────────────────────────────
		new Setting(containerEl)
			.setName('Controls on art (experimental)')
			.setHeading();
		containerEl.createDiv({
			cls: 'setting-item-description',
			text:
				'Move progress + volume directly onto the album art for a more compact, Apple-Music-style layout. When on, the corresponding separate row below the art is hidden.',
		});

		new Setting(containerEl)
			.setName('Progress bar on album art')
			.setDesc(
				'Thin progress bar along the bottom edge of the album art. Click to seek. Hides the separate seek row.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.progressOnArt).onChange(async (v) => {
					this.plugin.settings.progressOnArt = v;
					await this.plugin.saveSettings();
					this.plugin.notifyViewsSettingsChanged();
				}),
			);

		new Setting(containerEl)
			.setName('Volume button on album art')
			.setDesc(
				'Speaker button at the bottom-right corner of the album art. Click to reveal a vertical slider that floats above. Hides the separate volume row.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.volumeOnArt).onChange(async (v) => {
					this.plugin.settings.volumeOnArt = v;
					await this.plugin.saveSettings();
					this.plugin.notifyViewsSettingsChanged();
				}),
			);

		// ── Spotify Web Player ────────────────────────────────────────
		new Setting(containerEl).setName('Spotify web player').setHeading();
		const webPlayerNote = containerEl.createDiv({ cls: 'setting-item-description' });
		webPlayerNote.appendText(
			'The "Open Spotify web player" command opens open.spotify.com. ',
		);
		webPlayerNote.createEl('strong', { text: 'External browser is recommended' });
		webPlayerNote.appendText(
			' — it has the Widevine DRM module that Spotify needs to play audio. Opening inside Obsidian shows the UI but track playback will fail with the same Widevine error.',
		);

		new Setting(containerEl)
			.setName('Open in')
			.addDropdown((d) =>
				d
					.addOption('external', 'External browser (recommended)')
					.addOption('obsidian', 'Obsidian tab (UI only, no audio)')
					.setValue(this.plugin.settings.webPlayerMode)
					.onChange(async (v) => {
						this.plugin.settings.webPlayerMode = v as 'external' | 'obsidian';
						await this.plugin.saveSettings();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText('Open now')
					.onClick(() => this.plugin.openSpotifyWebPlayer()),
			);

	}

	private renderSetupHelp(parent: HTMLElement) {
		const help = parent.createDiv({ cls: 'setting-item-description' });
		help.createEl('p').createEl('strong', { text: 'Setup:' });
		const ol = help.createEl('ol');

		const li1 = ol.createEl('li');
		li1.appendText('Go to ');
		const link = li1.createEl('a', {
			text: 'developer.spotify.com/dashboard',
			href: 'https://developer.spotify.com/dashboard',
		});
		link.target = '_blank';
		link.rel = 'noopener,noreferrer';
		li1.appendText(
			' and create an app. Spotify requires the app owner to have an active Premium subscription.',
		);

		const li2 = ol.createEl('li');
		li2.appendText("In the app's settings, add this ");
		li2.createEl('strong', { text: 'Redirect URI' });
		li2.appendText(': ');
		li2.createEl('code', { text: REDIRECT_URI });

		const li3 = ol.createEl('li');
		li3.appendText('Copy the ');
		li3.createEl('strong', { text: 'Client ID' });
		li3.appendText(' below. ');
		li3.createEl('em', { text: 'No client secret needed' });
		li3.appendText(' — this plugin uses PKCE.');

		const li4 = ol.createEl('li');
		li4.appendText(
			"If you'll log in with a different Spotify account, add its name and Spotify email under the app's ",
		);
		li4.createEl('strong', { text: 'Settings → users management' });
		li4.appendText('. Development Mode allows up to five authorized users.');

		ol.createEl('li', {
			text: "Click log in. Your browser will open Spotify's authorization page. If Spotify asks for a one-time code, use the delivery method named on that page; the plugin doesn't generate it.",
		});
		ol.createEl('li', {
			text: "After approving, you'll be redirected back into Obsidian. A successful login followed by 403 errors usually means the account isn't in users management.",
		});
	}

}
