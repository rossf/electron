# Experimental Linux phone-passkey authentication and creation

This implementation combines native authentication and creation with one
per-Session UI handler. Its upstream inputs remain Electron
`6b48d9813bd791453c7b57812a5395c693ba3e14` and Chromium 156.0.8078.3
(`03a4bd2b9182691ca7d80e876878f678029aef83`). The preserved Electron 43
prototype and independent storage fix remain separate.

Registering `Session.setWebAuthnHybridHandler(handler)` is the sole opt-in for
eligible Linux authentication and creation requests. The handler returns void;
return values and Promises are ignored. Call the supplied `cancel()` to decline
the whole ceremony. A synchronous exception or an uncallable callback cancels it.

The request still snapshots one owner before discovery setup, invokes JavaScript
only after native callbacks exist, and posts `ended` after teardown. Stable request
IDs, availability updates, repeated/stale cancel protection and the actual requesting
StoragePartition are retained. Replacing/removing the handler affects future
requests only. No pairing or credential data is persisted.

Only modal WebAuthentication requests are eligible. Conditional, CMTG-key and
virtual-environment overrides remain excluded. Chromium retains origin/RP,
Permissions Policy, attachment, resident-key, user-verification, algorithm,
exclusion-list and response processing. Platform-only creation neither presents
hybrid UI nor cancels the independent platform ceremony. macOS and Windows behavior
is unchanged; this branch adds no support for either platform.

## Migration from the creation prototype

The earlier creation prototype is preserved at
`202d83aedadb45dc3e3e5b0aec12cad738b15def`.
Remove `enable-electron-webauthn-hybrid` and
`enable-electron-webauthn-hybrid-creation`; they are no longer consulted. Remove
`return true` acknowledgements. Replace a former `return false` rejection with
`cancel()`. Promise results do not decide request acceptance; handle asynchronous
errors in application code and explicitly cancel when appropriate.

Installing a handler now opts into both `get` and `create`. Cancelling a creation
update declines the entire creation ceremony; it does not restore the former
flag-controlled authentication-only mode. `setWebAuthnHybridHandler(null)` disables
ownership for future requests in that Session.

For example, this handler intentionally declines every owned request; an application
that presents QR UI replaces the final cancellation with its trusted UI integration:

```js
const { app, session } = require('electron');

app.whenReady().then(() => {
  session.defaultSession.setWebAuthnHybridHandler((details, cancel) => {
    if (details.state === 'ended') {
      // Remove any UI and transient QR data for details.requestId.
      return;
    }
    // Verify application policy using details.origin, relyingPartyId and frame.
    // Handle both requestType values and ready/unavailable updates.
    // Explicitly decline when this application cannot present trusted request UI.
    cancel?.();
  });
});
```

See the [API contract](../api/session.md#sessetwebauthnhybridhandlerhandler-linux-experimental)
and [test reproduction](webauthn-hybrid-testing.md). Native results are recorded
there separately from bounded hosted source checks. A user-operated localhost
phone test reported successful registration and signed authentication, followed by
`SIGABRT` of unconfirmed cause on exit. Other phone/provider configurations, live cancellation
and transport recovery, non-Linux compilation and production readiness remain unvalidated.

Source notices, upstream history and MIT licensing are retained. This work was
created with Codex assistance. No application integration code, profiles,
credentials, logs, dumps, screenshots or binaries are included.
