#!/usr/bin/env python3
"""Test supervisor failure and retention behavior without launching Electron."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "hybrid_runner", Path(__file__).with_name("run-webauthn-hybrid-tests.py"))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RunnerTests(unittest.TestCase):
    """Exercise the real supervisor with mocked children and fresh test files."""

    def setUp(self):
        # unittest owns this directory, including profiles the runner retains.
        # pylint: disable-next=consider-using-with
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.directory = Path(temporary) / "invocation"
        self.directory.mkdir()

    def run_main(self, suite, invoke):
        """Run the CLI without a compiler, browser or process signals."""
        with contextlib.ExitStack() as stack:
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            stack.enter_context(mock.patch.object(RUNNER, "no_core"))
            stack.enter_context(mock.patch.object(RUNNER, "invoke", side_effect=invoke))
            stack.enter_context(mock.patch.object(RUNNER.subprocess, "run"))
            stack.enter_context(mock.patch.object(RUNNER.tempfile, "mkdtemp",
                                                  return_value=str(self.directory)))
            stack.enter_context(mock.patch.object(
                RUNNER.sys, "argv", ["runner", "--suite", suite, "--out-dir", str(self.directory)]))
            RUNNER.main()
            return json.loads(output.getvalue())

    @staticmethod
    def successful_native(_command, environment, _timeout, _expected_output=None):
        """Supply a complete invocation-bound fixture result."""
        result = {"runId": environment["PASSKEY_BROWSER_TEST_RUN_ID"],
                  "completed": True, "ok": True, "tests": [{"ok": True}]}
        Path(environment["HYBRID_TEST_RESULT"]).write_text(json.dumps(result), encoding="utf-8")
        return 0

    def test_timeout_does_not_wait_or_signal(self):
        child = mock.Mock()
        child.communicate.side_effect = subprocess.TimeoutExpired(["synthetic"], 1)
        with (mock.patch.object(RUNNER.subprocess, "Popen", return_value=child),
              mock.patch.object(RUNNER.os, "kill", side_effect=AssertionError("signal forbidden")),
              mock.patch.object(RUNNER.os, "killpg", side_effect=AssertionError("group signal forbidden"))):
            with self.assertRaisesRegex(RuntimeError, "no signals sent"):
                RUNNER.invoke(["synthetic"], {}, 1)
        child.kill.assert_not_called()
        child.terminate.assert_not_called()
        child.wait.assert_not_called()

    def test_successful_native_run_retains_profiles(self):
        result = self.run_main("native", self.successful_native)
        self.assertTrue(result["profilesRetained"])
        self.assertEqual(result["supervisorSignalsSent"], 0)
        self.assertTrue((self.directory / "native-enabled").is_dir())
        self.assertTrue((self.directory / "native-no-handler").is_dir())

    def test_failed_native_run_retains_profiles(self):
        with self.assertRaisesRegex(RuntimeError, "exited with status"):
            self.run_main("native", lambda *_args: 1)
        self.assertTrue((self.directory / "native-enabled").is_dir())

    def test_invalid_result_retains_profiles(self):
        def stale_result(command, environment, timeout, expected_output=None):
            self.successful_native(command, environment, timeout, expected_output)
            result_file = Path(environment["HYBRID_TEST_RESULT"])
            result = json.loads(result_file.read_text(encoding="utf-8"))
            result["runId"] = "different-invocation"
            result_file.write_text(json.dumps(result), encoding="utf-8")
            return 0

        with self.assertRaisesRegex(RuntimeError, "this invocation"):
            self.run_main("native", stale_result)
        self.assertTrue(self.directory.is_dir())

    def test_successful_state_only_run_cleans_up(self):
        result = self.run_main("state", lambda *_args: 0)
        self.assertFalse(result["profilesRetained"])
        self.assertFalse(self.directory.exists())


if __name__ == "__main__":
    unittest.main()
