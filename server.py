#!/usr/bin/env python3
"""Pulseline server: serves index.html and persists app state to data/state.json.

Run:  python3 server.py [port]     (default port 8888)
"""
import json
import time
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

import re

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)
NS_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def state_path(path):
    """/api/state -> data/state.json (legacy/anon); /api/state/<ns> -> data/state-<ns>.json.
    Namespaces are Spotify user ids, giving each account its own file with no app login."""
    p = path.split("?")[0]
    if p == "/api/state":
        return os.path.join(DATA_DIR, "state.json")
    if p.startswith("/api/state/"):
        ns = p[len("/api/state/"):]
        if NS_RE.match(ns):
            return os.path.join(DATA_DIR, f"state-{ns}.json")
    return None


ANALYSIS_FILE = os.path.join(DATA_DIR, "analysis.json")


def analysis_path(path):
    """Per-track audio analysis, keyed by Spotify track id.

    Deliberately NOT namespaced by user: tempo, loudness and danceability are
    properties of the recording, not of the listener. One shared store means a track
    analysed once is analysed for everyone on this server, and nothing personal ends
    up in it. Anything listener-specific (the tempo reference, the energy weighting)
    is applied at display time from the user's own state file."""
    p = path.split("?")[0]
    if p == "/api/analysis" or p.startswith("/api/analysis/"):
        return ANALYSIS_FILE
    return None


# Slim projection of the analysis store, cached in memory and rebuilt only when the
# file changes. The editor needs summaries and the loudness curve; the full record
# also carries per-frame arrays (momentary loudness alone is ~2250 floats per track)
# which are only needed by the analysis page and raw dumps.
_summary_cache = {"mtime": None, "size": None, "data": None}

SUMMARY_KEEP = ("name", "artists", "durMs", "bpm", "bpmAuto", "bpmEdited",
                "bpmConfidence", "curveHz", "curveIsRmsFallback", "engine", "v", "analyzedAt")



def analysis_summary():
    try:
        st = os.stat(ANALYSIS_FILE)
        key = (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return {"tracks": {}, "view": "summary"}
    if _summary_cache["data"] is not None and _summary_cache["mtime"] == key[0]             and _summary_cache["size"] == key[1]:
        return _summary_cache["data"]
    full = read_json(ANALYSIS_FILE, {"tracks": {}})
    out = {}
    for tid, rec in (full.get("tracks") or {}).items():
        if not isinstance(rec, dict):
            continue
        slim = {k: rec[k] for k in SUMMARY_KEEP if k in rec}
        if isinstance(rec.get("essentia"), dict):
            slim["essentia"] = rec["essentia"]
        if isinstance(rec.get("curveLufs"), list):
            slim["curveLufs"] = rec["curveLufs"]
        if rec.get("errors"):
            slim["errors"] = rec["errors"]
        out[tid] = slim
    data = {"tracks": out, "view": "summary"}
    _summary_cache.update({"mtime": key[0], "size": key[1], "data": data})
    return data


def migrate_analysis():
    """Fold any older per-user analysis files into the shared store, once."""
    merged = read_json(ANALYSIS_FILE, {"tracks": {}})
    tracks = merged.get("tracks") or {}
    changed = False
    for fn in os.listdir(DATA_DIR):
        if fn.startswith("analysis-") and fn.endswith(".json"):
            old = read_json(os.path.join(DATA_DIR, fn), {})
            for tid, data in (old.get("tracks") or {}).items():
                if tid not in tracks:
                    tracks[tid] = data
                    changed = True
            try:
                os.replace(os.path.join(DATA_DIR, fn),
                           os.path.join(DATA_DIR, fn + ".migrated"))
            except OSError:
                pass
    if changed or not os.path.exists(ANALYSIS_FILE):
        write_json_atomic(ANALYSIS_FILE, {"tracks": tracks})


def history_path(path):
    """Workout history lives in its OWN file, never inside the state blob - a client that
    rewrites its state cache can then never clobber logged workouts."""
    p = path.split("?")[0]
    if p.startswith("/api/history/"):
        ns = p[len("/api/history/"):]
        if NS_RE.match(ns):
            return os.path.join(DATA_DIR, f"history-{ns}.json")
    return None


# Client diagnostics: pages append Spotify player events and API failures here so a
# developer (or agent) can read what a phone actually saw, instead of asking for a
# pasted console log. Append-only JSON lines, one file per account, rotated once it
# passes LOG_MAX_BYTES (a storage bound chosen for this app, not a measured value).
LOG_MAX_BYTES = 1_000_000
LOG_ENTRY_MAX_CHARS = 2000


def log_path(path):
    p = path.split("?")[0]
    if p.startswith("/api/log/"):
        ns = p[len("/api/log/"):]
        if NS_RE.match(ns):
            return os.path.join(DATA_DIR, f"clientlog-{ns}.jsonl")
    return None


def append_log(lp, entries):
    try:
        if os.path.getsize(lp) > LOG_MAX_BYTES:
            os.replace(lp, lp + ".1")
    except FileNotFoundError:
        pass
    now = int(time.time() * 1000)
    with open(lp, "a", encoding="utf-8") as f:
        for e in entries[:50]:
            if isinstance(e, dict):
                line = json.dumps({"srv": now, **e}, ensure_ascii=False)
                f.write(line[:LOG_ENTRY_MAX_CHARS] + "\n")


def read_json(path, default):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (FileNotFoundError, ValueError, UnicodeDecodeError):
        return default


def write_json_atomic(path, obj, keep_backups=3):
    """Atomic replace + rolling backups, so a bad write or crash can't lose the file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(path):
        for i in range(keep_backups - 1, 0, -1):
            older, newer = f"{path}.bak{i}", f"{path}.bak{i - 1}" if i > 1 else f"{path}.bak"
            if os.path.exists(newer):

                try:
                    os.replace(newer, older)
                except OSError:
                    pass
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
    os.replace(tmp, path)


def seed_history(hpath, spath):
    """One-time migration: lift any history that still lives inside an old state file."""
    if os.path.exists(hpath):
        return
    st = read_json(spath, {})
    hist = st.get("history")
    if isinstance(hist, list) and hist:
        write_json_atomic(hpath, {"history": hist})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)


    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):

        ap = analysis_path(self.path)
        if ap:
            migrate_analysis()
            if "view=summary" in self.path:
                self._json(analysis_summary())
            else:
                self._json(read_json(ap, {"tracks": {}}))
            return
        hp = history_path(self.path)
        if hp:
            ns = self.path.split("?")[0][len("/api/history/"):]
            seed_history(hp, os.path.join(DATA_DIR, f"state-{ns}.json"))
            self._json(read_json(hp, {"history": []}))
            return
        sp = state_path(self.path)
        if sp is None and self.path.split("?")[0].startswith("/api/"):
            self.send_response(404)
            self.end_headers()
            return
        if sp:
            try:
                with open(sp, "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))  # refuse to save junk
        except (ValueError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            return
        if not isinstance(payload, dict):
            self.send_response(400)
            self.end_headers()
            return

        ap = analysis_path(self.path)
        if ap:  # merge one track's analysis at a time; never a wholesale overwrite
            migrate_analysis()
            cur = read_json(ap, {"tracks": {}})
            tracks = cur.get("tracks") or {}
            op = payload.get("op")
            if op == "put" and isinstance(payload.get("tracks"), dict):
                for tid, data in payload["tracks"].items():
                    if isinstance(tid, str) and isinstance(data, dict):
                        tracks[tid] = data
            elif op == "delete" and payload.get("id"):
                tracks.pop(payload["id"], None)
            elif op == "clear":
                tracks = {}
            else:
                self.send_response(400)
                self.end_headers()
                return
            write_json_atomic(ap, {"tracks": tracks})
            _summary_cache["data"] = None          # invalidate the slim projection
            self._json({"count": len(tracks)})
            return

        lp = log_path(self.path)
        if lp:  # append-only diagnostics; never read back by the app
            entries = payload.get("entries")
            if not isinstance(entries, list):
                self.send_response(400)
                self.end_headers()
                return
            append_log(lp, entries)
            self.send_response(204)
            self.end_headers()
            return

        hp = history_path(self.path)
        if hp:  # append / delete a single entry - never a wholesale overwrite
            ns = self.path.split("?")[0][len("/api/history/"):]
            seed_history(hp, os.path.join(DATA_DIR, f"state-{ns}.json"))
            cur = read_json(hp, {"history": []})
            hist = cur.get("history") or []
            op = payload.get("op")
            if op == "add" and isinstance(payload.get("entry"), dict):
                entry = payload["entry"]
                if not any(h.get("id") == entry.get("id") for h in hist):  # idempotent retry
                    hist.append(entry)
            elif op == "delete" and payload.get("id"):
                hist = [h for h in hist if h.get("id") != payload["id"]]
            else:
                self.send_response(400)
                self.end_headers()
                return
            hist.sort(key=lambda h: h.get("ts", 0))
            write_json_atomic(hp, {"history": hist})
            self._json({"history": hist})
            return


        sp = state_path(self.path)
        if sp is None:
            self.send_response(404)
            self.end_headers()
            return

        # Shallow-merge top-level keys: a client that doesn't know about a key can never
        # delete it by omission (this is what used to wipe history).

        cur = read_json(sp, {})
        cur.update(payload)
        cur.pop("history", None)  # history has its own file now
        write_json_atomic(sp, cur)
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        # Pages and the manifest must revalidate on every launch - this is what lets the
        # iOS home-screen app pick up new versions just by being closed and reopened.
        p = self.path.split("?")[0]
        # .js included deliberately: a stale cached script is indistinguishable from
        # a code bug ("X is not a function") and wastes a lot of debugging time.
        if p == "/" or p.endswith((".html", ".json", ".js", ".css")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, *args):  # keep the console quiet
        pass


if __name__ == "__main__":
    # Usage: server.py [port] [host]
    # Host defaults to loopback, which is what you want when a tunnel (cloudflared)
    # runs on the same machine. Use 0.0.0.0 to also serve the local network.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PULSELINE_PORT", 8888))
    host = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("PULSELINE_HOST", "127.0.0.1")
    print(f"Pulseline running at http://{host}:{port}/")
    print(f"State files: {DATA_DIR}/state-<spotify-user>.json (one per account)")
    try:
        HTTPServer((host, port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

