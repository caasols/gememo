const { test, expect } = require('@playwright/test');
const {
  launchExtension,
  closeExtension,
  stubNativeMessage,
  getSent,
  seedStorage,
  getStorage,
  clearStorage,
  openPopup,
  sendFromPage,
} = require('./ext-harness');

test.describe('extension E2E harness', () => {
  let ext;
  test.beforeAll(async () => { ext = await launchExtension(); });
  test.afterAll(async () => { if (ext) await closeExtension(ext); });

  test('loads the unpacked extension and exposes a service worker', async () => {
    expect(ext.serviceWorker).toBeTruthy();
    expect(ext.extensionId).toMatch(/^[a-p]{32}$/); // chrome extension id alphabet
  });

  test('harness round-trip: a message logged via the stubbed host loop', async () => {
    await seedStorage(ext.serviceWorker, { mm2c_logs: [] });
    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    const popup = await openPopup(ext.context, ext.extensionId);
    await sendFromPage(popup, { type: 'MM2C_LOG', message: 'hello from e2e', meetingTitle: 'Smoke' });
    await expect.poll(async () => {
      const s = await getStorage(ext.serviceWorker, ['mm2c_logs']);
      return (s.mm2c_logs || []).some(e => e.message === 'hello from e2e');
    }).toBe(true);
    await popup.close();
  });

  test.describe('background handlers', () => {
    let popup;
    test.beforeAll(async () => { popup = await openPopup(ext.context, ext.extensionId); });
    test.afterAll(async () => { if (popup) await popup.close(); });
    test.beforeEach(async () => {
      await clearStorage(ext.serviceWorker);
      await stubNativeMessage(ext.serviceWorker, {
        ping: { status: 'ok', version: require('../extension/manifest.json').version, home: '/Users/x' },
        __default: { status: 'ok' },
      });
    });

    test('MM2C_STAT_JOINED increments meetingsAttended', async () => {
      await sendFromPage(popup, { type: 'MM2C_STAT_JOINED' });
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended
      ).toBe(1);
    });

    test('MM2C_CHECK_HOST reports ok + no version mismatch on matching major', async () => {
      const resp = await sendFromPage(popup, { type: 'MM2C_CHECK_HOST' });
      expect(resp.ok).toBe(true);
      expect(resp.versionMismatch).toBe(false);
    });

    test('MM2C_RESPONSE forwards the right payload and updates stats/status/last-note', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'obsidian',
        mm2c_stats: { meetingsAttended: 3, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'one two three four five',
        meetingTitle: 'Q3 Sync',
        durationMin: 25,
        meetingCode: 'abc-defg-hij',
      });
      expect(resp.ok).toBe(true);

      // The host received the forwarded payload (via the stubbed sendNativeMessage).
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'one two three four five');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.backupType).toBe('obsidian');
      expect(fwd.msg.meetingTitle).toBe('Q3 Sync');

      // On the stubbed {status:ok}: stats + last-note (global) and the status
      // (tab-scoped, because the popup is a real tab) all update.
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null); // all keys
        const statusKey = Object.keys(s).find(k => k.startsWith('mm2c_last_status'));
        return {
          notes: s.mm2c_stats?.notesSaved,
          words: s.mm2c_stats?.wordsCaptured,
          mins: s.mm2c_stats?.totalMeetingMinutes,
          status: !!(statusKey && String(s[statusKey]).startsWith('Saved to Obsidian')),
          note: s.mm2c_last_note,
        };
      }).toEqual({ notes: 1, words: 5, mins: 25, status: true, note: 'one two three four five' });
    });

    test('MM2C_RESPONSE stores the host deep-link on the success log entry', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        __default: { status: 'ok', title: 'Q3 Sync',
                     link: { app: 'apple_notes', kind: 'note_id', value: 'x-coredata://S/ICNote/p9' } },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'apple_notes', mm2c_logs: [] });
      await sendFromPage(popup, { type: 'MM2C_RESPONSE', text: 'one two three', meetingTitle: 'Q3 Sync' });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_logs']);
        return (s.mm2c_logs || []).find(e => e.status === 'ok')?.link?.value || null;
      }).toBe('x-coredata://S/ICNote/p9');
    });

    test('MM2C_RESPONSE forwards the destinations repeater regardless of beta state (UXF-11)', async () => {
      const dests = [{ type: 'obsidian', vaultPath: '/tmp/VaultA' }, { type: 'apple_notes' }];
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_destinations: dests,
        mm2c_beta_enabled: false, // beta OFF — must STILL thread (regression guard for the gating bug)
      });
      await sendFromPage(popup, { type: 'MM2C_RESPONSE', text: 'destinations payload', meetingTitle: 'X' });
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'destinations payload');
        return fwd ? fwd.msg.destinations : null;
      }).toEqual(dests);
    });

    test('MM2C_RESPONSE merges legacy also-send into the destinations payload', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_destinations: [{ type: 'obsidian', vaultPath: '/tmp/VaultA' }],
        mm2c_also_send: ['apple_notes'],
        mm2c_beta_enabled: false,
      });
      await sendFromPage(popup, { type: 'MM2C_RESPONSE', text: 'merge payload', meetingTitle: 'X' });
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'merge payload');
        return fwd ? fwd.msg.destinations : null;
      }).toEqual([{ type: 'obsidian', vaultPath: '/tmp/VaultA' }, { type: 'apple_notes' }]);
    });

    test('MM2C_RESPONSE dedups destinations + drops the primary app', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_destinations: [
          { type: 'apple_notes' }, { type: 'apple_notes' },
          { type: 'craft', folderId: '' },
          { type: 'obsidian', vaultPath: '/v' }, { type: 'obsidian', vaultPath: '/w' },
        ],
        mm2c_beta_enabled: false,
      });
      await sendFromPage(popup, { type: 'MM2C_RESPONSE', text: 'dedup payload', meetingTitle: 'X' });
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'dedup payload');
        return fwd ? fwd.msg.destinations : null;
      }).toEqual([{ type: 'apple_notes' }, { type: 'obsidian', vaultPath: '/v' }]);
    });

    test('MM2C_RESPONSE forwards backupType:google_docs when Google Docs is the primary (5.7)', async () => {
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'google_docs' });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'gdocs primary payload',
        meetingTitle: 'Gdocs Primary',
      });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'gdocs primary payload');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.backupType).toBe('google_docs');
    });

    test('MM2C_GCAL relays the action to the host', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        gdocs_status: { connected: true, available: true, email: 'me@x.com' },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_GCAL', action: 'gdocs_status' });
      expect(resp.connected).toBe(true);
      expect(resp.email).toBe('me@x.com');
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.type === 'gdocs_status')).toBe(true);
    });

    test('MM2C_GOOGLE relays the combined connect action to the host', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        google_status: { connected: true, available: true, email: 'me@x.com' },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_GOOGLE', action: 'google_status' });
      expect(resp.connected).toBe(true);
      expect(resp.email).toBe('me@x.com');
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.type === 'google_status')).toBe(true);
    });

    test('MM2C_SET_CAPTURE_STATE records capturing state + REC tab tracking', async () => {
      await sendFromPage(popup, { type: 'MM2C_SET_CAPTURE_STATE', state: 'capturing' });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const stateKey = Object.keys(s).find(k => k.startsWith('mm2c_capture_state'));
        return {
          state: stateKey ? s[stateKey] : undefined,
          capturing: Array.isArray(s.mm2c_capturing_tabs) && s.mm2c_capturing_tabs.length > 0,
        };
      }).toEqual({ state: 'capturing', capturing: true });
    });

    test('MM2C_WARNING sets a Warning status and logs it', async () => {
      await sendFromPage(popup, { type: 'MM2C_WARNING', message: 'Meeting too short', meetingTitle: 'X' });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const statusKey = Object.keys(s).find(k => k.startsWith('mm2c_last_status'));
        return {
          status: !!(statusKey && String(s[statusKey]).startsWith('Warning: Meeting too short')),
          logged: (s.mm2c_logs || []).some(e => e.status === 'warn' && e.message === 'Meeting too short'),
        };
      }).toEqual({ status: true, logged: true });
    });

    test('MM2C_ERROR shows a friendly status and logs the raw error (UXC-3)', async () => {
      await sendFromPage(popup, { type: 'MM2C_ERROR', error: 'Craft is not running — open Craft', meetingTitle: 'X' });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const statusKey = Object.keys(s).find(k => k.startsWith('mm2c_last_status'));
        return {
          friendly: !!(statusKey && /Error: Craft isn't running/i.test(String(s[statusKey]))),
          rawLogged: (s.mm2c_logs || []).some(e => e.status === 'err' && /Craft is not running/.test(e.message)),
        };
      }).toEqual({ friendly: true, rawLogged: true });
    });

    test('MM2C_RETRY removes the failed entry on a successful host retry', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_failed_list: [{ tabId: null, title: 'Lost', backupPath: '/tmp/lost.md', failedAt: Date.now() }],
      });
      await stubNativeMessage(ext.serviceWorker, { retry: { status: 'ok', title: 'Lost', source: 'file' }, __default: { status: 'ok' } });
      const resp = await sendFromPage(popup, { type: 'MM2C_RETRY', title: 'Lost', backupPath: '/tmp/lost.md' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_failed_list'])).mm2c_failed_list?.length
      ).toBe(0);
    });

    test('MM2C_RETRY counts the recovered note in the usage stats (STATS-2)', async () => {
      // A note that failed at send time stashed words/durationMin on its
      // failed-list entry; a successful retry must fold those into the stats so
      // recovered meetings aren't missing from the impact numbers.
      await seedStorage(ext.serviceWorker, {
        mm2c_stats: { meetingsAttended: 2, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
        mm2c_failed_list: [{ tabId: null, title: 'Lost', backupPath: '/tmp/lost.md', failedAt: Date.now(), words: 137, durationMin: 23 }],
      });
      await stubNativeMessage(ext.serviceWorker, { retry: { status: 'ok', title: 'Lost', source: 'file' }, __default: { status: 'ok' } });
      const resp = await sendFromPage(popup, { type: 'MM2C_RETRY', title: 'Lost', backupPath: '/tmp/lost.md' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_stats']);
        return { notes: s.mm2c_stats?.notesSaved, words: s.mm2c_stats?.wordsCaptured, mins: s.mm2c_stats?.totalMeetingMinutes };
      }).toEqual({ notes: 1, words: 137, mins: 23 });

      // Idempotency: retrying the same path again (entry already gone) must NOT
      // count a second time.
      const resp2 = await sendFromPage(popup, { type: 'MM2C_RETRY', title: 'Lost', backupPath: '/tmp/lost.md' });
      expect(resp2.ok).toBe(true);
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.notesSaved
      ).toBe(1);
    });

    test('MM2C_RECOVER re-sends the in-flight note and clears it (RB-1d)', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_inflight: { title: 'Crashed Meeting', text: 'recovered notes body', at: Date.now() },
      });
      await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok', title: 'Crashed Meeting' } });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER' });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.transcript === 'recovered notes body')).toBe(true);
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_inflight'])).mm2c_inflight
      ).toBeUndefined();
    });

    test('MM2C_RECOVER_SNAPSHOT files the host snapshot + logs it (leave fallback)', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        recover_snapshot: { status: 'ok', title: 'Sprint Planning' },
        __default: { status: 'ok' },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'craft', mm2c_logs: [] });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER_SNAPSHOT', meetingTitle: 'Sprint Planning' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_logs'])).mm2c_logs.some(e => /Recovered from the latest snapshot/.test(e.message))
      ).toBe(true);
    });

    test('MM2C_RECOVER_SNAPSHOT returns ok:false when the host has no snapshot', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        recover_snapshot: { ok: false, reason: 'no_snapshot' },
        __default: { status: 'ok' },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'craft' });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER_SNAPSHOT', meetingTitle: 'X' });
      expect(resp.ok).toBe(false);
      expect(resp.reason).toBe('no_snapshot');
    });

    test('MM2C_RECOVER counts the recovered note\'s meeting time (STATS-1)', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 1, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
        mm2c_inflight: { title: 'Crashed', text: 'one two three', durationMin: 42, at: Date.now() },
      });
      await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok', title: 'Crashed' } });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_stats', 'mm2c_inflight']);
        return { mins: s.mm2c_stats?.totalMeetingMinutes, notes: s.mm2c_stats?.notesSaved, cleared: s.mm2c_inflight };
      }).toEqual({ mins: 42, notes: 1, cleared: undefined });
    });

    test('MM2C_RECOVER threads the full config + the in-flight timestamp (drift fix)', async () => {
      const at = Date.parse('2026-06-01T09:12:00Z');
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_cleanup_snap_enabled: true, mm2c_cleanup_snap_days: 7,
        mm2c_inflight: { title: 'Recovered', text: 'recovered body', durationMin: 20, at },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'recovered body');
        if (!fwd) return null;
        return {
          cleanup: fwd.msg.backupCleanup?.snapshots?.enabled,
          ts: fwd.msg.timestamp,
          recover: fwd.msg.recover,
        };
      }).toEqual({ cleanup: true, ts: new Date(at).toISOString(), recover: true });
    });

    test('MM2C_RECOVER re-sends only the primary — never the additional destinations (BUG-11 #3)', async () => {
      // Recovery fires only when the PRIMARY failed; the additional destinations
      // (best-effort) may already have succeeded, so re-pushing them duplicates
      // (e.g. a 2nd Craft doc). The recover message must carry destinations: [].
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'obsidian',
        mm2c_destinations: [{ type: 'craft' }, { type: 'apple_notes' }],
        mm2c_inflight: { title: 'Recovered', text: 'recover-no-dup', durationMin: 10, at: Date.parse('2026-06-01T09:12:00Z') },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'recover-no-dup');
        return fwd ? fwd.msg.destinations : null;
      }).toEqual([]);
    });

    test('MM2C_RESPONSE host-error appends to mm2c_failed_list + friendly banner (retry entry point)', async () => {
      // The host replies with a non-ok status AND a backupPath — this is the only
      // path that creates a failed-list retry entry (forwardToNativeHost error branch).
      await stubNativeMessage(ext.serviceWorker, {
        __default: { status: 'error', error: 'disk full', backupPath: '/tmp/x.md' },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'craft' });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'host error body',
        meetingTitle: 'Fail Me',
      });
      // The handler reports failure with the backup path threaded back for the chip.
      expect(resp.ok).toBe(false);
      expect(resp.backupPath).toBe('/tmp/x.md');

      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const failed = s.mm2c_failed_list || [];
        const entry = failed.find(f => f.backupPath === '/tmp/x.md');
        const statusKey = Object.keys(s).find(k => k.startsWith('mm2c_last_status'));
        const status = statusKey ? String(s[statusKey]) : '';
        return {
          entryTitle: entry?.title,
          entryPath: entry?.backupPath,
          // words/durationMin are stashed on the entry so a later retry can count
          // the recovered note (STATS-2). 'host error body' → 3 words; no duration
          // was sent, so durationMin is null.
          entryWords: entry?.words,
          entryDuration: entry?.durationMin,
          // friendlyError('disk full') → generic "Something went wrong" banner,
          // prefixed with "Error:" so resolveBanner classifies it as an error.
          statusIsError: /^Error/.test(status) || /^Couldn/.test(status),
        };
      }).toEqual({ entryTitle: 'Fail Me', entryPath: '/tmp/x.md', entryWords: 3, entryDuration: null, statusIsError: true });
    });

    test('MM2C_RESPONSE partial + primaryOk:true → no recovery, in-flight cleared, partial banner (BUG-11 Fix C)', async () => {
      // The PRIMARY (Craft) saved but a secondary (Apple Notes) failed. Recovery
      // re-sends the primary, so a secondary-only failure must NOT create a
      // failed-list retry entry and must report ok:true (the content script then
      // clears the in-flight note). The banner warns about the partial save.
      await stubNativeMessage(ext.serviceWorker, {
        __default: { status: 'partial', primaryOk: true, title: 'Q3 Sync',
                     saved: ['Craft'], failed: ['Apple Notes'],
                     error: 'Apple Notes: osascript failed' },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'craft', mm2c_failed_list: [], mm2c_logs: [] });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE', text: 'one two three', meetingTitle: 'Q3 Sync',
      });
      // primaryOk → the handler reports success so the in-flight note is cleared.
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const statusKey = Object.keys(s).find(k => k.startsWith('mm2c_last_status'));
        const status = statusKey ? String(s[statusKey]) : '';
        return {
          // No retry entry — recovery is only for primary failures.
          failedListLen: (s.mm2c_failed_list || []).length,
          // Partial banner mentions both the save and the failed destination.
          bannerSaved: /Saved to Craft/.test(status),
          bannerFailed: /Apple Notes failed/.test(status),
        };
      }).toEqual({ failedListLen: 0, bannerSaved: true, bannerFailed: true });
    });

    test('MM2C_RESPONSE partial + primaryOk:false → recovery shown, ok:false (BUG-11 Fix C)', async () => {
      // The PRIMARY (Obsidian) failed; a secondary saved. Recovery re-sends the
      // primary, so this MUST create a failed-list retry entry and report ok:false
      // (the content script keeps the in-flight note + shows the recovery card).
      await stubNativeMessage(ext.serviceWorker, {
        __default: { status: 'partial', primaryOk: false, title: 'Q3 Sync',
                     saved: ['Apple Notes'], failed: ['Obsidian'],
                     error: 'Obsidian: vault path not set', backupPath: '/tmp/q3.md' },
      });
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'obsidian', mm2c_failed_list: [], mm2c_logs: [] });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE', text: 'one two three', meetingTitle: 'Q3 Sync',
      });
      expect(resp.ok).toBe(false);
      expect(resp.backupPath).toBe('/tmp/q3.md');
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const entry = (s.mm2c_failed_list || []).find(f => f.backupPath === '/tmp/q3.md');
        return entry?.backupPath || null;
      }).toBe('/tmp/q3.md');  // recovery entry present (primary failed)
    });

    test('MM2C_RESPONSE skips a duplicate send within the dedup window (shouldSkipDuplicate)', async () => {
      // Tab-keyed fingerprint dedup: two identical sends from the same sender (same
      // tab + same title) within DEDUP_WINDOW_MS must forward exactly once.
      await seedStorage(ext.serviceWorker, { mm2c_output_app: 'craft', mm2c_logs: [] });
      const dupMsg = { type: 'MM2C_RESPONSE', meetingTitle: 'Dup', text: 'dedup-body-unique' };

      const first = await sendFromPage(popup, dupMsg);
      expect(first.ok).toBe(true);
      // Wait for the first forward to be recorded before sending the duplicate so
      // the fingerprint is committed to session storage.
      await expect.poll(async () => {
        const sent = await getSent(ext.serviceWorker);
        return sent.filter(s => s.msg.transcript === 'dedup-body-unique').length;
      }).toBe(1);

      const second = await sendFromPage(popup, dupMsg);
      expect(second.ok).toBe(true);

      // The second send must NOT have produced a new host send for that transcript…
      const sent = await getSent(ext.serviceWorker);
      expect(sent.filter(s => s.msg.transcript === 'dedup-body-unique').length).toBe(1);
      // …and a "Duplicate send skipped" warn must be logged.
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_logs']);
        return (s.mm2c_logs || []).some(
          e => e.status === 'warn' && /Duplicate send skipped/.test(e.message)
        );
      }).toBe(true);
    });

    test('MM2C_CHECK_HOST flags a major version mismatch + warns in the logs', async () => {
      // Force a major-version mismatch against the manifest version (e.g. 1.x vs 0.0.1).
      await seedStorage(ext.serviceWorker, { mm2c_logs: [] });
      // Manifest major is 0; force a different major (9.x) to trip isVersionMismatch.
      await stubNativeMessage(ext.serviceWorker, {
        ping: { status: 'ok', version: '9.9.9', home: '/Users/x' },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_CHECK_HOST' });
      expect(resp.ok).toBe(true);
      expect(resp.versionMismatch).toBe(true);
      expect(resp.hostVersion).toBe('9.9.9');
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_logs']);
        return (s.mm2c_logs || []).some(
          e => e.status === 'warn' && /version mismatch/i.test(e.message)
        );
      }).toBe(true);
    });

    test('MM2C_RETRY failure branch returns ok:false, logs an error, leaves failed-list intact', async () => {
      const seeded = [{ tabId: null, title: 'Still Lost', backupPath: '/tmp/still.md', failedAt: 111 }];
      await seedStorage(ext.serviceWorker, { mm2c_failed_list: seeded, mm2c_logs: [] });
      await stubNativeMessage(ext.serviceWorker, {
        retry: { status: 'error', error: 'still missing' },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RETRY', title: 'Still Lost', backupPath: '/tmp/still.md',
      });
      expect(resp.ok).toBe(false);
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_logs', 'mm2c_failed_list']);
        return (s.mm2c_logs || []).some(e => e.status === 'err' && /Retry failed/.test(e.message));
      }).toBe(true);
      // The failure branch logs an error but must NOT touch the failed list.
      const after = (await getStorage(ext.serviceWorker, ['mm2c_failed_list'])).mm2c_failed_list;
      expect(after).toEqual(seeded);
    });

    test('chrome.tabs.onRemoved prunes tab-scoped keys + capturing/failed lists for the closed tab', async () => {
      // Open a real page so it has a genuine tab id, seed tab-scoped state for THAT
      // id, then close it and assert the onRemoved listener cleaned everything up.
      const page = await ext.context.newPage();
      await page.goto('about:blank');
      const tabId = await ext.serviceWorker.evaluate(() => new Promise((res) => {
        chrome.tabs.query({ url: 'about:blank' }, (tabs) => res(tabs[tabs.length - 1].id));
      }));

      await seedStorage(ext.serviceWorker, {
        [`mm2c_capture_state_${tabId}`]: 'capturing',
        [`mm2c_last_status_${tabId}`]: 'Saved to Craft',
        [`mm2c_last_snapshot_${tabId}`]: 'snap body',
        mm2c_capturing_tabs: [tabId, 999999],
        mm2c_failed_list: [
          { tabId, title: 'For Closed Tab', backupPath: '/tmp/closed.md', failedAt: 1 },
          { tabId: 999999, title: 'Other Tab', backupPath: '/tmp/other.md', failedAt: 2 },
        ],
      });

      await page.close();

      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const failed = s.mm2c_failed_list || [];
        return {
          captureGone: s[`mm2c_capture_state_${tabId}`] === undefined,
          statusGone: s[`mm2c_last_status_${tabId}`] === undefined,
          snapGone: s[`mm2c_last_snapshot_${tabId}`] === undefined,
          capturingPruned: (s.mm2c_capturing_tabs || []).includes(tabId) === false,
          othersKept: (s.mm2c_capturing_tabs || []).includes(999999),
          closedFailedGone: failed.every(f => f.tabId !== tabId),
          otherFailedKept: failed.some(f => f.tabId === 999999),
        };
      }).toEqual({
        captureGone: true, statusGone: true, snapGone: true,
        capturingPruned: true, othersKept: true,
        closedFailedGone: true, otherFailedKept: true,
      });
    });

    test('MM2C_SNAPSHOT skips the host when file backup is disabled, forwards it when enabled', async () => {
      // Disabled: nothing should reach the host.
      await seedStorage(ext.serviceWorker, { mm2c_file_backup_enabled: false });
      await sendFromPage(popup, { type: 'MM2C_SNAPSHOT', text: 'snap body disabled', meetingTitle: 'X' });
      // Fire-and-forget — give the handler a beat, then assert no snapshot was sent.
      await expect.poll(async () => {
        const sent = await getSent(ext.serviceWorker);
        return sent.some(s => s.msg.type === 'snapshot');
      }, { timeout: 2000 }).toBe(false);

      // Enabled: the snapshot payload is forwarded carrying the transcript.
      await seedStorage(ext.serviceWorker, {
        mm2c_file_backup_enabled: true,
        mm2c_file_backup_type: 'markdown',
        mm2c_file_backup_path: '~/Downloads/meeting-notes',
      });
      await sendFromPage(popup, { type: 'MM2C_SNAPSHOT', text: 'snap body enabled', meetingTitle: 'Y' });
      await expect.poll(async () => {
        const sent = await getSent(ext.serviceWorker);
        const snap = sent.find(s => s.msg.type === 'snapshot');
        return snap ? { transcript: snap.msg.transcript, title: snap.msg.meetingTitle } : null;
      }).toEqual({ transcript: 'snap body enabled', title: 'Y' });
    });

    test('MM2C_SET_SNAPSHOT sets the tab-scoped key, then null removes it', async () => {
      await sendFromPage(popup, { type: 'MM2C_SET_SNAPSHOT', snapshot: 'hello' });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        const key = Object.keys(s).find(k => k.startsWith('mm2c_last_snapshot'));
        return key ? s[key] : undefined;
      }).toBe('hello');

      await sendFromPage(popup, { type: 'MM2C_SET_SNAPSHOT', snapshot: null });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, null);
        return Object.keys(s).some(k => k.startsWith('mm2c_last_snapshot'));
      }).toBe(false);
    });
  });

  test.describe('popup render', () => {
    // Seed storage, then (re)open the popup so popup.js renders from it.
    // `nativeResponder` (optional) overrides the SW-side native-message stub so
    // popup-init relays (e.g. MM2C_GCAL → gdocs_status) resolve to
    // real values through the genuine background relay BEFORE the popup renders.
    async function popupWith(state, nativeResponder) {
      await clearStorage(ext.serviceWorker);
      await stubNativeMessage(
        ext.serviceWorker,
        nativeResponder || { ping: { status: 'ok' }, __default: { status: 'ok' } }
      );
      await seedStorage(ext.serviceWorker, state);
      const page = await openPopup(ext.context, ext.extensionId);
      return page;
    }

    test('popup migrates legacy also-send into mm2c_destinations and clears it', async () => {
      const page = await popupWith({
        mm2c_destinations: [{ type: 'craft', folderId: 'F1' }],
        mm2c_also_send: ['apple_notes'],
      });
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_destinations', 'mm2c_also_send']);
        return { dests: s.mm2c_destinations, also: s.mm2c_also_send };
      }).toEqual({
        dests: [{ type: 'craft', folderId: 'F1' }, { type: 'apple_notes' }],
        also: undefined,
      });
      await page.close();
    });

    test('OUT-1: greys out unavailable outputs + warns when the selected primary is dead', async () => {
      const page = await popupWith(
        { mm2c_output_app: 'craft' },
        {
          ping: { status: 'ok' },
          destination_status: {
            status: 'ok',
            destinations: {
              craft:       { available: false, reason: 'Not installed' },
              bear:        { available: true,  reason: '' },
              apple_notes: { available: true,  reason: '' },
              google_docs: { available: false, reason: 'Not connected' },
              obsidian:    { available: true,  reason: '' },
            },
          },
          __default: { status: 'ok' },
        }
      );
      await page.click('#tab-settings');
      // Unavailable options are disabled + carry their reason as the title.
      await expect(page.locator('#output-app option[value="craft"]')).toBeDisabled();
      await expect(page.locator('#output-app option[value="craft"]')).toHaveAttribute('title', 'Not installed');
      // The reason is shown inline in the label too (not only on hover).
      await expect(page.locator('#output-app option[value="craft"]')).toContainText('Not installed');
      await expect(page.locator('#output-app option[value="google_docs"]')).toBeDisabled();
      await expect(page.locator('#output-app option[value="google_docs"]')).toHaveAttribute('title', 'Not connected');
      // Available ones stay enabled.
      await expect(page.locator('#output-app option[value="bear"]')).not.toBeDisabled();
      await expect(page.locator('#output-app option[value="apple_notes"]')).not.toBeDisabled();
      // The selected primary (craft) is unavailable → banner visible + names Craft + its reason.
      await expect(page.locator('#output-unavailable')).toBeVisible();
      await expect(page.locator('#output-unavailable')).toContainText('Craft');
      await expect(page.locator('#output-unavailable')).toContainText('Not installed');
      await page.close();
    });

    test('OUT-1: no banner when the selected primary output is available', async () => {
      const page = await popupWith(
        { mm2c_output_app: 'apple_notes' },
        {
          ping: { status: 'ok' },
          destination_status: {
            status: 'ok',
            destinations: {
              craft:       { available: false, reason: 'Not installed' },
              apple_notes: { available: true,  reason: '' },
              google_docs: { available: true,  reason: '' },
              obsidian:    { available: true,  reason: '' },
              bear:        { available: true,  reason: '' },
            },
          },
          __default: { status: 'ok' },
        }
      );
      await page.click('#tab-settings');
      // craft is not installed and isn't the selected primary → it's HIDDEN now
      // (only show detectable apps); the banner stays hidden since the *selected*
      // primary (apple_notes) is fine.
      await expect.poll(async () =>
        page.locator('#output-app option[value="craft"]').evaluate((o) => o.hidden)).toBe(true);
      await expect(page.locator('#output-unavailable')).toBeHidden();
      await page.close();
    });

    test('About tab renders the impact stats', async () => {
      const page = await popupWith({
        mm2c_stats: { meetingsAttended: 4, notesSaved: 3, wordsCaptured: 1200, totalMeetingMinutes: 95 },
      });
      await page.click('#tab-about');
      await expect(page.locator('#stats-grid')).toContainText('4');
      await expect(page.locator('#stats-grid')).toContainText('1,200');
      await expect(page.locator('#stats-grid')).toContainText('1h 35m');
      await page.close();
    });

    test('Hero banner + support nudge appear once meetings pass 24h', async () => {
      const page = await popupWith({
        mm2c_stats: { meetingsAttended: 9, notesSaved: 9, wordsCaptured: 1200, totalMeetingMinutes: 1500 },
      });
      await page.click('#tab-about');
      // The headline time-saved is promoted to the hero banner…
      await expect(page.locator('#impact-hero')).toBeVisible();
      await expect(page.locator('#impact-hero')).toContainText('saved roughly');
      await expect(page.locator('#impact-hero')).toContainText('9 notes saved across 9 meetings');
      // …and the savings line below is just the support ask (no duplicated time).
      await expect(page.locator('#stats-savings')).toContainText('supporting it');
      await expect(page.locator('#stats-savings')).not.toContainText('saved roughly');
      await page.close();
    });

    test('Hero banner + support nudge stay hidden under 24h of meetings', async () => {
      const page = await popupWith({
        mm2c_stats: { meetingsAttended: 3, notesSaved: 3, wordsCaptured: 1200, totalMeetingMinutes: 100 },
      });
      await page.click('#tab-about');
      await expect(page.locator('#stats-grid')).toContainText('1,200'); // stats still render
      await expect(page.locator('#impact-hero')).toBeHidden();          // but the hero is gated off
      await expect(page.locator('#stats-savings')).toBeHidden();        // and so is the nudge
      await page.close();
    });

    test('Logs tab renders a meeting group from seeded logs', async () => {
      const page = await popupWith({
        mm2c_logs: [{ ts: Date.now(), status: 'ok', title: 'Q3 Sync', message: 'Saved to Craft', level: 'user' }],
      });
      await page.click('#tab-logs');
      await expect(page.locator('#log-list')).toContainText('Q3 Sync');
      // The tab leads with a "History" section title like the other tabs (Rules/Settings).
      await expect(page.locator('#logs-panel .widget-title')).toHaveText('History');
      await page.close();
    });

    test('History: a saved Apple Notes link shows an "Open ↗" control (beta)', async () => {
      const page = await popupWith({
        mm2c_beta_enabled: true,
        mm2c_logs: [{ ts: 111, status: 'ok', title: 'Q3 Sync', message: 'Saved to Apple Notes', level: 'user',
                      link: { app: 'apple_notes', kind: 'note_id', value: 'x-coredata://S/ICNote/p9' } }],
      });
      await page.click('#tab-logs');
      const openBtn = page.locator('.log-open-btn');
      await expect(openBtn).toBeVisible();
      await expect(openBtn).toHaveAttribute('data-noteid', 'x-coredata://S/ICNote/p9');
      await page.close();
    });

    test('History: clicking Open on a deleted note drops the dead link', async () => {
      const page = await popupWith(
        {
          mm2c_beta_enabled: true,
          mm2c_logs: [{ ts: 222, status: 'ok', title: 'Gone Mtg', message: 'Saved to Apple Notes', level: 'user',
                        link: { app: 'apple_notes', kind: 'note_id', value: 'x-coredata://S/ICNote/dead' } }],
        },
        { open_note: { ok: false, reason: 'not_found' }, ping: { status: 'ok' }, __default: { status: 'ok' } },
      );
      await page.click('#tab-logs');
      await page.click('.log-open-btn');
      // not_found ⇒ the link is stripped from the entry (which re-renders → Open gone).
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_logs']))
          .mm2c_logs.find(e => e.ts === 222)?.link ?? 'removed')
        .toBe('removed');
      await expect(page.locator('.log-open-btn')).toHaveCount(0);
      await page.close();
    });

    test('setup wizard shows the capture step unchecked until the first note is saved (RB-7a)', async () => {
      // host ping ok (host step ✓) + output app set (output step ✓) + no notes
      // saved yet (capture step ✗) ⇒ wizard stays visible, not auto-dismissed.
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 2, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      });
      await expect(page.locator('#setup-wizard')).toBeVisible();
      await expect(page.locator('#setup-wizard-steps')).toContainText('Capture your first meeting');
      expect((await getStorage(ext.serviceWorker, ['mm2c_setup_dismissed'])).mm2c_setup_dismissed).toBeFalsy();
      await page.close();
    });

    test('setup wizard manual dismiss is a labelled ✕ that hides the card + persists (RB-7a)', async () => {
      // notesSaved:0 ⇒ the card stays visible, so the manual ✕ is exercised.
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 2, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      });
      const x = page.locator('#setup-wizard-dismiss');
      await expect(page.locator('#setup-wizard')).toBeVisible();
      // Compact ✕ with an accessible label (replaces the old "Dismiss" text link).
      await expect(x).toHaveText('✕');
      await expect(x).toHaveAttribute('aria-label', 'Dismiss');
      await x.click();
      await expect(page.locator('#setup-wizard')).toBeHidden();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_setup_dismissed'])).mm2c_setup_dismissed
      ).toBe(true);
      await page.close();
    });

    test('setup wizard auto-hides once every step (incl. optional Connect Google) is done (RB-7a)', async () => {
      // host ok + output app + a note saved + Google connected ⇒ every step incl.
      // the optional one is done, so nothing's left to show and the card hides.
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
        mm2c_google_connected: true,
      });
      await expect(page.locator('#setup-wizard')).toBeHidden();
      await page.close();
    });

    test('setup wizard stays up with the optional Connect-Google step pending (RB-7a)', async () => {
      // Required steps done but Google not connected ⇒ card stays, showing the
      // optional step — this is what re-surfaces for users who onboarded earlier.
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
      });
      await expect(page.locator('#setup-wizard')).toBeVisible();
      await expect(page.locator('#setup-wizard-steps')).toContainText('Connect Google');
      await page.close();
    });

    test('setup wizard shows a Connect button on the pending Google step (one-flow)', async () => {
      const page = await popupWith(
        {
          mm2c_output_app: 'craft',
          mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
        },
        {
          ping: { status: 'ok' },
          google_status: { connected: false, available: true },
          __default: { status: 'ok' },
        }
      );
      await expect(page.locator('#setup-wizard')).toBeVisible();
      await expect(page.locator('#setup-google-connect')).toBeVisible();
      await expect(page.locator('#setup-google-connect')).toHaveText('Connect');
      await page.close();
    });

    test('clicking Connect sends google_connect then polls google_status → ticks the step', async () => {
      const page = await popupWith(
        {
          mm2c_output_app: 'craft',
          mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
        },
        {
          ping: { status: 'ok' },
          google_status: { connected: false, available: true },
          __default: { status: 'ok' },
        }
      );
      await expect(page.locator('#setup-google-connect')).toBeVisible();
      await page.click('#setup-google-connect');
      // google_connect was relayed to the host.
      await expect.poll(async () =>
        (await getSent(ext.serviceWorker)).some(s => s.msg.type === 'google_connect')
      ).toBe(true);
      // The detached flow "completes": flip the host status to connected (without
      // clearing the recorded calls) so the popup's poll observes it next tick.
      await ext.serviceWorker.evaluate(() => {
        const prior = chrome.runtime.sendNativeMessage;
        chrome.runtime.sendNativeMessage = (host, msg, cb) => {
          globalThis.__nativeSent.push({ host, msg });
          const resp = msg.type === 'google_status'
            ? { connected: true, available: true, email: 'me@x.com' }
            : { status: 'ok' };
          if (cb) setTimeout(() => cb(resp), 0);
        };
        void prior;
      });
      // The poll flips storage → the step ticks.
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_google_connected'])).mm2c_google_connected,
        { timeout: 15000 }
      ).toBe(true);
      await page.close();
    });

    test('load-time status sync ticks the Google step when the host reports connected', async () => {
      // Host already connected (e.g. connected outside the popup) but storage not
      // yet set → the load-time sync should set mm2c_google_connected and hide the
      // card (all steps now done).
      const page = await popupWith(
        {
          mm2c_output_app: 'craft',
          mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
        },
        {
          ping: { status: 'ok' },
          google_status: { connected: true, available: true, email: 'me@x.com' },
          __default: { status: 'ok' },
        }
      );
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_google_connected'])).mm2c_google_connected
      ).toBe(true);
      await expect(page.locator('#setup-wizard')).toBeHidden();
      await page.close();
    });

    test('Settings: Privacy settings sits between File backup and Experimental (UXF-13 reorder)', async () => {
      const page = await popupWith({});
      await page.click('#tab-settings');
      const order = await page.evaluate(() => {
        const titles = [...document.getElementById('settings-panel').querySelectorAll('.widget-title')]
          .map(t => t.textContent.trim());
        return {
          fileBackup: titles.indexOf('File backup'),
          privacy: titles.findIndex(t => t.startsWith('Privacy settings')),
          experimental: titles.indexOf('Experimental'),
        };
      });
      expect(order.fileBackup).toBeGreaterThanOrEqual(0);
      expect(order.privacy).toBeGreaterThan(order.fileBackup);
      expect(order.experimental).toBeGreaterThan(order.privacy);
      await page.close();
    });

    test('Rules tab renders a seeded rule row', async () => {
      const page = await popupWith({ mm2c_prompt_rules: [{ regex: 'standup', prompt: 'Brief notes' }] });
      await page.click('#tab-rules');
      await expect(page.locator('#rules-list .rule-regex')).toHaveValue('standup');
      await page.close();
    });

    test('built-in templates are off by default and materialise into rules when switched on', async () => {
      const page = await popupWith({}); // fresh: no user rules
      await page.click('#tab-rules');
      // Templates show as available, all OFF (off by default).
      const toggles = page.locator('#builtin-rules-list .builtin-enabled');
      const count = await toggles.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) await expect(toggles.nth(i)).not.toBeChecked();
      // No rules yet.
      expect((await getStorage(ext.serviceWorker, ['mm2c_prompt_rules'])).mm2c_prompt_rules || []).toEqual([]);
      // Switch 'Standup' on → it materialises into mm2c_prompt_rules as an enabled,
      // editable rule (with its name + regex + prompt) and leaves the template list.
      await page.locator('#builtin-rules-list .builtin-rule:has(.builtin-enabled[data-name="Standup"]) label.toggle-wrap').click();
      await expect.poll(async () => {
        const r = (await getStorage(ext.serviceWorker, ['mm2c_prompt_rules'])).mm2c_prompt_rules || [];
        const s = r.find(x => x.name === 'Standup');
        return s && s.enabled === true && typeof s.regex === 'string' && typeof s.prompt === 'string';
      }).toBe(true);
      // The materialised template no longer appears as an available template…
      await expect(page.locator('#builtin-rules-list .builtin-enabled[data-name="Standup"]')).toHaveCount(0);
      // …and now appears as an editable rule (name badge + a toggle on the right).
      await expect(page.locator('#rules-list .rule-name', { hasText: 'Standup' })).toBeVisible();
      await expect(page.locator('#rules-list .rule-item .rule-toggle')).toHaveCount(1);
      await page.close();
    });

    test('a materialised rule row fits within the popup (no horizontal overflow)', async () => {
      // Regression: name badge + regex + ↑↓✕ + toggle must fit in 340px — the
      // regex input has to shrink (min-width:0) or the toggle overflows off-screen.
      const page = await popupWith({
        mm2c_prompt_rules: [{ name: 'Standup', regex: 'standup|stand-up|daily|scrum', prompt: 'p', enabled: true }],
      });
      await page.click('#tab-rules');
      const fits = await page.evaluate(() => {
        // The chevron is the right-most header control; its right edge must stay
        // within the popup body width (and the header must not overflow).
        const chev = document.querySelector('#rules-list .rule-expand');
        const hdr  = document.querySelector('#rules-list .rule-header');
        if (!chev || !hdr) return false;
        return Math.round(chev.getBoundingClientRect().right) <= document.body.clientWidth
          && hdr.scrollWidth <= hdr.clientWidth + 1;
      });
      expect(fits).toBe(true);
      await page.close();
    });

    test('editable rules collapse/expand via the right-side chevron', async () => {
      const page = await popupWith({
        mm2c_prompt_rules: [{ name: 'Standup', regex: 'standup', prompt: 'p', enabled: true }],
      });
      await page.click('#tab-rules');
      const body = page.locator('#rules-list .rule-item .rule-body');
      const chev = page.locator('#rules-list .rule-item .rule-expand');
      await expect(chev).toHaveCount(1);
      await expect(body).toBeHidden();   // collapsed by default (tidy, like templates)
      await chev.click();
      await expect(body).toBeVisible();  // chevron expands the prompt/conditions
      await chev.click();
      await expect(body).toBeHidden();   // and collapses again
      await page.close();
    });

    test('Add rule appends a new auto-expanded rule and persists it', async () => {
      const page = await popupWith({});
      await page.click('#tab-rules');
      await page.click('#add-rule-btn');
      const item = page.locator('#rules-list .rule-item');
      await expect(item).toHaveCount(1);
      // New rule is auto-expanded for editing (popup.js:1030 → expandedRuleIdx.add).
      await expect(item.locator('.rule-body')).toBeVisible();
      await expect.poll(async () =>
        ((await getStorage(ext.serviceWorker, ['mm2c_prompt_rules'])).mm2c_prompt_rules || []).length
      ).toBe(1);
      await page.close();
    });

    // Regression: clicking an ↑/↓/✕ action focuses the button; the re-render then
    // detaches it, firing a capture-phase blur → saveRuleFromEvent. Without the
    // detached-row guard that stray save clobbered the reorder/delete (reorder →
    // duplicate, delete → wrong survivor). These assert the real mouse-click path.
    test('reorder (down) swaps the stored order and resets expand state', async () => {
      const page = await popupWith({ mm2c_prompt_rules: [
        { regex: 'aaa', prompt: 'x', enabled: true },
        { regex: 'bbb', prompt: 'y', enabled: true },
      ] });
      await page.click('#tab-rules');
      const expands = page.locator('#rules-list .rule-expand');
      await expands.nth(0).click();
      await expands.nth(1).click(); // expand both rows
      await page.locator('#rules-list .rule-item').nth(0)
        .locator('.btn-rule-action[data-action="down"]').click();
      await expect.poll(async () => {
        const r = (await getStorage(ext.serviceWorker, ['mm2c_prompt_rules'])).mm2c_prompt_rules || [];
        return r.map(x => x.regex).join(',');
      }).toBe('bbb,aaa'); // would be 'aaa,aaa' with the stale-blur bug
      const bodies = page.locator('#rules-list .rule-item .rule-body');
      const n = await bodies.count();
      for (let i = 0; i < n; i++) await expect(bodies.nth(i)).toBeHidden(); // expand state cleared
      await page.close();
    });

    test('delete removes the CORRECT rule (no stale-blur clobber)', async () => {
      const page = await popupWith({ mm2c_prompt_rules: [
        { regex: 'first', prompt: 'x', enabled: true },
        { regex: 'second', prompt: 'y', enabled: true },
      ] });
      await page.click('#tab-rules');
      // Delete the FIRST rule → 'second' must survive (the bug kept the wrong one).
      await page.locator('#rules-list .rule-item').nth(0)
        .locator('.btn-rule-action[data-action="delete"]').click();
      await expect.poll(async () => {
        const r = (await getStorage(ext.serviceWorker, ['mm2c_prompt_rules'])).mm2c_prompt_rules || [];
        return r.map(x => x.regex).join(',');
      }).toBe('second');
      await page.close();
    });

    test('#default-expand toggles the Default rule body and chevron', async () => {
      const page = await popupWith({});
      await page.click('#tab-rules');
      const body = page.locator('#default-rule .rule-body');
      const chev = page.locator('#default-expand');
      await expect(body).toBeHidden();              // collapsed initially
      await chev.click();
      await expect(body).toBeVisible();             // expands
      await expect(chev).toHaveClass(/open/);       // chevron gets .open
      await chev.click();
      await expect(body).toBeHidden();              // collapses again
      await page.close();
    });

    test('Main tab renders a retry card from a failed-send entry', async () => {
      const page = await popupWith({
        mm2c_failed_list: [{ tabId: null, title: 'Lost Meeting', backupPath: '/tmp/x.md', failedAt: Date.now() }],
      });
      await expect(page.locator('#retry-list')).toContainText('Lost Meeting');
      await expect(page.locator('#retry-list .retry-btn')).toBeVisible();
      await page.close();
    });

    test('Beta tab appears when experimental is on and gathers the beta widgets (UXF-14)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await expect(page.locator('#tab-beta')).toBeVisible();
      await page.click('#tab-beta');
      await expect(page.locator('#beta-panel #selector-hotfix-url')).toBeVisible();
      await page.close();
    });

    test('advanced features are hidden when Experimental is OFF (beta gating)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: false });
      await page.click('#tab-settings');
      // Beta-gated widget (selector hotfix) lives behind the hidden Beta tab.
      await expect(page.locator('#tab-beta')).not.toBeVisible();
      await expect(page.locator('#selector-hotfix-url')).not.toBeVisible();
      // Core Settings stay visible. Additional destinations promoted out of beta —
      // visible regardless of the Experimental toggle.
      await expect(page.locator('#output-app')).toBeVisible();
      await expect(page.locator('#add-destination')).toBeVisible();
      await expect(page.getByText('Privacy settings')).toBeVisible();      // card title (production)
      await expect(page.getByText('Local backups')).toBeVisible();         // retention sub-section stays
      await expect(page.locator('#clear-logs')).toBeVisible();             // Clear moved here (production)
      // Diagnostics: Developer logs + Download promoted out of beta — visible regardless of Experimental.
      // (#show-debug-logs is a styled toggle: assert its visible label, not the opacity-0 input.)
      await expect(page.locator('label.toggle-wrap', { has: page.locator('#show-debug-logs') })).toBeVisible();
      await expect(page.locator('#download-logs')).toBeVisible();
      // Rules-tab: the unified rules list (Default row) stays.
      await page.click('#tab-rules');
      await expect(page.locator('#default-rule')).toBeVisible();
      await page.close();
    });

    test('advanced features appear when Experimental is ON (beta gating)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await expect(page.locator('#tab-beta')).toBeVisible();
      await page.click('#tab-beta');
      await expect(page.locator('#selector-hotfix-url')).toBeVisible();
      await page.close();
    });

    test('Clear (now in Privacy settings) empties the activity log', async () => {
      const page = await popupWith({
        mm2c_logs: [{ ts: Date.now(), status: 'ok', title: 'Standup', message: 'Saved', level: 'user' }],
      });
      await page.click('#tab-settings');
      await page.click('#clear-logs');
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_logs'])).mm2c_logs)
        .toEqual([]);
      await page.close();
    });

    test('History auto-cleanup: toggle + days persist', async () => {
      const page = await popupWith({});
      await page.click('#tab-settings');
      await page.locator('label.toggle-wrap', { has: page.locator('#logs-cleanup-enabled') }).click();
      // 14 ≠ the default (7) so the change event actually fires and persists.
      await page.fill('#logs-cleanup-days', '14');
      await page.locator('#logs-cleanup-days').blur();
      await expect.poll(async () => {
        const s = await getStorage(ext.serviceWorker, ['mm2c_logs_cleanup_enabled', 'mm2c_logs_cleanup_days']);
        return { on: s.mm2c_logs_cleanup_enabled, days: s.mm2c_logs_cleanup_days };
      }).toEqual({ on: true, days: 14 });
      await page.close();
    });

    test('Developer logs toggle persists across popup opens', async () => {
      // Toggling it on saves the preference…
      const page = await popupWith({});
      await page.click('#tab-settings');
      await page.locator('label.toggle-wrap', { has: page.locator('#show-debug-logs') }).click();
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_show_debug_logs'])).mm2c_show_debug_logs)
        .toBe(true);
      await page.close();
      // …and a fresh popup restores the checked state (no longer session-only).
      const page2 = await popupWith({ mm2c_show_debug_logs: true });
      await page2.click('#tab-settings');
      await expect(page2.locator('#show-debug-logs')).toBeChecked();
      await page2.close();
    });

    test('Developer logs toggle defaults OFF on a fresh install', async () => {
      const page = await popupWith({}); // empty storage = fresh install (no seeded key)
      await page.click('#tab-settings');
      await expect(page.locator('#show-debug-logs')).not.toBeChecked();
      await page.close();
    });

    test('History auto-cleanup: entries older than N days are pruned on open', async () => {
      const DAY = 86400000;
      const now = Date.now();
      const page = await popupWith({
        mm2c_logs_cleanup_enabled: true,
        mm2c_logs_cleanup_days: 30,
        mm2c_logs: [
          { ts: now - 2 * DAY,  status: 'ok', title: 'Recent', message: 'kept',    level: 'user' },
          { ts: now - 45 * DAY, status: 'ok', title: 'Ancient', message: 'dropped', level: 'user' },
        ],
      });
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_logs'])).mm2c_logs.map(e => e.title)
      ).toEqual(['Recent']);
      await page.close();
    });

    test('Beta tab renders seeded additional-destination rows (UXF-11)', async () => {
      const page = await popupWith({
        mm2c_beta_enabled: true,
        mm2c_destinations: [
          { type: 'obsidian', vaultPath: '/tmp/VaultA' },
          { type: 'craft', folderId: 'fid-123' },
        ],
      });
      await page.click('#tab-beta');
      const rows = page.locator('#destinations-list .dest-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator('.dest-type')).toHaveValue('obsidian');
      await expect(rows.nth(0).locator('.dest-config')).toHaveValue('/tmp/VaultA');
      await expect(rows.nth(1).locator('.dest-type')).toHaveValue('craft');
      await expect(rows.nth(1).locator('.dest-config')).toHaveValue('fid-123');
      await page.close();
    });

    test('Additional destinations: an Apple Notes row gets the no-config layout (hidden field)', async () => {
      const page = await popupWith({
        mm2c_output_app: 'craft', // so apple_notes is offered as an extra
        mm2c_destinations: [{ type: 'apple_notes' }],
      });
      await page.click('#tab-settings');
      const row = page.locator('#destinations-list .dest-row').first();
      await expect(row.locator('.dest-type')).toHaveValue('apple_notes');
      await expect(row).toHaveClass(/no-config/);            // dropdown fills the row → ✕ aligned
      await expect(row.locator('.dest-config')).toBeHidden(); // no config field for Apple Notes
      await page.close();
    });

    test('Additional destinations: Google Docs is an option + reveals the connection widget (5.7)', async () => {
      const page = await popupWith({
        mm2c_output_app: 'craft', // craft primary → Google Docs offered as an extra
        mm2c_destinations: [{ type: 'google_docs' }],
      });
      await page.click('#tab-settings');
      const row = page.locator('#destinations-list .dest-row').first();
      await expect(row.locator('.dest-type')).toHaveValue('google_docs');
      // The option is selectable, and the shared connection widget shows because GDocs is in use.
      await expect(row.locator('.dest-type option[value="google_docs"]')).toHaveCount(1);
      await expect(page.locator('#gdocs-conn')).toBeVisible();
      await page.close();
    });

    test('Additional destinations: Google Docs is excluded when it is the primary (dedupe)', async () => {
      const page = await popupWith({
        mm2c_output_app: 'google_docs', // primary → must not be offered/kept as an extra
        mm2c_destinations: [{ type: 'apple_notes' }],
      });
      await page.click('#tab-settings');
      const row = page.locator('#destinations-list .dest-row').first();
      // The apple_notes row's type dropdown must NOT offer google_docs (it's the primary).
      await expect(row.locator('.dest-type option[value="google_docs"]')).toHaveCount(0);
      await page.close();
    });

    test('Adding + filling an additional destination persists to storage (UXF-11)', async () => {
      const page = await popupWith({ mm2c_destinations: [] });
      await page.click('#tab-settings'); // promoted out of beta — now in Settings
      await page.click('#add-destination');
      const row = page.locator('#destinations-list .dest-row').first();
      // Default new row is obsidian; fill its vault path and assert it persists.
      await row.locator('.dest-config').fill('/tmp/NewVault');
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_destinations'])).mm2c_destinations
      ).toEqual([{ type: 'obsidian', vaultPath: '/tmp/NewVault' }]);
      // Removing the row clears it back to [].
      await row.locator('.dest-remove').click();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_destinations'])).mm2c_destinations
      ).toEqual([]);
      await page.close();
    });

    test('Google Docs primary reveals the Google Docs connection widget (5.7)', async () => {
      const page = await popupWith({ mm2c_output_app: 'google_docs' });
      await page.click('#tab-settings');
      await expect(page.locator('#output-app')).toHaveValue('google_docs');
      await expect(page.locator('#gdocs-conn')).toBeVisible();      // connection control shown
      await expect(page.locator('#gdocs-connect')).toBeVisible();
      await page.close();
    });

    test('Selecting Google Docs as the primary persists mm2c_output_app + shows the connection widget (5.7)', async () => {
      const page = await popupWith({ mm2c_output_app: 'none' });
      await page.click('#tab-settings');
      await expect(page.locator('#gdocs-conn')).toBeHidden(); // not in use yet
      await page.selectOption('#output-app', 'google_docs');
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_output_app'])).mm2c_output_app
      ).toBe('google_docs');
      await expect(page.locator('#gdocs-conn')).toBeVisible(); // connection control revealed
      await page.close();
    });

    test('Beta tab is hidden when experimental is off (UXF-14)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: false });
      await expect(page.locator('#tab-beta')).toBeHidden();
      await page.close();
    });

    test('Main tab renders the crash-recovery card from an in-flight note (RB-1d)', async () => {
      const page = await popupWith({
        // `at` older than the 60s grace window so inflightRecoverable() is true.
        mm2c_inflight: { title: 'Crashed Meeting', text: 'recovered notes body', at: Date.now() - 70000 },
      });
      await expect(page.locator('#recovery-list')).toContainText('unsent note was recovered');
      await expect(page.locator('#recovery-list #recover-send')).toBeVisible();
      await page.close();
    });

    test('Google Docs status: not installed shows the re-run install hint + Connect (5.7)', async () => {
      const page = await popupWith({ mm2c_output_app: 'google_docs' }, {
        gdocs_status: { connected: false, available: false },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      await expect.poll(async () => page.locator('#gdocs-status').textContent())
        .toContain('Not set up — re-run install');
      await expect(page.locator('#gdocs-connect')).toHaveText('Connect');
      await page.close();
    });

    test('Google Docs status: connected shows "Connected as …" + Disconnect (5.7)', async () => {
      const page = await popupWith({ mm2c_output_app: 'google_docs' }, {
        gdocs_status: { connected: true, available: true, email: 'me@x' },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      await expect.poll(async () => page.locator('#gdocs-status').textContent())
        .toContain('Connected as me@x');
      await expect(page.locator('#gdocs-connect')).toHaveText('Disconnect');
      await page.close();
    });

    test('Google Docs Disconnect relays gdocs_disconnect to the host (5.7)', async () => {
      const page = await popupWith({ mm2c_output_app: 'google_docs' }, {
        gdocs_status: { connected: true, available: true, email: 'me@x' },
        gdocs_disconnect: { ok: true },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      await expect(page.locator('#gdocs-connect')).toHaveText('Disconnect'); // render set it
      await page.click('#gdocs-connect');                                    // → disconnect path
      await expect
        .poll(async () => (await getSent(ext.serviceWorker)).some(s => s.msg && s.msg.type === 'gdocs_disconnect'))
        .toBe(true);
      await page.close();
    });

    test('Settings → Privacy: Google account Disconnect relays google_disconnect + clears the connect flag', async () => {
      const page = await popupWith({
        mm2c_google_connected: true,
      }, {
        google_status: { connected: true, available: true, email: 'me@x' },
        google_disconnect: { ok: true },
        gdocs_status: { connected: false, available: false },
        destination_status: { status: 'ok', destinations: { google_docs: { available: false, reason: 'Not connected' } } },
        ping: { status: 'ok' }, __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      await expect.poll(async () => page.locator('#google-acct-status').textContent())
        .toContain('Connected as me@x');
      await expect(page.locator('#google-acct-btn')).toHaveText('Disconnect');
      await page.click('#google-acct-btn');
      // Relays google_disconnect to the host…
      await expect.poll(async () =>
        (await getSent(ext.serviceWorker)).some(s => s.msg && s.msg.type === 'google_disconnect')).toBe(true);
      // …and clears the onboarding tick.
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_google_connected'])))
        .toEqual({ mm2c_google_connected: false });
      await page.close();
    });

    test('onboarding Connect surfaces an error instead of spinning forever when it cannot connect (BUG-14)', async () => {
      const page = await popupWith({ mm2c_setup_dismissed: false }, {
        google_status: { connected: false, available: true },
        google_connect: { status: 'error', error: 'Google isn’t set up on this Mac — no credentials.json (see GDOCS_SETUP.md).' },
        ping: { status: 'ok' }, __default: { status: 'ok' },
      });
      const btn = page.locator('#setup-google-connect');
      await expect(btn).toHaveText('Connect');
      await btn.click();
      // It must NOT get stuck on "Connecting…" — it resets to Connect + shows why.
      await expect(btn).toHaveText('Connect');
      await expect(page.locator('#setup-google-error')).toBeVisible();
      await expect(page.locator('#setup-google-error')).toContainText('credentials.json');
      await page.close();
    });

    test('output dropdown hides not-installed apps, greys connectable ones, keeps the current pick visible', async () => {
      const page = await popupWith({ mm2c_output_app: 'bear' }, {
        destination_status: { status: 'ok', destinations: {
          bear: { available: false, reason: 'Not installed' },        // the current pick
          craft: { available: false, reason: 'Not installed' },       // not selected
          google_docs: { available: false, reason: 'Not connected' }, // connectable, not installed-detection
          apple_notes: { available: true, reason: '' },
          obsidian: { available: true, reason: '' },
        } },
        ping: { status: 'ok' }, __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      const opt = (v) => page.locator(`#output-app option[value="${v}"]`);
      // Current pick (bear, not installed) stays VISIBLE + greyed so you can see/change it.
      await expect.poll(async () => opt('bear').evaluate((o) => o.hidden)).toBe(false);
      await expect(opt('bear')).toBeDisabled();
      // A not-installed app you didn't pick → HIDDEN (not just greyed).
      await expect.poll(async () => opt('craft').evaluate((o) => o.hidden)).toBe(true);
      // Connectable (not connected) → VISIBLE + greyed, so it stays discoverable.
      await expect.poll(async () => opt('google_docs').evaluate((o) => o.hidden)).toBe(false);
      await expect(opt('google_docs')).toBeDisabled();
      await page.close();
    });

    test('additional-destination rows offer Bear + apply OUT-1 availability (parity with primary)', async () => {
      const page = await popupWith({
        mm2c_output_app: 'obsidian',
        mm2c_destinations: [{ type: 'craft' }],
      }, {
        destination_status: { status: 'ok', destinations: {
          bear: { available: true, reason: '' },
          google_docs: { available: false, reason: 'Not connected' },
          craft: { available: true }, apple_notes: { available: true }, obsidian: { available: true },
        } },
        ping: { status: 'ok' }, __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      const rowSel = '#destinations-list select.dest-type';
      // Bug 1: Bear is now offered as an additional destination (was missing).
      await expect(page.locator(`${rowSel} option[value="bear"]`).first()).toHaveCount(1);
      // Bug 2: an un-connected Google Docs is greyed in the row, like the primary.
      await expect(page.locator(`${rowSel} option[value="google_docs"]`).first()).toBeDisabled();
      await page.close();
    });

    test('adding a destination keeps an un-connected app greyed in the freshly-built row', async () => {
      // A re-render rebuilds the row dropdowns; greying must re-apply (from the
      // cached status) so there's no window where Google Docs is selectable while
      // not connected — matching the primary dropdown.
      const page = await popupWith({
        mm2c_output_app: 'obsidian',
        mm2c_destinations: [{ type: 'craft' }],
      }, {
        destination_status: { status: 'ok', destinations: {
          google_docs: { available: false, reason: 'Not connected' },
          craft: { available: true }, apple_notes: { available: true },
          obsidian: { available: true }, bear: { available: true },
        } },
        ping: { status: 'ok' }, __default: { status: 'ok' },
      });
      await page.click('#tab-settings');
      // initial status populates the cache (existing row greys Google Docs)
      await expect(page.locator('#destinations-list select.dest-type option[value="google_docs"]').first()).toBeDisabled();
      // add a destination → the NEW row's Google Docs option must be greyed too
      await page.click('#add-destination');
      await expect(page.locator('#destinations-list .dest-row:last-child select.dest-type option[value="google_docs"]')).toBeDisabled();
      await page.close();
    });

    test('popup self-heals duplicate/primary destinations on load', async () => {
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_destinations: [
          { type: 'apple_notes' }, { type: 'apple_notes' },
          { type: 'craft', folderId: '' },
          { type: 'obsidian', vaultPath: '' }, { type: 'obsidian', vaultPath: '' },
        ],
      });
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_destinations'])).mm2c_destinations
      ).toEqual([{ type: 'apple_notes' }, { type: 'obsidian', vaultPath: '' }]);
      await page.close();
    });

    test('popup disables Add destination when all apps are used', async () => {
      const page = await popupWith({
        mm2c_output_app: 'craft', // craft is primary → obsidian + apple_notes + bear + google_docs addable
        mm2c_destinations: [{ type: 'apple_notes' }, { type: 'obsidian', vaultPath: '' }, { type: 'bear' }, { type: 'google_docs' }],
      });
      await page.click('#tab-settings');
      await expect(page.locator('#add-destination')).toBeDisabled();
      await page.close();
    });

    test('Backup-cleanup clampDays clamps to [1, 3650] + persists the clamped value (UXF-13)', async () => {
      const page = await popupWith({});
      await page.click('#tab-settings'); // promoted out of beta — now in Settings

      // clampDays = Math.max(1, Math.min(3650, parseInt(v,10) || 30)). A value
      // below the floor (negative) clamps UP to 1; an over-max clamps DOWN to 3650.
      const snapDays = page.locator('#cleanup-snap-days');

      // Set the input's value directly (a number input rejects fill('-5')), then
      // fire the real change handler the way the browser would.
      await snapDays.evaluate((el) => { el.value = '-5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await expect(snapDays).toHaveValue('1');
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_cleanup_snap_days'])).mm2c_cleanup_snap_days
      ).toBe(1);

      await snapDays.evaluate((el) => { el.value = '9999'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await expect(snapDays).toHaveValue('3650');
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_cleanup_snap_days'])).mm2c_cleanup_snap_days
      ).toBe(3650);

      // Toggling the snapshot-cleanup switch persists mm2c_cleanup_snap_enabled.
      const wrap = page.locator('label.toggle-wrap', { has: page.locator('#cleanup-snap-enabled') });
      await wrap.click();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_cleanup_snap_enabled'])).mm2c_cleanup_snap_enabled
      ).toBe(true);
      await page.close();
    });
  });
});
