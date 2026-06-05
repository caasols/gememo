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
  });
});
