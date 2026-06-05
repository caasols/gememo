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
