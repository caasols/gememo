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

    test('MM2C_RESPONSE forwards googleDocsOutput:true when beta is ON (5.7)', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_beta_enabled: true,
        mm2c_gdocs_enabled: true,
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'beta on gdocs payload',
        meetingTitle: 'Gdocs On',
      });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'beta on gdocs payload');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.googleDocsOutput).toBe(true);
    });

    test('MM2C_RESPONSE sends googleDocsOutput:false when beta is OFF even with seeded data (5.7)', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_beta_enabled: false,
        mm2c_gdocs_enabled: true,
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'beta off gdocs payload',
        meetingTitle: 'Gdocs Off',
      });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'beta off gdocs payload');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.googleDocsOutput).toBe(false);
    });

    test('MM2C_GCAL relays the action to the host', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        gcal_status: { connected: true, available: true, email: 'me@x.com' },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_GCAL', action: 'gcal_status' });
      expect(resp.connected).toBe(true);
      expect(resp.email).toBe('me@x.com');
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.type === 'gcal_status')).toBe(true);
    });

    test('MM2C_SEARCH relays query + filters to the host', async () => {
      await stubNativeMessage(ext.serviceWorker, {
        search: { status: 'ok', results: [{ title: 'Q3 Sync', date: '2026-06-05', snippet: '…' }] },
        __default: { status: 'ok' },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_SEARCH', query: 'q3', since: '2026-06-01' });
      expect(resp.ok).toBe(true);
      expect(resp.results[0].title).toBe('Q3 Sync');
      const sent = await getSent(ext.serviceWorker);
      const call = sent.find(s => s.msg.type === 'search');
      expect(call.msg.query).toBe('q3');
      expect(call.msg.since).toBe('2026-06-01');
    });

    test('MM2C_PRE_BRIEF beta OFF returns beta_off WITHOUT calling the host (P9-G)', async () => {
      await seedStorage(ext.serviceWorker, { mm2c_beta_enabled: false });
      const resp = await sendFromPage(popup, { type: 'MM2C_PRE_BRIEF' });
      expect(resp).toEqual({ ok: false, error: 'beta_off' });
      // Invariant: the native host must NOT have been called.
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.type === 'pre_meeting_brief')).toBe(false);
    });

    test('MM2C_PRE_BRIEF with no active Meet tab returns no_meet_tab (P9-G)', async () => {
      await seedStorage(ext.serviceWorker, { mm2c_beta_enabled: true });
      // No meet.google.com tab is open in this context; the popup is the only tab.
      const resp = await sendFromPage(popup, { type: 'MM2C_PRE_BRIEF' });
      expect(resp).toEqual({ ok: false, error: 'no_meet_tab' });
      const sent = await getSent(ext.serviceWorker);
      expect(sent.some(s => s.msg.type === 'pre_meeting_brief')).toBe(false);
    });

    test('MM2C_PRE_BRIEF with beta ON relays the host bullets (P9-G)', async () => {
      await seedStorage(ext.serviceWorker, { mm2c_beta_enabled: true, mm2c_redact_pii: false });
      await stubNativeMessage(ext.serviceWorker, {
        pre_meeting_brief: { ok: true, matched: true, title: 'Q3 Planning',
                             bullets: ['Agenda: Roadmap', 'Who: 2 attendees'] },
        __default: { status: 'ok' },
      });
      // Stub chrome.tabs.query so the handler sees an active Meet tab without
      // needing to launch a real meet.google.com page (blocked headlessly).
      await ext.serviceWorker.evaluate(() => {
        globalThis.__origQuery = chrome.tabs.query;
        chrome.tabs.query = (info, cb) => cb([
          { id: 1, active: true, url: 'https://meet.google.com/abc-defg-hij?authuser=0', title: 'Q3 Planning' },
        ]);
      });
      try {
        const resp = await sendFromPage(popup, { type: 'MM2C_PRE_BRIEF' });
        expect(resp.ok).toBe(true);
        expect(resp.matched).toBe(true);
        expect(resp.bullets).toEqual(['Agenda: Roadmap', 'Who: 2 attendees']);
        // The host got the parsed room code + redaction flag.
        const sent = await getSent(ext.serviceWorker);
        const call = sent.find(s => s.msg.type === 'pre_meeting_brief');
        expect(call).toBeTruthy();
        expect(call.msg.meetingCode).toBe('abc-defg-hij');
        expect(call.msg.redactPii).toBe(false);
        expect(call.msg.meetingTitle).toBe('Q3 Planning');
      } finally {
        await ext.serviceWorker.evaluate(() => { chrome.tabs.query = globalThis.__origQuery; });
      }
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
        mm2c_calendar_enabled: true,
        mm2c_cleanup_snap_enabled: true, mm2c_cleanup_snap_days: 7,
        mm2c_beta_enabled: true, mm2c_gdocs_enabled: true,
        mm2c_inflight: { title: 'Recovered', text: 'recovered body', durationMin: 20, at },
      });
      const resp = await sendFromPage(popup, { type: 'MM2C_RECOVER' });
      expect(resp.ok).toBe(true);
      await expect.poll(async () => {
        const fwd = (await getSent(ext.serviceWorker)).find(s => s.msg.transcript === 'recovered body');
        if (!fwd) return null;
        return {
          cal: fwd.msg.calendarEnabled,
          cleanup: fwd.msg.backupCleanup?.snapshots?.enabled,
          gdocs: fwd.msg.googleDocsOutput,
          ts: fwd.msg.timestamp,
          recover: fwd.msg.recover,
        };
      }).toEqual({ cal: true, cleanup: true, gdocs: true, ts: new Date(at).toISOString(), recover: true });
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
    // popup-init relays (e.g. MM2C_GCAL → gcal_status/gdocs_status) resolve to
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

    test('Support nudge appears once meetings pass 24h', async () => {
      const page = await popupWith({
        mm2c_stats: { meetingsAttended: 9, notesSaved: 9, wordsCaptured: 1200, totalMeetingMinutes: 1500 },
      });
      await page.click('#tab-about');
      await expect(page.locator('#stats-savings')).toContainText('saved you roughly');
      await expect(page.locator('#stats-savings')).toContainText('supporting it');
      await page.close();
    });

    test('Support nudge stays hidden under 24h of meetings', async () => {
      const page = await popupWith({
        mm2c_stats: { meetingsAttended: 3, notesSaved: 3, wordsCaptured: 1200, totalMeetingMinutes: 100 },
      });
      await page.click('#tab-about');
      await expect(page.locator('#stats-grid')).toContainText('1,200'); // stats still render
      await expect(page.locator('#stats-savings')).toBeHidden();        // but the nudge block is gated off
      await page.close();
    });

    test('Logs tab renders a meeting group from seeded logs', async () => {
      const page = await popupWith({
        mm2c_logs: [{ ts: Date.now(), status: 'ok', title: 'Q3 Sync', message: 'Saved to Craft', level: 'user' }],
      });
      await page.click('#tab-logs');
      await expect(page.locator('#log-list')).toContainText('Q3 Sync');
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
      expect((await getStorage(ext.serviceWorker, ['mm2c_setup_done'])).mm2c_setup_done).toBeFalsy();
      await page.close();
    });

    test('setup wizard auto-dismisses once all three steps are complete (RB-7a)', async () => {
      // host ping ok + output app set + a note already saved (notesSaved>0) ⇒
      // every step is done, so the card persists mm2c_setup_done and hides.
      const page = await popupWith({
        mm2c_output_app: 'craft',
        mm2c_stats: { meetingsAttended: 2, notesSaved: 1, wordsCaptured: 50, totalMeetingMinutes: 20 },
      });
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_setup_done'])).mm2c_setup_done
      ).toBe(true);
      await expect(page.locator('#setup-wizard')).toBeHidden();
      await page.close();
    });

    test('Settings: Backup cleanup sits between File backup and Experimental (UXF-13 reorder)', async () => {
      const page = await popupWith({});
      await page.click('#tab-settings');
      const order = await page.evaluate(() => {
        const titles = [...document.getElementById('settings-panel').querySelectorAll('.widget-title')]
          .map(t => t.textContent.trim());
        return {
          fileBackup: titles.indexOf('File backup'),
          cleanup: titles.findIndex(t => t.startsWith('Backup cleanup')),
          experimental: titles.indexOf('Experimental'),
        };
      });
      expect(order.fileBackup).toBeGreaterThanOrEqual(0);
      expect(order.cleanup).toBeGreaterThan(order.fileBackup);
      expect(order.experimental).toBeGreaterThan(order.cleanup);
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

    test('toggling Redact PII persists to storage', async () => {
      // Privacy is beta-gated now — enable Experimental so the widget shows.
      const page = await popupWith({ mm2c_redact_pii: false, mm2c_beta_enabled: true });
      await page.click('#tab-settings');
      // The checkbox is a visually-hidden custom toggle (opacity:0); click its
      // wrapping label to drive the real change handler.
      await page.locator('label.toggle-wrap', { has: page.locator('#redact-pii') }).click();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_redact_pii'])).mm2c_redact_pii
      ).toBe(true);
      await page.close();
    });

    test('Beta tab appears when experimental is on and gathers the beta widgets (UXF-14)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await expect(page.locator('#tab-beta')).toBeVisible();
      await page.click('#tab-beta');
      await expect(page.locator('#beta-panel #gcal-connect')).toBeVisible();
      await expect(page.locator('#beta-panel #dual-output')).toBeAttached();
      await page.close();
    });

    test('advanced features are hidden when Experimental is OFF (beta gating)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: false });
      await page.click('#tab-settings');
      // Settings-tab gated widgets: Your name, Webhook, Privacy, action-item routing, wikilinks.
      await expect(page.locator('#my-aliases')).not.toBeVisible();
      await expect(page.locator('#webhook-url')).not.toBeVisible();
      await expect(page.locator('#redact-keywords')).not.toBeVisible();
      await expect(page.locator('#task-app')).not.toBeVisible();
      await expect(page.getByText('Wikilinks for graph apps')).not.toBeVisible();
      await expect(page.locator('#note-language')).not.toBeVisible();
      await expect(page.locator('#preview-before-send')).not.toBeVisible();
      // Core Settings stay visible. Additional destinations promoted out of beta —
      // visible regardless of the Experimental toggle.
      await expect(page.locator('#output-app')).toBeVisible();
      await expect(page.locator('#add-destination')).toBeVisible();
      await expect(page.getByText('Backup cleanup')).toBeVisible();
      // Rules-tab Glossary is gated; the unified rules list (Default row) stays.
      await page.click('#tab-rules');
      await expect(page.locator('#glossary')).not.toBeVisible();
      await expect(page.locator('#default-rule')).toBeVisible();
      // Logs-tab: search, Developer logs + Download are gated; Clear stays.
      await page.click('#tab-logs');
      await expect(page.locator('#note-search')).not.toBeVisible();
      await expect(page.locator('#show-debug-logs')).not.toBeVisible();
      await expect(page.locator('#download-logs')).not.toBeVisible();
      await expect(page.locator('#clear-logs')).toBeVisible();
      await page.close();
    });

    test('advanced features appear when Experimental is ON (beta gating)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await page.click('#tab-settings');
      await expect(page.locator('#my-aliases')).toBeVisible();
      await expect(page.locator('#webhook-url')).toBeVisible();
      await expect(page.locator('#redact-keywords')).toBeVisible();
      await expect(page.locator('#task-app')).toBeVisible();
      await expect(page.getByText('Wikilinks for graph apps')).toBeVisible();
      await expect(page.locator('#note-language')).toBeVisible();
      await expect(page.getByText('Review notes before saving')).toBeVisible();
      await page.click('#tab-rules');
      await expect(page.locator('#glossary')).toBeVisible();
      await page.click('#tab-logs');
      await expect(page.locator('#note-search')).toBeVisible();
      await expect(page.locator('#show-debug-logs')).toBeVisible();
      await expect(page.locator('#download-logs')).toBeVisible();
      await expect(page.locator('#clear-logs')).toBeVisible();
      await page.close();
    });

    test('.ics for Next Steps is gated behind Experimental (within file backup)', async () => {
      // The .ics row lives inside the file-backup sub-options, so it's only shown
      // when file backup is enabled — then it appears only with Experimental on.
      const ics = (p) => p.getByText('.ics for Next Steps');
      const off = await popupWith({ mm2c_file_backup_enabled: true, mm2c_beta_enabled: false });
      await off.click('#tab-settings');
      await expect(off.locator('#file-type')).toBeVisible();   // file-backup body open
      await expect(ics(off)).not.toBeVisible();                 // …but .ics gated off
      await off.close();
      const on = await popupWith({ mm2c_file_backup_enabled: true, mm2c_beta_enabled: true });
      await on.click('#tab-settings');
      await expect(ics(on)).toBeVisible();
      await on.close();
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

    test('Beta tab renders the Google Docs output widget (5.7)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await page.click('#tab-beta');
      await expect(page.locator('#beta-panel #gdocs-enabled')).toBeAttached();
      await expect(page.locator('#beta-panel #gdocs-connect')).toBeVisible();
      await page.close();
    });

    test('Beta tab renders the Pre-meeting brief widget (P9-G)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await page.click('#tab-beta');
      await expect(page.locator('#beta-panel #pre-brief-btn')).toBeVisible();
      await expect(page.locator('#beta-panel #pre-brief-out')).toBeAttached();
      await page.close();
    });

    test('Clicking Pre-meeting brief renders the stubbed bullets (P9-G)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      // Intercept the runtime message in the popup page so the click renders
      // deterministically without a live host or Meet tab.
      await page.evaluate(() => {
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.type === 'MM2C_PRE_BRIEF') {
            cb({ ok: true, matched: true, title: 'Q3',
                 bullets: ['Agenda: Roadmap', 'Who: 3 attendees', 'Context: Recurring meeting'] });
          } else if (cb) { cb({}); }
        };
      });
      await page.click('#tab-beta');
      await page.click('#pre-brief-btn');
      const items = page.locator('#pre-brief-out ul li');
      await expect(items).toHaveCount(3);
      await expect(items.first()).toHaveText('Agenda: Roadmap');
      await page.close();
    });

    test('Pre-meeting brief shows a friendly message when no event matches (P9-G)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true });
      await page.evaluate(() => {
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.type === 'MM2C_PRE_BRIEF') cb({ ok: true, matched: false, bullets: [] });
          else if (cb) cb({});
        };
      });
      await page.click('#tab-beta');
      await page.click('#pre-brief-btn');
      await expect(page.locator('#pre-brief-out')).toContainText('No matching calendar event');
      await page.close();
    });

    test('Toggling Google Docs output persists mm2c_gdocs_enabled (5.7)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true, mm2c_gdocs_enabled: false });
      await page.click('#tab-beta');
      // The checkbox is a visually-hidden custom toggle (opacity:0); click its
      // label wrapper instead of the input directly.
      const wrap = page.locator('label.toggle-wrap', { has: page.locator('#gdocs-enabled') });
      await wrap.click();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_gdocs_enabled'])).mm2c_gdocs_enabled
      ).toBe(true);
      await wrap.click();
      await expect.poll(async () =>
        (await getStorage(ext.serviceWorker, ['mm2c_gdocs_enabled'])).mm2c_gdocs_enabled
      ).toBe(false);
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

    test('Pre-meeting brief renders the exact friendly string per error (no_meet_tab / beta_off) (P9-G)', async () => {
      // The friendly per-error map lives in popup.js renderPreBrief(); assert the
      // exact strings for two distinct host error codes.
      const page = await popupWith({ mm2c_beta_enabled: true });
      await page.click('#tab-beta');

      // no_meet_tab → "Open a Google Meet tab first."
      await page.evaluate(() => {
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.type === 'MM2C_PRE_BRIEF') cb({ ok: false, error: 'no_meet_tab' });
          else if (cb) cb({});
        };
      });
      await page.click('#pre-brief-btn');
      await expect(page.locator('#pre-brief-out')).toHaveText('Open a Google Meet tab first.');

      // beta_off → "Enable experimental features first."
      await page.evaluate(() => {
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.type === 'MM2C_PRE_BRIEF') cb({ ok: false, error: 'beta_off' });
          else if (cb) cb({});
        };
      });
      await page.click('#pre-brief-btn');
      await expect(page.locator('#pre-brief-out')).toHaveText('Enable experimental features first.');
      await page.close();
    });

    test('Google Calendar status: connected shows "Connected as …" + Disconnect (5.3)', async () => {
      // Drive the status render through the GENUINE MM2C_GCAL → host relay by
      // stubbing the native responder before the popup init renders the panel.
      const page = await popupWith({ mm2c_beta_enabled: true }, {
        gcal_status: { connected: true, available: true, email: 'me@x' },
        gdocs_status: { connected: false, available: false },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-beta');
      await expect.poll(async () => page.locator('#gcal-status').textContent())
        .toContain('Connected as me@x');
      await expect(page.locator('#gcal-connect')).toHaveText('Disconnect');
      await page.close();
    });

    test('Google Docs status: not installed shows the re-run install hint + Connect (5.7)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true }, {
        gdocs_status: { connected: false, available: false },
        gcal_status: { connected: false, available: false },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-beta');
      await expect.poll(async () => page.locator('#gdocs-status').textContent())
        .toContain('Not installed (re-run install.sh)');
      await expect(page.locator('#gdocs-connect')).toHaveText('Connect');
      await page.close();
    });

    test('Google Docs status: connected shows "Connected as …" + Disconnect (5.7)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true }, {
        gdocs_status: { connected: true, available: true, email: 'me@x' },
        gcal_status: { connected: false, available: false },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-beta');
      await expect.poll(async () => page.locator('#gdocs-status').textContent())
        .toContain('Connected as me@x');
      await expect(page.locator('#gdocs-connect')).toHaveText('Disconnect');
      await page.close();
    });

    test('Google Docs Disconnect saves gdocs off + unchecks the toggle (B6)', async () => {
      const page = await popupWith({ mm2c_beta_enabled: true, mm2c_gdocs_enabled: true }, {
        gdocs_status: { connected: true, available: true, email: 'me@x' },
        gcal_status: { connected: false, available: false },
        gdocs_disconnect: { ok: true },
        ping: { status: 'ok' },
        __default: { status: 'ok' },
      });
      await page.click('#tab-beta');
      await expect(page.locator('#gdocs-connect')).toHaveText('Disconnect'); // render set it
      await page.click('#gdocs-connect');                                    // → disconnect path
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_gdocs_enabled'])).mm2c_gdocs_enabled)
        .toBe(false);
      await expect(page.locator('#gdocs-enabled')).not.toBeChecked();
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
        mm2c_output_app: 'craft', // craft is primary → only obsidian + apple_notes addable
        mm2c_destinations: [{ type: 'apple_notes' }, { type: 'obsidian', vaultPath: '' }],
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
