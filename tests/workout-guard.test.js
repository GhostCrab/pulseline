/* Tests for workout.html's run-loop containment helper, against the real source.
 *
 * Run:  node --test tests/
 *
 * workout.html is one 1300-line inline <script> that cannot be evaluated outside a
 * browser: `const cvs=$("#tl"), ctx=cvs.getContext("2d")` runs at module-evaluation
 * time, and the boot IIFE fires on load and reaches the network. So this extracts just
 * the containment helper by brace matching and evaluates that, with clog and toast
 * stubbed. It is the real shipped text, not a copy - if someone edits guardRun in the
 * page, these tests see the edit.
 *
 * What this does NOT cover: whether tick() and setPaused() actually call it correctly.
 * That needs the full sequence on a device - see scripts/hitl-workout.sh. The point of
 * the helper is that such a failure is now reported and recorded (as a `loopFail` entry
 * that scripts/clientlog.py reports) instead of silently freezing the countdown.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { readPage, extractFunction: extractFrom, stripComments } = require("./_page.js");

const src = readPage("workout.html");
const extractFunction = name => extractFrom(src, name);

/* Builds a fresh instance of the helper with its module-level latch, plus spies.
 * `loopFailed` is declared in the page next to guardRun; it is redeclared here so the
 * latch behaviour is exercised without dragging in the rest of the script. */
function freshGuard() {
  const calls = { clog: [], toast: [] };
  const factory = new Function("clog", "toast",
    "let loopFailed=null;\n" + extractFunction("guardRun") + "\nreturn guardRun;");
  const guardRun = factory(
    (type, data) => calls.clog.push({ type, data }),
    (msg, ms) => calls.toast.push({ msg, ms }));
  return { guardRun, calls };
}

test("the page still defines guardRun and the latch beside it", () => {
  assert.match(src, /let loopFailed=null;/, "the per-run latch is gone");
  assert.match(extractFunction("guardRun"), /catch/, "guardRun no longer catches");
});

test("a successful call reports nothing and returns true", () => {
  const { guardRun, calls } = freshGuard();
  let ran = false;
  assert.equal(guardRun("The timeline", () => { ran = true; }), true);
  assert.equal(ran, true);
  assert.deepEqual(calls.clog, []);
  assert.deepEqual(calls.toast, []);
});

test("a throw is contained: it returns false rather than propagating", () => {
  const { guardRun } = freshGuard();
  assert.doesNotThrow(() => {
    assert.equal(guardRun("The timeline", () => { throw new Error("songY is not defined"); }),
      false);
  });
});

test("a throw is recorded to the client log with its label and message", () => {
  const { guardRun, calls } = freshGuard();
  guardRun("The timeline", () => { throw new ReferenceError("songY is not defined"); });
  assert.equal(calls.clog.length, 1);
  assert.equal(calls.clog[0].type, "loopFail", "scripts/clientlog.py keys on this type");
  assert.equal(calls.clog[0].data.label, "The timeline");
  assert.equal(calls.clog[0].data.msg, "songY is not defined");
});

test("a throw is surfaced to the user, and says the workout continues", () => {
  // CODING_STANDARDS.md: every fallback is visible. A contained failure that nobody
  // is told about is the silent case this whole fix exists to remove.
  const { guardRun, calls } = freshGuard();
  guardRun("The timeline", () => { throw new Error("songY is not defined"); });
  assert.equal(calls.toast.length, 1);
  assert.match(calls.toast[0].msg, /The timeline/);
  assert.match(calls.toast[0].msg, /songY is not defined/);
  assert.match(calls.toast[0].msg, /still running/);
});

test("the same label repeating does NOT report again", () => {
  // tick() runs ~60 times a second: without the latch a broken draw would emit 60
  // toasts and 60 log entries per second, and the log caps at 50 entries per flush.
  const { guardRun, calls } = freshGuard();
  for (let i = 0; i < 100; i++) {
    guardRun("The timeline", () => { throw new Error("boom"); });
  }
  assert.equal(calls.clog.length, 1, "one log entry for 100 failures");
  assert.equal(calls.toast.length, 1, "one toast for 100 failures");
});

test("a different label reports separately", () => {
  const { guardRun, calls } = freshGuard();
  guardRun("The timeline", () => { throw new Error("a"); });
  guardRun("The interval ding", () => { throw new Error("b"); });
  assert.deepEqual(calls.clog.map(c => c.data.label),
    ["The timeline", "The interval ding"]);
});

test("a non-Error throw still produces a message", () => {
  const { guardRun, calls } = freshGuard();
  guardRun("The timeline", () => { throw "just a string"; });
  assert.equal(calls.clog[0].data.msg, "just a string");
});

test("a throw with an empty message still reports something", () => {
  const { guardRun, calls } = freshGuard();
  guardRun("The timeline", () => { throw new Error(""); });
  assert.equal(calls.toast.length, 1);
  assert.match(calls.toast[0].msg, /The timeline/);
});

/* ---- the structural guarantee the helper cannot provide on its own ---- */


const { finallyBody } = require("./_page.js");

test("tick schedules the next frame from inside its finally block", () => {
  // guardRun protects the calls it wraps; the finally is what protects the loop from a
  // throw anywhere else in tick. Asserted structurally because the loop itself cannot
  // be evaluated outside a browser.
  assert.match(finallyBody(extractFunction("tick")), /requestAnimationFrame\(tick\)/,
    "the reschedule must sit inside the finally, or a throw can still kill the loop");
});

test("tick has exactly one reschedule, and it is the guarded one", () => {
  const code = stripComments(extractFunction("tick"));
  const all = code.match(/requestAnimationFrame\(tick\)/g) || [];
  assert.equal(all.length, 1, "a second unguarded reschedule would defeat the finally");
});

test("setPaused schedules the clock from inside its finally block", () => {
  assert.match(finallyBody(extractFunction("setPaused")), /requestAnimationFrame\(tick\)/,
    "the clock start must sit inside the finally: a throw above it used to leave the "
    + "button reading PAUSE with nothing counting");
});

test("setPaused starts the polls from inside its finally block too", () => {
  const body = finallyBody(extractFunction("setPaused"));
  assert.match(body, /startPoll\(\)/, "live sync must start even if the body threw");
  assert.match(body, /startPausePoll\(\)/, "the pause poll must start on the paused path");
});

/* ---- api(): how a successful response body is read ---- */

/* Builds api() with every dependency injected, and a fetch stub that behaves like
 * WebKit: Response.json() on an EMPTY body throws, with Safari's exact message.
 * That is what a real iPhone produced in data/clientlog-u_ghostcrab.jsonl. */
function freshApi(responses) {
  const calls = [];
  let i = 0;
  const fetchStub = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET" });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: () => null },
      text: async () => r.body,
      json: async () => {
        if (!r.body) {
          throw new SyntaxError("The string did not match the expected pattern.");
        }
        return JSON.parse(r.body);
      },
    };
  };
  const logged = [];
  /* api() reaches clog two ways: bare on the !r.ok path, and through window.clog for
     the unparseable-body path (so that only workout.html need define it). In the page
     both resolve to the same function, so inject both and record to one list. */
  const factory = new Function("ensureToken", "fetch", "netBad", "netOK", "clog", "window",
    extractFunction("api") + ";\nreturn api;");
  const record = (type, data) => logged.push({ type, data });
  const api = factory(async () => "tok", fetchStub, () => {}, () => {},
    record, { clog: record });
  return { api, calls, logged };
}

test("a 204 success returns null without touching the body", async () => {
  const { api } = freshApi([{ status: 204, body: "" }]);
  assert.equal(await api("/me/player/shuffle?state=false", { method: "PUT" }), null);
});

test("REGRESSION: a 200 with an EMPTY body is a success, not a parse error", async () => {
  /* The field failure. Spotify's player commands are documented as 204 but can answer
   * 200 with no content; api() called r.json() on anything that was not exactly 204, and
   * on WebKit that throws "The string did not match the expected pattern."
   *
   * Observed on an iPhone: PUT /me/player/shuffle and /repeat both failed with that
   * message, no `api` entry was logged because the response was fine, and shuffle stayed
   * on - so the symptom read as "Pulseline cannot turn shuffle off". */
  const { api } = freshApi([{ status: 200, body: "" }]);
  assert.equal(await api("/me/player/shuffle?state=false", { method: "PUT" }), null);
});

test("a 200 with a JSON body is parsed", async () => {
  const { api } = freshApi([{ status: 200, body: '{"is_playing":true}' }]);
  assert.deepEqual(await api("/me/player"), { is_playing: true });
});

test("a 202 with an empty body is also a success", async () => {
  const { api } = freshApi([{ status: 202, body: "" }]);
  assert.equal(await api("/me/player/pause", { method: "PUT" }), null);
});

test("REGRESSION: a 2xx with an unparseable body is a success, and is recorded", async () => {
  /* Second round of the same field bug. With the empty-body case fixed, an iPhone then
   * reported `JSON Parse error: Unexpected identifier "RupOGcf..."` from
   * PUT /me/player/shuffle - a 2xx carrying a short non-JSON token. Throwing there
   * turned a command Spotify had ACCEPTED into a reported failure, which is what made
   * it look like Pulseline could not turn shuffle off.
   *
   * A 2xx is a success and the body is informational. It is recorded rather than
   * swallowed, so it stays diagnosable. */
  const { api, logged } = freshApi([{ status: 200, body: "RupOGcfsumG098JKNl0Dx0MFITk" }]);
  assert.equal(await api("/me/player/shuffle?state=false", { method: "PUT" }), null);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, "apiBody");
  assert.equal(logged[0].data.status, 200);
  assert.equal(logged[0].data.head, "RupOGcfsumG098JKNl0Dx0MFITk");
  assert.equal(logged[0].data.path, "/me/player/shuffle", "query stripped");
});

test("a recorded body is truncated, so one response cannot fill the log", async () => {
  // append_log caps a line at 2000 chars and truncates AFTER serialising, which would
  // leave invalid JSON in the file.
  const { api, logged } = freshApi([{ status: 200, body: "x".repeat(5000) }]);
  await api("/me/player");
  assert.equal(logged[0].data.head.length, 120);
});

test("a failed response still logs an api entry and throws with the status", async () => {
  const { api, logged } = freshApi([{ status: 403, body: '{"error":{"message":"nope"}}' }]);
  await assert.rejects(() => api("/me/player/shuffle?state=false", { method: "PUT" }),
    /Spotify 403/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, "api");
  assert.equal(logged[0].data.status, 403);
  assert.equal(logged[0].data.msg, "nope");
});

test("the absence of an api log entry means the response was fine", async () => {
  // This is the inference that located the bug: the client log showed the calls
  // failing with no `api` entry, which is only possible on a success path.
  const { api, logged } = freshApi([{ status: 200, body: "" }]);
  await api("/me/player/repeat?state=off", { method: "PUT" });
  assert.deepEqual(logged, []);
});

/* ---- applySync: the decision from sync-core, applied and reported ---- */

/* Builds applySync with stub W, P and toast, so the latch behaviour and the clock
 * effects can be exercised without a browser. */
function freshApply() {
  const toasts = [];
  const logged = [];
  const W = { warned: { shuffle: false, noMatch: false, order: false } };
  const P = { t: 100, slew: 0, last: 0 };
  // applySync records its verdict through logSyncOnce, so both come across together.
  const factory = new Function("W", "P", "toast", "performance", "clog",
    extractFunction("logSyncOnce") + "\n" + extractFunction("applySync")
    + "\nreturn applySync;");
  const applySync = factory(W, P, (m) => toasts.push(m), { now: () => 12345 },
    (type, data) => logged.push({ type, data }));
  return { applySync, W, P, toasts, logged };
}

test("a noUri decision changes nothing and says nothing", () => {
  // The SDK reports no track_window between tracks. Telling the user about that would
  // fire a shuffle warning every time the player blinked.
  const { applySync, P, toasts } = freshApply();
  applySync({ action: "none", diagnosis: "noUri" });
  assert.equal(P.t, 100);
  assert.equal(P.slew, 0);
  assert.deepEqual(toasts, []);
});

test("a noMatch decision warns about shuffle and leaves the clock alone", () => {
  const { applySync, P, W, toasts } = freshApply();
  applySync({ action: "none", diagnosis: "noMatch" });
  assert.equal(P.t, 100, "the clock must not be yanked to a span that does not match");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /shuffle may be on/);
  assert.equal(W.warned.noMatch, true);
});

test("a snap sets the clock, clears the slew and restamps the frame time", () => {
  const { applySync, P } = freshApply();
  applySync({ action: "snap", to: 250, diagnosis: null });
  assert.equal(P.t, 250);
  assert.equal(P.slew, 0);
  assert.equal(P.last, 12345, "P.last must be restamped or the next frame's dt is wrong");
});

test("a slew records the outstanding correction without moving the clock", () => {
  const { applySync, P } = freshApply();
  applySync({ action: "slew", by: -1.5, diagnosis: null });
  assert.equal(P.t, 100);
  assert.equal(P.slew, -1.5);
});

test("order drift is reported AND the correction is still applied", () => {
  const { applySync, P, toasts } = freshApply();
  applySync({ action: "snap", to: 250, diagnosis: "orderDrift" });
  assert.equal(P.t, 250, "the warning must not suppress the correction");
  assert.match(toasts[0], /order doesn't match/);
});

test("each warning fires once per run", () => {
  const { applySync, toasts } = freshApply();
  for (let i = 0; i < 20; i++) applySync({ action: "none", diagnosis: "noMatch" });
  assert.equal(toasts.length, 1);
});

test("the warning latches are independent of each other", () => {
  /* They used to share one W.orderWarned, which sprang into existence from whichever
   * fired first - so a shuffle warning silenced the order-drift warning for the rest
   * of the run. */
  const { applySync, W, toasts } = freshApply();
  W.warned.shuffle = true;                       // the start-up read-back already fired
  applySync({ action: "none", diagnosis: "noMatch" });
  applySync({ action: "slew", by: 0.2, diagnosis: "orderDrift" });
  assert.equal(toasts.length, 2, "an earlier warning must not silence a different one");
});

test("applySync tolerates W being cleared mid-flight", () => {
  // backToSplash() sets W = null, and a poll response can land after that.
  const factory = new Function("W", "P", "toast", "performance", "clog",
    extractFunction("logSyncOnce") + "\n" + extractFunction("applySync")
    + "\nreturn applySync;");
  const P = { t: 100, slew: 0, last: 0 };
  const applySync = factory(null, P, () => {}, { now: () => 1 }, () => {});
  assert.doesNotThrow(() => applySync({ action: "none", diagnosis: "noMatch" }));
  assert.doesNotThrow(() => applySync({ action: "snap", to: 5, diagnosis: "orderDrift" }));
  assert.doesNotThrow(() => applySync({ action: "slew", by: 1, diagnosis: null }));
});

test("applySync records the live-sync verdict once per kind", () => {
  // The only direct evidence of whether the audio followed the timeline.
  const { applySync, logged } = freshApply();
  applySync({ action: "slew", by: 0.2, diagnosis: null });
  applySync({ action: "slew", by: 0.3, diagnosis: null });
  assert.deepEqual(logged.map(l => [l.type, l.data.diagnosis]), [["syncDiag", "inOrder"]]);

  applySync({ action: "snap", to: 200, diagnosis: "orderDrift" });
  applySync({ action: "snap", to: 210, diagnosis: "orderDrift" });
  assert.deepEqual(logged.map(l => l.data.diagnosis), ["inOrder", "orderDrift"]);
});

test("a recorded verdict says WHERE in the run it happened", () => {
  /* Without at/total, a noMatch logged after the workout finished looks identical to
   * one at the start. endWorkout leaves the music rolling for the cooldown, so Spotify
   * carries on past the playlist and sync legitimately stops matching - a real session
   * logged exactly that and it was reported as a failure. */
  const { applySync, logged, W, P } = freshApply();
  W.total = 470;
  P.t = 471;
  applySync({ action: "none", diagnosis: "noMatch" });
  const d = logged[0].data;
  assert.equal(d.at, 471, "the clock position is recorded");
  assert.equal(d.total, 470, "the workout length is recorded");
  assert.equal(d.done, true, "past the end is marked as such");
});

test("a verdict during the workout is not marked done", () => {
  const { applySync, logged, W, P } = freshApply();
  W.total = 470;
  P.t = 30;
  applySync({ action: "snap", to: 200, diagnosis: "orderDrift" });
  assert.equal(logged[0].data.done, false);
  assert.equal(logged[0].data.at, 30);
});

test("applySync does not record a verdict for a player blink", () => {
  const { applySync, logged } = freshApply();
  applySync({ action: "none", diagnosis: "noUri" });
  assert.deepEqual(logged, []);
});

/* ---- playBody: what Spotify is asked to play ---- */

/* The page's PLAY_URI_MAX, read out of the source rather than restated here. */
const PLAY_URI_MAX = Number(src.match(/const PLAY_URI_MAX=(\d+);/)[1]);

function playBody(tracks, key) {
  const factory = new Function(
    "const PLAY_URI_MAX=" + PLAY_URI_MAX + ";\n"
    + extractFunction("playBody") + ";\nreturn playBody;");
  return factory()(tracks, key);
}

const tracksOf = n => Array.from({ length: n }, (_, i) => ({ uri: "spotify:track:t" + i }));

test("a normal workout starts from an explicit, ordered uri list", () => {
  /* The fix for the real bug. Measured 2026-11-11: shuffle read off immediately before
   * play, on immediately after, and live sync saw a track outside the workout at 0m00s
   * of a 20m00s run. quirk 4 means that cannot be undone after play, so the only remedy
   * is to give Spotify no context to reshuffle. */
  const body = playBody(tracksOf(7), "4SKmbOB");
  assert.deepEqual(body, { uris: tracksOf(7).map(t => t.uri), position_ms: 0 });
  assert.ok(!("context_uri" in body), "a context start is what gets reshuffled");
});

test("the uri list preserves timeline order", () => {
  const body = playBody(tracksOf(5), "k");
  assert.deepEqual(body.uris,
    ["spotify:track:t0", "spotify:track:t1", "spotify:track:t2",
     "spotify:track:t3", "spotify:track:t4"]);
});

test("exactly at the bound still uses the uri list", () => {
  assert.ok(playBody(tracksOf(PLAY_URI_MAX), "k").uris);
});

test("above the bound falls back to the playlist context", () => {
  const body = playBody(tracksOf(PLAY_URI_MAX + 1), "4SKmbOB");
  assert.equal(body.context_uri, "spotify:playlist:4SKmbOB");
  assert.deepEqual(body.offset, { position: 0 });
  assert.ok(!body.uris);
});

test("an empty or unusable track list falls back to the context", () => {
  for (const tracks of [[], null, undefined, [{}], [{ uri: null }]]) {
    const body = playBody(tracks, "k");
    assert.equal(body.context_uri, "spotify:playlist:k",
      `${JSON.stringify(tracks)} should fall back`);
  }
});

test("tracks without a uri are dropped rather than sent as holes", () => {
  const body = playBody([{ uri: "a" }, {}, { uri: "b" }, { uri: null }], "k");
  assert.deepEqual(body.uris, ["a", "b"]);
});

test("every start sets position_ms so a resumed device cannot start mid-track", () => {
  assert.equal(playBody(tracksOf(3), "k").position_ms, 0);
  assert.equal(playBody(tracksOf(PLAY_URI_MAX + 1), "k").position_ms, 0);
});

test("the shuffle settle round trip is skipped for a uri start", () => {
  /* Verified on a device: the Spotify app showed shuffle on for a whole 20-minute run
   * and playback stayed in order, because a uris start takes its order from the request.
   * So the settle-and-verify GET is only worth its ~300ms on the START gesture when a
   * context start is coming. */
  const fn = stripComments(extractFunction("forceLinearPlayback"));
  assert.match(fn, /shuffleMatters/, "the start mode is not considered at all");
  assert.match(fn, /if\(!shuffleMatters\)return ok;/,
    "the settle step is not gated on the start mode");
  const gate = fn.indexOf("if(!shuffleMatters)return ok;");
  assert.ok(fn.indexOf('/me/player/repeat') < gate,
    "repeat must still be set: repeat=track would loop one track and desync the clock");
  assert.ok(fn.lastIndexOf('api("/me/player")') > gate,
    "the verify GET must sit after the gate, or it is not skipped");
});

test("the start mode is decided before the linear sequence runs", () => {
  // forceLinearPlayback needs to know whether shuffle matters, so playBody comes first.
  const fn = stripComments(extractFunction("beginPlayback"));
  assert.ok(fn.indexOf("playBody(") < fn.indexOf("forceLinearPlayback("),
    "playBody must be computed before forceLinearPlayback is called");
});

test("the shuffle warning only fires when shuffle can affect the order", () => {
  // A warning that fires on a working setup teaches you to ignore warnings.
  const fn = stripComments(extractFunction("beginPlayback"));
  assert.match(fn, /if\(!body\.uris&&!linear/,
    "the shuffle toast is not gated on the start mode");
});

/* ---- handoffBody: what the target device is asked to play ---- */

function handoffBody(p, key) {
  return new Function(extractFunction("handoffBody") + ";\nreturn handoffBody;")()(p, key);
}

test("REGRESSION: the handoff plays the workout's playlist, not the SDK's placeholder context", () => {
  /* Measured on the real SDK 2026-11-14: after a uris start the in-app player reports
   * its context as "spotify:webapi" - truthy, and not a playable context. The handoff
   * sent it and Spotify answered `400 Invalid context uri`, on an iPhone and again in
   * desktop Chrome. Nothing was handed off; pressing play in Spotify then took over the
   * bare track list, so no playlist showed and shuffle-after-handoff had nothing to
   * shuffle. With the workout's own playlist the same request answered 204 and carried
   * on from the same position.
   *
   * This replaces a structural test that asserted the source contained `p.ctx||`,
   * which is the exact expression that was wrong. */
  const body = handoffBody({ ctx: "spotify:webapi", uri: "spotify:track:now" }, "4SKmbOB");
  assert.deepEqual(body,
    { context_uri: "spotify:playlist:4SKmbOB", offset: { uri: "spotify:track:now" } });
});

test("the handoff uses the workout's playlist when no context is reported at all", () => {
  // Spotify-app mode: GET /me/player reports `context: null` for a uris start.
  const body = handoffBody({ ctx: null, uri: "spotify:track:now" }, "4SKmbOB");
  assert.equal(body.context_uri, "spotify:playlist:4SKmbOB");
  assert.deepEqual(body.offset, { uri: "spotify:track:now" });
});

test("without a workout playlist, a reported playlist, album or artist context is used", () => {
  // The spec's valid contexts for /me/player/play: albums, artists and playlists.
  for (const ctx of ["spotify:playlist:abc", "spotify:album:abc", "spotify:artist:abc"]) {
    assert.equal(handoffBody({ ctx, uri: "spotify:track:now" }, null).context_uri, ctx);
  }
});

test("without a workout playlist, an unplayable context falls back to the single track", () => {
  for (const ctx of ["spotify:webapi", "", null, undefined]) {
    assert.deepEqual(handoffBody({ ctx, uri: "spotify:track:now" }, null),
      { uris: ["spotify:track:now"] }, `${JSON.stringify(ctx)} was sent as a context`);
  }
});

test("doHandoff builds its request through handoffBody", () => {
  const fn = stripComments(extractFunction("doHandoff"));
  assert.match(fn, /handoffBody\(p,/, "doHandoff no longer uses the tested body builder");
  assert.ok(!/context_uri/.test(fn), "doHandoff builds a context request of its own");
});

/* ---- the boot gate must be reachable ---- */

test("spansOf defers its PLSync lookup to call time", () => {
  /* The boot gate reports a missing or stale sync-core.js, and it can only do that if
   * the script finishes evaluating first. `const spansOf=PLSync.spansOf` would throw a
   * ReferenceError during evaluation, before the gate runs, leaving a blank page and no
   * message at all - the gate would be dead code in the one case it exists for.
   *
   * Tested behaviourally: run the real declaration with no PLSync in scope. */
  const decl = src.match(/const spansOf=[^\n]*/)[0];
  const define = new Function(decl + "\nreturn spansOf;");
  let spansOf;
  assert.doesNotThrow(() => { spansOf = define(); },
    "the declaration dereferences PLSync while evaluating");
  assert.equal(typeof spansOf, "function");
  // And it really does go through PLSync when called, rather than having been inlined.
  assert.throws(() => spansOf([]), /PLSync/);
});

test("no top-level statement dereferences PLSync outside a function", () => {
  /* The general form of the rule above. Peel every balanced {...} block, which leaves
   * top-level statements; any PLSync left must belong to an arrow with an expression
   * body (deferred), not to an immediate dereference. */
  let code = stripComments(src.slice(src.indexOf('<script>\n"use strict"')));
  let prev;
  do {
    prev = code;
    code = code.replace(/\{[^{}]*\}/g, " ");
  } while (code !== prev);
  const offenders = code.split(";")
    .filter(stmt => stmt.includes("PLSync") && !stmt.includes("=>"))
    .map(s => s.trim().slice(0, 80));
  assert.deepEqual(offenders, [],
    "PLSync dereferenced during evaluation, so the boot gate cannot run");
});

test("the boot gate checks both presence and version", () => {
  const boot = stripComments(src);
  assert.match(boot, /if\(!window\.PLSync\)/, "no presence check");
  assert.match(boot, /PLSync\.SYNC_VERSION!==NEEDS_SYNC/, "no version check");
  assert.match(boot, /const NEEDS_SYNC=\d+;/, "no NEEDS_SYNC constant for check.py to pin");
});

test("setPaused sets P.playing before anything that can throw", () => {
  // The finally block branches on P.playing, so it must already be correct by then.
  const code = stripComments(extractFunction("setPaused"));
  const assigned = code.indexOf("P.playing=!pause");
  const tryAt = code.search(/\btry\s*\{/);
  assert.notEqual(assigned, -1, "P.playing is no longer assigned from `pause`");
  assert.notEqual(tryAt, -1, "setPaused no longer has a try block");
  assert.ok(assigned < tryAt,
    "P.playing must be assigned before the try, or the finally schedules the wrong thing");
});
