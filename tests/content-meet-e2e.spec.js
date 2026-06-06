// content-meet-e2e.spec.js — drives the REAL extension/content_meet.js content
// script in a Playwright extension e2e test against a fake Google Meet page
// served over localhost. This is the only coverage that injects content_meet
// into a live page (the dom_fixtures spec exercises it as a static fixture only).
//
// The extension is loaded via launchExtensionLocalhost(), which copies the real
// extension and only widens the manifest's matches/host_permissions to include
// localhost — the content script code is byte-identical to production.

const { test, expect } = require('@playwright/test');
const {
  launchExtensionLocalhost,
  closeExtension,
  stubNativeMessage,
  getSent,
  seedStorage,
  getStorage,
} = require('./ext-harness');
const { startFakeMeet, closeFakeMeet, SENTINEL_TRANSCRIPT } = require('./fake-meet');

// Send a runtime message to the content script in the fake-Meet tab, from the
// service worker (real sender.tab path). Resolves the content script's reply.
async function sendToMeetTab(sw, message) {
  return sw.evaluate(
    ([msg]) =>
      new Promise((resolve) => {
        chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] }, (tabs) => {
          if (!tabs.length) return resolve({ __noTab: true });
          chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
            void chrome.runtime.lastError; // swallow "no receiver" races
            resolve(resp || null);
          });
        });
      }),
    [message]
  );
}

test.describe('content_meet e2e (fake Meet over localhost)', () => {
  let ext;
  let fake;

  test.beforeAll(async () => {
    ext = await launchExtensionLocalhost();
    fake = await startFakeMeet();
  });

  test.afterAll(async () => {
    if (fake) await closeFakeMeet(fake.server);
    if (ext) await closeExtension(ext);
  });

  // ── 2a (spike) — content_meet injects and the join lifecycle fires ──────────
  test('injects content_meet and fires the join lifecycle (MM2C_STAT_JOINED)', async () => {
    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    // Fresh stats so the assertion is unambiguous; content script reads
    // mm2c_enabled (defaults to enabled when unset) at injection time.
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
    });

    const page = await ext.context.newPage();
    try {
      await page.goto(fake.url, { waitUntil: 'domcontentloaded' });

      // content_meet's attachInterceptor() hooks the Leave button on first sight
      // and sends MM2C_STAT_JOINED, which background.js folds into
      // mm2c_stats.meetingsAttended. Poll the SW-visible storage for it.
      await expect
        .poll(
          async () =>
            (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
          { timeout: 15_000 }
        )
        .toBe(1);
    } finally {
      await page.close();
    }
  });

  // ── 2b (capture) — a real capture forwards the sentinel transcript ──────────
  // Triggered through the genuine MM2C_CAPTURE_NOW path (background.js sends this
  // to the tab on the capture-now command). That runs takePeriodicSnapshot →
  // runGeminiFlow against the fake panel; on success content_meet emits
  // MM2C_SNAPSHOT, which background.js forwards to the native host as a
  // {type:'snapshot'} message — but ONLY when mm2c_file_backup_enabled is true.
  test('a capture forwards the sentinel transcript to the native host', async () => {
    // 3s response-stability wait inside waitForResponseComplete + injection/submit
    // round-trips exceed the 30s default; give the whole test generous headroom.
    test.setTimeout(60_000);

    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      // Required for background.js to forward MM2C_SNAPSHOT to the native host.
      mm2c_file_backup_enabled: true,
      mm2c_file_backup_type: 'markdown',
      mm2c_file_backup_path: '~/Downloads/meeting-notes',
    });

    const page = await ext.context.newPage();
    try {
      await page.goto(fake.url, { waitUntil: 'domcontentloaded' });

      // Wait for the join to register (content script active + interceptor attached)
      // before triggering capture, so the Gemini flow's guards are satisfied.
      await expect
        .poll(
          async () =>
            (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
          { timeout: 15_000 }
        )
        .toBe(1);

      // Fire the genuine capture trigger at the content script in the Meet tab.
      await sendToMeetTab(ext.serviceWorker, { type: 'MM2C_CAPTURE_NOW' });

      // takePeriodicSnapshot → runGeminiFlow injects the prompt, submits (Enter +
      // click), waits ~3s for the response to stabilise, extracts it, then sends
      // MM2C_SNAPSHOT. background.js forwards it to the native host as type
      // 'snapshot'. Assert the host got it with the sentinel transcript.
      await expect
        .poll(
          async () => {
            const sent = await getSent(ext.serviceWorker);
            return sent.some(
              (s) =>
                s.msg.type === 'snapshot' &&
                typeof s.msg.transcript === 'string' &&
                s.msg.transcript.includes(SENTINEL_TRANSCRIPT)
            );
          },
          { timeout: 40_000 }
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });

  // ── 2c (leave → primary save) — the genuine Leave-click capture path ─────────
  // Distinct from 2b's snapshot path: clicking the real "Leave call" button is
  // intercepted by attachInterceptor → onLeaveClick → runGeminiFlow → the content
  // script emits MM2C_RESPONSE, which background.js forwards to the host as the
  // PRIMARY capture payload (transcript + meetingTitle, NOT a {type:'snapshot'}).
  // This is the main save path and was previously only covered for snapshots.
  test('clicking Leave forwards the primary MM2C_RESPONSE capture to the native host', async () => {
    test.setTimeout(60_000);

    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      mm2c_output_app: 'craft', // a real primary destination so the forward happens
    });

    const page = await ext.context.newPage();
    try {
      await page.goto(fake.url, { waitUntil: 'domcontentloaded' });

      // Wait for join (interceptor attached) before clicking Leave.
      await expect
        .poll(
          async () =>
            (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
          { timeout: 15_000 }
        )
        .toBe(1);

      // Genuine user action: click the real Leave button. The fake page has no
      // navigation handler, so the interceptor's eventual btn.click() is a no-op
      // and the page stays alive for the assertion.
      await page.click('button[aria-label="Leave call"]');

      // onLeaveClick runs the Gemini flow then forwards MM2C_RESPONSE; background
      // forwards the PRIMARY payload (no type:'snapshot') carrying the transcript.
      await expect
        .poll(
          async () => {
            const sent = await getSent(ext.serviceWorker);
            return sent.some(
              (s) =>
                s.msg.type !== 'snapshot' &&
                typeof s.msg.transcript === 'string' &&
                s.msg.transcript.includes(SENTINEL_TRANSCRIPT)
            );
          },
          { timeout: 40_000 }
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});
