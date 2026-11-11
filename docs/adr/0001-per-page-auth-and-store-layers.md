# Auth and store layers are duplicated per page

**Status:** accepted

Each page re-implements its own auth and store layer rather than sharing a module, so that a page
can be opened **standalone**: the phone loads `workout.html` through the Cloudflare tunnel and
nothing else, so no page may depend on another page having run first. This is a deliberate choice,
not copy-paste debt. Background: `docs/DEVELOPING.md` *Shape of the thing* — "The duplication is
deliberate."

## What is actually duplicated

`CLAUDE.md` says the auth and `api()` code is "duplicated in every page", and `CODING_STANDARDS.md`
lists four copies. Both are shorthand. The verified shape is uneven, and the unevenness is the part
worth knowing:

- **Two login implementations**, `index.html` and `workout.html`. These are the only two pages that
  can start a login, and the only two carrying a `scope:` list. Hotspot 5 calls them the hardened
  copies.
- **Four token-refresh implementations** — `index.html`, `workout.html`, `calendar.html`,
  `analyze.html` — plus a fifth in `debug/sdk-probe.html`.
- **Three `api()` wrappers** of differing depth, in `index.html`, `workout.html` and
  `analyze.html`, plus a fourth of a different shape in `debug/sdk-probe.html`.
  `calendar.html` has **no** `api()` at all: it makes exactly one raw `fetch` to `/me`
  (`calendar.html:187`), which is consistent with Hotspot 5 describing it as deliberately minimal.

So "every page" is four pages for refresh, three for `api()`, and two for login. A change to the
login path cannot be mechanically propagated to `calendar.html` or `analyze.html`, because they have
no login to change.

## Consequences

- A change is complete only when it has landed on every copy **that has the thing being changed**,
  or the diff explains why that page differs. This is the review rule in `CODING_STANDARDS.md`
  ("Auth and API changes land on every page").
- `scripts/check.py`'s `scopes` check enforces the one mechanical part: identical login scope lists.
  Note its reach — it only sees pages containing a literal `scope:"…"`, so it compares exactly
  `index.html` and `workout.html` and is blind to the other pages by construction. That is
  sufficient today, because those are the only pages that log in, but it is not a four-page guard.
- The duplication has already cost one real bug: one page's login was missing the `streaming`
  scope, producing a silent in-app playback failure on iOS (fixed in `5186151`). The `scopes` check
  exists because of it.
- **Some differences are deliberate.** `calendar.html` loads history from `LSD.ns` first and
  confirms identity via `/me` afterwards, because the original order produced an empty calendar with
  a one-line error whenever Spotify hiccuped (Hotspot 5). `workout.html`'s `redirectUri` keeps the
  filename because `…/workout.html` is its own registered redirect URI.
- **Some differences are known drift, not design.** `analyze.html`'s refresh still lacks
  single-flight and token skew, recorded in `docs/DEVELOPING.md` *Phone / iOS* as
  "`analyze.html` still lacks it".
- Therefore: before "fixing" a difference between copies, establish which kind it is — a hardening
  the others lack, a deviation that is load-bearing for that page, or genuine drift. Do not assume.

## Considered options

Consolidating the copies into one shared module is tempting and would be a real improvement in
locality. It is recorded as rejected-for-now rather than rejected outright: the blocker is that a
single change would then be able to break every page at once, so it may only be done with a full
manual pass over each page. Do not propose it as an incidental refactor inside other work.
