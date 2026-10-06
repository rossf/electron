#!/usr/bin/env python3
"""Run isolated synthetic DOM-storage shutdown checks; never open an account."""

import argparse
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "spec/fixtures/api/storage-shutdown"


def no_core():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def invoke(command, environment, timeout):
    with subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL,
                          stderr=subprocess.PIPE, start_new_session=True,
                          preexec_fn=no_core) as child:
        try:
            _, errors = child.communicate(timeout=timeout)
            if child.returncode:
                # Only synthetic fixtures run here. Keep diagnostics on the
                # local terminal, not in committed result files or artifacts.
                print(errors.decode(errors="replace")[-4000:], file=sys.stderr)
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["all", "contract", "storage"], default="all")
    parser.add_argument("--out-dir", type=Path, help="Explicit Electron build output directory")
    parser.add_argument("--electron-binary", type=Path, help="Optional ordinary fixed Electron executable")
    args = parser.parse_args()
    if args.out_dir is None:
        parser.error("--out-dir is required for compiled native/storage checks")
    output = args.out_dir.resolve() if args.out_dir else None
    environment = dict(os.environ)
    for key in ("NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"):
        environment.pop(key, None)
    results = []
    with tempfile.TemporaryDirectory(prefix="electron-storage-tests-") as temporary:
        directory = Path(temporary)

        def run_case(name, command, extra=None, timeout=30):
            profile = directory / name
            profile.mkdir()
            env = {**environment, "XDG_CONFIG_HOME": str(profile / "config"),
                   "XDG_CACHE_HOME": str(profile / "cache"), **(extra or {})}
            status = invoke([str(value) for value in command], env, timeout)
            results.append({"name": name, "exitCode": status, "ok": status == 0})
            if status != 0:
                raise RuntimeError(f"{name} exited with status {status}")
            return profile

        if args.suite in ("all", "contract"):
            run_case("contract", [output / "storage_blocking_contract_test"])

        if args.suite in ("all", "storage"):
            binary = (args.electron_binary or output / "electron").resolve()
            for persistent in (False, True):
                for iteration in range(3 if persistent else 10):
                    name = f"storage-{'disk' if persistent else 'memory'}-{iteration}"
                    profile = run_case(name, [binary, FIXTURES / "main.cjs"], {
                        "SHUTDOWN_REPRO_PROFILE": str(directory / name),
                        "SHUTDOWN_REPRO_PERSIST": "1" if persistent else "0",
                        "SHUTDOWN_REPRO_DELAY": str((iteration % 3) * 5),
                    })
                    state = json.loads((profile / "synthetic-state.json").read_text())
                    if state != {"storageWritten": True, "authenticationApisCalled": False, "quitRequested": True}:
                        raise RuntimeError("Storage fixture did not complete its synthetic writes")

    print(json.dumps({"ok": True, "syntheticOnly": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
