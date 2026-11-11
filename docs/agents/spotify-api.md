# Spotify Web API: rules and reference

Read this before touching any code that calls Spotify. The rules come from Spotify's own guidance for building on the Web API. Behavioural quirks learned the hard way are at the end, under **Quirks learned the hard way**.

## Source of truth: the OpenAPI spec

A copy of Spotify's spec lives at `docs/spotify/open-api-schema.yaml` (fetched 2026-11-10 from https://developer.spotify.com/reference/web-api/open-api-schema.yaml).

**Never guess an endpoint, parameter, field name or scope.** Look it up:

```bash
S=docs/spotify/open-api-schema.yaml
grep -n '^  /' $S                                        # every path
sed -n '/^  \/me\/player\/play:/,/^  \/[a-z]/p' $S        # one path's full definition
awk '/^  \//{p=$1} /deprecated: true/{print p}' $S | sort -u   # deprecated paths
```

Refresh it with `curl -sfL -o docs/spotify/open-api-schema.yaml <url above>` and update the date here. If the live spec disagrees with this copy, the live one wins.

## Rules

1. **Auth:** use Authorization Code with PKCE for user data ([guide](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)). Never use Implicit Grant, and never put a Client Secret in client code. Use Client Credentials only for public, non-user data.
2. **Redirect URIs:** HTTPS only, except `http://127.0.0.1` for local development. Never use `http://localhost` or wildcards ([requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).
3. **Scopes:** request only the scopes the features actually use ([list](https://developer.spotify.com/documentation/web-api/concepts/scopes)). Each endpoint's required scopes are under `security: oauth_2_0:` in the spec.
4. **Tokens:** store them securely and refresh them ([guide](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)). When the refresh token itself is dead, send the user through authorization again.
5. **Rate limits:** on a 429, honour `Retry-After` and back off exponentially. Never retry immediately or in a tight loop.
6. **Deprecated endpoints:** don't use them. Use `/playlists/{id}/items`, not `/playlists/{id}/tracks`, and `/me/library`, not the type-specific library endpoints.
7. **Errors:** handle the error codes the spec documents for each endpoint, and show the user Spotify's returned error message in useful terms.
8. **Developer Terms** ([terms](https://developer.spotify.com/terms)): don't cache Spotify content beyond what immediate use needs, always attribute content to Spotify, and never use Spotify data to train ML models.

## Where Pulseline stands (checked 2026-11-10)

| Rule | Status |
|---|---|
| PKCE, no secret | ✅ All pages use PKCE. `config.js` holds only the public Client ID. |
| Redirect URIs | ✅ `127.0.0.1` locally, HTTPS through the tunnel. The editor warns about non-loopback plain HTTP. |
| Token refresh | ✅ Single-flight refresh, with re-auth only on an explicit 400/401 (`docs/DEVELOPING.md` *Phone / iOS*). |
| 429 / Retry-After | ⚠️ `api()` in `index.html` and `workout.html` honours `Retry-After` (default 2 s) but makes at most 3 attempts with fixed waits for 5xx, which is not exponential. ❌ `analyze.html`'s `api()` ignores `Retry-After` and retries a 429 every 2 s with **no cap**, a tight loop the rules forbid. `calendar.html` has no `api()` wrapper. #1, #2 |
| Deprecated endpoints | ⚠️ `index.html` `loadTracks()` / `saveOrder()` still fall back to the deprecated `/playlists/{id}/tracks` on a 403/404 (remembered in `LSD.plResource`). #3 |
| Minimal scopes | Decided 2026-11-10: every page requests the **same union** of scopes, because all pages share one stored token. An editor login without `streaming` silently broke in-app playback. #5 should trim the union, not split it per page. Previously: ❓ Not reviewed. The editor asks for `playlist-read-collaborative` and both `playlist-modify-*`; `workout.html` asks for `user-read-email` / `user-read-private` (Spotify's Web Playback SDK docs list these alongside `streaming`, which needs re-checking). #5 |
| Error messages | ⚠️ Errors surface as `Spotify <status>: <first 140 chars>`. The JSON `error.message` isn't parsed out. #4 |
| Caching / Terms | ❓ Not reviewed. Server state keeps track lists (name, artists, duration) per workspace, and `analysis.json` stores track name and artists next to the measurements. Whether that counts as "immediate use" is an open question. #6 |

Issue numbers refer to GitHub issues on GhostCrab/pulseline (label `spotify-api`). Update this table when a row changes. ⚠️ means a known gap; ❓ means not yet assessed.

## Quirks learned the hard way

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
   SIMULATED with a message. `debug/sdk-probe.html` (logs every SDK event plus each API status) is
   what pinned this down. No automated seam reaches the SDK, so there's no regression test.
