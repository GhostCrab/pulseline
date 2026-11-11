/* Contract tests: every Spotify call the pages make, checked against the OpenAPI spec.
 *
 * Run:  node --test tests/
 *
 * CODING_STANDARDS.md says new or changed Spotify calls must use endpoints, fields and
 * scopes "as they appear in docs/spotify/open-api-schema.yaml". Until now nothing
 * enforced that but review. These tests do, with no credentials and no network: the
 * spec is a 7500-line file already in the repo.
 *
 * What this catches: calling a path that does not exist, calling it with a method it
 * does not support, needing a scope the login does not request, and silently picking up
 * an endpoint Spotify has marked deprecated.
 *
 * What it does NOT catch: whether Spotify's live behaviour matches its own spec, and
 * anything about audio. The spec is a description, not the server. See
 * docs/DEVELOPING.md "Verifying the playback path".
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SPEC = path.join(ROOT, "docs", "spotify", "open-api-schema.yaml");

/* js-yaml is a declared devDependency. If `npm install` has not been run, say so
 * clearly and skip rather than failing with a module-not-found, the way check.py skips
 * its ESLint pass. CI always has it. */
let yaml = null;
try { yaml = require("js-yaml"); } catch { /* reported below */ }

/* Pages that talk to Spotify. calendar.html is included because it makes one raw
 * fetch rather than going through an api() wrapper. */
const PAGES = ["index.html", "workout.html", "analyze.html", "calendar.html",
               path.join("debug", "sdk-probe.html")];

/* Call sites that build the final path segment at runtime. Listed explicitly so the
 * contract still checks concrete paths rather than waving a wildcard at the spec.
 * If a new branch is added to one of these call sites, this map goes stale - which is
 * why each entry names the code that produces it. */
const DYNAMIC = {
  // workout.html setPaused(): api("/me/player/"+(pause?"pause":"play"))
  "/me/player/": ["/me/player/pause", "/me/player/play"],
  // index.html playlistResource, which is "items" or "tracks" (LS key plResource)
  "/playlists/{}/{}": ["/playlists/{playlist_id}/items", "/playlists/{playlist_id}/tracks"],
};

/* Scopes the login requests that no called endpoint's `security` block declares, each
 * with why it is still needed. Pinned so that adding an unnecessary scope fails this
 * suite instead of passing unnoticed, and so that a scope here going unused is caught
 * too. docs/agents/spotify-api.md "Minimal scopes" tracks trimming the union.
 *
 * Note what is NOT here: the spec says GET /me requires user-read-email and
 * user-read-private, so those are ordinary requirements rather than SDK extras. */
const SCOPES_BEYOND_SPEC = {
  "streaming":
    "Web Playback SDK requirement. No REST endpoint declares it, and a token without "
    + "it produces LIVE badge, no sound, no error (quirk 8).",
  "playlist-read-collaborative":
    "Needed for collaborative playlists to appear in GET /me/playlists. The spec's "
    + "security block for that endpoint lists only playlist-read-private.",
};

/* Deprecated endpoints the code can still reach, and why that is accepted for now.
 * A NEW deprecated usage fails the suite; these are recorded with their justification
 * rather than leaving the suite permanently red, which would train everyone to ignore
 * it. Tracked as #3 in docs/agents/spotify-api.md's status table. */
const KNOWN_DEPRECATED = [
  // index.html loadTracks()/saveOrder() fall back to this on a 403/404, remembering the
  // working resource in LS key `plResource`. The non-deprecated /items is tried first.
  "POST /playlists/{playlist_id}/tracks",
  "PUT /playlists/{playlist_id}/tracks",
];

function readPage(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}

/* Normalise a source path expression to the spec's path-template shape:
 * strip the query string, and turn each `${...}` into a `{}` placeholder. */
function normalise(raw) {
  let p = raw.replace(/\$\{[^}]*\}/g, "{}");
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  return p;
}

/* Path prefixes that belong to the Spotify Web API. The server's own routes all live
 * under /api/, so there is no overlap to confuse. */
const SPOTIFY_PREFIXES = ["/me", "/playlists/", "/search", "/tracks", "/albums",
                          "/artists", "/users/"];

const isSpotifyPath = p =>
  SPOTIFY_PREFIXES.some(pre => p === pre || p.startsWith(pre));

/* Every Spotify path the pages reference, as {page, path, method, source, raw}.
 *
 * Two sources, because they can be trusted to different depths:
 *   "call"    - a literal directly inside api(...) or a v1 fetch(...), so the method
 *               is readable from the same call site.
 *   "literal" - a Spotify path in a string anywhere else in the page. These matter:
 *               index.html and analyze.html build "/me/playlists?limit=50" into a
 *               variable and hand it to api(url) for pagination, so an api()-only
 *               extractor silently skips them. The method cannot be known here, so
 *               these are checked for existence only.
 */
function collectCalls() {
  const calls = [];
  const callPatterns = [
    /\bapi\(\s*(["`])([^"`]*)\1/g,
    /fetch\(\s*(["`])https:\/\/api\.spotify\.com\/v1([^"`]*)\1/g,
  ];
  const literalPattern = /(["`])(\/[A-Za-z0-9_${}./?=&,:-]*)\1/g;

  for (const page of PAGES) {
    const src = readPage(page);
    const seen = new Set();

    for (const re of callPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        /* Must be a path, not an empty capture. The fetch pattern otherwise matches
         * api()'s OWN `fetch("https://api.spotify.com/v1"+path)` in every page that
         * defines a wrapper, which yielded a phantom empty-path call site. */
        if (!m[2].startsWith("/")) continue;
        // Look ahead a bounded window for this call's method, defaulting to GET.
        const window = src.slice(m.index, m.index + 240);
        const method = (window.match(/method\s*:\s*["'](\w+)["']/) || [, "GET"])[1];
        const p = normalise(m[2]);
        seen.add(p);
        calls.push({ page, raw: m[2], path: p, method: method.toLowerCase(),
                     source: "call" });
      }
    }

    literalPattern.lastIndex = 0;
    let m;
    while ((m = literalPattern.exec(src)) !== null) {
      const p = normalise(m[2]);
      if (!isSpotifyPath(p) || seen.has(p)) continue;
      seen.add(p);
      calls.push({ page, raw: m[2], path: p, method: null, source: "literal" });
    }
  }
  return calls;
}

/* Resolve one normalised path to the concrete spec paths it can hit. */
function resolve(p) {
  if (DYNAMIC[p]) return DYNAMIC[p];
  return [p];
}

/* Match a path carrying `{}` placeholders against a spec template like
 * /playlists/{playlist_id}/tracks - segment count must agree, and a `{}` matches
 * exactly one of the spec's own `{param}` segments. */
function specPathFor(specPaths, p) {
  if (specPaths[p]) return p;
  const want = p.split("/");
  for (const cand of Object.keys(specPaths)) {
    const got = cand.split("/");
    if (got.length !== want.length) continue;
    const ok = want.every((seg, i) =>
      seg === got[i] || (seg === "{}" && /^\{.*\}$/.test(got[i])));
    if (ok) return cand;
  }
  return null;
}

function loginScopes() {
  /* The one scope list, which scripts/check.py already proves is identical across the
   * pages that log in - so reading the first is sufficient. */
  for (const page of PAGES) {
    const m = readPage(page).match(/scope\s*:\s*"([a-z\- ]+)"/);
    if (m) return m[1].split(/\s+/).filter(Boolean);
  }
  throw new Error("no login scope list found in any page");
}

if (!yaml) {
  test("spotify contract", { skip: "js-yaml not installed - run `npm install`" }, () => {});
} else {
  const spec = yaml.load(fs.readFileSync(SPEC, "utf8"));
  const specPaths = spec.paths || {};
  const calls = collectCalls();

  /* Operations the pages actually use, de-duplicated. */
  const operations = [];
  for (const call of calls) {
    for (const concrete of resolve(call.path)) {
      operations.push({ ...call, concrete });
    }
  }

  test("the spec parses and has the paths section", () => {
    // No threshold on the count: the number of paths in the spec is Spotify's business
    // and inventing a floor for it would be exactly the kind of made-up number
    // docs/DEVELOPING.md forbids. Anchor on paths this app actually depends on instead.
    assert.equal(typeof specPaths, "object");
    assert.ok(Object.keys(specPaths).length > 0, "no paths parsed from the spec");
    for (const anchor of ["/me", "/me/player", "/me/playlists"]) {
      assert.ok(specPaths[anchor], `spec no longer describes ${anchor}`);
    }
  });

  test("call sites were actually found (guards the extractor itself)", () => {
    // Without this, a regex that silently matches nothing would make every other
    // test in this file vacuously true.
    assert.ok(calls.length >= 12, `only found ${calls.length} Spotify call sites`);
    const pagesSeen = new Set(calls.map(c => c.page));
    for (const p of ["index.html", "workout.html", "calendar.html"]) {
      assert.ok(pagesSeen.has(p), `no Spotify calls extracted from ${p}`);
    }
  });

  test("every path the pages call exists in the spec", () => {
    const missing = [];
    for (const op of operations) {
      if (!specPathFor(specPaths, op.concrete)) {
        missing.push(`${op.page}: ${op.raw} -> ${op.concrete}`);
      }
    }
    assert.deepEqual(missing, [], "paths not present in open-api-schema.yaml");
  });

  test("every path is called with a method the spec defines for it", () => {
    const wrong = [];
    for (const op of operations.filter(o => o.source === "call")) {
      const key = specPathFor(specPaths, op.concrete);
      if (!key) continue;                       // reported by the test above
      if (!specPaths[key][op.method]) {
        const allowed = Object.keys(specPaths[key])
          .filter(k => ["get", "put", "post", "delete"].includes(k));
        wrong.push(`${op.page}: ${op.method.toUpperCase()} ${key} `
          + `(spec allows ${allowed.join(", ").toUpperCase() || "nothing"})`);
      }
    }
    assert.deepEqual(wrong, [], "method not defined for that path");
  });

  test("the login requests every scope the called endpoints require", () => {
    const have = new Set(loginScopes());
    const missing = new Map();
    for (const op of operations.filter(o => o.source === "call")) {
      const key = specPathFor(specPaths, op.concrete);
      const spec_op = key && specPaths[key][op.method];
      if (!spec_op) continue;
      for (const sec of spec_op.security || []) {
        for (const scope of sec.oauth_2_0 || []) {
          if (!have.has(scope)) {
            missing.set(scope, `${op.method.toUpperCase()} ${key} (${op.page})`);
          }
        }
      }
    }
    assert.deepEqual([...missing.entries()], [],
      "endpoints need a scope the login does not request");
  });

  /* Scopes declared by the `security` block of every operation the pages call. */
  function requiredScopes() {
    const required = new Set();
    for (const op of operations.filter(o => o.source === "call")) {
      const key = specPathFor(specPaths, op.concrete);
      const spec_op = key && specPaths[key][op.method];
      if (!spec_op) continue;
      for (const sec of spec_op.security || []) {
        for (const scope of sec.oauth_2_0 || []) required.add(scope);
      }
    }
    return required;
  }

  test("the login requests no scope beyond what is needed", () => {
    // The union is deliberate - one stored token serves every page - but it should be
    // exactly what is required plus the documented extras, not a grab bag.
    const required = requiredScopes();
    const extra = loginScopes()
      .filter(s => !required.has(s) && !(s in SCOPES_BEYOND_SPEC));
    assert.deepEqual(extra, [],
      "scopes requested that no called endpoint requires and that are not justified "
      + "in SCOPES_BEYOND_SPEC");
  });

  test("every documented extra scope is still actually requested", () => {
    // Stops SCOPES_BEYOND_SPEC rotting into a list of justifications for scopes the
    // login no longer asks for.
    const have = new Set(loginScopes());
    const stale = Object.keys(SCOPES_BEYOND_SPEC).filter(s => !have.has(s));
    assert.deepEqual(stale, [], "listed in SCOPES_BEYOND_SPEC but no longer requested");
  });

  test("no documented extra scope is in fact required by the spec", () => {
    // The inverse: if Spotify's spec starts declaring one of these, it stops being an
    // unexplained extra and the justification should be deleted.
    const required = requiredScopes();
    const nowRequired = Object.keys(SCOPES_BEYOND_SPEC).filter(s => required.has(s));
    assert.deepEqual(nowRequired, [],
      "the spec now declares this scope, so remove it from SCOPES_BEYOND_SPEC");
  });

  test("the deprecated endpoints in use are exactly the known, documented ones", () => {
    const inUse = new Set();
    for (const op of operations.filter(o => o.source === "call")) {
      const key = specPathFor(specPaths, op.concrete);
      const spec_op = key && specPaths[key][op.method];
      if (spec_op && spec_op.deprecated === true) {
        inUse.add(`${op.method.toUpperCase()} ${key}`);
      }
    }
    assert.deepEqual([...inUse].sort(), [...KNOWN_DEPRECATED].sort(),
      "deprecated-endpoint usage changed - if a new one is deliberate, record it in "
      + "KNOWN_DEPRECATED and in spotify-api.md's status table");
  });

  test("the player endpoints the fragile path depends on are all present", () => {
    // Named explicitly: these are the calls beginPlayback / doHandoff / live sync make,
    // so a spec update that drops or renames one should fail loudly here rather than
    // surface as a 404 mid-workout.
    for (const [p, method] of [["/me/player", "get"], ["/me/player", "put"],
                               ["/me/player/play", "put"], ["/me/player/pause", "put"],
                               ["/me/player/shuffle", "put"], ["/me/player/repeat", "put"],
                               ["/me/player/devices", "get"], ["/me", "get"]]) {
      assert.ok(specPaths[p], `spec no longer describes ${p}`);
      assert.ok(specPaths[p][method], `spec no longer allows ${method.toUpperCase()} ${p}`);
    }
  });

  test("the quirk-4 ordering endpoints all require a scope we hold", () => {
    // activate -> shuffle off -> repeat off -> play. If any one of these needed a scope
    // the login lacked, forceLinearPlayback would half-apply and the symptom would be
    // "shuffle is still on" rather than an auth error.
    const have = new Set(loginScopes());
    for (const p of ["/me/player", "/me/player/shuffle", "/me/player/repeat",
                     "/me/player/play"]) {
      for (const sec of specPaths[p].put.security || []) {
        for (const scope of sec.oauth_2_0 || []) {
          assert.ok(have.has(scope), `PUT ${p} needs ${scope}, which the login omits`);
        }
      }
    }
  });
}
