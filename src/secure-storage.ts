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

import { Notice, Platform } from 'obsidian';
import { isBase64BufferConstructor } from './util';
import type { Base64BufferConstructor } from './util';

interface Base64Serializable {
	toString(): string;
	toString(encoding: 'base64'): string;
}

interface ElectronSafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Base64Serializable;
	decryptString(encrypted: Uint8Array): string;
}

interface EncryptionBackend {
	safeStorage: ElectronSafeStorage;
	buffer: Base64BufferConstructor;
}

type ModuleLoader = (moduleId: string) => unknown;

interface WindowWithModuleLoader extends Window {
	require?: unknown;
}

/**
 * Try to acquire Electron's safeStorage instance. Returns null if not
 * accessible — caller falls back to plaintext.
 */
function getEncryptionBackend(): EncryptionBackend | null {
	if (!Platform.isDesktop) return null;
	try {
		// Modern Obsidian (Electron 28+) exposes electron module via require.
		// safeStorage in renderer was deprecated; some Obsidian builds still
		// expose it via @electron/remote or process.contextIsolated == false.
		// We attempt the most common paths in order.

		const loadModule = getModuleLoader();
		if (!loadModule) return null;

		// Path 1: direct electron export, then its legacy remote export.
		const electron = loadModule('electron');
		let safeStorage = findSafeStorage(electron);

		// Path 2: @electron/remote (community module Obsidian sometimes bundles).
		if (!safeStorage) {
			try {
				safeStorage = findSafeStorage(loadModule('@electron/remote'));
			} catch {
				safeStorage = null;
			}
		}

		const buffer = findBufferConstructor(loadModule('buffer'));
		if (!safeStorage || !buffer || !safeStorage.isEncryptionAvailable()) return null;
		return { safeStorage, buffer };
	} catch {
		return null;
	}
}

function getModuleLoader(): ModuleLoader | null {
	const candidate = (window as WindowWithModuleLoader).require;
	return typeof candidate === 'function' ? candidate as ModuleLoader : null;
}

function findSafeStorage(value: unknown): ElectronSafeStorage | null {
	if (!isRecord(value)) return null;
	if (isSafeStorage(value.safeStorage)) return value.safeStorage;
	if (isRecord(value.remote) && isSafeStorage(value.remote.safeStorage)) {
		return value.remote.safeStorage;
	}
	return isSafeStorage(value) ? value : null;
}

function isSafeStorage(value: unknown): value is ElectronSafeStorage {
	return (
		isRecord(value) &&
		typeof value.isEncryptionAvailable === 'function' &&
		typeof value.encryptString === 'function' &&
		typeof value.decryptString === 'function'
	);
}

function findBufferConstructor(value: unknown): Base64BufferConstructor | null {
	if (!isRecord(value)) return null;
	return isBase64BufferConstructor(value.Buffer) ? value.Buffer : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

let warnedAboutPlaintext = false;

export interface StoredSecret {
	/** Plaintext token data. Present iff encryption is unavailable. */
	plain?: unknown;
	/** Base64-encoded ciphertext. Present iff encryption succeeded. */
	enc?: string;
}

export class SecureStorage {
	private backend: EncryptionBackend | null;
	private available: boolean;

	constructor() {
		this.backend = getEncryptionBackend();
		this.available = this.backend !== null;
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
		if (this.backend) {
			try {
				const cipher = this.backend.safeStorage.encryptString(JSON.stringify(value));
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
		if (stored.enc && this.backend) {
			try {
				const encrypted = this.backend.buffer.from(stored.enc, 'base64');
				const json = this.backend.safeStorage.decryptString(encrypted);
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
