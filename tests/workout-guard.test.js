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
const fs = require("node:fs");
const path = require("node:path");

const PAGE = path.join(__dirname, "..", "workout.html");
const src = fs.readFileSync(PAGE, "utf8");

/* Extract `function <name>(...){...}` by brace matching, so the test breaks loudly if
 * the function is renamed or removed rather than silently testing nothing. */
function extractFunction(name) {
  const start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `workout.html no longer defines ${name}()`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

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

/* Comments must be stripped before any structural check. The first version of these
 * tests matched indexOf("finally") against the whole function text and so matched the
 * word "finally" in tick()'s own explanatory comment - which sits near the top, making
 * the assertion unfalsifiable. It passed happily with the reschedule moved out of the
 * block. Strip first, then look for the keyword. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/* The body of the function's `finally` block, by brace matching - so the assertion is
 * "the reschedule is INSIDE this block", not "it appears later in the file". */
function finallyBody(fnText) {
  const code = stripComments(fnText);
  const kw = code.search(/\bfinally\s*\{/);
  assert.notEqual(kw, -1, "no finally block");
  let i = code.indexOf("{", kw), depth = 0, start = i + 1;
  for (; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i);
  }
  throw new Error("unbalanced braces in finally block");
}

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

/* ---- applySync: the decision from sync-core, applied and reported ---- */

/* Builds applySync with stub W, P and toast, so the latch behaviour and the clock
 * effects can be exercised without a browser. */
function freshApply() {
  const toasts = [];
  const W = { warned: { shuffle: false, noMatch: false, order: false } };
  const P = { t: 100, slew: 0, last: 0 };
  const factory = new Function("W", "P", "toast", "performance",
    extractFunction("applySync") + "\nreturn applySync;");
  return { applySync: factory(W, P, (m) => toasts.push(m), { now: () => 12345 }),
           W, P, toasts };
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
  const factory = new Function("W", "P", "toast", "performance",
    extractFunction("applySync") + "\nreturn applySync;");
  const P = { t: 100, slew: 0, last: 0 };
  const applySync = factory(null, P, () => {}, { now: () => 1 });
  assert.doesNotThrow(() => applySync({ action: "none", diagnosis: "noMatch" }));
  assert.doesNotThrow(() => applySync({ action: "snap", to: 5, diagnosis: "orderDrift" }));
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
