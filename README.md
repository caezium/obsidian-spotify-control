# Spotify Control

<img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22spotify-control%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=for-the-badge" alt="Obsidian Downloads">

Control Spotify from inside Obsidian. A now-playing sidebar with hover-revealed transport, time-synced lyrics, upcoming-tracks queue, search palette, hotkey-bindable transport commands, and track/lyrics capture for your vault.

Spotify Development Mode now requires the developer-app owner to have an active **Spotify Premium** subscription. Playback control also requires Premium. A Free account can use display and capture features only when it has been allowlisted on somebody else's Premium-owned development app; Spotify limits each development app to five authorized users.

<table align="center">
  <tr>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/6315d743-45a4-417a-8060-62b7a0f2d8b2" width="200" />
    </td>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/253f364e-3d9d-4670-915c-a46d4d8e398a" width="200" />
    </td>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/f607ef41-9e95-49d4-a95d-69c261dc6d9e" width="200" />
    </td>
  </tr>
  <tr>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/8113ba07-d020-41ba-bf04-d597db040f4e" width="200" />
    </td>
    <td colspan="2" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/0d9f8fb2-8261-46f4-a8a4-e7f725c1b67f" width="500" />
    </td>
  </tr>
  <tr> 
    <td colspan="2" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/45523254-552e-420e-9482-e81ee66ab6dd" width="600" />
    </td>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/5fc06332-1604-47df-8e07-5e6d467d549b" width="200" />
    </td>
  </tr>
  <tr> 
    <td colspan="2" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/eacf5b3f-4b14-4d0b-b85a-ee75e91889e9" width="600" />
    </td>
    <td width="33%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/9d469f5d-1d8b-4b84-bfec-07280ef4a8f3" width="200" />
    </td>
  </tr>
</table>


## Features

**Now-playing sidebar.** Album art (with optional hover overlay for prev/play/next/shuffle/repeat), large track title, artist, album, seek bar, volume, custom device picker. Polls Spotify every 3s (configurable). Pauses polling when the Obsidian window is hidden.

**Time-synced lyrics.** Toggle a lyrics panel from a corner button on the album art. Lyrics come from [LRCLIB](https://lrclib.net) — free, no account, community-maintained LRC database. The active line is highlighted and auto-scrolls; click any line to seek to that timestamp. Falls back to plain-text lyrics when no synced version exists. Prefetched on every track change so the panel opens instantly.

**Upcoming-tracks queue.** Toggle button next to lyrics. Each row shows thumbnail + title + artist + duration. Click any track to jump to it — playback stays inside the current playlist/album context so the queue keeps rolling. Pre-loaded album art means scrolling is instant.

**Search palette.** Command-palette-style modal for searching tracks, albums, and playlists. Track results prompt "Play now" or "Add to queue."

**Capture tracks as notes.** Insert the current track into an active editor, including editors opened by QuickAdd or Commander macros, or create/reopen a dedicated song note in a configurable folder. The filename and note body are templated; variables are `{{name}} {{artist}} {{album}} {{url}} {{uri}} {{lyrics}} {{lrc}}`, plus `{{show}}` and `{{publisher}}` for podcasts.

**Capture lyrics.** Insert lyrics into the active note with a configurable template, copy them to the clipboard, or save them in the vault. The original synchronized LRCLIB payload is saved as `.lrc`; tracks with plain lyrics only fall back to `.txt`.

**Play any Spotify URI under cursor.** Bindable command — works on `spotify:track:abc` URIs and `https://open.spotify.com/...` URLs (including `?si=` share tokens and `intl-XX/` locale prefixes).

**Open Spotify Web Player.** Command/setting to open `open.spotify.com` either in your external browser (audio works) or in an Obsidian tab (UI only — Obsidian's Electron build doesn't bundle Widevine DRM).

## Podcast support

When a Spotify podcast episode is playing the sidebar adapts:

- Title → episode name; "artist" row → show name; "album" row → release date + remaining time (e.g., `Oct 24, 2025  •  50 min 44 sec left`).
- Album art uses the episode image (falls back to show art).
- Transport row reveals **−15s** and **+15s** seek buttons around prev/play/next.
- Lyrics panel auto-opens with the episode description ("show notes") on each new episode. Click the lyrics toggle to close — it stays closed for the rest of that episode.
- Search finds podcasts and individual episodes; insert-into-note has `{{show}}` and `{{publisher}}` template variables.

**Not available** (Spotify Web API limitations, not a plugin design choice): transcripts, auto-generated chapters, variable playback speed (1×/1.5×/2×), and sleep timer. These are exposed only by Spotify's own clients via private endpoints we don't have access to. If you find yourself wanting them, use the Spotify app for the listening session itself; the sidebar still shows what's playing.

## Mobile (preview)

The plugin runs on Obsidian mobile (iOS + Android) with `isDesktopOnly: false`. It's tagged "preview" rather than full support because the development cycle is primarily desktop and not every interaction has been validated on a phone. Known differences from desktop:

- **Hover-reveal controls are hidden in settings** and force-off in the sidebar. Touch screens have no hover, so the on-art overlay would be unreachable. The always-visible transport row carries the controls instead.
- **Tokens are stored in plaintext** in `data.json`. Desktop uses Electron's `safeStorage` (OS keychain on macOS, libsecret on Linux, DPAPI on Windows), which doesn't exist on mobile. The plugin warns about this on first load and on the settings screen.
- **OAuth flow** goes through Obsidian's `obsidian://spotify-control/auth` protocol handler, same as desktop — your phone's default browser opens Spotify's auth page, you approve, the redirect bounces back into Obsidian.

If anything misbehaves on mobile (layout, auth callback, missing UI elements), please file an issue with your phone model + Obsidian version.

## Setup (one-time)

1. Sign in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) with the Premium account that will own the app, then create an app. Select **Web API** if Spotify asks which APIs you plan to use.
2. In the app settings, add this exact **Redirect URI**:

   ```
   obsidian://spotify-control/auth
   ```

3. Copy the **Client ID** from your app's main page. **No Client Secret needed** — this plugin uses PKCE.
4. If you will connect a Spotify account other than the app owner, open the app's **Settings → Users Management** page and add that account's name and Spotify email. Development Mode allows up to five authorized users.
5. In Obsidian → Settings → Community plugins, enable **Spotify Control**.
6. Open the Spotify Control settings tab, paste the Client ID, and click **Log in**. Your browser will open Spotify's authorization page; after approving, it redirects to `obsidian://spotify-control/auth` and back into Obsidian.

The first time you control playback after starting cold, the plugin auto-transfers playback to the first available device (so you don't need to manually pick one).

### Stuck on the OTP or verification page?

The plugin does not generate, receive, or validate an OTP. That page belongs to Spotify account authentication, so first verify that the address is on `accounts.spotify.com`, then use the delivery method Spotify names on the page. If Spotify offers another verification or account-recovery method, use that; if it rate-limits more attempts, wait for the cooldown it shows. Never post the code in an issue or screenshot.

If the code is accepted but Spotify Control still does not connect:

- A successful browser login followed by Spotify `403` responses usually means the exact account is not listed under the app's **Settings → Users Management** page.
- If the browser never returns to Obsidian, confirm the redirect URI is exactly `obsidian://spotify-control/auth`, allow the browser to open Obsidian, then click **Log in** again. The callback must finish while that login attempt is still pending.
- If Spotify reports that the app is unavailable or the dashboard will not let you create it, confirm that the app owner still has an active Premium subscription.
- If Spotify Control asks you to reconnect after months of working normally, log in again. Spotify refresh tokens now expire after six months, and the plugin clears the expired token instead of retrying forever.
- A `429` with `QUOTA_EXCEEDED` is Spotify's shared Development Mode quota, not a bad OTP. Close duplicate Spotify sidebars or increase the poll interval, then try again later.

If these steps do not match the page you see, open an issue with the page URL, Obsidian version, platform, and exact error text — with all codes, tokens, emails, and Client IDs redacted.

## Current Spotify Development Mode limits

- The app owner needs active Premium, and each client ID can authorize at most five users.
- Spotify allows up to 25 client IDs per developer account, but all of those apps now share one Development Mode quota.
- Refresh tokens expire after six months. Spotify Control already treats the resulting `invalid_grant` as a clean re-login instead of a permanent refresh loop.
- Spotify still supports PKCE and custom redirect schemes such as this plugin's `obsidian://` callback, so no Client Secret or localhost callback is needed.
- Spotify reduced search responses to at most 10 items per type. Spotify Control requests five and clamps future requests to the supported range.

Spotify documents these changes in its [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [June refresh-token update](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration), and [July quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).

## Commands (hotkey-bindable in Settings → Hotkeys)

- Open Spotify sidebar
- Open Spotify Web Player
- Play / pause
- Next track / Previous track
- Volume up (+10%) / Volume down (−10%)
- Toggle shuffle
- Toggle lyrics view
- Search Spotify…
- Play Spotify URI/URL under cursor
- Insert now-playing into note
- Create note from now playing
- Insert now-playing lyrics into note
- Copy now-playing lyrics
- Save now-playing lyrics file

## Settings

| Setting | What |
|---|---|
| **Spotify Client ID** | From your Spotify Developer Dashboard |
| **Account** | Log in / Re-login / Log out |
| **Reveal controls on album art hover** | When on, prev/play/next/shuffle/repeat live as a hover overlay on the art. When off, they sit in a permanent transport row below the art. |
| **Show lyrics button** | Enables the lyrics toggle. Default on. |
| **Show queue button** | Enables the queue toggle. Default on. |
| **Lyrics + queue panel position** | "Below art" (default — panel slots between art and controls) or "Replace album art" (panel covers the art square) |
| **Progress bar on album art** | Thin progress line along the bottom edge of the art, clickable to seek. Hides the separate seek row. Default off. |
| **Volume button on album art** | Speaker button at the bottom-right of the art with a popover slider. Hides the separate volume row. Default off. |
| **Sidebar poll interval (ms)** | How often to refresh playback state. Default 3000. |
| **Insert-now-playing template** | Template for inserting track metadata into the active note |
| **Now-playing note folder** | Destination for song notes; missing folders are created automatically |
| **Now-playing note filename** | Filename template shared by song notes and exported lyrics |
| **Now-playing note template** | Full Markdown body used when creating a song note |
| **Lyrics insert template** | Template for inserting lyrics into the active note |
| **Lyrics export folder** | Destination for `.lrc` and plain-text lyrics files |
| **Spotify Web Player → Open in** | External browser (recommended) or Obsidian tab (UI only) |

## Architecture

```
src/
├── main.ts              Plugin entry, settings tab, lifecycle
├── auth.ts              PKCE OAuth + token refresh (deduped + backoff retry)
├── api.ts               Direct requestUrl wrapper for Spotify Web API
├── view.ts              Now-playing sidebar (ItemView)
├── search.ts            Spotify search modal (SuggestModal)
├── commands.ts          Transport and navigation commands
├── capture-commands.ts  Note, clipboard, and lyrics-file commands
├── capture.ts           Pure note paths, metadata templates, and lyrics export
├── lyrics.ts            LRC parsing + LyricsService (pure, no Obsidian deps)
├── lyrics-fetcher.ts    Obsidian requestUrl bridge for LyricsService
├── queue.ts             Queue snapshot + cache (pure)
├── queue-fetcher.ts     Obsidian requestUrl bridge for QueueService
├── secure-storage.ts    OAuth tokens via Electron safeStorage, plaintext fallback
├── util.ts              Pure helpers (formatTime, parseSpotifyResource, PKCE primitives, template)
└── types.ts             Settings shape + scopes + redirect URI

tests/
├── capture.test.ts      Now-playing metadata, paths, and lyrics export
├── lyrics.test.ts       LRC parsing + LyricsService
├── queue.test.ts        Queue snapshot normalization and cache
├── spotify-compat.test.ts OAuth and Spotify platform compatibility
└── util.test.ts         Tests for the pure helpers
```

## Token storage

OAuth tokens are encrypted at rest when possible:

- **macOS, Windows, modern Linux**: tokens stored in `data.json` encrypted via Electron's `safeStorage` (uses Keychain / DPAPI / kwallet under the hood). Settings tab shows `🔒 Tokens encrypted via OS keychain.`
- **If keychain is unavailable** (e.g. headless Linux, certain Electron builds): tokens stored as plaintext with a one-time Notice and `⚠️` indicator in settings.

Either way, `data.json` is in the plugin's local folder. **Don't commit it** if you sync your vault to a public git repo — the included `.gitignore` excludes `data.json` from version control. If you use Obsidian Sync or iCloud, encrypted tokens travel with your vault but are bound to your OS keychain (won't decrypt on a different machine — you'd just re-login).

## Performance

Steady-state cost:
- ~16 HTTP requests/minute when the sidebar is open and a track is playing
- ~2 DOM mutations per poll (only changed values trigger writes)
- 0 background work when the Obsidian window is hidden

Optimizations:
- Polling uses chained `setTimeout` (not `setInterval`) so slow networks don't queue up overlapping requests
- Devices fetched only on first poll + when the device picker opens
- `togglePlay` reads cached `lastState` instead of an extra fetch per click
- Track changes trigger background prefetch of lyrics, queue, and upcoming-track album art
- Bundle is 83 KB (no third-party SDK; direct `requestUrl` for both reads and writes)

## What's intentionally missing

**Smart Shuffle.** Spotify's "Smart Shuffle" mode is exposed only via their private API — the public Web API has no endpoint to read or toggle it. If you've enabled Smart Shuffle in the desktop app, it affects the queue order you receive, but this plugin can't read or change the state.

**Playback inside Obsidian itself.** The Spotify Web Playback SDK requires Widevine DRM, which Obsidian's Electron build doesn't bundle. The "Open Spotify Web Player → Obsidian tab" mode loads the UI but audio won't play in-tab. Use the external-browser mode (or the desktop app, or your phone) — the plugin controls whichever device is active.

## Development

```bash
npm install
node esbuild.config.mjs production  # build main.js
npm test                            # run unit tests
node esbuild.config.mjs             # dev (watch mode)
```

After source changes, `Cmd+R` (or `Ctrl+R`) inside Obsidian reloads the window and re-imports every plugin — more reliable than toggling the plugin off and on.

## License

MIT.
