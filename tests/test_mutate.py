#!/usr/bin/env python3
"""Tests for scripts/mutate.py, the tool that proves a test can fail.

Run:  python tests/test_mutate.py

Worth testing for one reason above the others: if the restore breaks, it leaves the
working tree dirty with a deliberate break in it, and the next commit ships the mutation.
The hand-rolled version of this did exactly that twice.

The other thing pinned here is the exit inversion. mutate.py reports failure when the
suite stays GREEN, because a mutation nothing catches means no test can tell the
difference. Getting that backwards would make the tool always agree with you.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import mutate  # noqa: E402


class TestApplyMutation(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pulseline-mutate-")
        self.path = os.path.join(self.dir, "subject.txt")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, text):
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def read(self):
        with open(self.path, encoding="utf-8") as f:
            return f.read()

    def test_a_unique_pattern_is_replaced(self):
        self.write("alpha beta gamma")
        mutate.apply_mutation(self.path, "beta", "BETA")
        self.assertEqual(self.read(), "alpha BETA gamma")

    def test_a_pattern_that_is_absent_aborts(self):
        """Silently matching nothing is the worst outcome: the suite stays green and the
        mutation looks uncaught, so you go and 'fix' a test that was fine."""
        self.write("alpha beta")
        with self.assertRaises(SystemExit) as cm:
            mutate.apply_mutation(self.path, "zeta", "ZETA")
        self.assertIn("0 times", str(cm.exception))
        self.assertEqual(self.read(), "alpha beta", "the file must be untouched")

    def test_a_pattern_that_is_not_unique_aborts(self):
        self.write("beta and beta")
        with self.assertRaises(SystemExit) as cm:
            mutate.apply_mutation(self.path, "beta", "BETA")
        self.assertIn("2 times", str(cm.exception))
        self.assertEqual(self.read(), "beta and beta")

    def test_a_deletion_is_allowed(self):
        self.write("keep\ndrop me\nkeep")
        mutate.apply_mutation(self.path, "drop me\n", "")
        self.assertEqual(self.read(), "keep\nkeep")


class TestRestore(unittest.TestCase):
    """The guarantee that matters: the file goes back, whatever happened."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pulseline-mutate-")
        self.path = os.path.join(self.dir, "subject.txt")
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write("original\ncontent\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read_bytes(self):
        with open(self.path, "rb") as f:
            return f.read()

    def test_the_file_is_restored_byte_for_byte(self):
        before = self.read_bytes()
        with mutate.Restore(self.path):
            with open(self.path, "w", encoding="utf-8", newline="") as f:
                f.write("mutated")
        self.assertEqual(self.read_bytes(), before)

    def test_the_file_is_restored_when_the_body_raises(self):
        """A failed mutation, a crashing runner, Ctrl-C: all the same path."""
        before = self.read_bytes()
        with self.assertRaises(ValueError):
            with mutate.Restore(self.path):
                with open(self.path, "w", encoding="utf-8", newline="") as f:
                    f.write("mutated")
                raise ValueError("boom")
        self.assertEqual(self.read_bytes(), before)

    def test_a_restore_that_silently_fails_is_reported_loudly(self):
        """The verification, not the copy. If the copy back fails - a locked file, a full
        disk - the tool must refuse to exit quietly, because the alternative is a working
        tree left holding a deliberate break that the next commit ships."""
        from unittest.mock import patch
        r = mutate.Restore(self.path)
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write("mutated")
        with patch.object(mutate.shutil, "copy2", lambda *a, **k: None):
            with self.assertRaises(SystemExit):
                r.__exit__(None, None, None)

    def test_the_snapshot_file_is_cleaned_up(self):
        with mutate.Restore(self.path) as r:
            snap = r.snap
            self.assertTrue(os.path.exists(snap))
        self.assertFalse(os.path.exists(snap))


class TestOutputParsing(unittest.TestCase):
    def test_each_runner_s_failure_format_is_recognised(self):
        output = "\n".join([
            "FAIL: test_a (mod.TestB.test_a)",
            "ERROR: test_b (mod.TestB.test_b)",
            "not ok 7 - a node test name",
            mutate.FAIL_PREFIXES[3] + "a default-reporter test name",
            "ok 8 - a passing test",
            "some unrelated chatter",
        ])
        got = mutate.failing_lines(output)
        self.assertEqual(got, ["test_a (mod.TestB.test_a)",
                              "test_b (mod.TestB.test_b)",
                              "7 - a node test name",
                              "a default-reporter test name"])

    def test_node_s_failing_tests_header_is_not_a_test(self):
        header = mutate.FAIL_PREFIXES[3] + "failing tests:"
        self.assertEqual(mutate.failing_lines(header), [])

    def test_duplicates_are_collapsed(self):
        """node prints each failure twice: once inline and once in the summary."""
        line = "not ok 3 - the same test"
        self.assertEqual(len(mutate.failing_lines(line + "\n" + line)), 1)

    def test_output_is_normalised_to_ascii_before_printing(self):
        """Printing node's U+2716 to a cp1252 console raises UnicodeEncodeError, which is
        how this trap bit the tool built to catch mistakes."""
        got = mutate.ascii_only("caught " + chr(0x2716) + " here")
        self.assertEqual(got.encode("ascii"), got.encode("ascii"))
        self.assertNotIn(chr(0x2716), got)


class TestExitInversion(unittest.TestCase):
    """Green is the failure. A tool that got this backwards would always agree with you."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pulseline-mutate-")
        self.path = os.path.join(self.dir, "subject.txt")
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write("value = 1\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def checker(self, expect):
        """A command standing in for a suite: green only while the file says `expect`."""
        code = ("import sys;"
                "sys.exit(0 if open(%r,encoding='utf-8').read().strip()==%r else 1)"
                % (self.path, expect))
        return [sys.executable, "-c", code]

    def test_a_mutation_the_suite_notices_is_caught(self):
        caught = mutate.one(self.path, "value = 1", "value = 2",
                            self.checker("value = 1"))
        self.assertTrue(caught)

    def test_a_mutation_the_suite_ignores_is_NOT_caught(self):
        # The checker only looks at the whole line, so a comment change is invisible.
        caught = mutate.one(self.path, "value = 1", "value = 1",
                            self.checker("value = 1"))
        self.assertFalse(caught)

    def test_the_file_survives_either_way(self):
        before = open(self.path, "rb").read()
        mutate.one(self.path, "value = 1", "value = 2", self.checker("value = 1"))
        mutate.one(self.path, "value = 1", "value = 1", self.checker("value = 1"))
        self.assertEqual(open(self.path, "rb").read(), before)


class TestCli(unittest.TestCase):
    def run_cli(self, *args):
        r = subprocess.run([sys.executable, os.path.join("scripts", "mutate.py")]
                           + list(args), cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")

    def test_no_arguments_is_refused_rather_than_doing_something(self):
        code, out = self.run_cli()
        self.assertNotEqual(code, 0)
        self.assertIn("--spec", out)

    def test_help_states_the_inversion(self):
        code, out = self.run_cli("--help")
        self.assertEqual(code, 0)
        self.assertIn("green is the failure", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
