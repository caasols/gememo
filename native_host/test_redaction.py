#!/usr/bin/env python3
"""Tests for the PII redaction pass (RB-5b) in meeting_minutes_host.py."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from meeting_minutes_host import redact_pii


class TestRedactPii(unittest.TestCase):

    def test_emails(self):
        out = redact_pii("contact alice@example.com or bob.smith+x@corp.co.uk")
        self.assertNotIn("alice@example.com", out)
        self.assertNotIn("bob.smith+x@corp.co.uk", out)
        self.assertIn("[redacted-email]", out)

    def test_phone_us_dashed(self):
        self.assertIn("[redacted-phone]", redact_pii("call 555-123-4567 today"))

    def test_phone_international_plus(self):
        self.assertIn("[redacted-phone]", redact_pii("ring +44 20 7946 0958 please"))

    def test_phone_long_run(self):
        self.assertIn("[redacted-phone]", redact_pii("number is 5551234567"))

    def test_credit_card(self):
        out = redact_pii("card 4111 1111 1111 1111 expires soon")
        self.assertIn("[redacted-number]", out)
        self.assertNotIn("4111 1111 1111 1111", out)

    def test_does_not_redact_dates_or_name_suffixes(self):
        # A spaced date and an attendee-style "Name 1" must survive.
        out = redact_pii("meeting on 2026 06 04 with Carlos 1 and Alice 2")
        self.assertIn("2026 06 04", out)
        self.assertIn("Carlos 1", out)

    def test_user_keywords_case_insensitive(self):
        out = redact_pii("Project Falcon launches Q3", keywords=["falcon"])
        self.assertNotIn("Falcon", out)
        self.assertIn("[redacted]", out)

    def test_empty_and_none(self):
        self.assertEqual(redact_pii(""), "")
        self.assertEqual(redact_pii(None), None)


if __name__ == "__main__":
    unittest.main()
