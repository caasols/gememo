#!/usr/bin/env python3
"""Tests for Bear output (5.8) in meeting_minutes_host.py.

Bear is untested against a live app — these cover the URL contract and that
route_output dispatches to the (injected) opener without touching the system.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import build_bear_url, route_output


class TestBuildBearUrl(unittest.TestCase):

    def test_scheme_and_encoding(self):
        url = build_bear_url("Q3 Sync", "Line one\nLine two")
        self.assertTrue(url.startswith("bear://x-callback-url/create?"))
        self.assertIn("title=Q3%20Sync", url)
        self.assertIn("text=Line%20one%0ALine%20two", url)


class TestRouteOutputBear(unittest.TestCase):

    def test_routes_to_opener_and_reports_ok(self):
        # BUG-11 Fix C: route_output RETURNS a per-destination result dict.
        opened = []
        result = route_output(
            "bear", "## Summary\nNotes", "20260605 09:00 Q3 Sync", None,
            open_url_fn=lambda u: opened.append(u),
            notify_fn=lambda *a: None,
        )
        self.assertEqual(len(opened), 1)
        self.assertTrue(opened[0].startswith("bear://x-callback-url/create?"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["dest"], "Bear")

    def test_includes_backup_file_path_when_present(self):
        opened = []
        result = route_output(
            "bear", "body", "title", "/tmp/notes/20260605-x.md",
            open_url_fn=lambda u: opened.append(u),
            notify_fn=lambda *a: None,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["file"], "/tmp/notes/20260605-x.md")

    def test_opener_failure_reports_error(self):
        def boom(_):
            raise RuntimeError("Bear not installed")

        result = route_output(
            "bear", "body", "title", None,
            open_url_fn=boom, notify_fn=lambda *a: None,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["dest"], "Bear")
        self.assertIn("Bear not installed", result["error"])


if __name__ == "__main__":
    unittest.main()
