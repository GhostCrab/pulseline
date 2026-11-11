#!/usr/bin/env python3
"""Prove a test can fail. Applies a deliberate break, runs the suite, puts the file back.

    python3 scripts/mutate.py <file> <old> <new>
    python3 scripts/mutate.py --spec mutations.json
    python3 scripts/mutate.py <file> <old> <new> -- node --test tests/sync-core.test.js

docs/DEVELOPING.md says to watch every new test fail before trusting it, because a test
that has only ever passed proves nothing. This session alone produced four tests that
passed without exercising anything: an assertion matching the word "finally" in a
comment, an extractor silently truncating at a default parameter, a call-site scan that
missed the paths built into variables, and an invented threshold. Every one was caught by
a mutation and by nothing else.

Doing it by hand is five steps - snapshot, assert the pattern is unique, apply, run,
restore - and two of those hand-rolled scripts corrupted the file they were editing. This
is the same five steps, with the restore guaranteed and verified.

**A mutation that leaves the suite GREEN is the failure.** It means the test cannot tell
the difference, so this exits non-zero on green and zero on red: the inverse of a test
runner, which is the whole point.

Python stdlib only. The file is restored on success, on failure, on a crash, and on
Ctrl-C; if the restore itself fails it says so loudly rather than leaving you dirty.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CMD = [sys.executable, os.path.join("scripts", "test.py")]


def rel(p):
    try:
        return os.path.relpath(p, ROOT).replace(os.sep, "/")
    except ValueError:
        return p


class Restore:
    """Snapshot one file and put it back, verifying it really went back."""

    def __init__(self, path):
        self.path = path
        fd, self.snap = tempfile.mkstemp(prefix="mutate-", suffix=".snap")
        os.close(fd)
        shutil.copy2(path, self.snap)
        if not self._same():
            raise SystemExit("could not snapshot %s - refusing to mutate" % rel(path))

    def _same(self):
        with open(self.path, "rb") as a, open(self.snap, "rb") as b:
            return a.read() == b.read()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.copy2(self.snap, self.path)
        ok = self._same()
        os.unlink(self.snap)
        if not ok:
            print("\n!!! %s was NOT restored - check it before committing" % rel(self.path),
                  file=sys.stderr)
            raise SystemExit(2)
        return False


def apply_mutation(path, old, new):
    """Replace `old` with `new`, insisting the pattern is unique first.

    A pattern matching 0 times silently tests nothing; matching 2+ times mutates
    somewhere you did not mean. Both have happened by hand, so both abort."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    n = src.count(old)
    if n != 1:
        raise SystemExit("pattern occurs %d times in %s (needs exactly 1):\n  %s"
                         % (n, rel(path), old.strip().splitlines()[0][:90]))
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(src.replace(old, new, 1))
    with open(path, encoding="utf-8") as f:
        if new and new not in f.read():
            raise SystemExit("mutation did not land in %s" % rel(path))


def run(cmd):
    """Returns (passed, output). Output is captured so the summary stays readable."""
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0, (r.stdout or "") + (r.stderr or "")


# unittest, node's TAP reporter, and node's default reporter respectively. The last marks
# a failure with U+2716, built with chr() so this file stays ASCII: scripts/check.py's
# `ascii` check requires that of every .py here, and it caught a `\u` escape being turned
# back into the literal glyph by a later rewrite of this very file.
FAIL_PREFIXES = ("FAIL: ", "ERROR: ", "not ok ", chr(0x2716) + " ")


def ascii_only(s):
    """Test output carries glyphs a Windows console cannot encode - node's reporter
    marks a failure with U+2716 - and printing one raises UnicodeEncodeError on cp1252.
    That trap has now bitten this project three times, including inside the tool written
    to catch mistakes. Normalise before printing anything that came from a subprocess."""
    return s.encode("ascii", "replace").decode("ascii")


def failing_lines(output):
    """The lines a human wants: the named failures, from whichever runner ran."""
    seen, out = set(), []
    for line in output.splitlines():
        s = line.strip()
        if s.startswith(FAIL_PREFIXES) and s not in seen and "failing tests" not in s:
            seen.add(s)
            for p in FAIL_PREFIXES:
                if s.startswith(p):
                    s = s[len(p):]
                    break
            out.append(ascii_only(s)[:120])
    return out


def one(path, old, new, cmd, name=None):
    """Apply one mutation, run the suite, restore. True when the mutation was caught."""
    label = name or (old.strip().splitlines()[0][:70] if old.strip() else "(deletion)")
    print("\n=== %s" % label)
    print("    %s" % rel(path))
    with Restore(path):
        apply_mutation(path, old, new)
        passed, output = run(cmd)
    caught = not passed
    if caught:
        for line in failing_lines(output)[:8] or ["(suite failed without naming a test)"]:
            print("    caught by: %s" % line)
    else:
        print("    NOT CAUGHT - the suite stayed green, so no test can tell the "
              "difference. That test does not test this.")
    return caught


def main():
    ap = argparse.ArgumentParser(
        description="Apply a deliberate break, run the suite, restore the file.",
        epilog="Put the test command after `--`. Exits non-zero when a mutation is NOT "
               "caught: green is the failure here.")
    ap.add_argument("file", nargs="?", help="the file to mutate")
    ap.add_argument("old", nargs="?", help="text to replace (must occur exactly once)")
    ap.add_argument("new", nargs="?", help="replacement ('' to delete)")
    ap.add_argument("--spec", help="JSON list of {file, old, new, name} for a batch")
    # Everything after a literal `--` is the test command. Split it off before argparse
    # sees it: as a positional it was read as file/old/new whenever --spec was given,
    # and the explicit command was then silently ignored.
    argv = sys.argv[1:]
    cmd = DEFAULT_CMD
    if "--" in argv:
        i = argv.index("--")
        argv, cmd = argv[:i], argv[i + 1:] or DEFAULT_CMD
    args = ap.parse_args(argv)

    if args.spec:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        if not isinstance(spec, list) or not spec:
            raise SystemExit("--spec must be a non-empty JSON list")
        mutations = [(os.path.join(ROOT, m["file"]), m["old"], m.get("new", ""),
                      m.get("name")) for m in spec]
    else:
        if not (args.file and args.old is not None):
            ap.error("give a file and a pattern, or --spec")
        mutations = [(os.path.join(ROOT, args.file), args.old, args.new or "", None)]

    # A baseline run first: a suite that is already red cannot prove anything about a
    # mutation, and that mistake wastes a whole round.
    print("baseline: %s" % " ".join(rel(c) for c in cmd))
    passed, output = run(cmd)
    if not passed:
        print("\nThe suite is ALREADY failing, so no mutation can prove anything.")
        for line in failing_lines(output)[:8]:
            print("  %s" % line)
        return 2
    print("    green")

    results = [(name or rel(path), one(path, old, new, cmd, name))
               for path, old, new, name in mutations]

    print("\n%s" % ("-" * 60))
    missed = [n for n, caught in results if not caught]
    for n, caught in results:
        print("  %-7s %s" % ("caught" if caught else "MISSED", n))
    if missed:
        print("\n%d of %d mutation(s) not caught." % (len(missed), len(results)))
        return 1
    print("\nAll %d mutation(s) caught." % len(results))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # Restore already ran via the context manager's __exit__.
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
