# Pulseline — interval workout × playlist sync

A single-file browser app for lining up a Spotify playlist against a programmed interval workout on a shared timeline, and catching song transitions that land inside a peak interval.

## Project layout

```
pulseline/
├── server.py               static server + JSON state API (python3 server.py)
├── config.js               ← paste your Spotify Client ID here
│
├── index.html              editor: playlists, interval program, timeline
├── workout.html            phone player: in-workout screen
├── calendar.html           workout history: calendar + list
├── analyze.html            track analysis: loopback capture + Essentia
├── analysis-core.js        thin wrapper over Essentia.js algorithms
│
├── vendor/                 Essentia.js, vendored (AGPL) — no CDN needed
│   ├── essentia-wasm.web.js
│   ├── essentia-wasm.web.wasm
│   ├── essentia.js-core.min.js
│   └── ESSENTIA-LICENSE
│
├── manifest.json           PWA manifest (Add to Home Screen)
├── icon-192.png            \
├── icon-512.png             ) home-screen + tab icons
├── apple-touch-icon.png    /
├── favicon.ico
├── favicon-32.png
│
└── data/                   created on first run — your data lives here
    ├── analysis.json                  per-track Essentia results (SHARED, not per user)
    ├── state-u_<spotify-id>.json      workspaces, intervals, prefs, tokens
    ├── history-u_<spotify-id>.json    completed workouts
    └── *.bak, *.bak1, *.bak2          rolling backups of each
```

Workspaces and history are one file per Spotify account, so each person's data is separate.
Track analysis is the exception: it lives in a single `analysis.json`, because tempo and loudness
are properties of the recording rather than of the listener — a track analysed once is analysed
for everyone on the server, and nothing personal is stored in it. Listener-specific things (your
tempo reference, and therefore the energy score derived from it) live in your own state file and
are applied at display time. `data/` is the only
directory that changes at runtime — back it up, and don't commit it (it holds auth tokens).

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
- **Display modes**: the ▤ button right of PAUSE cycles **full** (timeline + everything) → **minimal** (timeline shrunk to a compact single-line strip) → **focus** (no timeline; interval name and countdown fill the screen). Your choice persists across sessions.
- **Landscape**: turn the phone sideways and it switches automatically to a landscape focus view — solid interval color filling the screen with just the interval name and a huge countdown, controls tucked down the right edge.
- **Audio cues** (WebAudio, through your headphones over the music): a two-tone ding at every interval change, a rising three-tone when a **peak** starts, and a finish chime at the end. The screen stays awake via wake lock.
- **Play through**: pick **This app** (Web Playback SDK — the browser itself becomes the Spotify player, so nothing else needs to be open; needs Premium and one extra permission, granted by logging in again once) or **Spotify app** (Spotify Connect — drives whatever device Spotify is active on). In-app mode syncs in real time from playback events instead of polling, so the clock is exact. Keep the screen on in this mode: mobile browsers stop audio when backgrounded, and the app holds a wake lock for exactly that reason. If in-app playback fails for any reason it says so and falls back to the silent simulation, and the Spotify-app mode is always there as a fallback.
- **Finishing**: when the last interval ends you get a WORKOUT COMPLETE splash, but **the music keeps playing** (cooldown). If you were playing in-app, the splash offers **Continue on Spotify app** — a Spotify Connect handoff that moves playback to your phone's Spotify app (or any other device) at the exact same track and position, so the music survives closing Pulseline. Only an explicit ✕ exit stops the audio. If you pause externally — headphone tap, lock screen — the app notices and pauses with you; resuming externally resumes the app too (instantly in in-app mode, within a few seconds in Spotify-app mode; that watch backs off and stops after 10 minutes so a long break doesn't hammer the API).
- **Live playback**: starting a (clean, saved) workout tells Spotify to play that playlist from the top on your chosen target — with the Spotify app open on the same phone, that's your headphones. PAUSE pauses both the workout clock and Spotify; the clock re-syncs to real playback every 5 s, so pausing/seeking inside Spotify is reflected too. ✕ ends the workout and pauses the music.

## Workout colors & calendar

Each playlist/workout has a **color** — the swatch next to the playlist picker in the editor (auto-assigned from a palette, override freely). It accents the workspace card in workout mode and becomes that workout's **calendar marker**.

**`/calendar.html`** (📅 in the editor topbar and workout splash) tracks what you've actually done. Finishing a workout logs it to your profile on the backend; quitting early asks whether to **End workout** (save it) or **Discard workout** (don't). Entries record: playlist name, color, interval-program length, elapsed time, and a DONE/PARTIAL flag. Two views:
- **Calendar**: a monthly grid with a colored dot on each day you worked out (the *first* workout's color; "×2" marks multi-workout days). Tap a day to see every workout from it, with details and a ✕ to delete entries.
- **History**: the same entries as a flat list, newest first, with full dates.

History lives in its **own** per-account file (`data/history-u_<id>.json`), separate from the workspace state, and is only ever modified through append/delete operations — so no page can wipe it by saving a stale copy of its own state. State writes are shallow-merged (a client can't delete a key it doesn't know about), every write is atomic, and three rolling backups are kept (`.bak`, `.bak1`, `.bak2`). Any history still stored inside an older state file is migrated automatically the first time the calendar loads.

## Track analysis (intensity curves)

**`/analyze.html`** measures the actual audio of every track in a playlist and stores an
**intensity curve over time** (one value per second, 0–1), plus tempo (BPM) and a 0–100 track
score. The editor timeline then draws these as a fourth lane under the intervals, so you can see
whether the music's energy actually rises where your peak intervals are. Hovering the timeline
shows the intensity at that exact instant.

How it works: Spotify's stream is DRM-protected and cannot be tapped by the browser, so analysis
listens to Spotify's *output* through a virtual loopback device — the exact master you'll hear,
full length, no 30-second previews. Tracks play one at a time in a hidden in-browser player while
features are extracted live (RMS loudness, spectral flux for percussive onset energy, spectral
centroid for brightness, and tempo by autocorrelation of the onset envelope with octave
correction). Analysis therefore runs at playback speed: a 20-track playlist takes about as long
as listening to it.

Results are cached **per track**, not per playlist, in the shared `data/analysis.json`. Load a
different playlist that shares tracks and their analysis is already there — only new tracks are
queued. Pressing Analyze processes just the unanalyzed tracks unless you tick **re-analyze tracks
that already have data**. Individual tracks can be cleared with the ✕ on their row.

Feature extraction is done by **[Essentia.js](https://mtg.github.io/essentia.js/)** — the
WebAssembly build of the Essentia library from the Music Technology Group, UPF Barcelona (the same
engine behind the AcousticBrainz dataset). Pulseline does no DSP of its own; it captures the audio
and hands it to Essentia. The library is vendored in `vendor/` (~2.1 MB, AGPL) so it works offline
and through a tunnel.

Per track it stores:

| value | Essentia algorithm |
|---|---|
| tempo + confidence + beat count | `RhythmExtractor2013` (multifeature beat tracker) |
| danceability (0–3) | `Danceability` (Detrended Fluctuation Analysis) |
| integrated loudness (LUFS), loudness range (LU), short-term loudness series | `LoudnessEBUR128` (EBU R128 standard) |
| dynamic complexity (dB) | `DynamicComplexity` |
| brightness (Hz) | `SpectralCentroidTime` |

The timeline curve is the **EBU R128 short-term loudness series**, mapped to 0–1 for display —
a standardised measurement, not a derived score. **There is no composite "energy" score.** Earlier versions had one; it was a weighted blend of
Essentia's outputs using thresholds I had chosen, and because real full-mix values sit in much
narrower bands than a naive reading of the docs suggests, every track collapsed into the middle of
the range. Rather than keep tuning invented constants, the app now exposes the measurements
directly and lets you graph whichever one you care about.

Pick a metric in the **graph** dropdown above the timeline. Available measurements, all straight
from Essentia:

| metric | unit | axis |
|---|---|---|
| Loudness over time (`shortTermLoudness`) | LUFS | observed |
| Tempo | BPM | documented 40–208 |
| Tempo confidence | — | documented 0–5.32 |
| Danceability | — | documented 0–3 |
| Integrated loudness | LUFS | observed |
| Loudness range | LU | observed |
| Dynamic complexity | dB | observed |
| Spectral centroid | Hz | observed |
| Beats detected | beats | observed |

Loudness over time draws as a curve within each track; the rest draw as one level per track.
**Axis scaling uses Essentia's documented range where one exists, and the observed spread across
your analysed tracks where it doesn't** — never an invented "typical" range. The lane header says
which of the two it's using. Values are labelled in their real units, on the timeline and in the
hover, and the analysis page's **show** dropdown picks which measurement appears in the track
table (hover any row for all of them at once).

**Tempo reference (personal).** The exercise-music literature puts the population threshold for
music's ergogenic effect at roughly 120 bpm, so that's the default — but preference is genuinely
individual, and the app treats it that way. Set your own reference in the **tempo ref** box on the
editor timeline (or the analysis page; the two share the setting). Tracks at or above it are drawn
in red on the timeline, below it in teal, and the hover shows how far a track sits from your
reference. Nothing is labelled "optimal" and nothing scores a track as good or bad — the reference
only scales the tempo component of the score and decides what gets highlighted, so a playlist
tuned to 175 isn't penalised for exceeding some notional ideal. Changing the reference re-colours
everything instantly; it does not require re-analysis.

### Turn off Spotify's loudness normalisation before analysing

**This matters more than any other setting.** Spotify normalises playback loudness by default, so
every track arrives at roughly the same level — which makes any loudness-based measure read the
same for a whisper-quiet ballad and a wall of distortion. In the Spotify desktop app: **Settings →
Playback → Normalize volume → off**. The energy metric is built from gain-invariant features
(crest factor, onset rate, spectral flatness, brightness, dynamic range) precisely so it survives
this, but turning normalisation off makes the loudness and dynamic-range terms meaningful too.

Keep your system volume fixed between sessions for the same reason.

### If a number looks wrong

Press **Copy raw dump** on the analysis page. Nothing is filtered — it contains:

- **input**: capture sample rate, whether it was resampled, sample count and duration, plus
  measured signal statistics (peak, RMS, crest, DC offset, clipped sample count, leading/trailing
  silence) for both the captured and the resampled signal
- **params**: the exact arguments passed to every Essentia algorithm
- **results**: every field each algorithm returned, including the long arrays — beat positions,
  BPM estimates and intervals, the DFA series, and the full momentary and short-term loudness
  series
- **errors**: the stack/message for any algorithm that failed, per algorithm
- **timingMs** per algorithm, and the browser/device context

That's roughly 21 KB per track. Prompt answers: a track number, `all`, or `slim` (same structure
with the long per-frame arrays replaced by counts) if you just want the headline numbers.

### Setting up audio loopback (one-time)

Route Spotify's output back in as a recording device. The analysis page shows a **loopback
detected** badge (green) when it recognises such a device by name, and a **level** badge that
turns green once it actually hears signal — so you can confirm the routing works before starting.

**macOS** — install [BlackHole](https://existential.audio/blackhole/) (2ch, free):
1. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**.
2. Tick both your speakers/headphones **and** BlackHole 2ch. (This lets you still hear the audio
   while it is also being routed to the loopback device.)
3. Set that Multi-Output Device as the system output.
4. In the analysis page's input list, choose **BlackHole 2ch**.

**Windows** — either enable the built-in **Stereo Mix** (Sound settings → Recording devices →
right-click → Show Disabled Devices → enable Stereo Mix), or install
[VB-Cable](https://vb-audio.com/Cable/) and select **CABLE Output** as the input. VB-Cable is more
reliable; with it, set **CABLE Input** as the playback device and use *Listen to this device* in
its properties if you want to hear the audio too. [VoiceMeeter](https://vb-audio.com/Voicemeeter/)
also works and makes the monitoring easier.

**Linux (PipeWire/PulseAudio)** — no install needed: choose the **Monitor of <your output>**
source in the input list (`pavucontrol` → Recording tab → set the browser's stream to the monitor
source).

Notes: the capture explicitly disables echo cancellation, noise suppression, and automatic gain
control, all of which are tuned for speech and would destroy the dynamics being measured. Keep
system volume at a consistent level between sessions, since loudness is measured from the signal.
Analysis needs Premium (it uses the in-browser player) and a desktop OS — virtual audio devices
don't exist on iOS.

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