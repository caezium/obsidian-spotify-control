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
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	Notice,
} from 'obsidian';
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

export default class SpotifyControlPlugin extends Plugin {
	settings!: SpotifyControlSettings;
	auth!: SpotifyAuth;
	api!: SpotifyDirectApi;
	secure!: SecureStorage;
	lyrics!: LyricsService;
	queue!: QueueService;
	/**
	 * Spotify account tier. Set by auth.detectPremiumTier() shortly after
	 * connection. Used by api.ts to distinguish "Free user can't do this"
	 * from transient "Restriction violated" — so Free users get a clear
	 * message instead of silence.
	 *
	 * Defaults to `true` (optimistic) to avoid false "Premium required"
	 * warnings before the /me probe completes. Flipped to false only if
	 * the probe explicitly returns product: "free" or "open".
	 */
	isPremium = true;

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

		this.addSettingTab(new SpotifyControlSettingTab(this.app, this));

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
		(disk as DiskSettings).tokens = undefined;
		await this.saveData(disk);
	}

	/** Called by SpotifyAuth after login/logout so the view can refresh. */
	onAuthChanged() {
		this.app.workspace
			.getLeavesOfType(SPOTIFY_VIEW_TYPE)
			.forEach((leaf) => (leaf.view as SpotifyView).onAuthChanged?.());
	}

	/** Called from settings tab when a UI-affecting setting changes. */
	notifyViewsSettingsChanged() {
		this.app.workspace
			.getLeavesOfType(SPOTIFY_VIEW_TYPE)
			.forEach((leaf) => (leaf.view as SpotifyView).onSettingsChanged?.());
	}

	/** Open the plugin's settings tab. Used by sidebar buttons. */
	openSettings() {
		// Cast to any: openTab + the internal setting tab navigation are not in
		// the public typings. Falls back to a Notice if the APIs change.
		try {
			const setting = (this.app as any).setting;
			setting.open?.();
			setting.openTabById?.('spotify-control');
		} catch (e) {
			console.error('[spotify-control] openSettings failed', e);
			new Notice('Open Settings → Community plugins → Spotify Control.');
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
		if (leaf) workspace.revealLeaf(leaf);
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
				} as any);
				this.app.workspace.revealLeaf(leaf);
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Spotify Control' });

		this.renderSetupHelp(containerEl);

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
			.setName('Spotify Client ID')
			.setDesc('From your Spotify Developer Dashboard.')
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

		// ── Polling interval ──────────────────────────────────────────
		new Setting(containerEl)
			.setName('Sidebar poll interval (ms)')
			.setDesc(
				'How often the sidebar asks Spotify for current state. Lower = snappier, higher = fewer API calls. 3000 is a good default.',
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
				'Template for the "Insert now-playing into note" command. Variables: {{name}} {{artist}} {{album}} {{url}} {{uri}}',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.style.width = '100%';
				t.setValue(this.plugin.settings.insertTemplate).onChange(async (v) => {
					this.plugin.settings.insertTemplate = v;
					await this.plugin.saveSettings();
				});
			});

		// ── Lyrics ────────────────────────────────────────────────────
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
		containerEl.createEl('h3', { text: 'Controls on art (experimental)' });
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
		containerEl.createEl('h3', { text: 'Spotify Web Player' });
		const webPlayerNote = containerEl.createDiv({ cls: 'setting-item-description' });
		webPlayerNote.appendText(
			'The "Open Spotify Web Player" command opens open.spotify.com. ',
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
		li1.appendText(' and create an app.');

		const li2 = ol.createEl('li');
		li2.appendText("In the app's settings, add this ");
		li2.createEl('strong', { text: 'Redirect URI' });
		li2.appendText(': ');
		li2.createEl('code', { text: REDIRECT_URI });

		const li3 = ol.createEl('li');
		li3.appendText('Copy the ');
		li3.createEl('strong', { text: 'Client ID' });
		li3.appendText(' below. ');
		li3.createEl('em', { text: 'No Client Secret needed' });
		li3.appendText(' — this plugin uses PKCE.');

		ol.createEl('li', {
			text: "Click Log in. Your browser will open Spotify's auth page.",
		});
		ol.createEl('li', {
			text: "After approving, you'll be redirected back into Obsidian.",
		});
	}

}
