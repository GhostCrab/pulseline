/* Tests for sync-core.js, the live sync decision logic.
 *
 * Run:  node --test tests/
 *
 * This is the first part of workout.html's fragile path that can be exercised with no
 * browser, no SDK and no Spotify session. The behaviour pinned here is the behaviour
 * the three previous inline copies had - the module is an extraction, so these are
 * characterisation tests, and the expected values are hand-computed from the
 * documented constants rather than read back out of the implementation.
 *
 * docs/DEVELOPING.md Hotspots 6: "Latency compensation and slewing are tuned; changing
 * the constants reintroduces either flicker or drift." These tests are what makes that
 * warning enforceable.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../sync-core.js");

const track = (uri, durMs) => ({ uri, durMs, name: uri, artists: "x" });

/* Three 100s tracks: spans start at 0, 100, 200. */
const TRACKS = [track("spotify:track:a", 100000),
                track("spotify:track:b", 100000),
                track("spotify:track:c", 100000)];
const SPANS = PL.spansOf(TRACKS);

test("the module requires cleanly and exports its surface", () => {
  for (const name of ["SYNC_VERSION", "SNAP_SEC", "ORDER_DRIFT_SEC", "SLEW_RATE",
                      "spansOf", "matchSpan", "syncCorrection", "absorbStep"]) {
    assert.ok(name in PL, `PLSync.${name} is missing`);
  }
});

test("the tuned constants are the values the inline copies used", () => {
  // Pinned so a change is a deliberate decision rather than a drive-by edit:
  // 2.5s snap, 25s order-drift warning, 12% maximum clock rate while absorbing.
  assert.equal(PL.SNAP_SEC, 2.5);
  assert.equal(PL.ORDER_DRIFT_SEC, 25);
  assert.equal(PL.SLEW_RATE, 0.12);
});

test("SYNC_VERSION is an integer, for the page boot gate", () => {
  assert.ok(Number.isInteger(PL.SYNC_VERSION));
});

/* ---------------------------------- spansOf ---------------------------------- */

test("spansOf lays tracks end to end from zero", () => {
  assert.deepEqual(SPANS.map(s => [s.start, s.end]),
    [[0, 100], [100, 200], [200, 300]]);
});

test("spansOf carries the track on the span", () => {
  // This is what removes the old spans[i] <-> tracks[i] parallel-array assumption.
  assert.equal(SPANS[1].tr.uri, "spotify:track:b");
});

test("spansOf handles an empty or missing track list", () => {
  assert.deepEqual(PL.spansOf([]), []);
  assert.deepEqual(PL.spansOf(null), []);
  assert.deepEqual(PL.spansOf(undefined), []);
});

test("spansOf treats a track with no duration as zero length", () => {
  const spans = PL.spansOf([track("a", 1000), { uri: "b" }, track("c", 2000)]);
  assert.deepEqual(spans.map(s => [s.start, s.end]), [[0, 1], [1, 1], [1, 3]]);
});

/* --------------------------------- matchSpan --------------------------------- */

test("matchSpan finds the span for a uri", () => {
  assert.equal(PL.matchSpan(SPANS, "spotify:track:c", 0).index, 2);
});

test("matchSpan picks the repeat nearest the clock", () => {
  // The same song twice in one workout: spans at 0..100 and 200..300.
  const spans = PL.spansOf([track("dup", 100000), track("other", 100000),
                            track("dup", 100000)]);
  assert.equal(PL.matchSpan(spans, "dup", 10).index, 0, "near the start");
  assert.equal(PL.matchSpan(spans, "dup", 240).index, 2, "near the third span");
  // Exactly halfway between span starts 0 and 200: the first wins, because a later
  // candidate must be strictly nearer to displace it.
  assert.equal(PL.matchSpan(spans, "dup", 100).index, 0);
});

test("matchSpan reports no match for a uri that is not in the workout", () => {
  const got = PL.matchSpan(SPANS, "spotify:track:zzz", 0);
  assert.equal(got.index, -1);
  assert.equal(got.distanceSec, Infinity);
});

test("matchSpan survives a malformed span list", () => {
  for (const spans of [null, undefined, [], [null], [{}], [{ tr: null }]]) {
    assert.equal(PL.matchSpan(spans, "a", 0).index, -1);
  }
});

/* ------------------------------- syncCorrection ------------------------------ */

test("a tiny difference is absorbed as a slew, not snapped", () => {
  // span b starts at 100, position 1s in -> server says 101; clock at 100 -> delta 1.
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 1 }, 100);
  assert.deepEqual(got, { action: "slew", by: 1, diagnosis: null });
});

test("a difference past the snap threshold jumps the clock", () => {
  // server says 100 + 10 = 110; clock at 100 -> delta 10, above 2.5.
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 10 }, 100);
  assert.deepEqual(got, { action: "snap", to: 110, diagnosis: null });
});

test("the snap threshold is exclusive: exactly 2.5s still slews", () => {
  const at = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 2.5 }, 100);
  assert.equal(at.action, "slew");
  const past = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 2.51 }, 100);
  assert.equal(past.action, "snap");
});

test("a clock running ahead of Spotify slews backwards", () => {
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 0 }, 101);
  assert.deepEqual(got, { action: "slew", by: -1, diagnosis: null });
});

test("half the round-trip time is added, because the position is already stale", () => {
  // quirk 5: progress was sampled about half an RTT before we read it. rttSec 0.5
  // contributes 0.25. span 100 + position 1 + 0.25 = 101.25; clock 100 -> 1.25.
  const got = PL.syncCorrection(SPANS,
    { uri: "spotify:track:b", positionSec: 1, rttSec: 0.5 }, 100);
  assert.equal(got.action, "slew");
  assert.ok(Math.abs(got.by - 1.25) < 1e-9, `by was ${got.by}`);
});

test("an event-driven report passes no rttSec and gets no compensation", () => {
  // The SDK pushes player_state_changed, so there is no round trip to compensate.
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 1 }, 100);
  assert.equal(got.by, 1);
});

test("rttSec compensation can tip a slew into a snap", () => {
  // delta 2.4 alone would slew; +rtt/2 of 0.5 makes 2.9, past the 2.5 threshold.
  const got = PL.syncCorrection(SPANS,
    { uri: "spotify:track:b", positionSec: 2.4, rttSec: 1 }, 100);
  assert.equal(got.action, "snap");
});

test("a uri that is not in the workout corrects nothing", () => {
  // Shuffle, or a manual skip to something else entirely. The clock must be left
  // alone rather than yanked to a span that does not correspond.
  assert.deepEqual(PL.syncCorrection(SPANS, { uri: "spotify:track:zzz" }, 50),
    { action: "none", diagnosis: "noMatch" });
});

test("a missing uri is noUri, NOT noMatch", () => {
  // The distinction matters at the call site: the SDK reports no track_window between
  // tracks, and treating that as "something else is playing" would fire a shuffle
  // warning every time the player blinked.
  for (const observed of [{}, { uri: null }, { uri: "" }, null, undefined]) {
    assert.deepEqual(PL.syncCorrection(SPANS, observed, 50),
      { action: "none", diagnosis: "noUri" });
  }
});

test("noUri and noMatch are distinguishable by the caller", () => {
  const blink = PL.syncCorrection(SPANS, { uri: null }, 50);
  const elsewhere = PL.syncCorrection(SPANS, { uri: "spotify:track:zzz" }, 50);
  assert.equal(blink.action, elsewhere.action, "both correct nothing");
  assert.notEqual(blink.diagnosis, elsewhere.diagnosis, "but they are told apart");
});

test("order drift is reported but the correction is still made", () => {
  // Playing track c (span starts at 200) while the clock says 100: the nearest
  // matching span is 100s away, well past the 25s threshold. The old code warned
  // and then corrected anyway, and so does this.
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:c", positionSec: 0 }, 100);
  assert.equal(got.diagnosis, "orderDrift");
  assert.equal(got.action, "snap", "the correction is not suppressed by the warning");
  assert.equal(got.to, 200);
});

test("REGRESSION: correct in-order playback never reports drift", () => {
  /* The bug this replaced: order drift was judged on the distance from the clock to the
   * START of the matched span, so it was true of any healthy playthrough more than 25s
   * into a track. A real workout showed "Playback order doesn't match the timeline"
   * repeatedly while playing the right playlist in the right order with shuffle off.
   *
   * Spotify agrees with the clock in every case below - that is what "correct" means. */
  for (const [label, uri, positionSec, clockT] of [
    ["1s into track a", "spotify:track:a", 1, 1],
    ["60s into track a", "spotify:track:a", 60, 60],
    ["99s into track a", "spotify:track:a", 99, 99],
    ["30s into track b", "spotify:track:b", 30, 130],
    ["90s into track c", "spotify:track:c", 90, 290],
  ]) {
    const got = PL.syncCorrection(SPANS, { uri, positionSec, rttSec: 0.1 }, clockT);
    assert.equal(got.diagnosis, null, `${label} wrongly reported ${got.diagnosis}`);
  }
});

test("a transition boundary does not look like drift", () => {
  // The clock has just crossed into track b while Spotify still reports track a, a few
  // hundred ms behind. Ordinary staleness, not an order problem.
  const got = PL.syncCorrection(SPANS,
    { uri: "spotify:track:a", positionSec: 99.8, rttSec: 0.2 }, 100.5);
  assert.equal(got.diagnosis, null);
  assert.equal(got.action, "slew");
});

test("a genuine jump to another track IS reported as drift", () => {
  // Clock is 50s in, inside track a; Spotify is playing track c. That is what shuffle
  // or a manual skip looks like.
  const got = PL.syncCorrection(SPANS, { uri: "spotify:track:c", positionSec: 10 }, 50);
  assert.equal(got.diagnosis, "orderDrift");
  assert.equal(got.action, "snap");
  assert.equal(got.to, 210);
});

test("order drift always accompanies a snap, never a slew", () => {
  // ORDER_DRIFT_SEC > SNAP_SEC, so a correction big enough to be called drift is
  // always big enough to snap. Asserted as an invariant over a sweep of deltas.
  assert.ok(PL.ORDER_DRIFT_SEC > PL.SNAP_SEC, "the thresholds are the wrong way round");
  for (let delta = -200; delta <= 200; delta += 0.5) {
    const got = PL.syncCorrection(SPANS,
      { uri: "spotify:track:b", positionSec: 50 + delta }, 150);
    if (got.diagnosis === "orderDrift") {
      assert.equal(got.action, "snap", `delta ${delta} reported drift with a ${got.action}`);
    }
  }
});

test("the order-drift threshold is exclusive, and measured on the correction", () => {
  const at = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 75 }, 150);
  assert.equal(at.by ?? at.to - 150, 25, "a correction of exactly 25s");
  assert.equal(at.diagnosis, null, "exactly 25s is not yet drift");

  const past = PL.syncCorrection(SPANS, { uri: "spotify:track:b", positionSec: 75.1 }, 150);
  assert.equal(past.diagnosis, "orderDrift");
});

test("a non-finite position or rtt is treated as zero rather than poisoning the clock", () => {
  for (const bad of [NaN, undefined, null, "1", Infinity]) {
    const got = PL.syncCorrection(SPANS,
      { uri: "spotify:track:b", positionSec: bad }, 100);
    assert.ok(Number.isFinite(got.by ?? got.to), `positionSec ${bad} produced ${JSON.stringify(got)}`);
  }
  const got = PL.syncCorrection(SPANS,
    { uri: "spotify:track:b", positionSec: 1, rttSec: NaN }, 100);
  assert.equal(got.by, 1);
});

/* -------------------------------- absorbStep -------------------------------- */

test("absorbStep takes at most 12% of the frame", () => {
  // A 10s outstanding slew over a 1/60s frame: 1/60 * 0.12 = 0.002.
  const step = PL.absorbStep(10, 1 / 60);
  assert.ok(Math.abs(step - 0.002) < 1e-9, `step was ${step}`);
});

test("absorbStep never overshoots the outstanding slew", () => {
  // 0.001s of slew left and a long frame: take the remainder, not 12% of the frame.
  assert.equal(PL.absorbStep(0.001, 1), 0.001);
});

test("absorbStep keeps the sign, so a backwards slew is absorbed backwards", () => {
  assert.ok(PL.absorbStep(-10, 1 / 60) < 0);
  assert.equal(PL.absorbStep(-0.001, 1), -0.001);
});

test("absorbStep is zero when there is nothing to absorb", () => {
  for (const slew of [0, null, undefined, NaN]) {
    assert.equal(PL.absorbStep(slew, 1 / 60), 0);
  }
});

test("absorbStep is zero for a non-positive or non-finite frame", () => {
  for (const dt of [0, -1, NaN, undefined, null]) {
    assert.equal(PL.absorbStep(10, dt), 0);
  }
});

test("repeated absorption converges on the full slew without overshooting", () => {
  // The property that matters: the clock ends up corrected by exactly the slew, and
  // never passes it. Loop the absorber the way tick() does.
  let slew = 3, moved = 0;
  for (let i = 0; i < 5000 && slew !== 0; i++) {
    const step = PL.absorbStep(slew, 1 / 60);
    moved += step;
    slew -= step;
  }
  assert.ok(Math.abs(moved - 3) < 1e-9, `absorbed ${moved} of 3`);
  assert.ok(Math.abs(slew) < 1e-9, `${slew} left outstanding`);
});
