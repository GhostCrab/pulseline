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

    def test_a_failed_forced_linear_step_is_HIGH(self):
        found = by_code([entry("linearFail", step="shuffle", msg="403 Forbidden")],
                        "linear-fail")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("shuffle", found[0].message)
        self.assertIn("quirk 4", found[0].rule)

    def test_a_clean_shuffle_report_is_only_informational(self):
        found = by_code([entry("shuffleState", observed={"shuffle_state": False},
                               repeat="off")], "shuffle-state")
        self.assertEqual(found[0].severity, clientlog.INFO)

    def test_a_raw_reading_is_informational_whatever_shuffle_says(self):
        """The raw readings are observations; the per-run verdicts are the interpretation
        and carry the severity. Reporting both at WARN meant a single run produced four
        warnings describing one situation."""
        for state in (True, False):
            found = by_code([entry("shuffleState", observed={"shuffle_state": state})],
                            "shuffle-state")
            self.assertEqual(found[0].severity, clientlog.INFO, state)

    def test_an_undocumented_shuffle_field_that_is_ON_is_called_out(self):
        """Smart shuffle is a third state the OpenAPI spec does not describe. We do not
        guess its field name - we record whatever Spotify sends and flag anything beyond
        the documented `shuffle_state`."""
        found = by_code([entry("shuffleState",
                               observed={"shuffle_state": False, "smart_shuffle": True})],
                        "shuffle-state")
        # Still a warning: an undocumented field being ON is genuinely novel.
        self.assertEqual(found[0].severity, clientlog.WARN)
        self.assertIn("smart_shuffle", found[0].message)
        self.assertIn("OpenAPI spec", found[0].message)
        self.assertIn("is on", found[0].message)

    def test_an_undocumented_field_that_is_OFF_is_not_called_shuffle(self):
        """A real device reported {"shuffle_state": true, "smart_shuffle": false}: plain
        shuffle, not the third state. Saying "that is what smart shuffle looks like"
        there would send the next reader down the wrong path."""
        found = by_code([entry("shuffleState",
                               observed={"shuffle_state": True, "smart_shuffle": False})],
                        "shuffle-state")
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("present but off", found[0].message)
        self.assertNotIn("what smart shuffle looks like", found[0].message)

    def test_no_shuffle_field_at_all_is_reported_plainly(self):
        found = by_code([entry("shuffleState", observed={})], "shuffle-state")
        self.assertIn("no shuffle field at all", found[0].message)

    def test_shuffle_off_before_play_and_on_after_blames_play(self):
        """quirk 4: setting shuffle after play does not reorder the queue, so this
        verdict and the next one need completely different fixes.

        WARN rather than HIGH, deliberately: shuffle_state is a flag about the player and
        says nothing on its own about whether the queue is in timeline order. A real run
        showed the order warning firing while the playlist played correctly. Only a
        live-sync verdict can turn this into an alarm."""
        found = by_code([
            entry("shuffleState", t=1, when="before-play", observed={"shuffle_state": False}),
            entry("shuffleState", t=2, when="after-play", observed={"shuffle_state": True}),
        ], "shuffle-reenabled-by-play")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.WARN)
        self.assertIn("re-enabled the flag", found[0].message)
        self.assertIn("separate question", found[0].message)

    def test_shuffle_on_before_AND_after_blames_the_ignored_call(self):
        found = by_code([
            entry("shuffleState", t=1, when="before-play", observed={"shuffle_state": True}),
            entry("shuffleState", t=2, when="after-play", observed={"shuffle_state": True}),
        ], "shuffle-call-ignored")
        self.assertEqual(len(found), 1)
        # WARN, like the other flag verdicts: only a live-sync verdict is an alarm.
        self.assertEqual(found[0].severity, clientlog.WARN)
        self.assertIn("never took", found[0].message)

    def test_REGRESSION_on_before_but_off_after_is_clean_not_a_failure(self):
        """A real run reported exactly this and the verdict wrongly came back HIGH
        "accepted the call and ignored it". The END STATE is what matters: shuffle
        reading on before play just means the setting had not propagated yet, which is
        what the settle-and-verify step in forceLinearPlayback absorbs. A diagnostic
        that cries wolf on a successful run is worse than no diagnostic."""
        records = [
            entry("shuffleState", t=1, when="before-play", observed={"shuffle_state": True}),
            entry("shuffleState", t=2, when="after-play", observed={"shuffle_state": False}),
        ]
        self.assertEqual(by_code(records, "shuffle-call-ignored"), [])
        self.assertEqual(by_code(records, "shuffle-reenabled-by-play"), [])
        clean = by_code(records, "shuffle-clean")
        self.assertEqual(len(clean), 1)
        self.assertEqual(clean[0].severity, clientlog.INFO)
        self.assertIn("propagating", clean[0].message)

    def test_a_present_but_off_undocumented_field_does_not_warn(self):
        found = by_code([entry("shuffleState", when="after-play",
                               observed={"shuffle_state": False, "smart_shuffle": False})],
                        "shuffle-state")
        self.assertEqual(found[0].severity, clientlog.INFO)

    def test_a_before_play_reading_never_warns_on_its_own(self):
        found = by_code([entry("shuffleState", when="before-play",
                               observed={"shuffle_state": True})], "shuffle-state")
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("before-play", found[0].message)

    def test_live_sync_confirming_order_is_the_direct_evidence(self):
        """shuffle_state is a flag ABOUT the player; whether the queue is in timeline
        order is a different question, and live sync is the only thing that measures it.
        A run was reported where the order warning fired while the playlist played
        correctly, so the flag must not be treated as proof either way."""
        records = [
            entry("shuffleState", t=1, when="before-play", observed={"shuffle_state": False}),
            entry("shuffleState", t=2, when="after-play", observed={"shuffle_state": True}),
            entry("syncDiag", t=3, diagnosis="inOrder"),
        ]
        found = by_code(records, "order-confirmed")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("despite shuffle_state reading as on", found[0].message)
        # And the flag finding is a warning, not an alarm.
        self.assertEqual(by_code(records, "shuffle-reenabled-by-play")[0].severity,
                         clientlog.WARN)

    def test_live_sync_observing_drift_is_HIGH(self):
        found = by_code([entry("syncDiag", diagnosis="orderDrift", action="snap")],
                        "order-actually-wrong")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("really was not following the timeline", found[0].message)

    def test_a_stray_track_is_also_order_actually_wrong(self):
        found = by_code([entry("syncDiag", diagnosis="noMatch")], "order-actually-wrong")
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("noMatch", found[0].message)

    def test_drift_outranks_a_confirmation_from_earlier_in_the_run(self):
        records = [entry("syncDiag", t=1, diagnosis="inOrder"),
                   entry("syncDiag", t=2, diagnosis="orderDrift")]
        self.assertEqual(by_code(records, "order-confirmed"), [])
        self.assertEqual(len(by_code(records, "order-actually-wrong")), 1)

    def test_no_sync_verdict_at_all_draws_no_conclusion(self):
        """A simulated run, or one cancelled before sync ever ran."""
        records = [entry("begin", target="sdk", streamScope=True)]
        self.assertEqual(by_code(records, "order-confirmed"), [])
        self.assertEqual(by_code(records, "order-actually-wrong"), [])

    def test_a_noMatch_past_the_end_is_the_cooldown_not_a_failure(self):
        """A real session logged noMatch 7m51s into a 7m50s workout - the workout had
        finished, endWorkout leaves the music rolling, and Spotify carried on past the
        playlist. Reporting that as HIGH sent me chasing a shuffle bug that was not
        there. Where in the run it happened is what decides."""
        records = [entry("begin", t=1, target="sdk", streamScope=True),
                   entry("syncDiag", t=2, diagnosis="noMatch", at=471, total=470, done=True)]
        self.assertEqual(by_code(records, "order-actually-wrong"), [])
        found = by_code(records, "played-past-the-end")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("cooldown", found[0].message)
        self.assertIn("7m51s into a 7m50s workout", found[0].message)

    def test_a_noMatch_DURING_the_workout_is_still_HIGH(self):
        records = [entry("begin", t=1, target="sdk", streamScope=True),
                   entry("syncDiag", t=2, diagnosis="noMatch", at=30, total=470, done=False)]
        found = by_code(records, "order-actually-wrong")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.HIGH)
        self.assertIn("0m30s into a 7m50s workout", found[0].message)
        self.assertEqual(by_code(records, "played-past-the-end"), [])

    def test_verdicts_are_attributed_to_the_run_they_came_from(self):
        """Two workouts eight minutes apart are one session. Merging them attributed one
        run's noMatch to the other and suppressed the other run's confirmation."""
        records = [
            entry("begin", t=1, target="sdk", streamScope=True),
            entry("syncDiag", t=2, diagnosis="noMatch", at=471, total=470, done=True),
            entry("begin", t=3, target="sdk", streamScope=True),
            entry("syncDiag", t=4, diagnosis="inOrder", at=5, total=470, done=False),
        ]
        past = by_code(records, "played-past-the-end")
        confirmed = by_code(records, "order-confirmed")
        self.assertEqual(len(past), 1)
        self.assertEqual(len(confirmed), 1, "run 2's confirmation must not be swallowed")
        self.assertIn("run 1 of 2", past[0].message)
        self.assertIn("run 2 of 2", confirmed[0].message)

    def test_a_single_run_is_not_labelled(self):
        records = [entry("begin", t=1, target="sdk", streamScope=True),
                   entry("syncDiag", t=2, diagnosis="inOrder", at=5, total=470)]
        self.assertNotIn("run 1 of", by_code(records, "order-confirmed")[0].message)

    def test_split_runs_divides_on_begin(self):
        records = [entry("sdk", t=1, ev="ready"),
                   entry("begin", t=2), entry("syncDiag", t=3, diagnosis="inOrder"),
                   entry("begin", t=4), entry("syncDiag", t=5, diagnosis="inOrder")]
        groups = clientlog.split_runs(records)
        # The leading `ready` is carry-over and keeps its own group rather than vanishing.
        self.assertEqual([len(g) for g in groups], [1, 2, 2])

    def test_split_runs_orders_before_dividing(self):
        records = [entry("syncDiag", t=5, diagnosis="inOrder"), entry("begin", t=4),
                   entry("begin", t=2), entry("syncDiag", t=3, diagnosis="inOrder")]
        self.assertEqual([len(g) for g in clientlog.split_runs(records)], [2, 2])

    def test_a_uri_start_is_reported_as_safe(self):
        found = by_code([entry("playStart", mode="uris", tracks=7)], "started-by-uris")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("cannot reorder", found[0].message)
        self.assertIn("7 tracks", found[0].message)

    def test_a_context_start_is_a_warning_because_it_can_be_reshuffled(self):
        found = by_code([entry("playStart", mode="context", tracks=140)],
                        "started-by-context")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.WARN)
        self.assertIn("reshuffles", found[0].message)

    def test_shuffle_on_after_a_uri_start_is_reported_as_irrelevant(self):
        """Verified on a device: the Spotify app showed shuffle on for a whole 20-minute
        run and playback stayed in order. Warning about the flag there would be noise."""
        records = [
            entry("playStart", t=1, mode="uris", tracks=6),
            entry("shuffleState", t=2, when="before-play", observed={"shuffle_state": True}),
            entry("shuffleState", t=3, when="after-play", observed={"shuffle_state": True}),
        ]
        self.assertEqual(by_code(records, "shuffle-reenabled-by-play"), [])
        self.assertEqual(by_code(records, "shuffle-call-ignored"), [])
        found = by_code(records, "shuffle-irrelevant")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("does not matter", found[0].message)

    def test_a_context_start_still_gets_the_flag_verdict(self):
        records = [
            entry("playStart", t=1, mode="context", tracks=140),
            entry("shuffleState", t=2, when="before-play", observed={"shuffle_state": False}),
            entry("shuffleState", t=3, when="after-play", observed={"shuffle_state": True}),
        ]
        found = by_code(records, "shuffle-reenabled-by-play")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.WARN)

    def test_order_confirmed_and_played_past_the_end_can_both_appear(self):
        """The ideal run: matched in order early, and drifted only at the cooldown.
        Reporting one and swallowing the other loses the positive evidence."""
        records = [
            entry("begin", t=1), entry("playStart", t=2, mode="uris", tracks=6),
            entry("syncDiag", t=3, diagnosis="inOrder", at=4, total=1200, done=False),
            entry("syncDiag", t=4, diagnosis="orderDrift", at=1200, total=1200, done=True),
        ]
        self.assertEqual(len(by_code(records, "order-confirmed")), 1)
        self.assertEqual(len(by_code(records, "played-past-the-end")), 1)
        self.assertEqual(by_code(records, "order-actually-wrong"), [])

    def test_drift_during_the_run_suppresses_both_reassurances(self):
        records = [
            entry("begin", t=1), entry("playStart", t=2, mode="uris", tracks=6),
            entry("syncDiag", t=3, diagnosis="inOrder", at=4, total=1200, done=False),
            entry("syncDiag", t=4, diagnosis="noMatch", at=90, total=1200, done=False),
        ]
        self.assertEqual(len(by_code(records, "order-actually-wrong")), 1)
        self.assertEqual(by_code(records, "order-confirmed"), [])
        self.assertEqual(by_code(records, "played-past-the-end"), [])

    def test_a_retry_is_recorded(self):
        found = by_code([entry("shuffleRetry")], "shuffle-retried")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].severity, clientlog.INFO)

    def test_shuffle_off_throughout_is_clean(self):
        found = by_code([
            entry("shuffleState", t=1, when="before-play", observed={"shuffle_state": False}),
            entry("shuffleState", t=2, when="after-play", observed={"shuffle_state": False}),
        ], "shuffle-clean")
        self.assertEqual(found[0].severity, clientlog.INFO)

    def test_one_reading_alone_draws_no_conclusion(self):
        """An older page version only took the post-play reading. Without both, which
        step lost the setting is unknowable and must not be guessed at."""
        one = [entry("shuffleState", when="after-play", observed={"shuffle_state": True})]
        for code in ("shuffle-reenabled-by-play", "shuffle-call-ignored", "shuffle-clean"):
            self.assertEqual(by_code(one, code), [], code)

    def test_an_unparseable_success_body_is_recorded_as_info(self):
        found = by_code([entry("apiBody", method="PUT", path="/me/player/shuffle",
                               status=200, head="RupOGcfsumG098JKNl0Dx0MFITk")],
                        "unparseable-success-body")
        self.assertEqual(found[0].severity, clientlog.INFO)
        self.assertIn("/me/player/shuffle", found[0].message)
        self.assertIn("RupOGcf", found[0].message)
        self.assertIn("Treated as success", found[0].message)

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


class TestDiscoveryAndSessions(unittest.TestCase):
    """`python scripts/clientlog.py` with no arguments has to pick the right file and
    the right slice of it, or the report describes a workout you are not asking about."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="pulseline-logs-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text="", mtime=None):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def test_logs_come_back_newest_first(self):
        import time
        now = time.time()
        self.write("clientlog-u_old.jsonl", mtime=now - 9000)
        self.write("clientlog-u_new.jsonl", mtime=now - 10)
        self.write("clientlog-u_mid.jsonl", mtime=now - 3000)
        got = [os.path.basename(p) for p in clientlog.find_logs(self.dir)]
        self.assertEqual(got, ["clientlog-u_new.jsonl", "clientlog-u_mid.jsonl",
                              "clientlog-u_old.jsonl"])

    def test_rotated_generations_are_not_offered(self):
        """append_log rotates to `.1` and keeps only one; the live file is what we want."""
        self.write("clientlog-u_a.jsonl")
        self.write("clientlog-u_a.jsonl.1")
        got = [os.path.basename(p) for p in clientlog.find_logs(self.dir)]
        self.assertEqual(got, ["clientlog-u_a.jsonl"])

    def test_no_logs_is_an_empty_list_not_an_error(self):
        self.assertEqual(clientlog.find_logs(self.dir), [])

    def test_entries_far_apart_are_separate_sessions(self):
        gap = clientlog.SESSION_GAP_MS
        records = [entry("begin", t=1000), entry("sdk", t=2000),
                   entry("begin", t=2000 + gap + 1), entry("sdk", t=2000 + gap + 2000)]
        sessions = clientlog.split_sessions(records)
        self.assertEqual([len(s) for s in sessions], [2, 2])

    def test_one_continuous_workout_is_one_session(self):
        records = [entry("begin", t=1000 + i * 5000) for i in range(12)]
        self.assertEqual(len(clientlog.split_sessions(records)), 1)

    def test_entries_are_ordered_before_splitting(self):
        """clog() queues entries in memory until the namespace is known, so a log is not
        guaranteed to be in time order."""
        gap = clientlog.SESSION_GAP_MS
        records = [entry("sdk", t=2000 + gap + 2000), entry("begin", t=1000),
                   entry("begin", t=2000 + gap + 1), entry("sdk", t=2000)]
        sessions = clientlog.split_sessions(records)
        self.assertEqual([len(s) for s in sessions], [2, 2])
        self.assertEqual([_w(r) for r in sessions[0]], [1000, 2000])

    def test_the_default_scope_ignores_an_earlier_bad_session(self):
        """The whole point: a log accumulates every workout ever run on that account, so
        a bare invocation must not report last week's failure as though it were today's."""
        gap = clientlog.SESSION_GAP_MS
        bad = [entry("begin", t=1000, target="sdk", streamScope=False)]
        good = [entry("begin", t=1000 + gap + 1, target="sdk", streamScope=True),
                entry("sdk", t=1000 + gap + 500, ev="ready")]
        path = self.write("clientlog-u_x.jsonl", jsonl(*(bad + good)))

        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            last = clientlog.report(path, as_json=True, scope="last")
            every = clientlog.report(path, as_json=True, scope="all")
        self.assertEqual(last, 0, "the latest session is clean")
        self.assertEqual(every, 1, "--all still finds the earlier failure")


def _w(rec):
    return clientlog._when(rec)


if __name__ == "__main__":
    unittest.main(verbosity=2)
