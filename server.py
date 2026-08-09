#!/usr/bin/env python3
"""Pulseline server: serves index.html and persists app state to data/state.json.

Run:  python3 server.py [port]     (default port 8888)
"""
import json
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
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
        sp = state_path(self.path)
        if sp is None:
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            json.loads(body.decode("utf-8"))  # refuse to save junk
        except (ValueError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            return
        tmp = sp + ".tmp"
        with open(tmp, "wb") as f:  # atomic write + rolling backup
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(sp):
            try:
                os.replace(sp, sp + ".bak")
            except OSError:
                pass
        os.replace(tmp, sp)
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        # Pages and the manifest must revalidate on every launch — this is what lets the
        # iOS home-screen app pick up new versions just by being closed and reopened.
        p = self.path.split("?")[0]
        if p == "/" or p.endswith((".html", ".json")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, *args):  # keep the console quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8888
    print(f"Pulseline running at http://127.0.0.1:{port}/")
    print(f"State files: {DATA_DIR}/state-<spotify-user>.json (one per account)")
    try:
        HTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")