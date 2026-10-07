# Fork source checks

The fork uses a bounded Ubuntu workflow for source validation. Native builds
and synthetic browser tests remain separate local validation steps.

## Coverage

The candidate workflow runs on this fork's own authentication, storage and CI
branches targeting `main`, `baseline/electron-v43.7.0-fork-ci` or the
authentication base `experimental/linux-phone-passkey-main` or creation base
`experimental/linux-phone-passkey-create-main`. The explicit
head allowlist contains `experimental/linux-phone-passkey-preservation`,
`experimental/linux-phone-passkey-main`, `fix/in-memory-storage-shutdown` and
`docs/fork-ci-active-status`. This creation branch additionally permits
`experimental/linux-phone-passkey-create-main`; the API simplification adds
`experimental/linux-phone-passkey-api-main`. Events are `opened`, `reopened` and `synchronize`.
It checks the exact head against GitHub's resolved merge base:

- Electron's changed-file C++, GN, Python, JavaScript and documentation linters,
  plus explicit CommonJS lint and JavaScript/TypeScript formatting checks.
- API declaration generation, the actual upstream TypeScript smoke compiler and
  documentation TypeScript checks. Authentication heads also compile a small
  positive/negative check for `setWebAuthnHybridHandler` against the generated API.
  Creation also checks the `requestType` field. The simplification additionally
  checks no-return handlers, a void return type and rejection of the old boolean
  acknowledgement type.
- The standalone C++ lifetime-policy test, when present on that source head.
- Five mocked supervisor tests for timeout behavior and profile retention, alongside
  the nine offline patch-order/scope tests. These checks do not launch Electron.
- Chromium patch registry consistency. When the storage shutdown patch is
  present, the complete one-file patch must apply to the source version pinned
  by that head's DEPS, after earlier patches touching the same file. The check
  retains all three task traits and rejects extra target files or renames.

Storage applicability validates only the affected file. It does not validate
an entire Chromium patch stack, compile native code, or reproduce shutdown.
The standalone policy test does not exercise V8, Bluetooth or native WebAuthn.
These checks cannot establish real phone interoperability or production safety.

## Candidate validation and rollout

On `docs/fork-ci-active-status`, the candidate harness additionally resolves
and validates the current PR #1 head, PR #2 head and
`experimental/linux-phone-passkey-main`. Each job checks out that immutable
source separately and uses its own lockfile and lint/type configuration. Logs
record the harness, source, PR base, merge base and dependency identities.

Those matrix results belong to the CI candidate PR. They validate the logged
source commits; they are not checks attached to PR #1 or #2 and do not rerun
merely because another branch advances. Continuous checks on those PRs require
the reviewed CI change on their heads and a new qualifying PR event. The expanded CI candidate was merged as PR #4 at
`265bd09e15d9baf0f07cdddd3254d02ee19a66fb`. Its exact-source checks on PR #1
and PR #2 are active; merging does not itself rerun those checks. The creation
branch/base additions are isolated in this follow-up.

The guarded Electron 43 baseline is used for PR #1. The original
`baseline/electron-v43.7.0-c440db5` reference remains pinned. Do not use that
unguarded historical reference as a new PR base.

## Tools and limits

The workflow uses standard `ubuntu-24.04`, read-only token permissions, a
five-minute preparation job, and at most two concurrent twenty-minute source
jobs. The sole allowed action remains
`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`, without persisted
credentials. No extra action, repository secret, cache, artifact upload,
publishing, external dispatch or paid runner is required.

The helper downloads an official SHA-256-checked Node 22.23.3 archive and pinned
depot_tools, then installs the GN revision and checksummed clang-format object
from the target Chromium's DEPS. Python lint uses pylint 2.17.7; JavaScript
packages use the source checkout's immutable Yarn lockfile. Package installation
and dependency failures fail the check. No full Chromium checkout is fetched.

All 52 inherited registered workflows remain manually disabled. Their jobs on
active bases and heads also retain the `electron/electron` repository guard.
Default token permissions remain read-only, and Actions cannot approve reviews.
Main requires a PR with admin enforcement; force-push and deletion are disabled.
Review and guard workflows from any later upstream sync before enabling them.

## Local reproduction

Use a disposable workspace containing the target at `src/electron`, and keep
the candidate harness in a separate checkout. The helper's `setup` phase writes
small build-tool files alongside the source, installs locked packages and emits
PATH/environment entries using `GITHUB_PATH` and `GITHUB_ENV`. It is intended
for a fresh CI workspace, not an existing Chromium build tree.

Run `python3 script/test_fork_ci.py` in the harness for the offline patch-order
and validation tests. The workflow records the exact commands for `setup`,
`lint`, `types`, `state` and `storage`, including the source and comparison SHA.
The authentication and storage documents describe their separate native runners.
