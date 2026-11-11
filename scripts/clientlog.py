#!/usr/bin/env python3
"""Read a client diagnostics log and report what a real device actually saw.

Run:  python3 scripts/clientlog.py data/clientlog-<ns>.jsonl
      python3 scripts/clientlog.py data/clientlog-<ns>.jsonl --json

`workout.html` appends Spotify player events and API failures to
`data/clientlog-<ns>.jsonl` through `POST /api/log/<ns>`. Until now nothing read it
back: the file was the only recorded evidence of real-device behaviour and it was
reachable only by eye. This turns it into findings.

It exists because of `docs/agents/spotify-api.md` quirk 9: `PUT /me/player/play` returns
204 and the server reports `is_playing:true` even when the in-browser player produces
nothing. The SDK events in this log are the ONLY signal that in-app audio failed, which
makes this file the one place the truth survives. Each finding below names the rule it
encodes, so a report can be checked against the docs rather than trusted.

Two shapes of input it must tolerate, both by design of the writer:
  * `server.py` truncates each line to 2000 chars AFTER serializing it, so an oversized
    entry is written as syntactically invalid JSON. Those lines are counted, not fatal.
  * entries queue in the browser until the namespace is known, so `t` ordering can lag
    the `srv` timestamp the server stamps on arrival.

Python stdlib only. Exit status is 1 if any high-severity finding was reported, so this
can gate a human-in-the-loop verification pass.
"""
import argparse
import collections
import json
import os
import sys

# A chosen window, not a measured one: it mirrors the 15s pairing threshold
# workout.html uses to decide the in-app player is failing rather than hiccupping.
PLAYBACK_ERROR_WINDOW_MS = 15_000

# SDK events that mean something specific went wrong, and what each one actually means.
# Sourced from docs/agents/spotify-api.md quirk 9 and workout.html's own listeners.
SDK_EVENT_MEANING = {
    "initialization_error": "the in-app player could not start at all",
    "authentication_error": "token rejected by the player - usually missing the `streaming` scope (quirk 8)",
    "account_error": "the account cannot drive the in-app player (the SDK requires Premium)",
    "autoplay_failed": "playback was not inside a user gesture",
}

HIGH, WARN, INFO = "HIGH", "WARN", "INFO"


class Finding:
    def __init__(self, severity, code, message, rule=None, evidence=()):
        self.severity = severity
        self.code = code
        self.message = message
        self.rule = rule
        self.evidence = list(evidence)

    def as_dict(self):
        return {"severity": self.severity, "code": self.code, "message": self.message,
                "rule": self.rule, "evidence": self.evidence}


def parse_lines(text):
    """Returns (records, bad). `bad` is [(line_number, reason)] - see the module docstring
    on why invalid lines are expected rather than exceptional."""
    records, bad = [], []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            bad.append((n, "truncated or invalid JSON (%d chars)" % len(line)))
            continue
        if not isinstance(rec, dict):
            bad.append((n, "not a JSON object"))
            continue
        records.append(rec)
    return records, bad


def _of_type(records, type_):
    return [r for r in records if r.get("type") == type_]


def _when(rec):
    """Client time if present, else the server's arrival stamp."""
    for k in ("t", "srv"):
        v = rec.get(k)
        if isinstance(v, (int, float)):
            return v
    return 0


def findings(records, bad=()):
    out = []

    if not records:
        out.append(Finding(WARN, "empty", "No readable entries in this log."))
        return out

    # --- the silent-iOS signature: a run began with a token lacking `streaming` -----
    for rec in _of_type(records, "begin"):
        if rec.get("streamScope") is False:
            out.append(Finding(
                HIGH, "no-stream-scope",
                "A run began with a token that lacks the `streaming` scope, so the in-app "
                "player cannot produce audio. This is the signature of the silent-playback "
                "bug: badge reads LIVE, play is accepted, nothing is heard.",
                rule="spotify-api.md quirk 8",
                evidence=[{"t": _when(rec), "target": rec.get("target"), "ua": rec.get("ua")}]))

    # --- repeated playback_error: the only reliable in-app-silence signal -----------
    errs = sorted((_when(r), r) for r in _of_type(records, "sdk")
                  if r.get("ev") == "playback_error")
    for i in range(1, len(errs)):
        gap = errs[i][0] - errs[i - 1][0]
        if 0 <= gap <= PLAYBACK_ERROR_WINDOW_MS:
            out.append(Finding(
                HIGH, "playback-error-pair",
                "Two `playback_error` events %dms apart - the in-app player skipping "
                "through the playlist. The API reports success during this; these events "
                "are the only evidence." % gap,
                rule="spotify-api.md quirk 9",
                evidence=[{"t": e[0], "msg": e[1].get("msg")} for e in errs[i - 1:i + 1]]))
            break

    # --- named SDK failures, each with its own meaning -----------------------------
    for rec in _of_type(records, "sdk"):
        meaning = SDK_EVENT_MEANING.get(rec.get("ev"))
        if meaning:
            out.append(Finding(
                HIGH, "sdk-" + rec["ev"], "`%s`: %s." % (rec["ev"], meaning),
                rule="spotify-api.md quirk 9",
                evidence=[{"t": _when(rec), "msg": rec.get("msg")}]))

    # --- the page told the user it was degrading ------------------------------------
    for rec in _of_type(records, "sdkFail"):
        out.append(Finding(
            HIGH, "sdk-fail",
            "The page dropped out of in-app playback: %s" % (rec.get("msg") or "(no message)"),
            rule="CODING_STANDARDS.md - every fallback is visible",
            evidence=[{"t": _when(rec), "live": rec.get("live"), "target": rec.get("target")}]))

    for rec in _of_type(records, "beginFail"):
        out.append(Finding(
            HIGH, "begin-fail",
            "Starting playback failed: %s" % (rec.get("msg") or "(no message)"),
            evidence=[{"t": _when(rec), "target": rec.get("target")}]))

    # --- the strict-mode orphaning class, caught rather than fatal -------------------
    # guardRun() in workout.html contains a throw inside the run loop so the countdown
    # keeps advancing. Before that containment existed this failed silently: the loop
    # died, the countdown froze and nothing was recorded anywhere. Any entry here is a
    # real defect that reached a device.
    for rec in _of_type(records, "loopFail"):
        out.append(Finding(
            HIGH, "loop-fail",
            "%s threw inside the run loop: %s. The loop was contained and kept running, "
            "but this is a live defect - most likely an identifier orphaned by a moved or "
            "deleted block." % (rec.get("label") or "Something",
                                rec.get("msg") or "(no message)"),
            rule="DEVELOPING.md Hotspots 2",
            evidence=[{"t": _when(rec), "label": rec.get("label"), "msg": rec.get("msg")}]))

    # --- a run that began but never saw the player become ready --------------------
    begins = _of_type(records, "begin")
    sdk_begins = [r for r in begins if r.get("target") == "sdk"]
    ready = [r for r in _of_type(records, "sdk") if r.get("ev") == "ready"]
    if sdk_begins and not ready:
        out.append(Finding(
            WARN, "no-ready",
            "%d in-app run(s) began but no `ready` event was ever logged - the 6s "
            "device-id race may have been lost." % len(sdk_begins),
            evidence=[{"t": _when(r)} for r in sdk_begins]))

    # --- token trouble --------------------------------------------------------------
    auth = _of_type(records, "auth")
    if auth:
        by = collections.Counter((r.get("grant"), r.get("status")) for r in auth)
        for (grant, status), n in sorted(by.items(), key=lambda kv: -kv[1]):
            sev = HIGH if status in (400, 401) and n > 2 else WARN
            out.append(Finding(
                sev, "auth-failure",
                "%d token request(s) failed: grant=%s status=%s. Repeated 400/401 can be a "
                "lost refresh race rather than a dead session." % (n, grant, status),
                rule="spotify-api.md quirk 7",
                evidence=[{"grant": grant, "status": status, "count": n}]))

    # --- API failures that survived the retry ladder --------------------------------
    api = _of_type(records, "api")
    if api:
        by = collections.Counter((r.get("method"), r.get("path"), r.get("status")) for r in api)
        for (method, path, status), n in sorted(by.items(), key=lambda kv: -kv[1]):
            out.append(Finding(
                WARN if status != 429 else INFO, "api-failure",
                "%d terminal failure(s) of %s %s -> %s (after the retry ladder gave up)."
                % (n, method, path, status),
                evidence=[{"method": method, "path": path, "status": status, "count": n}]))

    if bad:
        out.append(Finding(
            INFO, "unreadable-lines",
            "%d line(s) could not be parsed. server.py truncates each line to 2000 chars "
            "after serializing it, so an oversized entry is written as invalid JSON." % len(bad),
            evidence=[{"line": n, "reason": r} for n, r in bad[:10]]))

    return out


def summarise(records):
    types = collections.Counter(r.get("type") for r in records)
    pages = collections.Counter(r.get("page") for r in records)
    times = [_when(r) for r in records if _when(r)]
    return {"entries": len(records), "types": dict(types), "pages": dict(pages),
            "first": min(times) if times else None, "last": max(times) if times else None}


SEV_ORDER = {HIGH: 0, WARN: 1, INFO: 2}


def report(path, as_json=False):
    with open(path, encoding="utf-8", errors="replace") as f:
        records, bad = parse_lines(f.read())
    found = sorted(findings(records, bad), key=lambda f_: SEV_ORDER[f_.severity])
    summary = summarise(records)

    if as_json:
        print(json.dumps({"file": path, "summary": summary,
                          "findings": [f_.as_dict() for f_ in found]}, indent=2))
    else:
        print("%s - %d entries, %d unreadable" % (path, summary["entries"], len(bad)))
        if summary["types"]:
            print("  events: " + ", ".join("%s x%d" % kv for kv in sorted(summary["types"].items())))
        print()
        for f_ in found:
            print("[%s] %s" % (f_.severity, f_.message))
            if f_.rule:
                print("       rule: %s" % f_.rule)
            for e in f_.evidence[:4]:
                print("       %s" % json.dumps(e))
            print()
        if not found:
            print("No findings.")

    return 1 if any(f_.severity == HIGH for f_ in found) else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("path", help="path to a clientlog-<ns>.jsonl file")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()
    if not os.path.exists(args.path):
        print("no such file: %s" % args.path, file=sys.stderr)
        sys.exit(2)
    sys.exit(report(args.path, args.json))


if __name__ == "__main__":
    main()
