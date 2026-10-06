# In-memory DOM-storage shutdown regression

This change adds `base::MayBlock()` to Chromium's in-memory DOM-storage task
runner. In-memory LevelDB destruction can wait for background compaction; its
condition-variable wait needs blocking permission. Existing sync and
`BLOCK_SHUTDOWN` traits remain intact. Electron carries the change through its
normal Chromium dependency patch and `.patches` list.

This draft is based on Electron main `6b48d9813bd791453c7b57812a5395c693ba3e14`,
which pins Chromium `156.0.8078.3`. The pinned storage source still lacks the
trait and the patch applies cleanly. A separate Linux testing build and the
synthetic checks below passed on 2026-10-06. The patch has not been submitted
or landed in Chromium; its message states the removal condition.

## Reproduce

Use a normal Electron dependency checkout with DCHECKs enabled and this branch
as `src/electron`. Standard dependency sync imports the patch; do not apply it
a second time. From the Chromium `src` directory:

```sh
ninja -C out/Testing electron electron:storage_blocking_contract_test
python3 electron/script/run-storage-shutdown-tests.py --out-dir out/Testing
```

`--suite contract` tests blocking permission on the actual production runner.
`--suite storage` performs ten in-memory and three disk-backed synthetic storage
shutdowns in disposable profiles. It blocks DNS and uses generated local/session
storage only, with no WebAuthn calls or accounts. A usable Linux display is
required. The runner checks exit status and write/quit completion markers,
limits child duration, disables core dumps, and deletes temporary profiles.
`--electron-binary` can select an existing ordinary Electron binary explicitly.

## Evidence and scope

The historical Chromium 150 checkpoint reproduced the blocking-contract failure
without passkey changes, then passed the contract and 13 storage shutdown checks
with this task-trait fix. The runner in this PR is storage-only; its production
probe and fixture retain those source inputs. Those historical results are not
new Chromium 156 build results. They support a pre-existing storage defect
exposed by the synthetic workload, not a defect introduced by the optional
passkey backend. The original manual shutdown initiator remains unknown, and
finite runs cannot rule out every shutdown race.

The independent authentication experiment's successful manual and native checks
used a combined build containing both changes. This PR includes no authentication
implementation. No profiles, credentials, logs, dumps or binaries are published.
Upstream licensing and notices are retained; this work used Codex assistance.

## Current-main validation

The tested storage source was `22e87638d455cb036bc948312d2836846bfa2644`,
combined with the independent authentication source
`cc41beacdce46acee8a2e5245d037fe3f7be6904` on the Electron/Chromium bases above.
Ordinary Electron and the production storage contract executable built, and
both passed GN dependency checks. The contract test, ten in-memory shutdowns
and three disk-backed shutdowns all passed with DCHECKs and sandboxing retained.
The storage fixture made no authentication API calls; this was a combined build,
not a separate storage-only binary. No real account, profile or credential was used.

Fork source CI separately checks lint, real generated API/TypeScript compilation,
the patch registry and one-file applicability against pinned Chromium after any
predecessor patches touching that file. It does not compile Chromium or establish
runtime shutdown behavior. See [fork CI controls](fork-ci-activation.md) and the
exact source SHA in the relevant run. Native results do not establish non-Linux
compatibility or eliminate every shutdown race.
