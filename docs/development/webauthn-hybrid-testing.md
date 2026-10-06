# Reproduce the experimental hybrid tests

These Linux checks use disposable directories, synthetic credentials and local
fixtures. They never open a real relying party or use a production authenticator.
They do not validate real BLE, caBLE tunnels or an authenticated website session.
Keep DCHECKs enabled; otherwise the storage contract test is not meaningful.

## Source and build inputs

Use this branch in a normal Electron dependency checkout. `DEPS` pins Chromium;
Electron's patch import applies `patches/chromium/.patches`, including the
in-memory DOM-storage task-trait fix. Do not apply that patch a second time.
The Chromium source fix and the test-only Electron targets are separate changes.
See [Electron's build instructions](build-instructions-linux.md) for toolchain
and dependency setup. No binary or build output is stored in this repository.

From the Chromium `src` directory, with a testing output directory configured:

```sh
ninja -C out/Testing electron electron:electron_hybrid_browser_owned_tests electron:storage_blocking_contract_test
python3 electron/script/run-webauthn-hybrid-tests.py --out-dir out/Testing
```

The runner compiles the dependency-free state test with a local C++17 compiler,
runs the storage contract probe, executes enabled and disabled native suites,
then runs ten in-memory and three disk-backed storage shutdowns. A usable Linux
display is required for Electron; an existing Xvfb session is also suitable.
The mock binding is linked only into the separately named test executable.
The ordinary `electron` target contains no browser-owned mock binding.

For the small state test alone, from the Electron repository root:

```sh
python3 script/run-webauthn-hybrid-tests.py --suite state
```

`--suite native`, `--suite contract` and `--suite storage` select individual
checks. `--native-binary` and `--electron-binary` accept explicit executable
paths when validating an existing build. The legacy cached mock name
`electron_hybrid_browser_owned_storage_tests` is also accepted. A passing run
identifies the tested executable, not a newly compiled checkout.

## Coverage and limits

The native suite covers synchronous/duplicate/stale cancellation, BLE
unavailability and recovery, handler errors and replacement, navigation/window
and iframe teardown, separate Session ownership, Permissions Policy, RP rejection,
page abort, concurrent requests, repeated synthetic assertions, and USB fallback.
An installed hybrid handler must not be called by `navigator.credentials.create()`;
a successful synthetic USB registration supplies the assertion credential. It checks signed
challenge/origin/RP/UP/UV data using a fresh virtual credential. It never saves a
QR payload, credential or private key. Result files exist only in the temporary
directory and are deleted at completion; stdout contains case counts and exit
status. Timeouts terminate only the runner's newly created child process group.

The storage contract probe checks blocking permission on the actual production
task runner. The storage browser fixture uses only generated local/session
storage values, blocks DNS, and verifies orderly process exit after writes.
Finite shutdown runs cannot prove all possible races. A live login is neither
required nor performed by these tests.

The separate application integration and its historical full-app tests are not
part of this Electron repository. The source snapshot of the old debug testing
helpers is likewise not required by this standalone native suite.

## Fork CI status

`fork-hybrid-state.yml` is a five-minute, read-only `ubuntu-24.04` PR job. It
checks the exact base/head diff and builds/runs only the standalone state test.
It uses a pinned checkout action without persisted credentials, and has no
secrets, cache, artifacts, publishing or dispatch steps. It does not test native
WebAuthn, BLE, V8 lifetime or storage shutdown.

Actions is currently disabled for the fork. GitHub returned no registered
workflows, and disabling an inherited workflow by filename returned 404. The
small job is staged on this PR head, but it has not run. Enablement requires a
separate verified plan that keeps every inherited workflow disabled before any
triggering event; no protection bypass or merge is part of this checkpoint.
