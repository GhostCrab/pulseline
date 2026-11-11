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
import glob
import json
import os
import sys
import time

# A chosen window, not a measured one: it mirrors the 15s pairing threshold
# workout.html uses to decide the in-app player is failing rather than hiccupping.
PLAYBACK_ERROR_WINDOW_MS = 15_000

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A chosen value, not a measured one: entries further apart than this are treated as
# separate workouts. One log accumulates every run ever made on that account.
SESSION_GAP_MS = 10 * 60 * 1000

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

    # --- the forced-linear sequence failed outright ---------------------------------
    for rec in _of_type(records, "linearFail"):
        out.append(Finding(
            HIGH, "linear-fail",
            "The %s call failed while forcing linear playback: %s%s. Playback may be "
            "shuffled or repeating, so the timeline will not match the audio."
            % (rec.get("step") or "ordering", rec.get("msg") or "(no message)",
               " [%s - a client-side fault, not a Spotify rejection; a rejection would "
               "also have logged an `api` entry]" % rec["name"]
               if rec.get("name") and rec["name"] != "Error" else ""),
            rule="spotify-api.md quirk 4 (activate, shuffle off, repeat off, then play)",
            evidence=[{"t": _when(rec), "step": rec.get("step")}]))

    # --- what Spotify actually reported about shuffle --------------------------------
    # Recorded rather than interpreted. "Smart shuffle" is a third state that does not
    # appear in docs/spotify/open-api-schema.yaml, so the point of this entry is to find
    # out what the real field is called and what it holds, from a real device.
    for rec in _of_type(records, "shuffleState"):
        observed = rec.get("observed") or {}
        unknown = {k: v for k, v in observed.items() if k != "shuffle_state"}
        when = rec.get("when") or "unlabelled"
        # A before-play reading showing shuffle on is not itself a problem: it may just
        # be propagating. Only the end state earns a warning.
        # An undocumented field merely being PRESENT is informational; only one that is
        # actually on, or shuffle itself being on, earns a warning.
        unknown_on = any(v for v in unknown.values())
        sev = (INFO if when == "before-play"
               else WARN if (observed.get("shuffle_state") or unknown_on) else INFO)
        extra = ""
        if unknown:
            on = [k for k, v in unknown.items() if v]
            extra = (" %s is on, and is not described in the OpenAPI spec at all - that "
                     "is what smart shuffle looks like" % ", ".join(on) if on else
                     " %s is present but off; the OpenAPI spec does not describe it"
                     % ", ".join(unknown))
        out.append(Finding(
            sev, "shuffle-state",
            "Spotify reported %s (%s).%s"
            % (json.dumps(observed) if observed else "no shuffle field at all",
               when, extra),
            evidence=[{"t": _when(rec), "observed": observed,
                       "repeat": rec.get("repeat"), "ctx": rec.get("ctx")}]))

    # --- which step loses the shuffle setting ---------------------------------------
    # The whole point of taking two readings. quirk 4: setting shuffle AFTER play does
    # not reorder the queue, so "the call was ignored" and "play re-enabled it" need
    # completely different fixes and must not be confused.
    shuf = _of_type(records, "shuffleState")
    pre = [r for r in shuf if r.get("when") == "before-play"]
    post = [r for r in shuf if r.get("when") == "after-play"]
    if pre and post:
        pre_on = bool((pre[-1].get("observed") or {}).get("shuffle_state"))
        post_on = bool((post[-1].get("observed") or {}).get("shuffle_state"))
        ev = [{"before": pre[-1].get("observed"), "after": post[-1].get("observed")}]
        if not post_on:
            # The END STATE is what matters. Shuffle still reading on before play only
            # means the setting had not propagated yet, which the settle-and-verify step
            # in forceLinearPlayback exists to absorb. Judging on the before reading
            # alone cried wolf on a run that finished correctly.
            out.append(Finding(
                INFO, "shuffle-clean",
                "Shuffle was off once playback started%s."
                % (" (it still read as on before play, which is the setting "
                   "propagating)" if pre_on else ""),
                evidence=ev))
        elif pre_on:
            out.append(Finding(
                HIGH, "shuffle-call-ignored",
                "Shuffle was on before play AND still on after it, so the call never "
                "took - most likely the transferred device was not active yet when it "
                "landed, and the single retry did not catch it either.",
                rule="spotify-api.md quirk 4", evidence=ev))
        else:
            out.append(Finding(
                HIGH, "shuffle-reenabled-by-play",
                "The forced-linear sequence DID turn shuffle off, and starting playback "
                "turned it back on. Per quirk 4 this cannot be fixed by re-applying "
                "shuffle afterwards, because that does not reorder the queue - the "
                "context_uri start is what reintroduces it.",
                rule="spotify-api.md quirk 4", evidence=ev))

    for rec in _of_type(records, "shuffleRetry"):
        out.append(Finding(
            INFO, "shuffle-retried",
            "Shuffle had not taken by the time it was checked, so it was re-applied "
            "before play. Expected occasionally; the setting propagates asynchronously.",
            evidence=[{"t": _when(rec)}]))

    # --- a success whose body would not parse ----------------------------------------
    for rec in _of_type(records, "apiBody"):
        out.append(Finding(
            INFO, "unparseable-success-body",
            "%s %s answered %s with a body that is not JSON: %r. Treated as success, "
            "because a 2xx is a success and the body is informational."
            % (rec.get("method"), rec.get("path"), rec.get("status"), rec.get("head")),
            evidence=[{"t": _when(rec), "head": rec.get("head")}]))

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


def find_logs(data_dir=None):
    """Every live client log, newest first. Rotated `.1` files are left out: they are
    the previous generation and `append_log` keeps only one."""
    d = data_dir or os.path.join(ROOT, "data")
    paths = glob.glob(os.path.join(d, "clientlog-*.jsonl"))
    return sorted(paths, key=lambda p: os.path.getmtime(p), reverse=True)


def split_sessions(records, gap_ms=SESSION_GAP_MS):
    """Group entries into sessions, splitting wherever the clock jumps by more than
    gap_ms. A log accumulates across every workout ever run on that account, so without
    this a report mixes last week's findings into today's."""
    ordered = sorted(records, key=_when)
    sessions, current, last = [], [], None
    for rec in ordered:
        t = _when(rec)
        if last is not None and t and last and t - last > gap_ms:
            sessions.append(current)
            current = []
        current.append(rec)
        last = t or last
    if current:
        sessions.append(current)
    return sessions


def _age(seconds):
    if seconds < 90:
        return "%ds ago" % int(seconds)
    if seconds < 5400:
        return "%dm ago" % round(seconds / 60)
    if seconds < 172800:
        return "%.1fh ago" % (seconds / 3600)
    return "%dd ago" % round(seconds / 86400)


def _window(records):
    times = [_when(r) for r in records if _when(r)]
    if not times:
        return "unknown time"
    span = (max(times) - min(times)) / 1000
    when = _age(max(0, time.time() - max(times) / 1000))
    return "%s, lasting %dm %02ds" % (when, span // 60, span % 60)


def report(path, as_json=False, scope="last"):
    with open(path, encoding="utf-8", errors="replace") as f:
        records, bad = parse_lines(f.read())

    sessions = split_sessions(records)
    if scope == "last" and len(sessions) > 1:
        chosen, note = sessions[-1], ("latest of %d sessions in this log; "
                                      "--all to report every one" % len(sessions))
    else:
        chosen, note = records, ("all %d session(s)" % max(1, len(sessions)))

    found = sorted(findings(chosen, bad), key=lambda f_: SEV_ORDER[f_.severity])
    summary = summarise(chosen)

    if as_json:
        print(json.dumps({"file": path, "scope": scope, "sessions": len(sessions),
                          "summary": summary,
                          "findings": [f_.as_dict() for f_ in found]}, indent=2))
    else:
        print("%s" % rel(path))
        print("  %s - %s" % (_window(chosen), note))
        print("  %d entries, %d unreadable" % (summary["entries"], len(bad)))
        if summary["types"]:
            print("  events: " + ", ".join("%s x%d" % kv
                                           for kv in sorted(summary["types"].items())))
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


def rel(path):
    try:
        return os.path.relpath(path, ROOT).replace(os.sep, "/")
    except ValueError:
        return path


def main():
    ap = argparse.ArgumentParser(
        description="Report what a real device saw, from its client diagnostics log.",
        epilog="With no arguments: the newest log in data/, latest session only.")
    ap.add_argument("path", nargs="?",
                    help="a clientlog-<ns>.jsonl file (default: the newest in data/)")
    ap.add_argument("--all", action="store_true",
                    help="report every session in the log, not just the latest")
    ap.add_argument("--list", action="store_true", help="list the logs that exist")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    logs = find_logs()

    if args.list:
        if not logs:
            print("no logs in %s" % os.path.join(ROOT, "data"))
            return 0
        for p in logs:
            recs, _ = parse_lines(open(p, encoding="utf-8", errors="replace").read())
            print("%-44s %7d entries  %2d session(s)  %s"
                  % (rel(p), len(recs), len(split_sessions(recs)),
                     _age(max(0, time.time() - os.path.getmtime(p)))))
        return 0

    path = args.path or (logs[0] if logs else None)
    if not path:
        print("No client log found in %s" % os.path.join(ROOT, "data"), file=sys.stderr)
        print("", file=sys.stderr)
        print("The log is written by whichever server served the page. If the workout",
              file=sys.stderr)
        print("ran against production it is on the Pi at /opt/pulseline/data/ - copy one",
              file=sys.stderr)
        print("down, or pass a path explicitly.", file=sys.stderr)
        return 2
    if not os.path.exists(path):
        print("no such file: %s" % path, file=sys.stderr)
        return 2

    return report(path, args.json, "all" if args.all else "last")


if __name__ == "__main__":
    sys.exit(main())
