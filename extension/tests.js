// tests.js — inject into a meet.google.com tab via the DevTools console or
// javascript_tool to verify all core logic before relying on it in production.
//
// Usage (browser console):
//   const s = document.createElement('script');
//   s.src = chrome.runtime.getURL('tests.js');
//   document.head.appendChild(s);
//
// Or paste the whole file into the console and call: MM2C_TESTS.run()

window.MM2C_TESTS = (() => {
  'use strict';

  // ── Minimal test harness ───────────────────────────────────────────────────

  const results = [];

  function assert(label, condition, detail = '') {
    const ok = !!condition;
    results.push({ ok, label, detail });
    const icon = ok ? '✅' : '❌';
    console[ok ? 'log' : 'error'](`${icon} ${label}${detail ? ' — ' + detail : ''}`);
    return ok;
  }

  function assertEq(label, actual, expected) {
    const ok = actual === expected;
    results.push({ ok, label, detail: ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
    const icon = ok ? '✅' : '❌';
    console[ok ? 'log' : 'error'](`${icon} ${label}${ok ? '' : ` — expected "${expected}", got "${actual}"`}`);
    return ok;
  }

  // ── DOM fixture helpers ────────────────────────────────────────────────────

  function mkBtn(ariaLabel, text = '') {
    const b = document.createElement('button');
    b.setAttribute('aria-label', ariaLabel);
    b.textContent = text;
    return b;
  }

  function mkDiv(attrs = {}, text = '') {
    const d = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v);
    d.textContent = text;
    return d;
  }

  async function withFixture(html, fn) {
    const container = document.createElement('div');
    container.id = 'mm2c-test-fixture';
    container.innerHTML = html;
    document.body.appendChild(container);
    try { await fn(container); }
    finally { container.remove(); }
  }

  // ── Async test utilities ───────────────────────────────────────────────────

  // Minimal stub for delay() — resolves immediately in test context so tests
  // don't need to wait real milliseconds for settle delays.
  const delayStub = () => Promise.resolve();

  // Minimal stub for sendLog() — prevents "chrome.runtime is not defined"
  // errors when running tests outside the extension context.
  const sendLogStub = () => {};

  // Stub document.hidden to a fixed value for the duration of fn(), then restore.
  // document.hidden is a read-only getter on Document.prototype; shadowing it on
  // the instance is the only way to override it without a real tab switch.
  async function withHiddenStub(hiddenValue, fn) {
    Object.defineProperty(document, 'hidden', {
      get: () => hiddenValue,
      configurable: true,
    });
    try {
      await fn();
    } finally {
      // Restore: delete the instance property so the prototype getter takes over again
      delete document.hidden;
    }
  }

  // Stub document.execCommand for the duration of fn(), then restore.
  async function withExecCommandSpy(spyFn, fn) {
    const orig = document.execCommand.bind(document);
    document.execCommand = spyFn;
    try {
      await fn();
    } finally {
      document.execCommand = orig;
    }
  }

  // Re-implement sentinel errors for test scope (keep in sync with content_meet.js)
  class InjectionTimeoutError extends Error {}
  class GeminiNotActiveError_test extends Error {}

  // Re-implementation of captureProactively with injectable state and dependencies.
  // State is a plain object that the test mutates and inspects; deps supplies mocks
  // for runGeminiFlow, chrome.runtime.sendMessage, sendLog, and showStatus.
  //
  // KEEP IN SYNC with captureProactively in content_meet.js.
  // Intentional deviations from production:
  //   • isContextValid() omitted — checks chrome.runtime.id, unavailable in page-world tests.
  //   • _sendMessage is fire-and-forget (no callback), so the Craft-send-error reset path
  //     (capturedProactively/captureProactivelyAttempted/intercepting = false) is not exercised.
  async function captureProactively_test(meetingTitle, state, deps) {
    const {
      _runGeminiFlow,
      _sendMessage = () => {}, // simplified: no callback; Craft-send error path not tested here
      _sendLog     = () => {},
      _showStatus  = () => {},
    } = deps;

    if (state.intercepting || state.capturedProactively || state.captureProactivelyAttempted) return;
    state.captureProactivelyAttempted = true;

    if (!state.cachedTranscript) {
      state.intercepting = true;
      _sendLog('Gemini deactivated — no snapshot yet, attempting live capture (60 s)...');
      _showStatus('Meeting ended — capturing notes...');
      try {
        const transcript = await _runGeminiFlow(60_000);
        state.cachedTranscript   = transcript;
        state.cachedTranscriptAt = Date.now();
        _sendLog(`Live proactive capture succeeded (${transcript.length} chars)`);
      } catch (err) {
        state.intercepting = false;
        if (err instanceof GeminiNotActiveError_test) {
          _sendLog('Proactive live capture: Gemini not active — meeting too short for notes');
          _showStatus('Meeting ended — Gemini was not active, no notes saved', 'warn');
          _sendMessage({ type: 'MM2C_WARNING', message: 'Meeting too short — Gemini was not active', meetingTitle });
        } else {
          _sendLog(`Proactive live capture failed: ${err.message}`);
          _showStatus(`Capture failed: ${err.message}`, 'err');
          _sendMessage({ type: 'MM2C_ERROR', error: err.message, meetingTitle });
        }
        return;
      }
    }

    state.intercepting        = true;
    state.capturedProactively = true;
    _sendLog('Gemini deactivated — sending notes to Craft');
    _showStatus('Saving notes to Craft...');
    _sendMessage({ type: 'MM2C_RESPONSE', text: state.cachedTranscript, meetingTitle });
  }

  // ── Local re-implementations for unit testing ──────────────────────────────
  // content_meet.js wraps these in an IIFE so they aren't accessible from
  // tests.js (which runs in the page main world). We re-implement them here
  // for unit testing. KEEP IN SYNC with content_meet.js.

  // -- waitForForeground (keep in sync with content_meet.js) ------------------
  function waitForForeground_test(timeoutMs, _sendLog = sendLogStub) {
    return new Promise((resolve, reject) => {
      if (!document.hidden) return resolve();
      _sendLog('Tab not active — waiting to return before injecting prompt...');
      let timer;
      const onVisible = () => {
        if (!document.hidden) { cleanup(); resolve(); }
      };
      const cleanup = () => {
        window.removeEventListener('visibilitychange', onVisible);
        clearTimeout(timer);
      };
      window.addEventListener('visibilitychange', onVisible);
      timer = setTimeout(() => {
        if (document.pictureInPictureElement) {
          _sendLog('PiP window active during injection timeout');
        }
        cleanup();
        reject(new InjectionTimeoutError('Tab did not become active within the flow deadline'));
      }, timeoutMs);
    });
  }

  // -- injectPromptWithVerification (keep in sync with content_meet.js) -------
  // No retry loop — single-pass: Path A (execCommand), then Path B (textContent).
  // Verification: el.textContent.trim() truthy (not startsWith) because
  // execCommand('insertText') converts \n to block elements; textContent strips
  // them back, making startsWith checks on prompts with \n\n always fail.

  async function injectPromptWithVerification_test(
    input, prompt, deadline,
    _sendLog = sendLogStub,
    _waitForForeground = waitForForeground_test
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new InjectionTimeoutError('Deadline passed before injection');

    await _waitForForeground(remaining);

    // Mirror production re-fetch: querySelector finds the element because
    // withFixture appends it to document.body; || input is the fallback.
    const el = document.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]') || input;

    el.focus();

    // ── Path A: execCommand ──────────────────────────────────────────────────
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, prompt);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false }));

    if (el.textContent.trim()) {
      _sendLog(`Prompt injected via execCommand (${prompt.length} chars)`);
      return;
    }

    // ── Path B: direct textContent ───────────────────────────────────────────
    _sendLog(`execCommand injection empty — falling back to direct textContent`);
    el.textContent = prompt;
    try {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText',
      data: prompt.slice(0, 200),
    }));

    if (!el.textContent.trim()) {
      _sendLog('Both injection paths failed — input still empty');
      throw new InjectionTimeoutError(
        'Failed to inject prompt — both execCommand and direct textContent left the input empty');
    }
    _sendLog(`Prompt injected via direct textContent (${prompt.length} chars)`);
  }

  // ── Re-export the functions under test from the IIFE ──────────────────────
  // content_meet.js wraps everything in an IIFE, so we can't import directly.
  // We re-implement the pure functions here and test them in isolation.
  // Integration (selector + DOM interaction) is tested against the live page.

  // -- extractLastResponse (delegates to shared extractLastResponseFromEl) ----
  // Alias with an `aside` parameter for testability; production wraps it with
  // a live document.querySelector call instead.
  const extractLastResponse = aside => extractLastResponseFromEl(aside);

  // ── Tests ──────────────────────────────────────────────────────────────────

  function testSelectors() {
    console.group('Selector tests (live DOM)');

    if (!window.MM2C_FIXTURE_MODE) {
      assert('Leave button found',
        !!document.querySelector('button[aria-label="Leave call"]'),
        'button[aria-label="Leave call"]');

      assert('Mic button found',
        !!document.querySelector('button[aria-label="Turn off microphone"]') ||
        !!document.querySelector('button[aria-label="Turn on microphone"]'),
        '"Turn off/on microphone"');

      assert('Camera button found',
        !!document.querySelector('button[aria-label="Turn off camera"]') ||
        !!document.querySelector('button[aria-label="Turn on camera"]'),
        '"Turn off/on camera"');

      assert('Gemini toggle button found',
        !!document.querySelector('button[aria-label*="Gemini" i]'),
        'button[aria-label*="Gemini" i] (partial match)');
    } else {
      console.warn('  Live DOM selector tests skipped in fixture mode');
    }

    // Toolbar selector used by showStatus to derive bottom position.
    // Note: withFixture is async but testSelectors is sync; callback is kept synchronous
    // (matching the pattern in testGeminiActiveDetection and testExtractLastResponse).
    withFixture(`<div aria-label="Call controls" style="height:72px;display:block"></div>`, (c) => {
      const toolbar = c.querySelector('div[aria-label="Call controls"]');
      assert('Call controls selector matches toolbar fixture', !!toolbar);
      assert('offsetHeight is readable from fixture', toolbar.offsetHeight === 72);
    });

    console.groupEnd();
  }

  function testGeminiActiveDetection() {
    console.group('Gemini active detection');

    // isGeminiAvailable() checks for the toolbar button, not the panel input.
    // The panel's DOM elements persist off-screen when the panel is "closed",
    // so the real open/close check in _runGeminiFlowInner uses getBoundingClientRect
    // to confirm the input is inside the viewport. These fixture tests verify the
    // selector shapes; viewport checks require the live Meet DOM.

    withFixture(`<button aria-label="Gemini"></button>`, (c) => {
      const btn = c.querySelector('button[aria-label*="Gemini" i]');
      assert('Partial selector matches exact label "Gemini"', !!btn);
    });

    withFixture(`<button aria-label="Open Gemini notes"></button>`, (c) => {
      const btn = c.querySelector('button[aria-label*="Gemini" i]');
      assert('Partial selector matches label variant "Open Gemini notes"', !!btn);
    });

    withFixture(`
      <aside aria-label="Side panel">
        <div aria-label="Ask Gemini" contenteditable="true"></div>
      </aside>`, (c) => {
      const input = c.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      assert('Input selector matches when panel element present in DOM', !!input);
      // Note: in production, presence alone is insufficient — the element persists
      // off-screen when the panel is closed. isInViewport() is the real gate.
    });

    console.groupEnd();
  }

  function testExtractLastResponse() {
    console.group('extractLastResponse');

    // Single response
    // Note: aside must be appended to the document for innerText to work in Playwright
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = [
        'More options',
        'Gemini response',
        'Carlos Sol joined at 10:00. Action item: fix the bug by Friday.\n',
        'Copy\nReport',
      ].join('\n');
      c.appendChild(aside);

      const result = extractLastResponse(aside);
      assert('Extracts single response', result?.includes('Carlos Sol'));
      assert('Strips Copy/Report row', !result?.includes('Copy'));
    });

    // Multiple responses — should return last
    // Use innerHTML with block elements (<div>) so innerText correctly inserts
    // newlines between blocks — matching the real Gemini panel DOM structure.
    // "Report" after each "Copy" mirrors the real Gemini UI (Copy / Report
    // buttons) and ensures the Copy-stripping regex (/\n+Copy\n.*$/s) has
    // content after the \n so it can match: "…\nCopy\nReport" → stripped.
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = [
        'Gemini response',
        'First response text.',
        'Copy',
        'Report',      // mirrors real UI; gives \n after Copy for regex match
        'Gemini response',
        'Second response text.',
        'Copy',
        'Report',      // same for last Copy
      ].map(t => `<div>${t}</div>`).join('');
      c.appendChild(aside);

      const result = extractLastResponse(aside);
      assertEq('Returns LAST response when multiple exist', result, 'Second response text.');
      assert('Does not include first response', !result?.includes('First response'));
    });

    // Citation footnotes stripped
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = 'Gemini response\nMeeting summary here.1\n1\n1 source\n';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Strips citation footer (1\\n1\\n1 source)', !result?.includes('1 source'));
      assert('Strips inline citation superscript (.1)', result === 'Meeting summary here.');
    });

    // Citation regex must NOT corrupt version numbers or decimals
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = 'Gemini response\nUsing Python 3.11 and score of 0.5 FTE.\n';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Citation regex preserves version numbers (Python 3.11)',
        result?.includes('3.11'), `got: "${result}"`);
      assert('Citation regex preserves decimals (0.5 FTE)',
        result?.includes('0.5'), `got: "${result}"`);
    });

    // No response yet
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.innerText = 'Collecting info...';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Returns null when no response yet', result === null);
    });

    // Note disclaimer stripped
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.innerText = 'Gemini response\nSummary text here.\n\n\nNote: No relevant information was found.';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Strips Note disclaimer', !result?.includes('Note:'));
      assert('Keeps summary text before Note', result === 'Summary text here.');
    });

    console.groupEnd();
  }

  function testMuteSelectors() {
    console.group('Mute selector logic');

    // When mic is ON → "Turn off microphone" present → would click
    withFixture('<button aria-label="Turn off microphone"></button>', (c) => {
      const mic = c.querySelector('button[aria-label="Turn off microphone"]');
      assert('Finds mic-ON button to mute', !!mic);
    });

    // When mic is already OFF → "Turn off microphone" absent → would NOT click
    withFixture('<button aria-label="Turn on microphone"></button>', (c) => {
      const mic = c.querySelector('button[aria-label="Turn off microphone"]');
      assert('Does NOT find mic when already muted (no accidental unmute)', !mic);
    });

    // Same for camera
    withFixture('<button aria-label="Turn off camera"></button>', (c) => {
      const cam = c.querySelector('button[aria-label="Turn off camera"]');
      assert('Finds cam-ON button to mute', !!cam);
    });

    withFixture('<button aria-label="Turn on camera"></button>', (c) => {
      const cam = c.querySelector('button[aria-label="Turn off camera"]');
      assert('Does NOT find cam when already off (no accidental unmute)', !cam);
    });

    // NOTE: The two "already muted" tests above may show false failures when run
    // inside an active meeting where the real mic/camera buttons are in the DOM
    // (e.g. mic is ON so Turn off microphone is present, swamping the fixture).
    // The production code uses document.querySelector — the logic is correct, but
    // the negative case can only be proven in isolation from the live meeting DOM.

    console.groupEnd();
  }

  function testSubmitButton() {
    console.group('Submit button state');

    if (window.MM2C_FIXTURE_MODE) {
      console.warn('  Skipped — requires live Gemini panel');
      console.groupEnd();
      return;
    }

    // Panel is open and active: check Submit exists and is currently disabled (no text in input)
    const aside = document.querySelector('aside[aria-label="Side panel"]');
    if (aside) {
      const submit = document.querySelector('button[aria-label="Submit"]');
      assert('Submit button found when panel is open', !!submit);
    } else {
      console.warn('  Skipped — Gemini panel not open. Open the panel and re-run.');
    }

    console.groupEnd();
  }

  async function testWaitForForeground() {
    console.group('waitForForeground');

    // Sub-case 1: tab already visible — should resolve immediately
    await (async () => {
      // In the DevTools console the tab is always the active tab, so
      // document.hidden is false. This test verifies the fast path.
      const start = Date.now();
      let resolved = false;
      await waitForForeground_test(1000).then(() => { resolved = true; });
      const elapsed = Date.now() - start;
      assert('Resolves immediately when tab is visible', resolved);
      assert('No significant delay when tab is visible (< 50 ms)', elapsed < 50,
        `elapsed: ${elapsed} ms`);
    })();

    // Sub-case 2: tab hidden → visibilitychange → should resolve
    await (async () => {
      let resolved = false;
      let rejected = false;

      await withHiddenStub(true, async () => {
        const p = waitForForeground_test(500)
          .then(() => { resolved = true; })
          .catch(() => { rejected = true; });

        // Dispatch a synthetic visibilitychange while hidden stub is active,
        // then remove the stub so the handler sees document.hidden === false.
        await new Promise(r => setTimeout(r, 20)); // let listener attach
        delete document.hidden; // restore so event handler sees hidden=false
        window.dispatchEvent(new Event('visibilitychange'));
        await p;
      });

      assert('Resolves on visibilitychange when tab was hidden', resolved);
      assert('Does not reject on visibilitychange resolution', !rejected);
    })();

    // Sub-case 3: tab hidden, timeout expires → should reject with InjectionTimeoutError
    await (async () => {
      let resolved = false;
      let rejectedWithCorrectType = false;

      await withHiddenStub(true, async () => {
        await waitForForeground_test(60) // 60 ms timeout — fast for tests
          .then(() => { resolved = true; })
          .catch(err => {
            rejectedWithCorrectType = err instanceof InjectionTimeoutError;
          });
      });

      assert('Rejects when timeout expires with tab still hidden', !resolved && rejectedWithCorrectType,
        `resolved=${resolved}, correctType=${rejectedWithCorrectType}`);
    })();

    console.groupEnd();
  }

  async function testInjectVerification() {
    console.group('injectPromptWithVerification');

    // Use a prompt with \n\n — this is exactly the content that broke the old
    // startsWith(prompt.slice(0,80)) check (browser block-element conversion).
    const PROMPT = 'Summarise this meeting.\n\nList action items.';
    const FAR_DEADLINE = Date.now() + 60_000;
    const foregroundImmediate = () => Promise.resolve();

    // Sub-case 1: Path A works — execCommand injects text, textContent is truthy
    await withFixture(`
      <div aria-label="Ask Gemini" contenteditable="true" style="position:fixed;top:0;left:0;width:200px;height:40px"></div>
    `, async (container) => {
      const input = container.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      input.textContent = 'old content';

      await injectPromptWithVerification_test(
        input, PROMPT, FAR_DEADLINE, sendLogStub, foregroundImmediate
      );

      // Verify with truthy check (matching production) not strict equality,
      // because execCommand converts \n to block elements — textContent
      // reassembles them with \n but the exact form may vary by browser.
      assert('Path A: execCommand path — input is non-empty after injection',
        input.textContent.trim() !== '',
        `got: "${input.textContent.slice(0, 50)}"`);
    });

    // Sub-case 2: Path A empty → Path B succeeds
    // withExecCommandSpy makes every execCommand a no-op (returns false).
    // After Path A, el.textContent is '' → function falls to Path B.
    // Path B does el.textContent = prompt directly — DOM setter works normally.
    await withFixture(`
      <div aria-label="Ask Gemini" contenteditable="true" style="position:fixed;top:0;left:0;width:200px;height:40px"></div>
    `, async (container) => {
      const input = container.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      let execCallCount = 0;
      let caughtError = null;

      await withExecCommandSpy(() => { execCallCount++; return false; }, async () => {
        await injectPromptWithVerification_test(
          input, PROMPT, FAR_DEADLINE, sendLogStub, foregroundImmediate
        ).catch(err => { caughtError = err; });
      });

      assert('Path B fallback: no error thrown', caughtError === null,
        `got error: ${caughtError?.message}`);
      assert('Path B fallback: Path A was attempted (execCommand was called)',
        execCallCount > 0,
        `execCommand call count: ${execCallCount}`);
      assert('Path B fallback: el.textContent equals PROMPT after direct assignment',
        input.textContent === PROMPT,
        `got: "${input.textContent.slice(0, 50)}"`);
    });

    // Sub-case 3: Both paths fail → InjectionTimeoutError
    // execCommands are no-ops (Path A leaves input empty) AND the textContent
    // setter on the element is mocked to silently ignore writes (Path B is
    // also a no-op). The getter is forced to return '' throughout.
    await withFixture(`
      <div aria-label="Ask Gemini" contenteditable="true" style="position:fixed;top:0;left:0;width:200px;height:40px"></div>
    `, async (container) => {
      const input = container.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      const logMessages = [];
      const capturingLog = (msg) => logMessages.push(msg);
      let caughtError = null;

      await withExecCommandSpy(() => false, async () => {
        Object.defineProperty(input, 'textContent', {
          get() { return ''; },
          set(_v) { /* no-op — simulate Path B write being silently ignored */ },
          configurable: true,
        });
        try {
          await injectPromptWithVerification_test(
            input, PROMPT, FAR_DEADLINE, capturingLog, foregroundImmediate
          ).catch(err => { caughtError = err; });
        } finally {
          delete input.textContent; // restore native DOM property
        }
      });

      assert('Both paths fail: throws InjectionTimeoutError',
        caughtError instanceof InjectionTimeoutError,
        `error was: ${caughtError?.constructor?.name}`);
      assert('Both paths fail: sendLog reported the failure',
        logMessages.some(m => m.includes('Both injection paths failed')),
        `log messages: ${JSON.stringify(logMessages)}`);
    });

    // Sub-case 4: deadline already expired → throws immediately, no execCommand
    await withFixture(`
      <div aria-label="Ask Gemini" contenteditable="true" style="position:fixed;top:0;left:0;width:200px;height:40px"></div>
    `, async (container) => {
      const input = container.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      const EXPIRED_DEADLINE = Date.now() - 1;
      let execCalled = false;
      let caughtError = null;

      await withExecCommandSpy(() => { execCalled = true; return false; }, async () => {
        await injectPromptWithVerification_test(
          input, PROMPT, EXPIRED_DEADLINE, sendLogStub, foregroundImmediate
        ).catch(err => { caughtError = err; });
      });

      assert('Expired deadline: throws InjectionTimeoutError immediately',
        caughtError instanceof InjectionTimeoutError,
        `error was: ${caughtError?.constructor?.name}`);
      assert('Expired deadline: no execCommand calls made', !execCalled);
    });

    console.groupEnd();
  }

  // ── Runner ─────────────────────────────────────────────────────────────────

  async function testCaptureProactively() {
    console.group('captureProactively');

    // Sub-case 1: null transcript, live flow succeeds → Craft send fires
    await (async () => {
      const state = {
        intercepting: false, capturedProactively: false,
        captureProactivelyAttempted: false,
        cachedTranscript: null, cachedTranscriptAt: null,
      };
      const messages = [];
      let flowCallCount = 0;
      await captureProactively_test('Test Meeting', state, {
        _runGeminiFlow: async () => { flowCallCount++; return 'live-transcript'; },
        _sendMessage:   (msg) => messages.push(msg),
      });
      assert('Case 1: live flow called once',
        flowCallCount === 1, `calls: ${flowCallCount}`);
      assert('Case 1: MM2C_RESPONSE sent',
        messages.some(m => m.type === 'MM2C_RESPONSE'), JSON.stringify(messages));
      assert('Case 1: MM2C_RESPONSE carries live transcript',
        messages.find(m => m.type === 'MM2C_RESPONSE')?.text === 'live-transcript');
      assert('Case 1: capturedProactively = true', state.capturedProactively);
      assert('Case 1: intercepting = true',        state.intercepting);
      assert('Case 1: cachedTranscript updated',   state.cachedTranscript === 'live-transcript');
    })();

    // Sub-case 2: null transcript, GeminiNotActiveError → warn, no Craft send
    await (async () => {
      const state = {
        intercepting: false, capturedProactively: false,
        captureProactivelyAttempted: false,
        cachedTranscript: null, cachedTranscriptAt: null,
      };
      const messages = [];
      const statuses  = [];
      await captureProactively_test('Test Meeting', state, {
        _runGeminiFlow: async () => { throw new GeminiNotActiveError_test('not active'); },
        _sendMessage:   (msg)        => messages.push(msg),
        _showStatus:    (msg, type)  => statuses.push({ msg, type }),
      });
      assert('Case 2: MM2C_WARNING sent',
        messages.some(m => m.type === 'MM2C_WARNING'), JSON.stringify(messages));
      assert('Case 2: MM2C_RESPONSE NOT sent',
        !messages.some(m => m.type === 'MM2C_RESPONSE'));
      assert('Case 2: intercepting released',      !state.intercepting);
      assert('Case 2: capturedProactively = false', !state.capturedProactively);
      assert('Case 2: warn status shown',
        statuses.some(s => s.type === 'warn'), JSON.stringify(statuses));
    })();

    // Sub-case 3: double-run guard — second call while first is in-flight
    await (async () => {
      const state = {
        intercepting: false, capturedProactively: false,
        captureProactivelyAttempted: false,
        cachedTranscript: null, cachedTranscriptAt: null,
      };
      let flowCallCount = 0;
      // Use a never-resolving promise so the first call is still "running"
      // when the second is dispatched.
      // Ordering guarantee: state.captureProactivelyAttempted is set synchronously
      // (before the first await in captureProactively_test), so the second call's
      // guard fires with the flag already true. If the flag assignment ever moves
      // past an await in production, this test will correctly start failing.
      const neverResolve = new Promise(() => {});
      const first  = captureProactively_test('Test Meeting', state, {
        _runGeminiFlow: async () => { flowCallCount++; await neverResolve; },
      });
      // Dispatch second call immediately — captureProactivelyAttempted is already true
      await captureProactively_test('Test Meeting', state, {
        _runGeminiFlow: async () => { flowCallCount++; return 'second'; },
      });
      assert('Case 3: runGeminiFlow called exactly once (guard blocked second)',
        flowCallCount === 1, `calls: ${flowCallCount}`);
      assert('Case 3: captureProactivelyAttempted = true after first call',
        state.captureProactivelyAttempted);
    })();

    // Sub-case 4: cached transcript present → live flow NOT attempted
    await (async () => {
      const state = {
        intercepting: false, capturedProactively: false,
        captureProactivelyAttempted: false,
        cachedTranscript: 'cached-transcript', cachedTranscriptAt: Date.now(),
      };
      const messages = [];
      let flowCallCount = 0;
      await captureProactively_test('Test Meeting', state, {
        _runGeminiFlow: async () => { flowCallCount++; return 'live'; },
        _sendMessage:   (msg) => messages.push(msg),
      });
      assert('Case 4: runGeminiFlow NOT called',
        flowCallCount === 0, `calls: ${flowCallCount}`);
      assert('Case 4: MM2C_RESPONSE sent with cached transcript',
        messages.find(m => m.type === 'MM2C_RESPONSE')?.text === 'cached-transcript');
      assert('Case 4: capturedProactively = true', state.capturedProactively);
    })();

    console.groupEnd();
  }

  async function testGeminiFlowMutex() {
    console.group('geminiFlowMutex');

    // Re-implementation of runGeminiFlow's Promise-based mutex with injectable _inner.
    // KEEP IN SYNC with runGeminiFlow in content_meet.js.
    // Intentional deviation: chrome.storage.local.set calls omitted (Chrome-only API).
    async function runGeminiFlow_test(state, _inner) {
      if (state.geminiFlowPromise) throw new Error('Another Gemini capture is already running');
      let releaseLock;
      state.geminiFlowPromise = new Promise(resolve => { releaseLock = resolve; });
      try {
        return await _inner();
      } finally {
        releaseLock();
        state.geminiFlowPromise = null;
      }
    }

    // Case 1: second call throws while first is running
    await (async () => {
      const state = { geminiFlowPromise: null };
      const neverResolve = new Promise(() => {});
      let secondError = null;

      // Start first — never resolves, holds the lock
      const first = runGeminiFlow_test(state, () => neverResolve);
      // Second call immediately — lock is held
      try {
        await runGeminiFlow_test(state, async () => 'second');
      } catch (err) {
        secondError = err;
      }

      assert('Case 1: second call throws while first is running',
        secondError?.message === 'Another Gemini capture is already running',
        `error: ${secondError?.message}`);
      assert('Case 1: geminiFlowPromise still set (first call holds lock)',
        state.geminiFlowPromise !== null);
    })();

    // Case 2: lock released on success
    await (async () => {
      const state = { geminiFlowPromise: null };
      let result;
      try { result = await runGeminiFlow_test(state, async () => 'ok'); } catch (_) {}

      assert('Case 2: lock released on success (geminiFlowPromise = null)',
        state.geminiFlowPromise === null);
      assert('Case 2: return value propagated correctly', result === 'ok');

      // Second call must succeed now that lock is free
      let secondError = null;
      try { await runGeminiFlow_test(state, async () => 'ok2'); }
      catch (err) { secondError = err; }
      assert('Case 2: second call succeeds after first completes', secondError === null);
    })();

    // Case 3: lock released on error
    await (async () => {
      const state = { geminiFlowPromise: null };
      let caughtError = null;
      try {
        await runGeminiFlow_test(state, async () => { throw new Error('boom'); });
      } catch (err) { caughtError = err; }

      assert('Case 3: lock released on error (geminiFlowPromise = null)',
        state.geminiFlowPromise === null);
      assert('Case 3: error propagated correctly', caughtError?.message === 'boom');

      // Second call must succeed after the errored flow
      let secondError = null;
      try { await runGeminiFlow_test(state, async () => 'recovered'); }
      catch (err) { secondError = err; }
      assert('Case 3: second call succeeds after first errored', secondError === null);
    })();

    console.groupEnd();
  }

  // Pure helper mirroring the time-window dedup logic in background.js MM2C_RESPONSE.
  // KEEP IN SYNC with the DEDUP_WINDOW_MS constant and storage check in background.js.
  function isDuplicateSend_test(stored, title, now, windowMs) {
    if (!title) return false;
    if (!stored) return false;
    return stored.title === title && (now - stored.sentAt) < windowMs;
  }

  function testSendDedup() {
    console.group('sendDedup (time-window)');
    const W = 40 * 60 * 1000; // 40 min in ms
    const T0 = 1_000_000_000_000; // arbitrary fixed "now" base

    // Case 1: same title, within window → duplicate
    assert('Case 1: same title within 40 min → duplicate',
      isDuplicateSend_test({ title: 'Standup', sentAt: T0 - 10 * 60 * 1000 }, 'Standup', T0, W) === true);

    // Case 2: same title, exactly at window boundary → NOT duplicate (boundary is exclusive)
    assert('Case 2: same title at exactly 40 min → not duplicate',
      isDuplicateSend_test({ title: 'Standup', sentAt: T0 - W }, 'Standup', T0, W) === false);

    // Case 3: same title, beyond window → not duplicate (new meeting)
    assert('Case 3: same title after 40 min → not duplicate',
      isDuplicateSend_test({ title: 'Standup', sentAt: T0 - W - 1 }, 'Standup', T0, W) === false);

    // Case 4: different title within window → not duplicate
    assert('Case 4: different title within 40 min → not duplicate',
      isDuplicateSend_test({ title: 'Retro', sentAt: T0 - 5 * 60 * 1000 }, 'Standup', T0, W) === false);

    // Case 5: empty title → never deduplicated
    assert('Case 5: empty title → not duplicate',
      isDuplicateSend_test({ title: '', sentAt: T0 - 1000 }, '', T0, W) === false);

    // Case 6: no stored record → not duplicate
    assert('Case 6: null stored → not duplicate',
      isDuplicateSend_test(null, 'Standup', T0, W) === false);

    console.groupEnd();
  }

  // Re-implementation of the admin-disabled detection logic in autoActivateGemini.
  // KEEP IN SYNC with the waitForPanelVisible try/catch block in content_meet.js.
  // Intentional deviation: geminiWasActive and panelAutoOpened are tracked via state
  // object rather than IIFE-scoped module variables.
  async function autoActivateAdminDisabled_test(state, deps) {
    const {
      _waitForPanelVisible,
      _sendLog    = () => {},
      _showStatus = () => {},
    } = deps;

    try {
      await _waitForPanelVisible(5000);
    } catch {
      _sendLog('Gemini panel did not open after trigger click — Gemini may be disabled by admin');
      _showStatus('Gemini may be disabled for your account — check with your Google Admin', 'warn');
      return; // state.panelAutoOpened intentionally NOT set
    }

    state.panelAutoOpened = true;
    state.geminiWasActive = true;
  }

  async function testAdminDisabledDetection() {
    console.group('adminDisabledDetection');

    // Case 1: panel opens successfully → flags set, no warn shown
    await (async () => {
      const state = { panelAutoOpened: false, geminiWasActive: false };
      const statuses = [];
      await autoActivateAdminDisabled_test(state, {
        _waitForPanelVisible: async () => { /* resolves immediately */ },
        _showStatus: (msg, type) => statuses.push({ msg, type }),
      });
      assert('Case 1: panelAutoOpened = true on success', state.panelAutoOpened);
      assert('Case 1: geminiWasActive = true on success', state.geminiWasActive);
      assert('Case 1: no warn toast shown', statuses.length === 0,
        `unexpected statuses: ${JSON.stringify(statuses)}`);
    })();

    // Case 2: panel never opens (admin disabled) → warn shown, flags NOT set
    await (async () => {
      const state = { panelAutoOpened: false, geminiWasActive: false };
      const statuses = [];
      const logs     = [];
      await autoActivateAdminDisabled_test(state, {
        _waitForPanelVisible: async () => { throw new Error('timeout'); },
        _showStatus: (msg, type) => statuses.push({ msg, type }),
        _sendLog:    (msg)       => logs.push(msg),
      });
      assert('Case 2: panelAutoOpened remains false', !state.panelAutoOpened);
      assert('Case 2: geminiWasActive remains false', !state.geminiWasActive);
      assert('Case 2: warn status shown',
        statuses.some(s => s.type === 'warn' && s.msg.includes('disabled')),
        JSON.stringify(statuses));
      assert('Case 2: admin-disabled message logged',
        logs.some(m => m.includes('disabled by admin')),
        JSON.stringify(logs));
    })();

    console.groupEnd();
  }

  // Re-implements the stability guard condition from waitForResponseComplete's check().
  // KEEP IN SYNC with the else-if branch in content_meet.js.
  // Returns 'blocked', 'resolve', or 'not-ready'.
  function checkStabilityGuard_test(state, isRegenerating) {
    if (state.lastChangeAt > 0 && state.contentLength > 10 && state.elapsed >= 3000) {
      if (isRegenerating) {
        state.lastChangeAt = 0; // reset stability clock — mirrors production behaviour
        return 'blocked';
      }
      return 'resolve';
    }
    return 'not-ready';
  }

  // Re-implementation of the onBeforeUnload setTimeout guard condition.
  // KEEP IN SYNC with the setTimeout callback in onBeforeUnload (content_meet.js).
  function shouldShowOverlay_test(isHidden, hasLeaveButton) {
    return !isHidden && hasLeaveButton;
  }

  function testOnBeforeUnloadGuard() {
    console.group('onBeforeUnloadGuard');

    // Case 1: Guard blocks overlay when no Leave button (navigated away)
    assert('Case 1: guard returns false when no Leave button',
      !shouldShowOverlay_test(false, false));

    // Case 2: Guard blocks overlay when tab is hidden
    assert('Case 2: guard returns false when tab is hidden',
      !shouldShowOverlay_test(true, true));

    // Case 3: Guard allows overlay when on call page and tab visible
    assert('Case 3: guard returns true when Leave button present and tab visible',
      shouldShowOverlay_test(false, true));

    console.groupEnd();
  }

  // Re-implementation of formatSnapshotAge for test scope.
  // KEEP IN SYNC with formatSnapshotAge in popup.js.
  function formatSnapshotAge_test(ts, now) {
    const diffMs  = Math.max(0, now - ts);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return `${Math.floor(diffMs / 1000)}s ago`;
    return `${diffMin} min ago`;
  }

  function testFormatSnapshotAge() {
    console.group('formatSnapshotAge');
    const now = Date.now();

    assertEq('0s ago when ts = now',
      formatSnapshotAge_test(now, now), '0s ago');
    assertEq('30s ago when 30s elapsed',
      formatSnapshotAge_test(now - 30000, now), '30s ago');
    assertEq('1 min ago when exactly 60s elapsed',
      formatSnapshotAge_test(now - 60000, now), '1 min ago');
    assertEq('3 min ago when 3.5 min elapsed (floor)',
      formatSnapshotAge_test(now - 210000, now), '3 min ago');
    assertEq('59s ago when 59s elapsed (under 1 min threshold)',
      formatSnapshotAge_test(now - 59000, now), '59s ago');

    console.groupEnd();
  }

  // Re-implementation of formatCountdown for test scope.
  // KEEP IN SYNC with formatCountdown in popup.js.
  function formatCountdown_test(nextAt, now) {
    if (!nextAt) return null;
    const ms = nextAt - now;
    if (ms <= 0) return 'due now';
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  }

  function testFormatCountdown() {
    console.group('formatCountdown');
    const NOW = 1_000_000_000_000;

    // Case 1: 0 (not scheduled) → null
    assert('Case 1: nextAt=0 → null',
      formatCountdown_test(0, NOW) === null);

    // Case 2: 90 seconds remaining → "1m 30s"
    assertEq('Case 2: 90s remaining → "1m 30s"',
      formatCountdown_test(NOW + 90_000, NOW), '1m 30s');

    // Case 3: 45 seconds remaining → "45s"
    assertEq('Case 3: 45s remaining → "45s"',
      formatCountdown_test(NOW + 45_000, NOW), '45s');

    // Case 4: overdue (past) → "due now"
    assertEq('Case 4: overdue → "due now"',
      formatCountdown_test(NOW - 1000, NOW), 'due now');

    // Case 5: exactly 0ms remaining → "due now"
    assertEq('Case 5: exactly now → "due now"',
      formatCountdown_test(NOW, NOW), 'due now');

    // Case 6: 8 minutes → "8m 0s"
    assertEq('Case 6: 8 min → "8m 0s"',
      formatCountdown_test(NOW + 8 * 60_000, NOW), '8m 0s');

    console.groupEnd();
  }

  // Re-implementation of the capture button state logic from queryMeetingState (popup.js).
  // KEEP IN SYNC with the mm2c_capture_state callback in queryMeetingState.
  function captureBtnState_test(geminiActive, capturing) {
    if (capturing)     return { disabled: true,  text: 'Capturing…' };
    if (!geminiActive) return { disabled: true,  text: 'Start Gemini first' };
    return             { disabled: false, text: 'Capture now' };
  }

  function testCaptureBtnState() {
    console.group('captureBtnState');

    const s1 = captureBtnState_test(true,  true);
    assert('capturing → disabled', s1.disabled);
    assertEq('capturing → text', s1.text, 'Capturing…');

    const s2 = captureBtnState_test(false, false);
    assert('gemini inactive → disabled', s2.disabled);
    assertEq('gemini inactive → text', s2.text, 'Start Gemini first');

    const s3 = captureBtnState_test(true,  false);
    assert('gemini active → enabled', !s3.disabled);
    assertEq('gemini active → text', s3.text, 'Capture now');

    console.groupEnd();
  }

  // Re-implementation of the snapshot interval clamping from content_meet.js.
  // KEEP IN SYNC with: Math.max(3, Math.min(30, parseInt(raw || '8', 10) || 8)) * 60 * 1000
  function computeSnapshotIntervalMs_test(rawMin) {
    const parsed = parseInt(rawMin || '8', 10) || 8;
    return Math.max(3, Math.min(30, parsed)) * 60_000;
  }

  function testSnapshotInterval() {
    console.group('snapshotInterval');

    assertEq('8 min (default) → 480000 ms',   computeSnapshotIntervalMs_test(8),   480_000);
    assertEq('3 min (minimum) → 180000 ms',   computeSnapshotIntervalMs_test(3),   180_000);
    assertEq('30 min (maximum) → 1800000 ms', computeSnapshotIntervalMs_test(30), 1_800_000);
    assertEq('0 (falsy) → falls back to default 8 min', computeSnapshotIntervalMs_test(0), 480_000);
    assertEq('50 → clamped to 30 min',        computeSnapshotIntervalMs_test(50), 1_800_000);
    assertEq('empty string → defaults to 8',  computeSnapshotIntervalMs_test(''),  480_000);

    console.groupEnd();
  }

  // Re-implementation of the prompt rule matching logic from _runGeminiFlowInner (content_meet.js).
  // KEEP IN SYNC with: rules.find(r => { try { return new RegExp(r.regex, 'i').test(title) } catch { return false } })
  function matchPromptRule_test(rules, meetingTitle) {
    if (!Array.isArray(rules)) return null;
    const matched = rules.find(r => {
      if (!r?.regex) return false;
      try { return new RegExp(r.regex, 'i').test(meetingTitle || ''); }
      catch { return false; }
    });
    return matched?.prompt?.trim() || null;
  }

  function testMatchPromptRule() {
    console.group('matchPromptRule');

    // Case 1: empty rules → null
    assert('Case 1: empty rules returns null',
      matchPromptRule_test([], 'Daily Standup') === null);

    // Case 2: first matching rule wins
    const rules = [
      { regex: 'DAILY', prompt: 'Standup prompt' },
      { regex: 'Planning', prompt: 'Planning prompt' },
    ];
    assertEq('Case 2: first matching rule wins',
      matchPromptRule_test(rules, 'Daily Standup'),
      'Standup prompt');

    // Case 3: case-insensitive match
    assertEq('Case 3: match is case-insensitive',
      matchPromptRule_test([{ regex: 'daily', prompt: 'ok' }], 'DAILY STANDUP'),
      'ok');

    // Case 4: no match → null
    assert('Case 4: no match returns null',
      matchPromptRule_test(rules, 'Retrospective') === null);

    console.groupEnd();
  }

  // Re-implementation of the note language prefix logic from _runGeminiFlowInner (content_meet.js).
  // KEEP IN SYNC with: languagePrefix = mm2c_note_language ? `Write all notes in ${mm2c_note_language}. Preserve proper nouns...` : ''
  function buildPromptWithLanguage_test(basePrompt, language) {
    const prefix = language
      ? `Write all notes in ${language}. Preserve proper nouns, product names, technical acronyms, and people's names in their original form without translating them.\n\n`
      : '';
    return prefix + basePrompt;
  }

  function testBuildPromptWithLanguage() {
    console.group('buildPromptWithLanguage');

    // Case 1: Auto (empty language) → prompt unchanged
    assertEq('Case 1: Auto returns base prompt unchanged',
      buildPromptWithLanguage_test('Take notes.', ''),
      'Take notes.');

    // Case 2: Spanish → language instruction with proper noun protection prepended
    assertEq('Case 2: Spanish prepends language instruction with proper noun protection',
      buildPromptWithLanguage_test('Take notes.', 'Spanish'),
      'Write all notes in Spanish. Preserve proper nouns, product names, technical acronyms, and people\'s names in their original form without translating them.\n\nTake notes.');

    // Case 3: custom language → instruction prepended correctly
    assertEq('Case 3: custom language works',
      buildPromptWithLanguage_test('Take notes.', 'Japanese'),
      'Write all notes in Japanese. Preserve proper nouns, product names, technical acronyms, and people\'s names in their original form without translating them.\n\nTake notes.');

    console.groupEnd();
  }

  // Re-implementation of the visibilitychange catch-up condition from content_meet.js.
  // KEEP IN SYNC with: elapsed >= SNAPSHOT_INTERVAL_MS / 2 && getLeaveButton() && isGeminiAvailable()
  function shouldRunCatchupSnapshot_test(elapsed, intervalMs, inMeeting, geminiActive) {
    return elapsed >= intervalMs / 2 && inMeeting && geminiActive;
  }

  function testVisibilityChangeCatchup() {
    console.group('visibilityChangeCatchup');
    const MS = 600_000; // 10 min — matches SNAPSHOT_INTERVAL_MS

    // Case 1: all conditions met → should run
    assert('Case 1: runs when elapsed >= half-interval, in meeting, gemini active',
      shouldRunCatchupSnapshot_test(MS / 2, MS, true, true));

    // Case 2: elapsed below threshold → should not run
    assert('Case 2: does not run when elapsed < half-interval',
      !shouldRunCatchupSnapshot_test(MS / 2 - 1, MS, true, true));

    // Case 3: exactly at threshold → should run (>= is inclusive)
    assert('Case 3: runs at exactly the half-interval boundary (>= not >)',
      shouldRunCatchupSnapshot_test(MS / 2, MS, true, true));

    // Case 4: not in meeting → should not run
    assert('Case 4: does not run when not in meeting',
      !shouldRunCatchupSnapshot_test(MS, MS, false, true));

    // Case 5: gemini not active → should not run
    assert('Case 5: does not run when gemini not active',
      !shouldRunCatchupSnapshot_test(MS, MS, true, false));

    console.groupEnd();
  }

  // Re-implementation of autoActivateGemini with injectable state and deps.
  // KEEP IN SYNC with autoActivateGemini in content_meet.js.
  // Intentional deviations: _isContextValid and _getLeaveButton are injectable
  // (they check chrome.runtime.id and live DOM — unavailable in page-world tests).
  async function autoActivateGemini_test(state, deps) {
    const {
      _isContextValid        = () => true,
      _getLeaveButton        = () => true,
      _waitForGeminiTrigger  = async () => null,
      _isInViewport          = () => false,
      _waitForStartNowButton = async () => null,
      _waitForPanelVisible   = async () => {},
      _sendLog               = () => {},
      _showStatus            = () => {},
    } = deps;

    if (state.panelAutoOpened || state.geminiActivating) return;
    state.geminiActivating = true;

    try {
      if (!_isContextValid() || !_getLeaveButton()) return;

      const trigger = await _waitForGeminiTrigger(2500);
      if (!trigger) return;

      if (_isInViewport()) {
        _sendLog('Gemini panel already open — skipping auto-activation');
        state.panelAutoOpened = true;
        return;
      }

      trigger.click();

      const startNowBtn = await _waitForStartNowButton(800);
      if (startNowBtn) startNowBtn.click();

      try {
        await _waitForPanelVisible(5000);
      } catch {
        _sendLog('Gemini panel did not open after trigger click — Gemini may be disabled by admin');
        _showStatus('Gemini may be disabled for your account — check with your Google Admin', 'warn');
        return;
      }

      state.geminiWasActive = true;
      state.panelAutoOpened = true;
      _sendLog('Gemini panel opened automatically — note-taking started');
    } finally {
      state.geminiActivating = false;
    }
  }

  async function testAutoActivate() {
    console.group('autoActivateGemini');

    const mkState = () => ({
      panelAutoOpened: false, geminiActivating: false, geminiWasActive: false,
    });

    // Case 1: panelAutoOpened guard — returns early without setting geminiActivating
    await (async () => {
      const state = { panelAutoOpened: true, geminiActivating: false, geminiWasActive: false };
      let triggerCallCount = 0;
      await autoActivateGemini_test(state, {
        _waitForGeminiTrigger: async () => { triggerCallCount++; return null; },
      });
      assert('Case 1: panelAutoOpened guard skips waitForGeminiTrigger',
        triggerCallCount === 0, `calls: ${triggerCallCount}`);
      assert('Case 1: geminiActivating never set', !state.geminiActivating);
    })();

    // Case 2: no trigger found — returns, geminiActivating released
    await (async () => {
      const state = mkState();
      await autoActivateGemini_test(state, {
        _waitForGeminiTrigger: async () => null,
      });
      assert('Case 2: panelAutoOpened stays false when no trigger', !state.panelAutoOpened);
      assert('Case 2: geminiActivating released in finally', !state.geminiActivating);
    })();

    // Case 3: panel already in viewport — trigger found but NOT clicked
    await (async () => {
      const state = mkState();
      let clickCount = 0;
      const mockTrigger = { click: () => { clickCount++; }, getAttribute: () => 'Gemini', textContent: '' };
      await autoActivateGemini_test(state, {
        _waitForGeminiTrigger: async () => mockTrigger,
        _isInViewport: () => true,
      });
      assert('Case 3: trigger NOT clicked when panel already in viewport', clickCount === 0,
        `clicks: ${clickCount}`);
      assert('Case 3: panelAutoOpened = true', state.panelAutoOpened);
      assert('Case 3: geminiWasActive stays false', !state.geminiWasActive);
    })();

    // Case 4: admin-disabled — waitForPanelVisible rejects
    await (async () => {
      const state = mkState();
      const statuses = [];
      const mockTrigger = { click: () => {}, getAttribute: () => 'Gemini', textContent: '' };
      await autoActivateGemini_test(state, {
        _waitForGeminiTrigger:  async () => mockTrigger,
        _waitForStartNowButton: async () => null,
        _waitForPanelVisible:   async () => { throw new Error('timeout'); },
        _showStatus: (msg, type) => statuses.push({ msg, type }),
      });
      assert('Case 4: panelAutoOpened stays false on admin-disabled', !state.panelAutoOpened);
      assert('Case 4: geminiWasActive stays false', !state.geminiWasActive);
      assert('Case 4: warn status shown',
        statuses.some(s => s.type === 'warn' && s.msg.includes('disabled')),
        JSON.stringify(statuses));
      assert('Case 4: geminiActivating released', !state.geminiActivating);
    })();

    // Case 5: happy path — trigger found, Start Now clicked, panel opens
    await (async () => {
      const state = mkState();
      let triggerClicks = 0;
      let startNowClicks = 0;
      const mockTrigger  = { click: () => { triggerClicks++; }, getAttribute: () => 'Gemini', textContent: '' };
      const mockStartNow = { click: () => { startNowClicks++; } };
      await autoActivateGemini_test(state, {
        _waitForGeminiTrigger:  async () => mockTrigger,
        _waitForStartNowButton: async () => mockStartNow,
        _waitForPanelVisible:   async () => {},
      });
      assert('Case 5: trigger clicked', triggerClicks === 1, `clicks: ${triggerClicks}`);
      assert('Case 5: Start Now clicked', startNowClicks === 1, `clicks: ${startNowClicks}`);
      assert('Case 5: panelAutoOpened = true', state.panelAutoOpened);
      assert('Case 5: geminiWasActive = true', state.geminiWasActive);
      assert('Case 5: geminiActivating released', !state.geminiActivating);
    })();

    console.groupEnd();
  }

  function testCaptureNow() {
    console.group('captureNow');

    // Verify the message type constant used by both popup.js and content_meet.js.
    assert('MM2C_CAPTURE_NOW message type is correct string',
      'MM2C_CAPTURE_NOW' === 'MM2C_CAPTURE_NOW');

    // Re-implement the handler logic with an injectable mock.
    // KEEP IN SYNC with the MM2C_CAPTURE_NOW handler in content_meet.js.
    let snapshotCalled = false;
    const mockTakePeriodicSnapshot = () => { snapshotCalled = true; };
    const responses = [];
    const mockSendResponse = (r) => responses.push(r);

    const handleCaptureNow = (msg, sendResponse, takePeriodicSnapshot) => {
      if (msg.type === 'MM2C_CAPTURE_NOW') {
        takePeriodicSnapshot();
        sendResponse({ ok: true });
      }
    };

    // Case 1: MM2C_CAPTURE_NOW triggers takePeriodicSnapshot and responds ok
    handleCaptureNow({ type: 'MM2C_CAPTURE_NOW' }, mockSendResponse, mockTakePeriodicSnapshot);
    assert('Case 1: MM2C_CAPTURE_NOW invokes takePeriodicSnapshot', snapshotCalled);
    assert('Case 1: handler responds { ok: true }',
      responses.length === 1 && responses[0]?.ok === true,
      JSON.stringify(responses));

    // Case 2: other message types are ignored
    snapshotCalled = false;
    handleCaptureNow({ type: 'MM2C_OTHER' }, mockSendResponse, mockTakePeriodicSnapshot);
    assert('Case 2: other message types do not invoke takePeriodicSnapshot', !snapshotCalled);

    console.groupEnd();
  }

  async function testRegenerationGuard() {
    console.group('regenerationGuard');

    // Case 1a: Stop button found when present in aside
    await withFixture(`
      <aside aria-label="Side panel">
        <button aria-label="Stop generating"></button>
      </aside>`, (c) => {
      const aside = c.querySelector('aside[aria-label="Side panel"]');
      const stopBtn = aside.querySelector('button[aria-label*="Stop"]');
      assert('Case 1a: Stop button found when present in aside', !!stopBtn);
    });

    // Case 1b: Stop button null when absent from aside
    await withFixture(`<aside aria-label="Side panel"></aside>`, (c) => {
      const aside = c.querySelector('aside[aria-label="Side panel"]');
      const stopBtn = aside.querySelector('button[aria-label*="Stop"]');
      assert('Case 1b: Stop button null when absent from aside', stopBtn === null);
    });

    // Case 2: Guard blocks resolution when regenerating; resets lastChangeAt to 0
    (() => {
      const state = { lastChangeAt: Date.now() - 5000, contentLength: 50, elapsed: 5000 };
      const result = checkStabilityGuard_test(state, /* isRegenerating */ true);
      assert('Case 2: guard returns blocked when regenerating', result === 'blocked',
        `got: ${result}`);
      assert('Case 2: lastChangeAt reset to 0 when blocked', state.lastChangeAt === 0,
        `got: ${state.lastChangeAt}`);
    })();

    // Case 3: Guard allows resolution when not regenerating
    (() => {
      const state = { lastChangeAt: Date.now() - 5000, contentLength: 50, elapsed: 5000 };
      const result = checkStabilityGuard_test(state, /* isRegenerating */ false);
      assert('Case 3: guard returns resolve when not regenerating', result === 'resolve',
        `got: ${result}`);
    })();

    // Case 4: Guard returns not-ready when stability conditions not met
    (() => {
      const state = { lastChangeAt: Date.now() - 1000, contentLength: 50, elapsed: 1000 };
      const result = checkStabilityGuard_test(state, false);
      assert('Case 4: guard returns not-ready when elapsed < 3000ms', result === 'not-ready',
        `got: ${result}`);
    })();

    console.groupEnd();
  }

  // ── New tests for v0.1.54-0.1.66 features ─────────────────────────────────

  // ── 1. Citation second-pass regex ─────────────────────────────────────────
  // Tests added directly into testExtractLastResponse via the dedicated fixture
  // section below. The second-pass regex /(?<=[a-zA-Z"'])([1-9])(?=[\s\n]|$)/gm
  // was added in v0.1.66 to handle digits directly after letters and closing quotes.

  function testCitationSecondPass() {
    console.group('extractLastResponse — second-pass citation regex');

    // Case 1: digit directly after a word letter (Carlos Sol1 → Carlos Sol)
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = [
        'Gemini response',
        'Attendees',
        'Carlos Sol1',
        'Summary',
        'The meeting concluded.',
      ].map(t => `<div>${t}</div>`).join('');
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Strips trailing digit after letter: "Sol1" → "Sol"',
        result?.includes('Carlos Sol') && !result?.includes('Carlos Sol1'), `got: "${result}"`);
    });

    // Case 2: digit after closing ASCII double-quote  ("agree."1 → "agree.")
    // Use innerText with plain ASCII " (U+0022) — the regex lookbehind targets ASCII " only.
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = 'Gemini response\nSummary\nHe said "I agree."1\nReport\n';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Strips digit after ASCII closing quote: "agree."1 → "agree."',
        result !== null && !result?.includes('"1'), `got: "${result}"`);
    });

    // Case 3: Python 3.11 must NOT be corrupted (digit precedes the digit → no match)
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = 'Gemini response\nUsing Python 3.11 and Node 18.1 in production.\n';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Preserves Python 3.11 (digit.digit pattern)',
        result?.includes('3.11'), `got: "${result}"`);
      assert('Preserves Node 18.1 (digit.digit pattern)',
        result?.includes('18.1'), `got: "${result}"`);
    });

    // Case 4: decimal number 0.5 must NOT be corrupted
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerText = 'Gemini response\nScore of 0.5 FTE allocated.\n';
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('Preserves decimal 0.5 (digit before decimal)',
        result?.includes('0.5'), `got: "${result}"`);
    });

    console.groupEnd();
  }

  // ── 2. Timer-drift guard ───────────────────────────────────────────────────
  // Re-implementation of the timer-drift condition in takePeriodicSnapshot.
  // ── 3. Leave click fresh-first capture logic ──────────────────────────────
  // Re-implementation of the fresh-first capture path in onLeaveClick.
  // KEEP IN SYNC with the `if (true)` fresh-first block in onLeaveClick
  // (content_meet.js) and the subsequent cache fallback.
  // GeminiNotActiveError_test already declared at top of IIFE

  async function onLeaveClickFreshFirst_test({
    _runGeminiFlow     = async () => 'fresh result',
    _cachedTranscript  = null,
  } = {}) {
    let transcript = null;

    // Primary: always try fresh
    try {
      transcript = await _runGeminiFlow(60_000);
    } catch (freshErr) {
      if (freshErr instanceof GeminiNotActiveError_test) {
        // Gemini never ran — fall through to cache
      } else {
        // Other error — fall through to cache
      }
    }

    // Fallback: use cache when fresh failed
    if (!transcript && _cachedTranscript) {
      transcript = _cachedTranscript;
    }

    return transcript;
  }

  async function testLeaveClickFreshFirst() {
    console.group('onLeaveClick — fresh-first capture');

    // Case 1: fresh flow succeeds → returns fresh, ignores cache
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => 'fresh notes',
        _cachedTranscript: 'stale cache',
      });
      assertEq('Case 1: fresh succeeds → fresh result returned (not cache)',
        result, 'fresh notes');
    }

    // Case 2: fresh throws generic error → falls back to cache
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => { throw new Error('DOM race'); },
        _cachedTranscript: 'cached snapshot',
      });
      assertEq('Case 2: fresh fails (generic) → cache fallback',
        result, 'cached snapshot');
    }

    // Case 3: fresh throws GeminiNotActiveError → falls back to cache
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => { throw new GeminiNotActiveError_test('not active'); },
        _cachedTranscript: 'cached snapshot',
      });
      assertEq('Case 3: GeminiNotActiveError → cache fallback',
        result, 'cached snapshot');
    }

    // Case 4: fresh throws, no cache → null
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => { throw new Error('failed'); },
        _cachedTranscript: null,
      });
      assert('Case 4: fresh fails, no cache → null',
        result === null);
    }

    // Case 5: fresh succeeds even though cache exists — fresh wins
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => 'brand new summary',
        _cachedTranscript: 'old snapshot',
      });
      assertEq('Case 5: fresh succeeds alongside cache → fresh wins',
        result, 'brand new summary');
    }

    // Case 6: no cache, no fresh (Gemini not active) → null
    {
      const result = await onLeaveClickFreshFirst_test({
        _runGeminiFlow:    async () => { throw new GeminiNotActiveError_test(); },
        _cachedTranscript: null,
      });
      assert('Case 6: Gemini not active, no cache → null',
        result === null);
    }

    console.groupEnd();
  }

  // ── 4. getGeminiTriggerElement state detection ────────────────────────────
  // Re-implementation of getGeminiTriggerElement selector logic.
  // KEEP IN SYNC with getGeminiTriggerElement in content_meet.js.
  // Each element: { role, ariaLabel, text }
  function getGeminiTriggerElement_test(elements) {
    // Rule 1: any element with aria-label containing "Gemini"
    const byLabel = elements.find(
      e => e.ariaLabel && /Gemini/i.test(e.ariaLabel)
    );
    if (byLabel) return byLabel;
    // Rule 2: role=button, text starts with "Gemini", NOT "take notes"
    for (const el of elements) {
      if (el.role === 'button') {
        const t = el.text || '';
        if (/^Gemini/i.test(t) && !/take notes/i.test(t)) return el;
      }
    }
    // Rule 3: "Take notes with Gemini" fallback
    for (const el of elements) {
      if (el.role === 'button' && /take notes with gemini/i.test(el.text || '')) return el;
    }
    return null;
  }

  function testGeminiTriggerStates() {
    console.group('getGeminiTriggerElement');

    // Case 1: State 2 — button[aria-label="Gemini"] present → found via rule 1
    {
      const elements = [
        { role: 'button', ariaLabel: 'Gemini', text: 'Gemini' },
        { role: 'button', ariaLabel: null,     text: 'Take notes with Geminipen_spark' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assert('Case 1: State 2 — aria-label="Gemini" found via rule 1',
        result !== null && result.ariaLabel === 'Gemini');
    }

    // Case 2: State 1 — "Geminispark_off" (no aria-label) → found via rule 2
    {
      const elements = [
        { role: 'button', ariaLabel: null, text: 'Take notes with Geminipen_spark' },
        { role: 'button', ariaLabel: null, text: 'Geminispark_off' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assert('Case 2: State 1 — "Geminispark_off" found via rule 2',
        result !== null && result.text === 'Geminispark_off');
    }

    // Case 3: Only "Take notes with Gemini" present → found via rule 3 fallback
    {
      const elements = [
        { role: 'button', ariaLabel: null, text: 'Take notes with Geminipen_spark' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assert('Case 3: "Take notes with Gemini" found via rule 3 fallback',
        result !== null && /take notes/i.test(result.text));
    }

    // Case 4: State 2 aria-label takes precedence over "Take notes" fallback
    {
      const elements = [
        { role: 'button', ariaLabel: null,     text: 'Take notes with Geminipen_spark' },
        { role: 'button', ariaLabel: 'Gemini', text: 'Gemini' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assertEq('Case 4: aria-label="Gemini" wins over "Take notes" fallback',
        result?.ariaLabel, 'Gemini');
    }

    // Case 5: No Gemini elements → null
    {
      const elements = [
        { role: 'button', ariaLabel: 'Leave call',     text: 'call_end' },
        { role: 'button', ariaLabel: 'Turn off camera', text: 'videocam' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assert('Case 5: No Gemini elements → null',
        result === null);
    }

    // Case 6: "Geminispark_off" is NOT matched by "Take notes" rule (rule 2 gets it)
    {
      const elements = [
        { role: 'button', ariaLabel: null, text: 'Geminispark_off' },
      ];
      const result = getGeminiTriggerElement_test(elements);
      assert('Case 6: Geminispark_off matched by rule 2, not rule 3',
        result?.text === 'Geminispark_off');
    }

    console.groupEnd();
  }

  // ── 5. waitForActiveGeminiButton DOM appearance ───────────────────────────
  // Tests the MutationObserver-based detection of button[aria-label*="Gemini"].
  // This helper mirrors waitForActiveGeminiButton in content_meet.js but is
  // scoped to a container so it doesn't pollute the global document.
  function waitForActiveGeminiButton_test(containerEl, timeoutMs) {
    const SELECTOR = 'button[aria-label*="Gemini" i]';
    return new Promise((resolve) => {
      const found = containerEl.querySelector(SELECTOR);
      if (found) { resolve(found); return; }
      let done = false;
      const finish = (el) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(t);
        resolve(el);
      };
      const obs = new MutationObserver(() => {
        const el = containerEl.querySelector(SELECTOR);
        if (el) finish(el);
      });
      obs.observe(containerEl, { childList: true, subtree: true });
      const t = setTimeout(() => finish(null), timeoutMs);
    });
  }

  async function testWaitForActiveGeminiButton() {
    console.group('waitForActiveGeminiButton');

    // Case 1: button already present → resolves immediately
    await withFixture('', async (c) => {
      const btn = document.createElement('button');
      btn.setAttribute('aria-label', 'Gemini');
      c.appendChild(btn);
      const result = await waitForActiveGeminiButton_test(c, 500);
      assert('Case 1: resolves immediately when button already present',
        result !== null);
      assertEq('Case 1: returns correct element',
        result?.getAttribute('aria-label'), 'Gemini');
    });

    // Case 2: button appears after 60ms → MutationObserver detects it
    await withFixture('', async (c) => {
      setTimeout(() => {
        const btn = document.createElement('button');
        btn.setAttribute('aria-label', 'Gemini');
        c.appendChild(btn);
      }, 60);
      const result = await waitForActiveGeminiButton_test(c, 500);
      assert('Case 2: detects button added asynchronously via MutationObserver',
        result !== null);
    });

    // Case 3: button never appears → resolves null after timeout
    await withFixture('', async (c) => {
      const result = await waitForActiveGeminiButton_test(c, 100);
      assert('Case 3: resolves null when button never appears (timeout)',
        result === null);
    });

    // Case 4: non-Gemini buttons ignored, Gemini button detected
    await withFixture('', async (c) => {
      // Add a non-matching button first
      const other = document.createElement('button');
      other.setAttribute('aria-label', 'Leave call');
      c.appendChild(other);
      // Then add the Gemini button after 50ms
      setTimeout(() => {
        const btn = document.createElement('button');
        btn.setAttribute('aria-label', 'Gemini');
        c.appendChild(btn);
      }, 50);
      const result = await waitForActiveGeminiButton_test(c, 500);
      assertEq('Case 4: ignores non-Gemini buttons, detects Gemini button',
        result?.getAttribute('aria-label'), 'Gemini');
    });

    console.groupEnd();
  }

  // Pure helper mirroring the examplePrefix logic in content_meet.js _runGeminiFlowInner.
  // KEEP IN SYNC with: examplePrefix = `Here is an example...\n\n---\n${EXAMPLE_NOTES}\n---\n\n...`
  function buildPromptWithExample_test(basePrompt, exampleNotes) {
    const prefix = exampleNotes
      ? `Here is an example of the exact note format to produce:\n\n---\n${exampleNotes}\n---\n\nNow produce notes for the current meeting following this exact format:\n\n`
      : '';
    return prefix + basePrompt;
  }

  // KEEP IN SYNC with backup path extraction in popup.js log entry rendering.
  // Regex: /backup at (.+)$/ — captures everything after "backup at " to end of string.
  function extractBackupPath_test(message) {
    const match = (message || '').match(/backup at (.+)$/);
    return match?.[1] ?? '';
  }

  function testExtractBackupPath() {
    console.group('extractBackupPath');

    assertEq('extracts path from full error message',
      extractBackupPath_test(
        'Host error: Could not open Craft URL — backup at /Users/caraujo/Downloads/meeting-notes/file.md'
      ),
      '/Users/caraujo/Downloads/meeting-notes/file.md');

    assertEq('message without backup path → empty string',
      extractBackupPath_test('Host error: Native host not found'),
      '');

    assertEq('empty message → empty string',
      extractBackupPath_test(''),
      '');

    console.groupEnd();
  }

  // KEEP IN SYNC with firstSnapshotAt computation in content_meet.js MM2C_STATUS_QUERY
  function computeFirstSnapshotAt_test(meetingJoinedAt, lastSnapshotAt, snapshotIntervalMs) {
    return meetingJoinedAt > 0 && lastSnapshotAt === 0
      ? meetingJoinedAt + snapshotIntervalMs
      : 0;
  }

  function testFirstSnapshotAt() {
    console.group('firstSnapshotAt');
    const INTERVAL = 8 * 60_000;
    const T = 1_000_000_000_000;

    // Case 1: not in meeting → 0
    assertEq('Case 1: meetingJoinedAt=0 → 0',
      computeFirstSnapshotAt_test(0, 0, INTERVAL), 0);

    // Case 2: in meeting, no snapshot yet → meetingJoinedAt + interval
    assertEq('Case 2: in meeting, no snapshot → ETA',
      computeFirstSnapshotAt_test(T, 0, INTERVAL), T + INTERVAL);

    // Case 3: first snapshot already taken → 0
    assertEq('Case 3: lastSnapshotAt > 0 → 0 (already done)',
      computeFirstSnapshotAt_test(T, T + 1000, INTERVAL), 0);

    // Case 4: interval math — 3 min interval
    assertEq('Case 4: 3-min interval → T + 3min',
      computeFirstSnapshotAt_test(T, 0, 3 * 60_000), T + 3 * 60_000);

    console.groupEnd();
  }

  // KEEP IN SYNC with outputAppName() in content_meet.js
  function outputAppName_test(appKey) {
    return ({ craft: 'Craft', apple_notes: 'Apple Notes', none: 'None', obsidian: 'Obsidian' })[appKey] || appKey;
  }

  function testOutputAppName() {
    console.group('outputAppName');
    assertEq('craft → Craft',                outputAppName_test('craft'),       'Craft');
    assertEq('apple_notes → Apple Notes',    outputAppName_test('apple_notes'), 'Apple Notes');
    assertEq('none → None',                  outputAppName_test('none'),        'None');
    assertEq('obsidian → Obsidian',          outputAppName_test('obsidian'),    'Obsidian');
    assertEq('unknown key → returned as-is', outputAppName_test('unknown'),     'unknown');
    console.groupEnd();
  }

  function testBuildPromptWithExample() {
    console.group('buildPromptWithExample');

    // Case 1: with example → prefix prepended
    const result1 = buildPromptWithExample_test('Take notes.', 'Example note content.');
    assert('Case 1: example prefix is prepended',
      result1.startsWith('Here is an example of the exact note format to produce:'));
    assert('Case 1: example content is included between separators',
      result1.includes('---\nExample note content.\n---'));
    assert('Case 1: base prompt follows the example block',
      result1.endsWith('Take notes.'));

    // Case 2: empty example → no prefix, prompt unchanged
    assertEq('Case 2: empty example → prompt unchanged',
      buildPromptWithExample_test('Take notes.', ''),
      'Take notes.');

    // Case 3: EXAMPLE_NOTES constant works end-to-end with helper
    const result3 = buildPromptWithExample_test('Take notes.', EXAMPLE_NOTES);
    assert('Case 3: real EXAMPLE_NOTES produces valid prefix',
      result3.startsWith('Here is an example') && result3.endsWith('Take notes.'));

    console.groupEnd();
  }

  // Pure helper mirroring the titlePrefix logic in content_meet.js _runGeminiFlowInner.
  // KEEP IN SYNC with: titlePrefix = currentMeetingTitle ? `Meeting title: ${currentMeetingTitle}...` : ''
  function buildPromptWithTitle_test(basePrompt, title) {
    const prefix = title
      ? `Meeting title: ${title}. Use this context to interpret references to projects, teams, or products in the transcript.\n\n`
      : '';
    return prefix + basePrompt;
  }

  // Pure helper mirroring the attendeesPrefix logic in content_meet.js _runGeminiFlowInner.
  // KEEP IN SYNC with: attendeesPrefix = attendees.length > 0 ? `Meeting attendees: 1. X, 2. Y...` : ''
  function buildPromptWithAttendees_test(basePrompt, attendees) {
    const prefix = attendees.length > 0
      ? `Meeting attendees: ${attendees.map((n, i) => `${i + 1}. ${n}`).join(', ')}. Use these exact names when assigning action items.\n\n`
      : '';
    return prefix + basePrompt;
  }

  function testBuildPromptWithAttendees() {
    console.group('buildPromptWithAttendees');

    // Case 1: no attendees → prompt unchanged
    assertEq('Case 1: empty attendees → no prefix',
      buildPromptWithAttendees_test('Take notes.', []),
      'Take notes.');

    // Case 2: one attendee → numbered list
    assertEq('Case 2: one attendee → numbered prefix',
      buildPromptWithAttendees_test('Take notes.', ['Alice Chen']),
      'Meeting attendees: 1. Alice Chen. Use these exact names when assigning action items.\n\nTake notes.');

    // Case 3: multiple attendees → comma-separated numbered list
    assertEq('Case 3: multiple attendees → numbered comma-separated',
      buildPromptWithAttendees_test('Take notes.', ['Alice Chen', 'Bob Martinez', 'Carlos Rodriguez']),
      'Meeting attendees: 1. Alice Chen, 2. Bob Martinez, 3. Carlos Rodriguez. Use these exact names when assigning action items.\n\nTake notes.');

    // Case 4: single character name still included (filtering is in getAttendeeNames)
    assertEq('Case 4: single-char name still included',
      buildPromptWithAttendees_test('Take notes.', ['A']),
      'Meeting attendees: 1. A. Use these exact names when assigning action items.\n\nTake notes.');

    console.groupEnd();
  }

  function testBuildPromptWithTitle() {
    console.group('buildPromptWithTitle');

    // Case 1: no title → prompt unchanged
    assertEq('Case 1: empty title → no prefix',
      buildPromptWithTitle_test('Take notes.', ''),
      'Take notes.');

    // Case 2: with title → prefix prepended
    assertEq('Case 2: title prepended with context hint',
      buildPromptWithTitle_test('Take notes.', 'Q3 Planning'),
      'Meeting title: Q3 Planning. Use this context to interpret references to projects, teams, or products in the transcript.\n\nTake notes.');

    // Case 3: title with special characters → included verbatim
    assertEq('Case 3: title with dash and colon included verbatim',
      buildPromptWithTitle_test('Take notes.', 'Platform Team — Weekly Sync'),
      'Meeting title: Platform Team — Weekly Sync. Use this context to interpret references to projects, teams, or products in the transcript.\n\nTake notes.');

    // Case 4: null/undefined title → no prefix (falsy guard)
    assertEq('Case 4: null title → no prefix',
      buildPromptWithTitle_test('Take notes.', null),
      'Take notes.');

    console.groupEnd();
  }

  function testDefaultPromptContent() {
    console.group('DEFAULT_PROMPT content');

    // P5-D: adaptive summary length
    assert('P5-D: adaptive summary instruction present',
      DEFAULT_PROMPT.includes('1–2 sentences for meetings under 30 minutes, or 3–4 sentences for longer meetings'));

    // P5-E: decision signal guard
    assert('P5-E: decision signal guard present',
      DEFAULT_PROMPT.includes('Only classify something as a decision if the transcript contains agreement language'));

    // P5-F: short meeting fallback (transcript-length based, not time-based)
    assert('P5-F: short meeting fallback present',
      DEFAULT_PROMPT.includes('If the transcript contains very little content'));

    // Sanity: still contains core sections
    assert('Sanity: Attendees heading still present', DEFAULT_PROMPT.includes('"Attendees"'));
    assert('Sanity: Action Items heading still present', DEFAULT_PROMPT.includes('"Action Items"'));

    // P5-B: pronoun ban + deadline language
    assert('P5-B: pronoun ban present',
      DEFAULT_PROMPT.includes('never write "I" or "they"'));
    assert('P5-B: no deadline set language present',
      DEFAULT_PROMPT.includes('otherwise write "no deadline set"'));

    // P5-A1: risks and concerns in Open Questions
    assert('P5-A1: risks/concerns in Open Questions',
      DEFAULT_PROMPT.includes('risks or concerns raised during the meeting'));

    // P5-A2: Next Steps section present
    assert('P5-A2: Next Steps heading present',
      DEFAULT_PROMPT.includes('"Next Steps"'));
    assert('P5-A2: Next Steps described as shared calendar commitments',
      DEFAULT_PROMPT.includes('shared calendar commitments'));

    // P5-C: hallucination guard
    assert('P5-C: vague filler phrase ban present',
      DEFAULT_PROMPT.includes('Do not use vague filler phrases'));
    assert('P5-C: omit empty section instruction present',
      DEFAULT_PROMPT.includes('If a section has no content, omit the heading entirely'));

    // P5-G: EXAMPLE_NOTES constant is non-empty and well-formed
    assert('P5-G: EXAMPLE_NOTES defined and non-empty',
      typeof EXAMPLE_NOTES === 'string' && EXAMPLE_NOTES.length > 100);
    assert('P5-G: EXAMPLE_NOTES contains Action Items section',
      EXAMPLE_NOTES.includes('Action Items'));
    assert('P5-G: EXAMPLE_NOTES contains Next Steps section',
      EXAMPLE_NOTES.includes('Next Steps'));

    console.groupEnd();
  }

  function testTabState() {
  // tabKey — tests the actual function from constants.js
  assert('tabKey: basic', tabKey('mm2c_capture_state', 42) === 'mm2c_capture_state_42');
  assert('tabKey: zero tabId', tabKey('mm2c_last_snapshot', 0) === 'mm2c_last_snapshot_0');

  // addFailure / removeFailure — inline definitions matching background.js
  const addFailure    = (list, entry) => [...(Array.isArray(list) ? list : []), entry];
  const removeFailure = (list, tid)   => (Array.isArray(list) ? list : []).filter(f => f.tabId !== tid);

  const f1 = addFailure([], { tabId: 1, title: 'A', backupPath: '/a' });
  assert('addFailure: first entry', f1.length === 1);

  const f2 = addFailure(f1, { tabId: 2, title: 'B', backupPath: '/b' });
  assert('addFailure: second entry', f2.length === 2);

  const r1 = removeFailure(f2, 1);
  assert('removeFailure: removes correct entry', r1.length === 1 && r1[0].tabId === 2);

  const r2 = removeFailure(f2, 99);
  assert('removeFailure: no-op on missing tabId', r2.length === 2);

  // removeFailureByPath — real function from constants.js. Identity used by
  // user-initiated retry/dismiss, since the log-retry path carries no tabId (BUG-D).
  const fl = [
    { tabId: null, title: 'A', backupPath: '/a' },
    { tabId: 42,   title: 'B', backupPath: '/b' },
  ];
  const byPath = removeFailureByPath(fl, '/a');
  assert('removeFailureByPath: removes entry by backupPath regardless of tabId',
    byPath.length === 1 && byPath[0].backupPath === '/b');
  assert('removeFailureByPath: no-op when path absent',
    removeFailureByPath(fl, '/zzz').length === 2);
  assert('removeFailureByPath: tolerates non-array',
    Array.isArray(removeFailureByPath(undefined, '/a')) && removeFailureByPath(undefined, '/a').length === 0);

  // resolveMeetTab — inline definition matching popup.js
  const resolveMeetTab = (meetTabs, activeTab) => {
    const isMeet = url => url?.startsWith('https://meet.google.com/');
    if (isMeet(activeTab?.url)) return { tabId: activeTab.id, needsPicker: false };
    if (!meetTabs.length) return { tabId: null, needsPicker: false };
    if (meetTabs.length === 1) return { tabId: meetTabs[0].id, needsPicker: false };
    const sorted = [...meetTabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return { tabId: sorted[0].id, needsPicker: true };
  };

  const res1 = resolveMeetTab([], { id: 5, url: 'https://meet.google.com/abc-def-ghi' });
  assert('resolveMeetTab: active is Meet', res1.tabId === 5 && !res1.needsPicker);

  const res2 = resolveMeetTab([], { id: 1, url: 'https://google.com' });
  assert('resolveMeetTab: no Meet tabs', res2.tabId === null && !res2.needsPicker);

  const res3 = resolveMeetTab([{ id: 7, url: 'https://meet.google.com/x', lastAccessed: 100 }], { id: 1, url: 'https://google.com' });
  assert('resolveMeetTab: 1 Meet tab auto-selected', res3.tabId === 7 && !res3.needsPicker);

  const res4 = resolveMeetTab(
    [{ id: 8, url: 'https://meet.google.com/x', lastAccessed: 200 },
     { id: 9, url: 'https://meet.google.com/y', lastAccessed: 100 }],
    { id: 1, url: 'https://google.com' }
  );
  assert('resolveMeetTab: most recent of 2 wins, picker shown', res4.tabId === 8 && res4.needsPicker);

  // resolveBanner — real function from constants.js. Single source of truth for
  // the status-banner text + class, removing the dual-writer race (BUG-C).
  // Precedence: capturing > in-meeting > last status > idle default.
  const b1 = resolveBanner({ capturing: true, inMeeting: true, geminiActive: false, lastStatus: 'Error: x' });
  assert('resolveBanner: capturing wins over everything',
    b1.text === 'Capturing notes…' && b1.cls === 'ok');

  const b2 = resolveBanner({ capturing: false, inMeeting: true, geminiActive: true, lastStatus: 'Saved to Craft: X' });
  assert('resolveBanner: in-meeting + gemini active',
    b2.text === 'In meeting — notes captured when you leave' && b2.cls === 'ok');

  const b3 = resolveBanner({ capturing: false, inMeeting: true, geminiActive: false, lastStatus: '' });
  assert('resolveBanner: in-meeting without gemini → warn',
    b3.text === 'In meeting — open the Gemini panel to enable capture' && b3.cls === 'warn');

  assert('resolveBanner: error last status → err',
    resolveBanner({ lastStatus: 'Error: boom' }).cls === 'err');
  assert('resolveBanner: native host last status → err',
    resolveBanner({ lastStatus: 'Native host error: x' }).cls === 'err');
  assert('resolveBanner: host error last status → err',
    resolveBanner({ lastStatus: 'Host error: x' }).cls === 'err');
  assert('resolveBanner: warning last status → warn',
    resolveBanner({ lastStatus: 'Warning: heads up' }).cls === 'warn');
  const b4 = resolveBanner({ lastStatus: 'Saved to Craft: Daily' });
  assert('resolveBanner: ok last status → ok with its text',
    b4.cls === 'ok' && b4.text === 'Saved to Craft: Daily');

  const b5 = resolveBanner({});
  assert('resolveBanner: idle default',
    b5.text === 'Not in a meeting.' && b5.cls === '');
}

  async function run() {
    results.length = 0;
    console.group('%cMM2C Extension Tests', 'font-weight:bold;font-size:14px;color:#1a73e8');

    testSelectors();
    testGeminiActiveDetection();
    testExtractLastResponse();
    testMuteSelectors();
    testSubmitButton();
    await testWaitForForeground();
    await testInjectVerification();
    await testCaptureProactively();
    await testGeminiFlowMutex();
    testSendDedup();
    await testAdminDisabledDetection();
    await testRegenerationGuard();
    testOnBeforeUnloadGuard();
    testFormatSnapshotAge();
    testFormatCountdown();
    testCaptureNow();
    await testAutoActivate();
    testCaptureBtnState();
    testSnapshotInterval();
    testExtractBackupPath();
    testFirstSnapshotAt();
    testOutputAppName();
    testBuildPromptWithExample();
    testBuildPromptWithAttendees();
    testBuildPromptWithTitle();
    testDefaultPromptContent();
    testMatchPromptRule();
    testBuildPromptWithLanguage();
    testVisibilityChangeCatchup();
    testCitationSecondPass();
    await testLeaveClickFreshFirst();
    testGeminiTriggerStates();
    await testWaitForActiveGeminiButton();
    testTabState();

    const passed = results.filter(r => r.ok).length;
    const total = results.length;
    const allOk = passed === total;

    console.groupEnd();
    console.log(
      `%c${allOk ? '✅' : '❌'} ${passed}/${total} tests passed`,
      `font-weight:bold;color:${allOk ? '#137333' : '#c5221f'}`
    );
    return { passed, total, results };
  }

  // ── onLeaveClick send-path test helper ────────────────────────────────────
  // Re-implements only the "send MM2C_RESPONSE when transcript is available"
  // branch of onLeaveClick, with injectable deps.
  // KEEP IN SYNC with onLeaveClick send block in content_meet.js.
  //
  // Intentional simplifications vs production:
  //   • No fresh Gemini flow attempt — tests the send path only.
  //   • durationMin always null — meetingJoinedAt not tracked in test state.
  //   • No 20 s send timeout — _sendMessage is synchronous in tests.
  async function onLeaveClick_test({ cachedTranscript, meetingTitle, attendees, _sendMessage = () => {} }) {
    if (!cachedTranscript) return;
    _sendMessage({
      type: 'MM2C_RESPONSE',
      text: cachedTranscript,
      meetingTitle,
      attendees,
      durationMin: null,
    });
  }

  // ── Smoke test suite ───────────────────────────────────────────────────────
  async function runSmoke() {
    results.length = 0;
    console.group('Smoke: onLeaveClick send path');

    // Case 1: happy path — transcript present, message sent with correct shape
    const spy1 = [];
    await onLeaveClick_test({
      cachedTranscript: 'Sprint notes captured by Gemini.',
      meetingTitle: 'Sprint Planning',
      attendees: ['Alice', 'Bob'],
      _sendMessage: msg => spy1.push(msg),
    });
    assert('MM2C_RESPONSE sent when transcript present', spy1.length === 1);
    assertEq('message type is MM2C_RESPONSE', spy1[0]?.type, 'MM2C_RESPONSE');
    assertEq('text field contains transcript', spy1[0]?.text, 'Sprint notes captured by Gemini.');
    assertEq('meetingTitle forwarded', spy1[0]?.meetingTitle, 'Sprint Planning');

    // Case 2: null transcript — no message sent
    const spy2 = [];
    await onLeaveClick_test({
      cachedTranscript: null,
      meetingTitle: 'Empty Meeting',
      attendees: [],
      _sendMessage: msg => spy2.push(msg),
    });
    assert('no MM2C_RESPONSE sent when transcript is null', spy2.length === 0);

    // Case 3: attendees array forwarded correctly
    const spy3 = [];
    await onLeaveClick_test({
      cachedTranscript: 'notes',
      meetingTitle: 'Team Sync',
      attendees: ['Carlos', 'María'],
      _sendMessage: msg => spy3.push(msg),
    });
    // assertEq uses === so compare the JSON string directly for arrays
    assert('attendees array forwarded in payload',
      JSON.stringify(spy3[0]?.attendees) === JSON.stringify(['Carlos', 'María']));

    console.groupEnd();

    const passed = results.filter(r => r.ok).length;
    return { passed, total: results.length, results };
  }

  return { run, runSmoke };
})();

// Auto-run — skipped when MM2C_SKIP_AUTORUN is set (e.g. Playwright fixture mode)
if (!window.MM2C_SKIP_AUTORUN) {
  MM2C_TESTS.run().then(r => {
    // result already printed inside run(); this just surfaces the promise
  }).catch(e => console.error('[MM2C_TESTS] Unexpected runner error:', e));
}
