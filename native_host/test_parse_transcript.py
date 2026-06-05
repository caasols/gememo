#!/usr/bin/env python3
"""Unit tests for the markdown-stripping logic in parse_transcript (meeting_minutes_host.py)."""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import parse_transcript


class TestParseTranscriptStripping(unittest.TestCase):

    def _body(self, text: str) -> str:
        """Run parse_transcript on raw text and return just the body."""
        _, body = parse_transcript(text)
        return body

    def test_title_line_extracted_and_stripped_from_body(self):
        """A leading 'TITLE:' line is pulled out and removed from the body."""
        title, body = parse_transcript("TITLE: Q3 Planning\n## Summary\nWe shipped it.")
        self.assertEqual(title, "Q3 Planning")
        self.assertNotIn("TITLE:", body)
        self.assertIn("We shipped it.", body)

    def test_bold_markers_stripped(self):
        """**bold text** markers are removed; content is preserved."""
        body = self._body("**Key Points:** something important happened")
        self.assertNotIn("**", body)
        self.assertIn("Key Points:", body)
        self.assertIn("something important happened", body)

    def test_backtick_markers_stripped(self):
        """Inline backtick markers are removed; content is preserved."""
        body = self._body("use `python` for this task")
        self.assertNotIn("`", body)
        self.assertIn("python", body)
        self.assertIn("use python for this task", body)

    def test_numbers_and_decimals_preserved(self):
        """Numeric content (versions, decimals) is not corrupted by the strip passes."""
        body = self._body("Python 3.11 and score of 0.5 FTE discussed")
        self.assertIn("3.11", body)
        self.assertIn("0.5", body)

    def test_heading_bold_stripped(self):
        """**Summary** loses bold markers (becomes bare text; heading conversion is a separate concern)."""
        body = self._body("**Summary**\nSome meeting outcome.")
        self.assertNotIn("**", body)
        self.assertIn("Summary", body)

    def test_separator_lines_stripped(self):
        """Lines of three or more dashes (Gemini separator artifacts) are removed from body."""
        body = self._body("## Summary\nWe discussed plans.\n---\n## Action Items\n- task")
        self.assertNotIn('---', body,
                         "Separator lines should be stripped from transcript body")
        self.assertIn('## Summary', body)
        self.assertIn('## Action Items', body)


class TestParseTranscriptHeadings(unittest.TestCase):

    def _body(self, text: str) -> str:
        """Run parse_transcript on raw text and return just the body."""
        _, body = parse_transcript(text)
        return body

    def test_existing_hash_prefix_not_doubled(self):
        """## Key Points on its own line becomes ## Key Points — not ## ## Key Points."""
        body = self._body("## Key Points\nSome bullet here.")
        self.assertIn("## Key Points", body)
        self.assertNotIn("## ## Key Points", body)
        self.assertNotIn("#### Key Points", body)

    def test_trailing_colon_stripped_from_heading(self):
        """Key Points: on its own line is promoted to ## Key Points (colon removed)."""
        body = self._body("Key Points:\nSome bullet here.")
        self.assertIn("## Key Points", body)
        self.assertNotIn("Key Points:", body)

    def test_case_insensitive_heading_match(self):
        """KEY POINTS on its own line is promoted to a heading."""
        body = self._body("KEY POINTS\nSome bullet here.")
        self.assertRegex(body, r'^## KEY POINTS', re.MULTILINE)

    def test_bold_wrapped_section_promoted(self):
        """**Attendees** on its own line is promoted to ## Attendees.
        The heading regex runs before the 3.3 bold strip, so it must handle **...** directly."""
        body = self._body("**Attendees**\nAlice, Bob")
        self.assertIn("## Attendees", body)
        self.assertNotIn("**Attendees**", body)

    def test_dash_prefix_stripped_before_heading(self):
        """---Attendees (Gemini copying EXAMPLE_NOTES delimiter) is normalised to ## Attendees."""
        body = self._body("---Attendees\n\nAlice, Bob\n\n## Summary\n\nMeeting notes.")
        self.assertIn("## Attendees", body)
        self.assertNotIn("---Attendees", body)

    def test_dash_prefix_on_multiple_sections(self):
        """--- prefix on multiple headings are all stripped and promoted."""
        raw = "---Attendees\n\nAlice\n\n---Summary\n\nNotes.\n\n---Key Points\n\nBullets."
        body = self._body(raw)
        self.assertIn("## Attendees", body)
        self.assertIn("## Summary", body)
        self.assertIn("## Key Points", body)
        self.assertNotIn("---Attendees", body)
        self.assertNotIn("---Summary", body)

    def test_standalone_separator_still_stripped(self):
        """Standalone --- lines (not attached to a heading) are still removed."""
        body = self._body("## Summary\n\n---\n\nSome text.")
        self.assertNotIn("\n---\n", body)
        self.assertIn("Some text.", body)

    def test_four_dash_line_leaves_no_orphan_dash(self):
        """A 4+ dash separator line is removed cleanly, not mangled into a stray '-'.

        Regression for the greedy-backtrack bug: ^-{3,}(?=\\S) consumed 3 of the 4
        dashes and left the 4th as an orphan '-' line that the standalone cleanup
        no longer matched.
        """
        body = self._body("## Summary\n\nDecision made.\n\n----\n\n## Action Items\n\n- task")
        orphan_lines = [ln for ln in body.splitlines() if ln.strip() == '-']
        self.assertEqual(orphan_lines, [], f"4-dash line left an orphan dash: {body!r}")
        self.assertIn("## Summary", body)
        self.assertIn("## Action Items", body)

    def test_five_dash_line_leaves_no_orphan_dash(self):
        """A 5-dash separator line is also removed cleanly."""
        body = self._body("## Summary\n\n-----\n\nSome text.")
        orphan_lines = [ln for ln in body.splitlines() if ln.strip() == '-']
        self.assertEqual(orphan_lines, [], f"5-dash line left an orphan dash: {body!r}")
        self.assertIn("Some text.", body)


if __name__ == "__main__":
    unittest.main()
