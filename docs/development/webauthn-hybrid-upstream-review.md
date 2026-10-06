# Upstream comparison and remaining work

## Existing proposal

Source review of [electron/electron#53733](https://github.com/electron/electron/pull/53733)
at head `304c8efa796182a166b9d8cec8f8c82f86c5e588` found overlapping native
QR/discovery configuration, with modal creation and assertion support on macOS
and Linux. This branch retains its separate Linux authentication-only API.
Request IDs, per-request ownership, cancellation, availability transitions and
posted terminal notification are additional lifecycle concerns. No upstream
review, message or PR has been submitted from this fork.

Do not transplant either proposal blindly. Preserve main's existing account,
PIN and authenticator selection behavior and its `spec/api-web-authn.spec.ts`
Vitest tests. Keep JavaScript out of discovery configuration: Chromium continues
constructing its request handler before action callbacks are installed.

## Main build and validation gate

The source port has not been compiled against Chromium 156. Use a separate full
Electron/Chromium dependency checkout and testing output directory, with DCHECKs
and sandboxing retained. Do not reuse or overwrite the preserved Electron 43
checkout or binaries. Native compilation, GN dependency validation, existing
WebAuthn specs and the portable synthetic suite are required next. Review native
peer shutdown/GC behavior on the resulting build, as well as Linux behavior and
non-Linux compile compatibility. The network-context resolver's weak owner,
original partition and non-null closed endpoint need continued review; the
portable suite does not directly exercise every resolver shutdown branch.

The standalone state test cannot establish those native properties. A full
source sync/build is a separate resource commitment, not part of the small fork
Actions job. No real account or credential is required for synthetic tests.

## Separate creation follow-up

Finish and review authentication before a separate creation PR. Chromium already
provides make-credential, caBLE, QR encoding and origin/RP/response machinery.
The follow-up must deliberately define eligibility and request type/UI wording;
cover attachment, resident key, UV, algorithms, excludeCredentials and
platform-only requests; and test cancellation, timeout, navigation, destruction
and shutdown using browser-owned requests. Any real disposable-RP registration
and subsequent sign-in requires a user-controlled test handoff. No creation
support or real credential creation is included here.
