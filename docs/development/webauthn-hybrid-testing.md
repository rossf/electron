# Reproduce the experimental hybrid tests

These Linux checks use disposable directories, synthetic credentials and local
fixtures. They never open a real relying party or use a production authenticator.
They do not validate real BLE, caBLE tunnels or an authenticated website session.
Keep DCHECKs enabled for native lifetime checks.

## Source and build inputs

Use this branch in a normal Electron dependency checkout. `DEPS` pins Chromium.
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
then executes enabled and disabled authentication suites and the creation modes
described below. A usable Linux
display is required for Electron; an existing Xvfb session is also suitable.
The mock binding is linked only into the separately named test executable.
The ordinary `electron` target contains no browser-owned mock binding.

For the small state test alone, from the Electron repository root:

```sh
python3 script/run-webauthn-hybrid-tests.py --suite state
```

`--suite native` selects authentication-only native checks.
`--suite creation` selects the creation follow-up. `--native-binary` accepts an explicit
executable path when validating an existing build. The legacy cached mock name
`electron_hybrid_browser_owned_storage_tests` is also accepted. A passing run
identifies the tested executable, not a newly compiled checkout.

## Coverage and limits

The native suite covers synchronous/duplicate/stale cancellation, BLE
unavailability and recovery, handler errors and replacement, navigation/window
and iframe teardown, separate Session ownership, Permissions Policy, RP rejection,
page abort, concurrent requests, repeated synthetic assertions, and USB fallback.
With the creation switch absent, an installed hybrid handler must not be called
by `navigator.credentials.create()`;
a successful synthetic USB registration supplies the assertion credential. It checks signed
challenge/origin/RP/UP/UV data using a fresh virtual credential. It never saves a
QR payload, credential or private key. Result files exist only in the temporary
directory and are deleted at completion; stdout contains case counts and exit
status. Timeouts terminate only the runner's newly created child process group.

The separate application integration and its historical full-app tests are not
part of this Electron repository. The source snapshot of the old debug testing
helpers is likewise not required by this standalone native suite.

## Fork CI status

The reviewed source-check workflow uses standard Ubuntu runners and read-only
permissions. It checks changed C++, GN, Python, JavaScript and documentation,
generates API types and runs actual TypeScript smoke/snippet checks, and runs
the standalone state test. Storage heads also receive a targeted pinned-source
patch applicability check. These are source checks; native runtime results are
recorded separately below. See [fork CI controls](fork-ci-activation.md) for
exact branch coverage, time limits and candidate-matrix limitations.

All 52 inherited registered workflows remain disabled and guarded. The action
allowlist still contains only the pinned checkout action, without persisted
credentials. No repository secret, artifact upload or publication is used.
The original Electron 43 baseline remains pinned; PR #1 uses the guarded base.
Check each run's exact source SHA before applying its result to a newer head.

## Recorded current-main validation

On 2026-10-06, a separate Linux testing build completed for Electron base
`6b48d9813bd791453c7b57812a5395c693ba3e14` and Chromium 156.0.8078.3
(`03a4bd2b9182691ca7d80e876878f678029aef83`). It combined authentication source
`cc41beacdce46acee8a2e5245d037fe3f7be6904` with the independent storage source
`22e87638d455cb036bc948312d2836846bfa2644`. These are current-main results,
not a new build of the Electron 43 branch.

The ordinary Electron and isolated authentication targets built successfully.
GN dependency checks passed for both and the separate storage contract target.
The standalone state test, 26 enabled native cases and four disabled native
cases passed. The unchanged upstream `spec/api-web-authn.spec.ts` passed all
seven Linux-applicable cases; its 16 macOS-only cases were skipped. The upstream
spec used ordinary Electron, one worker and a disposable profile.

The combined build also passed the production storage contract test, ten
in-memory shutdowns and three disk-backed shutdowns. DCHECKs and sandboxing
were retained, core dumps disabled, and temporary profiles removed. No real
account, Bluetooth hardware, caBLE tunnel or live relying party was tested.
This does not establish non-Linux compile compatibility, every resolver/GC
shutdown path, absence of races, or production readiness.

## Creation follow-up

Use this creation branch with the same pinned dependency checkout and testing
configuration. Build both `electron` and `electron:electron_hybrid_browser_owned_tests`
as above, then from Chromium `src` run:

```sh
python3 electron/script/run-webauthn-hybrid-tests.py --suite creation --out-dir out/Testing
```

The mock factory supplies a virtual CTAP2 device over a synthetic hybrid transport.
It never starts a Bluetooth scan, tunnel or real authenticator. The tests check
that the native QR encodes creation or authentication without logging the payload.
Successful creation is checked against challenge, origin, RP hash, UP/UV,
credential ID and public key. A subsequent assertion is signature-verified using
that newly created virtual credential.

Coverage includes cross-platform and unspecified attachment; required, preferred
and discouraged resident key/UV; algorithm fallback and rejection; exclusion of an
existing credential; unsupported resident key/UV and failed verification; invalid
RP and iframe Permissions Policy; opt-in combinations, Session ownership, USB
fallback and BLE availability/recovery. Platform-only tests check both the absence
of a hybrid owner and successful independent virtual platform creation. A negative
platform control has no platform device. Chromium may receive cable configuration
before the platform constraint arrives; those tests assert no hybrid device or UI.

Lifecycle cases cover synchronous, duplicate and stale cancel handles, handler
false/Promise/throw, owner replacement, page abort, timeout, navigation, destroyed
windows, removed iframes and app quit with a pending creation. The shutdown case
marks its pending synthetic request before app quit; after native shutdown the
isolated executable verifies that discoveries and observers are gone and releases
the mock environment. The runner requires that completion marker and a clean exit. It does not require a terminal callback during app shutdown.
Each invocation uses fresh temporary profiles, a run identifier and result checks.
The default suite also reruns the unchanged authentication fixture.

These checks validate native integration and lifecycle behavior, not phone
interoperability, network transport or RP enrollment. Real registration remains a
user-controlled test, and no laptop artifact is regenerated for this follow-up.

On 2026-10-06 the Linux creation build passed all three GN dependency checks,
the standalone state test, 26 enabled and four disabled authentication cases,
33 enabled creation cases, three separate flag controls and pending-creation
app shutdown with the native teardown marker. The source check also generated
API declarations and compiled the positive/negative `requestType` TypeScript
fixture. The build included the separate storage fix for local validation;
it is not part of the creation PR. CMTG and virtual-override exclusion have
static/state-gate evidence, not additional browser creation cases.
