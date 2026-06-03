#!/usr/bin/env python3
"""Tests for generic webhook output (P9-D) in meeting_minutes_host.py."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import parse_note_sections, build_webhook_payload


class TestParseNoteSections(unittest.TestCase):

    NOTE = (
        "## Attendees\nAlice, Bob\n\n"
        "## Summary\nWe agreed on the plan.\n\n"
        "## Key Points\nTopic: detail here.\n\n"
        "## Decisions Made\nAdopt X.\n\n"
        "## Action Items\nAlice: do thing by Friday.\n\n"
        "## Open Questions\nWhat about Z?"
    )

    def test_splits_known_sections(self):
        s = parse_note_sections(self.NOTE)
        self.assertEqual(s["summary"], "We agreed on the plan.")
        self.assertEqual(s["key_points"], "Topic: detail here.")
        self.assertEqual(s["decisions_made"], "Adopt X.")
        self.assertEqual(s["action_items"], "Alice: do thing by Friday.")
        self.assertEqual(s["open_questions"], "What about Z?")

    def test_handles_plain_and_bold_headings(self):
        s = parse_note_sections("Summary\nPlain heading body.\n\n**Key Points**\nBold heading body.")
        self.assertEqual(s["summary"], "Plain heading body.")
        self.assertEqual(s["key_points"], "Bold heading body.")

    def test_missing_sections_absent(self):
        s = parse_note_sections("## Summary\nOnly a summary.")
        self.assertIn("summary", s)
        self.assertNotIn("action_items", s)


class TestBuildWebhookPayload(unittest.TestCase):

    def test_maps_sections_and_metadata(self):
        sections = {
            "summary": "S", "key_points": "KP", "decisions_made": "D",
            "action_items": "AI", "next_steps": "NS", "open_questions": "OQ",
        }
        payload = build_webhook_payload("Q3 Planning", "2026-06-04", ["Alice"], 42, sections)
        self.assertEqual(payload["title"], "Q3 Planning")
        self.assertEqual(payload["date"], "2026-06-04")
        self.assertEqual(payload["attendees"], ["Alice"])
        self.assertEqual(payload["duration_min"], 42)
        self.assertEqual(payload["summary"], "S")
        self.assertEqual(payload["decisions"], "D")      # decisions_made → decisions
        self.assertEqual(payload["action_items"], "AI")
        self.assertEqual(payload["open_questions"], "OQ")

    def test_absent_sections_default_to_empty_string(self):
        payload = build_webhook_payload("M", "2026-06-04", [], None, {})
        self.assertEqual(payload["summary"], "")
        self.assertEqual(payload["attendees"], [])
        self.assertIsNone(payload["duration_min"])


if __name__ == "__main__":
    unittest.main()
