# Experimental Linux phone-passkey checkpoint

This branch preserves an existing, AI-assisted Electron WebAuthn hybrid
prototype and the separately validated in-memory storage shutdown fix. It is
experimental source for review, not a supported API or production distribution.

## Provenance and repository boundary

- Electron 43.7.0 base: `c440db52c29668e848f02e374720e15b6025a132`.
- Chromium version: `150.0.7871.250`.
- Electron-patched Chromium base: `0f94d8e4283eb200da8cc5ed57baccb8d8c3419f`.
- Original hybrid patch SHA-256:
  `232fe1609402c75774cbd8161c54ecb8156bc6ad8bf32fdeaabc756bc22fef4a`.
- Saved Chromium shutdown-fix patch SHA-256 before mail-format export:
  `ac7fda57d3744c09591c73b9e10339fd8d9467414fcb1a3c998d100509df08e2`.

The original hybrid implementation remains unchanged. The shutdown fix is a
separate Chromium patch, listed in `patches/chromium/.patches`, which adds
`base::MayBlock()` to the in-memory DOM-storage task runner. Existing
synchronization and shutdown traits are retained. It is not a landed upstream
Chromium fix. The exported patch explains when it can be removed.

Upstream MIT licensing, source notices and history remain intact. The source was
created with Codex assistance. No application integration code, profiles, logs,
crash dumps, screenshots, credentials or binaries are included.

## Behavior and test reproduction

The feature is default-off, Linux-only and limited to modal credential assertion
requests (`navigator.credentials.get()`). Creation remains on the existing
registration path. See the [Session API contract](../api/session.md#sessetwebauthnhybridhandlerhandler-linux-experimental)
and [native and storage test instructions](webauthn-hybrid-testing.md).

The test-only browser executable and fixture runner are now included for
reproducibility. They replace all authenticator discovery with synthetic devices
and use generated disposable storage. The normal Electron target does not link
that mock binding. The previously separate debug testing helpers and application
integration tests are not included. This is not a byte-identical binary archive.

## Current portable checks

On the preserved fixed Electron 43 binaries, the portable runner passed its
standalone state test, deterministic storage contract probe, 26 enabled and
4 disabled native cases, and 13 storage shutdown runs. These include an explicit
non-interception check for existing `create()` registration and independently
cancelled concurrent `get()` requests. The binaries were not rebuilt from this
publication checkout; the native helper and storage probe sources match the
saved fixed-build inputs. The portable fixture/runner sources are now included.

## Historical validation and remaining limits

The saved fixed-build checkpoint records 22 enabled and 3 disabled native cases,
13 storage-only shutdowns, ten application integration flows and a synthetic
full-app shutdown passing. A later laptop trial was user-reported to complete
phone passkey login and exit cleanly (`code: 0`, no signal, temporary profile
removed). This is one user-observed trial. Laptop artifact bytes and native
transport telemetry were not independently verified; process exit alone is not
an automated assertion of login success.

The storage fix addresses the demonstrated blocking-contract failure with
DCHECKs retained. It does not establish every possible shutdown race is resolved;
the original manual shutdown initiator remains unknown. Broader platform,
authenticator and relying-party compatibility is not established. The earlier
restricted investigation was not bypassed; no credential-bearing memory or
profile contents were read. Preparing this source update does not entail another
real-account trial or installing the experiment into an existing application.
