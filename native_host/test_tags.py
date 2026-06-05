#!/usr/bin/env python3
"""Tests for auto-tagging (RB-4c) in meeting_minutes_host.py."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import extract_tags, build_yaml_frontmatter


class TestExtractTags(unittest.TestCase):

    def test_parses_and_strips_tags_line(self):
        body = "## Summary\nWe shipped it.\n\nTags: Payments, Kafka, Q3 Planning"
        tags, cleaned = extract_tags(body)
        self.assertEqual(tags, ["payments", "kafka", "q3-planning"])
        self.assertNotIn("Tags:", cleaned)
        self.assertIn("We shipped it.", cleaned)

    def test_no_tags_line_returns_body_unchanged(self):
        body = "## Summary\nNo tags here."
        tags, cleaned = extract_tags(body)
        self.assertEqual(tags, [])
        self.assertEqual(cleaned, body)

    def test_dedupes_and_caps_at_five(self):
        body = "Tags: a, a, b, c, d, e, f, g"
        tags, _ = extract_tags(body)
        self.assertEqual(tags, ["a", "b", "c", "d", "e"])

    def test_strips_unsafe_characters(self):
        body = "Tags: q3/planning, ka!fka, deploy@prod"
        tags, _ = extract_tags(body)
        self.assertEqual(tags, ["q3/planning", "kafka", "deployprod"])

    def test_frontmatter_appends_topic_tags(self):
        fm = build_yaml_frontmatter(
            "Q3 Sync", datetime(2026, 6, 5, 9, 0),
            topic_tags=["payments", "kafka"],
        )
        self.assertIn("tags: [meeting, 2026/06, payments, kafka]", fm)

    def test_frontmatter_without_topic_tags_unchanged(self):
        fm = build_yaml_frontmatter("Q3 Sync", datetime(2026, 6, 5, 9, 0))
        self.assertIn("tags: [meeting, 2026/06]", fm)


if __name__ == "__main__":
    unittest.main()
