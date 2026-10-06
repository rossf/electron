# Reproduce the experimental hybrid tests

These Linux checks use disposable directories, synthetic credentials and local
fixtures. They never open a real relying party or use a production authenticator.
They do not validate real BLE, caBLE tunnels or an authenticated website session.
Keep DCHECKs enabled for native lifetime checks.

## Source and build inputs

Use this branch in a normal Electron dependency checkout. `DEPS` pins Chromium;
The independent in-memory storage task-trait fix and its reproducer are tracked
on `rossf/electron` branch `fix/in-memory-storage-shutdown`; they are not part of
this authentication diff. The previously validated fixed binary combined both
changes. If testing that combination, import the companion patch once through
Electron's dependency patch list and record both source heads.
See [Electron's build instructions](build-instructions-linux.md) for toolchain
and dependency setup. No binary or build output is stored in this repository.

From the Chromium `src` directory, with a testing output directory configured:

```sh
ninja -C out/Testing electron electron:electron_hybrid_browser_owned_tests
python3 electron/script/run-webauthn-hybrid-tests.py --out-dir out/Testing
```

The runner compiles the dependency-free state test with a local C++17 compiler,
then executes enabled and disabled native suites. A usable Linux
display is required for Electron; an existing Xvfb session is also suitable.
The mock binding is linked only into the separately named test executable.
The ordinary `electron` target contains no browser-owned mock binding.

For the small state test alone, from the Electron repository root:

```sh
python3 script/run-webauthn-hybrid-tests.py --suite state
```

`--suite native` selects the native checks. `--native-binary` accepts an explicit
executable path when validating an existing build. The legacy cached mock name
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

The separate application integration and its historical full-app tests are not
part of this Electron repository. The source snapshot of the old debug testing
helpers is likewise not required by this standalone native suite.

## Fork CI status

`fork-hybrid-state.yml` is a five-minute, read-only `ubuntu-24.04` PR job. It
checks the exact base/head diff and builds/runs only the standalone state test.
It uses a pinned checkout action without persisted credentials, and has no
secrets, cache, artifacts, publishing or dispatch steps. It does not test native
WebAuthn, BLE, V8 lifetime or storage shutdown.

The CI-only guard PR was approved and merged through the fork's protected
`main`. Every active PR base and head now guards inherited jobs. The Electron 43
comparison uses `baseline/electron-v43.7.0-fork-ci`; the original pinned baseline
remains unchanged. Repository Actions settings require SHA pinning and allow
only the exact checkout revision. All 52 registered inherited workflows are
manually disabled; this is the only active workflow. Default token permissions
are read-only and Actions cannot approve PR reviews. These settings do not
establish a native test result; check the PR's run for the tested head.
