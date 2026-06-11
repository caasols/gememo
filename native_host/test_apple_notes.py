#!/usr/bin/env python3
"""Unit and integration tests for Apple Notes output in meeting_minutes_host.py."""

import os
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as mh
from meeting_minutes_host import (
    body_to_html, build_apple_notes_body, push_to_apple_notes, route_output, notify,
)

# The integration tests below create real notes via `osascript`, which LAUNCHES
# Apple Notes on macOS. They are opt-in so the default `npm run test:all` never
# opens Notes. Run them deliberately with:
#     GEMEMO_NOTES_INTEGRATION=1 python3 -m pytest native_host/test_apple_notes.py
RUN_NOTES_INTEGRATION = os.environ.get('GEMEMO_NOTES_INTEGRATION') == '1'
_TEST_PREFIX = 'GEMEMO_TEST_'


def _delete_test_notes() -> None:
    """Delete all Apple Notes whose name starts with GEMEMO_TEST_."""
    script = (
        'tell application "Notes"\n'
        f'  set toDelete to (every note whose name starts with "{_TEST_PREFIX}")\n'
        '  repeat with n in toDelete\n'
        '    delete n\n'
        '  end repeat\n'
        'end tell'
    )
    subprocess.run(['osascript', '-e', script], capture_output=True)


class TestBodyToHtml(unittest.TestCase):

    def test_heading_converted(self):
        """## Heading becomes <h2>Heading</h2>."""
        self.assertEqual(body_to_html('## Summary'), '<h2>Summary</h2>')

    def test_dash_bullets_become_ul(self):
        """Lines starting with '- ' become <ul><li>...</li></ul>."""
        result = body_to_html('- item one\n- item two')
        self.assertEqual(result, '<ul><li>item one</li><li>item two</li></ul>')

    def test_bullet_char_bullets_become_ul(self):
        """Lines starting with '• ' become <ul><li>...</li></ul>."""
        result = body_to_html('• item one\n• item two')
        self.assertEqual(result, '<ul><li>item one</li><li>item two</li></ul>')

    def test_consecutive_bullets_single_ul(self):
        """Three consecutive bullet lines produce exactly one <ul> block."""
        result = body_to_html('- a\n- b\n- c')
        self.assertEqual(result.count('<ul>'), 1)
        self.assertEqual(result.count('<li>'), 3)

    def test_paragraph_wrapped_in_p(self):
        """Plain prose lines are wrapped in <p>...</p>."""
        result = body_to_html('Some plain text here.')
        self.assertIn('<p>', result)
        self.assertIn('Some plain text here.', result)

    def test_full_note_structure(self):
        """A complete note produces headings, bullets, and paragraphs in order."""
        note = (
            '## Attendees\nAlice, Bob\n\n'
            '## Summary\nWe discussed the Q3 plan.\n\n'
            '## Action Items\n- Alice to write spec\n- Bob to review'
        )
        result = body_to_html(note)
        self.assertIn('<h2>Attendees</h2>', result)
        self.assertIn('<h2>Summary</h2>', result)
        self.assertIn('<h2>Action Items</h2>', result)
        self.assertIn('<ul>', result)
        self.assertIn('<li>Alice to write spec</li>', result)
        self.assertIn('<li>Bob to review</li>', result)
        # Headings come before bullets in result
        self.assertLess(result.index('<h2>Action Items</h2>'), result.index('<ul>'))

    def test_empty_string(self):
        """Empty input produces empty output."""
        self.assertEqual(body_to_html(''), '')

    def test_separator_line_stripped(self):
        """A line of three or more dashes is stripped entirely (Gemini artifact)."""
        self.assertEqual(body_to_html('---'), '')

    def test_separator_four_dashes_stripped(self):
        """Four dashes also stripped."""
        self.assertEqual(body_to_html('----'), '')

    def test_first_heading_no_br_prefix(self):
        """First <h2> heading has no <br> prefix."""
        result = body_to_html('## Attendees\nAlice')
        self.assertTrue(result.startswith('<h2>Attendees</h2>'),
                        f'Should not start with <br>: {result!r}')

    def test_second_heading_has_br_prefix(self):
        """Second <h2> heading is preceded by <br>."""
        result = body_to_html('## Summary\nText.\n\n## Action Items\n- task')
        self.assertIn('<br><h2>Action Items</h2>', result)

    def test_separator_between_sections_removed(self):
        """--- between sections disappears, sections still separated by <br>."""
        result = body_to_html('## Summary\nText.\n---\n## Action Items\n- task')
        self.assertNotIn('---', result)
        self.assertIn('<br><h2>Action Items</h2>', result)

    def test_separator_at_start_stripped(self):
        """--- at the very start of the note is stripped."""
        result = body_to_html('---\n## Summary\nText.')
        self.assertFalse(result.startswith('---'), repr(result[:30]))
        self.assertIn('<h2>Summary</h2>', result)

    def test_each_prose_line_own_paragraph(self):
        """Each non-blank prose line becomes its own <p>, not joined with neighbours."""
        result = body_to_html('Alice: Do X by Friday.\nBob: Do Y. No deadline set.')
        self.assertEqual(result.count('<p>'), 2,
                         f'Expected 2 <p> elements, got: {result!r}')
        self.assertIn('<p>Alice: Do X by Friday.</p>', result)
        self.assertIn('<p>Bob: Do Y. No deadline set.</p>', result)

    def test_blank_line_separated_prose_each_own_paragraph(self):
        """Blank-line-separated prose blocks each produce their own <p>."""
        result = body_to_html('Topic one: explanation.\n\nAnother topic: more detail.')
        self.assertEqual(result.count('<p>'), 2,
                         f'Expected 2 <p> elements, got: {result!r}')

    def test_attendees_line_own_paragraph(self):
        """Attendees list (single prose line after heading) gets its own <p>."""
        result = body_to_html('## Attendees\nAlice, Bob, Carlos')
        self.assertIn('<h2>Attendees</h2>', result)
        self.assertIn('<p>Alice, Bob, Carlos</p>', result)

    def test_no_empty_paragraph_between_headings(self):
        """No <p></p> or <ul></ul> emitted when a section has no content."""
        result = body_to_html('## Open Questions\n\n## Action Items\n- task')
        self.assertNotIn('<p></p>', result)
        self.assertNotIn('<ul></ul>', result)

    def test_full_real_note_structure(self):
        """Full realistic note renders all sections with proper element counts."""
        note = (
            '## Attendees\n'
            'Alice, Bob, Carlos\n\n'
            '## Summary\n'
            'The team discussed the Q3 plan.\n\n'
            '## Key Points\n'
            'Topic one: explanation here.\n\n'
            'Another topic: more explanation.\n\n'
            '## Action Items\n'
            'Alice: Do X by Friday.\n'
            'Bob: Do Y. No deadline set.\n\n'
            '## Open Questions\n'
            'What about Z?'
        )
        result = body_to_html(note)
        # All headings present
        for heading in ('Attendees', 'Summary', 'Key Points', 'Action Items', 'Open Questions'):
            self.assertIn(f'<h2>{heading}</h2>', result)
        # Each action item on its own line → two separate <p> elements in that section
        self.assertIn('<p>Alice: Do X by Friday.</p>', result)
        self.assertIn('<p>Bob: Do Y. No deadline set.</p>', result)
        # Key Points prose paragraphs separated by blank line → two separate <p>
        self.assertIn('<p>Topic one: explanation here.</p>', result)
        self.assertIn('<p>Another topic: more explanation.</p>', result)


class TestBuildAppleNotesBody(unittest.TestCase):
    """build_apple_notes_body — leads the note with an <h1> title so Apple Notes
    renders it in its 24px 'Title' style (and derives the note name from it),
    instead of relying on the AppleScript `name` property, which Notes renders
    as a plain, un-styled first line that looks smaller than the <h2> headings."""

    def test_prepends_h1_title_before_body(self):
        out = build_apple_notes_body('My Meeting', '<h2>Attendees</h2><p>Alice</p>')
        self.assertTrue(out.startswith('<h1>My Meeting</h1>'),
                        f'Title must lead the body: {out!r}')
        # The title comes before the first heading.
        self.assertLess(out.index('<h1>My Meeting</h1>'), out.index('<h2>Attendees</h2>'))

    def test_separates_title_from_first_heading(self):
        """A <br> sits between the title and the first heading so they don't hug."""
        out = build_apple_notes_body('My Meeting', '<h2>Attendees</h2>')
        self.assertIn('</h1><br><h2>', out)

    def test_escapes_html_special_chars_in_title(self):
        """& < > " in the title must be HTML-escaped so the title isn't mangled."""
        out = build_apple_notes_body('A & B <Product> "Review"', '<h2>X</h2>')
        self.assertIn('A &amp; B &lt;Product&gt; &quot;Review&quot;', out)
        self.assertNotIn('<Product>', out)

    def test_blank_title_returns_body_unchanged(self):
        body = '<h2>Attendees</h2><p>Alice</p>'
        self.assertEqual(build_apple_notes_body('', body), body)
        self.assertEqual(build_apple_notes_body('   ', body), body)

    def test_push_drops_applescript_name_property(self):
        """push_to_apple_notes must no longer set a `name` property — the note
        name is derived by Apple Notes from the leading <h1>. The generated
        AppleScript creates the note with {body:noteBody} only."""
        with patch.object(mh.subprocess, 'run',
                          return_value=types.SimpleNamespace(returncode=0)) as mrun:
            push_to_apple_notes('My Meeting', '<h2>Attendees</h2>')
        args, _ = mrun.call_args
        script = args[0][2]  # ['osascript', '-e', <script>]
        self.assertIn('{body:noteBody}', script)
        self.assertNotIn('name:', script)


class TestSubprocessTimeouts(unittest.TestCase):
    """ARCH-2 — osascript calls must carry a timeout so the host can't hang forever."""

    def test_push_to_apple_notes_sets_timeout(self):
        with patch.object(mh.subprocess, 'run',
                          return_value=types.SimpleNamespace(returncode=0)) as mrun:
            push_to_apple_notes('T', '<p>x</p>')
        _, kwargs = mrun.call_args
        self.assertIn('timeout', kwargs)
        self.assertGreater(kwargs['timeout'], 0)

    def test_notify_swallows_timeout(self):
        with patch.object(mh.subprocess, 'run',
                          side_effect=subprocess.TimeoutExpired(cmd='osascript', timeout=10)):
            notify('Title', 'message')  # must not raise

    def test_notify_sets_timeout(self):
        with patch.object(mh.subprocess, 'run',
                          return_value=types.SimpleNamespace(returncode=0)) as mrun:
            notify('Title', 'message')
        _, kwargs = mrun.call_args
        self.assertIn('timeout', kwargs)


class TestRouteOutput(unittest.TestCase):
    """Unit tests for route_output() — no I/O, all deps injected."""

    def _deps(self):
        pushed, notified, sent = [], [], []
        return (
            pushed, notified, sent,
            lambda t, h: pushed.append((t, h)),
            lambda t, m: notified.append((t, m)),
            lambda r: sent.append(r),
        )

    def test_apple_notes_calls_push_and_returns_true(self):
        pushed, notified, sent, push_fn, note_fn, send_fn = self._deps()
        result = route_output(
            'apple_notes', '## Summary\nTest content', 'My Meeting', None,
            apple_push_fn=push_fn, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertTrue(result)
        self.assertEqual(len(pushed), 1)
        self.assertEqual(pushed[0][0], 'My Meeting')
        self.assertIn('<h2>Summary</h2>', pushed[0][1])
        self.assertEqual(sent[0]['status'], 'ok')
        self.assertEqual(sent[0]['title'], 'My Meeting')

    def test_none_sends_ok_without_push_and_returns_true(self):
        pushed, notified, sent, push_fn, note_fn, send_fn = self._deps()
        result = route_output(
            'none', '## Summary\nTest', 'Meeting', None,
            apple_push_fn=push_fn, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertTrue(result)
        self.assertEqual(len(pushed), 0, 'apple push must not be called for none')
        self.assertEqual(sent[0]['status'], 'ok')

    def test_craft_returns_false_without_sending(self):
        pushed, notified, sent, push_fn, note_fn, send_fn = self._deps()
        result = route_output(
            'craft', '## Summary\nTest', 'Meeting', None,
            apple_push_fn=push_fn, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertFalse(result)
        self.assertEqual(len(sent), 0, 'nothing should be sent for craft fallthrough')
        self.assertEqual(len(pushed), 0)

    def test_apple_notes_includes_file_path_in_response(self):
        _, _, sent, push_fn, note_fn, send_fn = self._deps()
        from pathlib import Path
        fp = Path('/tmp/test-backup.md')
        route_output(
            'apple_notes', '## Summary\nContent', 'Meeting', fp,
            apple_push_fn=push_fn, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertEqual(sent[0].get('file'), str(fp))

    def test_none_includes_file_path_in_response(self):
        _, _, sent, push_fn, note_fn, send_fn = self._deps()
        from pathlib import Path
        fp = Path('/tmp/test-backup.md')
        route_output(
            'none', '## Summary\nContent', 'Meeting', fp,
            apple_push_fn=push_fn, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertEqual(sent[0].get('file'), str(fp))

    def test_apple_notes_push_error_sends_error_response(self):
        _, _, sent, _, note_fn, send_fn = self._deps()
        def failing_push(title, html):
            raise RuntimeError('osascript failed')
        route_output(
            'apple_notes', '## Summary\nContent', 'Meeting', None,
            apple_push_fn=failing_push, notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertEqual(sent[0]['status'], 'error')
        self.assertIn('osascript failed', sent[0]['error'])

    def test_obsidian_writes_file_and_returns_true(self):
        """obsidian branch writes file to vault path and sends ok."""
        import tempfile
        _, _, sent, push_fn, note_fn, send_fn = self._deps()
        with tempfile.TemporaryDirectory() as vault:
            result = route_output(
                'obsidian', '## Summary\nTest content', '20260531 20:57 Meeting', None,
                obsidian_vault_path=vault,
                notify_fn=note_fn, send_fn=send_fn,
            )
            self.assertTrue(result)
            md_files = list(Path(vault).glob('*.md'))
            self.assertEqual(len(md_files), 1, 'Expected exactly one .md file in vault')
            content = md_files[0].read_text(encoding='utf-8')
            self.assertTrue(content.startswith('---\n'), 'Should have YAML frontmatter')
            self.assertIn('## Summary', content)
            self.assertEqual(sent[0]['status'], 'ok')

    def test_obsidian_write_failure_sends_error(self):
        """An unwritable vault path is caught and reported, not raised."""
        import tempfile
        _, _, sent, push_fn, note_fn, send_fn = self._deps()
        with tempfile.NamedTemporaryFile() as f:
            # A path *under* a regular file can't be created → mkdir raises → caught.
            result = route_output(
                'obsidian', '## Summary\nx', '20260101 09:00 Meeting', None,
                obsidian_vault_path=f.name + '/cannot',
                notify_fn=note_fn, send_fn=send_fn,
            )
        self.assertTrue(result)
        self.assertEqual(sent[0]['status'], 'error')

    def test_obsidian_no_vault_path_sends_error(self):
        """obsidian branch with empty vault path sends error and returns True."""
        _, _, sent, push_fn, note_fn, send_fn = self._deps()
        result = route_output(
            'obsidian', '## Summary\nTest', 'Meeting', None,
            obsidian_vault_path='',
            notify_fn=note_fn, send_fn=send_fn,
        )
        self.assertTrue(result)
        self.assertEqual(sent[0]['status'], 'error')
        self.assertIn('vault path not set', sent[0]['error'])


@unittest.skipUnless(
    RUN_NOTES_INTEGRATION,
    'opt-in: set GEMEMO_NOTES_INTEGRATION=1 (these tests launch Apple Notes)',
)
class TestPushToAppleNotesIntegration(unittest.TestCase):
    """Integration tests — actually create and verify notes in Apple Notes.

    Skipped by default because creating notes via osascript launches the Apple
    Notes app. Opt in with GEMEMO_NOTES_INTEGRATION=1.
    """

    TEST_TITLE = f'{_TEST_PREFIX}Integration'

    def tearDown(self) -> None:
        _delete_test_notes()

    def _note_count(self, title: str) -> int:
        script = (
            'tell application "Notes"\n'
            f'  set n to (every note whose name is "{title}")\n'
            '  return (count of n) as string\n'
            'end tell'
        )
        result = subprocess.run(['osascript', '-e', script],
                                capture_output=True, text=True)
        try:
            return int(result.stdout.strip())
        except ValueError:
            return 0

    def test_creates_note_with_correct_title(self):
        """push_to_apple_notes creates exactly one note with the expected title."""
        html = '<h2>Summary</h2><p>Test meeting content.</p><ul><li>Action item</li></ul>'
        push_to_apple_notes(self.TEST_TITLE, html)
        self.assertEqual(self._note_count(self.TEST_TITLE), 1,
                         f'Expected 1 note titled {self.TEST_TITLE!r} in Apple Notes')

    def test_title_with_double_quotes_does_not_crash(self):
        """push_to_apple_notes handles a title containing double quotes."""
        title = f'{_TEST_PREFIX}Quote"Test'
        safe_for_verify = title.replace('"', '\\"')
        push_to_apple_notes(title, '<p>Quote test.</p>')
        # Verify via a contains check (embedding escaped quotes in osascript is complex)
        script = (
            'tell application "Notes"\n'
            f'  set n to (every note whose name starts with "{_TEST_PREFIX}Quote")\n'
            '  return (count of n) as string\n'
            'end tell'
        )
        result = subprocess.run(['osascript', '-e', script],
                                capture_output=True, text=True)
        count = int(result.stdout.strip()) if result.stdout.strip().isdigit() else 0
        self.assertGreaterEqual(count, 1, 'Expected note with quoted title to be created')


if __name__ == '__main__':
    unittest.main()
