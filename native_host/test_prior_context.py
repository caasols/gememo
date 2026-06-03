#!/usr/bin/env python3
"""Tests for recurring-meeting context injection (P9-C) in meeting_minutes_host.py."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import note_slug, find_prior_note, build_prior_context


class TestNoteSlug(unittest.TestCase):

    def test_spaces_and_case(self):
        self.assertEqual(note_slug("Daily Standup"), "daily-standup")

    def test_punctuation_normalised(self):
        self.assertEqual(note_slug("1:1 with Bob"), "1-1-with-bob")

    def test_empty(self):
        self.assertEqual(note_slug(""), "")


class TestBuildPriorContext(unittest.TestCase):

    def test_includes_summary_and_actions(self):
        note = '## Summary\nWe shipped X.\n\n## Action Items\nAlice: finish Y.'
        ctx = build_prior_context(note, "2026-06-01")
        self.assertIn("2026-06-01", ctx)
        self.assertIn("We shipped X.", ctx)
        self.assertIn("Alice: finish Y.", ctx)
        self.assertIn("do not repeat", ctx.lower())

    def test_empty_when_no_relevant_sections(self):
        self.assertEqual(build_prior_context("## Attendees\nAlice, Bob", "2026-06-01"), "")


class TestFindPriorNote(unittest.TestCase):

    def _write(self, d: Path, name: str, title: str, body: str = "## Summary\nstuff") -> None:
        (d / name).write_text(f'---\ndate: x\ntitle: "{title}"\n---\n{body}', encoding="utf-8")

    def test_finds_most_recent_matching_series(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(d, "20260601-daily-standup.md", "Daily Standup")
            self._write(d, "20260603-daily-standup.md", "Daily Standup")
            self._write(d, "20260602-q3-planning.md", "Q3 Planning")
            prior = find_prior_note("Daily Standup", tmp, today="20260604")
            self.assertIsNotNone(prior)
            self.assertTrue(prior.name.startswith("20260603"))

    def test_excludes_today(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(d, "20260604-daily-standup.md", "Daily Standup")
            self.assertIsNone(find_prior_note("Daily Standup", tmp, today="20260604"))

    def test_excludes_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(d, "20260601-120000-daily-standup-snap.md", "Daily Standup")
            self.assertIsNone(find_prior_note("Daily Standup", tmp, today="20260604"))

    def test_no_match_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(Path(tmp), "20260601-q3-planning.md", "Q3 Planning")
            self.assertIsNone(find_prior_note("Daily Standup", tmp, today="20260604"))


if __name__ == "__main__":
    unittest.main()
