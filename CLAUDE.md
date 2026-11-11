# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pulseline lines up a Spotify playlist against a programmed interval workout on a shared timeline. It is a no-build, no-dependency web app: plain HTML pages with inline `<script>` blocks, plus a stdlib-only Python server. There is no package manager, bundler, linter, or test suite.

## Running

```bash
python3 server.py                 # http://127.0.0.1:8888/
python3 server.py 9000 0.0.0.0    # [port] [host]; also PULSELINE_PORT / PULSELINE_HOST env vars
```

Must be opened via `http://127.0.0.1:<port>/` (not `localhost`) — Spotify's PKCE redirect URI is matched character-for-character, including the trailing slash.

This checkout at `/opt/pulseline` is also the deployed copy run by the systemd unit `pulseline.service` (user `pulseline`, `ProtectSystem=full`, only `data/` writable). After changing files: `sudo systemctl restart pulseline`; logs via `journalctl -u pulseline -f`. Server changes need a restart; static file changes do not (pages, `.js`, `.json` are served `no-cache`).

## Architecture

**Pages** — each is a self-contained app with its own copy of helpers:
- `index.html` — desktop editor: playlists, interval program, timeline/minimap, run-through mode, live Spotify Connect sync.
- `workout.html` — phone in-workout player (PWA via `manifest.json`); Web Playback SDK ("This app") or Spotify Connect ("Spotify app"), audio cues via WebAudio, wake lock, handoff to the Spotify app at finish.
- `calendar.html` — workout history (calendar + list).
- `analyze.html` — captures Spotify output through a virtual loopback device and runs Essentia.js on it; `analysis-core.js` wraps the vendored Essentia algorithms (`vendor/`, AGPL — don't modify).

Spotify auth (PKCE token refresh, `api()` fetch wrapper with retry/backoff/401-refresh) is **deliberately duplicated in each page** so each can load standalone (the phone opens only `workout.html` via the tunnel). A fix to auth or API retry logic usually needs applying to every page that has one. They had drifted apart. Single-flight token refresh (`refreshPromise`) is in `index.html`, `workout.html` and `calendar.html`, but not yet in `analyze.html`. All pages share one stored token (`pl_tok`), so **every page's login must request the same scopes** (README *Spotify API quirks* 8). `calendar.html` intentionally loads history from `LSD.ns` before confirming identity via `/me`.

Script includes use cache-busting query strings (e.g. `analysis-core.js?v=8`); bump `?v=` when changing a shared `.js` file.

**Two storage scopes** (see comment near the top of the `index.html` script):
- `localStorage`, keys prefixed `pl_` (`LSD` helper): per-device secrets — client ID, Spotify tokens, PKCE verifier. Deliberately never sent to the server.
- Server state (`Store` helper, debounced ~400 ms saves): per-user data namespaced by Spotify user id `u_<id>`.

**Server API** (`server.py`, all JSON under `data/`, atomic writes with `.bak/.bak1/.bak2` rotation):
- `GET/POST /api/state/<ns>` → `data/state-<ns>.json`. POST **shallow-merges** top-level keys (a client can't delete a key by omitting it) and strips any `history` key. `/api/state` without ns is the legacy/anon file.
- `GET/POST /api/history/<ns>` → `data/history-<ns>.json`. POST only accepts `{op:"add",entry}` (idempotent by `id`) or `{op:"delete",id}` — never wholesale overwrite. Legacy history inside a state file is migrated on first read (`seed_history`).
- `GET/POST /api/analysis` → shared `data/analysis.json` keyed by Spotify track id (not per-user: analysis describes the recording). POST ops: `put`/`delete`/`clear`. `?view=summary` returns a slim cached projection (`SUMMARY_KEEP`) used by the editor.

These append/merge-only semantics exist to prevent stale clients from wiping data; preserve them.

**Spotify API notes:** uses the Feb 2026 API shape (`/playlists/{id}/items`, entries under `.item`) with a fallback to legacy `/tracks` on 403/404. Playlist contents are only readable for playlists the user owns. Live sync only runs on un-edited (saved) playlists. Playback turns off shuffle/repeat before starting so timeline alignment holds.

## Spotify Web API

Before any change that calls Spotify, read `docs/agents/spotify-api.md`. It has Spotify's rules for API clients, how to look things up in the local OpenAPI spec (`docs/spotify/open-api-schema.yaml`), and where Pulseline currently falls short. **Never guess an endpoint, field or scope; grep the spec.**

## Read before changing things

`README.md` is both the user-facing spec and the developer handbook. Its second half is required reading for the area you touch:
- **Spotify API quirks**: Feb 2026 API shape, shuffle/repeat order of operations, `progress_ms` latency compensation, and which errors count as a dead session.
- **Hotspots**: `workout.html`'s `beginPlayback()` → pause → finish → handoff path is the most-regressed code. Re-verify that whole sequence after any change.
- **Storage model**, **Caching and version skew**, **Phone / iOS**, **Layout and canvas quirks**.

## Working agreement (from the project owner)

- **No invented numbers.** If documentation or research doesn't give a range, threshold or constant, say so instead of guessing one.
- **Verify that edits landed** by grepping or reading the file afterwards. Twice a multi-patch script exited before writing, and a fix was reported as applied when it wasn't.
- Under `"use strict"`, moving or deleting a block can orphan an identifier and throw a `ReferenceError` mid-function. Grep for every identifier the block defined.
- If you don't know what something refers to, say so rather than reconstructing it plausibly.

## Conventions

- `data/` is runtime state, gitignored — never commit it.
- Keep `README.md` in sync with behavior changes.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for GhostCrab/pulseline (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
