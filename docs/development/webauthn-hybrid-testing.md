# Reproduce the experimental hybrid tests

These Linux checks use disposable directories, synthetic credentials and local
fixtures. They never open a real relying party or use a production authenticator.
They do not validate real BLE, caBLE tunnels or an authenticated website session.
Keep DCHECKs enabled for native lifetime checks.

## Source and build inputs

Use this branch in a normal Electron dependency checkout. `DEPS` pins Chromium.
The independent in-memory storage task-trait fix and its reproducer are tracked
on `rossf/electron` branch `fix/in-memory-storage-shutdown`; they are not part of
this API diff. The previously validated fixed binary combined both
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
then executes handler and no-handler authentication suites and the creation modes
described below. A usable Linux
display is required for Electron; an existing Xvfb session is also suitable.
The mock binding is linked only into the separately named test executable.
The ordinary `electron` target contains no browser-owned mock binding.
Its Linux-only test entry point is `shell/app/hybrid_browser_owned_test_main_linux.cc`;
the production application keeps its existing platform entry points.

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
Without an installed Session handler, a successful synthetic USB registration
supplies the assertion credential. It checks signed
challenge/origin/RP/UP/UV data using a fresh virtual credential. It never saves a
QR payload, credential or private key. Result files exist only in the fresh private test directory; stdout contains
case counts and exit status. The supervisor sends no signals. Native test
directories are retained even on success because parent exit alone does not prove
all browser descendants have exited. The runner prints the directory locally;
remove it only after confirming its processes have stopped. Failed runs also
retain their directory. Only a successful dependency-free state test is cleaned
up automatically. Do not upload native profiles or raw test results.

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

## Historical validation before API simplification

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
RP and iframe Permissions Policy; handler/no-handler controls, Session ownership, USB
fallback and BLE availability/recovery. Platform-only tests check both the absence
of a hybrid owner and successful independent virtual platform creation. A negative
platform control has no platform device. Chromium may receive cable configuration
before the platform constraint arrives; those tests assert no hybrid device or UI.

Lifecycle cases cover synchronous, duplicate and stale cancel handles, handler
false/object/undefined/Promise returns and synchronous exceptions, owner replacement, page abort, timeout, navigation, destroyed
windows, removed iframes and app quit with a pending creation. The shutdown case
marks its pending synthetic request before app quit; after native shutdown the
isolated executable verifies that discoveries and observers are gone and releases
the mock environment. The runner requires that completion marker and a clean exit. It does not require a terminal callback during app shutdown.
Return-value cases verify the request remains pending before explicit cancellation.
Each invocation uses fresh temporary profiles, a run identifier and result checks.
The default suite also runs the authentication fixture with the same void contract.
The enabled creation fixture additionally runs four concurrent create/get cases:
cancellation or navigation of either request in separate windows. They check
distinct IDs, stable request types, a pending survivor after duplicate/stale
cancellation, exactly one terminal update per request, and discovery/observer cleanup.
These four cases keep synthetic discoveries alive without authenticators, so
they test ownership independently of credential completion. They do not test
competing transports or shared-authenticator scheduling.

Four separate response-race cases exercise creation and authentication with USB
or hybrid winning first. Each transport has an independent virtual authenticator
state. Both successful CTAP responses must be held before the chosen winner is
released. After the renderer result, one terminal owner update and native teardown,
the losing response is delivered through its original native callback. Counters
prove both deliveries and cancellation of the loser; the renderer result and
terminal count must remain unchanged. Authentication checks the winning synthetic
credential ID and signature against that transport's public key. Creation uses
the same challenge/origin/RP/UP/UV/public-key checks as the other creation cases.

These cases cover delayed synthetic success responses, including one delivered
after operation/device teardown. They do not establish simultaneous live-response
scheduling, physical USB/BLE or caBLE interoperability, network-context resolver
behavior, or successful cancellation on actual hardware. No production behavior
changes are needed, and this test-only change does not require a new user phone test.

These checks validate native integration and lifecycle behavior, not phone
interoperability, network transport or RP enrollment. The separate
[user-operated phone result](#user-operated-phone-result) records the limited live evidence.

Before this simplification, on 2026-10-06 the Linux creation build passed all three GN dependency checks,
the standalone state test, 26 enabled and four disabled authentication cases,
33 enabled creation cases, three separate flag controls and pending-creation
app shutdown with the native teardown marker. The source check also generated
API declarations and compiled the positive/negative `requestType` TypeScript
fixture. The build included the separate storage fix for local validation;
it is not part of the creation PR. CMTG and virtual-override exclusion have
static/state-gate evidence, not additional browser creation cases.

The tested creation native inputs match
`45ecd725f5f0e7092221c9a31c82450c46914d1b`, with the separate storage head
`4076a8688ef5db2ff019826c31f570881555b3d0`. The combined build also passed the
production storage contract, ten in-memory and three disk-backed shutdowns.
The unchanged upstream WebAuthn spec passed seven Linux cases, with 16 macOS-only
cases skipped, using ordinary Electron and one worker. These results retain the
same limitations as the authentication validation above.

## API simplification validation

Run the commands above on this branch. No experimental process switches are used.
The native fixtures cover no-handler defaults, cross-Session isolation, successful
no-return handlers for create/get, ignored return values, synchronous exceptions,
explicit and repeated cancellation, availability and teardown. Creation has an
additional pending-request shutdown invocation. The generated TypeScript test
requires a void return contract and rejects a boolean acknowledgement type.

The historical counts above describe earlier source heads, not this API revision.
The separately reproduced hover-related BrowserContext shutdown failure is an
independent issue; no fix for it is included in this API diff.

On 2026-10-07, Linux validation of API source
`1b0795cd29256c500f805a5325992928c4bb1deb` passed: the ordinary Electron and
isolated mock executables compiled; the state test, 26 authentication cases,
four authentication no-handler controls, 35 creation cases, one creation
no-handler control and pending-creation shutdown all passed. The shutdown case
required the native teardown marker. Ignored-return cases checked both a pending
renderer request and live native discovery before explicit cancellation.

Changed-file lint, generated declarations and actual TypeScript checks passed,
as did nine offline CI-harness tests and five mocked supervisor tests. The native
supervisor sent no signals and retained its fresh private test directories.
Sandboxing and DCHECKs were enabled, with core dumps disabled.

The compiled checkout used the same Electron/Chromium bases listed above and
included the independent storage fix at
`4076a8688ef5db2ff019826c31f570881555b3d0`. That dependency patch remains outside
this API diff. These results establish the synthetic API contract on Linux;
they do not establish that the separate hover shutdown failure is fixed.

## Concurrent ownership validation

On 2026-10-07, the isolated Linux test executable was rebuilt for the test-entry
rename and pending-only mock mode. The targeted run passed 70 synthetic browser
cases: 39 creation cases including the four concurrent create/get cases, one
creation no-handler control, 26 authentication cases and four authentication
no-handler controls. The standalone state test and the renamed target's GN
dependency check also passed. The production API implementation was unchanged.

The build retained sandboxing, DCHECKs and the independent storage patch recorded
above. Core dumps were disabled; the supervisor sent no signals and retained
the private test directories. The pending-creation app-quit case was not rerun
in this follow-up; its earlier result remains recorded above. No new phone
ceremony or shutdown investigation was performed.

## Competing transport response validation

On 2026-10-07, the rebuilt isolated Linux executable passed 74 targeted synthetic
cases: 43 in the enabled creation fixture (35 earlier cases, four concurrent
create/get ownership cases and four USB/hybrid response races), one creation
no-handler control, 26 authentication cases and four authentication no-handler
controls. Both winner orders passed for creation and authentication.

Each race held and delivered exactly one successful response per transport,
observed cancellation of the loser, and finished with no held/in-flight callbacks,
live virtual devices, discoveries or adapter observers. The losing response was
delivered after native teardown, leaving the verified renderer result and single
terminal owner update unchanged. These are synthetic callback-ordering results,
not evidence for real hardware, the network-context resolver or simultaneous
live-response scheduling.

GN dependency and changed-source checks passed, and independent source review
found no remaining blockers. Production behavior and the previously supplied
user-test runtime were unchanged. The build still included the separately
recorded storage patch. The supervisor sent no signals, core dumps were disabled,
and private test directories were retained. The pending-creation app-quit case
was not rerun; shutdown investigation remains deferred.

## User-operated phone result

On 2026-10-07, a user-operated disposable localhost test of the simplified API
reported `registrationVerified: true` and `authenticationVerified: true`, with
one native creation-ready and one native authentication-ready update. This is
user-supplied harness evidence for successful phone registration and signed
authentication in that configuration; the assistant did not independently observe
the ceremony.

The same run subsequently exited with `SIGABRT` (`code: null`, overall `ok: false`).
Clean exit failed. No stack trace was supplied and the cause is unconfirmed; this
does not establish that it is the separately tracked hover shutdown issue.
The supervisor reported zero signals sent.

Live cancellation and transport interruption/recovery, other phones/providers
and relying parties, non-Linux compilation and production readiness remain
unvalidated. No credentials, QR payloads, profiles or raw native results are
published here. The separate shutdown investigation remains deferred.
