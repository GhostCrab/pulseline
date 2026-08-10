# Pulseline — interval workout × playlist sync

A single-file browser app for lining up a Spotify playlist against a programmed interval workout on a shared timeline, and catching song transitions that land inside a peak interval.

## Run it

From the folder containing `index.html` and `server.py` (Python 3, no packages needed):

```
python3 server.py
```

Then open **http://127.0.0.1:8888/** in your browser. (`python3 server.py 9000` for a different port — keep it consistent with your Spotify app settings below.)

`server.py` does two jobs: serves the app over the loopback URL Spotify's login requires, and persists everything to **`data/state.json`** — a plain JSON text file you can inspect, back up, or delete to reset. Writes are atomic and a rolling backup is kept at `state.json.bak`.

## Connect your Spotify account (one-time)

1. Go to https://developer.spotify.com/dashboard and create an app (any name; select "Web API").
2. In the app's settings, add this Redirect URI **exactly**: `http://127.0.0.1:8888/`
   (Spotify no longer accepts `localhost` for new apps — it must be the `127.0.0.1` loopback IP, and the trailing slash matters. The Connect dialog in Pulseline shows the precise URI it will send, with a Copy button — paste that into the dashboard and it cannot mismatch.)

### "redirect_uri: Not matching configuration"

Spotify compares the URI character-for-character. Checklist: browse to the app at `http://127.0.0.1:8888/` (not `localhost` — the Connect dialog will warn you and give a fix-it link); make sure the dashboard entry has the trailing slash; make sure the port matches how you launched `server.py`; after editing the dashboard, hit **Save** at the bottom of Spotify's settings page (easy to miss).
3. Copy the app's **Client ID**.
4. In Pulseline, click **Connect Spotify**, paste the Client ID, and log in. The token and Client ID are stored only in your browser (PKCE flow — no client secret involved).

Your Spotify app runs in Development Mode, which is fine: your own account works without any approval process.

## Using it

- **Browse your playlists**: once connected, all playlists from your account are listed in the left rail — click one to load it (the top-bar dropdown does the same). Loading pulls the full track list with exact durations.
- **Per-playlist workspaces**: every playlist owns its interval list and its in-edit state, persisted on the backend. Switch playlists freely — a playlist you edited comes back exactly as you left it (order, additions, dirty marker and all), a clean one reloads fresh from Spotify, and a first-time one starts a new interval list. **Revert edits** (appears next to Save while dirty) throws away your local changes and reloads the Spotify version, keeping the interval list.
- **Reorder** by dragging rows; **remove** with ✕; **add** via the search box at the bottom of the rail. Nothing touches Spotify until you press **Save order to Spotify**, which replaces the playlist's contents with what you see.
- **Intervals**: a vertical list, one row per section, reading top-to-bottom like a program sheet. Each row holds everything inline: color, name, a computed **T+ start time**, length (`m:ss`), and intensity (low / medium / high / peak — picking an intensity resets the color to its default, which you can then override). Reorder by grabbing the **⠿ handle** and dragging the row up or down. **+ ADD SECTION** appends at the bottom. The workout autosaves and can be exported/imported as JSON.
- **Duplicating intervals**: the ⧉ button on a card copies that one section in place. For blocks, tick the checkboxes on the sections you want (shift-click selects a range), set the repeat count in the amber bar that appears, and hit **Duplicate group** — e.g. select Sprint + Recover, repeat ×4, and the whole pattern is inserted right after the originals in order.
- **Analysis log export**: **Copy analysis log for AI** puts a structured JSON snapshot of everything on your clipboard, ready to paste into any AI chat (**Download analysis log** saves the same thing as a timestamped file). It contains the full track list with start/end offsets, every interval with intensity and timing, every song transition annotated with which interval it lands in, per-interval song-overlap breakdowns, coverage math, and the peak-clash list — plus a `_description` field explaining the semantics so an agent needs no other context. Ask for things like "reorder these tracks to eliminate peak clashes" or "tweak interval lengths so transitions land in recovery".
- **Run-through mode**: the transport bar above the minimap plays a live clock across the timeline — press **▶** (or **space**), and a bright playhead sweeps both the main view and minimap while the bar shows T+, the current song with time remaining, the current interval with its intensity, and a countdown to the next transition (turning red when that transition lands in a peak). The **speed button** cycles 1× / 2× / 4× / 8× / 16× so you can preview a 30-minute workout in about two minutes. **Follow** keeps the zoom window tracking the playhead. Click or drag on the ruler tape to seek/scrub. By default it's a silent simulation — but the **🔊 link device** button turns it real: it lists your Spotify Connect devices (phone, desktop app, speakers — open Spotify on the device so it shows up), and once linked, play/pause and ruler seeking drive actual audio on that device. **Rule: live sync only runs on un-edited playlists** — playback always uses the playlist exactly as saved on Spotify (played as a proper playlist context, so your phone shows "Playing from …"). Linking is blocked while you have unsaved changes; editing while live pauses the device and puts the link in an amber "save to sync" state; hitting Save re-arms it. The silent simulation still works on anything, edited or not. The app clock re-syncs to real playback every few seconds, so pausing or skipping on the phone is reflected on the timeline. Speed locks to 1× while linked (real audio has one speed); unlink to get fast preview back. Requires Premium on the logged-in account — which dev-mode apps already require. If you get "no active playback", open the Spotify app on the target device first.
- **Timeline**: songs on top, intervals below, sharing one time ruler. Amber diamonds mark song transitions; a transition inside a **peak** interval turns into a red **!** marker piercing both lanes (and a red tick on the minimap). A compact chip in the timeline header shows the clash count — clicking it jumps the view window to each clash in turn — and hovering a clash on the timeline gives the exact timing. Full clash details are also in the analysis log export. Hover anywhere for overall time, time into/left of the current song and interval, BPM, and intensity. Navigation uses an overview + detail design: a **minimap** above the main timeline always shows the full run at fixed width, with an amber window marking what the main view (also fixed width) is showing. Drag the window on the minimap to move around, drag its edge handles to resize it, click outside it to jump, double-click the minimap to snap back to full view. On the main timeline, **Ctrl+wheel** zooms the window about the cursor (up to 64×), plain wheel pans, and the slider (with a live × readout) zooms about the window centre. Neither canvas ever changes size, so nothing can overflow the page at any zoom depth. Click-dragging on the main timeline remains reserved for reordering songs.

## Workout mode (phone)

**`/workout.html`** is a read-only, fullscreen in-workout player built for a phone (host locally and tunnel it — e.g. Cloudflare Tunnel to your own domain; add the tunneled `…/workout.html` URL as a Spotify redirect URI so the phone can log in). The flow: start your watch's heart-rate tracking, open Spotify on the phone, open workout mode, pick a workout, go.

- **Splash** lists every playlist that has an interval program (built on the desktop dashboard), with workout/music durations, an interval color bar, and a clash check. Workspaces with unsaved edits run simulated-only, per the live-sync rule.
- **In-workout screen** (fits the screen exactly, no scrolling): a sliding 2-minute timeline strip up top with the playhead pinned centre; below it, song + artist + song time, the interval name, a **huge time-left countdown**, next-interval preview, and total T+ / time-to-go. The background is a gradient from the dark timeline down into the **current interval's color**, animating as intervals change.
- **Audio cues** (WebAudio, through your headphones over the music): a two-tone ding at every interval change, a rising three-tone when a **peak** starts, and a finish chime at the end. The screen stays awake via wake lock.
- **Play through**: pick **This app** (Web Playback SDK — the browser itself becomes the Spotify player, so nothing else needs to be open; needs Premium and one extra permission, granted by logging in again once) or **Spotify app** (Spotify Connect — drives whatever device Spotify is active on). In-app mode syncs in real time from playback events instead of polling, so the clock is exact. Keep the screen on in this mode: mobile browsers stop audio when backgrounded, and the app holds a wake lock for exactly that reason. If in-app playback fails for any reason it says so and falls back to the silent simulation, and the Spotify-app mode is always there as a fallback.
- **Live playback**: starting a (clean, saved) workout tells Spotify to play that playlist from the top on your chosen target — with the Spotify app open on the same phone, that's your headphones. PAUSE pauses both the workout clock and Spotify; the clock re-syncs to real playback every 5 s, so pausing/seeking inside Spotify is reflected too. ✕ ends the workout and pauses the music.

## Workout colors & calendar

Each playlist/workout has a **color** — the swatch next to the playlist picker in the editor (auto-assigned from a palette, override freely). It accents the workspace card in workout mode and becomes that workout's **calendar marker**.

**`/calendar.html`** (📅 in the editor topbar and workout splash) tracks what you've actually done. Finishing — or quitting after at least a minute of — a workout in workout mode logs it to your profile on the backend: playlist name, color, interval-program length, elapsed time, and a DONE/PARTIAL flag. Two views:
- **Calendar**: a monthly grid with a colored dot on each day you worked out (the *first* workout's color; "×2" marks multi-workout days). Tap a day to see every workout from it, with details and a ✕ to delete entries.
- **History**: the same entries as a flat list, newest first, with full dates.

History lives in your per-Spotify-account state file, so each person's calendar is their own.

## Multi-user

No app login: backend state is namespaced by **Spotify identity**. After login the app reads/writes `data/state-u_<spotify-user-id>.json`, so each Spotify account gets its own workspaces automatically — your wife logs into her Spotify on her device and sees only her playlists and interval programs. Tokens are per-device (browser localStorage); the shared piece is only the app Client ID. (No authentication guards the state files — fine for a household tunnel, not for the open internet.)

## Notes & limits

- The app uses Spotify's February 2026 API (`/playlists/{id}/items`, entries under `.item`) and transparently falls back to the legacy `/tracks` shape if it ever sees a 403/404, remembering whichever works. Saving uses replace semantics batched per 100 tracks, so removals, additions, and reorders persist in one go. Local (non-Spotify) files in playlists are skipped since they can't be re-added via the API.
- Per the 2026 API policy, playlist *contents* are only readable for playlists your own account owns — followed/other users' playlists list in the browser but will refuse to load their tracks.
- Your login persists across refreshes and restarts (tokens live in `data/state.json` and refresh silently). The badge in the top bar shows "● saving to disk" when the backend is active — if it shows "● browser storage only" in red, you launched a plain static server instead of `python3 server.py`, and persistence will be weaker. Only a genuinely expired/revoked session asks you to reconnect; transient errors keep your login. **Disconnect** wipes it deliberately.
- **Persistence**: everything lives in `data/state.json` on disk, not in browser storage — client ID, auth tokens, workout sections, the selected playlist, your working track order (including unsaved edits), and zoom level. Close the browser, reboot the machine, restart the server: you resume exactly where you left off, with a "Session restored" note and the dirty marker intact if you had unpushed changes. Saves are debounced (~0.4s after any change) with a final flush on tab close.
- The state file includes your Spotify tokens in plain text — it's scoped to your own account on your own machine, but treat `data/` like a credentials file (don't commit or share it).
- If you launch with a plain static server instead of `server.py`, the app warns you and falls back to browser storage so nothing breaks.
- No BPM anywhere: Spotify removed its tempo endpoint for apps created after Nov 2024, and rather than expose a manual field the app just doesn't surface tempo. Track lengths come straight from Spotify.