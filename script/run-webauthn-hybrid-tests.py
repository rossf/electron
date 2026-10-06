#!/usr/bin/env python3
"""Run isolated synthetic hybrid checks; never open an account."""

import argparse
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "spec/fixtures/api/webauthn-hybrid"


def no_core():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def invoke(command, environment, timeout, expected_output=None):
    with subprocess.Popen(command, env=environment,
                          stdout=subprocess.PIPE if expected_output else subprocess.DEVNULL,
                          stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            output, errors = child.communicate(timeout=timeout)
            if child.returncode:
                # Only synthetic fixtures run here. Keep diagnostics on the
                # local terminal, not in committed result files or artifacts.
                print(errors.decode(errors="replace")[-4000:], file=sys.stderr)
            if expected_output and expected_output not in (output or b""):
                raise RuntimeError("Synthetic child did not verify native shutdown teardown")
            return child.returncode
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
            raise RuntimeError("Synthetic child exceeded its time limit") from None


def main():
    no_core()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["all", "state", "native", "creation"], default="all")
    parser.add_argument("--out-dir", type=Path, help="Explicit Electron build output directory")
    parser.add_argument("--native-binary", type=Path, help="Optional separate mock executable")
    parser.add_argument("--cxx", default="c++", help="Compiler for the dependency-free state test")
    args = parser.parse_args()
    if args.suite != "state" and args.out_dir is None:
        parser.error("--out-dir is required for compiled native checks")
    output = args.out_dir.resolve() if args.out_dir else None
    environment = dict(os.environ)
    for key in ("NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"):
        environment.pop(key, None)
    results = []
    with tempfile.TemporaryDirectory(prefix="electron-hybrid-tests-") as temporary:
        directory = Path(temporary)

        def run_case(name, command, extra=None, timeout=30, expected_output=None):
            profile = directory / name
            profile.mkdir()
            env = {**environment, "XDG_CONFIG_HOME": str(profile / "config"),
                   "XDG_CACHE_HOME": str(profile / "cache"), **(extra or {})}
            status = invoke([str(value) for value in command], env, timeout, expected_output)
            results.append({"name": name, "exitCode": status, "ok": status == 0})
            if status != 0:
                raise RuntimeError(f"{name} exited with status {status}")
            return profile

        if args.suite in ("all", "state"):
            binary = directory / "state-test"
            subprocess.run([args.cxx, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "-I", str(ROOT), str(ROOT / "shell/browser/webauthn/hybrid_request_state_test.cc"),
                            "-o", str(binary)], check=True)
            run_case("state", [binary])

        if args.suite in ("all", "native", "creation"):
            binary = (args.native_binary or output / "electron_hybrid_browser_owned_tests").resolve()
            if binary.name not in ("electron_hybrid_browser_owned_tests", "electron_hybrid_browser_owned_storage_tests"):
                parser.error("Native tests require the explicitly named mock executable")
        if args.suite in ("all", "native"):
            for enabled in (True, False):
                name = "native-enabled" if enabled else "native-disabled"
                result_file = directory / (name + ".json")
                run_id = str(uuid.uuid4())
                run_case(name, [binary, FIXTURES / "native.cjs"], {
                    "PASSKEY_BROWSER_TEST_ENABLED": "1" if enabled else "0",
                    "PASSKEY_BROWSER_TEST_RUN_ID": run_id,
                    "HYBRID_TEST_PROFILE": str(directory / name),
                    "HYBRID_TEST_RESULT": str(result_file),
                    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent-passkey-probe",
                    "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/nonexistent-passkey-probe",
                }, timeout=180)
                result = json.loads(result_file.read_text())
                if (result.get("runId") != run_id or result.get("completed") is not True
                        or result.get("ok") is not True or not result.get("tests")
                        or not all(test.get("ok") is True for test in result["tests"])):
                    raise RuntimeError(f"{name} did not pass every case in this invocation")
                results[-1]["cases"] = len(result["tests"])

        if args.suite in ("all", "creation"):
            for mode in ("enabled", "creation-disabled", "backend-disabled", "disabled", "shutdown"):
                name = "creation-" + mode
                result_file = directory / (name + ".json")
                run_id = str(uuid.uuid4())
                run_case(name, [binary, FIXTURES / "creation.cjs"], {
                    "PASSKEY_CREATION_TEST_MODE": mode,
                    "PASSKEY_BROWSER_TEST_RUN_ID": run_id,
                    "HYBRID_TEST_PROFILE": str(directory / name),
                    "HYBRID_TEST_RESULT": str(result_file),
                    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent-passkey-probe",
                    "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/nonexistent-passkey-probe",
                }, timeout=180, expected_output=(
                    b"electron-hybrid-test: shutdown teardown verified"
                    if mode == "shutdown" else None))
                result = json.loads(result_file.read_text())
                if (result.get("runId") != run_id or result.get("completed") is not True
                        or result.get("ok") is not True or not result.get("tests")
                        or not all(test.get("ok") is True for test in result["tests"])):
                    raise RuntimeError(f"{name} did not pass every case in this invocation")
                if mode == "shutdown" and result.get("shutdownRequested") is not True:
                    raise RuntimeError("Creation fixture did not request app quit")
                results[-1]["cases"] = len(result["tests"])

    print(json.dumps({"ok": True, "syntheticOnly": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
