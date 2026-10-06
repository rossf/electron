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

A separate Linux build against Chromium 156 completed with DCHECKs and
sandboxing retained. GN checks, the portable synthetic authentication suite,
storage contract/shutdown checks, and all seven applicable unchanged upstream
WebAuthn cases passed. See [recorded validation](webauthn-hybrid-testing.md#recorded-current-main-validation)
for exact source commits and scope. The preserved Electron 43 checkout and
binaries were not overwritten.

Non-Linux compilation and real phone interoperability remain unvalidated on this
build. The network-context resolver's weak owner, original partition and non-null
closed endpoint still need review; the portable suite does not directly exercise
every resolver or native-peer shutdown/GC path. Finite synthetic runs cannot
establish production readiness. The standalone state test and source CI alone
cannot establish native lifetime properties.

## Separate creation follow-up

Finish and review authentication before a separate creation PR. Chromium already
provides make-credential, caBLE, QR encoding and origin/RP/response machinery.
The follow-up must deliberately define eligibility and request type/UI wording;
cover attachment, resident key, UV, algorithms, excludeCredentials and
platform-only requests; and test cancellation, timeout, navigation, destruction
and shutdown using browser-owned requests. Any real disposable-RP registration
and subsequent sign-in requires a user-controlled test handoff. No creation
support or real credential creation is included here.
