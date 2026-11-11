/* Tests for tests/_page.js, the helpers every page-level suite is built on.
 *
 * Run:  node --test tests/
 *
 * These exist because the helpers have already had two bugs, and a bug here does not
 * announce itself - it makes the suites above quietly test less. `extractFunction`
 * truncated at a default parameter, and `stripComments` going no-op was caught by nothing
 * at all until this file existed, despite being the whole reason the function is there.
 *
 * Fixtures are written inline rather than taken from a page, so these stay true when the
 * pages change.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFunction, stripComments, finallyBody,
        loadClassicScript } = require("./_page.js");

/* ------------------------------ extractFunction ------------------------------ */

test("extracts a plain function whole", () => {
  const src = "before\nfunction f(a){ return a; }\nafter";
  assert.equal(extractFunction(src, "f"), "function f(a){ return a; }");
});

test("REGRESSION: a default parameter's braces are not mistaken for the body", () => {
  /* `async function api(path, opts={}, _depth=0)` came back truncated at `opts={}`, and
   * new Function rejected the fragment - so every test using it failed loudly. Had it
   * produced something parseable, those tests would have passed while testing nothing. */
  const src = "function f(a, opts={}, n=0){ return opts; }";
  assert.equal(extractFunction(src, "f"), src);
});

test("a nested object literal does not end the function early", () => {
  const src = "function f(){ const o = { a: { b: 1 } }; return o; }";
  assert.equal(extractFunction(src, "f"), src);
});

test("the async keyword is kept, or the body cannot be evaluated", () => {
  const src = "async function f(){ await g(); }";
  assert.equal(extractFunction(src, "f"), src);
  // The point of keeping it: new Function on the result must not throw on `await`.
  assert.doesNotThrow(() => new Function(extractFunction(src, "f")));
});

test("a missing function fails loudly rather than returning nothing", () => {
  assert.throws(() => extractFunction("function g(){}", "f"), /no longer defines f\(\)/);
});

test("unbalanced braces are reported, not returned as a fragment", () => {
  assert.throws(() => extractFunction("function f(){ if (x) {", "f"), /unbalanced/);
});

/* ------------------------------- stripComments ------------------------------- */

test("block and line comments are removed", () => {
  assert.equal(stripComments("a /* b */ c // d\ne").trim(), "a   c  \ne".trim());
});

test("REGRESSION: a keyword inside a comment cannot satisfy a structural assertion", () => {
  /* The bug this guards. An assertion compared indexOf("finally") against the whole
   * function text and matched the word in the function's own comment, which sits near
   * the top - so it passed with the construct it was guarding moved out of place.
   *
   * A comment that happens to contain `finally{` is all it takes. */
  const fn = "function f(){ /* reschedules in a finally{ } for safety */ x(); }";
  assert.equal(stripComments(fn).includes("finally"), false,
    "a comment mentioning the keyword must not survive stripping");
});

test("a multi-line block comment is removed entirely", () => {
  const fn = "function f(){\n/* line one\n   finally{ mentioned here\n*/\nreal();\n}";
  const code = stripComments(fn);
  assert.equal(code.includes("finally"), false);
  assert.ok(code.includes("real()"), "the code itself survives");
});

/* -------------------------------- finallyBody -------------------------------- */

test("the finally block's body is returned, not the whole function", () => {
  const fn = "function f(){ try{ a(); } finally { b(); } }";
  assert.match(finallyBody(fn), /b\(\)/);
  assert.equal(finallyBody(fn).includes("a()"), false);
});

test("REGRESSION: a comment mentioning finally{ does not become the block", () => {
  const fn = "function f(){ /* see the finally{ below */ try{ a(); } finally { b(); } }";
  const body = finallyBody(fn);
  assert.match(body, /b\(\)/);
  assert.equal(body.includes("below"), false, "the comment was taken for the block");
});

test("the word inside a string literal does not become the block", () => {
  /* Why the search is `/\bfinally\s*\{/` and not indexOf("finally"): a message that
   * happens to contain the word would otherwise anchor the match, and the next `{` found
   * is the `try{` - so the body returned is the TRY block, and an assertion about the
   * finally silently inspects the wrong code. */
  const fn = 'function f(){ log("get it done finally"); try{ a(); } finally { b(); } }';
  const body = finallyBody(fn);
  assert.match(body, /b\(\)/);
  assert.equal(body.includes("a()"), false, "the try block was returned instead");
});

test("a nested block inside the finally is kept", () => {
  const fn = "function f(){ try{ a(); } finally { if (x) { b(); } c(); } }";
  const body = finallyBody(fn);
  assert.match(body, /b\(\)/);
  assert.match(body, /c\(\)/);
});

test("a function with no finally fails loudly", () => {
  assert.throws(() => finallyBody("function f(){ try{ a(); } catch(e){} }"),
    /no finally block/);
});

/* ----------------------------- loadClassicScript ----------------------------- */

test("a classic script's window assignments come back", () => {
  // config.js is the smallest real one: a single assignment and nothing else.
  const w = loadClassicScript("config.js");
  assert.equal(typeof w.PULSELINE_CLIENT_ID, "string");
});

test("the script's own top-level names do not leak into the test's globals", () => {
  loadClassicScript("analysis-core.js");
  assert.equal(typeof globalThis.METRICS, "undefined",
    "analysis-core.js's declarations escaped into the test realm");
});

test("objects it builds share this realm's intrinsics", () => {
  /* The reason this uses a Function body rather than a vm context. In a vm, an array
   * built by the script has that context's Array.prototype, and deepStrictEqual rejects
   * it against an identical-looking literal - which produced five mystifying failures
   * whose "actual" and "expected" printed the same. */
  const PL = loadClassicScript("analysis-core.js").PLAnalysis;
  assert.deepEqual(PL.loudnessCurve01([-40, -5]), [0, 1]);
  assert.ok(Array.isArray(PL.METRICS));
  assert.equal(Object.getPrototypeOf(PL.METRICS), Array.prototype);
});
