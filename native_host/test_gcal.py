#!/usr/bin/env python3
"""Unit tests for the pure layer of gcal.py (5.3) — no Google libs required."""
import shutil
import sys
import tempfile
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


class TestExtract(unittest.TestCase):
    EVENT = {
        "summary": "Q3 Planning",
        "recurringEventId": "rec_123",
        "description": "Agenda:\n- roadmap\n- staffing",
        "organizer": {"email": "lead@x.com"},
        "attendees": [{"email": "a@x.com"}, {"email": "b@x.com"}, {"displayName": "No Email"}],
        "start": {"dateTime": "2026-06-05T09:00:00Z"},
        "end": {"dateTime": "2026-06-05T09:30:00Z"},
    }

    def test_full_extraction(self):
        f = gcal.extract_calendar_fields(self.EVENT, redact_emails=False)
        self.assertEqual(f["recurring_event_id"], "rec_123")
        self.assertIn("roadmap", f["description"])
        self.assertEqual(f["organizer"], "lead@x.com")
        self.assertEqual(f["attendee_emails"], ["a@x.com", "b@x.com"])
        self.assertEqual(f["scheduled_duration_min"], 30)
        self.assertEqual(f["scheduled_start"], "2026-06-05T09:00:00Z")

    def test_redaction_omits_emails(self):
        f = gcal.extract_calendar_fields(self.EVENT, redact_emails=True)
        self.assertNotIn("attendee_emails", f)
        self.assertIn("recurring_event_id", f)

    def test_empty_event_returns_empty(self):
        self.assertEqual(gcal.extract_calendar_fields(None), {})
        self.assertEqual(gcal.extract_calendar_fields({}), {})

    def test_all_day_event_has_no_duration(self):
        f = gcal.extract_calendar_fields({"start": {"date": "2026-06-05"}, "end": {"date": "2026-06-06"}})
        self.assertNotIn("scheduled_duration_min", f)


class TestEnrich(unittest.TestCase):
    def test_window_brackets_timestamp(self):
        tmin, tmax = gcal._window_around("2026-06-05T10:00:00Z")
        self.assertLess(tmin, "2026-06-05T10:00:00Z")
        self.assertGreater(tmax, "2026-06-05T10:00:00Z")

    def test_enrich_ok(self):
        ev = {"hangoutLink": "https://meet.google.com/abc-defg-hij",
              "start": {"dateTime": "2026-06-05T10:00:00Z"},
              "end": {"dateTime": "2026-06-05T10:30:00Z"},
              "recurringEventId": "rec_1"}
        fields, status = gcal.enrich_frontmatter_fields(
            "abc-defg-hij", "2026-06-05T10:31:00Z", "", False,
            events_provider=lambda: [ev])
        self.assertEqual(status, "ok")
        self.assertEqual(fields["recurring_event_id"], "rec_1")

    def test_enrich_not_connected(self):
        fields, status = gcal.enrich_frontmatter_fields(
            "x", "", "", False, events_provider=lambda: None)
        self.assertEqual(status, "not_connected")
        self.assertEqual(fields, {})

    def test_enrich_no_match(self):
        fields, status = gcal.enrich_frontmatter_fields(
            "zzz-zzzz-zzz", "2026-06-05T10:00:00Z", "", False,
            events_provider=lambda: [])
        self.assertEqual(status, "no_match")

    def test_enrich_never_raises(self):
        def boom():
            raise RuntimeError("api down")
        fields, status = gcal.enrich_frontmatter_fields(
            "x", "", "", False, events_provider=boom)
        self.assertEqual(fields, {})
        self.assertTrue(status.startswith("error"))


class TestTokenOps(unittest.TestCase):
    """Token/account file ops — testable without the Google libraries."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = (gcal.CONFIG_DIR, gcal.TOKEN_PATH, gcal.ACCOUNT_PATH)
        gcal.CONFIG_DIR = Path(self.tmp)
        gcal.TOKEN_PATH = Path(self.tmp) / "token.json"
        gcal.ACCOUNT_PATH = Path(self.tmp) / "account.json"

    def tearDown(self):
        gcal.CONFIG_DIR, gcal.TOKEN_PATH, gcal.ACCOUNT_PATH = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_disconnect_removes_files(self):
        gcal.TOKEN_PATH.write_text("{}")
        gcal.ACCOUNT_PATH.write_text('{"email":"x@y.com"}')
        r = gcal.disconnect()
        self.assertTrue(r["ok"])
        self.assertFalse(gcal.TOKEN_PATH.exists())
        self.assertFalse(gcal.ACCOUNT_PATH.exists())

    def test_disconnect_noop_when_absent(self):
        self.assertTrue(gcal.disconnect()["ok"])

    def test_load_creds_none_without_token(self):
        self.assertIsNone(gcal._load_creds())

    def test_status_when_libs_unavailable(self):
        if gcal.GCAL_AVAILABLE:
            self.skipTest("google libs present on this machine")
        s = gcal.status()
        self.assertFalse(s["connected"])
        self.assertFalse(s["available"])


if __name__ == "__main__":
    unittest.main()
