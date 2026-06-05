#!/usr/bin/env python3
"""Tests for the provenance footer (UXC-22) in meeting_minutes_host.py."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import build_provenance_footer, parse_note_sections


class TestProvenanceFooter(unittest.TestCase):

    def _dt(self) -> datetime:
        return datetime(2026, 6, 5, 14, 30, 0)

    def test_contains_brand_date_and_source(self):
        footer = build_provenance_footer(self._dt())
        self.assertIn("Captured automatically by Gememo", footer)
        self.assertIn("2026-06-05", footer)
        self.assertIn("Google Meet + Gemini", footer)

    def test_separated_from_body(self):
        """Footer starts with blank lines so it never runs into the last body line."""
        self.assertTrue(build_provenance_footer(self._dt()).startswith("\n\n"))

    def test_is_plain_text(self):
        """No markdown characters — reads the same in Craft, Notes, Obsidian."""
        footer = build_provenance_footer(self._dt())
        for ch in ("*", "_", "`", "#", "["):
            self.assertNotIn(ch, footer)

    def test_footer_not_parsed_as_a_section(self):
        """Appended to a note body, the footer must not become a fake section."""
        body = "## Summary\nWe shipped it.\n\n## Action Items\nAlice: ship."
        footer = build_provenance_footer(self._dt())
        sections = parse_note_sections(body + footer)
        # The footer text leaks into the trailing section's content at worst, but
        # never creates a 'captured' / 'gememo' heading of its own.
        self.assertNotIn("captured", sections)
        self.assertNotIn("gememo", sections)


if __name__ == "__main__":
    unittest.main()
