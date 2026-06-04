#!/usr/bin/env python3
"""Tests for .ics generation from Next Steps (RB-3b)."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import build_ics


class TestBuildIcs(unittest.TestCase):

    def _dt(self):
        return datetime(2026, 6, 1, 9, 12, 0)

    def test_one_vevent_per_step(self):
        ics = build_ics(["Architecture review next Tuesday", "Demo on June 15"],
                        self._dt(), "Q3 Planning")
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR"))
        self.assertIn("END:VCALENDAR", ics)
        self.assertEqual(ics.count("BEGIN:VEVENT"), 2)
        self.assertIn("SUMMARY:Architecture review next Tuesday", ics)
        self.assertIn("SUMMARY:Demo on June 15", ics)
        self.assertIn("DTSTART;VALUE=DATE:20260601", ics)
        self.assertIn("\r\n", ics)  # ICS requires CRLF

    def test_strips_bullet_markers(self):
        ics = build_ics(["- Review the spec", "• Send the deck"], self._dt())
        self.assertIn("SUMMARY:Review the spec", ics)
        self.assertIn("SUMMARY:Send the deck", ics)

    def test_escapes_special_chars(self):
        ics = build_ics(["Plan A, B; then C"], self._dt())
        self.assertIn(r"SUMMARY:Plan A\, B\; then C", ics)

    def test_empty_steps_returns_empty(self):
        self.assertEqual(build_ics([], self._dt()), "")
        self.assertEqual(build_ics(["   ", ""], self._dt()), "")


if __name__ == "__main__":
    unittest.main()
