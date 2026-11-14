/* START-sequence probe for workout.html, against the REAL Web Playback SDK.
 *
 * Debug tooling, never loaded by the app. Inject it into an open workout.html:
 *
 *   const s=document.createElement("script");s.src="/debug/start-probe.js";document.head.append(s)
 *
 * It has to be a classic <script>, not an eval in an isolated world: it reads the page's
 * own top-level `sdk`, `W` and `P`, which are lexical globals and not window properties.
 *
 * It only OBSERVES, plus optional fault injection on api.spotify.com calls:
 *
 *   __probe.faults.push({match:"/me/player/shuffle", delayMs:4000})
 *   __probe.faults.push({match:/\/me\/player$/, status:500})      // never reaches Spotify
 *
 * Then pick a workout and tap START by hand (a real tap: script clicks are not a user
 * gesture), wait, and read __probe.report().
 *
 * Why position and not the API's word for it: PUT /me/player/play answers 204 and
 * /me/player says is_playing:true while the in-browser player is silent
 * (docs/agents/spotify-api.md quirk 9). The SDK's own state is the only evidence short
 * of listening.
 */
(function () {
  "use strict";
  if (window.__probe) { console.log("[start-probe] already installed"); return; }

  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const ev = [];                       // one ordered timeline of everything observed
  const faults = [];
  const add = (kind, data) => { ev.push({ t: now(), kind, ...data }); };

  /* The page's view of itself at this instant. Each read is guarded: W is null on the
     splash, and a probe that throws would be one more thing to debug. */
  const page = () => {
    const o = {};
    try { o.clock = +P.t.toFixed(2); o.playing = P.playing; o.started = P.started; } catch (e) { /* splash */ }
    try { o.live = W ? W.live : null; } catch (e) { /* splash */ }
    try { o.btn = document.querySelector("#pauseBtn").textContent; } catch (e) { /* no DOM */ }
    try { o.badge = document.querySelector("#liveTag").textContent; } catch (e) { /* no DOM */ }
    try { o.done = getComputedStyle(document.querySelector("#doneOv")).display !== "none"; } catch (e) { /* no DOM */ }
    return o;
  };
  const trackIndex = uri => {
    try { return W.ws.tracks.findIndex(tr => tr && tr.uri === uri); } catch (e) { return null; }
  };

  /* ---- every Spotify Web API call: when it left, when it answered, with what ---- */
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.startsWith("https://api.spotify.com/")) return realFetch(input, init);
    const method = (init && init.method) || "GET";
    const path = url.replace("https://api.spotify.com/v1", "").split("?")[0];
    const fault = faults.find(f => (f.match instanceof RegExp ? f.match.test(path) : path === f.match)
      && (!f.method || f.method === method));
    const sent = now();
    add("api>", { method, path, fault: fault ? { delayMs: fault.delayMs, status: fault.status } : undefined });
    if (fault && fault.delayMs) await new Promise(r => setTimeout(r, fault.delayMs));
    if (fault && fault.status) {
      add("api<", { method, path, status: fault.status, ms: now() - sent, injected: true });
      return new Response(JSON.stringify({ error: { status: fault.status, message: "injected by start-probe" } }),
        { status: fault.status, headers: { "Content-Type": "application/json" } });
    }
    try {
      const r = await realFetch(input, init);
      add("api<", { method, path, status: r.status, ms: now() - sent });
      return r;
    } catch (e) {
      add("api<", { method, path, error: String(e && e.message || e), ms: now() - sent });
      throw e;
    }
  };

  /* ---- every SDK event, with what the page looked like just after handling it ---- */
  let hooked = null;
  const hook = () => {
    let player = null;
    try { player = sdk; } catch (e) { /* not declared yet */ }
    if (!player || player === hooked) return;
    hooked = player;
    add("sdk-hooked", {});
    ["ready", "not_ready", "initialization_error", "authentication_error", "account_error",
      "playback_error", "autoplay_failed"].forEach(name =>
      player.addListener(name, e => add("sdk:" + name, { msg: (e && e.message) || "", page: page() })));
    player.addListener("player_state_changed", st => {
      if (!st) { add("sdk:state", { state: null, page: page() }); return; }
      const cur = st.track_window && st.track_window.current_track;
      add("sdk:state", {
        paused: st.paused, loading: st.loading, positionMs: st.position,
        uri: cur && cur.uri, name: cur && cur.name, idx: cur ? trackIndex(cur.uri) : null,
        page: page(),
      });
    });
  };
  setInterval(hook, 100);

  /* ---- the START tap, and the page's state sampled around it ---- */
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("#pauseBtn,#exitBtn,.card[data-k]");
    if (b) add("tap", { on: b.id || "card", text: (b.textContent || "").trim().slice(0, 24), before: page() });
  }, true);
  let last = "";
  setInterval(() => {
    const p = page(), key = [p.playing, p.started, p.live, p.btn, p.badge, p.done].join("|");
    if (key !== last) { last = key; add("page", p); }
  }, 50);
  /* A toast is the only thing the user is told, so record its words. */
  const toastEl = document.querySelector("#toast");
  if (toastEl) new MutationObserver(() => {
    const txt = toastEl.textContent.trim();
    if (txt) add("toast", { txt });
  }).observe(toastEl, { childList: true, characterData: true, subtree: true });

  /* ---- verdicts over the most recent START ---- */
  function report() {
    const startAt = ev.map(e => e.kind === "tap" && e.on === "pauseBtn" && e.text === "START").lastIndexOf(true);
    if (startAt < 0) return { error: "no START tap recorded yet", events: ev };
    const run = ev.slice(startAt), T = run[0].t;
    const rel = e => e && e.t - T;
    const playSent = run.find(e => e.kind === "api>" && e.path === "/me/player/play");
    const playDone = run.find(e => e.kind === "api<" && e.path === "/me/player/play");
    const states = run.filter(e => e.kind === "sdk:state");
    const early = states.filter(e => !playSent || e.t < playSent.t);
    const firstAudio = states.find(e => e.idx === 0 && e.paused === false && !e.loading);
    const jumps = [];
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1].page, b = run[i].page;
      if (a && b && Number.isFinite(a.clock) && Number.isFinite(b.clock)) {
        const wall = (run[i].t - run[i - 1].t) / 1000, d = b.clock - a.clock;
        if (Math.abs(d - wall) > 2) jumps.push({ atMs: rel(run[i]), clockFrom: a.clock, clockTo: b.clock, wallSec: +wall.toFixed(2) });
      }
    }
    return {
      callsBeforePlay: run.filter(e => e.kind === "api>" && (!playSent || e.t < playSent.t))
        .map(e => e.method + " " + e.path),
      msStartToPlaySent: rel(playSent),
      msStartToPlayAnswered: rel(playDone), playStatus: playDone && (playDone.status || playDone.error),
      msStartToFirstAudioState: rel(firstAudio),
      playRequests: run.filter(e => e.kind === "api>" && e.path === "/me/player/play").length,
      statesBeforePlaySent: early.map(e => ({ ms: rel(e), paused: e.paused, loading: e.loading,
        idx: e.idx, name: e.name, positionMs: e.positionMs, page: e.page })),
      clockJumps: jumps,
      toasts: run.filter(e => e.kind === "toast").map(e => ({ ms: rel(e), txt: e.txt })),
      sdkErrors: run.filter(e => /^sdk:(playback_error|autoplay_failed|.*_error|not_ready)$/.test(e.kind))
        .map(e => ({ ms: rel(e), kind: e.kind, msg: e.msg })),
      final: page(),
      timeline: run.map(e => ({ ...e, t: e.t - T })),
    };
  }

  window.__probe = { ev, faults, report, page };
  console.log("[start-probe] installed");
})();
