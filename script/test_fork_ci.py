#!/usr/bin/env python3
"""Regression tests for bounded source validation without network access."""

import contextlib
import difflib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import fork_ci


BASE = '''void Configure() {
  if (database_path.empty()) {
    return CreateRunner({base::WithBaseSyncPrimitives(),
                         base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
  }
}
'''


def patch(before, after, filename=fork_ci.STORAGE_FILE):
    """Create a complete synthetic Git patch with its removal condition."""
    return ('Subject: [PATCH] synthetic storage contract\n\n'
            'Remove it when the upstream contract changes.\n\n'
            f'diff --git a/{filename} b/{filename}\n'
            + ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                          'a/' + filename, 'b/' + filename)))


class StoragePatchTests(unittest.TestCase):
    """Exercise real git application and reject unsupported or missing deltas."""

    def setUp(self):
        # unittest owns this context until each test finishes.
        # pylint: disable-next=consider-using-with
        self.temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temporary) / 'electron'
        self.tree = Path(self.temporary) / 'chromium'
        self.directory = self.root / 'patches/chromium'
        self.directory.mkdir(parents=True)
        self.source = self.tree / fork_ci.STORAGE_FILE
        self.source.parent.mkdir(parents=True)
        self.source.write_text(BASE)
        self.changed = BASE.replace('CreateRunner({', 'CreateRunner({base::MayBlock(), ')
        self.register({fork_ci.STORAGE_PATCH: patch(BASE, self.changed)})

    def register(self, patches):
        """Write an ordered synthetic registry."""
        (self.directory / '.patches').write_text('\n'.join(patches) + '\n')
        for name, contents in patches.items():
            (self.directory / name).write_text(contents)

    def test_complete_patch_applies(self):
        self.assertEqual(fork_ci.apply_storage_patch(self.root, self.tree), [])
        self.assertEqual(self.source.read_text(), self.changed)

    def test_prior_patch_context_is_applied_first(self):
        prior = BASE.replace('CreateRunner', 'MakeRunner')
        final = prior.replace('MakeRunner({', 'MakeRunner({base::MayBlock(), ')
        self.register({'prior.patch': patch(BASE, prior),
                       fork_ci.STORAGE_PATCH: patch(prior, final)})
        self.assertEqual(fork_ci.apply_storage_patch(self.root, self.tree), ['prior.patch'])
        self.assertEqual(self.source.read_text(), final)

    def test_additional_target_is_rejected(self):
        self.register({fork_ci.STORAGE_PATCH: patch(BASE, self.changed)
                       + patch('old\n', 'new\n', 'unvalidated.cc')})
        with self.assertRaisesRegex(ValueError, 'multi-file'):
            fork_ci.apply_storage_patch(self.root, self.tree)
        self.assertEqual(self.source.read_text(), BASE)

    def test_missing_registered_patch_is_rejected(self):
        (self.directory / '.patches').write_text(fork_ci.STORAGE_PATCH + '\nmissing.patch\n')
        with self.assertRaisesRegex(ValueError, 'registry and files differ'):
            fork_ci.apply_storage_patch(self.root, self.tree)

    def test_quoted_extra_target_is_rejected(self):
        extra = ('diff --git "a/extra file.cc" "b/extra file.cc"\n'
                 'new file mode 100644\n--- /dev/null\n+++ b/extra file.cc\n'
                 '@@ -0,0 +1 @@\n+unexpected\n')
        self.register({fork_ci.STORAGE_PATCH: patch(BASE, self.changed) + extra})
        with self.assertRaises(ValueError):
            fork_ci.apply_storage_patch(self.root, self.tree)
        self.assertEqual(self.source.read_text(), BASE)

    def test_legacy_extra_delta_is_rejected(self):
        extra = '--- a/extra.cc\n+++ b/extra.cc\n@@ -1 +1 @@\n-old\n+new\n'
        self.register({fork_ci.STORAGE_PATCH: patch(BASE, self.changed) + extra})
        with self.assertRaisesRegex(ValueError, 'unaccounted patch delta'):
            fork_ci.apply_storage_patch(self.root, self.tree)
        self.assertEqual(self.source.read_text(), BASE)

    def test_lost_shutdown_trait_is_rejected(self):
        broken = self.changed.replace('BLOCK_SHUTDOWN', 'SKIP_ON_SHUTDOWN')
        self.register({fork_ci.STORAGE_PATCH: patch(BASE, broken)})
        with self.assertRaisesRegex(ValueError, 'all three task traits'):
            fork_ci.apply_storage_patch(self.root, self.tree)

    def test_rename_into_target_is_rejected(self):
        prior = patch(BASE, self.changed).replace('a/' + fork_ci.STORAGE_FILE,
                                                'a/old_database.cc')
        self.register({'prior.patch': prior,
                       fork_ci.STORAGE_PATCH: patch(BASE, self.changed)})
        with self.assertRaisesRegex(ValueError, 'renamed patch target'):
            fork_ci.apply_storage_patch(self.root, self.tree)

    def test_quoted_predecessor_is_not_silently_skipped(self):
        prior = patch(BASE, BASE.replace('void Configure', 'void Prepare'))
        original = f'diff --git a/{fork_ci.STORAGE_FILE} b/{fork_ci.STORAGE_FILE}'
        quoted = f'diff --git "a/{fork_ci.STORAGE_FILE}" "b/{fork_ci.STORAGE_FILE}"'
        self.register({'prior.patch': prior.replace(original, quoted),
                       fork_ci.STORAGE_PATCH: patch(BASE, self.changed)})
        with self.assertRaises(ValueError):
            fork_ci.apply_storage_patch(self.root, self.tree)
        self.assertEqual(self.source.read_text(), BASE)


class ConsolidatedPasskeyTests(unittest.TestCase):
    """Run PR matrix selection and its source gate with synthetic fork inputs."""

    def verify_contract(self, contract):
        """Resolve PR #5's main comparison and run the selected verification."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            docs = root / 'docs/api/session.md'
            docs.parent.mkdir(parents=True)
            docs.write_text('ses.setWebAuthnHybridHandler(handler)\n'
                            '* `requestType` string\n' + contract)
            for name in ('script/run-webauthn-hybrid-tests.py',
                         'spec/fixtures/api/webauthn-hybrid/creation.cjs'):
                fixture = root / name
                fixture.parent.mkdir(parents=True)
                fixture.touch()
            head, base, merge_base = '1' * 40, '2' * 40, '3' * 40
            event = root / 'event.json'
            event.write_text(json.dumps({
                'repository': {'full_name': fork_ci.REPOSITORY},
                'pull_request': {
                    'number': 5,
                    'head': {'repo': {'full_name': fork_ci.REPOSITORY},
                             'ref': 'experimental/linux-phone-passkey-create-main',
                             'sha': head},
                    'base': {'ref': 'main', 'sha': base},
                },
            }))
            output = root / 'output'
            with (mock.patch.dict(fork_ci.os.environ, {
                    'GITHUB_EVENT_PATH': str(event), 'GITHUB_OUTPUT': str(output)}),
                  mock.patch.object(fork_ci, 'github', return_value={
                      'merge_base_commit': {'sha': merge_base}}) as github,
                  contextlib.redirect_stdout(io.StringIO())):
                fork_ci.matrix()
            github.assert_called_once_with(
                f'repos/{fork_ci.REPOSITORY}/compare/{base}...{head}')
            target, = json.loads(output.read_text().removeprefix('targets='))['include']
            self.assertEqual((target['head'], target['base'], target['merge_base']),
                             (head, base, merge_base))
            with mock.patch('sys.argv', ['fork_ci.py', 'verify', '--source-root',
                                        str(root), '--source-kind', target['kind']]):
                fork_ci.main()

    def test_consolidated_pr_rejects_boolean_contract(self):
        with self.assertRaisesRegex(ValueError, 'Expected void handler contract'):
            self.verify_contract('The handler returns a boolean.\n')

    def test_consolidated_pr_accepts_void_contract(self):
        self.verify_contract('The handler returns no value.\n')


if __name__ == '__main__':
    unittest.main()
