/**
 * Best-effort encryption-at-rest for OAuth tokens.
 *
 * Threat model honestly stated:
 *   - We can defend against another Obsidian plugin reading data.json with a
 *     casual fs.read. That's the realistic threat.
 *   - We CANNOT defend against malware running as your user (the same context
 *     that decrypts), or against you syncing data.json to an attacker.
 *   - Filesystem encryption (FileVault, etc.) is still the only real defense
 *     for data at rest.
 *
 * Implementation:
 *   - Try Electron's `safeStorage` API. On macOS this uses Keychain; on Linux
 *     it uses kwallet/gnome-keyring (or a fixed key if unavailable); on Windows
 *     it uses DPAPI. All keyed to the current OS user.
 *   - safeStorage exists in the main process. Renderer access depends on
 *     Electron version + how Obsidian wires it up. We try several paths and
 *     fall back gracefully.
 *   - On failure: store as plaintext, flag it in the saved data, surface a
 *     one-time Notice so the user knows.
 *
 * Data shape:
 *   { tokens?: <plaintext token object>, tokensEnc?: <base64-encrypted string> }
 *   Exactly one of the two is present at any time.
 */

import { Notice } from 'obsidian';

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

/**
 * Try to acquire Electron's safeStorage instance. Returns null if not
 * accessible — caller falls back to plaintext.
 */
function getSafeStorage(): SafeStorage | null {
	try {
		// Modern Obsidian (Electron 28+) exposes electron module via require.
		// safeStorage in renderer was deprecated; some Obsidian builds still
		// expose it via @electron/remote or process.contextIsolated == false.
		// We attempt the most common paths in order.

		// Path 1: direct require('electron') — works when nodeIntegration is on
		// (Obsidian plugins run with full Node integration).
		const electron = (globalThis as any).require?.('electron');
		if (electron?.safeStorage?.isEncryptionAvailable) {
			return electron.safeStorage as SafeStorage;
		}
		if (electron?.remote?.safeStorage?.isEncryptionAvailable) {
			return electron.remote.safeStorage as SafeStorage;
		}

		// Path 2: @electron/remote (community module Obsidian sometimes bundles)
		try {
			const remote = (globalThis as any).require?.('@electron/remote');
			if (remote?.safeStorage?.isEncryptionAvailable) {
				return remote.safeStorage as SafeStorage;
			}
		} catch {
			/* not bundled */
		}

		return null;
	} catch {
		return null;
	}
}

let warnedAboutPlaintext = false;

export interface StoredSecret {
	/** Plaintext token data. Present iff encryption is unavailable. */
	plain?: unknown;
	/** Base64-encoded ciphertext. Present iff encryption succeeded. */
	enc?: string;
}

export class SecureStorage {
	private safeStorage: SafeStorage | null;
	private available: boolean;

	constructor() {
		this.safeStorage = getSafeStorage();
		this.available = !!this.safeStorage?.isEncryptionAvailable?.();
	}

	/** True iff tokens will be encrypted at rest. */
	get encryptionAvailable(): boolean {
		return this.available;
	}

	/**
	 * Wrap a JSON-serializable value into a StoredSecret. Caller writes the
	 * returned object into the plugin's data.json (it has either `plain` or
	 * `enc`, never both).
	 */
	wrap(value: unknown): StoredSecret {
		if (this.available && this.safeStorage) {
			try {
				const cipher = this.safeStorage.encryptString(JSON.stringify(value));
				return { enc: cipher.toString('base64') };
			} catch (e) {
				console.error('[spotify-control] encrypt failed, falling back', e);
			}
		}
		if (!warnedAboutPlaintext) {
			warnedAboutPlaintext = true;
			new Notice(
				'Spotify Control: OS keychain unavailable; tokens stored in plaintext. ' +
					'See plugin README for security implications.',
				10_000,
			);
		}
		return { plain: value };
	}

	/**
	 * Unwrap a StoredSecret. Returns the value, or null if neither plain nor
	 * enc is present (or decryption fails).
	 *
	 * On decryption failure (likely because the user changed OS keychain or
	 * moved the vault to a new machine), surface a Notice so the user knows
	 * they need to re-login — otherwise they just see "Not logged in" with
	 * no explanation.
	 *
	 * Sets `lastDecryptionFailed` on the instance so callers (loadSettings)
	 * can clear the corrupted stored token instead of letting it linger.
	 */
	lastDecryptionFailed = false;

	unwrap<T = unknown>(stored: StoredSecret | null | undefined): T | null {
		if (!stored) return null;
		if (stored.enc && this.safeStorage) {
			try {
				const buf = Buffer.from(stored.enc, 'base64');
				const json = this.safeStorage.decryptString(buf);
				this.lastDecryptionFailed = false;
				return JSON.parse(json) as T;
			} catch (e) {
				console.error(
					'[spotify-control] decrypt failed — token unusable',
					e,
				);
				this.lastDecryptionFailed = true;
				new Notice(
					'Spotify Control: stored tokens could not be decrypted (OS keychain may have changed). Please log in again.',
					12_000,
				);
				return null;
			}
		}
		if (stored.plain !== undefined) {
			this.lastDecryptionFailed = false;
			return stored.plain as T;
		}
		return null;
	}
}
