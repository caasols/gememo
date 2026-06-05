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


class TestMeetCode(unittest.TestCase):
    def test_from_hangout_link(self):
        e = {"hangoutLink": "https://meet.google.com/abc-defg-hij"}
        self.assertEqual(gcal._event_meet_code(e), "abc-defg-hij")

    def test_from_conference_id(self):
        e = {"conferenceData": {"conferenceId": "abc-defg-hij"}}
        self.assertEqual(gcal._event_meet_code(e), "abc-defg-hij")

    def test_from_entry_point_uri(self):
        e = {"conferenceData": {"entryPoints": [{"uri": "https://meet.google.com/xyz-mnop-qrs"}]}}
        self.assertEqual(gcal._event_meet_code(e), "xyz-mnop-qrs")

    def test_none_when_absent(self):
        self.assertEqual(gcal._event_meet_code({}), "")


class TestMatch(unittest.TestCase):
    def _ev(self, code, start, summary=""):
        return {"hangoutLink": f"https://meet.google.com/{code}",
                "start": {"dateTime": start}, "summary": summary}

    def test_exact_code_match(self):
        evs = [self._ev("aaa-bbbb-ccc", "2026-06-05T09:00:00Z"),
               self._ev("ddd-eeee-fff", "2026-06-05T10:00:00Z")]
        m = gcal.match_calendar_event(evs, "ddd-eeee-fff", "2026-06-05T10:05:00Z")
        self.assertEqual(m["start"]["dateTime"], "2026-06-05T10:00:00Z")

    def test_duplicate_code_uses_nearest_time(self):
        evs = [self._ev("aaa-bbbb-ccc", "2026-06-05T09:00:00Z"),
               self._ev("aaa-bbbb-ccc", "2026-06-05T15:00:00Z")]
        m = gcal.match_calendar_event(evs, "aaa-bbbb-ccc", "2026-06-05T14:50:00Z")
        self.assertEqual(m["start"]["dateTime"], "2026-06-05T15:00:00Z")

    def test_fallback_title_then_time(self):
        evs = [self._ev("aaa-bbbb-ccc", "2026-06-05T09:00:00Z", "Standup"),
               self._ev("ddd-eeee-fff", "2026-06-05T10:00:00Z", "Q3 Planning")]
        m = gcal.match_calendar_event(evs, "", "2026-06-05T10:10:00Z", title="Q3 Planning")
        self.assertEqual(m["summary"], "Q3 Planning")

    def test_no_events_returns_none(self):
        self.assertIsNone(gcal.match_calendar_event([], "aaa-bbbb-ccc", ""))


if __name__ == "__main__":
    unittest.main()
