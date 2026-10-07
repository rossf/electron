# Network hints shutdown regression

Hovering an ordinary element in an HTTP document can lazily bind the network-hints
interface, even when the element is not a link. Electron's self-owned receiver
stored a `raw_ptr<BrowserContext>` that could survive shutdown of that context.
With dangling-pointer checks enabled, closing the final window could abort during
the allocator's exit check.

The handler now keeps only the frame's routing ID, resolves the live frame for
each `Preconnect` call, and returns if that frame has gone away. The receiver no
longer retains the browser context. The `preconnect` event's URL, credentials flag
and originating frame remain covered by the regression.

## Reproduce

Use a complete checkout with its pinned dependencies, installed root and spec
dependencies, and an Electron testing build. Keep DCHECKs and dangling-pointer
checks enabled. From the Electron repository root, set
`ELECTRON_SPEC_ELECTRON_PATH` to the executable to test, then run:

```sh
ELECTRON_SPEC_KEEP_RUNNING_INSTANCES=1 \
  spec/node_modules/.bin/vitest run --config spec/vitest.config.ts \
  api-network-hints-shutdown.spec.ts
```

The suite runs serially because the hover case focuses a visible window. Each
child uses a fresh temporary session and a loopback-only HTTP server. The cases
exercise no hover, a renderer-confirmed mouse move, and confirmed `preconnect`
events with and without credentials. The anonymous case sets
`crossOrigin = 'anonymous'` before inserting the link and requires the event's
`allowCredentials` value to be `false`; both preconnect cases also verify the URL
and originating frame. Each case must reach its ready marker and exit with code
zero and no signal.
The environment setting above disables the spec runner's sweep of previously
running Electron instances; ordinary cleanup of children started by this suite
still applies.

## Validation scope

On Linux, the unmodified pinned Electron baseline
`6b48d9813bd791453c7b57812a5395c693ba3e14`, with Chromium `156.0.8078.3` and its
existing Electron patches, passed no-hover and aborted with `SIGABRT` in both
hover and preconnect cases. That baseline contained neither the experimental
phone-passkey changes nor the separate in-memory storage shutdown patch. Adding
only this native lifetime correction made those original three cases pass.

The extended anonymous-preconnect case also reached its ready marker and then
aborted with `SIGABRT` on that baseline. The unchanged correction-only runtime
and the separate combined API/storage/correction runtime each passed all four
cases. No production change or rebuild was needed for this coverage addition.

Direct delivery of a queued hint after verified frame destruction remains
uncovered. The JavaScript fixture cannot control or acknowledge the private Mojo
receiver's dispatch order. A deterministic test needs native queue control and
must assert that a real Electron session receives no late `preconnect` event;
a timing-dependent link-and-remove sequence would not establish that ordering.

This validates the reproduced network-hints shutdown failure. It does not identify
every possible cause of a shutdown abort. No credentials, sign-in, private
profiles, process memory or core dumps are needed by these tests. Actual macOS and
Windows builds have not been validated.
