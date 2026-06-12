#!/usr/bin/env python3
"""Tests for the per-row "Additional destinations" repeater dispatch (UXF-11).

send_to_configured_destinations() routes a captured note to a list of destination
*instances*, each carrying its OWN config (vault path / craft folder id), independent
of the legacy primary + also-send singletons. It is best-effort per entry: one
failing destination must never raise or stop the others, and empty/None input is a
no-op. The push/AppleScript/subprocess boundaries are mocked so nothing touches
Craft, Apple Notes, or the network.
"""

import datetime as _dt
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, call

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as host


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


DT = _dt.datetime(2026, 6, 1, 9, 12)
CRAFT_MD = "## Summary\nWe shipped it.\n"
TITLE = "Q3 Planning"
LABEL = "2026-06-01 Q3 Planning"


class TestSendToConfiguredDestinations(unittest.TestCase):

    def test_empty_none_and_blank_are_noops(self):
        # None / [] / missing must never call any boundary or raise.
        with patch.object(host, 'push_to_apple_notes') as pan, \
                patch.object(host.subprocess, 'run') as run:
            host.send_to_configured_destinations(None, CRAFT_MD, TITLE, DT, LABEL)
            host.send_to_configured_destinations([], CRAFT_MD, TITLE, DT, LABEL)
        pan.assert_not_called()
        run.assert_not_called()

    def test_apple_notes_dispatch(self):
        with patch.object(host, 'push_to_apple_notes') as pan, \
                patch.object(host, 'notify'), \
                patch.object(host.subprocess, 'run') as run:
            host.send_to_configured_destinations(
                [{'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
        pan.assert_called_once()
        self.assertEqual(pan.call_args[0][0], TITLE)
        run.assert_not_called()

    def test_obsidian_writes_to_its_own_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            host.send_to_configured_destinations(
                [{'type': 'obsidian', 'vaultPath': tmp}], CRAFT_MD, TITLE, DT, LABEL)
            mds = list(Path(tmp).glob('*.md'))
            self.assertEqual(len(mds), 1)
            name = mds[0].name
            # <YYYYMMDD-HHMM>-<slug>.md, slug derived from the label.
            self.assertTrue(name.startswith('20260601-0912-'))
            self.assertIn('q3-planning', name)
            self.assertIn('We shipped it.', mds[0].read_text(encoding='utf-8'))

    def test_two_obsidian_vaults_both_written(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            host.send_to_configured_destinations(
                [{'type': 'obsidian', 'vaultPath': a},
                 {'type': 'obsidian', 'vaultPath': b}],
                CRAFT_MD, TITLE, DT, LABEL)
            self.assertEqual(len(list(Path(a).glob('*.md'))), 1)
            self.assertEqual(len(list(Path(b).glob('*.md'))), 1)

    def test_obsidian_without_vault_skipped(self):
        # No vaultPath ⇒ nothing written, no crash.
        with patch.object(host, 'push_to_apple_notes') as pan, \
                patch.object(host.subprocess, 'run') as run:
            host.send_to_configured_destinations(
                [{'type': 'obsidian'}, {'type': 'obsidian', 'vaultPath': ''}],
                CRAFT_MD, TITLE, DT, LABEL)
        pan.assert_not_called()
        run.assert_not_called()

    def test_craft_passes_its_own_folder_id_to_subprocess(self):
        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host.subprocess, 'run', return_value=_proc(0)) as run:
            host.send_to_configured_destinations(
                [{'type': 'craft', 'folderId': 'folder-xyz'}],
                CRAFT_MD, TITLE, DT, LABEL)
        run.assert_called_once()
        cmd = run.call_args[0][0]
        self.assertIn('--folder-id', cmd)
        self.assertEqual(cmd[cmd.index('--folder-id') + 1], 'folder-xyz')

    def test_craft_without_folder_id_omits_flag(self):
        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host.subprocess, 'run', return_value=_proc(0)) as run:
            host.send_to_configured_destinations(
                [{'type': 'craft'}], CRAFT_MD, TITLE, DT, LABEL)
        cmd = run.call_args[0][0]
        self.assertNotIn('--folder-id', cmd)

    def test_one_failing_entry_does_not_stop_the_others(self):
        # First obsidian row raises (bad path under a file); the apple_notes row
        # after it must still be dispatched — best-effort isolation per entry.
        with tempfile.TemporaryDirectory() as good_vault:
            with patch.object(host, 'push_to_apple_notes') as pan, \
                    patch.object(host, 'notify'):
                host.send_to_configured_destinations(
                    [{'type': 'obsidian', 'vaultPath': '/nonexistent\0/bad'},
                     {'type': 'apple_notes'},
                     {'type': 'obsidian', 'vaultPath': good_vault}],
                    CRAFT_MD, TITLE, DT, LABEL)
            pan.assert_called_once()
            self.assertEqual(len(list(Path(good_vault).glob('*.md'))), 1)

    def test_unknown_type_is_ignored(self):
        with patch.object(host, 'push_to_apple_notes') as pan, \
                patch.object(host.subprocess, 'run') as run:
            host.send_to_configured_destinations(
                [{'type': 'slack'}, {'type': 'webhook'}], CRAFT_MD, TITLE, DT, LABEL)
        pan.assert_not_called()
        run.assert_not_called()

    def test_non_dict_entry_skipped_valid_row_still_dispatched(self):
        # A malformed (non-dict) row is skipped (host 982-983) without stopping
        # a following valid apple_notes row.
        with patch.object(host, 'push_to_apple_notes') as pan, \
                patch.object(host, 'notify'), \
                patch.object(host.subprocess, 'run') as run:
            host.send_to_configured_destinations(
                ["garbage", None, 42, {'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
        pan.assert_called_once()  # the valid row still fired
        run.assert_not_called()


class TestSendToDestinations(unittest.TestCase):
    """Unified fan-out: per-row config falls back to the global default when blank."""

    def test_apple_notes_dispatch(self):
        with patch.object(host, 'push_to_apple_notes') as pan, patch.object(host, 'notify'):
            host.send_to_destinations([{'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
            pan.assert_called_once()

    def test_obsidian_uses_row_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': tmp}], CRAFT_MD, TITLE, DT, LABEL,
                obsidian_vault_path='/global/should/not/be/used')
            self.assertEqual(len(list(Path(tmp).glob('*.md'))), 1)

    def test_obsidian_blank_falls_back_to_global_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': ''}], CRAFT_MD, TITLE, DT, LABEL,
                obsidian_vault_path=tmp)
            self.assertEqual(len(list(Path(tmp).glob('*.md'))), 1)

    def test_obsidian_no_vault_anywhere_skipped(self):
        with patch.object(host.subprocess, 'run') as run:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': ''}], CRAFT_MD, TITLE, DT, LABEL,
                obsidian_vault_path='')
            run.assert_not_called()

    def test_craft_uses_row_folder(self):
        with patch.object(host.subprocess, 'run') as run:
            host.send_to_destinations(
                [{'type': 'craft', 'folderId': 'ROW'}], CRAFT_MD, TITLE, DT, LABEL,
                craft_folder_id='GLOBAL')
            self.assertIn('ROW', run.call_args[0][0])
            self.assertNotIn('GLOBAL', run.call_args[0][0])

    def test_craft_blank_falls_back_to_global_folder(self):
        with patch.object(host.subprocess, 'run') as run:
            host.send_to_destinations(
                [{'type': 'craft', 'folderId': ''}], CRAFT_MD, TITLE, DT, LABEL,
                craft_folder_id='GLOBAL')
            self.assertIn('GLOBAL', run.call_args[0][0])

    def test_craft_no_folder_anywhere_omits_flag(self):
        with patch.object(host.subprocess, 'run') as run:
            host.send_to_destinations(
                [{'type': 'craft', 'folderId': ''}], CRAFT_MD, TITLE, DT, LABEL,
                craft_folder_id='')
            self.assertNotIn('--folder-id', run.call_args[0][0])

    def test_unknown_and_non_dict_skipped(self):
        with patch.object(host, 'push_to_apple_notes') as pan, patch.object(host, 'notify'):
            host.send_to_destinations(
                ['nope', {'type': 'slack'}, {'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
            pan.assert_called_once()

    def test_empty_and_none_are_noops(self):
        with patch.object(host.subprocess, 'run') as run, patch.object(host, 'push_to_apple_notes') as pan:
            host.send_to_destinations(None, CRAFT_MD, TITLE, DT, LABEL)
            host.send_to_destinations([], CRAFT_MD, TITLE, DT, LABEL)
            run.assert_not_called()
            pan.assert_not_called()


if __name__ == '__main__':
    unittest.main()
