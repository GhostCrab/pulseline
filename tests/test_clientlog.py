#!/usr/bin/env python3
"""Tests for scripts/clientlog.py, the client diagnostics reader.

Run:  python tests/test_clientlog.py

Fixtures are built to the shapes `workout.html` actually emits, read off the source
rather than guessed:

  clog() wrapper      workout.html:343   {t, page:"workout", type, ...data}
  server stamp        server.py:142      {srv, ...entry}
  auth                workout.html:364   {grant, status}
  api                 workout.html:443   {method, path, status, msg}
  sdkFail             workout.html:519   {msg, live, target}
  sdk                 workout.html:531   {ev, msg}
  begin               workout.html:957   {target, streamScope, ua}
  beginFail           workout.html:985   {target, msg}

No real log file has been read: `data/` is gitignored and lives on the Pi. These
fixtures are therefore synthetic but shape-accurate. If a real log ever disagrees with
them, the fixtures are what is wrong.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import clientlog  # noqa: E402


def entry(type_, t=1000, page="workout", srv=None, **data):
    rec = {"t": t, "page": page, "type": type_}
    rec.update(data)
    if srv is not None:
        rec["srv"] = srv
    return rec


def jsonl(*records):
    return "\n".join(json.dumps(r) for r in records) + "\n"


def codes(records, bad=()):
    return [f.code for f in clientlog.findings(records, bad)]


def by_code(records, code, bad=()):
    return [f for f in clientlog.findings(records, bad) if f.code == code]


class TestParsing(unittest.TestCase):
    def test_reads_one_object_per_line(self):
        text = jsonl(entry("begin", target="sdk"), entry("api", status=500))
        records, bad = clientlog.parse_lines(text)
        self.assertEqual(len(records), 2)
        self.assertEqual(bad, [])

    def test_blank_lines_are_skipped(self):
        records, bad = clientlog.parse_lines("\n\n" + jsonl(entry("begin")) + "\n")
        self.assertEqual(len(records), 1)
        self.assertEqual(bad, [])

    def test_a_truncated_line_is_counted_not_fatal(self):
        """server.py truncates the serialized line to 2000 chars, so an oversized entry
        is written as invalid JSON. The reader must survive a real file containing one."""
        good = entry("begin", target="sdk")
        text = json.dumps(good) + "\n" + json.dumps(entry("api", msg="x" * 3000))[:2000] + "\n"
        records, bad = clientlog.parse_lines(text)
        self.assertEqual(len(records), 1, "the good line still parses")
        self.assertEqual(len(bad), 1)
        self.assertIn("truncated", bad[0][1])

    def test_a_truncated_line_does_not_hide_later_entries(self):
        text = (json.dumps(entry("api", msg="x" * 3000))[:2000] + "\n"
                + json.dumps(entry("sdkFail", msg="dropped out")) + "\n")
        records, bad = clientlog.parse_lines(text)
        self.assertEqual(len(bad), 1)
        self.assertEqual([r["type"] for r in records], ["sdkFail"])

    def test_a_non_object_line_is_rejected(self):
        records, bad = clientlog.parse_lines("[1,2]\n42\n")
        self.assertEqual(records, [])
        self.assertEqual(len(bad), 2)
        self.assertIn("not a JSON object", bad[0][1])

    def test_line_numbers_in_bad_are_one_based_and_count_blanks(self):
        text = jsonl(entry("begin")) + "\n" + "{bad\n"
        _, bad = clientlog.parse_lines(text)
        self.assertEqual(bad[0][0], 3)


class TestSilentPlaybackSignature(unittest.TestCase):
    """The bug this whole file exists for: quirk 8 + quirk 9."""

    def test_a_run_begun_without_the_streaming_scope_is_HIGH(self):
        found = by_code([entry("begin", target="sdk", streamScope=False, ua="iPhone")],
                        "no-stream-scope")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("quirk 8", found[0].rule)

    def test_a_run_begun_with_the_scope_is_not_reported(self):
        self.assertNotIn("no-stream-scope",
                         codes([entry("begin", target="sdk", streamScope=True)]))

    def test_a_missing_streamScope_key_is_not_treated_as_false(self):
        """Absent is unknown, not false - an older page version may not emit the key."""
        self.assertNotIn("no-stream-scope", codes([entry("begin", target="sdk")]))

    def test_two_playback_errors_inside_15s_is_HIGH(self):
        """workout.html:541-544 drops to SIMULATED on exactly this pairing, because the
        API reports success throughout. These events are the only evidence."""
        records = [entry("sdk", t=1000, ev="playback_error", msg="boom"),
                   entry("sdk", t=9000, ev="playback_error", msg="boom")]
        found = by_code(records, "playback-error-pair")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("quirk 9", found[0].rule)

    def test_two_playback_errors_further_apart_are_not_paired(self):
        """One unplayable track is not the same as no audio: the SDK just skips it."""
        records = [entry("sdk", t=1000, ev="playback_error"),
                   entry("sdk", t=1000 + 15_001, ev="playback_error")]
        self.assertNotIn("playback-error-pair", codes(records))

    def test_a_single_playback_error_is_not_paired(self):
        self.assertNotIn("playback-error-pair", codes([entry("sdk", ev="playback_error")]))

    def test_the_pairing_window_matches_the_page(self):
        # workout.html:542 filters sdkErrTimes with `now - x < 15000`.
        self.assertEqual(clientlog.PLAYBACK_ERROR_WINDOW_MS, 15_000)

    def test_each_named_sdk_error_is_reported_with_its_own_meaning(self):
        for ev, expect in [("authentication_error", "streaming"),
                           ("account_error", "Premium"),
                           ("initialization_error", "could not start"),
                           ("autoplay_failed", "user gesture")]:
            with self.subTest(ev=ev):
                found = by_code([entry("sdk", ev=ev, msg="m")], "sdk-" + ev)
                self.assertEqual(len(found), 1)
                self.assertEqual(found[0].severity, clientlog.HIGH)
                self.assertIn(expect, found[0].message)

    def test_benign_sdk_events_produce_no_finding(self):
        for ev in ["ready", "not_ready"]:
            with self.subTest(ev=ev):
                self.assertEqual(codes([entry("sdk", ev=ev)]), [])


class TestDegradeAndFailure(unittest.TestCase):
    def test_sdkFail_is_reported_with_its_message(self):
        found = by_code([entry("sdkFail", msg="Spotify can't play audio in this app",
                               live=True, target="sdk")], "sdk-fail")
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("can't play audio", found[0].message)

    def test_beginFail_is_reported_with_its_message(self):
        found = by_code([entry("beginFail", target="sdk", msg="no device id")], "begin-fail")
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("no device id", found[0].message)

    def test_a_failure_with_no_message_still_reports(self):
        found = by_code([entry("sdkFail", live=True, target="sdk")], "sdk-fail")
        self.assertEqual(len(found), 1)
        self.assertIn("no message", found[0].message)

    def test_a_contained_run_loop_throw_is_HIGH(self):
        """guardRun() keeps the countdown alive, but the throw is still a real defect -
        before the containment existed this class left no trace at all."""
        found = by_code([entry("loopFail", label="The timeline",
                               msg="songY is not defined")], "loop-fail")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("songY is not defined", found[0].message)
        self.assertIn("orphaned", found[0].message)
        self.assertIn("Hotspots 2", found[0].rule)

    def test_a_loop_failure_with_no_label_still_reports(self):
        found = by_code([entry("loopFail", msg="boom")], "loop-fail")
        self.assertEqual(len(found), 1)
        self.assertIn("Something threw", found[0].message)

    def test_an_in_app_run_with_no_ready_event_is_flagged(self):
        """The 6s device-id race in beginPlayback was lost."""
        found = by_code([entry("begin", target="sdk", streamScope=True)], "no-ready")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.WARN)

    def test_a_ready_event_clears_it(self):
        records = [entry("begin", target="sdk", streamScope=True),
                   entry("sdk", ev="ready")]
        self.assertNotIn("no-ready", codes(records))

    def test_a_spotify_app_run_does_not_expect_a_ready_event(self):
        """target=connect never initialises the in-app player, so `ready` never fires."""
        self.assertNotIn("no-ready",
                         codes([entry("begin", target="connect", streamScope=True)]))


class TestTokenAndApi(unittest.TestCase):
    def test_repeated_401s_are_HIGH_but_a_single_one_is_only_a_warning(self):
        one = by_code([entry("auth", grant="refresh_token", status=401)], "auth-failure")
        self.assertEqual(one[0].severity, clientlog.WARN)

        many = [entry("auth", t=i, grant="refresh_token", status=401) for i in range(3)]
        self.assertEqual(by_code(many, "auth-failure")[0].severity, clientlog.HIGH)

    def test_auth_failures_are_grouped_and_counted(self):
        records = [entry("auth", grant="refresh_token", status=400) for _ in range(4)]
        found = by_code(records, "auth-failure")
        self.assertEqual(len(found), 1, "grouped, not one finding per entry")
        self.assertIn("4 token request", found[0].message)

    def test_a_lost_refresh_race_is_named_rather_than_called_a_dead_session(self):
        found = by_code([entry("auth", grant="refresh_token", status=400)], "auth-failure")
        self.assertIn("lost refresh race", found[0].message)
        self.assertIn("quirk 7", found[0].rule)

    def test_api_failures_are_grouped_by_method_path_and_status(self):
        records = [entry("api", method="PUT", path="/me/player/play", status=502),
                   entry("api", method="PUT", path="/me/player/play", status=502),
                   entry("api", method="GET", path="/me/player", status=403)]
        found = by_code(records, "api-failure")
        self.assertEqual(len(found), 2)
        self.assertIn("2 terminal failure", found[0].message, "busiest group first")

    def test_rate_limiting_is_informational_rather_than_a_warning(self):
        got = by_code([entry("api", method="GET", path="/me/player", status=429)], "api-failure")
        self.assertEqual(got[0].severity, clientlog.INFO)


class TestReportingBehaviour(unittest.TestCase):
    def test_an_empty_log_is_a_warning_not_a_crash(self):
        self.assertEqual(codes([]), ["empty"])

    def test_unreadable_lines_are_reported_as_info(self):
        found = by_code([entry("begin", streamScope=True)], "unreadable-lines",
                        bad=[(7, "truncated or invalid JSON (2000 chars)")])
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("2000", found[0].message)

    def test_a_clean_log_produces_no_findings(self):
        records = [entry("begin", t=1, target="sdk", streamScope=True),
                   entry("sdk", t=2, ev="ready"),
                   entry("sdk", t=3, ev="not_ready")]
        self.assertEqual(codes(records), [])

    def test_srv_is_used_when_the_client_timestamp_is_absent(self):
        rec = {"srv": 5000, "page": "workout", "type": "sdk", "ev": "playback_error"}
        rec2 = {"srv": 9000, "page": "workout", "type": "sdk", "ev": "playback_error"}
        self.assertIn("playback-error-pair", codes([rec, rec2]))

    def test_findings_carry_evidence(self):
        found = by_code([entry("begin", target="sdk", streamScope=False, ua="iPhone OS")],
                        "no-stream-scope")
        self.assertEqual(found[0].evidence[0]["ua"], "iPhone OS")

    def test_summary_counts_events_and_pages(self):
        records = [entry("begin", t=10, target="sdk"), entry("api", t=20, status=500),
                   entry("probe", t=30, page="sdk-probe")]
        s = clientlog.summarise(records)
        self.assertEqual(s["entries"], 3)
        self.assertEqual(s["types"]["begin"], 1)
        self.assertEqual(s["pages"]["sdk-probe"], 1)
        self.assertEqual((s["first"], s["last"]), (10, 30))


class TestCli(unittest.TestCase):
    """report() is what the HITL pass and an agent both call."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="pulseline-clog-")
        self.path = os.path.join(self.dir, "clientlog-u_alice.jsonl")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(text)

    def report(self, **kw):
        """report() prints; swallow it so the suite's own output stays readable."""
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            return clientlog.report(self.path, **kw)

    def test_exit_status_is_1_when_a_high_finding_is_present(self):
        self.write(jsonl(entry("begin", target="sdk", streamScope=False)))
        self.assertEqual(self.report(as_json=True), 1)

    def test_exit_status_is_0_for_a_clean_log(self):
        self.write(jsonl(entry("begin", target="sdk", streamScope=True),
                         entry("sdk", ev="ready")))
        self.assertEqual(self.report(as_json=True), 0)

    def test_a_log_with_only_warnings_does_not_fail_the_pass(self):
        self.write(jsonl(entry("api", method="GET", path="/me/player", status=503)))
        self.assertEqual(self.report(as_json=True), 0)

    def test_a_file_of_entirely_invalid_lines_does_not_crash(self):
        self.write("{bad\n{also bad\n")
        self.assertEqual(self.report(as_json=True), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
