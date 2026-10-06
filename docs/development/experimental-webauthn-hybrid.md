# Experimental Linux phone-passkey creation follow-up

This branch adds separately gated creation to the current-main authentication
port at `661ae4c26316cacabddd8773df6814173e8c76ce`. That port targets Electron
`6b48d9813bd791453c7b57812a5395c693ba3e14` and Chromium 156.0.8078.3
(`03a4bd2b9182691ca7d80e876878f678029aef83`). Its Linux build and synthetic
validation are recorded in [test reproduction](webauthn-hybrid-testing.md).
The authentication branch and the preserved Electron 43 branch remain separate.

Authentication requires `enable-electron-webauthn-hybrid` and a Session handler.
Creation additionally requires `enable-electron-webauthn-hybrid-creation`.
Both switches must be set before readiness. The handler receives `requestType`
(`get` or `create`) on availability and terminal updates so trusted main-process
UI can distinguish signing in from creating a passkey. The renderer still uses
standard `navigator.credentials.create()`; the handler cannot supply credentials.

Only modal WebAuthentication requests are eligible. Conditional requests, CMTG-key
requests and virtual-environment overrides remain excluded. Chromium retains
origin/RP and Permissions Policy validation and attachment, resident-key,
user-verification, algorithm, exclusion-list and response processing. Platform-only
creation is filtered by Chromium before discovery; when its constraint arrives,
this delegate drops its unused hybrid owner without presenting UI or cancelling
the independent platform ceremony. No pairing or credential data is persisted.

The independent storage shutdown fix remains on `fix/in-memory-storage-shutdown`.
It is used by the combined local validation build but is outside this creation
diff. No Chromium source file or dependency patch is added by this follow-up.
The bounded source workflow accepts this creation branch targeting its
current-main authentication base and checks the generated request-type field.

See [creation reproduction and coverage](webauthn-hybrid-testing.md#creation-follow-up)
and [remaining review work](webauthn-hybrid-upstream-review.md).
Real phone/BLE/caBLE interoperability, non-Linux compatibility and production
readiness remain unvalidated. Real registration and subsequent sign-in are a
user-controlled handoff; no real account or credential is created by these tests.

Source notices, upstream history and MIT licensing are retained. This work was
created with Codex assistance. No application integration code, profiles,
credentials, logs, dumps, screenshots or binaries are included.
