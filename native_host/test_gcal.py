#!/usr/bin/env python3
"""Unit tests for the pure layer of gcal.py (5.3) — no Google libs required."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gcal


class TestParsing(unittest.TestCase):
    def test_parse_iso_with_z(self):
        dt = gcal._parse_iso("2026-06-05T09:00:00Z")
        self.assertEqual(dt.year, 2026)
        self.assertEqual(dt.hour, 9)

    def test_parse_iso_bad_returns_none(self):
        self.assertIsNone(gcal._parse_iso("not-a-date"))
        self.assertIsNone(gcal._parse_iso(""))

    def test_event_start_timed(self):
        dt = gcal._event_start({"start": {"dateTime": "2026-06-05T09:00:00Z"}})
        self.assertEqual(dt.hour, 9)

    def test_event_start_all_day(self):
        dt = gcal._event_start({"start": {"date": "2026-06-05"}})
        self.assertEqual(dt.year, 2026)

    def test_event_start_missing(self):
        self.assertIsNone(gcal._event_start({}))


if __name__ == "__main__":
    unittest.main()
