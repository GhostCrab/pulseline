/* Shared helpers for testing code that lives inside a page.
 *
 * Not a test file: `node --test` only collects `*.test.js`, so this is required, never run.
 *
 * The pages cannot be evaluated outside a browser - `const cvs=$("#tl"),
 * ctx=cvs.getContext("2d")` runs at module-evaluation time and the boot IIFE reaches the
 * network - so a function is lifted out by brace matching and evaluated on its own with
 * its dependencies injected. The tests then run against the real shipped text: rename the
 * function in the page and the extraction fails loudly rather than testing nothing.
 *
 * Lifted here because two suites already use it and the extractor has had two bugs worth
 * fixing once: it matched the braces of a DEFAULT PARAMETER value, and it needs the
 * `async` keyword or `new Function` chokes on the `await` inside.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function readPage(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

/* `function <name>(...) {...}` lifted whole, by brace matching. */
function extractFunction(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `the page no longer defines ${name}()`);
  // Keep an `async` prefix: without it the body has `await` in a sync function and
  // new Function() throws.
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6;

  /* Skip the parameter list by matching parens FIRST. Scanning for the next "{" from the
   * name finds the braces inside a default value instead - `api(path, opts={}, _depth=0)`
   * came back truncated at `opts={}`, and new Function rejected the fragment. */
  let i = src.indexOf("(", start), parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) { i++; break; }
  }
  i = src.indexOf("{", i);
  assert.notEqual(i, -1, `could not find the body of ${name}()`);

  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

/* Strip comments before any structural assertion.
 *
 * Required, not optional: an assertion comparing `indexOf("finally")` against the whole
 * function text matched the word "finally" in that function's own explanatory comment,
 * which sits near the top. The assertion could never fail, and it passed happily with the
 * construct it was guarding moved out. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/* The body of a function's `finally` block, by brace matching - so an assertion reads
 * "this is INSIDE the block", not "this appears later in the file than the block". */
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

/* Evaluate a whole classic script and hand back what it assigned to `window`.
 *
 * Inside a Function body, so the script's top-level declarations stay function-scoped and
 * nothing leaks into the test's globals - while still running in THIS realm, so arrays
 * and objects it builds share the host's intrinsics and deepStrictEqual works on them. A
 * vm context gives them that context's Object.prototype instead, and every structural
 * assertion then fails against an identical-looking literal. */
function loadClassicScript(file, extraGlobals = {}) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const names = ["window", ...Object.keys(extraGlobals)];
  const factory = new Function(...names, src + "\n;return window;");
  const window = {};
  return factory(window, ...Object.values(extraGlobals));
}

module.exports = { ROOT, readPage, extractFunction, stripComments, finallyBody,
                   loadClassicScript };
