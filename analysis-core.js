/* Pulseline analysis core — thin wrapper over Essentia.js (Music Technology Group,
   UPF Barcelona). All feature extraction is done by Essentia's validated C++
   algorithms compiled to WebAssembly; nothing here reimplements DSP.

   Algorithms used (see https://essentia.upf.edu/reference/):
     RhythmExtractor2013   tempo + beat positions + confidence
     Danceability          Detrended Fluctuation Analysis, 0..3
     DynamicComplexity     average absolute deviation from global loudness (dB)
     LoudnessEBUR128       EBU R128 integrated loudness (LUFS), loudness range,
                           and the short-term loudness series used as the curve
     SpectralCentroidTime  brightness (Hz)
*/
const ANALYSIS_VERSION = 8;   // bumped whenever the stored record shape changes

let essentia = null, essentiaReady = null;
function loadEssentia() {
  if (essentiaReady) return essentiaReady;
  essentiaReady = (async () => {
    if (typeof EssentiaWASM === "undefined" || typeof Essentia === "undefined")
      throw new Error("Essentia scripts not loaded");
    const wasm = await EssentiaWASM();
    essentia = new Essentia(wasm);
    return essentia;
  })();
  return essentiaReady;
}

const vec = a => essentia.arrayToVector(a);
const arr = v => essentia.vectorToArray(v);

/* Essentia's RhythmExtractor2013 takes no sampleRate argument — it assumes 44100 Hz.
   Windows commonly runs audio at 48000, which is why capture rate must be normalised
   before any of this runs. */
const ESSENTIA_SR = 44100;
async function resampleTo44100(signal, sampleRate) {
  if (Math.abs(sampleRate - ESSENTIA_SR) < 1) return { signal, sampleRate, resampled: false };
  const frames = Math.max(1, Math.round(signal.length * ESSENTIA_SR / sampleRate));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oac = new OAC(1, frames, ESSENTIA_SR);
  const src = oac.createBufferSource();
  const buf = oac.createBuffer(1, signal.length, sampleRate);
  buf.copyToChannel(signal, 0);
  src.buffer = buf;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();
  return { signal: rendered.getChannelData(0).slice(), sampleRate: ESSENTIA_SR, resampled: true };
}

/* Characterise the captured PCM itself. Most "the analysis is wrong" problems are
   really "the capture was wrong" — silence, clipping, a DC offset from a bad loopback
   route — so this is measured and reported rather than assumed. */
function signalStats(sig, sr) {
  let peak = 0, sum = 0, dc = 0, clipped = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i], a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v; dc += v;
    if (a >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sum / (sig.length || 1));
  const db = v => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);
  const thresh = 1e-4;
  let head = 0, tail = 0;
  while (head < sig.length && Math.abs(sig[head]) < thresh) head++;
  while (tail < sig.length && Math.abs(sig[sig.length - 1 - tail]) < thresh) tail++;
  return {
    samples: sig.length,
    durationSec: Math.round(sig.length / sr * 100) / 100,
    peak: Math.round(peak * 10000) / 10000, peakDb: db(peak),
    rms: Math.round(rms * 10000) / 10000, rmsDb: db(rms),
    crestDb: peak > 0 && rms > 0 ? Math.round((db(peak) - db(rms)) * 10) / 10 : null,
    dcOffset: Math.round(dc / (sig.length || 1) * 1e6) / 1e6,
    clippedSamples: clipped,
    leadingSilenceSec: Math.round(head / sr * 100) / 100,
    trailingSilenceSec: Math.round(tail / sr * 100) / 100,
  };
}

const toArr = v => { try { return Array.from(essentia.vectorToArray(v)); } catch (e) { return null; } };
const del = o => { try { o && o.delete && o.delete(); } catch (e) {} };

/* Full analysis. Returns EVERYTHING: what went in, the exact arguments used, and every
   field each algorithm returned — so a raw dump is enough to diagnose any result
   without re-running anything. */
async function analyseSignal(rawSignal, rawRate, onStage) {
  await loadEssentia();
  const t0 = (performance && performance.now) ? performance.now() : Date.now();
  const rs = await resampleTo44100(rawSignal, rawRate);
  const signal = rs.signal, sampleRate = rs.sampleRate;

  const out = {
    engine: { library: "essentia.js", version: (essentia && essentia.version) || null,
              algorithms: (essentia && essentia.algorithmNames) ? undefined : undefined,
              wrapper: ANALYSIS_VERSION },
    input: {
      captureRate: rawRate, analysisRate: sampleRate, resampled: rs.resampled,
      capturedSamples: rawSignal.length,
      captureStats: signalStats(rawSignal, rawRate),
      analysisStats: rs.resampled ? signalStats(signal, sampleRate) : null,
    },
    params: {}, results: {}, errors: {}, timingMs: {},
  };

  const run = async (stage, params, fn) => {
    out.params[stage] = params;
    if (onStage) { onStage(stage); await new Promise(r => setTimeout(r, 0)); }
    const s = (performance && performance.now) ? performance.now() : Date.now();
    let v = null;
    try {
      v = essentia.arrayToVector(signal);
      out.results[stage] = fn(v);
    } catch (e) {
      out.errors[stage] = String((e && e.stack) || (e && e.message) || e);
      out.results[stage] = null;
    } finally {
      del(v);
      out.timingMs[stage] = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - s);
    }
  };

  await run("RhythmExtractor2013",
    { maxTempo: 208, method: "multifeature", minTempo: 40, assumedSampleRate: 44100 },
    v => {
      const r = essentia.RhythmExtractor2013(v, 208, "multifeature", 40);
      /* Read the vectors immediately and record why any conversion failed, rather
         than silently storing null (which is what hid the beat data last time). */
      const grab = k => {
        try {
          const vv = r[k];
          if (!vv) return { value: null, note: "field absent" };
          if (Array.isArray(vv)) return { value: vv };
          if (vv.size && typeof vv.size === "function")
            return { value: Array.from({ length: vv.size() }, (_, i) => vv.get(i)) };
          const a = essentia.vectorToArray(vv);
          return { value: Array.from(a) };
        } catch (e) { return { value: null, note: String((e && e.message) || e) }; }
      };
      /* Field names per the API docs: ticks / estimates / bpmIntervals.
         (The snake_case names used earlier silently produced nulls.) */
      const bp = grab("ticks"), be = grab("estimates"), bi = grab("bpmIntervals");
      const res = {
        bpm: r.bpm, confidence: r.confidence,
        ticks: bp.value, ticksNote: bp.note,
        estimates: be.value, bpmIntervals: bi.value,
        beatCount: bp.value ? bp.value.length : null,
      };
      ["ticks", "estimates", "bpmIntervals"].forEach(k => del(r[k]));
      return res;
    });

  await run("PercivalBpmEstimator",
    { frameSize: 1024, frameSizeOSS: 2048, hopSize: 128, hopSizeOSS: 128,
      maxBPM: 210, minBPM: 50, sampleRate },
    v => ({ bpm: essentia.PercivalBpmEstimator(v, 1024, 2048, 128, 128, 210, 50, sampleRate).bpm }));

  await run("Danceability",
    { maxTau: 8800, minTau: 310, sampleRate, tauMultiplier: 1.1 },
    v => {
      const d = essentia.Danceability(v, 8800, 310, sampleRate, 1.1);
      const res = { danceability: d.danceability, dfa: toArr(d.dfa) };
      del(d.dfa);
      return res;
    });

  await run("DynamicComplexity",
    { frameSize: 0.2, sampleRate },
    v => {
      const dc = essentia.DynamicComplexity(v, 0.2, sampleRate);
      return { dynamicComplexity: dc.dynamicComplexity, loudness: dc.loudness };
    });

  await run("SpectralCentroidTime", { sampleRate },
    v => ({ centroid: essentia.SpectralCentroidTime(v, sampleRate).centroid }));

  await run("Loudness", {},
    v => ({ loudness: essentia.Loudness(v).loudness }));

  /* EBU R128 in 60-second chunks.
     A single call with two full-length channels asks the WASM heap for ~68MB on a
     3-minute track and aborts (Emscripten "exception catching is disabled" = an
     allocation failure, not a catchable error). Chunking keeps each call ~10MB.
     Short-term series are concatenated; integrated loudness is recombined as an
     energy-weighted mean of the chunk values, and loudness range is taken from the
     concatenated short-term distribution (P95-P10, per EBU Tech 3342). Both are
     flagged as chunk-recombined so the approximation is never mistaken for a
     single-pass measurement. */
  out.params.LoudnessEBUR128 = { hopSize: 0.1, sampleRate, startAtZero: false,
    chunkSeconds: 60, note: "mono signal passed as both channels; chunked to fit the WASM heap" };
  if (onStage) { onStage("LoudnessEBUR128"); await new Promise(r => setTimeout(r, 0)); }
  {
    const s0 = (performance && performance.now) ? performance.now() : Date.now();
    const EBU_HOP = 0.1;                       // documented default; other values abort
    const CH = Math.round(sampleRate * 60);
    const shortTerm = [], momentary = [], chunkLoud = [];
    let failed = null, chunks = 0;
    for (let off = 0; off < signal.length; off += CH) {
      const seg = signal.subarray(off, Math.min(off + CH, signal.length));
      if (seg.length < sampleRate * 4) break;            // too short for a 3s window
      let L = null, R = null;
      try {
        L = essentia.arrayToVector(seg); R = essentia.arrayToVector(seg);
        /* hopSize MUST be the documented default 0.1 — 0.5 makes the algorithm abort
           immediately (an uncatchable Emscripten abort, not a JS exception). */
        const l = essentia.LoudnessEBUR128(L, R, EBU_HOP, sampleRate, false);
        const st = toArr(l.shortTermLoudness), mo = toArr(l.momentaryLoudness);
        if (st) shortTerm.push(...st);
        if (mo) momentary.push(...mo);
        if (Number.isFinite(l.integratedLoudness))
          chunkLoud.push({ lufs: l.integratedLoudness, sec: seg.length / sampleRate });
        ["shortTermLoudness", "momentaryLoudness"].forEach(k => del(l[k]));
        chunks++;
      } catch (e) {
        failed = String((e && e.stack) || (e && e.message) || e);
        break;
      } finally { del(L); del(R); }
    }
    if (shortTerm.length) {
      let num = 0, den = 0;
      for (const c of chunkLoud) { num += Math.pow(10, c.lufs / 10) * c.sec; den += c.sec; }
      const integrated = den > 0 ? 10 * Math.log10(num / den) : null;
      const sorted = shortTerm.filter(Number.isFinite).sort((a, b) => a - b);
      const pick = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      out.results.LoudnessEBUR128 = {
        hopSize: EBU_HOP,
        integratedLoudness: integrated,
        loudnessRange: sorted.length ? pick(0.95) - pick(0.10) : null,
        shortTermLoudness: shortTerm,
        momentaryLoudness: momentary,
        chunks, chunkRecombined: true,
        chunkIntegrated: chunkLoud.map(c => Math.round(c.lufs * 10) / 10),
      };
      if (failed) out.errors.LoudnessEBUR128_partial = failed;
    } else {
      out.results.LoudnessEBUR128 = null;
      out.errors.LoudnessEBUR128 = failed || "no chunks produced output";
    }
    out.timingMs.LoudnessEBUR128 = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - s0);
  }

  /* ---- flattened convenience view over the raw results ---- */
  const R13 = out.results.RhythmExtractor2013, EB = out.results.LoudnessEBUR128;
  const PB = out.results.PercivalBpmEstimator;
  const r1 = R13 ? Math.round(R13.bpm * 10) / 10 : 0;
  out.summary = {
    bpm: r1,
    bpmPercival: PB ? Math.round(PB.bpm * 10) / 10 : null,
    /* Tempo is octave-ambiguous: 86 and 172 are both defensible readings of the same
       pulse. Essentia's answer is kept as-is; these are the alternates a listener can
       choose between, and the app can fold toward a personal reference on request. */
    bpmOctaves: r1 ? [r1 / 2, r1, r1 * 2].concat(PB ? [Math.round(PB.bpm * 10) / 10] : [])
      .map(b => Math.round(b * 10) / 10)
      .filter((b, i, a) => b >= 40 && b <= 220 && a.indexOf(b) === i).sort((a, b) => a - b) : [],
    bpmConfidence: R13 ? Math.round(R13.confidence * 100) / 100 : null,
    beatCount: R13 ? R13.beatCount : null,
    danceability: out.results.Danceability ? Math.round(out.results.Danceability.danceability * 1000) / 1000 : null,
    dynamicComplexity: out.results.DynamicComplexity ? Math.round(out.results.DynamicComplexity.dynamicComplexity * 100) / 100 : null,
    loudnessStevens: out.results.DynamicComplexity ? Math.round(out.results.DynamicComplexity.loudness * 100) / 100 : null,
    centroid: out.results.SpectralCentroidTime ? Math.round(out.results.SpectralCentroidTime.centroid) : null,
    integratedLoudness: EB ? Math.round(EB.integratedLoudness * 10) / 10 : null,
    loudnessRange: EB ? Math.round(EB.loudnessRange * 10) / 10 : null,
  };
  /* Short-term series arrives at 1/hopSize Hz; decimate to 2 Hz for the timeline. */
  if (EB && EB.shortTermLoudness && EB.shortTermLoudness.length) {
    const step = Math.max(1, Math.round((1 / (EB.hopSize || 0.1)) / 2));
    const dec = [];
    for (let i = 0; i < EB.shortTermLoudness.length; i += step)
      dec.push(Math.round(EB.shortTermLoudness[i] * 10) / 10);
    out.curveLufs = dec;
  } else out.curveLufs = null;
  out.curveHz = 2;
  if (!out.curveLufs) {                     // fallback, clearly flagged
    const win = Math.round(sampleRate * 0.5), c = [];
    for (let i = 0; i + win <= signal.length; i += win) {
      let s2 = 0;
      for (let j = i; j < i + win; j++) s2 += signal[j] * signal[j];
      c.push(Math.round(20 * Math.log10(Math.max(Math.sqrt(s2 / win), 1e-6)) * 10) / 10);
    }
    out.curveLufs = c; out.curveIsRmsFallback = true;
  }
  out.errorCount = Object.keys(out.errors).length;
  out.totalMs = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - t0);
  return out;
}

/* Fold a tempo to the octave nearest a personal reference. This is a listener
   preference, not a correction: it never changes the measured value, only which
   octave of it is displayed. 86 with a reference of 160 becomes 172. */
function foldToReference(bpm, ref) {
  if (!bpm || !ref) return bpm;
  let best = bpm, bestD = Math.abs(Math.log2(bpm / ref));
  for (const m of [0.25, 0.5, 1, 2, 4]) {
    const c = bpm * m;
    if (c < 40 || c > 220) continue;
    const d = Math.abs(Math.log2(c / ref));
    if (d < bestD) { bestD = d; best = c; }
  }
  return Math.round(best * 10) / 10;
}

/* Curve for the timeline: EBU R128 short-term loudness (LUFS) mapped to 0..1 over a
   fixed -40..-5 LUFS window. This is a display mapping of a standardised measurement,
   not a derived "score". */
function loudnessCurve01(curveLufs) {
  if (!curveLufs || !curveLufs.length) return [];
  return curveLufs.map(x => {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, (x + 40) / 35));
  });
}

/* ============================ metric catalogue ============================
   No composite "energy" score. Every metric below is a direct Essentia output with
   its real unit. `docRange` is filled in ONLY where Essentia's documentation states
   a range; where it doesn't, axes are scaled from the observed data instead of an
   invented range, and `docRange` stays null.

   series: true  -> a value per time step (graphed as a curve within each track)
   series: false -> one value per track  (graphed as a level across the track)      */
const METRICS = [
  { key: "curveLufs", label: "Loudness over time", unit: "LUFS", series: true,
    algorithm: "LoudnessEBUR128 (shortTermLoudness)", docRange: null,
    note: "EBU R128 short-term loudness, 3s window. Negative; nearer 0 is louder." },
  { key: "bpm", label: "Tempo", unit: "BPM", series: false,
    algorithm: "RhythmExtractor2013", docRange: [40, 208],
    note: "Documented detection range 40-208 BPM." },
  { key: "bpmConfidence", label: "Tempo confidence", unit: "", series: false,
    algorithm: "RhythmExtractor2013", docRange: [0, 5.32],
    note: "Documented: 0 = no confidence, 5.32 = maximum." },
  { key: "danceability", label: "Danceability", unit: "", series: false,
    algorithm: "Danceability (DFA)", docRange: [0, 3],
    note: "Documented output range 0-3." },
  { key: "integratedLoudness", label: "Integrated loudness", unit: "LUFS", series: false,
    algorithm: "LoudnessEBUR128", docRange: null,
    note: "Whole-track EBU R128 loudness." },
  { key: "loudnessRange", label: "Loudness range", unit: "LU", series: false,
    algorithm: "LoudnessEBUR128", docRange: null,
    note: "EBU Tech 3342 loudness range." },
  { key: "dynamicComplexity", label: "Dynamic complexity", unit: "dB", series: false,
    algorithm: "DynamicComplexity", docRange: null,
    note: "Average absolute deviation from global loudness." },
  { key: "centroid", label: "Spectral centroid", unit: "Hz", series: false,
    algorithm: "SpectralCentroidTime", docRange: null,
    note: "Brightness: the spectrum's centre of mass." },
  { key: "beatCount", label: "Beats detected", unit: "beats", series: false,
    algorithm: "RhythmExtractor2013", docRange: null, note: "Number of tracked beats." },
];
const metricByKey = k => METRICS.find(m => m.key === k) || METRICS[0];

/* Read a metric off a stored record. Returns a number, an array (series), or null. */
function metricValue(rec, key) {
  if (!rec) return null;
  if (key === "curveLufs") return rec.curveLufs || null;
  const s = rec.essentia || rec.summary || {};
  if (key === "bpm") return rec.bpm != null ? rec.bpm : s.bpm;
  const v = s[key];
  return Number.isFinite(v) ? v : null;
}

/* Axis bounds: the documented range when one exists, otherwise the observed spread
   with a small margin. Never a made-up "typical" range. */
function metricBounds(key, records) {
  const m = metricByKey(key);
  if (m.docRange) return { min: m.docRange[0], max: m.docRange[1], source: "documented" };
  const vals = [];
  for (const r of records || []) {
    const v = metricValue(r, key);
    if (Array.isArray(v)) { for (const x of v) if (Number.isFinite(x)) vals.push(x); }
    else if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { min: 0, max: 1, source: "empty" };
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (key === "curveLufs") lo = Math.max(lo, -40);      // ignore fade-out tails
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return { min: lo - pad, max: hi + pad, source: "observed" };
}

if (typeof window !== "undefined")
  window.PLAnalysis = { loadEssentia, analyseSignal, loudnessCurve01, foldToReference,
                        METRICS, metricByKey, metricValue, metricBounds,
                        ANALYSIS_VERSION, get essentia(){return essentia} };