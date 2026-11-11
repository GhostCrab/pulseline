/* Characterisation tests for analysis-core.js's pure surface.
 *
 * Run:  node --test tests/
 *
 * analysis-core.js is a classic script that assigns window.PLAnalysis - there is no
 * module.exports and no export. Rather than change the file (which would risk the
 * `?v=N` / NEEDS_CORE contract and eslint's sourceType:"script" assumption), it is
 * evaluated with a stub window and the export object pulled back out - see loadCore.
 * So these tests run against the real shipped file, unmodified.
 *
 * Scope is the part that needs no browser and no Essentia WASM: foldToReference,
 * loudnessCurve01, METRICS, metricByKey, metricValue, metricBounds. loadEssentia and
 * analyseSignal are out of scope here - they need the vendored WASM.
 *
 * Expected values come from the documented ranges in METRICS, the worked example in
 * analysis-core.js's own comments, and hand computation - never from re-running the
 * implementation's own arithmetic.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { loadClassicScript } = require("./_page.js");

/* analysis-core.js is a classic script that assigns window.PLAnalysis - no module.exports
 * and no export - so it is evaluated whole and the export object taken off the stub
 * window. See tests/_page.js for why this runs in THIS realm rather than a vm context. */
function loadCore() {
  const api = loadClassicScript("analysis-core.js").PLAnalysis;
  assert.ok(api, "analysis-core.js must assign window.PLAnalysis");
  return api;
}

const PL = loadCore();

test("the module evaluates with no browser globals beyond window", () => {
  // Guards the harness itself: if analysis-core.js ever touches document or
  // OfflineAudioContext at evaluation time, this suite stops being runnable and
  // this is the test that says so.
  assert.doesNotThrow(loadCore);
});

test("exports the expected pure surface", () => {
  for (const name of ["foldToReference", "loudnessCurve01", "METRICS", "metricByKey",
                      "metricValue", "metricBounds", "ANALYSIS_VERSION"]) {
    assert.ok(name in PL, `PLAnalysis.${name} is missing`);
  }
});

test("ANALYSIS_VERSION is an integer", () => {
  assert.ok(Number.isInteger(PL.ANALYSIS_VERSION), "stored record shape version");
});

/* ------------------------------ foldToReference ------------------------------ */

test("foldToReference: the worked example from the source comment", () => {
  // "86 with a reference of 160 becomes 172" - analysis-core.js, foldToReference.
  assert.equal(PL.foldToReference(86, 160), 172);
});

test("foldToReference: a tempo already nearest the reference is unchanged", () => {
  assert.equal(PL.foldToReference(170, 160), 170);
});

test("foldToReference: folds down as well as up", () => {
  // 180 against a reference of 90: the 0.5x octave (90) is an exact match.
  assert.equal(PL.foldToReference(180, 90), 90);
});

test("foldToReference: candidate octaves outside 40-220 are not offered", () => {
  // 100 against a reference of 25: 25 and 12.5 are both below the 40 floor, so the
  // best available candidate is 50, not 25.
  assert.equal(PL.foldToReference(100, 25), 50);
});

test("foldToReference: a falsy bpm or reference returns the input untouched", () => {
  assert.equal(PL.foldToReference(0, 160), 0);
  assert.equal(PL.foldToReference(120, 0), 120);
  assert.equal(PL.foldToReference(undefined, 160), undefined);
  assert.equal(PL.foldToReference(120, null), 120);
});

test("foldToReference: the result is rounded to one decimal", () => {
  // 86.666 * 2 = 173.332 -> 173.3
  assert.equal(PL.foldToReference(86.666, 160), 173.3);
});

test("foldToReference: never invents a value outside the measured octaves", () => {
  for (const bpm of [41, 77, 128, 219]) {
    const out = PL.foldToReference(bpm, 150);
    const ratio = out / bpm;
    assert.ok([0.25, 0.5, 1, 2, 4].some(m => Math.abs(ratio - m) < 1e-6),
      `${bpm} -> ${out} is not an octave multiple of the measured tempo`);
  }
});

/* ------------------------------ loudnessCurve01 ------------------------------ */

test("loudnessCurve01: maps the documented -40..-5 LUFS window onto 0..1", () => {
  assert.deepEqual(PL.loudnessCurve01([-40, -22.5, -5]), [0, 0.5, 1]);
});

test("loudnessCurve01: clamps outside the window rather than extrapolating", () => {
  assert.deepEqual(PL.loudnessCurve01([-100, 0, 10]), [0, 1, 1]);
});

test("loudnessCurve01: non-finite samples become 0, not NaN", () => {
  assert.deepEqual(PL.loudnessCurve01([NaN, Infinity, -Infinity, null]), [0, 0, 0, 0]);
});

test("loudnessCurve01: empty and missing input give an empty curve", () => {
  assert.deepEqual(PL.loudnessCurve01([]), []);
  assert.deepEqual(PL.loudnessCurve01(null), []);
  assert.deepEqual(PL.loudnessCurve01(undefined), []);
});

/* --------------------------------- METRICS ---------------------------------- */

test("METRICS: every entry has the full shape", () => {
  assert.ok(PL.METRICS.length > 0);
  for (const m of PL.METRICS) {
    assert.equal(typeof m.key, "string", "key");
    assert.equal(typeof m.label, "string", `${m.key}.label`);
    assert.equal(typeof m.unit, "string", `${m.key}.unit`);
    assert.equal(typeof m.series, "boolean", `${m.key}.series`);
    assert.equal(typeof m.algorithm, "string", `${m.key}.algorithm`);
    assert.equal(typeof m.note, "string", `${m.key}.note`);
    assert.ok(m.docRange === null || Array.isArray(m.docRange), `${m.key}.docRange`);
  }
});

test("METRICS: keys are unique", () => {
  const keys = PL.METRICS.map(m => m.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("METRICS: there is no composite score metric", () => {
  // docs/DEVELOPING.md, the no-invented-numbers rule: every metric is a direct
  // Essentia output with a real unit, never a derived "energy" score.
  for (const m of PL.METRICS) {
    assert.ok(!/^(energy|score|rating|intensity)$/i.test(m.key),
      `${m.key} looks like a composite score`);
  }
});

test("METRICS: a declared docRange is ordered and finite", () => {
  for (const m of PL.METRICS.filter(m => m.docRange)) {
    const [lo, hi] = m.docRange;
    assert.ok(Number.isFinite(lo) && Number.isFinite(hi), `${m.key} docRange finite`);
    assert.ok(lo < hi, `${m.key} docRange is ordered`);
  }
});

test("METRICS: exactly one series metric, and it is the loudness curve", () => {
  const series = PL.METRICS.filter(m => m.series).map(m => m.key);
  assert.deepEqual(series, ["curveLufs"]);
});

/* ------------------------------- metricByKey -------------------------------- */

test("metricByKey: returns the matching entry", () => {
  assert.equal(PL.metricByKey("bpm").key, "bpm");
});

test("metricByKey: an unknown key silently falls back to the first metric", () => {
  // Part of the interface, and a trap: a caller cannot distinguish "unknown key"
  // from "loudness over time".
  assert.equal(PL.metricByKey("no-such-metric").key, PL.METRICS[0].key);
  assert.equal(PL.metricByKey(undefined).key, PL.METRICS[0].key);
});

/* ------------------------------- metricValue -------------------------------- */

test("metricValue: a missing record is null", () => {
  assert.equal(PL.metricValue(null, "bpm"), null);
  assert.equal(PL.metricValue(undefined, "bpm"), null);
});

test("metricValue: curveLufs is read off the top level, not from essentia", () => {
  assert.deepEqual(PL.metricValue({ curveLufs: [-20, -21] }, "curveLufs"), [-20, -21]);
  assert.equal(PL.metricValue({ essentia: { curveLufs: [-20] } }, "curveLufs"), null);
});

test("metricValue: an edited top-level bpm wins over the measured one", () => {
  // The user's own tempo edit must not be overwritten by the Essentia value.
  assert.equal(PL.metricValue({ bpm: 128, essentia: { bpm: 64 } }, "bpm"), 128);
});

test("metricValue: bpm falls back to the essentia value when no edit exists", () => {
  assert.equal(PL.metricValue({ essentia: { bpm: 64 } }, "bpm"), 64);
});

test("metricValue: summary is used when essentia is absent", () => {
  assert.equal(PL.metricValue({ summary: { danceability: 1.5 } }, "danceability"), 1.5);
});

test("metricValue: essentia takes precedence over summary", () => {
  const rec = { essentia: { danceability: 1 }, summary: { danceability: 2 } };
  assert.equal(PL.metricValue(rec, "danceability"), 1);
});

test("metricValue: a non-finite or absent scalar is null", () => {
  assert.equal(PL.metricValue({ essentia: { centroid: NaN } }, "centroid"), null);
  assert.equal(PL.metricValue({ essentia: {} }, "centroid"), null);
  assert.equal(PL.metricValue({ essentia: { centroid: "1200" } }, "centroid"), null);
});

test("metricValue: the bpm path has no finite guard, unlike every other scalar", () => {
  // Documents a real asymmetry: `centroid` returns null when missing, but `bpm`
  // returns undefined, because the bpm branch returns s.bpm directly.
  assert.equal(PL.metricValue({ essentia: {} }, "bpm"), undefined);
  assert.equal(PL.metricValue({ essentia: {} }, "centroid"), null);
});

/* ------------------------------- metricBounds ------------------------------- */

test("metricBounds: a documented range is used verbatim and marked documented", () => {
  // Expected values are the docRange declared in METRICS, which is the spec.
  for (const m of PL.METRICS.filter(m => m.docRange)) {
    const b = PL.metricBounds(m.key, []);
    assert.deepEqual(b, { min: m.docRange[0], max: m.docRange[1], source: "documented" },
      `${m.key} must use its documented range`);
  }
});

test("metricBounds: a documented range ignores the observed data entirely", () => {
  const records = [{ essentia: { danceability: 99 } }];
  assert.equal(PL.metricBounds("danceability", records).source, "documented");
  assert.equal(PL.metricBounds("danceability", records).max, 3);
});

test("metricBounds: no data gives 0..1 marked empty, never a made-up range", () => {
  for (const records of [[], null, undefined, [{}], [{ essentia: {} }]]) {
    assert.deepEqual(PL.metricBounds("centroid", records),
      { min: 0, max: 1, source: "empty" });
  }
});

test("metricBounds: observed bounds get 8% padding", () => {
  // vals -20, -10 -> lo -20, hi -10, spread 10, pad 0.8 -> -20.8 .. -9.2
  const records = [
    { essentia: { integratedLoudness: -10 } },
    { essentia: { integratedLoudness: -20 } },
  ];
  const b = PL.metricBounds("integratedLoudness", records);
  assert.equal(b.source, "observed");
  assert.ok(Math.abs(b.min - -20.8) < 1e-9, `min was ${b.min}`);
  assert.ok(Math.abs(b.max - -9.2) < 1e-9, `max was ${b.max}`);
});

test("metricBounds: a series metric is flattened across every sample", () => {
  // curveLufs floors at -40 before padding: lo -40, hi -10, spread 30, pad 2.4
  const records = [{ curveLufs: [-60, -10, NaN] }];
  const b = PL.metricBounds("curveLufs", records);
  assert.equal(b.source, "observed");
  assert.ok(Math.abs(b.min - -42.4) < 1e-9, `min was ${b.min}`);
  assert.ok(Math.abs(b.max - -7.6) < 1e-9, `max was ${b.max}`);
});

test("metricBounds: a degenerate range is widened by 1 either side before padding", () => {
  // vals 1000, 1000 -> widened to 999..1001, spread 2, pad 0.16
  const records = [{ essentia: { centroid: 1000 } }, { essentia: { centroid: 1000 } }];
  const b = PL.metricBounds("centroid", records);
  assert.ok(Math.abs(b.min - 998.84) < 1e-9, `min was ${b.min}`);
  assert.ok(Math.abs(b.max - 1001.16) < 1e-9, `max was ${b.max}`);
});

test("metricBounds: non-finite samples are excluded from the spread", () => {
  const withJunk = [{ essentia: { centroid: 1000 } }, { essentia: { centroid: NaN } },
                    { essentia: { centroid: 2000 } }];
  const clean = [{ essentia: { centroid: 1000 } }, { essentia: { centroid: 2000 } }];
  assert.deepEqual(PL.metricBounds("centroid", withJunk),
                   PL.metricBounds("centroid", clean));
});

test("metricBounds: metricByKey's fallback does NOT extend to the value lookup", () => {
  // metricBounds resolves `m` via metricByKey (so an unknown key inherits curveLufs's
  // null docRange and takes the observed path) but then reads samples with the ORIGINAL
  // key, not m.key. So an unknown key finds no values and always lands on "empty",
  // while metricByKey still hands the caller the curveLufs label and unit.
  //
  // Consequence worth knowing: a stale persisted metric preference (index.html saves
  // state.metric and restores it at boot) renders a lane labelled "Loudness over time"
  // on an empty 0..1 axis, rather than either working or failing visibly.
  const records = [{ curveLufs: [-30, -20] }];
  assert.deepEqual(PL.metricBounds("no-such-metric", records),
    { min: 0, max: 1, source: "empty" });
  assert.equal(PL.metricByKey("no-such-metric").key, "curveLufs");
  assert.equal(PL.metricBounds("curveLufs", records).source, "observed");
});

test("metricBounds: every metric yields finite ordered bounds for a realistic record", () => {
  const record = {
    bpm: 128, curveLufs: [-25, -18, -30],
    essentia: {
      bpm: 128, bpmConfidence: 3.2, danceability: 1.4, integratedLoudness: -9.5,
      loudnessRange: 6.1, dynamicComplexity: 3.3, centroid: 1800, beatCount: 420,
    },
  };
  for (const m of PL.METRICS) {
    const b = PL.metricBounds(m.key, [record]);
    assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max), `${m.key} finite`);
    assert.ok(b.min < b.max, `${m.key} ordered: ${b.min} .. ${b.max}`);
    assert.ok(["documented", "observed", "empty"].includes(b.source), `${m.key} source`);
  }
});
