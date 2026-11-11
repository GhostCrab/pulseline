/* Live sync: deciding how to correct the workout clock against what Spotify reports.
 *
 * Shared by workout.html and index.html. See docs/adr/0003-live-sync-is-shared-not-duplicated.md
 * for why this is shared when auth and the store layer deliberately are not.
 *
 * Everything here is pure: no DOM, no SDK, no network, no clock, no storage. The
 * functions return a DECISION and the caller applies it. That is what makes the tuned
 * behaviour testable without a browser or a Spotify session, which is the whole reason
 * the extraction was worth doing -- docs/DEVELOPING.md Hotspots 6 warns that changing
 * these constants reintroduces either flicker or drift, and they were previously
 * written out three times.
 *
 * Vocabulary is GLOSSARY.md's: span, snap, slew, order drift, live sync.
 */
"use strict";

/* Wrapped in an IIFE so this file leaks NOTHING into the global scope but PLSync.
   It is loaded as a classic script, so a top-level `function spansOf(){}` here would
   become a global and collide with any page that declares the same name - which is
   exactly what happened: workout.html's own `const spansOf` could not be declared
   because this file had already taken the binding, and the page failed to parse with
   "Identifier 'spansOf' has already been declared". scripts/check.py now parses each
   page together with the shared scripts it loads, so that class cannot come back. */
(function () {

  /* Bumped whenever this module's interface changes, so a page can refuse to boot
   * against a stale cached copy rather than failing mid-workout. Checked against each
   * page's NEEDS_SYNC by scripts/check.py. */
  const SYNC_VERSION = 2;

  /* Tuned values, not measured ones, and deliberately NOT parameters: a per-call-site
   * knob is how the tuning gets lost. Each is the value the three previous copies all
   * used. docs/DEVELOPING.md Hotspots 6. */
  const SNAP_SEC = 2.5;        // above this the gap is a real seek or skip, so jump
  const ORDER_DRIFT_SEC = 25;  // a correction this large means the timeline has diverged
  const SLEW_RATE = 0.12;      // max 12% clock rate while absorbing, so no visible flicker

  /* Build the span list for a track list: each track's stretch of the timeline, laid
   * end to end from zero. The span carries the track itself, which is what lets
   * syncCorrection read a uri without a parallel array. */
  function spansOf(tracks) {
    let t = 0;
    return (tracks || []).map(tr => {
      const s = { start: t, end: t + (tr && tr.durMs ? tr.durMs : 0) / 1000, tr };
      t = s.end;
      return s;
    });
  }

  /* Which span is Spotify playing? The same track can appear more than once in a
   * workout, so match on uri and then take the occurrence nearest the current clock. */
  function matchSpan(spans, uri, clockT) {
    let best = -1, bestD = Infinity;
    (spans || []).forEach((sp, i) => {
      if (sp && sp.tr && sp.tr.uri === uri) {
        const d = Math.abs(sp.start - clockT);
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    return { index: best, distanceSec: bestD };
  }

  /* How should the clock be corrected?
   *
   *   spans     from spansOf()
   *   observed  { uri, positionSec, rttSec }
   *               uri         what Spotify says is playing
   *               positionSec how far into that track it is
   *               rttSec      round-trip time of the observation, or 0 when the report
   *                           was pushed to us rather than polled. Half of it is added,
   *                           because the position was sampled about half an RTT ago
   *                           (docs/agents/spotify-api.md quirk 5).
   *   clockT    the workout clock now
   *
   * Returns one of:
   *   { action: "none", diagnosis: "noUri" }          nothing reported to correct against
   *   { action: "none", diagnosis: "noMatch" }        reported a track not in the workout
   *   { action: "snap", to, diagnosis }               set the clock to `to`
   *   { action: "slew", by, diagnosis }               absorb `by` gradually
   *
   * "noUri" and "noMatch" are deliberately distinct even though both correct nothing.
   * A missing uri is a transient player state - the SDK reports no track_window between
   * tracks - whereas a uri that matches no span means something else is playing, which
   * usually means shuffle. Only the second is worth telling the user about, and
   * collapsing them would make the SDK path emit a shuffle warning every time the
   * player blinked.
   *
   * diagnosis is otherwise null, or "orderDrift" when the required correction is large
   * enough that the audio and the timeline have genuinely diverged - a shuffled or
   * skipped track rather than ordinary drift. It is reported ALONGSIDE the correction
   * rather than instead of it, because the correction is still worth applying.
   * Surfacing any of them is the caller's decision.
   */
  function syncCorrection(spans, observed, clockT) {
    const o = observed || {};
    if (!o.uri) return { action: "none", diagnosis: "noUri" };

    const { index } = matchSpan(spans, o.uri, clockT);
    if (index < 0) return { action: "none", diagnosis: "noMatch" };

    const serverT = spans[index].start
      + (Number.isFinite(o.positionSec) ? o.positionSec : 0)
      + (Number.isFinite(o.rttSec) ? o.rttSec : 0) / 2;
    const delta = serverT - clockT;

    /* Order drift is judged on the size of the CORRECTION, not on how far the clock sits
       from the matched span's start.
       The inline copies used `distanceSec > 25`, which is the distance from the clock to
       the start of the track being played - so it was true of any correctly-ordered
       playthrough more than 25s into a track, and the warning fired on healthy runs. It
       went largely unnoticed because the three warnings shared one latch and the
       start-up shuffle read-back usually claimed it first.
       What actually means "the audio and the timeline have diverged" is a correction
       this large. ORDER_DRIFT_SEC > SNAP_SEC, so this always accompanies a snap. */
    const diagnosis = Math.abs(delta) > ORDER_DRIFT_SEC ? "orderDrift" : null;

    return Math.abs(delta) > SNAP_SEC
      ? { action: "snap", to: serverT, diagnosis }
      : { action: "slew", by: delta, diagnosis };
  }

  /* How much of an outstanding slew to absorb in a frame of `dt` seconds. The caller
   * adds the step to its clock and subtracts it from the outstanding slew, so the
   * correction disappears smoothly instead of as a jump.
   *
   * Returns only the step, deliberately: index.html applies it alongside a speed
   * multiplier and a clamp to the end of the timeline, and this module has no business
   * knowing either exists. */
  function absorbStep(slew, dt) {
    if (!slew || !Number.isFinite(slew) || !Number.isFinite(dt) || dt <= 0) return 0;
    return Math.sign(slew) * Math.min(Math.abs(slew), dt * SLEW_RATE);
  }

  const PLSync = { SYNC_VERSION, SNAP_SEC, ORDER_DRIFT_SEC, SLEW_RATE,
                   spansOf, matchSpan, syncCorrection, absorbStep };

  /* Dual export. The pages load this as a classic script and read window.PLSync; the
   * tests require() it directly. Two lines, and it avoids the harness gymnastics
   * analysis-core.js needs for the same job. */
  if (typeof window !== "undefined") window.PLSync = PLSync;
  if (typeof module !== "undefined" && module.exports) module.exports = PLSync;
})();
