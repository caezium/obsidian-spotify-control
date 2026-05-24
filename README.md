# Spotify Control

Control Spotify from inside Obsidian. A now-playing sidebar with hover-revealed transport, time-synced lyrics, upcoming-tracks queue, search palette, hotkey-bindable transport commands, and "insert track into note." Requires Spotify Premium for playback control.



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
</table>


## Features

**Now-playing sidebar.** Album art (with optional hover overlay for prev/play/next/shuffle/repeat), large track title, artist, album, seek bar, volume, custom device picker. Polls Spotify every 3s (configurable). Pauses polling when the Obsidian window is hidden.

**Time-synced lyrics.** Toggle a lyrics panel from a corner button on the album art. Lyrics come from [LRCLIB](https://lrclib.net) — free, no account, community-maintained LRC database. The active line is highlighted and auto-scrolls; click any line to seek to that timestamp. Falls back to plain-text lyrics when no synced version exists. Prefetched on every track change so the panel opens instantly.

**Upcoming-tracks queue.** Toggle button next to lyrics. Each row shows thumbnail + title + artist + duration. Click any track to jump to it — playback stays inside the current playlist/album context so the queue keeps rolling. Pre-loaded album art means scrolling is instant.

**Search palette.** Command-palette-style modal for searching tracks, albums, and playlists. Track results prompt "Play now" or "Add to queue."

**Insert track into note.** Drops the current track into your active editor using a configurable template (defaults to a `> [!music]` callout with a Spotify link). Variables: `{{name}} {{artist}} {{album}} {{url}} {{uri}}`.

**Play any Spotify URI under cursor.** Bindable command — works on `spotify:track:abc` URIs and `https://open.spotify.com/...` URLs (including `?si=` share tokens and `intl-XX/` locale prefixes).

**Open Spotify Web Player.** Command/setting to open `open.spotify.com` either in your external browser (audio works) or in an Obsidian tab (UI only — Obsidian's Electron build doesn't bundle Widevine DRM).

## Setup (one-time)

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app. Name and description don't matter.
2. In the app's settings, add this exact **Redirect URI**:
   ```
   obsidian://spotify-control/auth
   ```
3. Copy the **Client ID** from your app's main page. **No Client Secret needed** — this plugin uses PKCE.
4. In Obsidian → Settings → Community plugins → enable **Spotify Control**.
5. Open the Spotify Control settings tab, paste the Client ID, click **Log in**. Your browser will open Spotify's authorization page; after approving, you'll be redirected back into Obsidian.

The first time you control playback after starting cold, the plugin auto-transfers playback to the first available device (so you don't need to manually pick one).

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
| **Insert-now-playing template** | Template for the insert command |
| **Spotify Web Player → Open in** | External browser (recommended) or Obsidian tab (UI only) |

## Architecture

```
src/
├── main.ts              Plugin entry, settings tab, lifecycle
├── auth.ts              PKCE OAuth + token refresh (deduped + backoff retry)
├── api.ts               Direct requestUrl wrapper for Spotify Web API
├── view.ts              Now-playing sidebar (ItemView)
├── search.ts            Spotify search modal (SuggestModal)
├── commands.ts          All hotkey-bindable commands
├── lyrics.ts            LRC parsing + LyricsService (pure, no Obsidian deps)
├── lyrics-fetcher.ts    Obsidian requestUrl bridge for LyricsService
├── queue.ts             Queue snapshot + cache (pure)
├── queue-fetcher.ts     Obsidian requestUrl bridge for QueueService
├── secure-storage.ts    OAuth tokens via Electron safeStorage, plaintext fallback
├── util.ts              Pure helpers (formatTime, parseSpotifyResource, PKCE primitives, template)
└── types.ts             Settings shape + scopes + redirect URI

tests/
├── util.test.ts         24 tests for the pure helpers
└── lyrics.test.ts       25 tests for LRC parser + LyricsService
```

49 unit tests, run with `npm test`.

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
- Bundle is 64 KB (no third-party SDK; direct `requestUrl` for both reads and writes)

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
