#!/usr/bin/env python3
"""Tests for push_to_craft.py URL builders and callback handler."""

from __future__ import annotations

import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import push_to_craft as pc
from push_to_craft import (
    wait_for_craft_callback,
    build_import_url,
    build_createdocument_url,
    strip_yaml_frontmatter,
    normalize_headings,
)


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


class TestBuildCreatedocumentUrl(unittest.TestCase):
    """build_createdocument_url — % double-encoding so macOS open + Craft both decode correctly.

    Chain: content % → replace → %25 → quote → %2525 in URL
           macOS open decodes once: %2525 → %25
           Craft decodes once:      %25   → %
    """

    def _decode_once(self, url: str) -> str:
        """Simulate macOS open's single URL-decode pass."""
        return urllib.parse.unquote(url)

    def _extract_content(self, url: str) -> str:
        """Pull the raw content= value from a craftdocs://createdocument URL."""
        qs = url.split('?', 1)[1]
        params = dict(p.split('=', 1) for p in qs.split('&') if '=' in p)
        return params.get('content', '')

    def test_percent_double_encoded_in_url(self):
        """% in content produces %2525 in the URL (double-encoded)."""
        url = build_createdocument_url('Title', 'Success rate is 50%')
        raw_content = self._extract_content(url)
        self.assertIn('%2525', raw_content, "% should be double-encoded as %2525")
        self.assertNotIn('%25%', raw_content)

    def test_craft_receives_percent_after_open_decode(self):
        """After one URL-decode (simulating macOS open), content still has %25 — Craft decodes to %."""
        url = build_createdocument_url('Title', 'A/B test: 50% conversion')
        after_open = self._decode_once(url)
        after_craft = self._decode_once(after_open.split('content=')[1].split('&')[0])
        self.assertIn('50%', after_craft)

    def test_multiple_percent_signs(self):
        """Multiple % in content are all double-encoded."""
        url = build_createdocument_url('Title', '10% done, 50% reviewed, 100% shipped')
        raw_content = self._extract_content(url)
        self.assertEqual(raw_content.count('%2525'), 3)

    def test_percent_at_end_of_string(self):
        """% at the end of content doesn't produce a dangling invalid sequence."""
        url = build_createdocument_url('Title', 'Completion: 75%')
        raw_content = self._extract_content(url)
        self.assertTrue(raw_content.endswith('%2525'))

    def test_content_without_percent_unaffected(self):
        """Content with no % is URL-encoded normally — no double-encoding artifacts."""
        content = '## Summary\n\nThe team agreed on the plan.'
        url = build_createdocument_url('Title', content)
        self.assertNotIn('%2525', url)
        after_craft = urllib.parse.unquote(self._extract_content(url))
        self.assertEqual(after_craft, content)

    def test_url_scheme_and_action(self):
        """URL starts with craftdocs://createdocument."""
        url = build_createdocument_url('My Meeting', 'Notes here')
        self.assertTrue(url.startswith('craftdocs://createdocument?'))

    def test_title_encoded_in_url(self):
        """Title is URL-encoded and present."""
        url = build_createdocument_url('[Duff] Daily stand-up', 'content')
        self.assertIn('title=', url)
        self.assertIn('%5BDuff%5D', url)

    def test_space_id_included_when_set(self):
        """spaceId param present when space_id provided, absent when None."""
        url_with = build_createdocument_url('T', 'c', space_id='abc-123')
        url_without = build_createdocument_url('T', 'c', space_id=None)
        self.assertIn('spaceId=abc-123', url_with)
        self.assertNotIn('spaceId', url_without)

    def test_em_dash_and_percent_combined(self):
        """Em dash (multi-byte UTF-8) and % together both survive the double-decode chain."""
        content = 'Carlos said—without hesitation—that 80% is the target.'
        url = build_createdocument_url('Title', content)
        after_open = self._decode_once(url)
        content_encoded = after_open.split('content=')[1].split('&')[0]
        after_craft = urllib.parse.unquote(content_encoded)
        self.assertIn('80%', after_craft)
        self.assertIn('—', after_craft)


class TestStripYamlFrontmatter(unittest.TestCase):
    """strip_yaml_frontmatter — backup files include YAML; Craft must receive clean body."""

    def test_strips_standard_frontmatter(self):
        content = '---\ndate: 2026-06-03\ntitle: "Meeting"\n---\n## Summary\n\nNotes here.'
        self.assertEqual(strip_yaml_frontmatter(content), '## Summary\n\nNotes here.')

    def test_strips_leading_blank_lines_after_frontmatter(self):
        content = '---\ndate: 2026-06-03\n---\n\n\n## Summary\n\nBody.'
        result = strip_yaml_frontmatter(content)
        self.assertFalse(result.startswith('\n'), "leading blank lines should be stripped")
        self.assertIn('## Summary', result)

    def test_no_frontmatter_returned_unchanged(self):
        content = '## Summary\n\nNo frontmatter here.'
        self.assertEqual(strip_yaml_frontmatter(content), content)

    def test_empty_string_returned_unchanged(self):
        self.assertEqual(strip_yaml_frontmatter(''), '')

    def test_unclosed_frontmatter_returned_unchanged(self):
        """If there is no closing ---, return the content as-is rather than eating the whole file."""
        content = '---\ndate: 2026-06-03\n## Summary\n\nBody.'
        self.assertEqual(strip_yaml_frontmatter(content), content)

    def test_real_backup_file_format(self):
        """Mirrors the exact frontmatter format written by build_yaml_frontmatter()."""
        content = (
            '---\n'
            'date: 2026-06-03\n'
            'title: "[Duff] Daily stand-up"\n'
            'source: google-meet\n'
            'duration_min: 26\n'
            'tags: [meeting, 2026/06]\n'
            '---\n'
            '## Attendees\n\nAlice, Bob\n\n## Summary\n\nMeeting notes.'
        )
        result = strip_yaml_frontmatter(content)
        self.assertNotIn('date:', result)
        self.assertNotIn('source:', result)
        self.assertIn('## Attendees', result)


class TestNormalizeHeadings(unittest.TestCase):
    """normalize_headings — retroactive cleanup of old backup files for manual recovery."""

    def test_dash_glued_heading_promoted(self):
        """---Attendees (Gemini delimiter glued to heading) is promoted to ## Attendees."""
        result = normalize_headings("---Attendees\n\nAlice, Bob")
        self.assertIn("## Attendees", result)
        self.assertNotIn("---Attendees", result)

    def test_four_dash_line_leaves_no_orphan_dash(self):
        """A 4-dash separator line is not half-consumed into an orphan '-' line.

        Regression for the greedy-backtrack bug: ^-{3,}(?=\\S) consumed 3 of 4
        dashes and left a stray '-'.
        """
        result = normalize_headings("## Summary\n\nDecision.\n\n----\n\n## Action Items")
        orphan_lines = [ln for ln in result.splitlines() if ln.strip() == '-']
        self.assertEqual(orphan_lines, [], f"4-dash line left an orphan dash: {result!r}")

    def test_five_dash_line_leaves_no_orphan_dash(self):
        """A 5-dash separator line is also not mangled into a stray '-'."""
        result = normalize_headings("## Summary\n\n-----\n\nText.")
        orphan_lines = [ln for ln in result.splitlines() if ln.strip() == '-']
        self.assertEqual(orphan_lines, [], f"5-dash line left an orphan dash: {result!r}")

    def test_bare_section_name_promoted(self):
        """A bare section name on its own line is promoted to a ## heading."""
        result = normalize_headings("Summary\n\nWe shipped it.")
        self.assertRegex(result, r'^## Summary', re.MULTILINE)


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


class TestCleanupCache(unittest.TestCase):

    def test_removes_old_md_keeps_recent(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            old = d / "old.md"; old.write_text("x", encoding="utf-8")
            new = d / "new.md"; new.write_text("y", encoding="utf-8")
            os.utime(old, (time.time() - 10_000, time.time() - 10_000))
            pc.cleanup_cache(d, max_age_seconds=7200)
            self.assertFalse(old.exists())
            self.assertTrue(new.exists())

    def test_noop_on_missing_dir(self):
        pc.cleanup_cache(Path("/no/such/dir"))  # must not raise


class TestStageForCraft(unittest.TestCase):

    def test_copies_to_uploads_with_clean_name(self):
        with tempfile.TemporaryDirectory() as up, tempfile.TemporaryDirectory() as src:
            srcf = Path(src) / "note.md"
            srcf.write_text("body content", encoding="utf-8")
            with patch.object(pc, "CRAFT_UPLOADS_DIR", Path(up)):
                dest = pc.stage_for_craft(srcf, "My Meeting / Q3")
            self.assertTrue(dest.exists())
            self.assertEqual(dest.read_text(encoding="utf-8"), "body content")
            self.assertTrue(dest.suffix == ".md")


class TestPruneCraftUploads(unittest.TestCase):

    def test_prunes_old_files(self):
        with tempfile.TemporaryDirectory() as up:
            d = Path(up)
            old = d / "old.md"; old.write_text("x", encoding="utf-8")
            os.utime(old, (time.time() - 3 * 86400, time.time() - 3 * 86400))
            with patch.object(pc, "CRAFT_UPLOADS_DIR", d):
                pc._prune_craft_uploads(max_age_days=1)
            self.assertFalse(old.exists())


class TestOpenUrl(unittest.TestCase):
    """open_url — timeout + missing-binary handling (ARCH-2)."""

    def test_timeout_returns_124(self):
        with patch.object(pc.subprocess, 'run',
                          side_effect=pc.subprocess.TimeoutExpired(cmd='open', timeout=30)):
            self.assertEqual(pc.open_url('craftdocs://x'), 124)

    def test_missing_open_returns_127(self):
        with patch.object(pc.subprocess, 'run', side_effect=FileNotFoundError):
            self.assertEqual(pc.open_url('craftdocs://x'), 127)

    def test_success_returns_code(self):
        import types as _t
        with patch.object(pc.subprocess, 'run',
                          return_value=_t.SimpleNamespace(returncode=0)) as mrun:
            self.assertEqual(pc.open_url('craftdocs://x', background=True), 0)
        _, kwargs = mrun.call_args
        self.assertIn('timeout', kwargs)


class TestMainPush(unittest.TestCase):

    def test_main_strips_frontmatter_double_encodes_and_opens(self):
        with tempfile.TemporaryDirectory() as tmp:
            cf = Path(tmp) / "note.md"
            cf.write_text('---\ndate: 2026-06-01\ntitle: "T"\n---\n## Summary\n50% done.',
                          encoding="utf-8")
            opened = {}
            with patch.object(pc.sys, "argv",
                              ["push_to_craft.py", "--title", "20260601 Test",
                               "--content-file", str(cf), "--background"]), \
                    patch.object(pc, "open_url", side_effect=lambda url, background=False: opened.setdefault("url", url) or 0):
                rc = pc.main()
            self.assertEqual(rc, 0)
            self.assertTrue(opened["url"].startswith("craftdocs://createdocument?"))
            self.assertIn("%2525", opened["url"])          # % double-encoded
            self.assertNotIn("date%3A", opened["url"])      # frontmatter stripped (no 'date:')

    def test_main_missing_file_returns_2(self):
        with patch.object(pc.sys, "argv",
                          ["push_to_craft.py", "--title", "T",
                           "--content-file", "/no/such/file.md"]):
            self.assertEqual(pc.main(), 2)


if __name__ == "__main__":
    unittest.main()
