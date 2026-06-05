#!/usr/bin/env python3
"""Tests for per-rule title templating (RB-4d) in meeting_minutes_host.py."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import render_title_template


class TestRenderTitleTemplate(unittest.TestCase):

    def _dt(self):
        return datetime(2026, 6, 5, 14, 30, 0)

    def test_blank_template_uses_default_format(self):
        self.assertEqual(
            render_title_template("", self._dt(), "Q3 Sync"),
            "20260605 14:30 Q3 Sync",
        )

    def test_all_placeholders(self):
        out = render_title_template(
            "{date} — {name} — {type} ({code})", self._dt(), "Q3 Sync",
            meeting_type="calendar", code="abc-defg-hij",
        )
        self.assertEqual(out, "20260605 — Q3 Sync — calendar (abc-defg-hij)")

    def test_time_placeholder(self):
        self.assertEqual(
            render_title_template("{time} {name}", self._dt(), "Standup"),
            "14:30 Standup",
        )

    def test_empty_placeholders_collapse_spaces(self):
        # {type} and {code} are empty → no doubled spaces / dangling separators.
        out = render_title_template("{date} {name} {type}", self._dt(), "Sync")
        self.assertEqual(out, "20260605 Sync")

    def test_template_that_renders_empty_falls_back(self):
        out = render_title_template("{type}", self._dt(), "Sync", meeting_type="")
        self.assertEqual(out, "20260605 14:30 Sync")

    def test_missing_name_defaults(self):
        out = render_title_template("{name}", self._dt(), "")
        self.assertEqual(out, "Meeting")


if __name__ == "__main__":
    unittest.main()
