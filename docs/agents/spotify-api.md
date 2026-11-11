# Spotify Web API: rules and reference

Read this before touching any code that calls Spotify. The rules come from Spotify's own guidance for building on the Web API. Behavioural quirks learned the hard way are in `README.md` under **Spotify API quirks**; this file doesn't repeat them.

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
| Token refresh | ✅ Single-flight refresh, with re-auth only on an explicit 400/401 (README *Phone / iOS*). |
| 429 / Retry-After | ⚠️ `api()` in `index.html` and `workout.html` honours `Retry-After` (default 2 s) but makes at most 3 attempts with fixed waits for 5xx, which is not exponential. ❌ `analyze.html`'s `api()` ignores `Retry-After` and retries a 429 every 2 s with **no cap**, a tight loop the rules forbid. `calendar.html` has no `api()` wrapper. #1, #2 |
| Deprecated endpoints | ⚠️ `index.html` `loadTracks()` / `saveOrder()` still fall back to the deprecated `/playlists/{id}/tracks` on a 403/404 (remembered in `LSD.plResource`). #3 |
| Minimal scopes | Decided 2026-11-10: every page requests the **same union** of scopes, because all pages share one stored token. An editor login without `streaming` silently broke in-app playback. #5 should trim the union, not split it per page. Previously: ❓ Not reviewed. The editor asks for `playlist-read-collaborative` and both `playlist-modify-*`; `workout.html` asks for `user-read-email` / `user-read-private` (Spotify's Web Playback SDK docs list these alongside `streaming`, which needs re-checking). #5 |
| Error messages | ⚠️ Errors surface as `Spotify <status>: <first 140 chars>`. The JSON `error.message` isn't parsed out. #4 |
| Caching / Terms | ❓ Not reviewed. Server state keeps track lists (name, artists, duration) per workspace, and `analysis.json` stores track name and artists next to the measurements. Whether that counts as "immediate use" is an open question. #6 |

Issue numbers refer to GitHub issues on GhostCrab/pulseline (label `spotify-api`). Update this table when a row changes. ⚠️ means a known gap; ❓ means not yet assessed.
