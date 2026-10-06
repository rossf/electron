# Experimental Linux phone-passkey preservation checkpoint

This branch preserves an existing, AI-assisted Electron WebAuthn hybrid
prototype. It is experimental source for review, not a supported Electron API
or a production-ready distribution.

## Provenance

- Electron base: `c440db52c29668e848f02e374720e15b6025a132`.
- Recorded dependency version: Chromium `150.0.7871.250`.
- Recorded Electron-patched Chromium checkout:
  `0f94d8e4283eb200da8cc5ed57baccb8d8c3419f`.
- Preserved source patch: `electron-hybrid-reviewed-experimental.patch`.
- Original patch SHA-256:
  `232fe1609402c75774cbd8161c54ecb8156bc6ad8bf32fdeaabc756bc22fef4a`.

The ten source, build, test, and API-documentation files from that patch are
preserved without implementation changes. This note is the only added material.
The repository's MIT license, existing copyright notices, and upstream history
are retained. The source was created with Codex assistance.

## Repository scope

All changes in this branch belong to Electron. The prototype calls Chromium
APIs, but includes no new Chromium source changes or dependency patches.
Chromium remains a separate dependency governed by Electron's pinned `DEPS`
and existing patch configuration.

The branch includes the standalone `HybridRequestState` test source. It excludes
the separate browser-owned mock test executable, application integration code,
and later incomplete shutdown-probe changes. It is not a complete snapshot of
the source inputs of any previously tested binary.

## Experimental limitations

The feature is default-off, Linux-only, and limited to modal credential
assertion requests. Its API contract is documented in
[`session.setWebAuthnHybridHandler`](../api/session.md#sessetwebauthnhybridhandlerhandler-linux-experimental).

The standalone test covers the lifetime policy only; it does not validate native
caBLE transport, V8, Bluetooth, or complete authentication. The preservation
review checked patch applicability, source identity, and publication privacy.
No implementation, build, runtime test, or crash investigation was executed
for this publication, and no production-readiness claim is made.

Shutdown/crash behavior remains unresolved. Incomplete follow-up edits are not
included, and this branch does not claim to fix that behavior. Broader platform,
authenticator, and relying-party compatibility is not established.
