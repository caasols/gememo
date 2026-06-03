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
from meeting_minutes_host import read_message, send_message, choose_retry_file, retry_title_fallback


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


if __name__ == '__main__':
    unittest.main()
