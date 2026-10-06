# Fork CI activation gate

Every inherited workflow job is guarded by
`github.repository == 'electron/electron'`, preserving its original condition.
One five-minute read-only `ubuntu-24.04` PR check is staged for the fork's
authentication branches. It uses SHA-pinned checkout without persisted
credentials and runs only diff whitespace and the standalone C++ state test.
It has no secrets, cache, artifacts, publishing or external dispatch.

Actions is still disabled. The API returned an empty registered-workflow list,
and disabling `build.yml` by filename returned 404 despite the tracked YAML.
No global activation was attempted.

## Safe activation sequence

1. Review and explicitly approve merging this configuration PR into protected
   fork `main`. This draft does not merge or bypass that protection.
2. While Actions remains off, apply the same guards to every active PR head and
   base. Keep the original Electron 43 baseline reference intact, create a
   guard-only baseline branch, and retarget the authentication PR to it with
   identical guards on its head. Verify that the comparison remains focused on
   authentication and that the original baseline code is unchanged.
3. Restrict allowed actions to the checkout SHA used here, keep default workflow
   permissions read-only, and disallow Actions approving PRs.
4. Only after every active event source is guarded, enable the repository,
   enumerate workflows and manually disable every inherited workflow. Read back
   the entire inventory. The source guards prevent inherited jobs from running
   during registration, including jobs using `always()`.
5. Confirm only the fork check is active, trigger normal PR synchronization,
   and verify its bounded read-only run. Treat that result as a state/diff check,
   never as native WebAuthn, BLE, V8 or shutdown validation.

Review and guard workflows arriving from a later upstream sync before they
become active event sources. Do not use old baseline references as new PR bases
until guarded. No paid or inherited runners are needed.
