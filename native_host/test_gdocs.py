#!/usr/bin/env python3
"""Unit tests for the pure + injectable layer of gdocs.py (5.7) — no Google libs required.

Mirrors test_gcal.py: pure functions are tested directly; create_doc is exercised
with an injected fake service object (no network); token/file ops use a tmp CONFIG_DIR.
"""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gdocs


class TestMarkdownToDocsRequests(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        self.assertEqual(gdocs.markdown_to_docs_requests(""), [])
        self.assertEqual(gdocs.markdown_to_docs_requests("   \n  \n"), [])
        self.assertEqual(gdocs.markdown_to_docs_requests(None), [])

    def _texts(self, reqs):
        """All inserted text fragments, in order."""
        return [r["insertText"]["text"] for r in reqs if "insertText" in r]

    def _styles(self, reqs):
        return [r["updateParagraphStyle"] for r in reqs if "updateParagraphStyle" in r]

    def test_headings_each_level(self):
        for md, named in (("# Title", "HEADING_1"),
                          ("## Section", "HEADING_2"),
                          ("### Sub", "HEADING_3")):
            reqs = gdocs.markdown_to_docs_requests(md)
            styles = self._styles(reqs)
            self.assertTrue(styles, f"no paragraph style for {md!r}")
            self.assertEqual(styles[0]["paragraphStyle"]["namedStyleType"], named)
            # heading marker stripped from inserted text
            self.assertIn("Title".replace("Title", md.lstrip("# ").strip()),
                          "".join(self._texts(reqs)))

    def test_bullets_emit_create_paragraph_bullets(self):
        for md in ("- one", "* two"):
            reqs = gdocs.markdown_to_docs_requests(md)
            self.assertTrue(any("createParagraphBullets" in r for r in reqs),
                            f"no bullets for {md!r}")
            # bullet marker stripped from inserted text
            joined = "".join(self._texts(reqs))
            self.assertNotIn("- ", joined)
            self.assertNotIn("* ", joined)

    def test_bold_emits_update_text_style_ranges(self):
        reqs = gdocs.markdown_to_docs_requests("hello **world** bye")
        bolds = [r["updateTextStyle"] for r in reqs if "updateTextStyle" in r]
        self.assertTrue(bolds, "no bold range emitted")
        self.assertTrue(bolds[0]["textStyle"]["bold"])
        # the inserted text has the ** markers stripped
        self.assertIn("hello world bye", "".join(self._texts(reqs)))
        self.assertNotIn("**", "".join(self._texts(reqs)))

    def test_plain_line_inserted_verbatim(self):
        reqs = gdocs.markdown_to_docs_requests("just a plain line")
        self.assertIn("just a plain line", "".join(self._texts(reqs)))
        self.assertFalse(any("updateParagraphStyle" in r for r in reqs))
        self.assertFalse(any("createParagraphBullets" in r for r in reqs))

    def test_unknown_degrades_to_plain_never_raises(self):
        # weird/unsupported markdown should still produce text, not raise
        reqs = gdocs.markdown_to_docs_requests("> blockquote `code` ~~strike~~")
        self.assertIn("blockquote", "".join(self._texts(reqs)))

    def test_mixed_document(self):
        md = "# Heading\n\nIntro line.\n- bullet one\n- bullet **two**\n## Sub\nplain"
        reqs = gdocs.markdown_to_docs_requests(md)
        self.assertTrue(reqs)
        joined = "".join(self._texts(reqs))
        for frag in ("Heading", "Intro line.", "bullet one", "bullet two", "Sub", "plain"):
            self.assertIn(frag, joined)
        named = [r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
                 for r in reqs if "updateParagraphStyle" in r]
        self.assertIn("HEADING_1", named)
        self.assertIn("HEADING_2", named)
        self.assertTrue(any("createParagraphBullets" in r for r in reqs))
        self.assertTrue(any("updateTextStyle" in r for r in reqs))

    def test_indices_are_monotonic(self):
        """Insertion indices must never go backwards (single forward pass)."""
        reqs = gdocs.markdown_to_docs_requests("# H\nbody\n- b1\n- b2")
        last = 0
        for r in reqs:
            if "insertText" in r:
                idx = r["insertText"]["location"]["index"]
                self.assertGreaterEqual(idx, last)
                last = idx


class _FakeExecutable:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class _FakeDocuments:
    """Records create/batchUpdate calls and returns canned results."""
    def __init__(self, create_result, batch_result=None, fail_on=None):
        self.create_result = create_result
        self.batch_result = batch_result or {}
        self.fail_on = fail_on
        self.calls = []

    def create(self, body=None):
        self.calls.append(("create", {"body": body}))
        if self.fail_on == "create":
            raise RuntimeError("create boom")
        return _FakeExecutable(self.create_result)

    def batchUpdate(self, documentId=None, body=None):
        self.calls.append(("batchUpdate", {"documentId": documentId, "body": body}))
        if self.fail_on == "batchUpdate":
            raise RuntimeError("batch boom")
        return _FakeExecutable(self.batch_result)


class _FakeService:
    def __init__(self, documents):
        self._documents = documents

    def documents(self):
        return self._documents


class TestCreateDoc(unittest.TestCase):
    def test_create_doc_success(self):
        docs = _FakeDocuments(create_result={"documentId": "DOC123"})
        svc = _FakeService(docs)
        out = gdocs.create_doc("My Title", "# Heading\nbody", service=svc)
        self.assertTrue(out["ok"])
        self.assertEqual(out["docId"], "DOC123")
        self.assertEqual(out["url"], "https://docs.google.com/document/d/DOC123/edit")
        # create called with the title
        create_call = [c for c in docs.calls if c[0] == "create"][0]
        self.assertEqual(create_call[1]["body"], {"title": "My Title"})
        # batchUpdate called with the right docId and a requests list
        batch_call = [c for c in docs.calls if c[0] == "batchUpdate"][0]
        self.assertEqual(batch_call[1]["documentId"], "DOC123")
        self.assertIn("requests", batch_call[1]["body"])
        self.assertIsInstance(batch_call[1]["body"]["requests"], list)

    def test_create_doc_empty_body_still_creates(self):
        docs = _FakeDocuments(create_result={"documentId": "EMPTY1"})
        svc = _FakeService(docs)
        out = gdocs.create_doc("Empty", "", service=svc)
        self.assertTrue(out["ok"])
        self.assertEqual(out["docId"], "EMPTY1")
        # batchUpdate still called, with an empty requests list
        batch_call = [c for c in docs.calls if c[0] == "batchUpdate"][0]
        self.assertEqual(batch_call[1]["body"]["requests"], [])

    def test_create_doc_create_failure_returns_not_ok(self):
        docs = _FakeDocuments(create_result={}, fail_on="create")
        svc = _FakeService(docs)
        out = gdocs.create_doc("X", "body", service=svc)
        self.assertFalse(out["ok"])
        self.assertIn("error", out)

    def test_create_doc_batch_failure_returns_not_ok(self):
        docs = _FakeDocuments(create_result={"documentId": "D"}, fail_on="batchUpdate")
        svc = _FakeService(docs)
        out = gdocs.create_doc("X", "body", service=svc)
        self.assertFalse(out["ok"])
        self.assertIn("error", out)

    def test_create_doc_missing_document_id_returns_not_ok(self):
        docs = _FakeDocuments(create_result={})  # no documentId
        svc = _FakeService(docs)
        out = gdocs.create_doc("X", "body", service=svc)
        self.assertFalse(out["ok"])

    def test_create_doc_never_raises(self):
        # a service that explodes everywhere must still yield {ok: False}
        class Boom:
            def documents(self):
                raise RuntimeError("total failure")
        out = gdocs.create_doc("X", "body", service=Boom())
        self.assertFalse(out["ok"])

    def test_create_doc_not_connected_when_no_creds(self):
        # No injected service/creds and _load_creds → None ⇒ not_connected,
        # without ever touching build()/the network (covers gdocs.py 184-188).
        from unittest.mock import patch
        with patch.object(gdocs, '_load_creds', return_value=None):
            out = gdocs.create_doc("X", "body")
        self.assertEqual(out, {"ok": False, "error": "not_connected"})


class TestTokenOps(unittest.TestCase):
    """Token/file ops — testable without the Google libraries."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = (gdocs.CONFIG_DIR, gdocs.TOKEN_PATH)
        gdocs.CONFIG_DIR = Path(self.tmp)
        gdocs.TOKEN_PATH = Path(self.tmp) / "token_docs.json"

    def tearDown(self):
        gdocs.CONFIG_DIR, gdocs.TOKEN_PATH = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_token_path_is_distinct_from_calendar(self):
        # The Docs token file must NOT be Calendar's token.json.
        self.assertTrue(str(gdocs.TOKEN_PATH).endswith("token_docs.json"))

    def test_disconnect_removes_token(self):
        gdocs.TOKEN_PATH.write_text("{}")
        r = gdocs.disconnect()
        self.assertTrue(r["ok"])
        self.assertFalse(gdocs.TOKEN_PATH.exists())

    def test_disconnect_noop_when_absent(self):
        self.assertTrue(gdocs.disconnect()["ok"])

    def test_load_creds_none_without_token(self):
        self.assertIsNone(gdocs._load_creds())

    def test_status_when_libs_unavailable(self):
        if gdocs.GDOCS_AVAILABLE:
            self.skipTest("google libs present on this machine")
        s = gdocs.status()
        self.assertFalse(s["connected"])
        self.assertFalse(s["available"])

    def test_scopes_is_documents_only(self):
        self.assertEqual(gdocs.SCOPES, ["https://www.googleapis.com/auth/documents"])


if __name__ == "__main__":
    unittest.main()
