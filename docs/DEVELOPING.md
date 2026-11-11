# Developing Pulseline

The developer handbook. User-facing behaviour is specified in `README.md`; Spotify Web API rules and
quirks are in `docs/agents/spotify-api.md`.

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

## Environments

- **Development and testing** happen on a separate build/test machine, against a local server
  (`python3 server.py`, then `http://127.0.0.1:8888/`). Nothing there touches production data.
  Register `http://127.0.0.1:8888/` (and `…/workout.html`) as redirect URIs in the Spotify
  dashboard so local logins work.
- **Production** is `/opt/pulseline` on a Debian Pi 5 (systemd unit `pulseline.service`), served
  through a Cloudflare tunnel at `pulseline.pielow.io`. Deploy by updating the checkout there and
  `sudo systemctl restart pulseline` (needed only for `server.py` changes; pages are served no-cache).
- **Checks** run anywhere: `python3 scripts/check.py`. Run `git config core.hooksPath .githooks`
  once per clone to run them on every commit, and `npm install` to enable the ESLint pass.
  CI runs the same script on every push.
- **Client diagnostics**: `workout.html` appends Spotify player events and API failures to
  `data/clientlog-<ns>.jsonl` through `POST /api/log/<ns>`. Read that file first when playback
  misbehaves. `debug/sdk-probe.html` is a standalone in-app-player probe for deeper digging.

## Storage model — read this before touching persistence

Three stores with three different sets of rules. Mixing them up is how data gets lost.

| store | where | namespacing | write semantics |
|---|---|---|---|
| `Store` | `data/state-u_<spotify-id>.json` | per Spotify account | **POST shallow-merges** (`cur.update(payload)`) |
| history | `data/history-u_<spotify-id>.json` | per Spotify account | append / delete **ops only**, never wholesale |
| analysis | `data/analysis.json` | **shared, not per user** | put / delete / clear, plus a cached summary view |
| client log | `data/clientlog-u_<spotify-id>.jsonl` | per Spotify account | `POST /api/log/<ns>` appends `{entries:[…]}`; never read by the app; rotated to `.1` past 1 MB |
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
