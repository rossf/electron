# Experimental Linux phone-passkey checkpoint

This branch preserves an existing, AI-assisted Electron WebAuthn hybrid
prototype. It is experimental source for review, not a supported API or
production distribution.

## Provenance and repository boundary

- Electron 43.7.0 base: `c440db52c29668e848f02e374720e15b6025a132`.
- Chromium version: `150.0.7871.250`.
- Electron-patched Chromium base: `0f94d8e4283eb200da8cc5ed57baccb8d8c3419f`.
- Original hybrid patch SHA-256:
  `232fe1609402c75774cbd8161c54ecb8156bc6ad8bf32fdeaabc756bc22fef4a`.

The original hybrid implementation remains unchanged. The independent
in-memory DOM-storage shutdown fix and its storage-only reproducer are tracked
on `rossf/electron` branch `fix/in-memory-storage-shutdown`. They were separated
from this authentication diff using ordinary commits; prior history remains.
The preserved fixed test binaries combined both changes.

Upstream MIT licensing, source notices and history remain intact. The source was
created with Codex assistance. No application integration code, profiles, logs,
crash dumps, screenshots, credentials or binaries are included.

## Behavior and test reproduction

The feature is default-off, Linux-only and limited to modal
`navigator.credentials.get()` requests. Creation remains on the existing
registration path. See the [Session API contract](../api/session.md#sessetwebauthnhybridhandlerhandler-linux-experimental)
and [native test instructions](webauthn-hybrid-testing.md).

The test-only browser executable and portable fixtures replace all authenticator
discovery with synthetic devices. The normal Electron target does not link the
mock binding. Separate debug helpers and application integration tests are not
included. This is not a byte-identical binary archive.

## Validation and limits

The portable state test and 26 enabled/4 disabled native cases passed against
the preserved fixed Electron 43 binaries. The native cases include successful
existing `create()` registration without hybrid interception and independently
cancelled concurrent `get()` requests. That fixed build included the companion
storage change. It also passed the storage contract and 13 storage-only shutdowns;
those checks now belong to the independent storage work.

The saved checkpoint additionally records ten application integration flows and
a synthetic full-app shutdown passing. A later laptop trial was user-reported
to complete phone passkey login and exit cleanly, with its temporary profile
removed. This is one user-observed trial. Laptop artifact bytes and transport
telemetry were not independently verified; exit status alone does not prove
login success. The original manual shutdown initiator remains unknown and
broader platform, authenticator and relying-party compatibility is unproven.
