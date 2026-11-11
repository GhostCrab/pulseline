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
tempo reference, your selected graph metric, workspace colors) live in your own state file and are
applied at display time. `data/` is the only directory that changes at runtime — back it up, and
don't commit it (older installs may still hold auth tokens inside the state file).

## Run it

From the folder containing `index.html` and `server.py` (Python 3, no packages needed):

```
python3 server.py
```

Then open **http://127.0.0.1:8888/** in your browser. (`python3 server.py 9000` for a different port — keep it consistent with your Spotify app settings below.)

`server.py` does two jobs: serves the app over the loopback URL Spotify's login requires, and persists everything under **`data/`** as plain JSON text files you can inspect, back up, or delete to reset — one state file and one history file per Spotify account, plus one shared analysis file. Writes are atomic and three rolling backups are kept per file (`.bak`, `.bak1`, `.bak2`).

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
- **Staying connected**: token refresh is single-flight (concurrent callers share one refresh, so
  they can't race on Spotify's rotating refresh token), retried with backoff, and done two minutes
  before expiry. Only an explicit 400/401 from Spotify counts as a dead session; a failure caused
  by a sleeping radio is retried. API calls retry network errors, 429s and 5xxs with backoff, and
  a 401 triggers one forced refresh and a retry. Returning to the app — visibility change, window
  focus, or the network coming back — re-acquires the wake lock, resumes the audio context,
  revalidates the token, reconnects the in-app player if its socket dropped, and re-syncs against
  what Spotify is actually playing. A **reconnecting…** badge appears while this is happening.
- **Audio cues** (WebAudio, through your headphones over the music): a two-tone ding at every interval change, a rising three-tone when a **peak** starts, and a finish chime at the end. The screen stays awake via wake lock. iOS suspends the audio context whenever the app is backgrounded, the screen locks, or the audio session is taken — including on pause — so the context is revived before every cue rather than only at startup; otherwise the dings go silent after the first pause.
- **Play through**: pick **This app** (Web Playback SDK — the browser itself becomes the Spotify player, so nothing else needs to be open; needs Premium and the `streaming` permission, which every Pulseline login now requests; a device holding an older login without it shows a **Reconnect Spotify** button instead of switching modes behind your back) or **Spotify app** (Spotify Connect — drives whatever device Spotify is active on). In-app mode syncs in real time from playback events instead of polling, so the clock is exact. Keep the screen on in this mode: mobile browsers stop audio when backgrounded, and the app holds a wake lock for exactly that reason. If in-app playback fails for any reason it says so and falls back to the silent simulation, and the Spotify-app mode is always there as a fallback.
- **Finishing**: when the last interval ends you get a WORKOUT COMPLETE splash, but **the music keeps playing** (cooldown). If you were playing in-app, the splash offers **Continue on Spotify app**, which moves playback to your phone's Spotify app (or any other device) so the music survives closing Pulseline. Rather than a plain Connect transfer — which resumes from a position captured before the request, replaying the network round trip and the device's buffer startup as an audible half-second repeat — it reads the exact position with a timestamp and starts the target at that position plus the time genuinely elapsed plus a startup allowance. The allowance is then checked against where the device actually ended up and adjusted, so it converges on whatever your network and phone really cost (roughly 17 ms of repeat after half a dozen handoffs, from a 350 ms starting error). Only an explicit ✕ exit stops the audio. If you pause externally — headphone tap, lock screen — the app notices and pauses with you; resuming externally resumes the app too (instantly in in-app mode, within a few seconds in Spotify-app mode; that watch backs off and stops after 10 minutes so a long break doesn't hammer the API).
- **Shuffle and repeat are turned off automatically** before the first note. Both are account-level
  modes that persist, so a playlist you last played shuffled would otherwise start in a random
  order and every interval alignment on the timeline would be wrong — silently. If the playing
  order still diverges from the timeline (shuffle re-enabled mid-workout, a manual skip, a track
  that isn't in the workout at all), the app says so once rather than quietly drifting.
- **Live playback**: starting a (clean, saved) workout tells Spotify to play that playlist from the top on your chosen target — with the Spotify app open on the same phone, that's your headphones. PAUSE pauses both the workout clock and Spotify; the clock re-syncs to real playback every 5 s, so pausing/seeking inside Spotify is reflected too. ✕ ends the workout and pauses the music.

## Workout colors & calendar

Each playlist/workout has a **color** — the swatch next to the playlist picker in the editor (auto-assigned from a palette, override freely). It accents the workspace card in workout mode and becomes that workout's **calendar marker**.

**`/calendar.html`** (📅 in the editor topbar and workout splash) tracks what you've actually done. Finishing a workout logs it to your profile on the backend; quitting early asks whether to **End workout** (save it) or **Discard workout** (don't). Entries record: playlist name, color, interval-program length, elapsed time, and a DONE/PARTIAL flag. Two views:
- **Calendar**: a monthly grid with a colored dot on each day you worked out (the *first* workout's color; "×2" marks multi-workout days). Tap a day to see every workout from it, with details and a ✕ to delete entries.
- **History**: the same entries as a flat list, newest first, with full dates.

History lives in its **own** per-account file (`data/history-u_<id>.json`), separate from the workspace state, and is only ever modified through append/delete operations — so no page can wipe it by saving a stale copy of its own state. State writes are shallow-merged (a client can't delete a key it doesn't know about), every write is atomic, and three rolling backups are kept (`.bak`, `.bak1`, `.bak2`). Any history still stored inside an older state file is migrated automatically the first time the calendar loads.

## Track analysis (intensity curves)

**`/analyze.html`** measures the actual audio of every track in a playlist and stores a set of
**Essentia measurements** per track — tempo, loudness (integrated, range, and a short-term series
over time), danceability, dynamic complexity and spectral centroid. The editor timeline draws your
chosen measurement as a fourth lane under the intervals, so you can see whether the music's energy
actually rises where your peak intervals are. Hovering the timeline shows the value at that exact
instant.

How it works: Spotify's stream is DRM-protected and cannot be tapped by the browser, so analysis
listens to Spotify's *output* through a virtual loopback device — the exact master you'll hear,
full length, no 30-second previews. Tracks play one at a time in a hidden in-browser player while
the whole track is captured to raw PCM; the complete signal is then resampled to 44.1 kHz and
handed to Essentia in one pass. Analysis therefore runs at playback speed: a 20-track playlist
takes about as long as listening to it.

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
only decides what gets highlighted and which tempo octave a measured BPM is folded into, so a
playlist tuned to 175 isn't penalised for exceeding some notional ideal. Changing the reference
re-colours everything instantly; it does not require re-analysis.

### Turn off Spotify's loudness normalisation before analysing

**This matters more than any other setting.** Spotify normalises playback loudness by default, so
every track arrives at roughly the same level — which makes any loudness-based measure read the
same for a whisper-quiet ballad and a wall of distortion. In the Spotify desktop app: **Settings →
Playback → Normalize volume → off**. Tempo, danceability and spectral centroid survive
normalisation; the loudness metrics (LUFS, loudness range, dynamic complexity) and the timeline
curve do not, and are the main reason this setting matters.

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

## Running as a service (Debian / Raspberry Pi)

`pulseline.service` is a ready systemd unit. It assumes the app lives in **`/opt/pulseline`** —
not `/etc`, which is for configuration, and which systemd's `ProtectSystem=full` hardening mounts
read-only, blocking the server from writing `data/`.

```bash
# 1. install the app
sudo mkdir -p /opt/pulseline
sudo cp -r ./* /opt/pulseline/          # from wherever you copied the files

# 2. a dedicated unprivileged account that owns only its data
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pulseline
sudo mkdir -p /opt/pulseline/data
sudo chown -R root:root /opt/pulseline
sudo chown -R pulseline:pulseline /opt/pulseline/data

# 3. install and start the unit
sudo cp /opt/pulseline/pulseline.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pulseline

# 4. check
systemctl status pulseline
journalctl -u pulseline -f
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/
```

The app code is owned by root and read-only to the service; only `data/` is writable, which is
also the only directory that changes at runtime.

**Binding.** The server listens on `127.0.0.1:8888` by default — correct when `cloudflared` runs
on the same Pi. To also serve the local network, pass a host or set the environment variable:

```
ExecStart=/usr/bin/python3 /opt/pulseline/server.py 8888 0.0.0.0
```

(or `Environment=PULSELINE_HOST=0.0.0.0`). Note there is no authentication in front of the state
API, so only expose it on a network you trust.

**Updating.** Copy new files into `/opt/pulseline` and `sudo systemctl restart pulseline`. The
no-cache headers mean browsers pick up changes on the next load.

**Keeping the tunnel up.** If you run `cloudflared` on the same Pi, install it as its own service
(`sudo cloudflared service install`) so both come back after a reboot; add
`After=cloudflared.service` to Pulseline's unit only if you want a strict start order.

## Multi-user

No app login: backend state is namespaced by **Spotify identity**. After login the app reads/writes `data/state-u_<spotify-user-id>.json`, so each Spotify account gets its own workspaces automatically — your wife logs into her Spotify on her device and sees only her playlists and interval programs. Tokens are per-device (browser localStorage); the shared piece is only the app Client ID. (No authentication guards the state files — fine for a household tunnel, not for the open internet.)

## Notes & limits

- The app uses Spotify's February 2026 API (`/playlists/{id}/items`, entries under `.item`) and transparently falls back to the legacy `/tracks` shape if it ever sees a 403/404, remembering whichever works. Saving uses replace semantics batched per 100 tracks, so removals, additions, and reorders persist in one go. Local (non-Spotify) files in playlists are skipped since they can't be re-added via the API.
- Per the 2026 API policy, playlist *contents* are only readable for playlists your own account owns — followed/other users' playlists list in the browser but will refuse to load their tracks.
- Your login persists across refreshes and restarts and refreshes silently. The badge in the top bar shows "● saving to disk" when the backend is active — if it shows "● browser storage only" in red, you launched a plain static server instead of `python3 server.py`, and persistence will be weaker. Only a genuinely expired/revoked session asks you to reconnect; transient errors keep your login. **Disconnect** wipes it deliberately.
- **Persistence**: workspaces, workout sections, the selected playlist, your working track order (including unsaved edits), your view window and your preferences live on the backend under `data/`, not in browser storage. Close the browser, reboot the machine, restart the server: you resume exactly where you left off, with a "Session restored" note and the dirty marker intact if you had unpushed changes. Saves are debounced (~0.4 s after any change) with a final flush on tab close.
- **Secrets are per-device, not per-server.** The Client ID, access/refresh tokens and PKCE verifier live in that browser's `localStorage` (keys prefixed `pl_`), deliberately — they are device credentials, and keeping them out of the shared state file means one person's tunnel session can't adopt another's login. Older installs kept them server-side; the editor adopts any such legacy tokens into the device once on boot and deletes them from the state file. **If your `data/` ever predates that migration, treat it as a credentials file** — don't commit or share it, and if it reached a public git history, revoke at spotify.com/account/apps and reconnect.
- If you launch with a plain static server instead of `server.py`, the app warns you and falls back to browser storage so nothing breaks.
- **No BPM from Spotify**: Spotify removed its tempo endpoint for apps created after Nov 2024, and rather than expose a manual field the app surfaces no tempo at all unless it has *measured* one. Every BPM you see comes from Essentia via `analyze.html`. Track lengths come straight from Spotify.

---

# Working on this codebase

Written for whoever (or whatever) picks this up next. Everything below is hard-won — most items
cost an hour or more to find the first time.

## Shape of the thing

No build step, no framework, no package.json, no dependencies to install. Four HTML pages, each
with its own `<script>` block holding that page's entire application. The only shared JavaScript
is `config.js` (one line), `analysis-core.js`, and the vendored Essentia WASM. `server.py` is
Python stdlib only.

| file | role | notes |
|---|---|---|
| `server.py` | static server + JSON state API | ~300 lines, stdlib `http.server` |
| `index.html` | the editor — playlists, intervals, timeline, run-through | ~2.3k lines, the big one |
| `workout.html` | phone player | ~1.6k lines, the most-regressed file |
| `calendar.html` | history calendar + list | smallest page |
| `analyze.html` | loopback capture + Essentia driver | owns the capture pipeline |
| `analysis-core.js` | Essentia wrapper + METRICS catalogue | `ANALYSIS_VERSION = 8` |

**The duplication is deliberate.** Each page re-implements its own auth and store layer so a page
can be opened standalone (the phone loads `workout.html` through a tunnel and nothing else). The
cost is that an auth or storage fix must be applied to every page that has one — see *Hotspots*.

Dev happens on Windows (`C:\Users\ryanp\Workspace\spotify`); deploy target is `/opt/pulseline` on
a Debian Pi 5 behind a Cloudflare tunnel at `pulseline.pielow.io`.

## Storage model — read this before touching persistence

Three stores with three different sets of rules. Mixing them up is how data gets lost.

| store | where | namespacing | write semantics |
|---|---|---|---|
| `Store` | `data/state-u_<spotify-id>.json` | per Spotify account | **POST shallow-merges** (`cur.update(payload)`) |
| history | `data/history-u_<spotify-id>.json` | per Spotify account | append / delete **ops only**, never wholesale |
| analysis | `data/analysis.json` | **shared, not per user** | put / delete / clear, plus a cached summary view |
| `LSD` | browser `localStorage`, `pl_*` keys | per **device** | `clientId`, `tok`, `verifier`, `ns`, `plResource` |

**Why state POST shallow-merges:** history originally lived inside the state blob, and the editor
rewrote that blob wholesale on every save — so opening the editor silently erased the phone's
workout history. The fix was threefold: history moved to its own file, history ops became
append/delete, and state writes became a merge so **a client can no longer delete a key by
omitting it**. If you need to delete a state key, use the explicit delete path; don't "fix" the
merge. `server.py` also force-drops any `history` key from state writes, and auto-migrates history
found in a legacy state file the first time the calendar loads.

All writes go through `write_json_atomic()` — temp file, fsync, `os.replace`, then roll
`.bak` → `.bak1` → `.bak2`.

**Analysis is shared on purpose.** Tempo and loudness are properties of a recording, not of a
listener. Don't namespace it. Listener-specific values (`bpmRef`, `metric`, `wsColor`) belong in
the per-user state file and are applied at display time.

## Spotify API quirks

1. **The February 2026 migration is already done.** `/playlists/{id}/items`, entries under
   `.item`, and playlist listings report `items:{total}` — **not** `tracks:{total}`. The old
   `/tracks` endpoint returns **403** for development-mode apps. There is a self-healing fallback
   that tries both shapes and remembers the winner in `LSD.plResource`. The original bug here was
   an unguarded `p.tracks.total` that threw on the first row and left "Loading…" on screen
   forever — **null-guard every field you read off a Spotify payload, and surface render errors
   visibly** instead of letting them die in the console.
2. Playlist *contents* are readable only for playlists the account owns. Followed playlists list
   fine and then refuse to load.
3. **Shuffle and repeat are account-level persistent state.** A playlist last played shuffled will
   start shuffled, and every interval alignment on the timeline is then silently wrong.
   `forceLinearPlayback()` in `workout.html` handles this.
4. **Order of operations matters**: activate device (`PUT /me/player {device_ids, play:false}`) →
   `shuffle?state=false` → `repeat?state=off` → **then** `/me/player/play`. Setting shuffle after
   play does not retroactively reorder the queue. A 2.5 s read-back of `shuffle_state` warns once
   (`W.orderWarned`) if it didn't take.
5. **`progress_ms` is stale by one round trip.** Compensate with `+rtt/2`, then *slew* the local
   clock toward the truth (±12 %) rather than snapping; snap only on >2.5 s drift. Snapping
   produced a visible flicker every 5 s.
6. **PKCE, no client secret.** The Client ID is public by design, so `config.js` is safe to
   commit. Tokens are device-local.
7. **Only an explicit 400/401 means the session is dead.** An early version treated *any* startup
   error as auth failure and wiped the token on every refresh. Even a 400 can be a lost race: every
   page on the origin shares `pl_tok`, so if the stored refresh token changed while a refresh was in
   flight, another tab rotated it and the newer token is used instead of declaring the session dead.
8. **One login serves every page, so every page requests the same scopes.** The editor used to
   request a smaller set without `streaming`. A device that logged in through the editor (e.g. by
   tapping the PULSELINE logo on the phone) got a token the in-app player rejects with
   `authentication_error: Invalid token scopes`, and `workout.html` then silently switched itself
   to Spotify-app mode: badge `● LIVE`, play sent to some other device, no sound and no error.
   Keep the scope lists identical, and never downgrade the target silently.
9. **In-app audio failure is reported only through SDK events.** `PUT /me/player/play` returns
   204 and the server says `is_playing:true` even when the in-browser player produces nothing.
   `playback_error` (repeated, while the SDK skips through the playlist), `authentication_error`
   and `autoplay_failed` are the only signals. `workout.html` listens for all of them and drops to
   SIMULATED with a message. `sdk-probe.html`-style diagnostics (log every SDK event plus each API
   status) are what pinned this down. No automated seam reaches the SDK, so there's no regression test.

## Essentia quirks

All three of these are undocumented or easy to misread, and each one presents as something else.

1. **`RhythmExtractor2013` takes no sampleRate parameter** — it assumes 44100 Hz. Windows loopback
   captures at 48000, which silently yields `bpm: 0`. Everything is resampled to 44.1 kHz via
   `OfflineAudioContext` in `resampleTo44100()` before any algorithm runs. Don't remove that step.
2. **`LoudnessEBUR128` requires `hopSize = 0.1`** (its documented default). Any other value throws
   an **uncatchable Emscripten abort** that takes the whole WASM instance with it — no JS exception
   to handle. The first theory was heap exhaustion; it wasn't (it failed in 8 ms). The chunking
   added while chasing that theory is harmless and was kept.
3. **Beat results are in `ticks` / `estimates` / `bpmIntervals`**, not `beats_position`.

Analysis runs on the **complete captured PCM in one pass**, not streaming — capture the whole
track via `ScriptProcessorNode`, resample, then analyse. `analyseSignal()` returns
`{engine, input, params, results, errors, timingMs, summary, curveLufs, curveHz}`; each algorithm's
failure is caught and recorded in `errors` per algorithm rather than aborting the track.

## The no-invented-numbers rule

**This is a standing constraint from the project owner, not a style preference.**

There used to be a composite 0–100 "energy score". It was a weighted blend of Essentia outputs
against thresholds that had been *guessed* — spectral flatness assumed to span 0.02–0.35 when real
full mixes sit near 0.025, a spectral-centroid ceiling of 3800 Hz when real tracks come in at
1100–1700. The result was that every track in a 20-track playlist scored between 49 and 62, and
the whole feature was worthless. It was deleted rather than retuned.

What replaced it:

- `METRICS` in `analysis-core.js` carries a `docRange` **only where Essentia documents one**
  (tempo 40–208, tempo confidence 0–5.32, danceability 0–3).
- `metricBounds()` returns `source: "documented" | "observed"`, and the timeline lane header tells
  the user which it's using. Observed means the spread across that user's own analysed tracks.
- Every value is labelled in its real unit.

**If you add a metric and the documentation gives no range, use the observed spread or expose no
axis at all. Do not invent a plausible-looking range.** The same applies to anything else in this
project: if the documentation or research isn't there, say so rather than filling the gap.

## Layout and canvas quirks

1. **`minmax(0, 1fr)` in `#main`'s grid is load-bearing.** A plain `1fr` track refuses to shrink
   below its content; the app measures that container to compute its "fit" zoom, which grew the
   content, which grew the track — an unbounded feedback loop that pushed the workspace off the
   right edge of the page. Keep `minmax(0,1fr)` and `overflow-x:hidden`.
2. **Never size a canvas from the zoom level.** Browsers cap a canvas dimension at roughly 32,767
   device pixels; on a 4K display at 200 % scaling a deep zoom asked for 60,832 and Chrome
   replaced the canvas with the white sad-face. The canvas is virtualized: it is a fixed size and
   only the visible window is drawn.
3. **Navigation is overview + detail (minimap), with `setWindow(start, len, persist)` as the
   single mutator** of the view window. `MIN_WIN()` is `max(5, total/64)`. There is deliberately
   **no scroll container** on the timeline — three separate attempts to fix zoom while a scroll
   container existed all failed (both wheel directions zooming in, stepwise creep, black blinks).
   Don't reintroduce one, and don't add a second path that writes the window.
4. `LAYOUT = {songTop:14, songH:104, rulerTop:130, rulerH:48, secTop:190, secH:104, anaTop:300,
   anaH:56, H:364, padL:8, padR:8}` — lane geometry is all here, not scattered.
5. **Rajdhani has no tabular figures**, so `font-variant-numeric: tabular-nums` is a silent no-op
   and the countdown jittered as digits changed width. Fixed with explicit per-glyph cells
   (`#count i.d{width:.58em}`, `#count i.c{width:.26em}`) sized by measured ratios in
   `setCount()` / `fitCount()`.
6. **A content-sized box plus a font sized from that box is a feedback loop** — the landscape
   timer resized stepwise for about five seconds. The box is `flex:1 1 0; min-height:0`.
7. **Rotation**: settle-detect on `innerWidth`/`innerHeight` before re-laying out. An earlier
   masking fade added to hide the transition is what caused the black blinks; it was removed, not
   tuned.
8. **The landscape completion-modal divider is `#doneBox #handoffWrap::before`** (inset 6 px,
   gradient-faded), not a `border-left` — a border spans the full element height and ran into the
   Done button. Separately, the portrait `#handoffWrap{border-top:…}` rule must stay scoped inside
   a portrait media query; at equal specificity it sits later in the stylesheet and otherwise wins
   by source order, putting a stray border on the landscape column.

## Caching and version skew

**Cloudflare caches `.js` by default but not HTML.** That produced the worst class of bug in the
project: `analyze.html` updated while `analysis-core.js` stayed stale, giving "X is not a function"
against code that looked correct on disk. Three defences, and **all three must be bumped
together** whenever `ANALYSIS_VERSION` changes:

1. `server.py`'s `end_headers()` sends `Cache-Control: no-cache, must-revalidate` for `/`,
   `.html`, `.json`, `.js`, `.css`.
2. `?v=N` query strings on every `<script src>` in `index.html` and `analyze.html`.
3. `NEEDS_CORE` in `analyze.html` gates on `PLAnalysis.ANALYSIS_VERSION` and shows an explicit
   version-mismatch error rather than failing deeper in.

## Phone / iOS

- **iOS suspends the AudioContext** whenever the app backgrounds, the screen locks, or the audio
  session is taken — *including on pause*. So `ensureAudio()` (which recreates a `closed` context)
  and `audioAlive()` are called **before every cue**, not once at startup. Without that the dings
  go silent after the first pause.
- `reviveSession()` runs on `visibilitychange` / `focus` / `online`: re-acquires the wake lock,
  resumes audio, revalidates the token, reconnects the SDK if `!sdkId`, and re-syncs against
  `/me/player`.
- Token refresh is **single-flight** (`refreshToken()` / `ensureToken(force)`, `SKEW_MS = 120000`)
  in `index.html`, `workout.html` and `calendar.html`, so concurrent callers can't race on Spotify's
  rotating refresh token. (`workout.html` only gained it in November 2026; before that `ensureToken(true)`
  ignored `force` and `e.fatal` was never set. `analyze.html` still lacks it.) `api()` retries network
  errors, 429 and 5xx with backoff, and forces one refresh + retry on 401.
- Layout uses `dvh` and `env(safe-area-inset-*)`; without the insets the landscape view clipped
  into the notch.
- Handoff to the Spotify app: `livePosition()` captures position + `performance.now()`;
  `startupAllowance()` (`LSD.handoffLeadMs`, default 550 ms) self-corrects toward measured drift;
  `doHandoff()` starts the target with an explicit `position_ms`, then applies the shuffle
  preference, then opens `spotify://`.

## Performance

The editor once took ~50 s to load because it downloaded every track's full analysis record
(~783 KB for 20 tracks). Fixes: `GET /api/analysis?view=summary` returns a slim projection
(~60 KB) cached in `server.py` against `(st_mtime_ns, st_size)`, and `loadAnalysis()` is
fire-and-forget — the timeline draws immediately and redraws when analysis arrives. **Don't make
the analysis fetch blocking again, and don't fetch the full records in the editor.**

## Hotspots — tread carefully

1. **`workout.html`'s `beginPlayback()` / handoff / completion path.** By far the most-regressed
   code here. It has been broken by a fix to something adjacent at least four times. Change it in
   small steps and re-verify the whole sequence (start → pause → external pause → finish → modal →
   handoff), not just the thing you touched.
2. **`"use strict"` plus block-level rewrites.** Deleting or moving a block frequently orphaned an
   identifier it defined; under strict mode that throws `ReferenceError` and **aborts the rest of
   the function**. The symptom is rarely an obvious error: when `thisDeviceWord` went missing the
   visible result was "no WORKOUT COMPLETE modal, but the 'logged workout' toast still appeared",
   because the async log call had already gone out before the throw. After moving or deleting a
   block, grep for every identifier it defined. UI side-effects like `cueDone()` are wrapped in
   try/catch for exactly this reason.
3. **Multi-patch edit scripts.** Twice a batch script hit an assertion on a later patch and exited
   **before writing the file**, so an earlier fix reported as applied was never on disk — once for
   the shuffle fix, once for the EBU R128 batch. Both times the next session's evidence said the
   fix had been "reverted". **Verify writes by grepping the file afterwards.** A passing syntax
   check on a file that was never written proves nothing.
4. **Adding an analysis metric touches four places**: `METRICS` in `analysis-core.js`, the graph
   dropdown + lane drawing + tooltip in `index.html`, and the table column selector in
   `analyze.html`. Miss one and the metric half-exists.
5. **Three separate auth implementations** (`index.html`, `workout.html`, `calendar.html`).
   `workout.html`'s and `index.html`'s are the hardened ones. `calendar.html`'s is deliberately different: it loads
   history from `LSD.ns` **first** and only confirms identity via `/me` afterwards, because the
   original order produced an empty calendar with a one-line error whenever Spotify hiccuped.
   Consolidating these into a shared module is tempting and would be a real improvement — but it
   means one change can break all three pages at once, so do it with a full manual pass over each.
6. **Clock sync** (`workout.html` and the editor's run-through). Latency compensation and slewing
   are tuned; changing the constants reintroduces either flicker or drift.
7. **The editor's timeline draw path** runs on every pan, zoom and hover. Anything added there is
   in the hot loop.

## Operational notes

- `data/` holds everything that matters and is gitignored. It was scrubbed from git history once;
  if it ever lands in a public remote again, revoke at spotify.com/account/apps and reconnect.
- **There is no authentication in front of the state API.** It's namespaced by Spotify identity,
  not protected by it — anyone who can reach the port can read and write any namespace. Acceptable
  for a household tunnel; not for the open internet. This was an explicit, informed choice.
- Watch out for pasting README diagrams into `server.py` — a box-drawing character from the
  project tree once landed in the Python file and produced
  `SyntaxError: invalid character '├'`.

## On reporting work in this repo

The project owner has caught invented content three times: guessed feature ranges presented as
analysis, a described change to the completion modal that didn't exist, and a shuffle fix reported
as applied that was never written to disk. The working agreement that came out of that:

- If you don't know what something refers to, **say so** rather than reconstructing it plausibly.
- If a verification tool you built turns out to be unreliable, **discard it and say so** instead of
  reporting a false all-clear. (An undeclared-identifier scanner was written, found to produce
  false positives, and thrown away for this reason.)
- Verify that an edit landed by reading the file back, not by trusting the tool that made it.

## TODO / discussed but not built

- **Extend zoom past 64×.** The cap was set when the canvas could overflow; now that drawing is
  virtualized the limit is arbitrary.
- **Volume control for the workout dings** — they're aggressive over a quiet cooldown.
- **Analysis-driven suggestions**: use the stored measurements to propose track reorderings that
  eliminate peak clashes, and expand the clash checker beyond song transitions (e.g. flag a peak
  interval running under a track whose measured tempo is below the user's reference).
- **`After=cloudflared.service`** in `pulseline.service`, if a strict start order is ever wanted.
- **Consolidate the three auth layers** into a shared module — see hotspot 5 for the risk.
- **Per-metric axis locking** so switching the graph metric doesn't rescale the lane.
- **Auth in front of the state API**, required before this is exposed anywhere untrusted.