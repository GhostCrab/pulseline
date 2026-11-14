#!/usr/bin/env python3
"""commit-msg guardrail: a commit that changes the fragile playback path must say, step
by step, how the sequence was re-verified.

    python3 scripts/commit_msg.py <path-to-commit-message>      (run by .githooks/commit-msg)

CODING_STANDARDS.md "The fragile path is re-verified end to end" asked for this in prose
and it did not hold. The 2026-11-11 change to a uris start shipped with the handoff
broken, and the start fix of 2026-11-14 shipped with the handoff unverified; the handoff
stayed broken for three days. A rule that a reviewer has to remember is tier 2; this is
the same rule in tier 1 (docs/DEVELOPING.md, "The three tiers of guardrail").

It does not demand that every step was verified - a device is not always to hand. It
demands that each step is ACCOUNTED for, so "not verified" is written down by the person
who knows it, instead of discovered by the person holding the phone.

When the staged workout.html changes any function in FRAGILE, the message must carry one
line per step:

    Re-verified:
      start: yes - real SDK in Chrome, first playing state 383ms after START
      pause: yes - button, in Chrome
      external pause: no - no second client to hand
      finish: yes - completion card shown, music still playing
      completion card: yes
      handoff: no - not exercised; needs the phone

Python stdlib only. "Touched" is decided by comparing each function's text in HEAD with
its text in the index, not by diff hunk headers, which name the wrong function as often
as the right one in a 90KB inline script.
"""
import re
import subprocess
import sys

PAGE = "workout.html"

# The functions CODING_STANDARDS.md names - beginPlayback(), pause handling, completion,
# handoff, and the token code under them - plus the helpers those were split into.
FRAGILE = (
    "beginPlayback", "forceLinearPlayback", "playBody", "onSdkState", "setPaused",
    "reviveSession", "endWorkout", "doHandoff", "handoffBody", "tryLocalHandoff",
    "livePosition", "tokenRequest", "refreshToken", "ensureToken",
)

# The sequence, in the order hitl-workout.sh gives it.
STEPS = ("start", "pause", "external pause", "finish", "completion card", "handoff")

# How much has to follow "yes"/"no" before it counts as evidence. A chosen value: enough
# to rule out a bare "yes", not an attempt to judge the evidence.
MIN_EVIDENCE_CHARS = 3


def extract_function(src, name):
    """`function <name>(...) {...}` lifted whole by brace matching, or None.

    The same approach as tests/_page.js, including skipping the parameter list first so
    the braces of a default value (`opts={}`) are not mistaken for the body."""
    start = src.find("function " + name + "(")
    if start < 0:
        return None
    i, parens = src.find("(", start), 0
    while i < len(src):
        if src[i] == "(":
            parens += 1
        elif src[i] == ")":
            parens -= 1
            if parens == 0:
                break
        i += 1
    i = src.find("{", i)
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
    return None


def touched(old_src, new_src):
    """Names in FRAGILE whose text differs between the two versions of the page. A
    function added, removed or renamed counts: all three are changes to the path."""
    return [n for n in FRAGILE if extract_function(old_src, n) != extract_function(new_src, n)]


def accounted(message):
    """{step: 'yes'|'no'} for every step the message accounts for with evidence."""
    out = {}
    for step in STEPS:
        m = re.search(r"(?im)^[ \t]*(?:[-*][ \t]*)?%s[ \t]*:[ \t]*(yes|no)\b(.*)$"
                      % re.escape(step), message)
        if m and len(re.sub(r"^[\s\-:,.(]+", "", m.group(2))) >= MIN_EVIDENCE_CHARS:
            out[step] = m.group(1).lower()
    return out


def strip_comments(message):
    """Drop everything under the scissors line of `commit -v`, which is the diff itself
    and may quote an older message. Git's ordinary `#` lines need no stripping: a step
    line is matched from the start of the line, so a commented one cannot count."""
    lines = []
    for line in message.splitlines():
        if line.startswith("# ------------------------ >8"):
            break
        lines.append(line)
    return "\n".join(lines)


def exempt(message):
    """Commits that restate or combine other commits carry no verification of their own."""
    first = message.strip().splitlines()[0] if message.strip() else ""
    return first.startswith(("Merge ", "Revert ", "fixup! ", "squash! ", "amend! "))


def problems(message, old_src, new_src):
    """(touched function names, steps not accounted for). Both empty means it passes."""
    message = strip_comments(message)
    if exempt(message):
        return [], []
    names = touched(old_src, new_src)
    if not names:
        return [], []
    done = accounted(message)
    return names, [s for s in STEPS if s not in done]


def git_show(spec):
    r = subprocess.run(["git", "show", spec], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""


def main(argv):
    if len(argv) != 2:
        print("usage: commit_msg.py <commit-message-file>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8", errors="replace") as f:
        message = f.read()
    names, missing = problems(message, git_show("HEAD:" + PAGE), git_show(":" + PAGE))
    if not missing:
        return 0
    print("commit-msg: this commit changes the fragile playback path in %s:" % PAGE)
    print("    " + ", ".join(names))
    print()
    print("Say how each step of the sequence was re-verified. Not accounted for:")
    print("    " + ", ".join(missing))
    print()
    print("One line per step, `yes` or `no`, each followed by the evidence or the reason:")
    print()
    print("    Re-verified:")
    for s in STEPS:
        print("      %s: yes - <how>   |   no - <why not>" % s)
    print()
    print("`no` is an acceptable answer. An unaccounted step is not.")
    print("(CODING_STANDARDS.md, \"The fragile path is re-verified end to end\")")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
