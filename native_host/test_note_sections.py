#!/usr/bin/env python3
"""Tests for parse_note_sections — the note-body section splitter used by the
recurring-meeting context builder (P9-C)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import parse_note_sections


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


if __name__ == "__main__":
    unittest.main()
