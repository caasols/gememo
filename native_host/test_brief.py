#!/usr/bin/env python3
"""Unit tests for the P9-G pre-meeting brief brain in gcal.py — pure, no Google
libs required. Mirrors test_gcal.py style: synthetic event dicts, injected
events_provider, no network."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gcal


class TestBuildPreMeetingBrief(unittest.TestCase):
    def test_agenda_bullet_from_description_first_line(self):
        fields = {"description": "Discuss the Q3 roadmap.\n- staffing\n- budget"}
        bullets = gcal.build_pre_meeting_brief(fields)
        self.assertTrue(any("Q3 roadmap" in b for b in bullets))

    def test_agenda_bullet_first_sentence_only(self):
        fields = {"description": "Decide on the launch date. Then talk hiring."}
        bullets = gcal.build_pre_meeting_brief(fields)
        agenda = next(b for b in bullets if "Agenda" in b)
        self.assertIn("Decide on the launch date", agenda)
        self.assertNotIn("hiring", agenda)

    def test_no_agenda_when_description_missing(self):
        fields = {"attendee_emails": ["a@x.com"]}
        bullets = gcal.build_pre_meeting_brief(fields)
        self.assertTrue(any("No agenda in the invite." in b for b in bullets))

    def test_who_bullet_counts_and_names(self):
        fields = {"attendee_emails": ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
                  "organizer": "lead@x.com"}
        bullets = gcal.build_pre_meeting_brief(fields)
        who = next(b for b in bullets if b.startswith("Who"))
        self.assertIn("4", who)
        self.assertIn("a@x.com", who)
        self.assertIn("lead@x.com", who)

    def test_who_bullet_caps_names(self):
        fields = {"attendee_emails": [f"u{i}@x.com" for i in range(10)]}
        bullets = gcal.build_pre_meeting_brief(fields)
        who = next(b for b in bullets if b.startswith("Who"))
        # At most ~3 names listed, even with 10 attendees.
        self.assertLessEqual(who.count("@"), 3)

    def test_redaction_hides_emails_in_who(self):
        # When redaction is requested, extract drops attendee_emails entirely;
        # the brief should still surface a count if any other signal exists, but
        # must never print an email. Here only organizer is present.
        fields = {"organizer": "lead@x.com"}
        bullets = gcal.build_pre_meeting_brief(fields, redact_emails=True)
        for b in bullets:
            self.assertNotIn("lead@x.com", b)

    def test_context_recurring_flag(self):
        fields = {"recurring_event_id": "rec_1"}
        bullets = gcal.build_pre_meeting_brief(fields)
        self.assertTrue(any("Recurring" in b for b in bullets))

    def test_context_scheduled_start_and_duration(self):
        fields = {"scheduled_start": "2026-06-05T09:00:00Z", "scheduled_duration_min": 30}
        bullets = gcal.build_pre_meeting_brief(fields)
        ctx = next(b for b in bullets if b.startswith("Context"))
        self.assertIn("30", ctx)

    def test_empty_fields_returns_empty_list(self):
        self.assertEqual(gcal.build_pre_meeting_brief({}), [])
        self.assertEqual(gcal.build_pre_meeting_brief(None), [])

    def test_at_most_three_bullets(self):
        fields = {
            "description": "Plan the release.",
            "attendee_emails": ["a@x.com", "b@x.com"],
            "organizer": "lead@x.com",
            "recurring_event_id": "rec_1",
            "scheduled_start": "2026-06-05T09:00:00Z",
            "scheduled_duration_min": 45,
        }
        bullets = gcal.build_pre_meeting_brief(fields)
        self.assertLessEqual(len(bullets), 3)

    def test_never_raises_on_weird_input(self):
        for bad in [{"description": 123}, {"attendee_emails": "notalist"},
                    {"scheduled_duration_min": "x"}, {"organizer": None}, [], 42, "str"]:
            try:
                out = gcal.build_pre_meeting_brief(bad)
            except Exception as exc:  # pragma: no cover
                self.fail(f"build_pre_meeting_brief raised on {bad!r}: {exc}")
            self.assertIsInstance(out, list)


class TestPreMeetingBrief(unittest.TestCase):
    EVENT = {
        "hangoutLink": "https://meet.google.com/abc-defg-hij",
        "summary": "Q3 Planning",
        "description": "Discuss the roadmap.",
        "organizer": {"email": "lead@x.com"},
        "attendees": [{"email": "a@x.com"}, {"email": "b@x.com"}],
        "recurringEventId": "rec_1",
        "start": {"dateTime": "2026-06-05T09:00:00Z"},
        "end": {"dateTime": "2026-06-05T09:30:00Z"},
    }

    def test_match_returns_bullets(self):
        r = gcal.pre_meeting_brief(
            "abc-defg-hij", "2026-06-05T08:55:00Z", "", False,
            events_provider=lambda: [self.EVENT])
        self.assertTrue(r["ok"])
        self.assertTrue(r["matched"])
        self.assertTrue(r["bullets"])
        self.assertEqual(r["title"], "Q3 Planning")

    def test_redaction_hides_emails(self):
        r = gcal.pre_meeting_brief(
            "abc-defg-hij", "2026-06-05T08:55:00Z", "", True,
            events_provider=lambda: [self.EVENT])
        for b in r["bullets"]:
            self.assertNotIn("a@x.com", b)

    def test_no_match_matched_false(self):
        r = gcal.pre_meeting_brief(
            "zzz-zzzz-zzz", "2026-06-05T09:00:00Z", "", False,
            events_provider=lambda: [])
        self.assertTrue(r["ok"])
        self.assertFalse(r["matched"])
        self.assertEqual(r["bullets"], [])

    def test_not_connected_ok_false(self):
        r = gcal.pre_meeting_brief(
            "x", "", "", False, events_provider=lambda: None)
        self.assertFalse(r["ok"])
        self.assertIn("error", r)

    def test_provider_raising_ok_false(self):
        def boom():
            raise RuntimeError("api down")
        r = gcal.pre_meeting_brief("x", "", "", False, events_provider=boom)
        self.assertFalse(r["ok"])
        self.assertIn("error", r)


if __name__ == "__main__":
    unittest.main()
