#!/usr/bin/env python3
"""Pulseline guardrail: mechanical checks for mistakes this project has actually made.

Run:  python3 scripts/check.py [--require-eslint]

Checks (each names the docs/DEVELOPING.md section that explains why it exists):
  syntax      every inline <script> and shared .js parses (node --check)
  combined    each page parses TOGETHER with the shared scripts it loads, so a
              top-level name leaked by a shared file cannot collide with the page
  scopes      every page's Spotify login requests the identical scope list
              (one stored token serves all pages; spotify-api.md quirk 8)
  versions    ANALYSIS_VERSION == every analysis-core.js?v=N == NEEDS_CORE
              ("Caching and version skew")
  boxchars    no box-drawing characters in .py files ("Operational notes")
  debugtags   no leftover [DEBUG-...] instrumentation
  eslint      no-undef / no-redeclare etc. over the same scripts, if `npm install`
              has been run (required in CI via --require-eslint)

Python stdlib only. Exit status is non-zero if any check fails.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = sorted(glob.glob(os.path.join(ROOT, "*.html")) + glob.glob(os.path.join(ROOT, "debug", "*.html")))
SHARED_JS = [os.path.join(ROOT, f) for f in ("analysis-core.js", "config.js", "sync-core.js")]
INLINE_RE = re.compile(r"<script>(.*?)</script>", re.S)

failures = []


def rel(p):
    return os.path.relpath(p, ROOT).replace(os.sep, "/")


def fail(check, msg):
    failures.append(f"[{check}] {msg}")


def inline_scripts(page):
    """Yield (code, first_line) for each inline script, first_line being the 1-based
    line in the .html where the script body starts, so errors map back to the page."""
    src = open(page, encoding="utf-8").read()
    for m in INLINE_RE.finditer(src):
        yield m.group(1), src.count("\n", 0, m.start(1)) + 1


def find_node():
    """node on PATH, else the newest nvm install (nvm only edits PATH in interactive
    shells, so hooks and agents often can't see it)."""
    n = shutil.which("node")
    if n:
        return n
    cands = glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node"))
    for env in ("NVM_SYMLINK", "NVM_HOME", "ProgramFiles"):
        base = os.environ.get(env)
        if base:
            cands += glob.glob(os.path.join(base, "node.exe")) + glob.glob(os.path.join(base, "nodejs", "node.exe"))
    def ver(p):
        m = re.search(r"v(\d+)\.(\d+)\.(\d+)", p)
        return tuple(int(x) for x in m.groups()) if m else (0,)
    cands.sort(key=ver)
    return cands[-1] if cands else None


def check_syntax(node):
    with tempfile.TemporaryDirectory() as td:
        for page in PAGES:
            for i, (code, line0) in enumerate(inline_scripts(page)):
                tmp = os.path.join(td, f"{os.path.basename(page)}.{i}.js")
                open(tmp, "w", encoding="utf-8").write(code)
                r = subprocess.run([node, "--check", tmp], capture_output=True, text=True, encoding="utf-8")
                if r.returncode:
                    m = re.search(re.escape(tmp) + r":(\d+)", r.stderr)
                    where = f"{rel(page)}:{line0 + int(m.group(1)) - 1}" if m else rel(page)
                    err = next((l for l in r.stderr.splitlines() if "Error" in l), r.stderr.strip()[:200])
                    fail("syntax", f"{where}: {err}")
        for js in SHARED_JS:
            r = subprocess.run([node, "--check", js], capture_output=True, text=True, encoding="utf-8")
            if r.returncode:
                fail("syntax", f"{rel(js)}: {r.stderr.strip()[:300]}")


SCRIPT_TAG_RE = re.compile(r"<script(?:\s+src=\"([^\"]+)\")?\s*>(.*?)</script>", re.S)


def page_program(page):
    """The page's scripts in document order, concatenated the way a browser evaluates
    them: one shared global scope. Remote scripts (the Spotify SDK) are skipped."""
    src = open(page, encoding="utf-8").read()
    parts = []
    for m in SCRIPT_TAG_RE.finditer(src):
        href, inline = m.group(1), m.group(2)
        if href:
            if href.startswith(("http://", "https://", "//")):
                continue
            path = os.path.normpath(os.path.join(os.path.dirname(page), href.split("?")[0]))
            if os.path.exists(path):
                parts.append(open(path, encoding="utf-8").read())
        elif inline.strip():
            parts.append(inline)
    return "\n;\n".join(parts)


def check_combined(node):
    """Parse each page TOGETHER with the shared scripts it loads.

    check_syntax above parses every script in isolation, which cannot see a collision
    between them. Classic scripts share one global scope, so a top-level declaration in
    a shared file takes that name for the whole page: sync-core.js once declared
    `function spansOf`, workout.html declared `const spansOf`, and the page died with
    "Identifier 'spansOf' has already been declared" -- while every isolated check
    passed. ESLint's no-redeclare is per-file too, so it missed it as well.

    Any shared .js that leaks top-level names is a trap for every page that loads it.
    Wrap it in an IIFE and expose one object, as sync-core.js does."""
    with tempfile.TemporaryDirectory() as td:
        for page in PAGES:
            program = page_program(page)
            if not program.strip():
                continue
            tmp = os.path.join(td, os.path.basename(page) + ".combined.js")
            open(tmp, "w", encoding="utf-8").write(program)
            r = subprocess.run([node, "--check", tmp], capture_output=True, text=True,
                               encoding="utf-8")
            if r.returncode:
                err = next((l for l in r.stderr.splitlines() if "Error" in l),
                           r.stderr.strip()[:200])
                fail("combined", f"{rel(page)} with its shared scripts: {err}")


def check_scopes():
    found = {}
    for page in PAGES:
        for m in re.finditer(r'scope:\s*"([a-z\- ]+)"', open(page, encoding="utf-8").read()):
            found[rel(page)] = frozenset(m.group(1).split())
    if not found:
        fail("scopes", "no Spotify login scope list found in any page")
        return
    sets = set(found.values())
    if len(sets) > 1:
        union = frozenset().union(*sets)
        for page, s in sorted(found.items()):
            if s != union:
                fail("scopes", f"{page} is missing {' '.join(sorted(union - s))} (all pages share one token)")


def _shared_version(filename, const, marker, needs):
    """One shared script's three numbers must agree: the version constant in the file,
    every `<file>?v=N` cache-buster that loads it, and every page's NEEDS_* gate.
    Cloudflare caches .js and ignores the server's no-cache, so the query string is what
    forces the edge to re-fetch; the gate is what catches it having served a stale body
    anyway ("Caching and version skew")."""
    src = open(os.path.join(ROOT, filename), encoding="utf-8").read()
    m = re.search(const + r"\s*=\s*(\d+)", src)
    if not m:
        fail("versions", f"{const} not found in {filename}")
        return
    want = m.group(1)
    for page in PAGES:
        page_src = open(page, encoding="utf-8").read()
        for v in re.findall(marker + r"\?v=(\d+)", page_src):
            if v != want:
                fail("versions", f"{rel(page)} loads {filename}?v={v}, {const} is {want}")
        for v in re.findall(needs + r"\s*=\s*(\d+)", page_src):
            if v != want:
                fail("versions", f"{rel(page)} {needs}={v}, {const} is {want}")
        # A shared script loaded with no ?v= at all is the silent case: the edge may
        # serve an old body indefinitely and nothing says so.
        if re.search(r'src\s*=\s*"[^"]*' + marker + r'"', page_src):
            fail("versions", f"{rel(page)} loads {filename} with no ?v= cache-buster")


def check_versions():
    _shared_version("analysis-core.js", "ANALYSIS_VERSION", r"analysis-core\.js", "NEEDS_CORE")
    _shared_version("sync-core.js", "SYNC_VERSION", r"sync-core\.js", "NEEDS_SYNC")

    # config.js carries no version constant of its own - it is one line - but it is
    # served through the same edge cache, so every page must agree on its marker.
    seen = {}
    for page in PAGES:
        src = open(page, encoding="utf-8").read()
        for v in re.findall(r"config\.js\?v=(\d+)", src):
            seen.setdefault(v, []).append(rel(page))
        if re.search(r'src\s*=\s*"[^"]*config\.js"', src):
            fail("versions", f"{rel(page)} loads config.js with no ?v= cache-buster")
    if len(seen) > 1:
        detail = "; ".join(f"v={v} in {', '.join(p)}" for v, p in sorted(seen.items()))
        fail("versions", f"pages disagree on config.js?v=N ({detail})")


def check_boxchars():
    for py in glob.glob(os.path.join(ROOT, "**", "*.py"), recursive=True):
        for n, line in enumerate(open(py, encoding="utf-8"), 1):
            if re.search("[\u2500-\u257f]", line):
                fail("boxchars", f"{rel(py)}:{n}: box-drawing character (pasted from a README diagram?)")


def check_debugtags():
    files = PAGES + SHARED_JS + glob.glob(os.path.join(ROOT, "*.py"))
    for f in files:
        for n, line in enumerate(open(f, encoding="utf-8"), 1):
            if "[DEBUG-" in line:
                fail("debugtags", f"{rel(f)}:{n}: leftover debug instrumentation")


def check_eslint(node, required):
    eslint = os.path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js")
    if not os.path.exists(eslint):
        if required:
            fail("eslint", "ESLint not installed: run `npm ci` first")
        else:
            print("  eslint     skipped (run `npm install` to enable; CI always runs it)")
        return
    jobs = [(code, line0, page) for page in PAGES for code, line0 in inline_scripts(page)]
    jobs += [(open(js, encoding="utf-8").read(), 1, js) for js in SHARED_JS]
    for code, line0, src in jobs:
        r = subprocess.run([node, eslint, "--format", "json", "--stdin", "--stdin-filename",
                            os.path.join(ROOT, rel(src).replace("/", "_") + ".js")],
                           input=code, capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
        try:
            results = json.loads(r.stdout)
        except ValueError:
            fail("eslint", f"{rel(src)}: eslint did not run: {(r.stderr or r.stdout).strip()[:300]}")
            continue
        for res in results:
            for msg in res.get("messages", []):
                if msg.get("severity", 0) >= 2:
                    fail("eslint", f"{rel(src)}:{line0 + msg.get('line', 1) - 1}: {msg.get('message')} ({msg.get('ruleId')})")


def main():
    required = "--require-eslint" in sys.argv
    node = find_node()
    if not node:
        fail("node", "node not found (needed for the syntax check); install Node.js or add it to PATH")
    else:
        check_syntax(node)
        check_combined(node)
    check_scopes()
    check_versions()
    check_boxchars()
    check_debugtags()
    if node:
        check_eslint(node, required)
    if failures:
        print("Pulseline checks FAILED:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print(f"Pulseline checks passed ({len(PAGES)} pages).")


if __name__ == "__main__":
    main()
