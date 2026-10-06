# Fork CI status and maintenance

The CI-only [PR #3](https://github.com/rossf/electron/pull/3) was approved and
merged into protected fork `main` as
`30c3748e8dc756851b78258c352df919dee9e392`. Actions is enabled. The earlier
activation blockers were resolved; they are not the current repository state.

## Active check and coverage

`Fork hybrid state checks` is the only active registered workflow. Its
five-minute, read-only `ubuntu-24.04` job checks the exact base/head diff and
compiles/runs the standalone C++ lifetime-policy test. It does not validate
native WebAuthn, BLE, V8 lifetime or storage shutdown.

It runs for `pull_request` events `opened`, `reopened` and `synchronize`,
targeting `main` or `baseline/electron-v43.7.0-fork-ci`. The PR head must be in
`rossf/electron` and on one of these authentication branches:

- `experimental/linux-phone-passkey-preservation`
- `experimental/linux-phone-passkey-main`

[PR #1's check passed](https://github.com/rossf/electron/actions/runs/37410049000)
on head `5a1932b2fffd08a14a489a035000349d49f8804d`. Its one Ubuntu job took eight
seconds, and GitHub reported zero billable milliseconds. New qualifying PR
updates run automatically. Merely targeting `main` does not qualify a different
head branch; its state job is skipped. The independent storage-only PR #2 has
no coverage from this authentication-only job. Its native validation is separate.

The guarded Electron 43 baseline is used for PR #1. The original
`baseline/electron-v43.7.0-c440db5` reference remains pinned and is not an active
CI base. The workflow branch filter names the guarded baseline.

## Repository controls

All 52 inherited registered workflows are manually disabled. Every inherited
job on the active bases and heads also has the repository guard
`github.repository == 'electron/electron'`, preserving its original condition.
The disabled inherited entries in the Actions list do not mean that the
replacement check is disabled.

Repository policy requires SHA pinning and permits only
`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`. Checkout does not
persist credentials. The workflow has no secrets, cache, artifacts, publishing
or external dispatch. Default token permissions are read-only and Actions
cannot approve PR reviews. Main still requires a PR with admin enforcement;
force-push and deletion remain disallowed.

## Maintenance

Keep the job limits, exact action allowlist and disabled inherited workflow
inventory intact when maintaining this configuration. Review and guard workflows
arriving from a later upstream sync before they become active event sources.
Do not use old unguarded baseline references as new PR bases. Adding useful
coverage for other branches or storage requires a deliberate, reviewed workflow
change; this configuration does not claim full fork CI coverage.
