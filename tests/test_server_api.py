#!/usr/bin/env python3
"""Characterisation tests for server.py's HTTP interface.

Run:  python tests/test_server_api.py          (or: python -m unittest discover -s tests)

These pin the state API's *documented invariants* - the ones docs/DEVELOPING.md
"Storage model" tells you not to change - so a refactor that breaks one fails here
instead of silently losing a user's workspaces.

Python stdlib only, no browser, no Spotify session: the state API has no auth in
front of it by design (docs/adr/0002), which is what makes it reachable from a test.

The server module is imported and its DATA_DIR/ROOT/ANALYSIS_FILE globals are
redirected at a temp directory per test. Every path helper reads those globals at
call time, so no source change is needed.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


def request(url, method="GET", body=None, raw_body=None):
    """Returns (status, headers, text). Does not raise on 4xx/5xx."""
    data = raw_body if raw_body is not None else (
        json.dumps(body).encode("utf-8") if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8")


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pulseline-test-")
        self._saved = (server.DATA_DIR, server.ROOT, server.ANALYSIS_FILE)
        server.DATA_DIR = self.tmp
        server.ROOT = self.tmp
        server.ANALYSIS_FILE = os.path.join(self.tmp, "analysis.json")
        # _summary_cache is mutated in place, so reset its contents rather than rebind.
        server._summary_cache.update({"mtime": None, "size": None, "data": None})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        # poll_interval drives how long shutdown() blocks; the default 0.5s dominates
        # the whole suite's runtime when every test starts its own server.
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server.DATA_DIR, server.ROOT, server.ANALYSIS_FILE = self._saved
        server._summary_cache.update({"mtime": None, "size": None, "data": None})
        shutil.rmtree(self.tmp, ignore_errors=True)

    def get(self, path):
        return request(self.base + path)

    def post(self, path, body=None, raw_body=None):
        return request(self.base + path, method="POST", body=body, raw_body=raw_body)

    def datafile(self, name):
        return os.path.join(self.tmp, name)

    def write_data(self, name, obj):
        with open(self.datafile(name), "w", encoding="utf-8") as f:
            json.dump(obj, f)


class TestStateApi(ServerCase):
    NS = "u_alice"

    def test_missing_state_file_reads_as_empty_object(self):
        status, _, text = self.get("/api/state/" + self.NS)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text), {})

    def test_post_then_get_roundtrip(self):
        status, _, _ = self.post("/api/state/" + self.NS, {"workspaces": {"a": 1}})
        self.assertEqual(status, 204)
        _, _, text = self.get("/api/state/" + self.NS)
        self.assertEqual(json.loads(text), {"workspaces": {"a": 1}})

    def test_shallow_merge_means_a_key_cannot_be_deleted_by_omission(self):
        """docs/DEVELOPING.md Storage model: this is what used to wipe history."""
        self.post("/api/state/" + self.NS, {"workspaces": {"a": 1}, "prefs": {"x": 2}})
        self.post("/api/state/" + self.NS, {"workspaces": {"b": 3}})
        _, _, text = self.get("/api/state/" + self.NS)
        saved = json.loads(text)
        self.assertEqual(saved["workspaces"], {"b": 3}, "top-level key is replaced")
        self.assertEqual(saved["prefs"], {"x": 2}, "omitted key must survive")

    def test_history_key_is_force_dropped_from_state(self):
        """History has its own file; a state write must never carry it."""
        self.post("/api/state/" + self.NS, {"workspaces": {}, "history": [{"id": "h1"}]})
        _, _, text = self.get("/api/state/" + self.NS)
        self.assertNotIn("history", json.loads(text))

    def test_legacy_unnamespaced_state_route(self):
        status, _, _ = self.post("/api/state", {"workspaces": {}})
        self.assertEqual(status, 204)
        self.assertTrue(os.path.exists(self.datafile("state.json")))

    def test_namespace_outside_NS_RE_is_404(self):
        for bad in ["u_alice!", "has space", "a" * 65, ""]:
            with self.subTest(ns=bad):
                status, _, _ = self.get("/api/state/" + bad.replace(" ", "%20"))
                self.assertEqual(status, 404)

    def test_namespace_at_the_64_char_limit_is_accepted(self):
        status, _, _ = self.get("/api/state/" + "a" * 64)
        self.assertEqual(status, 200)

    def test_malformed_body_is_400(self):
        status, _, _ = self.post("/api/state/" + self.NS, raw_body=b"{not json")
        self.assertEqual(status, 400)

    def test_non_object_body_is_400(self):
        for raw in [b"[1,2]", b'"a string"', b"42", b"null"]:
            with self.subTest(raw=raw):
                status, _, _ = self.post("/api/state/" + self.NS, raw_body=raw)
                self.assertEqual(status, 400)

    def test_body_is_parsed_before_routing_so_bad_body_beats_bad_route(self):
        """do_POST reads and parses the body first: a malformed body on an unknown
        route yields 400, not 404. Dispatch order is part of the interface."""
        bad_route_bad_body = self.post("/api/nope", raw_body=b"{not json")[0]
        bad_route_ok_body = self.post("/api/nope", {"a": 1})[0]
        self.assertEqual(bad_route_bad_body, 400)
        self.assertEqual(bad_route_ok_body, 404)


class TestHistoryApi(ServerCase):
    NS = "u_alice"

    def path(self):
        return "/api/history/" + self.NS

    def test_missing_history_reads_as_empty_list(self):
        status, _, text = self.get(self.path())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text), {"history": []})

    def test_add_returns_the_full_list(self):
        status, _, text = self.post(self.path(), {"op": "add", "entry": {"id": "h1", "ts": 10}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["history"], [{"id": "h1", "ts": 10}])

    def test_add_is_idempotent_on_entry_id(self):
        """A retried POST must not double-log a workout."""
        entry = {"id": "h1", "ts": 10}
        self.post(self.path(), {"op": "add", "entry": entry})
        _, _, text = self.post(self.path(), {"op": "add", "entry": entry})
        self.assertEqual(len(json.loads(text)["history"]), 1)

    def test_history_is_sorted_ascending_by_ts(self):
        for ts in [30, 10, 20]:
            self.post(self.path(), {"op": "add", "entry": {"id": "h%d" % ts, "ts": ts}})
        _, _, text = self.get(self.path())
        self.assertEqual([h["ts"] for h in json.loads(text)["history"]], [10, 20, 30])

    def test_entry_without_ts_sorts_as_zero(self):
        self.post(self.path(), {"op": "add", "entry": {"id": "h1", "ts": 10}})
        _, _, text = self.post(self.path(), {"op": "add", "entry": {"id": "h2"}})
        self.assertEqual([h["id"] for h in json.loads(text)["history"]], ["h2", "h1"])

    def test_delete_by_id(self):
        self.post(self.path(), {"op": "add", "entry": {"id": "h1", "ts": 10}})
        self.post(self.path(), {"op": "add", "entry": {"id": "h2", "ts": 20}})
        _, _, text = self.post(self.path(), {"op": "delete", "id": "h1"})
        self.assertEqual([h["id"] for h in json.loads(text)["history"]], ["h2"])

    def test_unknown_op_is_400(self):
        for body in [{"op": "replace", "history": []}, {}, {"op": "add"}, {"op": "delete"}]:
            with self.subTest(body=body):
                self.assertEqual(self.post(self.path(), body)[0], 400)

    def test_legacy_history_inside_a_state_file_is_lifted_on_first_read(self):
        """seed_history: one-time migration out of the old state blob."""
        self.write_data("state-%s.json" % self.NS,
                        {"workspaces": {}, "history": [{"id": "old", "ts": 5}]})
        _, _, text = self.get(self.path())
        self.assertEqual(json.loads(text)["history"], [{"id": "old", "ts": 5}])
        self.assertTrue(os.path.exists(self.datafile("history-%s.json" % self.NS)))

    def test_migration_does_not_run_once_the_history_file_exists(self):
        self.write_data("history-%s.json" % self.NS, {"history": []})
        self.write_data("state-%s.json" % self.NS, {"history": [{"id": "old", "ts": 5}]})
        _, _, text = self.get(self.path())
        self.assertEqual(json.loads(text)["history"], [])

    def test_namespace_outside_NS_RE_is_404(self):
        self.assertEqual(self.get("/api/history/bad!ns")[0], 404)


class TestClientLogApi(ServerCase):
    NS = "u_alice"

    def path(self):
        return "/api/log/" + self.NS

    def logfile(self):
        return self.datafile("clientlog-%s.jsonl" % self.NS)

    def lines(self):
        with open(self.logfile(), encoding="utf-8") as f:
            return [ln for ln in f.read().split("\n") if ln]

    def test_append_returns_204_and_injects_srv_timestamp(self):
        status, _, body = self.post(self.path(), {"entries": [{"t": 1, "type": "begin"}]})
        self.assertEqual(status, 204)
        self.assertEqual(body, "")
        rec = json.loads(self.lines()[0])
        self.assertEqual(rec["type"], "begin")
        self.assertIsInstance(rec["srv"], int)

    def test_entries_must_be_a_list(self):
        for body in [{"entries": {"t": 1}}, {"entries": "x"}, {}]:
            with self.subTest(body=body):
                self.assertEqual(self.post(self.path(), body)[0], 400)

    def test_non_dict_entries_are_dropped_silently(self):
        self.post(self.path(), {"entries": [{"t": 1}, "junk", 42, None, {"t": 2}]})
        self.assertEqual(len(self.lines()), 2)

    def test_at_most_50_entries_are_written_per_request(self):
        self.post(self.path(), {"entries": [{"t": i} for i in range(120)]})
        self.assertEqual(len(self.lines()), 50)

    def test_an_oversized_entry_is_truncated_into_invalid_json(self):
        """Known shape of the data, not a desirable one: the 2000-char cap is applied
        to the serialized line, so an oversized entry produces a line that will not
        parse. Any reader of clientlog-<ns>.jsonl must tolerate this."""
        self.post(self.path(), {"entries": [{"t": 1, "msg": "x" * 5000}]})
        line = self.lines()[0]
        self.assertEqual(len(line), server.LOG_ENTRY_MAX_CHARS)
        with self.assertRaises(ValueError):
            json.loads(line)

    def test_rotation_keeps_exactly_one_generation(self):
        with open(self.logfile(), "w", encoding="utf-8") as f:
            f.write("x" * (server.LOG_MAX_BYTES + 1))
        self.post(self.path(), {"entries": [{"t": 1}]})
        self.assertTrue(os.path.exists(self.logfile() + ".1"))
        self.assertEqual(len(self.lines()), 1, "rotated file starts fresh")

        with open(self.logfile(), "w", encoding="utf-8") as f:
            f.write("y" * (server.LOG_MAX_BYTES + 1))
        self.post(self.path(), {"entries": [{"t": 2}]})
        with open(self.logfile() + ".1", encoding="utf-8") as f:
            self.assertTrue(f.read().startswith("y"), "previous .1 is overwritten")

    def test_there_is_no_read_route(self):
        """The log is write-only over HTTP; it is read off disk by a human or an agent."""
        self.assertEqual(self.get(self.path())[0], 404)


class TestAnalysisApi(ServerCase):
    def test_missing_store_reads_as_empty_tracks(self):
        status, _, text = self.get("/api/analysis")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text), {"tracks": {}})

    def test_put_merges_per_track(self):
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": {"bpm": 120}}})
        _, _, text = self.post("/api/analysis", {"op": "put", "tracks": {"t2": {"bpm": 130}}})
        self.assertEqual(json.loads(text), {"count": 2})
        _, _, text = self.get("/api/analysis")
        self.assertEqual(set(json.loads(text)["tracks"]), {"t1", "t2"})

    def test_put_ignores_non_string_keys_and_non_dict_records(self):
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": "not a dict"}})
        _, _, text = self.get("/api/analysis")
        self.assertEqual(json.loads(text)["tracks"], {})

    def test_delete_and_clear(self):
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": {}, "t2": {}}})
        _, _, text = self.post("/api/analysis", {"op": "delete", "id": "t1"})
        self.assertEqual(json.loads(text), {"count": 1})
        _, _, text = self.post("/api/analysis", {"op": "clear"})
        self.assertEqual(json.loads(text), {"count": 0})

    def test_unknown_op_is_400(self):
        for body in [{"op": "nope"}, {}, {"op": "put", "tracks": "x"}, {"op": "delete"}]:
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/analysis", body)[0], 400)

    def test_any_analysis_suffix_maps_to_the_same_shared_store(self):
        """Deliberately not namespaced: analysis describes the recording, not the listener."""
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": {"bpm": 120}}})
        for path in ["/api/analysis", "/api/analysis/", "/api/analysis/u_alice",
                     "/api/analysis/anything/at/all"]:
            with self.subTest(path=path):
                _, _, text = self.get(path)
                self.assertIn("t1", json.loads(text)["tracks"])

    def test_summary_projects_only_the_fields_the_editor_needs(self):
        record = {
            "name": "Song", "artists": "Band", "durMs": 1000, "bpm": 120,
            "essentia": {"danceability": 0.5},
            "curveLufs": [-20.0, -21.0],
            "errors": {"stage": "boom"},
            "curve": [0.1, 0.2],                 # display curve: deliberately dropped
            "raw": {"huge": [0] * 10},           # per-frame arrays: deliberately dropped
        }
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": record}})
        _, _, text = self.get("/api/analysis?view=summary")
        out = json.loads(text)
        self.assertEqual(out["view"], "summary")
        slim = out["tracks"]["t1"]
        self.assertEqual(slim["name"], "Song")
        self.assertEqual(slim["essentia"], {"danceability": 0.5})
        self.assertEqual(slim["curveLufs"], [-20.0, -21.0])
        self.assertEqual(slim["errors"], {"stage": "boom"})
        self.assertNotIn("raw", slim)
        self.assertNotIn("curve", slim,
                         "curve is not in SUMMARY_KEEP, so the editor never receives it")

    def test_summary_skips_non_dict_records(self):
        self.write_data("analysis.json", {"tracks": {"t1": "junk", "t2": {"name": "ok"}}})
        _, _, text = self.get("/api/analysis?view=summary")
        self.assertEqual(list(json.loads(text)["tracks"]), ["t2"])

    def test_summary_is_matched_by_substring_not_query_parsing(self):
        """"view=summary" in self.path - so it also fires inside another parameter."""
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": {"name": "Song"}}})
        _, _, text = self.get("/api/analysis?foo=view=summary")
        self.assertEqual(json.loads(text).get("view"), "summary")

    def test_a_write_invalidates_the_summary_cache(self):
        self.post("/api/analysis", {"op": "put", "tracks": {"t1": {"name": "one"}}})
        self.get("/api/analysis?view=summary")
        self.post("/api/analysis", {"op": "put", "tracks": {"t2": {"name": "two"}}})
        _, _, text = self.get("/api/analysis?view=summary")
        self.assertEqual(set(json.loads(text)["tracks"]), {"t1", "t2"})

    def test_summary_cache_keys_on_mtime_and_size_only(self):
        """Documents a known limitation: an out-of-band edit that preserves both
        mtime_ns and size is not seen. Only reachable by writing the file directly,
        which the app never does - every write goes through write_json_atomic."""
        self.write_data("analysis.json", {"tracks": {"t1": {"name": "AAAA"}}})
        before = os.stat(self.datafile("analysis.json"))
        _, _, text = self.get("/api/analysis?view=summary")
        self.assertEqual(json.loads(text)["tracks"]["t1"]["name"], "AAAA")

        self.write_data("analysis.json", {"tracks": {"t1": {"name": "BBBB"}}})
        os.utime(self.datafile("analysis.json"), ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(os.stat(self.datafile("analysis.json")).st_size, before.st_size)

        _, _, text = self.get("/api/analysis?view=summary")
        self.assertEqual(json.loads(text)["tracks"]["t1"]["name"], "AAAA",
                         "stale: same mtime_ns and size means the cache is reused")

    def test_legacy_per_user_analysis_files_are_folded_in_once(self):
        self.write_data("analysis-u_alice.json", {"tracks": {"t1": {"bpm": 120}}})
        _, _, text = self.get("/api/analysis")
        self.assertIn("t1", json.loads(text)["tracks"])
        self.assertTrue(os.path.exists(self.datafile("analysis-u_alice.json.migrated")))
        self.assertFalse(os.path.exists(self.datafile("analysis-u_alice.json")))

    def test_migration_does_not_overwrite_a_track_already_in_the_shared_store(self):
        self.write_data("analysis.json", {"tracks": {"t1": {"bpm": 999}}})
        self.write_data("analysis-u_alice.json", {"tracks": {"t1": {"bpm": 120}}})
        _, _, text = self.get("/api/analysis")
        self.assertEqual(json.loads(text)["tracks"]["t1"]["bpm"], 999)


class TestCachePolicy(ServerCase):
    def test_api_json_responses_are_no_store(self):
        _, headers, _ = self.get("/api/state/u_alice")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_pages_and_scripts_must_revalidate(self):
        """A stale cached .js is indistinguishable from a code bug, so .js is included."""
        for name in ["index.html", "config.js", "manifest.json", "style.css"]:
            with open(self.datafile(name), "w", encoding="utf-8") as f:
                f.write("x")
        for name in ["index.html", "config.js", "manifest.json", "style.css"]:
            with self.subTest(name=name):
                _, headers, _ = self.get("/" + name)
                self.assertEqual(headers["Cache-Control"], "no-cache, must-revalidate")

    def test_the_root_path_must_revalidate(self):
        with open(self.datafile("index.html"), "w", encoding="utf-8") as f:
            f.write("x")
        _, headers, _ = self.get("/")
        self.assertEqual(headers["Cache-Control"], "no-cache, must-revalidate")


class TestAtomicWrite(unittest.TestCase):
    """write_json_atomic is called directly: it has no HTTP surface of its own."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pulseline-test-")
        self.path = os.path.join(self.tmp, "state.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def read(self, p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def test_first_write_creates_no_backup(self):
        server.write_json_atomic(self.path, {"v": 1})
        self.assertEqual(self.read(self.path), {"v": 1})
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_backups_roll_and_stop_at_keep_backups(self):
        for v in range(1, 6):
            server.write_json_atomic(self.path, {"v": v})
        self.assertEqual(self.read(self.path), {"v": 5})
        self.assertEqual(self.read(self.path + ".bak"), {"v": 4})
        self.assertEqual(self.read(self.path + ".bak1"), {"v": 3})
        self.assertEqual(self.read(self.path + ".bak2"), {"v": 2})
        self.assertFalse(os.path.exists(self.path + ".bak3"))

    def test_no_temp_file_is_left_behind(self):
        server.write_json_atomic(self.path, {"v": 1})
        self.assertFalse(os.path.exists(self.path + ".tmp"))


class TestReadJson(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pulseline-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_corrupt_and_non_utf8_all_fall_back_to_the_default(self):
        missing = os.path.join(self.tmp, "nope.json")
        corrupt = os.path.join(self.tmp, "corrupt.json")
        binary = os.path.join(self.tmp, "binary.json")
        with open(corrupt, "w", encoding="utf-8") as f:
            f.write("{not json")
        with open(binary, "wb") as f:
            f.write(b"\xff\xfe\x00bad")
        for p in (missing, corrupt, binary):
            with self.subTest(path=os.path.basename(p)):
                self.assertEqual(server.read_json(p, {"fallback": True}), {"fallback": True})


if __name__ == "__main__":
    unittest.main(verbosity=2)
