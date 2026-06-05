#!/usr/bin/env python3
"""Tests for backup-folder auto-cleanup (UXF-13) in meeting_minutes_host.py.

Retention-prunes the backup folder via two independent rules: snapshots
(*-snap.md/.txt) and final notes (other .md/.txt, incl *-RECOVERED.md). A file
is deleted only when its rule is enabled AND its mtime is older than the rule's
retention days. .ics files are never touched. Both rules off ⇒ no-op. The host
call is throttled to once/24h via a stamp file.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import cleanup_backups

# A fixed "now" so tests are deterministic regardless of wall clock.
NOW = 1_700_000_000.0
DAY = 86400


def _write(folder, name, age_days, now=NOW):
    """Create a file under `folder` aged `age_days` days (by mtime)."""
    p = Path(folder) / name
    p.write_text("x", encoding="utf-8")
    age = age_days * DAY
    os.utime(p, (now - age, now - age))
    return p


class CleanupBackupsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self._tmp.name)
        # Each test uses an isolated, non-existent stamp path so throttling is
        # opt-in and never collides with the real ~/.cache stamp.
        self.stamp = self.folder / "stamp"

    def tearDown(self):
        self._tmp.cleanup()

    def _cfg(self, snap_on=False, snap_days=30, fin_on=False, fin_days=30):
        return {
            'snapshots': {'enabled': snap_on, 'days': snap_days},
            'finalNotes': {'enabled': fin_on, 'days': fin_days},
        }

    def test_snapshots_rule_deletes_old_snaps_keeps_recent_and_finals(self):
        old_snap = _write(self.folder, "20230101-meeting-snap.md", 60)
        recent_snap = _write(self.folder, "20230601-meeting-snap.md", 5)
        final = _write(self.folder, "report.md", 90)
        deleted = cleanup_backups(
            self.folder, self._cfg(snap_on=True, snap_days=30),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [old_snap])
        self.assertFalse(old_snap.exists())
        self.assertTrue(recent_snap.exists())
        self.assertTrue(final.exists())

    def test_snap_txt_extension_also_pruned(self):
        old_snap = _write(self.folder, "20230101-meeting-snap.txt", 60)
        deleted = cleanup_backups(
            self.folder, self._cfg(snap_on=True, snap_days=30),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [old_snap])
        self.assertFalse(old_snap.exists())

    def test_final_rule_deletes_report_and_recovered_keeps_snaps(self):
        report = _write(self.folder, "report.md", 60)
        recovered = _write(self.folder, "meeting-RECOVERED.md", 60)
        snap = _write(self.folder, "20230101-meeting-snap.md", 90)
        deleted = cleanup_backups(
            self.folder, self._cfg(fin_on=True, fin_days=30),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(sorted(deleted), sorted([report, recovered]))
        self.assertFalse(report.exists())
        self.assertFalse(recovered.exists())
        self.assertTrue(snap.exists())

    def test_both_off_is_noop_returns_empty(self):
        snap = _write(self.folder, "20230101-meeting-snap.md", 9999)
        final = _write(self.folder, "report.md", 9999)
        deleted = cleanup_backups(
            self.folder, self._cfg(snap_on=False, fin_on=False),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [])
        self.assertTrue(snap.exists())
        self.assertTrue(final.exists())

    def test_default_off_zero_behaviour_change(self):
        # Empty/None cfg ⇒ both rules off ⇒ nothing deleted.
        final = _write(self.folder, "report.md", 9999)
        self.assertEqual(cleanup_backups(self.folder, None, now=NOW, stamp_path=self.stamp), [])
        self.assertEqual(cleanup_backups(self.folder, {}, now=NOW, stamp_path=self.stamp), [])
        self.assertTrue(final.exists())

    def test_mtime_boundary_exactly_days_kept_older_deleted(self):
        # Exactly `days` old → NOT deleted (strict >). 1 second older → deleted.
        exact = _write(self.folder, "exact.md", 0)
        os.utime(exact, (NOW - 30 * DAY, NOW - 30 * DAY))
        older = _write(self.folder, "older.md", 0)
        os.utime(older, (NOW - 30 * DAY - 1, NOW - 30 * DAY - 1))
        deleted = cleanup_backups(
            self.folder, self._cfg(fin_on=True, fin_days=30),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [older])
        self.assertTrue(exact.exists())
        self.assertFalse(older.exists())

    def test_ics_never_deleted(self):
        ics = _write(self.folder, "event.ics", 9999)
        # Even with both rules on and a very old file, .ics is untouched.
        deleted = cleanup_backups(
            self.folder, self._cfg(snap_on=True, snap_days=1, fin_on=True, fin_days=1),
            now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [])
        self.assertTrue(ics.exists())

    def test_throttle_skips_second_run_within_24h(self):
        _write(self.folder, "report.md", 60)
        cfg = self._cfg(fin_on=True, fin_days=30)
        first = cleanup_backups(self.folder, cfg, now=NOW, stamp_path=self.stamp, throttle=True)
        self.assertEqual(len(first), 1)
        self.assertTrue(self.stamp.exists())
        # A new old file + a second call < 24h later is skipped (returns []).
        _write(self.folder, "report2.md", 60)
        second = cleanup_backups(
            self.folder, cfg, now=NOW + 3600, stamp_path=self.stamp, throttle=True,
        )
        self.assertEqual(second, [])
        self.assertTrue((self.folder / "report2.md").exists())

    def test_throttle_false_always_runs(self):
        _write(self.folder, "report.md", 60)
        cfg = self._cfg(fin_on=True, fin_days=30)
        cleanup_backups(self.folder, cfg, now=NOW, stamp_path=self.stamp, throttle=True)
        r2 = _write(self.folder, "report2.md", 60)
        deleted = cleanup_backups(
            self.folder, cfg, now=NOW + 3600, stamp_path=self.stamp, throttle=False,
        )
        self.assertEqual(deleted, [r2])
        self.assertFalse(r2.exists())

    def test_throttle_runs_after_24h(self):
        _write(self.folder, "report.md", 60)
        cfg = self._cfg(fin_on=True, fin_days=30)
        cleanup_backups(self.folder, cfg, now=NOW, stamp_path=self.stamp, throttle=True)
        r2 = _write(self.folder, "report2.md", 60)
        deleted = cleanup_backups(
            self.folder, cfg, now=NOW + DAY + 1, stamp_path=self.stamp, throttle=True,
        )
        self.assertEqual(deleted, [r2])

    def test_missing_folder_is_safe(self):
        missing = self.folder / "does-not-exist"
        deleted = cleanup_backups(
            missing, self._cfg(fin_on=True), now=NOW, stamp_path=self.stamp,
        )
        self.assertEqual(deleted, [])


if __name__ == "__main__":
    unittest.main()
