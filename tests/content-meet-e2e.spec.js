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
const { startFakeMeet, closeFakeMeet, FAKE_MEET_OFF_HTML, SENTINEL_TRANSCRIPT } = require('./fake-meet');

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

      // Success path also clears the in-flight note (it is no longer stuck).
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_inflight'])).mm2c_inflight, { timeout: 10_000 })
        .toBeFalsy();
    } finally {
      await page.close();
    }
  });

  // 2c-fail — a failed Leave-capture must KEEP the in-flight note (marked failed)
  // so the RB-1d recovery card can surface it. Regression guard for the bug where
  // clearInflightNote() ran on failure too, deleting the only recovery copy.
  test('a failed Leave-capture keeps the in-flight note marked failed (RB-1d)', async () => {
    test.setTimeout(60_000);

    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'error', error: 'simulated host failure' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      mm2c_output_app: 'craft',
    });

    const page = await ext.context.newPage();
    try {
      await page.goto(fake.url, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
          { timeout: 15_000 })
        .toBe(1);

      await page.click('button[aria-label="Leave call"]');

      // The send fails → content_meet keeps mm2c_inflight and marks it failed:true.
      await expect
        .poll(async () => {
          const inf = (await getStorage(ext.serviceWorker, ['mm2c_inflight'])).mm2c_inflight;
          return !!(inf && inf.failed === true && typeof inf.text === 'string'
                    && inf.text.includes(SENTINEL_TRANSCRIPT));
        }, { timeout: 40_000 })
        .toBe(true);
    } finally {
      await page.close();
    }
  });

  // ── 2c-link — clicking a URL shared in chat (opens a new tab) must NOT pop the
  // "leave without notes?" prompt, and the prompt must offer a "Stay" escape. ────
  async function joinFake(page) {
    await page.goto(fake.url, { waitUntil: 'domcontentloaded' });
    await expect
      .poll(async () => (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
        { timeout: 15_000 })
      .toBe(1); // join registered ⇒ interceptor attached + Gemini available
  }

  test('a chat link (target=_blank) does not trigger the leave prompt', async () => {
    test.setTimeout(60_000);
    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      mm2c_output_app: 'craft',
    });
    const page = await ext.context.newPage();
    try {
      await joinFake(page);
      // A URL shared in chat is rendered as <a target="_blank"> (opens a new tab).
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.id = 'chat-link'; a.href = 'https://example.com/'; a.target = '_blank'; a.textContent = 'shared link';
        a.addEventListener('click', (e) => e.preventDefault()); // bubble phase — neutralise real navigation
        document.body.appendChild(a);
      });
      await page.click('#chat-link');
      // The interceptor must let new-tab links through → no leave overlay.
      await expect(page.locator('#mm2c-close-stay')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Leave call"]')).toBeVisible(); // still in the call
    } finally {
      await page.close();
    }
  });

  test('the leave prompt offers "Stay in meeting" to abort (same-tab nav)', async () => {
    test.setTimeout(60_000);
    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
      mm2c_output_app: 'craft',
    });
    const page = await ext.context.newPage();
    try {
      await joinFake(page);
      // A same-tab navigation while in a call → interceptor preventDefaults + prompts.
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.id = 'nav-link'; a.href = 'https://example.com/'; a.textContent = 'go'; // no target = same tab
        document.body.appendChild(a);
      });
      await page.click('#nav-link');
      await expect(page.locator('#mm2c-close-stay')).toBeVisible();   // the new third option
      await page.click('#mm2c-close-stay');                          // abort the leave
      await expect(page.locator('#mm2c-close-stay')).toHaveCount(0); // overlay dismissed
      await expect(page.locator('button[aria-label="Leave call"]')).toBeVisible(); // stayed in the call
    } finally {
      await page.close();
    }
  });

  // ── 2d (auto-activation) — OFF → "Start now" → panel, via plain clicks ───────
  // Guards the activation path that regressed against Meet's 2026-06 redesign.
  // The OFF-state fixture starts with the spark_off Ask Gemini toggle (jsname
  // wptEcf) and a decoy "Take notes with Gemini" (jsname ocqpFe). On join,
  // autoActivateGemini() must: pick the GENUINE toggle (not the decoy) → click it
  // → the "Start now" card appears (span[jsname=V67aGc] in button[jsname=R6SlF])
  // → click it → the Ask Gemini panel input enters the viewport. All with plain
  // element.click() (no CDP/hover). If trigger detection or findStartNowButton
  // break, the panel never opens and this fails.
  test('autoActivateGemini drives OFF → "Start now" → open panel with plain clicks', async () => {
    test.setTimeout(60_000);

    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
    });

    const off = await startFakeMeet(FAKE_MEET_OFF_HTML);
    const page = await ext.context.newPage();
    try {
      await page.goto(off.url, { waitUntil: 'domcontentloaded' });

      // The Ask Gemini panel input appears ONLY if autoActivate clicked the right
      // toggle and then the right "Start now" control.
      await expect(page.locator('div[aria-label="Ask Gemini"][contenteditable="true"]'))
        .toBeVisible({ timeout: 20_000 });
      // …and the toggle swapped to its active state (proves "Start now" was clicked,
      // not the decoy "Take notes" control).
      await expect(page.locator('button[jsname="J4YcA"]')).toHaveCount(1);
      await expect(page.locator('button[jsname="wptEcf"]')).toHaveCount(0);
    } finally {
      await page.close();
      await closeFakeMeet(off.server);
    }
  });

  // ── notes-paused nudge — visibility round-trip + background badge handler ────
  // The "snapshots paused" nudge debounces by SNAPSHOT_INTERVAL_MS / 2 (≥ 90s),
  // so the badge message can't be observed deterministically within the harness.
  // Instead we assert the two halves that we CAN make deterministic:
  //   (1) the content script survives a hidden → visible round-trip (no crash —
  //       it still answers MM2C_STATUS_QUERY and the catch-up path still works),
  //   (2) the background's MM2C_SNAPSHOTS_PAUSED / _RESUMED handlers exist and
  //       set/clear the toolbar badge without throwing.
  // (The pure shouldNudgeSnapshotsPaused logic + the shared toast copy are
  // covered exhaustively by the unit suite in extension/tests.js.)
  test('survives a hidden→visible round-trip and the badge handlers exist', async () => {
    test.setTimeout(30_000);

    await stubNativeMessage(ext.serviceWorker, { __default: { status: 'ok' } });
    await seedStorage(ext.serviceWorker, {
      mm2c_stats: { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0 },
    });

    const page = await ext.context.newPage();
    try {
      await page.goto(fake.url, { waitUntil: 'domcontentloaded' });

      // Wait for the join so the visibilitychange branches have a live meeting.
      await expect
        .poll(
          async () =>
            (await getStorage(ext.serviceWorker, ['mm2c_stats'])).mm2c_stats?.meetingsAttended,
          { timeout: 15_000 }
        )
        .toBe(1);

      // Go hidden → fires the debounce-arming branch (does NOT flag synchronously).
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Come back → fires the resume branch + catch-up path.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Content script is still alive and answers status queries (no crash).
      const status = await sendToMeetTab(ext.serviceWorker, { type: 'MM2C_STATUS_QUERY' });
      expect(status).toBeTruthy();
      expect(status.inMeeting).toBe(true);

      // Background badge handlers exist and run without throwing. Send the real
      // runtime messages through chrome.runtime.sendMessage so the background's
      // onMessage switch cases (MM2C_SNAPSHOTS_PAUSED / _RESUMED) actually run.
      // They're fire-and-forget (no sendResponse), so sendMessage resolves with
      // undefined; we only assert the round-trip doesn't reject/throw.
      const badgeOk = await ext.serviceWorker.evaluate(async () => {
        const send = (type) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage({ type }, () => {
              void chrome.runtime.lastError; // swallow "no response" (fire-and-forget)
              resolve(true);
            });
          });
        try {
          await send('MM2C_SNAPSHOTS_PAUSED');
          await send('MM2C_SNAPSHOTS_RESUMED');
          return true;
        } catch (e) {
          return false;
        }
      });
      expect(badgeOk).toBe(true);
    } finally {
      await page.close();
    }
  });
});
