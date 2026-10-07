#!/usr/bin/env python3
"""Regression tests for bounded patch validation without network access."""

import difflib
import json
from pathlib import Path
import re
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


class MatrixTests(unittest.TestCase):
    """Keep shutdown checks on one exact, owned and allowlisted PR head."""

    def setUp(self):
        # pylint: disable-next=consider-using-with
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.event_path = Path(temporary) / 'event.json'
        self.output_path = Path(temporary) / 'output.txt'
        self.event = {
            'repository': {'full_name': fork_ci.REPOSITORY},
            'pull_request': {
                'head': {'repo': {'full_name': fork_ci.REPOSITORY},
                         'ref': 'fix/network-hints-shutdown-main', 'sha': 'a' * 40},
                'base': {'sha': 'b' * 40},
            },
        }
        self.enterContext(mock.patch.dict('os.environ', {
            'GITHUB_EVENT_PATH': str(self.event_path),
            'GITHUB_OUTPUT': str(self.output_path),
        }))
        self.github = self.enterContext(mock.patch.object(fork_ci, 'github'))
        self.github.return_value = {'merge_base_commit': {'sha': 'c' * 40}}

    def resolve(self):
        """Resolve the synthetic event without contacting GitHub."""
        self.event_path.write_text(json.dumps(self.event), encoding='utf-8')
        fork_ci.matrix()

    def test_shutdown_uses_only_its_exact_source_comparison(self):
        self.resolve()
        self.github.assert_called_once_with(
            f'repos/{fork_ci.REPOSITORY}/compare/{"b" * 40}...{"a" * 40}')
        value = self.output_path.read_text(encoding='utf-8').removeprefix('targets=')
        self.assertEqual(json.loads(value), {'include': [{
            'name': 'this-pr', 'head': 'a' * 40, 'base': 'b' * 40,
            'merge_base': 'c' * 40, 'kind': 'ci',
        }]})

    def test_unlisted_branch_prefix_is_rejected(self):
        self.event['pull_request']['head']['ref'] += '-unlisted'
        with self.assertRaises(KeyError):
            self.resolve()
        self.github.assert_not_called()
        self.assertFalse(self.output_path.exists())

    def test_foreign_head_is_rejected(self):
        self.event['pull_request']['head']['repo']['full_name'] = 'other/electron'
        with self.assertRaisesRegex(ValueError, 'own PR heads'):
            self.resolve()
        self.github.assert_not_called()

    def test_foreign_repository_is_rejected(self):
        self.event['repository']['full_name'] = 'other/electron'
        with self.assertRaisesRegex(ValueError, 'own PR heads'):
            self.resolve()
        self.github.assert_not_called()

    def test_nonimmutable_head_is_rejected(self):
        self.event['pull_request']['head']['sha'] = 'main'
        with self.assertRaisesRegex(ValueError, 'complete Git SHA'):
            self.resolve()
        self.github.assert_not_called()

    def test_workflow_and_classifier_allowlists_match(self):
        workflow = (Path(__file__).resolve().parents[1]
                    / '.github/workflows/fork-hybrid-state.yml').read_text(encoding='utf-8')
        allowed = re.search(r"contains\(fromJSON\('([^']+)'\), github\.head_ref\)", workflow)
        self.assertIsNotNone(allowed)
        branches = json.loads(allowed[1])
        self.assertEqual(len(branches), len(set(branches)))
        self.assertEqual(set(branches), set(fork_ci.BRANCH_KINDS))


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


if __name__ == '__main__':
    unittest.main()
