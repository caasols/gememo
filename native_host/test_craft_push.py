#!/usr/bin/env python3
"""Tests for wait_for_craft_callback and build_import_url in push_to_craft.py."""

from __future__ import annotations

import re
import sys
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from push_to_craft import wait_for_craft_callback, build_import_url


def _port_from_url(url: str) -> int | None:
    """Extract the callback port from an x-success param in the URL."""
    m = re.search(r'x-success=http(?:%3A|:)(?:%2F%2F|//)localhost(?:%3A|:)(\d+)', url, re.I)
    return int(m.group(1)) if m else None


def _fire_after_delay(port: int, path: str, delay: float = 0.05) -> None:
    """GET http://localhost:{port}{path} after `delay` seconds in a daemon thread."""
    def _do() -> None:
        time.sleep(delay)
        try:
            urllib.request.urlopen(f"http://localhost:{port}{path}", timeout=2)
        except Exception:
            pass
    threading.Thread(target=_do, daemon=True).start()


class TestBuildImportUrl(unittest.TestCase):

    def test_no_callback_params_by_default(self):
        """build_import_url does not add x-success or x-error params."""
        url = build_import_url("/tmp/note.md", None, "")
        self.assertNotIn("x-success", url)
        self.assertNotIn("x-error", url)
        self.assertIn("filePath=", url)
        self.assertTrue(url.startswith("craftdocs://"))


class TestWaitForCraftCallback(unittest.TestCase):

    _BASE_URL = "craftdocs://x-callback-url/importDocument?filePath=%2Ftmp%2Ftest.md"

    def _run_with_mock_open(self, path_to_fire: str, timeout: float = 2.0):
        """Run wait_for_craft_callback with subprocess.run mocked.
        The mock fires a GET to the callback port extracted from the crafted URL.
        """
        def mock_open(cmd, **kwargs):
            url = cmd[-1]  # ['open', '-g', <url>]
            port = _port_from_url(url)
            if port:
                _fire_after_delay(port, path_to_fire)

        with patch("push_to_craft.subprocess.run", side_effect=mock_open):
            return wait_for_craft_callback(self._BASE_URL, timeout=timeout)

    def test_success_callback(self):
        """/success GET → (True, '')."""
        success, msg = self._run_with_mock_open("/success")
        self.assertTrue(success, f"Expected success, got: {msg!r}")
        self.assertEqual(msg, "")

    def test_error_callback(self):
        """/error?errorMessage=import+failed → (False, contains 'import failed')."""
        success, msg = self._run_with_mock_open("/error?errorMessage=import+failed")
        self.assertFalse(success)
        self.assertIn("import failed", msg)

    def test_timeout(self):
        """No callback within timeout → (False, contains 'Timeout')."""
        def mock_open(cmd, **kwargs):
            pass  # nothing fires

        with patch("push_to_craft.subprocess.run", side_effect=mock_open):
            success, msg = wait_for_craft_callback(self._BASE_URL, timeout=0.15)
        self.assertFalse(success)
        self.assertIn("Timeout", msg)


if __name__ == "__main__":
    unittest.main()
