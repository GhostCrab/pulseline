/* Tests for the START sequence in workout.html, against the real source.
 *
 * Run:  node --test tests/
 *
 * Same seam as workout-guard.test.js: functions lifted out of the page by brace matching
 * and evaluated with their dependencies injected.
 *
 * The SDK states replayed here are NOT invented. They were captured from the real Web
 * Playback SDK in desktop Chrome on 2026-11-14 with debug/start-probe.js, which records
 * every player_state_changed event next to every Spotify API call. What that showed:
 * between the START tap and our own play command landing, the SDK reports the PREVIOUS
 * session - paused, the old track, the old position - first with loading:true and then
 * with loading:false. The page treated those as facts about the workout.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { readPage, extractFunction: extractFrom } = require("./_page.js");
const PLSync = require("../sync-core.js");

const src = readPage("workout.html");
const extractFunction = name => extractFrom(src, name);

/* A 3-track workout; durations only matter for where each span starts. */
const TRACKS = [
  { uri: "spotify:track:first", durMs: 180000 },
  { uri: "spotify:track:second", durMs: 200000 },
  { uri: "spotify:track:third", durMs: 220000 },
];
const sdkState = (uri, positionMs, paused, loading) => ({
  paused, loading, position: positionMs, track_window: { current_track: { uri } } });

/* The page just after the START tap: clock running from 0, play not yet sent. */
function freshPage() {
  const toasts = [], logged = [], pauses = [];
  const W = { live: true, spans: PLSync.spansOf(TRACKS), total: 1200,
              warned: { shuffle: false, noMatch: false, order: false } };
  const P = { t: 0.2, playing: true, started: true, slew: 0, last: 0 };
  // The real setPaused does far more; what the handler depends on is that it flips
  // P.playing, so the stub does exactly that and records the call.
  const setPaused = pause => { pauses.push(pause); P.playing = !pause; };
  const factory = new Function(
    "W", "P", "target", "setPaused", "PLSync", "toast", "performance", "clog",
    extractFunction("logSyncOnce") + "\n" + extractFunction("applySync") + "\n"
    + extractFunction("onSdkState") + "\nreturn onSdkState;");
  const onSdkState = factory(W, P, "sdk", setPaused, PLSync, m => toasts.push(m),
    { now: () => 0 }, (type, data) => logged.push({ type, data }));
  return { onSdkState, W, P, toasts, logged, pauses };
}

test("REGRESSION: the previous session's state does not move the clock before play is sent", () => {
  /* Captured: the last session stopped 55.6s into the first track. 205ms after START
   * the SDK reported exactly that, loading:true, and the clock jumped from 0 to 55.61
   * with "Playback order doesn't match the timeline". The same thing on a phone, with a
   * leftover position past the end of the workout, logged `at:1261,total:1200,done:true`
   * one second after START (data/clientlog, 2026-11-11). */
  const { onSdkState, P, toasts, logged } = freshPage();
  onSdkState(sdkState("spotify:track:first", 55606, true, true));
  assert.equal(P.t, 0.2, "the clock was snapped to where the LAST session stopped");
  assert.deepEqual(toasts, []);
  assert.deepEqual(logged, [], "a stale state must not be recorded as a sync verdict");
});

test("REGRESSION: the previous session's paused state does not pause the workout", () => {
  /* Captured 5ms after the one above: the same stale state with loading:false. The page
   * paused its own workout - button RESUME, clock frozen - until play landed, which was
   * 0.8s later on a healthy network and 7s later with Spotify answering slowly. */
  const { onSdkState, P, pauses } = freshPage();
  onSdkState(sdkState("spotify:track:first", 55606, true, false));
  assert.deepEqual(pauses, [], "the workout paused itself before any audio had started");
  assert.equal(P.playing, true);
});

test("REGRESSION: a leftover track from outside the workout raises no shuffle warning", () => {
  /* Captured on a healthy run: the previous session was a track not in this workout, and
   * 259ms after START the user was told "Spotify is playing a track that isn't in this
   * workout - shuffle may be on". Nothing was playing and shuffle was irrelevant. */
  const { onSdkState, toasts, logged } = freshPage();
  onSdkState(sdkState("spotify:track:somewhere-else", 116658, true, true));
  assert.deepEqual(toasts, []);
  assert.deepEqual(logged, []);
});

test("a stale paused state that arrives after play is sent is still ignored", () => {
  // Captured: the old paused state kept arriving for ~500ms after play answered 204.
  const { onSdkState, W, P, pauses } = freshPage();
  W.playSent = true;
  onSdkState(sdkState("spotify:track:first", 55606, true, false));
  assert.deepEqual(pauses, []);
  assert.equal(P.t, 0.2);
});

test("the first playing state after play is sent starts live sync", () => {
  /* The healthy case, so the gate cannot quietly swallow sync altogether. Captured:
   * {paused:false, loading:true, position:0} on the first workout track. The clock had
   * been running since the tap, so it is pulled back toward the audio. */
  const { onSdkState, W, P, toasts, logged } = freshPage();
  W.playSent = true;
  P.t = 1.7;                                   // healthy network: audio ~1.7s after the tap
  onSdkState(sdkState("spotify:track:first", 0, false, true));
  assert.equal(P.slew, -1.7, "a small gap is absorbed, not jumped");
  assert.deepEqual(toasts, [], "a normal start must not warn about anything");
  assert.deepEqual(logged.map(l => l.data.diagnosis), ["inOrder"]);
});

test("a slow start snaps the clock back to the audio without crying shuffle", () => {
  // Slow network: 7s between the tap and the audio. Larger than SNAP_SEC, well under
  // ORDER_DRIFT_SEC, so it is a plain snap to the start and not an order warning.
  const { onSdkState, W, P, toasts } = freshPage();
  W.playSent = true;
  P.t = 7;
  onSdkState(sdkState("spotify:track:first", 0, false, false));
  assert.equal(P.t, 0);
  assert.deepEqual(toasts, []);
});

test("once the audio has been heard, an outside pause still pauses the workout", () => {
  // The gate is for the start only: a headphone or lock-screen pause must still land.
  const { onSdkState, W, P, pauses } = freshPage();
  W.playSent = true;
  onSdkState(sdkState("spotify:track:first", 0, false, false));
  onSdkState(sdkState("spotify:track:first", 30000, true, false));
  assert.deepEqual(pauses, [true]);
  assert.equal(P.playing, false);
  // ...and an outside resume un-pauses it.
  onSdkState(sdkState("spotify:track:first", 30000, false, false));
  assert.deepEqual(pauses, [true, false]);
});

test("nothing is handled before START, or once the run is no longer live", () => {
  const a = freshPage();
  a.P.started = false;
  a.W.playSent = true;
  a.onSdkState(sdkState("spotify:track:second", 5000, false, false));
  assert.equal(a.P.t, 0.2);

  const b = freshPage();
  b.W.live = false;
  b.W.playSent = true;
  b.onSdkState(sdkState("spotify:track:second", 5000, false, false));
  assert.equal(b.P.t, 0.2);
  assert.doesNotThrow(() => b.onSdkState(null));
});

/* ---- reviveSession: coming back to the app while START is still in flight ---- */

function freshRevive({ heard, target = "sdk" }) {
  const pauses = [];
  const W = { live: true, heard };
  const P = { started: true, playing: true };
  const factory = new Function(
    "W", "P", "target", "sdk", "sdkId", "grabWake", "ensureAudio", "ensureToken", "toast",
    "api", "setPaused",
    "let reviving=false;\n" + extractFunction("reviveSession") + "\nreturn reviveSession;");
  const revive = factory(W, P, target, { connect: async () => {} }, "dev1", () => {}, () => {},
    async () => "tok", () => {}, async () => ({ is_playing: false }),
    pause => pauses.push(pause));
  return { revive, pauses };
}

test("returning to the app before the audio has started does not pause the workout", async () => {
  /* The same false pause as onSdkState's, by another door: reviveSession runs on every
   * focus and visibilitychange, asks Spotify whether it is playing, and pauses the
   * workout if not. While START is in flight the honest answer is "not yet". */
  const { revive, pauses } = freshRevive({ heard: false });
  await revive();
  assert.deepEqual(pauses, []);
});

test("returning to the app after playback stopped elsewhere still pauses the workout", async () => {
  const inApp = freshRevive({ heard: true });
  await inApp.revive();
  assert.deepEqual(inApp.pauses, [true]);
  // Spotify-app mode has no SDK to hear from, so it is not gated on it.
  const connect = freshRevive({ heard: undefined, target: "connect" });
  await connect.revive();
  assert.deepEqual(connect.pauses, [true]);
});

/* ---- beginPlayback: what is sent, in what order, and on behalf of which run ---- */

const PLAY_URI_MAX = Number(src.match(/const PLAY_URI_MAX=(\d+);/)[1]);
const manyTracks = n => Array.from({ length: n },
  (_, i) => ({ uri: "spotify:track:t" + i, durMs: 1000 }));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(r => setImmediate(r));

/* Builds beginPlayback with the real playBody and forceLinearPlayback beside it, and a
 * scripted api(). `W` is a module-level `let` in the page and is REASSIGNED when a new
 * run starts, so it is declared inside the factory and swapped through setW - injecting
 * it as a parameter could not express "the run changed underneath a start in flight". */
function freshBegin({ respond = () => null, sdkReady = Promise.resolve("dev1") } = {}) {
  const calls = [], toasts = [], logged = [], badge = { textContent: "", className: "" };
  const api = (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body });
    return Promise.resolve().then(() => respond(path, opts));
  };
  const factory = new Function(
    "target", "hasStreamScope", "sdk", "initSdk", "api", "clog", "toast", "$",
    "navigator", "setTimeout",
    "let W=null,sdkErrTimes=[],sdkId='dev1';\nconst PLAY_URI_MAX=" + PLAY_URI_MAX + ";\n"
    + extractFunction("playBody") + "\n" + extractFunction("forceLinearPlayback") + "\n"
    + extractFunction("beginPlayback")
    + "\nreturn {begin:beginPlayback,setW:w=>{W=w}};");
  const page = factory("sdk", () => true, { activateElement: async () => {} },
    () => sdkReady, api, (type, data) => logged.push({ type, data }),
    m => toasts.push(m), () => badge, { userAgent: "test" }, () => 0);
  const newRun = (n = 3) => ({ live: true, key: "pl1", ws: { tracks: manyTracks(n) },
    warned: { shuffle: false, noMatch: false, order: false } });
  const sent = () => calls.map(c => c.method + " " + c.path.split("?")[0]);
  return { ...page, newRun, calls, sent, toasts, logged, badge };
}

test("a track-list start sends play FIRST, with nothing queued ahead of it", async () => {
  /* Measured on the real SDK with Spotify's shuffle and repeat calls slowed to what a
   * phone logged on 2026-11-13 (4s and 2.5s): play was not even SENT until 7.0s after
   * START, behind PUT /me/player, /shuffle and /repeat. Those three exist for a context
   * start, where shuffle must be off before play (spotify-api.md quirk 4). A uris start
   * takes its order from the request, so nothing needs to precede it. */
  const p = freshBegin();
  p.setW(p.newRun());
  await p.begin();
  assert.equal(p.sent()[0], "PUT /me/player/play");
  assert.deepEqual(p.calls[0].body.uris.slice(0, 2), ["spotify:track:t0", "spotify:track:t1"]);
  assert.match(p.calls[0].path, /device_id=dev1/, "play must name the in-app device itself");
});

test("a track-list start never sends the device transfer", async () => {
  // PUT /me/player {play:false} arriving AFTER play would pause what was just started.
  const p = freshBegin();
  p.setW(p.newRun());
  await p.begin();
  await settle();
  assert.ok(!p.sent().includes("PUT /me/player"),
    "the transfer was sent: " + p.sent().join(", "));
});

test("repeat is still switched off on a track-list start, after play", async () => {
  // repeat=track would loop the first song and desync the clock however playback began.
  const p = freshBegin();
  p.setW(p.newRun());
  await p.begin();
  await settle();
  const s = p.sent();
  assert.ok(s.includes("PUT /me/player/repeat"), "repeat was never sent");
  assert.ok(s.indexOf("PUT /me/player/repeat") > s.indexOf("PUT /me/player/play"));
});

test("START does not wait for the repeat call", async () => {
  const hang = deferred();
  const p = freshBegin({ respond: path => (/repeat|shuffle/.test(path) ? hang.promise : null) });
  p.setW(p.newRun());
  const done = await Promise.race([p.begin(), settle().then(settle).then(() => "still waiting")]);
  assert.equal(done, true, "beginPlayback is blocked behind a call that is not needed for audio");
});

test("a repeat call that fails is said out loud; a shuffle call that fails is not", async () => {
  // CODING_STANDARDS: every fallback is visible - and a finding says nothing about a
  // healthy run. On a uris start shuffle is cosmetic, so only repeat is worth a toast.
  const failing = which => freshBegin({ respond: path => {
    if (path.includes(which)) throw new Error("Spotify 502");
    return null;
  } });
  const a = failing("/repeat");
  const runA = a.newRun();
  a.setW(runA);
  await a.begin();
  await settle();
  assert.equal(a.toasts.length, 1);
  assert.match(a.toasts[0], /repeat/i);
  assert.equal(runA.live, true, "a failed repeat call must not drop the run to simulated");

  const b = failing("/shuffle");
  b.setW(b.newRun());
  await b.begin();
  await settle();
  assert.deepEqual(b.toasts, []);
});

test("a healthy track-list start says nothing at all", async () => {
  const p = freshBegin();
  const run = p.newRun();
  p.setW(run);
  await p.begin();
  await settle();
  assert.deepEqual(p.toasts, []);
  assert.equal(run.live, true);
  assert.equal(run.playSent, true, "onSdkState's gate would never open");
});

test("a context start keeps the full order: transfer, shuffle, repeat, verify, play", async () => {
  // Above PLAY_URI_MAX there is a context for Spotify to shuffle, so quirk 4 still rules.
  const p = freshBegin({
    respond: path => (path === "/me/player" ? { shuffle_state: false } : null) });
  p.setW(p.newRun(PLAY_URI_MAX + 1));
  await p.begin();
  assert.deepEqual(p.sent(), ["PUT /me/player", "PUT /me/player/shuffle",
    "PUT /me/player/repeat", "GET /me/player", "PUT /me/player/play"]);
  assert.equal(p.calls[4].body.context_uri, "spotify:playlist:pl1");
});

test("REGRESSION: a start abandoned for a new run never sends its play", async () => {
  /* data/clientlog 2026-11-13: three STARTs 13s apart on one page load, and each one's
   * chain ran to completion - two interleaved shuffle/repeat pairs and a play apiece.
   * Every late play restarts the first track from 0:00 under the run that replaced it. */
  const ready = deferred();
  const p = freshBegin({ sdkReady: ready.promise });
  p.setW(p.newRun());
  const old = p.begin();                 // waiting for the in-app player
  p.setW(p.newRun());                    // the user went back and started again
  ready.resolve("dev1");
  await old;
  await settle();
  assert.deepEqual(p.sent(), [], "the abandoned start still talked to Spotify");
});

test("REGRESSION: an abandoned start's failure does not flip the new run to SIMULATED", async () => {
  /* Same log: the first start's play failed with a 502 eleven seconds in, by which time
   * a new run was on screen - and the catch wrote W.live=false onto THAT run. */
  const play = deferred();
  const p = freshBegin({ respond: path => (path.includes("/play") ? play.promise : null) });
  p.setW(p.newRun());
  const old = p.begin();
  await settle();
  const next = p.newRun();
  p.setW(next);
  play.reject(new Error("Spotify 502"));
  await old;
  assert.equal(next.live, true, "the new run was dropped to simulated by the old one's failure");
  assert.deepEqual(p.toasts, []);
  assert.equal(p.badge.textContent, "", "the badge was rewritten by a run that is gone");
  assert.equal(p.logged.filter(l => l.type === "beginFail").length, 1, "still recorded");
});

test("a failure of the CURRENT run drops to simulated and says so", async () => {
  const p = freshBegin({ respond: path => {
    if (path.includes("/play")) throw new Error("Spotify 502");
    return null;
  } });
  const run = p.newRun();
  p.setW(run);
  assert.equal(await p.begin(), true, "the workout still runs, silently");
  assert.equal(run.live, false);
  assert.equal(p.badge.textContent, "SIMULATED");
  assert.equal(p.toasts.length, 1);
  assert.match(p.toasts[0], /Spotify 502/);
});
