# Upstream comparison and remaining work

## Existing proposal

Source review of [electron/electron#53733](https://github.com/electron/electron/pull/53733)
at head `304c8efa796182a166b9d8cec8f8c82f86c5e588` found overlapping native
QR/discovery configuration, with modal creation and assertion support on macOS
and Linux. This fork provides a separate Linux Session API for authentication and
creation. Installing the handler is the sole opt-in; no process switch is required.
Request IDs, per-request ownership, cancellation, availability transitions and
posted terminal notification are additional lifecycle concerns. No upstream
review, message or PR has been submitted from this fork.

Do not transplant either proposal blindly. Preserve main's existing account,
PIN and authenticator selection behavior and its `spec/api-web-authn.spec.ts`
Vitest tests. Keep JavaScript out of discovery configuration: Chromium continues
constructing its request handler before action callbacks are installed.

## Main build and validation gate

A separate Linux build against Chromium 156 completed with DCHECKs and
sandboxing retained. GN checks, the portable synthetic authentication suite,
storage contract/shutdown checks, and all seven applicable unchanged upstream
WebAuthn cases passed. See [recorded validation](webauthn-hybrid-testing.md#historical-validation-before-api-simplification)
for exact source commits and scope. The preserved Electron 43 checkout and
binaries were not overwritten.

Non-Linux compilation remains unvalidated. A later user-operated localhost phone
test reported registration and signed authentication success, followed by
`SIGABRT` of unconfirmed cause on exit; see the [phone result](webauthn-hybrid-testing.md#user-operated-phone-result).
The network-context resolver's weak owner, original partition and non-null
closed endpoint still need review; the portable suite does not directly exercise
every resolver or native-peer shutdown/GC path. Finite synthetic runs cannot
establish production readiness. The standalone state test and source CI alone
cannot establish native lifetime properties.

## Consolidated authentication and creation

The creation branch combines authentication, registration and the simplified void
handler contract for one comparison against fork `main`. `requestType` distinguishes
the two ceremonies. The earlier authentication-only branch remains a historical
snapshot; installing a handler in this implementation opts into both operations. Source and
synthetic tests cover attachment, resident keys, UV, algorithms, exclusions,
platform-only requests, cancellation, timeout, navigation, destruction and app
shutdown. See [creation coverage](webauthn-hybrid-testing.md#creation-follow-up)
and the [API simplification results](webauthn-hybrid-testing.md#api-simplification-validation).

The reported phone result covers one disposable localhost configuration, not
other phones/providers or relying parties. Live cancellation and transport
interruption/recovery remain unvalidated. Further user-controlled testing should
use a disposable relying party and account, confirm
that UI says "Create a passkey" with the expected origin/RP, explicitly approve
creation on the phone, then check a separate sign-in and cancellation. Keep QR,
credential, account and device data out of reports. `ended` signals native
lifecycle completion, not successful RP enrollment. This repository includes no
application-specific registration UI and no real credential-creation automation.
