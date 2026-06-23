#!/usr/bin/env python3
"""Unit tests for user-agnostic backup-path resolution (_resolve_backup_path /
_homerel_path) — a stored folder must resolve regardless of which Mac account it
was saved under (BUG-12)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as host

HOME = Path("/Users/alice")


class TestResolveBackupPath(unittest.TestCase):
    def test_tilde_expands_against_current_home(self):
        self.assertEqual(host._resolve_backup_path("~/Documents/notes", home=HOME),
                         Path("/Users/alice/Documents/notes"))

    def test_foreign_user_is_rehomed(self):
        # saved on the work laptop, run on the personal one
        self.assertEqual(host._resolve_backup_path("/Users/bob/Documents/gememo-meeting-notes", home=HOME),
                         Path("/Users/alice/Documents/gememo-meeting-notes"))

    def test_same_user_absolute_is_unchanged(self):
        self.assertEqual(host._resolve_backup_path("/Users/alice/Documents/notes", home=HOME),
                         Path("/Users/alice/Documents/notes"))

    def test_outside_users_left_alone(self):
        self.assertEqual(host._resolve_backup_path("/Volumes/External/notes", home=HOME),
                         Path("/Volumes/External/notes"))

    def test_blank_falls_back_to_default_under_home(self):
        self.assertEqual(host._resolve_backup_path("", home=HOME),
                         Path("/Users/alice/Documents/gememo-meeting-notes"))
        self.assertEqual(host._resolve_backup_path(None, home=HOME),
                         Path("/Users/alice/Documents/gememo-meeting-notes"))


class TestHomerelPath(unittest.TestCase):
    def test_under_home_becomes_tilde(self):
        self.assertEqual(host._homerel_path("/Users/alice/Documents/gememo-meeting-notes", home=HOME),
                         "~/Documents/gememo-meeting-notes")

    def test_outside_home_unchanged(self):
        self.assertEqual(host._homerel_path("/Volumes/External/notes", home=HOME),
                         "/Volumes/External/notes")

    def test_roundtrip_is_agnostic(self):
        # pick on alice's machine → store '~/…' → resolve on bob's machine
        stored = host._homerel_path("/Users/alice/Documents/notes", home=Path("/Users/alice"))
        self.assertEqual(host._resolve_backup_path(stored, home=Path("/Users/bob")),
                         Path("/Users/bob/Documents/notes"))


if __name__ == "__main__":
    unittest.main()
