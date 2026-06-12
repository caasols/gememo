#!/usr/bin/env python3
"""Tests for send_to_destinations — the unified extra-destinations fan-out (UXF-11).

Per-row config falls back to the global default when blank, so a row without its
own vault/folder behaves like the legacy 'also send to' checkbox. Best-effort per
entry: one failing row never raises or stops the others, and empty/None input is a
no-op. Push/AppleScript/subprocess boundaries are mocked so nothing touches Craft,
Apple Notes, or the network.
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

    def test_one_failing_row_does_not_stop_the_others(self):
        # A row that raises is swallowed (best-effort) — the next row still runs.
        with patch.object(host, 'notify'), \
                patch.object(host, 'push_to_apple_notes',
                             side_effect=[RuntimeError('boom'), None]) as pan:
            host.send_to_destinations(
                [{'type': 'apple_notes'}, {'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
            self.assertEqual(pan.call_count, 2)


if __name__ == '__main__':
    unittest.main()
