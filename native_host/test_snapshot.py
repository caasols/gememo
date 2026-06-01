#!/usr/bin/env python3
"""Unit tests for prune_snapshots and handle_snapshot in meeting_minutes_host.py."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add native_host directory to path so we can import from meeting_minutes_host
sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import prune_snapshots, handle_snapshot


class TestPruneSnapshots(unittest.TestCase):

    def test_prune_keeps_last_3(self):
        """Creates 4 snapshot files with different mtimes; after pruning, only 3 remain."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            slug = "standup"
            files = []
            for i in range(4):
                f = tmp / f"2026052{i}-100000-{slug}-snap.md"
                f.write_text(f"snapshot {i}", encoding="utf-8")
                mtime = 1000000 + i  # distinct mtimes: 0 is oldest
                os.utime(f, (mtime, mtime))
                files.append(f)

            prune_snapshots(tmp, slug, ".md", keep=3)

            remaining = sorted(tmp.glob(f"*-{slug}-snap.md"), key=lambda p: p.stat().st_mtime)
            self.assertEqual(len(remaining), 3)
            self.assertFalse(files[0].exists(), "Oldest snapshot should have been pruned")
            self.assertTrue(files[1].exists())
            self.assertTrue(files[2].exists())
            self.assertTrue(files[3].exists())

    def test_prune_noop_when_3_or_fewer(self):
        """Pruning with <= keep files leaves everything untouched."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            slug = "retro"
            for i in range(3):
                (tmp / f"20260529-10000{i}-{slug}-snap.md").write_text(f"snap {i}", encoding="utf-8")
            prune_snapshots(tmp, slug, ".md", keep=3)
            self.assertEqual(len(list(tmp.glob(f"*-{slug}-snap.md"))), 3)

    def test_prune_does_not_affect_final_backup(self):
        """Final backup file (no -snap suffix) is never deleted by pruning."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            slug = "standup"
            for i in range(4):
                f = tmp / f"2026052{i}-100000-{slug}-snap.md"
                f.write_text(f"snap {i}", encoding="utf-8")
                os.utime(f, (1000000 + i, 1000000 + i))
            final = tmp / f"20260529-standup.md"
            final.write_text("final backup", encoding="utf-8")

            prune_snapshots(tmp, slug, ".md", keep=3)

            self.assertTrue(final.exists(), "Final backup must not be deleted")
            self.assertEqual(len(list(tmp.glob(f"*-{slug}-snap.md"))), 3)

    def test_prune_noop_on_empty_dir(self):
        """prune_snapshots on an empty directory raises no exception."""
        with tempfile.TemporaryDirectory() as tmp:
            try:
                prune_snapshots(Path(tmp), "nonexistent", ".md", keep=3)
            except Exception as exc:
                self.fail(f"prune_snapshots raised unexpectedly: {exc}")


class TestHandleSnapshot(unittest.TestCase):

    def _msg(self, tmp_path: str, transcript: str = "snapshot content",
             title: str = "Standup", ts: str = "2026-05-29T10:00:00Z") -> dict:
        return {
            "transcript": transcript,
            "meetingTitle": title,
            "timestamp": ts,
            "fileBackupType": "markdown",
            "fileBackupPath": tmp_path,
        }

    def test_writes_snapshot_file(self):
        """handle_snapshot writes exactly one -snap.md file with frontmatter and transcript content."""
        with tempfile.TemporaryDirectory() as tmp:
            handle_snapshot(self._msg(tmp, transcript="hello snapshot"))
            snaps = list(Path(tmp).glob("*-snap.md"))
            self.assertEqual(len(snaps), 1)
            content = snaps[0].read_text(encoding="utf-8")
            self.assertIn("---\n", content, "Should contain YAML frontmatter")
            self.assertIn("snapshot: true", content, "Should mark as snapshot")
            self.assertIn("hello snapshot", content, "Should contain transcript")

    def test_snapshot_filename_contains_timestamp_and_slug(self):
        """Snapshot filename includes date, time, and meeting slug."""
        with tempfile.TemporaryDirectory() as tmp:
            handle_snapshot(self._msg(tmp, title="Daily Standup", ts="2026-05-29T09:56:00Z"))
            snaps = list(Path(tmp).glob("*-snap.md"))
            self.assertEqual(len(snaps), 1)
            name = snaps[0].name
            self.assertTrue(name.startswith("20260529-"), f"Expected date prefix, got: {name}")
            self.assertIn("daily-standup", name, f"Expected slug in name, got: {name}")
            self.assertTrue(name.endswith("-snap.md"))

    def test_empty_transcript_skips_write(self):
        """handle_snapshot with whitespace-only transcript writes no file."""
        with tempfile.TemporaryDirectory() as tmp:
            handle_snapshot(self._msg(tmp, transcript="   "))
            self.assertEqual(list(Path(tmp).glob("*-snap.md")), [])

    def test_prunes_after_4_snapshots(self):
        """Calling handle_snapshot 4 times leaves only 3 -snap.md files."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = str(tmp)
            for i in range(4):
                msg = self._msg(tmp_path, ts=f"2026-05-29T10:0{i}:00Z")
                handle_snapshot(msg)
                # Set an explicit mtime so the sort is deterministic regardless of FS resolution
                snaps = sorted(Path(tmp_path).glob("*-snap.md"), key=lambda p: p.name)
                for j, f in enumerate(snaps):
                    os.utime(f, (1_000_000 + j, 1_000_000 + j))
            self.assertEqual(len(list(Path(tmp_path).glob("*-snap.md"))), 3)


if __name__ == "__main__":
    unittest.main()
