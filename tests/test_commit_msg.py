#!/usr/bin/env python3
"""Tests for scripts/commit_msg.py, the commit-msg guardrail for the fragile playback path.

Run:  python tests/test_commit_msg.py

Two things have to hold or the hook is worse than nothing. It must fire when the path
really changed - and only then, because a hook that nags on unrelated commits gets
bypassed with --no-verify and stops protecting anything. And it must accept an honest
"no": the point is that an unverified step is written down, not that it is impossible to
commit without a phone.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import commit_msg  # noqa: E402

PAGE_V1 = """<script>
function toast(m,ms=3200){show(m)}
async function api(path,opts={},_depth=0){return fetch(path,opts)}
function handoffBody(p,playlistKey){
  const ctx=p.ctx||playlistKey;
  return ctx?{context_uri:ctx}:{uris:[p.uri]};
}
async function doHandoff(deviceId,name){
  const body=handoffBody(p,W&&W.key);
  await api("/me/player/play",{method:"PUT",body});
}
function setPaused(pause){ if(!W)return; P.playing=!pause; }
</script>"""

FULL = """Fix the handoff

Re-verified:
  start: yes - real SDK in Chrome
  pause: yes - button, in Chrome
  external pause: no - no second client to hand
  finish: yes - completion card shown
  completion card: yes - music still playing behind it
  handoff: no - not exercised; needs the phone
"""


class TestExtraction(unittest.TestCase):
    def test_a_function_is_lifted_whole(self):
        fn = commit_msg.extract_function(PAGE_V1, "handoffBody")
        self.assertTrue(fn.startswith("function handoffBody("))
        self.assertTrue(fn.rstrip().endswith("}"))
        self.assertIn("uris:[p.uri]", fn)
        self.assertNotIn("doHandoff", fn)

    def test_a_default_parameter_brace_is_not_mistaken_for_the_body(self):
        # The bug tests/_page.js had: `opts={}` came back as the whole "function".
        fn = commit_msg.extract_function(PAGE_V1, "api")
        self.assertIn("return fetch(path,opts)", fn)

    def test_a_missing_function_is_None(self):
        self.assertIsNone(commit_msg.extract_function(PAGE_V1, "beginPlayback"))


class TestTouched(unittest.TestCase):
    def test_an_identical_page_touches_nothing(self):
        self.assertEqual(commit_msg.touched(PAGE_V1, PAGE_V1), [])

    def test_a_change_inside_a_fragile_function_is_named(self):
        new = PAGE_V1.replace("p.ctx||playlistKey", "playlistKey||p.ctx")
        self.assertEqual(commit_msg.touched(PAGE_V1, new), ["handoffBody"])

    def test_a_change_elsewhere_in_the_page_touches_nothing(self):
        # toast() and api() are not on the list; CSS and markup are not functions at all.
        new = PAGE_V1.replace("show(m)", "show(m,ms)").replace("<script>", "<style>a{}</style><script>")
        self.assertEqual(commit_msg.touched(PAGE_V1, new), [])

    def test_a_fragile_function_that_moved_but_did_not_change_is_not_touched(self):
        moved = PAGE_V1.replace("<script>", "<script>\nconst X=1;\n\n")
        self.assertEqual(commit_msg.touched(PAGE_V1, moved), [])

    def test_adding_or_removing_a_fragile_function_counts(self):
        added = PAGE_V1.replace("</script>", "function onSdkState(st){return st}\n</script>")
        self.assertEqual(commit_msg.touched(PAGE_V1, added), ["onSdkState"])
        self.assertEqual(commit_msg.touched(added, PAGE_V1), ["onSdkState"])

    def test_every_listed_function_exists_in_the_real_page(self):
        # A name that is renamed in the page would silently stop being guarded.
        with open(os.path.join(ROOT, "workout.html"), encoding="utf-8") as f:
            src = f.read()
        for name in commit_msg.FRAGILE:
            with self.subTest(name=name):
                self.assertIsNotNone(commit_msg.extract_function(src, name),
                                     "%s is no longer defined in workout.html" % name)


class TestAccounting(unittest.TestCase):
    def test_a_full_block_accounts_for_every_step(self):
        self.assertEqual(set(commit_msg.accounted(FULL)), set(commit_msg.STEPS))

    def test_no_is_recorded_as_no(self):
        done = commit_msg.accounted(FULL)
        self.assertEqual(done["handoff"], "no")
        self.assertEqual(done["start"], "yes")

    def test_external_pause_does_not_stand_in_for_pause(self):
        only_external = "x\n\n  external pause: yes - second client\n"
        self.assertEqual(list(commit_msg.accounted(only_external)), ["external pause"])

    def test_a_bare_yes_or_no_is_not_evidence(self):
        self.assertEqual(commit_msg.accounted("x\n\nhandoff: yes\nstart: no\npause: yes -\n"), {})

    def test_bullets_and_capitals_are_accepted(self):
        done = commit_msg.accounted("x\n\n- Start: Yes, in Chrome\n* HANDOFF: no (needs the phone)\n")
        self.assertEqual(done, {"start": "yes", "handoff": "no"})

    def test_a_step_named_in_prose_does_not_count(self):
        prose = "Fixed the handoff: yes it works now, and start is fine.\n"
        self.assertEqual(commit_msg.accounted(prose), {})


class TestProblems(unittest.TestCase):
    NEW = PAGE_V1.replace("p.ctx||playlistKey", "playlistKey||p.ctx")

    def test_a_fragile_change_with_no_account_is_refused_and_lists_every_step(self):
        names, missing = commit_msg.problems("Fix the handoff\n", PAGE_V1, self.NEW)
        self.assertEqual(names, ["handoffBody"])
        self.assertEqual(missing, list(commit_msg.STEPS))

    def test_a_fragile_change_with_a_full_account_passes(self):
        self.assertEqual(commit_msg.problems(FULL, PAGE_V1, self.NEW), (["handoffBody"], []))

    def test_one_missing_step_is_named(self):
        partial = FULL.replace("  handoff: no - not exercised; needs the phone\n", "")
        names, missing = commit_msg.problems(partial, PAGE_V1, self.NEW)
        self.assertEqual(missing, ["handoff"])

    def test_a_commit_that_leaves_the_path_alone_needs_nothing(self):
        # The healthy case: the hook must stay silent on every unrelated commit.
        self.assertEqual(commit_msg.problems("Tidy the docs\n", PAGE_V1, PAGE_V1), ([], []))

    def test_merges_and_reverts_are_exempt(self):
        for first in ("Merge branch 'x'", "Revert \"Fix the handoff\"", "fixup! Fix the handoff"):
            with self.subTest(first=first):
                self.assertEqual(commit_msg.problems(first + "\n", PAGE_V1, self.NEW), ([], []))

    def test_an_account_inside_gits_own_comment_lines_does_not_count(self):
        commented = "Fix the handoff\n\n" + "\n".join("# " + l for l in FULL.splitlines())
        _, missing = commit_msg.problems(commented, PAGE_V1, self.NEW)
        self.assertEqual(missing, list(commit_msg.STEPS))

    def test_the_diff_shown_by_commit_v_is_not_read_as_the_message(self):
        verbose = ("Fix the handoff\n\n# ------------------------ >8 ------------------------\n"
                   + FULL)
        _, missing = commit_msg.problems(verbose, PAGE_V1, self.NEW)
        self.assertEqual(missing, list(commit_msg.STEPS))

    def test_a_new_page_with_no_previous_version_is_a_change(self):
        names, _ = commit_msg.problems("Add the page\n", "", PAGE_V1)
        self.assertIn("doHandoff", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
