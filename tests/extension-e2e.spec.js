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

    test('MM2C_RESPONSE forwards the destinations repeater when beta is ON (UXF-11)', async () => {
      const dests = [
        { type: 'obsidian', vaultPath: '/tmp/VaultA' },
        { type: 'craft', folderId: 'folder-xyz' },
        { type: 'apple_notes' },
      ];
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_beta_enabled: true,
        mm2c_destinations: dests,
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'beta on destinations payload',
        meetingTitle: 'Beta On',
      });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'beta on destinations payload');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.destinations).toEqual(dests);
    });

    test('MM2C_RESPONSE sends destinations:[] when beta is OFF even with seeded data (UXF-11)', async () => {
      await seedStorage(ext.serviceWorker, {
        mm2c_output_app: 'craft',
        mm2c_beta_enabled: false,
        mm2c_destinations: [{ type: 'obsidian', vaultPath: '/tmp/VaultA' }],
      });
      const resp = await sendFromPage(popup, {
        type: 'MM2C_RESPONSE',
        text: 'beta off destinations payload',
        meetingTitle: 'Beta Off',
      });
      expect(resp.ok).toBe(true);
      const sent = await getSent(ext.serviceWorker);
      const fwd = sent.find(s => s.msg.transcript === 'beta off destinations payload');
      expect(fwd).toBeTruthy();
      expect(fwd.msg.destinations).toEqual([]);
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
  });

  test.describe('popup render', () => {
    // Seed storage, then (re)open the popup so popup.js renders from it.
    async function popupWith(state) {
      await clearStorage(ext.serviceWorker);
      await stubNativeMessage(ext.serviceWorker, { ping: { status: 'ok' }, __default: { status: 'ok' } });
      await seedStorage(ext.serviceWorker, state);
      const page = await openPopup(ext.context, ext.extensionId);
      return page;
    }

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

    test('Logs tab renders a meeting group from seeded logs', async () => {
      const page = await popupWith({
        mm2c_logs: [{ ts: Date.now(), status: 'ok', title: 'Q3 Sync', message: 'Saved to Craft', level: 'user' }],
      });
      await page.click('#tab-logs');
      await expect(page.locator('#log-list')).toContainText('Q3 Sync');
      await page.close();
    });

    test('Rules tab renders a seeded rule row', async () => {
      const page = await popupWith({ mm2c_prompt_rules: [{ regex: 'standup', prompt: 'Brief notes' }] });
      await page.click('#tab-rules');
      await page.click('#rules-toggle');
      await expect(page.locator('#rules-list .rule-regex')).toHaveValue('standup');
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
      const page = await popupWith({ mm2c_redact_pii: false });
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
      const page = await popupWith({ mm2c_beta_enabled: true, mm2c_destinations: [] });
      await page.click('#tab-beta');
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
  });
});
