#!/usr/bin/env python3
"""Pulseline guardrail: mechanical checks for mistakes this project has actually made.

Run:  python3 scripts/check.py [--require-eslint]

Checks (each names the docs/DEVELOPING.md section that explains why it exists):
  syntax      every inline <script> and shared .js parses (node --check)
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
SHARED_JS = [os.path.join(ROOT, f) for f in ("analysis-core.js", "config.js")]
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


def check_versions():
    core = open(os.path.join(ROOT, "analysis-core.js"), encoding="utf-8").read()
    m = re.search(r"ANALYSIS_VERSION\s*=\s*(\d+)", core)
    if not m:
        fail("versions", "ANALYSIS_VERSION not found in analysis-core.js")
        return
    want = m.group(1)
    for page in PAGES:
        src = open(page, encoding="utf-8").read()
        for v in re.findall(r"analysis-core\.js\?v=(\d+)", src):
            if v != want:
                fail("versions", f"{rel(page)} loads analysis-core.js?v={v}, ANALYSIS_VERSION is {want}")
        for v in re.findall(r"NEEDS_CORE\s*=\s*(\d+)", src):
            if v != want:
                fail("versions", f"{rel(page)} NEEDS_CORE={v}, ANALYSIS_VERSION is {want}")


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
