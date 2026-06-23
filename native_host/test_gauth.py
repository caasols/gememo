#!/usr/bin/env python3
"""Unit tests for gauth.py — the combined one-flow Google connect (Calendar +
Docs in a single consent). No live OAuth; the google libs may be absent. We
assert structure + the token/account file ops + the status logic, mocking the
google libs where a real grant would otherwise be required."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import gauth


class TestScopesAndPaths(unittest.TestCase):
    """The combined module must request BOTH scopes and write to the SAME paths
    that gcal.py / gdocs.py read (so both existing modules pick up the token)."""

    def test_requests_both_scopes(self):
        self.assertIn('https://www.googleapis.com/auth/calendar.readonly', gauth.SCOPES)
        self.assertIn('https://www.googleapis.com/auth/documents', gauth.SCOPES)

    def test_token_paths_match_gcal_and_gdocs(self):
        import gcal
        import gdocs
        self.assertEqual(gauth.TOKEN_PATH.name, gcal.TOKEN_PATH.name)
        self.assertEqual(gauth.DOCS_TOKEN_PATH.name, gdocs.TOKEN_PATH.name)
        # Same config dir so the on-disk files line up.
        self.assertEqual(gauth.TOKEN_PATH.parent, gcal.TOKEN_PATH.parent)
        self.assertEqual(gauth.DOCS_TOKEN_PATH.parent, gdocs.TOKEN_PATH.parent)


class TestTokenOps(unittest.TestCase):
    """Token/account file ops — testable without the Google libraries."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = (gauth.CONFIG_DIR, gauth.TOKEN_PATH,
                      gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH)
        gauth.CONFIG_DIR = Path(self.tmp)
        gauth.TOKEN_PATH = Path(self.tmp) / "token.json"
        gauth.DOCS_TOKEN_PATH = Path(self.tmp) / "token_docs.json"
        gauth.ACCOUNT_PATH = Path(self.tmp) / "account.json"

    def tearDown(self):
        (gauth.CONFIG_DIR, gauth.TOKEN_PATH,
         gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH) = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_disconnect_removes_all_three_files(self):
        gauth.TOKEN_PATH.write_text("{}")
        gauth.DOCS_TOKEN_PATH.write_text("{}")
        gauth.ACCOUNT_PATH.write_text('{"email":"x@y.com"}')
        r = gauth.disconnect()
        self.assertTrue(r["ok"])
        self.assertFalse(gauth.TOKEN_PATH.exists())
        self.assertFalse(gauth.DOCS_TOKEN_PATH.exists())
        self.assertFalse(gauth.ACCOUNT_PATH.exists())

    def test_disconnect_noop_when_absent(self):
        self.assertTrue(gauth.disconnect()["ok"])

    def test_status_not_connected_without_tokens(self):
        if not gauth.GAUTH_AVAILABLE:
            self.skipTest("covered by the libs-unavailable test below")
        s = gauth.status()
        self.assertFalse(s["connected"])
        self.assertTrue(s["available"])

    def test_status_when_libs_unavailable(self):
        if gauth.GAUTH_AVAILABLE:
            self.skipTest("google libs present on this machine")
        s = gauth.status()
        self.assertFalse(s["connected"])
        self.assertFalse(s["available"])


class TestStatusLogic(unittest.TestCase):
    """status() must report connected only when BOTH token files load valid creds.
    Inject fakes so no real tokens/libs are needed."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = (gauth.CONFIG_DIR, gauth.TOKEN_PATH,
                      gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH)
        gauth.CONFIG_DIR = Path(self.tmp)
        gauth.TOKEN_PATH = Path(self.tmp) / "token.json"
        gauth.DOCS_TOKEN_PATH = Path(self.tmp) / "token_docs.json"
        gauth.ACCOUNT_PATH = Path(self.tmp) / "account.json"

    def tearDown(self):
        (gauth.CONFIG_DIR, gauth.TOKEN_PATH,
         gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH) = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _valid(self):
        c = Mock()
        c.valid = True
        return c

    def _invalid(self):
        c = Mock()
        c.valid = False
        return c

    def test_connected_when_both_creds_valid(self):
        gauth.ACCOUNT_PATH.write_text('{"email":"me@x.com"}')
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, '_load_creds_for',
                             side_effect=lambda p: self._valid()):
            s = gauth.status()
        self.assertTrue(s["connected"])
        self.assertEqual(s["email"], "me@x.com")

    def test_not_connected_when_calendar_missing(self):
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, '_load_creds_for',
                             side_effect=lambda p: None if p == gauth.TOKEN_PATH else self._valid()):
            s = gauth.status()
        self.assertFalse(s["connected"])

    def test_not_connected_when_docs_missing(self):
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, '_load_creds_for',
                             side_effect=lambda p: None if p == gauth.DOCS_TOKEN_PATH else self._valid()):
            s = gauth.status()
        self.assertFalse(s["connected"])

    def test_needs_reconnect_when_a_cred_is_invalid(self):
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, '_load_creds_for',
                             side_effect=lambda p: self._invalid()):
            s = gauth.status()
        self.assertFalse(s["connected"])
        self.assertTrue(s.get("needs_reconnect"))


class TestConnectGuards(unittest.TestCase):
    """connect() guard branches — same error strings as gcal, no live flow."""

    def test_connect_blocks_when_libs_unavailable(self):
        with patch.object(gauth, 'GAUTH_AVAILABLE', False):
            r = gauth.connect()
        self.assertFalse(r["ok"])
        self.assertIn("Google libraries", r["error"])

    def test_connect_blocks_without_credentials(self):
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, 'CREDENTIALS_PATH') as cred:
            cred.exists.return_value = False
            r = gauth.connect()
        self.assertFalse(r["ok"])
        self.assertIn("credentials.json", r["error"])

    def test_connect_writes_both_tokens_and_account(self):
        """Mirror the live flow with fakes: one consent → both token files +
        account.json, RELAX_TOKEN_SCOPE set."""
        import os
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        orig = (gauth.CONFIG_DIR, gauth.TOKEN_PATH, gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH)

        def restore():
            (gauth.CONFIG_DIR, gauth.TOKEN_PATH, gauth.DOCS_TOKEN_PATH, gauth.ACCOUNT_PATH) = orig
        self.addCleanup(restore)
        gauth.CONFIG_DIR = Path(tmp)
        gauth.TOKEN_PATH = Path(tmp) / "token.json"
        gauth.DOCS_TOKEN_PATH = Path(tmp) / "token_docs.json"
        gauth.ACCOUNT_PATH = Path(tmp) / "account.json"

        fake_creds = Mock()
        fake_creds.to_json.return_value = '{"token":"abc"}'
        fake_flow = Mock()
        fake_flow.run_local_server.return_value = fake_creds

        os.environ.pop('OAUTHLIB_RELAX_TOKEN_SCOPE', None)
        with patch.object(gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(gauth, 'CREDENTIALS_PATH') as cred, \
                patch.object(gauth, 'InstalledAppFlow', create=True) as Flow, \
                patch.object(gauth, '_fetch_primary_email', return_value='me@x.com'):
            cred.exists.return_value = True
            Flow.from_client_secrets_file.return_value = fake_flow
            r = gauth.connect()

        self.assertTrue(r["ok"])
        self.assertEqual(r["email"], "me@x.com")
        # Both token files carry the SAME creds json.
        self.assertEqual(gauth.TOKEN_PATH.read_text(), '{"token":"abc"}')
        self.assertEqual(gauth.DOCS_TOKEN_PATH.read_text(), '{"token":"abc"}')
        self.assertIn("me@x.com", gauth.ACCOUNT_PATH.read_text())
        # One consent for both scopes.
        Flow.from_client_secrets_file.assert_called_once()
        self.assertEqual(Flow.from_client_secrets_file.call_args[0][1], gauth.SCOPES)
        # consent prompt requested on a random port.
        kwargs = fake_flow.run_local_server.call_args[1]
        self.assertEqual(kwargs.get("port"), 0)
        self.assertEqual(kwargs.get("prompt"), "consent")
        self.assertEqual(os.environ.get('OAUTHLIB_RELAX_TOKEN_SCOPE'), '1')


if __name__ == "__main__":
    unittest.main()
