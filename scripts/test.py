#!/usr/bin/env python3
"""Pulseline test suite: behaviour that scripts/check.py's mechanical checks can't reach.

Run:  python3 scripts/test.py          (on Windows: python scripts/test.py)

This is the third tier of the guardrail:
  1. scripts/check.py      mechanical  - syntax, scopes, version markers, ESLint
  2. CODING_STANDARDS.md   judgement   - read by the reviewer, not the implementer
  3. scripts/test.py       behaviour   - what neither a linter nor a reviewer can catch

Suites:
  python    tests/test_*.py        the state API's HTTP interface and the clientlog reader
  node      tests/*.test.js        analysis-core.js's pure surface, under node --test

Nothing here needs a browser, a Spotify session or the network. Everything runs against
the real shipped files: the server module is imported with its DATA_DIR redirected at a
temp directory, and analysis-core.js is evaluated with a stub `window`.

Both suites are discovered, not listed, so a new `tests/test_*.py` or `tests/*.test.js`
is picked up with no change here.

Python stdlib only. node is located the same way scripts/check.py locates it (nvm only
edits PATH in interactive shells, so hooks and agents often can't see it). Exit status
is non-zero if any suite fails.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check import find_node  # noqa: E402  (same node discovery as the mechanical checks)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Output is not captured: it goes straight to the terminal, so a failure shows the
# runner's own diff. It also sidesteps the Windows cp1252 trap that broke check.py's
# ESLint pass, since nothing is decoded here.
SUITE_NAMES = ("python", "node")

# `-t tests` makes tests/ the top-level directory, so discovery needs no __init__.py.
PY_DISCOVER = ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-t", "tests"]


def say(msg=""):
    # Flushed: subprocess output goes straight to the OS, so an unflushed header
    # would surface after the suite it introduces.
    print(msg, flush=True)


def main():
    require_node = "--require-node" in sys.argv
    node = find_node()
    failed, ran = [], []

    for name in SUITE_NAMES:
        if name == "python":
            argv = [sys.executable] + PY_DISCOVER
        else:
            if not node:
                if require_node:
                    failed.append("node: node not found")
                else:
                    say("\n  node       skipped (node not found; CI always runs it)")
                continue
            argv = [node, "--test"]

        say(f"\n=== {name} " + "=" * (60 - len(name)))
        if subprocess.run(argv, cwd=ROOT).returncode != 0:
            failed.append(name)
        else:
            ran.append(name)

    say()
    if failed:
        say("Pulseline tests FAILED:")
        for f in failed:
            say("  " + f)
        sys.exit(1)
    say("Pulseline tests passed (%s)." % ", ".join(ran))


if __name__ == "__main__":
    main()
