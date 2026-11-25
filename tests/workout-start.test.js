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
  assert.deepEqual(logged.filter(l => l.type === "syncDiag").map(l => l.data.diagnosis), ["inOrder"]);
});

test("the first playing state is logged as `heard`, once, with how long it took", () => {
  /* data/clientlog 2026-11-15: two STARTs that Spotify accepted and nobody could hear.
   * play answers 204 over silence, so the SDK's first playing state is the only evidence
   * of audio, and scripts/clientlog.py reads a playAck with no `heard` as a silent start. */
  const { onSdkState, W, logged } = freshPage();
  W.playSent = true;
  W.playSentAt = -350;                         // performance.now() is pinned at 0 here
  onSdkState(sdkState("spotify:track:first", 55606, true, false));   // stale: not audio
  assert.deepEqual(logged.filter(l => l.type === "heard"), []);
  onSdkState(sdkState("spotify:track:first", 0, false, true));
  onSdkState(sdkState("spotify:track:first", 900, false, false));
  assert.deepEqual(logged.filter(l => l.type === "heard").map(l => l.data), [{ ms: 350 }]);
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

/* ---- refreshIfStale: a page that has been in the background is replaced ---- */

function freshStale({ target = "sdk", hiddenAt = 1, frozenAt = 0, sdkPlaying = false } = {}) {
  const logged = [], calls = [];
  const factory = new Function(
    "target", "hiddenAt", "frozenAt", "sdkPlaying", "lastHiddenMs", "clog", "clogFlush", "location",
    "let reloading=false;\n" + extractFunction("refreshIfStale") + "\nreturn refreshIfStale;");
  const refresh = factory(target, hiddenAt, frozenAt, sdkPlaying, 82800000,
    (type, data) => { logged.push({ type, data }); calls.push("log"); },
    () => calls.push("flush"), { reload: () => calls.push("reload") });
  return { refresh, logged, calls };
}

test("REGRESSION: a page that has been in the background reloads before the next workout", () => {
  /* data/clientlog 2026-11-15: the installed iOS app was reopened, not restarted, on the
   * page that had finished the previous day's workout. Its player said `ready`, Spotify
   * accepted play twice, and nothing was heard until the app was force-closed. */
  const p = freshStale();
  assert.equal(p.refresh("done"), true);
  assert.deepEqual(p.calls, ["log", "flush", "reload"], "the reason must be on its way before the page goes");
  assert.deepEqual(p.logged, [{ type: "staleReload", data: { why: "done", hiddenMs: 82800000 } }]);
  // Seen in desktop Chrome: the visibility event fired again while the page was leaving.
  assert.equal(p.refresh("visible"), true);
  assert.equal(p.calls.filter(c => c === "reload").length, 1, "reloaded twice");
  assert.equal(p.logged.length, 1, "logged twice");
});

test("a page that was never hidden or frozen is left alone", () => {
  const p = freshStale({ hiddenAt: 0 });
  assert.equal(p.refresh("done"), false);
  assert.deepEqual(p.calls, []);
});

test("REGRESSION: a page frozen without a hide event still reloads", () => {
  /* data/clientlog 2026-11-24: loaded 19:33, no `hidden` ever logged, back at 22:14 with
   * hiddenMs:null, and both STARTs got 404 Device not found. hiddenAt was never set, so
   * the reload that waited for it did not happen. */
  const p = freshStale({ hiddenAt: 0, frozenAt: 1 });
  assert.equal(p.refresh("frozen"), true);
  assert.deepEqual(p.calls, ["log", "flush", "reload"]);
});

/* beat(): the freeze detector. lastBeat, frozenAt and the log are the page's own; time
 * is passed in, so a 2.7h suspension is one call rather than a 2.7h test. */
function freshBeat(start) {
  const logged = [];
  const FROZEN_MS = Number(src.match(/const FROZEN_MS=([\d*]+);/)[1].split("*")
    .reduce((a, b) => a * Number(b), 1));
  const factory = new Function("clog", "devTail", "sdkId",
    "const FROZEN_MS=" + FROZEN_MS + ";\nlet lastBeat=" + start + ",frozenAt=0;\n"
    + extractFunction("beat") + "\nreturn {beat,frozen:()=>frozenAt};");
  return { ...factory((type, data) => logged.push({ type, data }), id => id && id.slice(-6),
    "0123456789abcdef"), logged, FROZEN_MS };
}

test("a timer that did not run for 2.7 hours records a freeze, once", () => {
  const b = freshBeat(0);
  const gap = 9718628;                         // readyAgoMs on the failing START, 2026-11-24
  assert.equal(b.beat(gap), true);
  assert.equal(b.frozen(), 0, "the freeze is dated from the last tick before it");
  assert.deepEqual(b.logged, [{ type: "frozen", data: { gapMs: gap, dev: "abcdef" } }]);
  // The visibility handler and the timer both call beat() on the way back; only the first sees the gap.
  assert.equal(b.beat(gap + 5), false);
  assert.equal(b.logged.length, 1);
});

test("ordinary ticks, and a throttled background tab, are not a freeze", () => {
  const b = freshBeat(0);
  let t = 0;
  for (let i = 0; i < 100; i++) assert.equal(b.beat(t += 1000), false);
  // Chrome clamps timers in a hidden tab to about once a minute.
  assert.equal(b.beat(t += 61000), false);
  assert.ok(b.FROZEN_MS > 61000, "FROZEN_MS must stay above Chrome's background clamp");
  assert.equal(b.frozen(), 0);
  assert.deepEqual(b.logged, []);
});

test("a page that is still playing the cooldown music is not reloaded under it", () => {
  const p = freshStale({ sdkPlaying: true });
  assert.equal(p.refresh("done"), false);
  assert.deepEqual(p.calls, []);
});

test("Spotify-app mode has no in-page player to go stale", () => {
  const p = freshStale({ target: "connect" });
  assert.equal(p.refresh("visible"), false);
  assert.deepEqual(p.calls, []);
});

test("the reload is wired only to the splash and to leaving the completion card", () => {
  // Structural: a reload anywhere else would throw away a run that is armed or running.
  const code = require("./_page.js").stripComments(src);
  const uses = code.match(/refreshIfStale\("[a-z]+"\)/g) || [];
  assert.deepEqual(uses.sort(),
    ['refreshIfStale("done")', 'refreshIfStale("frozen")', 'refreshIfStale("visible")']);
  assert.match(code, /if\(!W\)refreshIfStale\("visible"\)/);
  assert.match(code, /if\(beat\(Date\.now\(\)\)&&!W\)refreshIfStale\("frozen"\)/);
  // The visibility handler records a freeze too, so the order the two run in cannot lose it.
  assert.match(code, /beat\(Date\.now\(\)\);\s*if\(!W\)refreshIfStale\("visible"\)/);
  assert.match(code, /backToSplash\(\);refreshIfStale\("done"\)/);
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
function freshBegin({ respond = () => null, sdkReady = Promise.resolve("dev1"),
                      reconnect = async () => "dev2" } = {}) {
  const calls = [], toasts = [], logged = [], badge = { textContent: "", className: "" };
  const reconnects = [];
  const api = (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body });
    return Promise.resolve().then(() => respond(path, opts));
  };
  const factory = new Function(
    "target", "hasStreamScope", "sdk", "initSdk", "api", "clog", "toast", "$",
    "navigator", "setTimeout", "BUILD", "performance", "reconnectSdk",
    "let W=null,sdkErrTimes=[],sdkId='dev1';\n"
    + "let sdkReadies=2,sdkReadyAt=Date.now()-9000,lastHiddenMs=82800000;\n"
    + "const LOADED_AT=Date.now()-86400000;\n"
    + src.match(/const devTail=.*;/)[0] + "\n"
    + "const PLAY_URI_MAX=" + PLAY_URI_MAX + ";\n"
    + extractFunction("playBody") + "\n" + extractFunction("forceLinearPlayback") + "\n"
    + extractFunction("beginPlayback")
    + "\nreturn {begin:beginPlayback,setW:w=>{W=w}};");
  const page = factory("sdk", () => true, { activateElement: async () => {} },
    () => sdkReady, api, (type, data) => logged.push({ type, data }),
    m => toasts.push(m), () => badge, { userAgent: "test" }, () => 0,
    "abc1234", { now: () => 0 }, () => { reconnects.push(1); return reconnect(); });
  const newRun =(n = 3) => ({ live: true, key: "pl1", ws: { tracks: manyTracks(n) },
    warned: { shuffle: false, noMatch: false, order: false } });
  const sent = () => calls.map(c => c.method + " " + c.path.split("?")[0]);
  return { ...page, newRun, calls, sent, toasts, logged, badge, reconnects };
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

test("every start ends in exactly one logged outcome, stamped with the build", async () => {
  /* scripts/clientlog.py reports a `begin` with none of playAck, beginFail or
   * beginAbandoned after it as a request still in flight - the reading that could not be
   * made on 2026-11-13. That only works if each ending really is logged. */
  const outcome = p => p.logged.map(l => l.type)
    .filter(t => ["playAck", "beginFail", "beginAbandoned"].includes(t));

  const ok = freshBegin();
  ok.setW(ok.newRun());
  await ok.begin();
  assert.deepEqual(outcome(ok), ["playAck"]);
  assert.equal(ok.logged.find(l => l.type === "begin").data.rev, "abc1234");
  assert.equal(typeof ok.logged.find(l => l.type === "playAck").data.ms, "number");

  const failed = freshBegin({ respond: path => {
    if (path.includes("/play")) throw new Error("Spotify 502");
    return null;
  } });
  failed.setW(failed.newRun());
  await failed.begin();
  assert.deepEqual(outcome(failed), ["beginFail"]);

  const ready = deferred();
  const gone = freshBegin({ sdkReady: ready.promise });
  gone.setW(gone.newRun());
  const old = gone.begin();
  gone.setW(gone.newRun());
  ready.resolve("dev1");
  await old;
  assert.deepEqual(outcome(gone), ["beginAbandoned"]);
});

test("a start records how old the page and its player were, and which device it addressed", async () => {
  /* The harness above sets up the 2026-11-15 suspect: a page loaded a day ago, hidden for
   * 23 hours, whose player announced `ready` a second time 9s before START. None of that
   * was in the log that morning, so a resumed page could not be told from a fresh one. */
  const p = freshBegin({ sdkReady: Promise.resolve("0123456789abcdef") });
  p.setW(p.newRun());
  await p.begin();
  const begin = p.logged.find(l => l.type === "begin").data;
  assert.equal(begin.readies, 2);
  assert.equal(begin.hiddenMs, 82800000);
  assert.ok(begin.readyAgoMs >= 9000 && begin.readyAgoMs < 60000, "readyAgoMs: " + begin.readyAgoMs);
  assert.ok(begin.loadAgoMs >= 86400000, "loadAgoMs: " + begin.loadAgoMs);
  // The tail only: enough to compare two entries, not the whole identifier.
  assert.equal(p.logged.find(l => l.type === "playStart").data.dev, "abcdef");
});

/* ---- a player Spotify dropped while the page slept ---- */

const playCalls = p => p.calls.filter(c => c.path.startsWith("/me/player/play"));
/* Answers play with `failures[n]` on the n-th play (an Error to throw, or null). */
const playScript = failures => {
  let n = 0;
  return path => {
    if (!path.startsWith("/me/player/play")) return null;
    const f = failures[n++];
    if (f) throw f;
    return null;
  };
};

test("REGRESSION: a 404 on play re-registers the player and plays on it", async () => {
  /* data/clientlog 2026-11-24 (and 2026-11-22): after hours suspended, PUT /me/player/play
   * answered `404 Device not found`, the SDK had never fired not_ready, and both STARTs
   * dropped the run to SIMULATED. */
  const p = freshBegin({ respond: playScript([new Error("Spotify 404")]) });
  const run = p.newRun();
  p.setW(run);
  await p.begin();
  assert.equal(p.reconnects.length, 1);
  assert.deepEqual(playCalls(p).map(c => c.path.match(/device_id=([^&]+)/)[1]), ["dev1", "dev2"],
    "the retry must name the device the player re-registered as");
  assert.equal(run.live, true, "a recovered start must not be marked simulated");
  assert.deepEqual(p.toasts, []);
  const types = p.logged.map(l => l.type);
  assert.ok(types.includes("deviceLost") && types.includes("playRetry") && types.includes("playAck"),
    types.join(", "));
  assert.ok(!types.includes("beginFail"));
  // repeat goes to the new device too
  await settle();
  const repeat = p.calls.find(c => c.path.startsWith("/me/player/repeat"));
  assert.match(repeat.path, /device_id=dev2/);
});

test("a player that does not come back fails the start as before", async () => {
  const p = freshBegin({ respond: playScript([new Error("Spotify 404")]), reconnect: async () => null });
  const run = p.newRun();
  p.setW(run);
  await p.begin();
  assert.equal(playCalls(p).length, 1, "no retry without a device");
  assert.equal(run.live, false);
  assert.equal(p.logged.filter(l => l.type === "beginFail").length, 1);
});

test("a retry that fails too is one failure, not a loop", async () => {
  const p = freshBegin({ respond: playScript([new Error("Spotify 404"), new Error("Spotify 404")]) });
  const run = p.newRun();
  p.setW(run);
  await p.begin();
  assert.equal(p.reconnects.length, 1);
  assert.equal(playCalls(p).length, 2);
  assert.equal(run.live, false);
  assert.equal(p.logged.filter(l => l.type === "beginFail").length, 1);
});

test("only a 404 re-registers the player", async () => {
  const p = freshBegin({ respond: playScript([new Error("Spotify 502")]) });
  p.setW(p.newRun());
  await p.begin();
  assert.equal(p.reconnects.length, 0);
  assert.equal(playCalls(p).length, 1);
});

test("a run replaced while the player re-registers sends no retry", async () => {
  const back = deferred();
  const p = freshBegin({ respond: playScript([new Error("Spotify 404")]), reconnect: () => back.promise });
  p.setW(p.newRun());
  const old = p.begin();
  await settle(); await settle();
  const next = p.newRun();
  p.setW(next);
  back.resolve("dev2");
  await old;
  assert.equal(playCalls(p).length, 1, "the abandoned start retried play");
  assert.equal(next.live, true);
  assert.ok(p.logged.some(l => l.type === "beginAbandoned"));
});

/* reconnectSdk() against a fake player: what it waits for and what it cleans up. */
function fakePlayer({ readyId = "dev2", fails = false } = {}) {
  const listeners = { ready: [] }, calls = [];
  return {
    calls, listeners,
    addListener: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    removeListener: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== cb); },
    disconnect: () => { calls.push("disconnect"); },
    connect: async () => {
      calls.push("connect");
      if (fails) throw new Error("no");
      if (readyId) setImmediate(() => listeners.ready.slice().forEach(cb => cb({ device_id: readyId })));
      return true;
    },
  };
}
const reconnectWith = (player, timers) => new Function("sdk", "setTimeout", "clearTimeout",
  extractFunction("reconnectSdk") + "\nreturn reconnectSdk;")(player,
  timers ? timers.set : setTimeout, timers ? timers.clear : clearTimeout);

test("reconnectSdk disconnects, connects, and resolves with the id from the next ready", async () => {
  const player = fakePlayer();
  assert.equal(await reconnectWith(player)(), "dev2");
  assert.deepEqual(player.calls, ["disconnect", "connect"]);
  assert.equal(player.listeners.ready.length, 0, "its one-shot ready listener was left behind");
});

test("reconnectSdk gives up with null when no ready arrives, or connect throws", async () => {
  let fire = null;
  const timers = { set: f => { fire = f; return 1; }, clear: () => {} };
  const silent = fakePlayer({ readyId: null });
  const pending = reconnectWith(silent, timers)();
  await settle();
  fire();                                    // the 6s bound elapses
  assert.equal(await pending, null);
  assert.equal(silent.listeners.ready.length, 0);
  // A connect that throws answers at once, not after the 6s bound: here the timer never fires.
  const never = { set: () => 1, clear: () => {} };
  const quick = await Promise.race([reconnectWith(fakePlayer({ fails: true }), never)(),
    settle().then(settle).then(() => "still waiting")]);
  assert.equal(quick, null);
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
