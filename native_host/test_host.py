#!/usr/bin/env python3
"""Unit tests for the native messaging wire format in meeting_minutes_host.py.

Tests read_message() and send_message() using io.BytesIO to simulate
the stdin/stdout byte streams without requiring a real Chrome connection.
"""

from __future__ import annotations

import io
import json
import os
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import types
from unittest.mock import patch

import meeting_minutes_host as host
from meeting_minutes_host import read_message, send_message, choose_retry_file, retry_title_fallback, search_notes, resolve_extras


class _BytesStream:
    """Wraps io.BytesIO as .buffer for stdin/stdout compatibility."""
    def __init__(self, data: bytes = b''):
        self.buffer = io.BytesIO(data)


def _encode_message(data: dict) -> bytes:
    """Build a valid wire-format message: 4-byte LE uint32 length + UTF-8 JSON."""
    payload = json.dumps(data).encode('utf-8')
    return struct.pack('<I', len(payload)) + payload


class TestReadMessage(unittest.TestCase):

    def _read_with_stdin(self, data: bytes):
        """Call read_message() with sys.stdin replaced by a BytesStream."""
        original = sys.stdin
        sys.stdin = _BytesStream(data)
        try:
            return read_message()
        finally:
            sys.stdin = original

    def test_parses_payload(self):
        """read_message correctly parses a 4-byte LE length + UTF-8 JSON payload."""
        msg = {'type': 'ping'}
        result = self._read_with_stdin(_encode_message(msg))
        self.assertEqual(result, msg)

    def test_returns_none_on_empty_stream(self):
        """read_message returns None when stdin is empty (EOF before 4 bytes)."""
        result = self._read_with_stdin(b'')
        self.assertIsNone(result)


class TestSendMessage(unittest.TestCase):

    def _capture_send(self, data: dict) -> bytes:
        """Call send_message() and return the raw bytes written to stdout."""
        stream = _BytesStream()
        original = sys.stdout
        sys.stdout = stream
        try:
            send_message(data)
        finally:
            sys.stdout = original
        return stream.buffer.getvalue()

    def test_writes_correct_wire_format(self):
        """send_message writes a 4-byte LE length prefix followed by UTF-8 JSON."""
        msg = {'status': 'ok', 'home': '/home/user'}
        raw = self._capture_send(msg)

        # First 4 bytes: LE uint32 length of the JSON payload
        length = struct.unpack('<I', raw[:4])[0]
        self.assertEqual(length, len(raw) - 4)

        # Remaining bytes: valid UTF-8 JSON matching the original dict
        recovered = json.loads(raw[4:].decode('utf-8'))
        self.assertEqual(recovered, msg)

    def test_round_trip(self):
        """send_message output can be parsed back by read_message unchanged."""
        original_msg = {
            'type': 'response',
            'status': 'ok',
            'title': '20260529 09:56 Standup',
        }

        # Step 1: capture send_message output into a BytesStream
        out_stream = _BytesStream()
        original_stdout = sys.stdout
        sys.stdout = out_stream
        try:
            send_message(original_msg)
        finally:
            sys.stdout = original_stdout

        # Step 2: feed captured bytes back into read_message via a BytesStream
        raw = out_stream.buffer.getvalue()
        in_stream = _BytesStream(raw)
        original_stdin = sys.stdin
        sys.stdin = in_stream
        try:
            recovered = read_message()
        finally:
            sys.stdin = original_stdin

        self.assertEqual(recovered, original_msg)


class TestChooseRetryFile(unittest.TestCase):

    def test_prefers_fresh_cache_file(self):
        """Returns cache file when it exists and is under 2 hours old."""
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            (cache_dir / "Sprint Planning.md").write_text("notes", encoding="utf-8")
            now = time.time()
            result, source = choose_retry_file(
                "Sprint Planning", "/backup/snap.md",
                now=now, cache_dir=cache_dir,
            )
            self.assertIsNotNone(result)
            self.assertEqual(source, "cache")
            self.assertTrue(str(result).endswith("Sprint Planning.md"))

    def test_falls_back_to_backup_when_cache_stale(self):
        """Returns backup file when cache exists but is older than 2 hours."""
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            cache_file = cache_dir / "Sprint Planning.md"
            cache_file.write_text("old notes", encoding="utf-8")
            old_mtime = time.time() - 3 * 3600
            os.utime(cache_file, (old_mtime, old_mtime))

            with tempfile.TemporaryDirectory() as btmp:
                backup = Path(btmp) / "snap.md"
                backup.write_text("snapshot", encoding="utf-8")
                result, source = choose_retry_file(
                    "Sprint Planning", str(backup),
                    now=time.time(), cache_dir=cache_dir,
                )
                self.assertEqual(source, "backup")
                self.assertEqual(result, backup)

    def test_returns_none_when_nothing_available(self):
        """Returns (None, '') when cache is stale and backup path doesn't exist."""
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)  # empty
            result, source = choose_retry_file(
                "Sprint Planning", "/nonexistent/snap.md",
                now=time.time(), cache_dir=cache_dir,
            )
            self.assertIsNone(result)
            self.assertEqual(source, "")


class TestRetryTitleFallback(unittest.TestCase):
    """retry_title_fallback — readable title for retries from untitled meetings (BUG-6)."""

    def test_returns_title_when_present(self):
        self.assertEqual(
            retry_title_fallback("Sprint Planning", Path("/b/x-snap.md")),
            "Sprint Planning",
        )

    def test_derives_from_snapshot_filename(self):
        self.assertEqual(
            retry_title_fallback("", Path("/b/20260604-143000-team-sync-snap.md")),
            "team sync",
        )

    def test_derives_from_final_filename(self):
        self.assertEqual(
            retry_title_fallback("", Path("/b/20260604-weekly-review.md")),
            "weekly review",
        )

    def test_unparseable_gives_default(self):
        self.assertEqual(
            retry_title_fallback("", Path("/b/20260604-.md")),
            "Recovered meeting note",
        )


class TestSearchNotes(unittest.TestCase):
    """search_notes — local full-text search over backup .md files (P9-E)."""

    def _make(self, d: Path, name: str, body: str) -> None:
        (d / name).write_text(body, encoding="utf-8")

    def test_empty_query_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(search_notes("", tmp), [])
            self.assertEqual(search_notes("   ", tmp), [])

    def test_missing_dir_returns_empty(self):
        self.assertEqual(search_notes("anything", "/no/such/dir"), [])

    def test_matches_content_with_title_date_snippet(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._make(d, "20260601-q3-planning.md",
                       '---\ndate: 2026-06-01\ntitle: "Q3 Planning"\n---\n'
                       '## Summary\nWe discussed the Kafka migration in detail.')
            res = search_notes("kafka", tmp)
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]["title"], "Q3 Planning")
            self.assertEqual(res[0]["date"], "2026-06-01")
            self.assertIn("Kafka", res[0]["snippet"])

    def test_case_insensitive(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._make(d, "20260601-x.md", "Discussed BUDGET allocation.")
            self.assertEqual(len(search_notes("budget", tmp)), 1)

    def test_excludes_snapshot_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._make(d, "20260601-x.md", "final note mentions widget")
            self._make(d, "20260601-120000-x-snap.md", "snapshot mentions widget")
            res = search_notes("widget", tmp)
            self.assertEqual(len(res), 1)
            self.assertTrue(res[0]["file"].endswith("20260601-x.md"))

    def test_no_match_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(Path(tmp), "20260601-x.md", "nothing relevant here")
            self.assertEqual(search_notes("zebra", tmp), [])

    def test_limit_respected(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for i in range(5):
                self._make(d, f"2026060{i}-m{i}.md", "common keyword here")
            self.assertEqual(len(search_notes("keyword", tmp, limit=3)), 3)


class TestHandleRetry(unittest.TestCase):
    """handle_retry — re-push a failed note (subprocess mocked)."""

    def _run(self, msg, returncode=0, stderr=''):
        sent = []
        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'), \
                patch.object(host.subprocess, 'run',
                             return_value=types.SimpleNamespace(returncode=returncode, stdout='', stderr=stderr)):
            host.handle_retry(msg)
        return sent

    def test_no_title_or_backup_errors(self):
        sent = self._run({"title": "", "backupPath": ""})
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("No title or backup path", sent[-1]["error"])

    def test_success_with_backup_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-daily-standup.md"
            bp.write_text("notes", encoding="utf-8")
            sent = self._run({"title": "Daily Standup", "backupPath": str(bp)}, returncode=0)
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["title"], "Daily Standup")

    def test_empty_title_uses_filename_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-weekly-review.md"
            bp.write_text("notes", encoding="utf-8")
            sent = self._run({"title": "", "backupPath": str(bp)}, returncode=0)
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["title"], "weekly review")

    def test_missing_file_errors(self):
        sent = self._run({"title": "X", "backupPath": "/nonexistent/x.md"}, returncode=0)
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("No recoverable file", sent[-1]["error"])

    def test_push_failure_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-x.md"
            bp.write_text("n", encoding="utf-8")
            sent = self._run({"title": "X", "backupPath": str(bp)}, returncode=1)
            self.assertEqual(sent[-1]["status"], "error")

    def test_subprocess_exception_sends_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-x.md"
            bp.write_text("n", encoding="utf-8")
            sent = []
            with patch.object(host, 'CACHE_DIR', Path(tmp)), \
                    patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                    patch.object(host, 'notify'), \
                    patch.object(host.subprocess, 'run', side_effect=RuntimeError('boom')):
                host.handle_retry({"title": "X", "backupPath": str(bp)})
            self.assertEqual(sent[-1]["status"], "error")
            self.assertIn("boom", sent[-1]["error"])


class TestSendToExtras(unittest.TestCase):
    """send_to_extras — best-effort secondary outputs (P9-X)."""

    def _dt(self):
        from datetime import datetime
        return datetime(2026, 6, 1, 9, 0)

    def test_obsidian_extra_writes_vault_file(self):
        with tempfile.TemporaryDirectory() as vault:
            host.send_to_extras(['obsidian'], '## Summary\nx', 'T', self._dt(), 'Standup',
                                obsidian_vault_path=vault)
            self.assertEqual(len(list(Path(vault).glob('*.md'))), 1)

    def test_apple_notes_extra_calls_push(self):
        calls = []
        with patch.object(host, 'push_to_apple_notes', side_effect=lambda t, h: calls.append(t)), \
                patch.object(host, 'notify'):
            host.send_to_extras(['apple_notes'], '## Summary\nx', 'T', self._dt(), 'T')
        self.assertEqual(len(calls), 1)

    def test_craft_extra_runs_push_subprocess(self):
        calls = []
        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host.subprocess, 'run', side_effect=lambda cmd, **k: calls.append(cmd)):
            host.send_to_extras(['craft'], '## Summary\nx', 'My Note', self._dt(), 'My Note',
                                craft_folder_id='folder-9')
        self.assertEqual(len(calls), 1)
        self.assertIn('--folder-id', calls[0])

    def test_failing_extra_is_swallowed(self):
        with patch.object(host, 'push_to_apple_notes', side_effect=RuntimeError('boom')), \
                patch.object(host, 'notify'):
            host.send_to_extras(['apple_notes'], 'x', 'T', self._dt(), 'T')  # must not raise

    def test_obsidian_extra_without_vault_writes_nothing(self):
        # obsidian extra with no vault path is a no-op (not an error)
        host.send_to_extras(['obsidian'], 'x', 'T', self._dt(), 'T', obsidian_vault_path='')

    def test_unknown_extra_ignored(self):
        host.send_to_extras(['bogus'], 'x', 'T', self._dt(), 'T')  # must not raise


class TestResolveExtras(unittest.TestCase):
    """resolve_extras — secondary output destinations for multi-destination (P9-X)."""

    def test_excludes_primary_and_dedupes(self):
        self.assertEqual(resolve_extras('craft', ['apple_notes', 'obsidian']), ['apple_notes', 'obsidian'])
        self.assertEqual(resolve_extras('craft', ['craft', 'apple_notes']), ['apple_notes'])
        self.assertEqual(resolve_extras('craft', ['apple_notes', 'apple_notes']), ['apple_notes'])

    def test_excludes_none_and_empty(self):
        self.assertEqual(resolve_extras('craft', ['none', '', 'obsidian']), ['obsidian'])

    def test_empty_inputs(self):
        self.assertEqual(resolve_extras('craft', None), [])
        self.assertEqual(resolve_extras('apple_notes', ['apple_notes']), [])


if __name__ == '__main__':
    unittest.main()
