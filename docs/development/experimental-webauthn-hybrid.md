# Experimental Linux phone-passkey main port

This branch prepares the authentication-only prototype for upstream `main`
commit `6b48d9813bd791453c7b57812a5395c693ba3e14`, whose DEPS pins Chromium
`156.0.8078.3`. It is source preparation, not a compiled or runtime-validated
main build. The separately preserved Electron 43 branch remains unchanged by
this port.

The default-off Linux backend configures only modal
`navigator.credentials.get()` requests with an installed Session handler.
`create()` continues on the existing registration path. Conditional requests,
virtual test overrides and CMTG-key requests are excluded. Chromium owns origin,
RP, credential and authenticator validation. The Session handler supplies trusted
UI ownership and cancellation, not credential responses.

The port adapts the additional Chromium discovery argument and current Electron
object-template API. Its callback root is held by a native peer, released outside
GC sweeping. Hybrid availability handling preserves main's existing authenticator
selection flow and checks for synchronous destruction after calling JavaScript.
The isolated test executable uses main's Linux entry point plus only the test
binding registration.

The Chromium storage fix is preserved separately under `patches/chromium` and
registered in `.patches`. It applies to the pinned Chromium 156 source, which
still lacks `MayBlock()` on the in-memory DOM-storage runner. This source check
is not a native build or a landed Chromium fix. The patch records provenance and
its removal condition.

See [test reproduction](webauthn-hybrid-testing.md) and
[upstream comparison and remaining work](webauthn-hybrid-upstream-review.md).
The state test and source checks pass locally. Native 26-enabled/4-disabled and
13-storage results belong to the preserved fixed Electron 43 binaries; they
must be rerun on a new main build before this port is called stable.

Source notices, upstream history and MIT licensing are retained. This work was
created with Codex assistance. No application integration code, profiles,
credentials, logs, dumps, screenshots or binaries are included. Historical
user-reported phone-login success and clean shutdown on a laptop are limited
observations, not proof of platform-wide compatibility.
