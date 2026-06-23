#!/usr/bin/env python3
"""Integration tests for the main() capture orchestration in meeting_minutes_host.py.

Drives main() with read_message/send_message/subprocess mocked so the Craft push,
file backup, and snapshot-retry paths are exercised without touching Craft, the
network, or the user's cache.
"""

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as host


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class TestMainCaptureFlow(unittest.TestCase):

    def _run(self, msg, run_results):
        """Run host.main() with read_message→msg and subprocess.run yielding run_results
        (a single _proc or a list consumed per call). Returns the list of sent messages."""
        sent = []
        results = run_results if isinstance(run_results, list) else [run_results]
        it = iter(results)

        def fake_run(*a, **k):
            try:
                return next(it)
            except StopIteration:
                return _proc(0)

        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host, 'HEARTBEAT_FILE', Path(cache_tmp) / "host_heartbeat.log"), \
                patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'), \
                patch.object(host.subprocess, 'run', side_effect=fake_run):
            host.main()
            hb = Path(cache_tmp) / "host_heartbeat.log"
            self._last_heartbeat = hb.read_text(encoding="utf-8") if hb.exists() else ""
        return sent

    def _capture_msg(self, tmp, **over):
        msg = {
            "transcript": "## Summary\nWe shipped it.",
            "meetingTitle": "Q3 Planning",
            "backupType": "craft",
            "fileBackupEnabled": True,
            "fileBackupType": "markdown",
            "fileBackupPath": tmp,
            "timestamp": "2026-06-01T09:12:00Z",
            "durationMin": 30,
            "attendees": ["Alice"],
        }
        msg.update(over)
        return msg

    def test_empty_transcript_errors(self):
        sent = self._run({"transcript": "   "}, _proc(0))
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("empty", sent[-1]["error"])

    def test_craft_success_writes_backup_and_oks(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertTrue(sent[-1]["title"].endswith("Q3 Planning"))
            self.assertIn("file", sent[-1])
            mds = list(Path(tmp).glob("*.md"))
            self.assertEqual(len(mds), 1)
            content = mds[0].read_text(encoding="utf-8")
            self.assertIn('title: "Q3 Planning"', content)   # frontmatter present
            self.assertIn("duration_min: 30", content)
            self.assertIn("We shipped it.", content)

    def test_slash_in_title_sanitized_in_backup_filename(self):
        """A meeting title containing '/' must not smuggle a path separator into the
        backup filename and create a phantom subdirectory (BUG-12). The note writes
        as one flat .md and the capture oks."""
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp, meetingTitle="1:1 Carlos / Pablo"), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            mds = list(Path(tmp).glob("*.md"))            # top level only — not under a subdir
            self.assertEqual(len(mds), 1)
            self.assertFalse([p for p in Path(tmp).iterdir() if p.is_dir()])  # no phantom subdir

    def test_backup_write_failure_is_nonfatal(self):
        """A failed file-backup write must NOT abort the capture — the primary output
        still runs (BUG-12). Here the backup folder can't be created (its parent is a
        regular file), yet the Craft push succeeds and the capture oks."""
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "afile"
            blocker.write_text("x")
            bad_path = str(blocker / "sub")               # parent is a file → mkdir fails
            sent = self._run(self._capture_msg(tmp, fileBackupPath=bad_path), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")    # craft (primary) still saved
            self.assertTrue(sent[-1]["title"].endswith("Q3 Planning"))

    def test_foreign_user_backup_path_is_rehomed(self):
        """A backup path saved under a DIFFERENT Mac user (another laptop) re-homes
        to the current user — no crash, the note lands under the current home (BUG-12)."""
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / "home"
            fake_home.mkdir()
            with patch.object(host.Path, 'home', return_value=fake_home):
                sent = self._run(self._capture_msg(
                    tmp, fileBackupPath="/Users/someoneelse/Documents/gememo-meeting-notes"
                ), _proc(0))
            landed = list((fake_home / "Documents/gememo-meeting-notes").glob("*.md"))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(len(landed), 1)   # re-homed under the CURRENT home

    def test_heartbeat_records_capture_stages(self):
        """A successful Craft capture writes the ordered stage trail ending in
        'replied status=ok' (BUG-9 Layer 0)."""
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp), _proc(0))
        self.assertEqual(sent[-1]["status"], "ok")
        # Each line is "{iso} pid={pid} {stage…}" — keep the stage portion.
        stages = [ln.split(" ", 2)[2] for ln in self._last_heartbeat.strip().splitlines()]
        for expected in ["start", "parsed", "backup_written",
                         "craft_push_start", "craft_push_done", "replied"]:
            self.assertTrue(any(s.startswith(expected) for s in stages),
                            f"missing stage {expected!r} in {stages}")
        self.assertTrue(stages[-1].startswith("replied status=ok"),
                        f"last stage should be replied status=ok: {stages}")

    def test_recover_uses_freshest_snapshot(self):
        """recover:true → main() files the longer on-disk snapshot, not the
        (staler/shorter) in-flight text (RB-1d freshest-copy, BUG-9 Layer 1)."""
        with tempfile.TemporaryDirectory() as tmp:
            long_body = "## Summary\n" + "Recovered detail. " * 40
            (Path(tmp) / "20260601-091500-q3-planning-snap.md").write_text(
                "---\ntitle: Q3 Planning\n---\n" + long_body, encoding="utf-8")
            msg = self._capture_msg(tmp, transcript="## Summary\nshort stale note", recover=True)
            sent = self._run(msg, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            finals = [p for p in Path(tmp).glob("*.md") if "-snap" not in p.name]
            self.assertEqual(len(finals), 1)
            content = finals[0].read_text(encoding="utf-8")
            self.assertIn("Recovered detail.", content)        # snapshot body used
            self.assertNotIn("short stale note", content)      # in-flight text discarded

    def test_craft_failure_no_snapshot_errors_with_backup_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp), _proc(1, stderr="boom"))
            self.assertEqual(sent[-1]["status"], "error")
            self.assertIn("backupPath", sent[-1])
            self.assertIn("Craft is not running", sent[-1]["error"])  # PUSH_EXIT_MESSAGES[1]

    def test_craft_failure_retries_with_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            # A snapshot whose slug matches the meeting label ("q3-planning").
            (Path(tmp) / "20260601-120000-q3-planning-snap.md").write_text(
                "snapshot body", encoding="utf-8")
            sent = self._run(self._capture_msg(tmp), [_proc(1), _proc(0)])  # push fails, retry ok
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertTrue(sent[-1].get("retried"))

    def test_none_backuptype_routes_through_route_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp, backupType="none", fileBackupEnabled=False),
                             _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")

    def test_pii_redaction_applied_to_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            msg = self._capture_msg(
                tmp,
                transcript="## Summary\nEmail alice@example.com about Falcon.",
                redactPii=True, redactKeywords="Falcon",
            )
            self._run(msg, _proc(0))
            content = next(Path(tmp).glob("*.md")).read_text(encoding="utf-8")
            self.assertNotIn("alice@example.com", content)
            self.assertNotIn("Falcon", content)
            self.assertIn("[redacted-email]", content)

    def test_failure_fires_desktop_notification(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as cache_tmp:
            msg = self._capture_msg(tmp)
            notifs = []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value=msg), \
                    patch.object(host, 'send_message'), \
                    patch.object(host, 'notify', side_effect=lambda t, m: notifs.append((t, m))), \
                    patch.object(host.subprocess, 'run', return_value=_proc(1, stderr='boom')):
                host.main()
            self.assertTrue(any('failed' in t.lower() for t, _ in notifs))

    # ── Tier 1 · integration seams that were "green" but unproven ──────────────

    def _run_capturing_webhooks(self, msg):
        """Run main() with post_webhook + subprocess mocked; return posted payloads."""
        posted = []
        with tempfile.TemporaryDirectory() as cache_tmp, \
                patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message'), \
                patch.object(host, 'notify'), \
                patch.object(host, 'post_webhook',
                             side_effect=lambda url, payload, timeout=8.0: posted.append((url, payload)) or (True, '')), \
                patch.object(host.subprocess, 'run', return_value=_proc(0)):
            host.main()
        return posted

    def test_emit_ics_writes_file_with_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            msg = self._capture_msg(
                tmp, emitIcs=True,
                transcript="## Summary\nx\n\n## Next Steps\nArchitecture review Tuesday\nDemo on Friday")
            self._run(msg, _proc(0))
            ics = list(Path(tmp).glob("*.ics"))
            self.assertEqual(len(ics), 1, "an .ics should be written next to the note")
            content = ics[0].read_text(encoding="utf-8")
            self.assertEqual(content.count("BEGIN:VEVENT"), 2)
            self.assertIn("SUMMARY:Architecture review Tuesday", content)

    def test_emit_ics_not_written_without_next_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            msg = self._capture_msg(tmp, emitIcs=True, transcript="## Summary\nNo follow-ups here.")
            self._run(msg, _proc(0))
            self.assertEqual(list(Path(tmp).glob("*.ics")), [])

    def test_webhook_dispatched_with_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            posted = self._run_capturing_webhooks(self._capture_msg(
                tmp, webhookUrl="https://hook.example/x", transcript="## Summary\nWe shipped it."))
            self.assertEqual(len(posted), 1)
            self.assertEqual(posted[0][0], "https://hook.example/x")
            self.assertIn("We shipped it.", posted[0][1]["summary"])

    def test_redaction_reaches_the_webhook_payload(self):
        # The CHANGELOG claims redaction applies to webhook payloads — prove it.
        with tempfile.TemporaryDirectory() as tmp:
            posted = self._run_capturing_webhooks(self._capture_msg(
                tmp, webhookUrl="https://hook.example/x", redactPii=True,
                transcript="## Summary\nEmail alice@example.com about it."))
            blob = str(posted[0][1])
            self.assertNotIn("alice@example.com", blob)
            self.assertIn("[redacted-email]", blob)

    def test_slack_dispatched_with_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            posted = self._run_capturing_webhooks(self._capture_msg(
                tmp, slackWebhookUrl="https://hooks.slack.com/x",
                transcript="## Summary\nx\n\n## Action Items\nAlice: do y"))
            self.assertEqual(posted[0][0], "https://hooks.slack.com/x")
            self.assertIn("text", posted[0][1])

    def test_unexpected_exception_notifies_and_errors(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as cache_tmp:
            sent, notifs = [], []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value=self._capture_msg(tmp)), \
                    patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                    patch.object(host, 'notify', side_effect=lambda t, m: notifs.append((t, m))), \
                    patch.object(host.subprocess, 'run', side_effect=RuntimeError('kaboom')):
                host.main()
            self.assertEqual(sent[-1]['status'], 'error')
            self.assertIn('kaboom', sent[-1]['error'])
            self.assertTrue(any('failed' in t.lower() for t, _ in notifs))

    def test_ping(self):
        sent = self._run({"type": "ping"}, _proc(0))
        self.assertEqual(sent[-1]["status"], "ok")
        self.assertIn("version", sent[-1])

    def test_choose_folder_dispatch(self):
        sent = self._run({"type": "choose_folder"}, _proc(0, stdout="/Users/x/Notes\n"))
        self.assertEqual(sent[-1]["status"], "ok")
        self.assertEqual(sent[-1]["path"], "/Users/x/Notes")

    def test_snapshot_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({
                "type": "snapshot", "transcript": "snapshot body",
                "meetingTitle": "Standup", "timestamp": "2026-06-01T09:00:00Z",
                "fileBackupType": "markdown", "fileBackupPath": tmp,
            }, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(len(list(Path(tmp).glob("*-snap.md"))), 1)

    def test_search_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({"type": "search", "query": "anything", "fileBackupPath": tmp}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["results"], [])

    def test_prior_context_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({"type": "prior_context", "meetingTitle": "Standup",
                              "fileBackupPath": tmp}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(sent[-1]["context"], "")

    def test_multi_destination_also_sends_to_apple_notes(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as cache_tmp:
            msg = self._capture_msg(tmp, destinations=[{"type": "apple_notes"}])
            calls = []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value=msg), \
                    patch.object(host, 'send_message'), \
                    patch.object(host, 'notify'), \
                    patch.object(host, 'push_to_apple_notes', side_effect=lambda t, h: calls.append(t)), \
                    patch.object(host.subprocess, 'run', return_value=_proc(0)):
                host.main()
            self.assertEqual(len(calls), 1)  # the apple_notes extra fired

    def test_craft_space_id_passed_to_push(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as cache_tmp:
            msg = self._capture_msg(tmp, craftSpaceId="space-123", fileBackupEnabled=False)
            calls = []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value=msg), \
                    patch.object(host, 'send_message'), \
                    patch.object(host, 'notify'), \
                    patch.object(host.subprocess, 'run',
                                 side_effect=lambda cmd, **k: calls.append(cmd) or _proc(0)):
                host.main()
            self.assertIn("--space-id", calls[0])
            self.assertIn("space-123", calls[0])

    def test_retry_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "20260601-standup.md"
            bp.write_text("notes", encoding="utf-8")
            sent = self._run({"type": "retry", "title": "Standup", "backupPath": str(bp)}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")

    # ── empty / missing message ─────────────────────────────────────────────
    def test_empty_message_errors(self):
        # read_message → None (Chrome closed the pipe) ⇒ guarded error reply.
        sent = self._run(None, _proc(0))
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("empty message", sent[-1]["error"])

    # ── choose_folder edge branches ─────────────────────────────────────────
    def test_choose_folder_timeout(self):
        with tempfile.TemporaryDirectory() as cache_tmp:
            sent = []
            with patch.object(host, 'CACHE_DIR', Path(cache_tmp)), \
                    patch.object(host, 'read_message', return_value={"type": "choose_folder"}), \
                    patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                    patch.object(host, 'notify'), \
                    patch.object(host.subprocess, 'run',
                                 side_effect=host.subprocess.TimeoutExpired(cmd="osascript", timeout=25)):
                host.main()
            self.assertEqual(sent[-1]["status"], "error")
            self.assertIn("timed out", sent[-1]["error"])

    def test_choose_folder_no_selection(self):
        # returncode 1 / empty stdout ⇒ "No folder selected".
        sent = self._run({"type": "choose_folder"}, _proc(1, stdout=""))
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("No folder selected", sent[-1]["error"])

    # ── prior_context with an EXISTING prior note ───────────────────────────
    def test_prior_context_with_existing_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            # A prior final note (yesterday) for the same series, with a Summary.
            (Path(tmp) / "20260531-standup.md").write_text(
                'title: "Standup"\ndate: 2026-05-31\n\n## Summary\nWe agreed on the plan.\n',
                encoding="utf-8")
            sent = self._run({"type": "prior_context", "meetingTitle": "Standup",
                              "fileBackupPath": tmp}, _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertTrue(sent[-1]["context"])  # non-empty — the prior summary fed through
            self.assertIn("agreed on the plan", sent[-1]["context"])


class TestGcalDispatch(unittest.TestCase):
    """main() routing for the gcal_* / pre_meeting_brief beta messages."""

    def _dispatch(self, msg):
        sent = []
        with patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'):
            host.main()
        return sent

    def test_gcal_status_sent_verbatim(self):
        canned = {"connected": True, "available": True, "email": "lead@x.com"}
        with patch.object(host.gcal, 'status', return_value=canned):
            sent = self._dispatch({"type": "gcal_status"})
        self.assertEqual(sent[-1], canned)

    def test_gcal_disconnect_sent(self):
        with patch.object(host.gcal, 'disconnect', return_value={"ok": True}) as dc:
            sent = self._dispatch({"type": "gcal_disconnect"})
        dc.assert_called_once()
        self.assertEqual(sent[-1], {"ok": True})

    def test_gcal_connect_spawns_detached(self):
        with patch.object(host.subprocess, 'Popen') as popen:
            sent = self._dispatch({"type": "gcal_connect"})
        popen.assert_called_once()
        # spawns gcal.py, detached
        self.assertTrue(str(popen.call_args[0][0][-1]).endswith("gcal.py"))
        self.assertEqual(popen.call_args[1].get("start_new_session"), True)
        self.assertEqual(sent[-1], {"status": "ok", "started": True})

    def test_gcal_connect_popen_failure_errors(self):
        with patch.object(host.subprocess, 'Popen', side_effect=OSError("nope")):
            sent = self._dispatch({"type": "gcal_connect"})
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("nope", sent[-1]["error"])

    def test_pre_meeting_brief_ok(self):
        with patch.object(host.gcal, 'GCAL_AVAILABLE', True), \
                patch.object(host.gcal, 'live_events_provider', return_value=lambda: []), \
                patch.object(host.gcal, 'pre_meeting_brief',
                             return_value={"ok": True, "matched": True,
                                           "bullets": ["Agenda: ship it"], "title": "Q3"}):
            sent = self._dispatch({"type": "pre_meeting_brief", "meetingCode": "abc-defg-hij",
                                   "timestamp": "2026-06-01T09:00:00Z", "meetingTitle": "Q3"})
        self.assertTrue(sent[-1]["ok"])
        self.assertIn("Agenda: ship it", sent[-1]["bullets"])

    def test_pre_meeting_brief_unavailable(self):
        with patch.object(host.gcal, 'GCAL_AVAILABLE', False):
            sent = self._dispatch({"type": "pre_meeting_brief"})
        self.assertEqual(sent[-1], {"ok": False, "error": "unavailable"})


class TestGdocsDispatch(unittest.TestCase):
    """main() routing for the gdocs_* beta messages."""

    def _dispatch(self, msg):
        sent = []
        with patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'):
            host.main()
        return sent

    def test_gdocs_status_sent_verbatim(self):
        canned = {"connected": False, "available": True}
        with patch.object(host.gdocs, 'status', return_value=canned):
            sent = self._dispatch({"type": "gdocs_status"})
        self.assertEqual(sent[-1], canned)

    def test_gdocs_disconnect_sent(self):
        with patch.object(host.gdocs, 'disconnect', return_value={"ok": True}) as dc:
            sent = self._dispatch({"type": "gdocs_disconnect"})
        dc.assert_called_once()
        self.assertEqual(sent[-1], {"ok": True})

    def test_gdocs_connect_spawns_detached(self):
        with patch.object(host.subprocess, 'Popen') as popen:
            sent = self._dispatch({"type": "gdocs_connect"})
        popen.assert_called_once()
        self.assertTrue(str(popen.call_args[0][0][-1]).endswith("gdocs.py"))
        self.assertEqual(popen.call_args[1].get("start_new_session"), True)
        self.assertEqual(sent[-1], {"status": "ok", "started": True})

    def test_gdocs_connect_popen_failure_errors(self):
        with patch.object(host.subprocess, 'Popen', side_effect=OSError("boom")):
            sent = self._dispatch({"type": "gdocs_connect"})
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("boom", sent[-1]["error"])


class TestGoogleDispatch(unittest.TestCase):
    """main() routing for the combined one-flow google_* messages (gauth)."""

    def _dispatch(self, msg):
        sent = []
        with patch.object(host, 'read_message', return_value=msg), \
                patch.object(host, 'send_message', side_effect=lambda r: sent.append(r)), \
                patch.object(host, 'notify'):
            host.main()
        return sent

    def test_google_status_sent_verbatim(self):
        canned = {"connected": True, "available": True, "email": "me@x.com"}
        with patch.object(host.gauth, 'status', return_value=canned):
            sent = self._dispatch({"type": "google_status"})
        self.assertEqual(sent[-1], canned)

    def test_google_disconnect_sent(self):
        with patch.object(host.gauth, 'disconnect', return_value={"ok": True}) as dc:
            sent = self._dispatch({"type": "google_disconnect"})
        dc.assert_called_once()
        self.assertEqual(sent[-1], {"ok": True})

    def test_google_connect_spawns_detached(self):
        with patch.object(host.gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(host.gauth, 'CREDENTIALS_PATH') as creds, \
                patch.object(host.subprocess, 'Popen') as popen:
            creds.exists.return_value = True
            sent = self._dispatch({"type": "google_connect"})
        popen.assert_called_once()
        self.assertTrue(str(popen.call_args[0][0][-1]).endswith("gauth.py"))
        self.assertEqual(popen.call_args[1].get("start_new_session"), True)
        self.assertEqual(sent[-1], {"status": "ok", "started": True})

    def test_google_connect_popen_failure_errors(self):
        with patch.object(host.gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(host.gauth, 'CREDENTIALS_PATH') as creds, \
                patch.object(host.subprocess, 'Popen', side_effect=OSError("nope")):
            creds.exists.return_value = True
            sent = self._dispatch({"type": "google_connect"})
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("nope", sent[-1]["error"])

    def test_google_connect_errors_fast_without_credentials(self):
        # BUG-14: no credentials.json on this Mac → immediate error, no doomed spawn
        # (otherwise the popup polls a never-connecting status forever).
        with patch.object(host.gauth, 'GAUTH_AVAILABLE', True), \
                patch.object(host.gauth, 'CREDENTIALS_PATH') as creds, \
                patch.object(host.subprocess, 'Popen') as popen:
            creds.exists.return_value = False
            sent = self._dispatch({"type": "google_connect"})
        popen.assert_not_called()
        self.assertEqual(sent[-1]["status"], "error")
        self.assertIn("credentials.json", sent[-1]["error"])

    def test_google_connect_errors_fast_without_libs(self):
        with patch.object(host.gauth, 'GAUTH_AVAILABLE', False), \
                patch.object(host.subprocess, 'Popen') as popen:
            sent = self._dispatch({"type": "google_connect"})
        popen.assert_not_called()
        self.assertEqual(sent[-1]["status"], "error")


class TestCaptureHooks(unittest.TestCase):
    """Capture-path wiring inside main(): googleDocsOutput / destinations /
    calendar enrichment / wikilinks / backupCleanup / timestamp fallback.
    Reuses the TestMainCaptureFlow harness."""

    _run = TestMainCaptureFlow._run
    _capture_msg = TestMainCaptureFlow._capture_msg

    # 7 — Google Docs as the PRIMARY output (backupType='google_docs') routes to create_doc
    def test_google_docs_primary_routes_to_create_doc(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            with patch.object(host.gdocs, 'create_doc',
                              side_effect=lambda t, b: calls.append((t, b)) or
                                  {"ok": True, "url": "https://docs.google.com/document/d/X/edit"}):
                sent = self._run(self._capture_msg(tmp, backupType='google_docs'), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(len(calls), 1)
            title, body = calls[0]
            self.assertTrue(title.endswith("Q3 Planning"))
            self.assertIn("We shipped it.", body)
            # The Doc URL rides back as a deep-link reference.
            self.assertEqual(sent[-1]["link"],
                             {"app": "gdocs", "kind": "url",
                              "value": "https://docs.google.com/document/d/X/edit"})

    def test_google_docs_primary_not_connected_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(host.gdocs, 'create_doc', return_value={"ok": False, "error": "not_connected"}):
                sent = self._run(self._capture_msg(tmp, backupType='google_docs'), _proc(0))
            self.assertEqual(sent[-1]["status"], "error")
            self.assertIn("connect", sent[-1]["error"].lower())

    # 8 — destinations → send_to_destinations(list, ...)
    def test_destinations_hook_wires_into_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [{"type": "apple_notes"}]
            calls = []
            with patch.object(host, 'send_to_destinations',
                              side_effect=lambda d, *a, **k: calls.append(d)):
                sent = self._run(self._capture_msg(tmp, destinations=rows), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(calls, [rows])

    # 8b — BUG-11 Fix C: per-destination aggregation into one partial/error reply.
    def test_all_ok_status_ok_saved_has_every_destination(self):
        # Craft primary OK + an Apple Notes secondary OK → status ok, both saved.
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(host, 'push_to_apple_notes', return_value=None):
                sent = self._run(self._capture_msg(
                    tmp, destinations=[{"type": "apple_notes"}]), _proc(0))
            r = sent[-1]
            self.assertEqual(r["status"], "ok")
            self.assertTrue(r["primaryOk"])
            self.assertEqual(set(r["saved"]), {"Craft", "Apple Notes"})
            self.assertEqual(r["failed"], [])
            self.assertNotIn("error", r)

    def test_primary_fails_additional_ok_is_partial_primary_false(self):
        # Obsidian primary fails (blank vault, nothing detectable) + Apple Notes
        # secondary OK → status partial, primaryOk False, Obsidian in failed.
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(host, '_detect_obsidian_vault', return_value=''), \
                    patch.object(host, 'push_to_apple_notes', return_value=None):
                sent = self._run(self._capture_msg(
                    tmp, backupType="obsidian", obsidianVaultPath="",
                    destinations=[{"type": "apple_notes"}]), _proc(0))
            r = sent[-1]
            self.assertEqual(r["status"], "partial")
            self.assertFalse(r["primaryOk"])
            self.assertIn("Obsidian", r["failed"])
            self.assertIn("Apple Notes", r["saved"])
            self.assertIn("Obsidian", r["error"])

    def test_primary_ok_additional_fails_is_partial_primary_true(self):
        # Craft primary OK + an Apple Notes secondary that raises → status partial,
        # primaryOk True, Apple Notes in failed.
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(host, 'push_to_apple_notes', side_effect=RuntimeError('boom')):
                sent = self._run(self._capture_msg(
                    tmp, destinations=[{"type": "apple_notes"}]), _proc(0))
            r = sent[-1]
            self.assertEqual(r["status"], "partial")
            self.assertTrue(r["primaryOk"])
            self.assertIn("Craft", r["saved"])
            self.assertIn("Apple Notes", r["failed"])
            self.assertIn("Apple Notes", r["error"])

    def test_all_fail_status_error(self):
        # Obsidian primary fails + Apple Notes secondary fails → status error.
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(host, '_detect_obsidian_vault', return_value=''), \
                    patch.object(host, 'push_to_apple_notes', side_effect=RuntimeError('boom')):
                sent = self._run(self._capture_msg(
                    tmp, backupType="obsidian", obsidianVaultPath="",
                    destinations=[{"type": "apple_notes"}]), _proc(0))
            r = sent[-1]
            self.assertEqual(r["status"], "error")
            self.assertFalse(r["primaryOk"])
            self.assertEqual(r["saved"], [])
            self.assertEqual(set(r["failed"]), {"Obsidian", "Apple Notes"})

    # 9 — calendar enrichment → cal_fields reach the frontmatter (covers 309)
    def test_calendar_enrichment_reaches_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            cal = {"organizer": "lead@x.com", "scheduled_end": "2026-06-01T10:00:00Z"}
            with patch.object(host.gcal, 'GCAL_AVAILABLE', True), \
                    patch.object(host.gcal, 'live_events_provider', return_value=lambda: []), \
                    patch.object(host.gcal, 'enrich_frontmatter_fields',
                                 return_value=(cal, 'ok')):
                self._run(self._capture_msg(tmp, calendarEnabled=True,
                                            meetingCode="abc-defg-hij"), _proc(0))
            content = next(Path(tmp).glob("*.md")).read_text(encoding="utf-8")
            self.assertIn("organizer: lead@x.com", content)
            self.assertIn("scheduled_end: 2026-06-01T10:00:00Z", content)

    # 14 — wikilinks → attendee names wrapped in [[ ]] on the persisted note
    def test_wikilinks_hook_wraps_attendees(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run(self._capture_msg(
                tmp, wikilinks=True, attendees=["Alice"],
                transcript="## Summary\nAlice owns the rollout."), _proc(0))
            content = next(Path(tmp).glob("*.md")).read_text(encoding="utf-8")
            self.assertIn("[[Alice]]", content)

    # 15 — backupCleanup → cleanup_backups called
    def test_backup_cleanup_hook_called(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            with patch.object(host, 'cleanup_backups',
                              side_effect=lambda p, cfg, *a, **k: calls.append(cfg)):
                sent = self._run(self._capture_msg(
                    tmp, backupCleanup={"maxAgeDays": 30}), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(calls, [{"maxAgeDays": 30}])

    # 16 — unparseable timestamp → fallback to now(), capture still oks
    def test_timestamp_garbage_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run(self._capture_msg(tmp, timestamp="garbage"), _proc(0))
            self.assertEqual(sent[-1]["status"], "ok")
            self.assertEqual(len(list(Path(tmp).glob("*.md"))), 1)


class TestRecoverSnapshot(unittest.TestCase):
    """recover_snapshot — leave-time fallback that files the latest on-disk snapshot."""

    _run = TestMainCaptureFlow._run

    def test_files_latest_snapshot_for_the_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            slug = host._file_slug("Sprint Planning")
            (Path(tmp) / f"20260615-1200-{slug}-snap.md").write_text(
                "---\ntitle: x\n---\n## Summary\nRecovered body.\n", encoding="utf-8")
            sent = self._run({
                "type": "recover_snapshot", "meetingTitle": "Sprint Planning",
                "backupType": "none", "fileBackupPath": tmp, "fileBackupType": "markdown",
            }, _proc(0))
            self.assertEqual(sent[-1].get("status"), "ok")

    def test_no_snapshot_returns_not_found_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = self._run({
                "type": "recover_snapshot", "meetingTitle": "Never Happened",
                "backupType": "none", "fileBackupPath": tmp, "fileBackupType": "markdown",
            }, _proc(0))
            self.assertEqual(sent[-1], {"ok": False, "reason": "no_snapshot"})


class TestMainNeverCrashes(unittest.TestCase):
    """A handler raising before it replies must not crash the host process — Chrome
    surfaces that as a cryptic 'Native host has exited'. main() must instead send a
    single clean error reply so the popup shows a real (friendly) message."""

    def test_uncaught_dispatch_error_becomes_clean_reply(self):
        sent = []
        with patch.object(host, '_dispatch', side_effect=RuntimeError('boom')), \
                patch.object(host, 'send_message', side_effect=lambda d: sent.append(d)), \
                patch.object(host, '_heartbeat'):
            host.main()  # must NOT raise
        self.assertEqual([d.get('status') for d in sent], ['error'])
        self.assertIn('boom', sent[0]['error'])

    def test_clean_dispatch_is_left_alone(self):
        sent = []
        with patch.object(host, '_dispatch', return_value=None), \
                patch.object(host, 'send_message', side_effect=lambda d: sent.append(d)):
            host.main()
        self.assertEqual(sent, [])  # guard only fires on an uncaught exception


class TestCalendarEnrichBounded(unittest.TestCase):
    """Calendar enrichment must never block the capture: a hung Calendar API call
    (the google client has no network timeout) is abandoned after a wall-clock
    timeout and the capture proceeds with no enrichment."""

    def test_returns_fields_on_success(self):
        with patch.object(host.gcal, 'enrich_frontmatter_fields',
                          return_value=({'organizer': 'https://x'}, 'ok')):
            out = host._enrich_calendar_bounded({'timestamp': '', 'meetingCode': ''}, timeout=5)
        self.assertEqual(out, {'organizer': 'https://x'})

    def test_hang_is_abandoned_and_returns_empty_quickly(self):
        import time
        with patch.object(host.gcal, 'enrich_frontmatter_fields',
                          side_effect=lambda *a, **k: time.sleep(5)):
            t0 = time.time()
            out = host._enrich_calendar_bounded({'timestamp': '', 'meetingCode': ''}, timeout=0.2)
            elapsed = time.time() - t0
        self.assertEqual(out, {})            # gave up on the hang
        self.assertLess(elapsed, 2.0)        # and returned promptly, not after 5s

    def test_exception_is_swallowed(self):
        with patch.object(host.gcal, 'enrich_frontmatter_fields',
                          side_effect=RuntimeError('boom')):
            self.assertEqual(host._enrich_calendar_bounded({'timestamp': ''}, timeout=5), {})


if __name__ == "__main__":
    unittest.main()
