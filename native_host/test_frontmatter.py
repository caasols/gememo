#!/usr/bin/env python3
"""Unit and integration tests for YAML frontmatter in meeting_minutes_host.py."""

import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import build_yaml_frontmatter, handle_snapshot


class TestBuildYamlFrontmatter(unittest.TestCase):

    def _dt(self) -> datetime:
        return datetime(2026, 5, 31, 9, 12, 0)

    def test_calendar_fields_rendered(self):
        cal = {
            "recurring_event_id": "rec_1",
            "description": "Line one\nLine two",
            "organizer": "lead@x.com",
            "attendee_emails": ["a@x.com", "b@x.com"],
            "scheduled_start": "2026-06-05T09:00:00Z",
            "scheduled_duration_min": 30,
        }
        fm = build_yaml_frontmatter("Q3 Sync", self._dt(), cal_fields=cal)
        self.assertIn("recurring_event_id: rec_1", fm)
        self.assertIn("organizer: lead@x.com", fm)
        self.assertIn("scheduled_duration_min: 30", fm)
        self.assertIn("  - a@x.com", fm)
        self.assertIn('description: "Line one Line two"', fm)

    def test_no_calendar_fields_unchanged(self):
        fm = build_yaml_frontmatter("Q3 Sync", self._dt())
        self.assertNotIn("recurring_event_id", fm)

    def test_final_note_fields(self):
        """Final note frontmatter has date, title, source, tags — no snapshot key."""
        result = build_yaml_frontmatter("Q3 Planning", self._dt())
        self.assertTrue(result.startswith("---\n"), f"Should start with ---: {result!r}")
        self.assertTrue(result.endswith("---\n"), f"Should end with ---: {result!r}")
        self.assertIn("date: 2026-05-31", result)
        self.assertIn('title: "Q3 Planning"', result)
        self.assertIn("source: google-meet", result)
        self.assertIn("tags: [meeting, 2026/05]", result)
        self.assertNotIn("snapshot:", result)

    def test_snapshot_flag_present(self):
        """Snapshot frontmatter includes snapshot: true."""
        result = build_yaml_frontmatter("Standup", self._dt(), snapshot=True)
        self.assertIn("snapshot: true", result)

    def test_no_snapshot_flag_on_final(self):
        """Final note frontmatter must not contain the snapshot key at all."""
        result = build_yaml_frontmatter("Standup", self._dt(), snapshot=False)
        self.assertNotIn("snapshot:", result)

    def test_title_double_quotes_escaped(self):
        """Double quotes in the title are escaped as \\\" in the YAML string."""
        result = build_yaml_frontmatter('Team "Sync"', self._dt())
        self.assertIn(r'title: "Team \"Sync\""', result)

    def test_month_tag_zero_padded(self):
        """Single-digit months are zero-padded: 2026/01 not 2026/1."""
        dt = datetime(2026, 1, 5, 9, 0, 0)
        result = build_yaml_frontmatter("Meeting", dt)
        self.assertIn("tags: [meeting, 2026/01]", result)

    def test_attendees_block_list_in_frontmatter(self):
        """Attendees list renders as YAML block sequence."""
        result = build_yaml_frontmatter(
            "Standup", self._dt(),
            attendees=["Alice Chen", "Bob Martinez", "Carlos Rodriguez"]
        )
        self.assertIn("attendees:", result)
        self.assertIn("  - Alice Chen", result)
        self.assertIn("  - Bob Martinez", result)
        self.assertIn("  - Carlos Rodriguez", result)
        # Block list — not inline [...]
        self.assertNotIn("attendees: [", result)

    def test_empty_attendees_omitted(self):
        """Empty attendees list produces no attendees key in frontmatter."""
        result = build_yaml_frontmatter("Standup", self._dt(), attendees=[])
        self.assertNotIn("attendees:", result)

    def test_duration_min_in_frontmatter(self):
        """duration_min renders as integer when provided."""
        result = build_yaml_frontmatter("Meeting", self._dt(), duration_min=47)
        self.assertIn("duration_min: 47", result)

    def test_duration_min_omitted_when_none(self):
        """duration_min key absent when not provided."""
        result = build_yaml_frontmatter("Meeting", self._dt())
        self.assertNotIn("duration_min:", result)

    def test_meeting_code_in_frontmatter(self):
        """meeting_code renders when provided (P9-A3a)."""
        result = build_yaml_frontmatter("Meeting", self._dt(), meeting_code="abc-defg-hij")
        self.assertIn("meeting_code: abc-defg-hij", result)

    def test_meeting_code_omitted_when_empty(self):
        """meeting_code key absent when empty/None."""
        self.assertNotIn("meeting_code:", build_yaml_frontmatter("Meeting", self._dt()))
        self.assertNotIn("meeting_code:", build_yaml_frontmatter("Meeting", self._dt(), meeting_code=""))

    def test_meeting_type_in_frontmatter(self):
        """meeting_type renders when provided (P9-A3b)."""
        result = build_yaml_frontmatter("Meeting", self._dt(), meeting_type="calendar")
        self.assertIn("meeting_type: calendar", result)

    def test_meeting_type_omitted_when_empty(self):
        """meeting_type key absent when empty/None."""
        self.assertNotIn("meeting_type:", build_yaml_frontmatter("Meeting", self._dt()))

    def test_recording_true_in_frontmatter(self):
        """recording: true renders when the meeting was recorded (P9-A3c)."""
        result = build_yaml_frontmatter("Meeting", self._dt(), recording=True)
        self.assertIn("recording: true", result)

    def test_recording_omitted_when_false(self):
        """recording key absent when not recorded (default)."""
        self.assertNotIn("recording:", build_yaml_frontmatter("Meeting", self._dt()))
        self.assertNotIn("recording:", build_yaml_frontmatter("Meeting", self._dt(), recording=False))


class TestHandleSnapshotFrontmatter(unittest.TestCase):

    def _msg(self, tmp: str, file_type: str = "markdown") -> dict:
        return {
            "transcript": "snapshot body content",
            "meetingTitle": "Standup",
            "timestamp": "2026-05-31T09:12:00Z",
            "fileBackupType": file_type,
            "fileBackupPath": tmp,
        }

    def test_md_snapshot_starts_with_frontmatter(self):
        """.md snapshot file starts with YAML frontmatter block."""
        with tempfile.TemporaryDirectory() as tmp:
            handle_snapshot(self._msg(tmp, "markdown"))
            snaps = list(Path(tmp).glob("*-snap.md"))
            self.assertEqual(len(snaps), 1)
            content = snaps[0].read_text(encoding="utf-8")
            self.assertTrue(content.startswith("---\n"), repr(content[:40]))
            self.assertIn("snapshot: true", content)
            self.assertIn("snapshot body content", content)

    def test_txt_snapshot_has_no_frontmatter(self):
        """.txt snapshot file has no YAML frontmatter."""
        with tempfile.TemporaryDirectory() as tmp:
            handle_snapshot(self._msg(tmp, "txt"))
            snaps = list(Path(tmp).glob("*-snap.txt"))
            self.assertEqual(len(snaps), 1)
            content = snaps[0].read_text(encoding="utf-8")
            self.assertFalse(content.startswith("---"), repr(content[:40]))


if __name__ == "__main__":
    unittest.main()
