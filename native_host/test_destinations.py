#!/usr/bin/env python3
"""Tests for send_to_destinations — the unified extra-destinations fan-out (UXF-11).

Per-row config falls back to the global default when blank, so a row without its
own vault/folder behaves like the legacy 'also send to' checkbox. Best-effort per
entry: one failing row never raises or stops the others, and empty/None input is a
no-op. Push/AppleScript/subprocess boundaries are mocked so nothing touches Craft,
Apple Notes, or the network.
"""

import datetime as _dt
import json
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

    def setUp(self):
        # The craft branch writes a temp note into CACHE_DIR before the (mocked)
        # subprocess.run, so redirect CACHE_DIR to a throwaway dir — otherwise the
        # craft tests dump "Q3 Planning.md" into the user's real ~/.cache/mm2c.
        self._cache = tempfile.TemporaryDirectory()
        self._cache_patch = patch.object(host, 'CACHE_DIR', Path(self._cache.name))
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)
        self.addCleanup(self._cache.cleanup)

    def test_apple_notes_dispatch(self):
        with patch.object(host, 'push_to_apple_notes') as pan, patch.object(host, 'notify'):
            host.send_to_destinations([{'type': 'apple_notes'}], CRAFT_MD, TITLE, DT, LABEL)
            pan.assert_called_once()

    def test_google_docs_dispatch(self):
        with patch.object(host.gdocs, 'create_doc', return_value={'ok': True}) as gd, \
                patch.object(host, 'notify') as note:
            host.send_to_destinations([{'type': 'google_docs'}], CRAFT_MD, TITLE, DT, LABEL)
            gd.assert_called_once_with(TITLE, CRAFT_MD)
            note.assert_called_once()

    def test_google_docs_not_connected_skips_quietly(self):
        with patch.object(host.gdocs, 'create_doc', return_value={'ok': False, 'error': 'not_connected'}), \
                patch.object(host, 'notify') as note:
            host.send_to_destinations([{'type': 'google_docs'}], CRAFT_MD, TITLE, DT, LABEL)
            note.assert_not_called()  # best-effort — no notification on failure

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

    def test_obsidian_blank_auto_detects_vault(self):
        # The user's case: Craft primary, Obsidian an additional row with a blank
        # vault. Row + global both blank → fall back to the vault detected from
        # Obsidian's own config, fulfilling the "uses your vault if blank" promise.
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(host, '_detect_obsidian_vault', return_value=tmp), \
                patch.object(host, 'notify') as note:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': ''}], CRAFT_MD, TITLE, DT, LABEL,
                obsidian_vault_path='')
            self.assertEqual(len(list(Path(tmp).glob('*.md'))), 1)
            note.assert_called_once()  # obsidian now notifies on success, like the other rows

    def test_obsidian_row_vault_beats_autodetect(self):
        with tempfile.TemporaryDirectory() as row_vault, \
                tempfile.TemporaryDirectory() as detected, \
                patch.object(host, '_detect_obsidian_vault', return_value=detected), \
                patch.object(host, 'notify'):
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': row_vault}], CRAFT_MD, TITLE, DT, LABEL)
            self.assertEqual(len(list(Path(row_vault).glob('*.md'))), 1)
            self.assertEqual(len(list(Path(detected).glob('*.md'))), 0)

    def test_obsidian_no_vault_anywhere_skipped(self):
        # Blank row + blank global + nothing detectable → no note written, no raise.
        with patch.object(host, '_detect_obsidian_vault', return_value=''), \
                patch.object(host, '_write_obsidian_note') as w:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': ''}], CRAFT_MD, TITLE, DT, LABEL,
                obsidian_vault_path='')
            w.assert_not_called()

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

    def test_obsidian_extra_includes_cal_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            host.send_to_destinations(
                [{'type': 'obsidian', 'vaultPath': tmp}], CRAFT_MD, TITLE, DT, LABEL,
                cal_fields={'organizer': 'https://example.com/evt'})
            md = next(Path(tmp).glob('*.md')).read_text(encoding='utf-8')
            self.assertIn('organizer', md)
            self.assertIn('https://example.com/evt', md)


class TestSelectObsidianVault(unittest.TestCase):
    """Pure selection over a parsed obsidian.json dict."""

    def test_prefers_open_vault(self):
        cfg = {'vaults': {
            'a': {'path': '/one', 'ts': 100, 'open': False},
            'b': {'path': '/two', 'ts': 50, 'open': True},
        }}
        self.assertEqual(host._select_obsidian_vault(cfg), '/two')

    def test_falls_back_to_most_recent_when_none_open(self):
        cfg = {'vaults': {
            'a': {'path': '/old', 'ts': 100},
            'b': {'path': '/new', 'ts': 999},
        }}
        self.assertEqual(host._select_obsidian_vault(cfg), '/new')

    def test_empty_or_malformed_returns_blank(self):
        self.assertEqual(host._select_obsidian_vault({}), '')
        self.assertEqual(host._select_obsidian_vault({'vaults': {}}), '')
        self.assertEqual(host._select_obsidian_vault({'vaults': 'nope'}), '')
        self.assertEqual(host._select_obsidian_vault(None), '')
        self.assertEqual(host._select_obsidian_vault({'vaults': {'a': {'ts': 1}}}), '')  # no path


class TestDetectObsidianVault(unittest.TestCase):
    """Reading the on-disk obsidian.json (best-effort)."""

    def test_reads_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfgp = Path(tmp) / 'obsidian.json'
            cfgp.write_text(json.dumps(
                {'vaults': {'a': {'path': '/v', 'ts': 1, 'open': True}}}), encoding='utf-8')
            self.assertEqual(host._detect_obsidian_vault(cfgp), '/v')

    def test_missing_file_returns_blank(self):
        self.assertEqual(host._detect_obsidian_vault(Path('/no/such/obsidian.json')), '')


class TestObsidianFilename(unittest.TestCase):
    """Obsidian uses the filename as the note title, so it must be readable
    (Craft-style), not a lowercased hyphen-slug."""

    DTT = _dt.datetime(2026, 6, 16, 11, 29)

    def test_matches_craft_readable_format(self):
        self.assertEqual(
            host._obsidian_filename('Trip Advisor Migration Discussion', self.DTT),
            '20260616 11:29 Trip Advisor Migration Discussion.md')

    def test_strips_filesystem_illegal_chars(self):
        # The colon in the *time* is kept; colons/slashes/etc inside the title are dropped.
        self.assertEqual(
            host._obsidian_filename('Q3/Q4: Planning *draft*', self.DTT),
            '20260616 11:29 Q3Q4 Planning draft.md')

    def test_collapses_whitespace_and_caps_length(self):
        self.assertEqual(host._obsidian_filename('A     B', self.DTT), '20260616 11:29 A B.md')
        clean = host._obsidian_filename('x' * 200, self.DTT)[len('20260616 11:29 '):-len('.md')]
        self.assertLessEqual(len(clean), 80)

    def test_long_title_trims_at_word_boundary(self):
        # 93 chars of whole words → must trim to <=80 WITHOUT leaving a word fragment.
        title = ('alpha bravo charlie delta echo foxtrot golf hotel india '
                 'juliett kilo lima mike november oscar')
        body = host._obsidian_filename(title, self.DTT)[len('20260616 11:29 '):-len('.md')]
        self.assertLessEqual(len(body), 80)
        self.assertFalse(body.endswith(' '))
        # every token in the result is a whole word from the source (no mid-word cut)
        self.assertTrue(set(body.split()).issubset(set(title.split())))

    def test_blank_or_symbol_only_label_falls_back_to_timestamp(self):
        self.assertEqual(host._obsidian_filename('   ', self.DTT), '20260616 11:29.md')
        self.assertEqual(host._obsidian_filename('!!!', self.DTT), '20260616 11:29.md')

    def test_write_obsidian_note_uses_readable_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            host._write_obsidian_note(tmp, 'Trip Advisor Migration Discussion', self.DTT, '## Summary\nx\n')
            self.assertEqual(
                [p.name for p in Path(tmp).glob('*.md')],
                ['20260616 11:29 Trip Advisor Migration Discussion.md'])


class TestFileSlug(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(host._file_slug('Q3 Planning'), 'q3-planning')

    def test_strips_non_ascii_word_chars_and_caps_50(self):
        self.assertEqual(host._file_slug('Café / Q3!! Review'), 'caf--q3-review')
        self.assertEqual(len(host._file_slug('x' * 80)), 50)


if __name__ == '__main__':
    unittest.main()
