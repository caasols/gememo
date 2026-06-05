#!/usr/bin/env python3
"""Tests for wikilink generation (RB-4e) in meeting_minutes_host.py."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import apply_wikilinks


class TestApplyWikilinks(unittest.TestCase):

    def test_wraps_attendee_names(self):
        body = "Alice Chen presented. Bob asked a question."
        out = apply_wikilinks(body, ["Alice Chen", "Bob"])
        self.assertIn("[[Alice Chen]] presented", out)
        self.assertIn("[[Bob]] asked", out)

    def test_longest_name_first_no_partial_double_wrap(self):
        body = "Bob Martinez and Bob spoke."
        out = apply_wikilinks(body, ["Bob", "Bob Martinez"])
        self.assertIn("[[Bob Martinez]]", out)
        # 'Bob' inside '[[Bob Martinez]]' must not be re-wrapped.
        self.assertNotIn("[[[[", out)

    def test_idempotent_on_already_linked(self):
        body = "[[Alice Chen]] presented."
        out = apply_wikilinks(body, ["Alice Chen"])
        self.assertEqual(out.count("[[Alice Chen]]"), 1)

    def test_no_attendees_returns_body_unchanged(self):
        body = "Some notes."
        self.assertEqual(apply_wikilinks(body, []), body)
        self.assertEqual(apply_wikilinks(body, None), body)

    def test_does_not_wrap_substrings_of_other_words(self):
        body = "Roberta is here."  # 'Rob' should not match inside 'Roberta'
        out = apply_wikilinks(body, ["Rob"])
        self.assertEqual(out, body)


if __name__ == "__main__":
    unittest.main()
