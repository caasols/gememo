#!/usr/bin/env python3
"""Tests for generic webhook output (P9-D) in meeting_minutes_host.py."""

import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import (
    parse_note_sections, build_webhook_payload, build_slack_payload, post_webhook,
)


class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestPostWebhook(unittest.TestCase):
    def test_2xx_is_success(self):
        with mock.patch.object(urllib.request, "urlopen", return_value=_FakeResp(200)):
            ok, err = post_webhook("https://hooks.example.com/x", {"a": 1})
        self.assertTrue(ok)
        self.assertEqual(err, "")

    def test_non_2xx_is_failure(self):
        with mock.patch.object(urllib.request, "urlopen", return_value=_FakeResp(500)):
            ok, err = post_webhook("https://hooks.example.com/x", {"a": 1})
        self.assertFalse(ok)
        self.assertIn("500", err)

    def test_exception_is_caught(self):
        with mock.patch.object(urllib.request, "urlopen", side_effect=OSError("boom")):
            ok, err = post_webhook("https://hooks.example.com/x", {"a": 1})
        self.assertFalse(ok)
        self.assertIn("boom", err)


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


class TestBuildSlackPayload(unittest.TestCase):
    """build_slack_payload — Slack incoming-webhook message (P9-B)."""

    def test_title_summary_and_action_count(self):
        sections = {"summary": "We shipped it.", "action_items": "Alice: x\nBob: y"}
        p = build_slack_payload("Q3 Planning", sections)
        self.assertIn("*Q3 Planning*", p["text"])
        self.assertIn("We shipped it.", p["text"])
        self.assertIn("*Action items:* 2", p["text"])

    def test_no_summary_zero_actions(self):
        p = build_slack_payload("Sync", {})
        self.assertIn("*Sync*", p["text"])
        self.assertIn("*Action items:* 0", p["text"])

    def test_blank_lines_not_counted(self):
        p = build_slack_payload("M", {"action_items": "Alice: x\n\n\nBob: y\n"})
        self.assertIn("*Action items:* 2", p["text"])


if __name__ == "__main__":
    unittest.main()
