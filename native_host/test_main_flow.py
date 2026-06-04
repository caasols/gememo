#!/usr/bin/env python3
"""Integration tests for the main() capture orchestration in meeting_minutes_host.py.

Drives main() with read_message/send_message/subprocess mocked so the Craft push,
file backup, and snapshot-retry paths are exercised without touching Craft, the
network, or the user's cache.
"""

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as host


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class TestMainCaptureFlow(unittest.TestCase):

    def _run(self, msg, run_results):
        """Run host.main() with read_message→msg and subprocess.run yielding run_results
        (a single _proc or a list consumed per call). Returns the list of sent messages."""
        sent = []
        results = run_results if isinstance(run_results, list) else [run_results]
        it = iter(results)

        def fake_run(*a, **k):
            try:
                return next(it)
            except StopIteration:
                return _proc(0)

        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'), \
                patch.object(host.subprocess, 'run', side_effect=fake_run):
            host.main()
        return sent

    def _capture_msg(self, tmp, **over):
        msg = {
            "transcript": "## Summary\nWe shipped it.",
            "meetingTitle": "Q3 Planning",
            "backupType": "craft",
            "fileBackupEnabled": True,
            "fileBackupType": "markdown",
            "fileBackupPath": tmp,
            "timestamp": "2026-06-01T09:12:00Z",
            "durationMin": 30,
            "attendees": ["Alice"],
        }
        msg.update(over)
        return msg

    def test_empty_transcript_errors(self):
        sent = self._run({"transcript": "   "}, _proc(0))
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("empty", sent[-1]["error"])

    def test_craft_success_writes_backup_and_oks(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertTrue(sent[-1]["title"].endswith("Q3 Planning"))
            self.assertIn("file", sent[-1])
            mds = list(Path(tmp).glob("*.md"))
            self.assertEqual(len(mds), 1)
            content = mds[0].read_text(encoding="utf-8")
            self.assertIn('title: "Q3 Planning"', content)   # frontmatter present
            self.assertIn("duration_min: 30", content)
            self.assertIn("We shipped it.", content)

    def test_craft_failure_no_snapshot_errors_with_backup_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp), _proc(1, stderr="boom"))
            self.assertEqual(sent[-1]["status"], "error")
            self.assertIn("backupPath", sent[-1])
            self.assertIn("Craft is not running", sent[-1]["error"])  # PUSH_EXIT_MESSAGES[1]

    def test_craft_failure_retries_with_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            # A snapshot whose slug matches the meeting label ("q3-planning").
            (Path(tmp) / "20260601-120000-q3-planning-snap.md").write_text(
                "snapshot body", encoding="utf-8")
            sent = self._run(self._capture_msg(tmp), [_proc(1), _proc(0)])  # push fails, retry ok
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertTrue(sent[-1].get("retried"))

    def test_none_backuptype_routes_through_route_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp, backupType="none", fileBackupEnabled=False),
                             _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")

    def test_ping(self):
        sent = self._run({"type": "ping"}, _proc(0))
        self.assertEqual(sent[-1]["status"], "ok")
        self.assertIn("version", sent[-1])

    def test_choose_folder_dispatch(self):
        sent = self._run({"type": "choose_folder"}, _proc(0, stdout="/Users/x/Notes\n"))
        self.assertEqual(sent[-1]["status"], "ok")
        self.assertEqual(sent[-1]["path"], "/Users/x/Notes")

    def test_snapshot_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({
                "type": "snapshot", "transcript": "snapshot body",
                "meetingTitle": "Standup", "timestamp": "2026-06-01T09:00:00Z",
                "fileBackupType": "markdown", "fileBackupPath": tmp,
            }, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(len(list(Path(tmp).glob("*-snap.md"))), 1)

    def test_search_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({"type": "search", "query": "anything", "fileBackupPath": tmp}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["results"], [])

    def test_prior_context_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({"type": "prior_context", "meetingTitle": "Standup",
                              "fileBackupPath": tmp}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["context"], "")

    def test_multi_destination_also_sends_to_apple_notes(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as cache_tmp:
            msg = self._capture_msg(tmp, alsoSend=["apple_notes"])  # primary craft + extra apple_notes
            calls = []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value=msg), \
                    patch.object(host, 'send_message'), \
                    patch.object(host, 'notify'), \
                    patch.object(host, 'push_to_apple_notes', side_effect=lambda t, h: calls.append(t)), \
                    patch.object(host.subprocess, 'run', return_value=_proc(0)):
                host.main()
            self.assertEqual(len(calls), 1)  # the apple_notes extra fired

    def test_retry_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-standup.md"
            bp.write_text("notes", encoding="utf-8")
            sent = self._run({"type": "retry", "title": "Standup", "backupPath": str(bp)}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
