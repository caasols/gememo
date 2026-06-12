#!/usr/bin/env python3
"""Tests for RB-1d recovery helpers in meeting_minutes_host.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import pick_recovery_text, _strip_frontmatter, _recover_freshest_text


class TestPickRecoveryText:
    def test_snapshot_when_longer(self):
        assert pick_recovery_text("short", "a much longer snapshot body") == "a much longer snapshot body"

    def test_inflight_when_longer(self):
        assert pick_recovery_text("the in-flight note is the longer one", "snap") \
            == "the in-flight note is the longer one"

    def test_tie_prefers_inflight(self):
        assert pick_recovery_text("same", "same") == "same"

    def test_no_snapshot_falls_back_to_inflight(self):
        assert pick_recovery_text("only inflight", None) == "only inflight"
        assert pick_recovery_text("only inflight", "") == "only inflight"


class TestStripFrontmatter:
    def test_removes_leading_block(self):
        body = "---\ntitle: X\ndate: Y\n---\nReal body here"
        assert _strip_frontmatter(body) == "Real body here"

    def test_noop_without_block(self):
        assert _strip_frontmatter("No frontmatter here") == "No frontmatter here"

    def test_empty(self):
        assert _strip_frontmatter("") == ""


class TestRecoverFreshestText:
    def test_prefers_longer_snapshot(self, tmp_path):
        (tmp_path / "20260611-170610-team-meet-snap.md").write_text(
            "---\ntitle: Team Meet\n---\n" + "x" * 500, encoding="utf-8")
        msg = {"meetingTitle": "team meet", "fileBackupType": "markdown",
               "fileBackupPath": str(tmp_path)}
        assert _recover_freshest_text("short inflight", msg) == "x" * 500

    def test_falls_back_to_inflight_when_no_snapshot(self, tmp_path):
        msg = {"meetingTitle": "no snaps here", "fileBackupType": "markdown",
               "fileBackupPath": str(tmp_path)}
        assert _recover_freshest_text("the inflight note", msg) == "the inflight note"

    def test_falls_back_to_inflight_on_error(self, tmp_path, monkeypatch):
        import meeting_minutes_host as mh

        def boom(*a, **k):
            raise OSError("disk error")

        monkeypatch.setattr(mh, "find_latest_snapshot", boom)
        msg = {"meetingTitle": "x", "fileBackupType": "markdown",
               "fileBackupPath": str(tmp_path)}
        assert mh._recover_freshest_text("keep me", msg) == "keep me"
