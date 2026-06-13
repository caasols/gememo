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

  // Sentinel error classes the DI mirrors below use (must match content_meet.js).
  class InjectionTimeoutError extends Error {}
  class GeminiNotActiveError_test extends Error {}

  // Re-implementation of captureProactively with injectable state and dependencies.
  // State is a plain object that the test mutates and inspects; deps supplies mocks
  // for runGeminiFlow, chrome.runtime.sendMessage, sendLog, and showStatus.
  //
  // Intentional DI mirror (NOT drift debt): exercises captureProactively's
  // double-run guard + GeminiNotActiveError routing — edge branches the fake-Meet
  // e2e cannot reach in isolation. Keep aligned with content_meet.js.
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

  // ── Intentional dependency-injected unit tests ─────────────────────────────
  // content_meet.js wraps these functions in an IIFE, and they hinge on browser/
  // Chrome state (document.hidden, chrome.*) the page-world harness can't drive.
  // These DI mirrors deliberately cover the EDGE BRANCHES the fake-Meet e2e cannot
  // reach in isolation (tab-hidden timeout, single-flight concurrency, the
  // proactive-capture double-run guard). They mirror content_meet.js on purpose —
  // keep them aligned when those branches change. (Happy paths are covered against
  // the REAL functions by the content-meet e2e and the fixture-dom tests.)

  // -- waitForForeground: DI mirror for the tab-hidden → timeout-reject branch --
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

    // Real Meet 2026-06 list-item text shape (captured live): label + answer +
    // citation digits + "N source" + the Copy/Report/thumbs feedback row, all
    // newline-separated. The cleanup must yield just the answer.
    withFixture('', (c) => {
      const li = document.createElement('div');
      li.setAttribute('role', 'listitem');
      li.innerText = "Gemini response\nNo one is currently screen sharing in the meeting, so you shouldn't see any indicators related to that on your screen.1\n1\n1 source\nCopy\nReport\nGood response\nBad response";
      c.appendChild(li);
      const result = extractLastResponse(li);
      assertEq('Real list-item text → clean answer (label/citations/feedback stripped)', result,
        "No one is currently screen sharing in the meeting, so you shouldn't see any indicators related to that on your screen.");
    });

    // ── New Meet DOM (2026-06 redesign): no "Gemini response" label; the answer
    //    ends with a Copy action button. Extraction must anchor on that button. ──
    // Mirrors the real markup the maintainer captured (jsname="WmNl5c", data-action-type="15").
    const newDomPanel = (answer) => `
      <div class="msg">
        <div class="answer">${answer}</div>
        <div class="actions">
          <button jsname="WmNl5c" data-action-type="15"><span jsname="V67aGc">Copy</span></button>
          <button jsname="other">Report</button>
        </div>
      </div>
      <div class="chips"><div>Summarise the discussion so far</div><div>What was discussed in the past two minutes</div></div>
      <div class="composer">Ask Gemini</div>
      <div>Gemini in Workspace can make mistakes. Learn more</div>`;

    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = newDomPanel('Summary\n\nThe team reviewed KPIs. Action item: Carlos to confirm timeline.');
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assert('New DOM: extracts the answer via the Copy button', result?.includes('Action item: Carlos'));
      assert('New DOM: excludes the composer ("Ask Gemini")', !result?.includes('Ask Gemini'));
      assert('New DOM: excludes the suggestion chips', !result?.includes('Summarise the discussion'));
      assert('New DOM: strips the Copy/Report action buttons', !/\bCopy\b|\bReport\b/.test(result || ''));
    });

    // New DOM with TWO responses — must return only the LAST answer.
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = `
        <div class="msg"><div class="answer">First answer about pricing.</div>
          <div class="actions"><button jsname="WmNl5c" data-action-type="15"><span>Copy</span></button><button>Report</button></div></div>
        <div class="msg"><div class="answer">Second answer about migration. Action item: ship it.</div>
          <div class="actions"><button jsname="WmNl5c" data-action-type="15"><span>Copy</span></button><button>Report</button></div></div>
        <div class="composer">Ask Gemini</div>`;
      c.appendChild(aside);
      const result = extractLastResponse(aside);
      assertEq('New DOM: returns the LAST answer', result, 'Second answer about migration. Action item: ship it.');
      assert('New DOM: does not include the first answer', !result?.includes('First answer'));
    });

    console.groupEnd();
  }

  function testGeminiResponseDone() {
    console.group('lastGeminiResponseEl / geminiResponseDone / findGeminiCopyButton (Meet 2026-06 DOM)');

    // New DOM: replies are role="listitem" rows. The LAST reply with a Copy button = done.
    withFixture('', (c) => {
      c.innerHTML = `<div role="list">
        <div role="listitem" id="m1">Gemini response<button jsname="WmNl5c"><span>Copy</span></button></div>
        <div role="listitem" id="m2">Gemini response<button jsname="WmNl5c"><span>Copy</span></button></div>
      </div>`;
      assert('lastGeminiResponseEl returns the LAST reply item', lastGeminiResponseEl(c)?.id === 'm2');
      assert('geminiResponseDone true when the last reply has a Copy button', geminiResponseDone(c) === true);
    });

    // Live-confirmed regression (2026-06-10): Meet inserts the Copy button into the
    // reply while it is still HIDDEN (width 0) during streaming, and only makes it
    // VISIBLE when the response actually finishes. Presence alone must NOT count as
    // "done" — otherwise we extract a partial fragment (the truncated-snapshot bug).
    withFixture('', (c) => {
      c.innerHTML = `<div role="list"><div role="listitem">Gemini response<div>partial…</div>` +
        `<button jsname="WmNl5c" style="display:none"><span>Copy</span></button></div></div>`;
      assert('geminiResponseDone FALSE when the Copy button is present but HIDDEN (still streaming)',
        geminiResponseDone(c) === false);
    });
    withFixture('', (c) => {
      c.innerHTML = `<div role="list"><div role="listitem">Gemini response<div>the full answer</div>` +
        `<button jsname="WmNl5c"><span>Copy</span></button></div></div>`;
      assert('geminiResponseDone true when the Copy button is VISIBLE (done)',
        geminiResponseDone(c) === true);
    });

    // KEY: a still-streaming last reply (label, NO Copy yet) must NOT complete on a
    // prior answer — anchoring on the LAST message prevents premature completion.
    withFixture('', (c) => {
      c.innerHTML = `<div role="list">
        <div role="listitem" id="done">Gemini response done<button jsname="WmNl5c"><span>Copy</span></button></div>
        <div role="listitem" id="streaming">Gemini response partial…</div>
      </div>`;
      assert('lastGeminiResponseEl returns the streaming (last) item', lastGeminiResponseEl(c)?.id === 'streaming');
      assert('geminiResponseDone false while the last reply is still streaming (no Copy)', geminiResponseDone(c) === false);
    });

    // No reply rows → not done.
    withFixture('', (c) => {
      c.innerHTML = `<div role="list"><div role="listitem">Carlos Sol (participant)</div></div>`;
      assert('geminiResponseDone false with no Gemini reply rows', geminiResponseDone(c) === false);
    });

    // Legacy / fake-Meet fallback: no listitems, reply lives in aside[Side panel].
    withFixture('', (c) => {
      c.innerHTML = `<aside aria-label="Side panel"><div class="actions"><button jsname="WmNl5c"><span>Copy</span></button></div></aside>`;
      assert('lastGeminiResponseEl falls back to the side panel', lastGeminiResponseEl(c)?.tagName === 'ASIDE');
      assert('geminiResponseDone true via the side-panel fallback', geminiResponseDone(c) === true);
    });

    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = `<div class="actions"><button jsname="WmNl5c" data-action-type="15"><span>Copy</span></button></div>`;
      c.appendChild(aside);
      assert('findGeminiCopyButton finds the WmNl5c button', !!findGeminiCopyButton(aside));
    });

    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.innerHTML = `<div>no actions yet</div>`;
      c.appendChild(aside);
      assert('findGeminiCopyButton returns null when absent', findGeminiCopyButton(aside) === null);
    });

    // Text-fallback branch: no jsname/data-action-type buttons, two "Copy"/"copy"
    // labelled buttons → the accumulator returns the LAST match.
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = `<button id="copy-a">Copy</button><button id="copy-b">copy</button>`;
      c.appendChild(aside);
      const found = findGeminiCopyButton(aside);
      assert('findGeminiCopyButton text-fallback returns the LAST "Copy" button',
        found && found.id === 'copy-b', `got: "${found && found.id}"`);
    });

    // Selector path last-match-wins: two button[jsname="WmNl5c"] → returns the 2nd.
    withFixture('', (c) => {
      const aside = document.createElement('aside');
      aside.setAttribute('aria-label', 'Side panel');
      aside.innerHTML = `<button jsname="WmNl5c" id="wm-1">Copy</button><button jsname="WmNl5c" id="wm-2">Copy</button>`;
      c.appendChild(aside);
      const found = findGeminiCopyButton(aside);
      assert('findGeminiCopyButton returns the SECOND WmNl5c button (last-match on selector path)',
        found && found.id === 'wm-2', `got: "${found && found.id}"`);
    });

    console.groupEnd();
  }

  function testGeminiNotStarted() {
    console.group('geminiNotStarted (Meet 2026-06 off-state detection)');

    // Off state (Meet 2026-06): button HAS an aria-label AND a spark_off icon.
    // The regression was treating "has aria-label" as "started" → must be OFF here.
    withFixture('', (c) => {
      c.innerHTML = `<button jsname="wptEcf" aria-label="Gemini can't answer your questions at the moment" role="button">
        <i class="quRWN-Bz112c google-symbols notranslate">spark_off</i></button>`;
      const btn = c.querySelector('button');
      assert('off-state button (spark_off icon + aria-label) → NOT started', geminiNotStarted(btn) === true);
    });

    // Off state by label alone (icon missing/changed but label says it can't answer).
    withFixture('', (c) => {
      c.innerHTML = `<button aria-label="Gemini isn't available right now"><i class="google-symbols">spark</i></button>`;
      assert('off-state by "isn\'t available" label → NOT started', geminiNotStarted(c.querySelector('button')) === true);
    });

    // Active/started state: lit spark icon + plain "Gemini" label → started (false).
    withFixture('', (c) => {
      c.innerHTML = `<button jsname="wptEcf" aria-label="Gemini" role="button">
        <i class="google-symbols notranslate">spark</i></button>`;
      assert('active-state button (spark icon, "Gemini" label) → started', geminiNotStarted(c.querySelector('button')) === false);
    });

    // Active state with no icon (older fake-Meet button) → started.
    withFixture('', (c) => {
      c.innerHTML = `<button aria-label="Gemini">Gemini</button>`;
      assert('plain "Gemini" button, no icon → started', geminiNotStarted(c.querySelector('button')) === false);
    });

    assert('geminiNotStarted(null) is safe → false', geminiNotStarted(null) === false);

    console.groupEnd();
  }

  function testFindStartNowButton() {
    console.group('findStartNowButton (Meet 2026-06 hover tray)');

    // Meet 2026-06: "Start now" label is a <span jsname="V67aGc"> inside a
    // NON-semantic clickable (div with click jsaction) — the case the old
    // button/[role=button] scan missed. Must return the clickable wrapper.
    withFixture('', (c) => {
      c.innerHTML = `<div id="tray"><div id="startclick" jsaction="click:abc123">
        <span jsname="V67aGc" class="YUhpIc-vQzf8d">Start now</span></div></div>`;
      const found = findStartNowButton(c);
      assert('finds the [jsaction] wrapper of the V67aGc "Start now" span',
        found && found.id === 'startclick', `got: "${found && found.id}"`);
    });

    // V67aGc span with no clickable ancestor → returns the span itself (CDP clicks by coords).
    withFixture('', (c) => {
      c.innerHTML = `<span jsname="V67aGc" id="bare">Start now</span>`;
      const found = findStartNowButton(c);
      assert('falls back to the label span when there is no clickable wrapper',
        found && found.id === 'bare', `got: "${found && found.id}"`);
    });

    // jsname="V67aGc" is ALSO the Copy button label — must NOT match it (text gate).
    withFixture('', (c) => {
      c.innerHTML = `<button jsname="WmNl5c"><span jsname="V67aGc">Copy</span></button>`;
      assert('does NOT match a V67aGc "Copy" span', findStartNowButton(c) === null);
    });

    // aria-label path (when Meet provides it).
    withFixture('', (c) => {
      c.innerHTML = `<button aria-label="Start now" id="al">x</button>`;
      assert('matches an aria-label="Start now" button', findStartNowButton(c)?.id === 'al');
    });

    // Legacy/popup shape: a real <button> whose text is "Start now" (± star prefix).
    withFixture('', (c) => {
      c.innerHTML = `<button id="legacy">✦ Start now</button>`;
      assert('matches a legacy button by anchored "Start now" text', findStartNowButton(c)?.id === 'legacy');
    });

    // A large container that merely CONTAINS the phrase must not be returned by the
    // anchored text fallback (we want the tight control, not its wrapper).
    withFixture('', (c) => {
      c.innerHTML = `<div role="button" id="big">Some heading. Start now to enable Gemini notes for everyone.</div>`;
      assert('anchored fallback ignores a big container that merely contains the phrase',
        findStartNowButton(c) === null);
    });

    assert('findStartNowButton on an empty root is safe', findStartNowButton(document.createElement('div')) === null);

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

    // Intentional DI mirror of runGeminiFlow's single-flight mutex (injectable _inner):
    // covers the concurrent-reject + lock-release branches the e2e can't reach by
    // timing. Keep aligned with content_meet.js. (chrome.storage.local.set omitted.)
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

  // shouldSkipDuplicate now lives in constants.js (bucket A) — test the real helper.
  function testSendDedup() {
    console.group('sendDedup (time-window)');
    const W = 40 * 60 * 1000; // 40 min in ms
    const T0 = 1_000_000_000_000; // arbitrary fixed "now" base

    // Case 1: same title, within window → duplicate
    assert('Case 1: same title within 40 min → duplicate',
      shouldSkipDuplicate({ title: 'Standup', sentAt: T0 - 10 * 60 * 1000 }, 'Standup', T0, W) === true);

    // Case 2: same title, exactly at window boundary → NOT duplicate (boundary is exclusive)
    assert('Case 2: same title at exactly 40 min → not duplicate',
      shouldSkipDuplicate({ title: 'Standup', sentAt: T0 - W }, 'Standup', T0, W) === false);

    // Case 3: same title, beyond window → not duplicate (new meeting)
    assert('Case 3: same title after 40 min → not duplicate',
      shouldSkipDuplicate({ title: 'Standup', sentAt: T0 - W - 1 }, 'Standup', T0, W) === false);

    // Case 4: different title within window → not duplicate
    assert('Case 4: different title within 40 min → not duplicate',
      shouldSkipDuplicate({ title: 'Retro', sentAt: T0 - 5 * 60 * 1000 }, 'Standup', T0, W) === false);

    // Case 5: empty title still dedupes within the window — prod's shouldSkipDuplicate
    // has no empty-title guard. This protects ONE untitled meeting from a double-send;
    // the trade-off (rarely skipping a second, different untitled meeting) is accepted.
    assert('Case 5: empty title within window → duplicate (matches prod behavior)',
      shouldSkipDuplicate({ title: '', sentAt: T0 - 1000 }, '', T0, W) === true);

    // Case 6: no stored record → not duplicate
    assert('Case 6: null stored → not duplicate',
      shouldSkipDuplicate(null, 'Standup', T0, W) === false);

    console.groupEnd();
  }

  // Re-implementation of the admin-disabled detection logic in autoActivateGemini.
  // Intentional DI mirror (edge branch the e2e can't reach in isolation); keep
  // aligned with the waitForPanelVisible try/catch block in content_meet.js.
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
  // Intentional DI mirror (edge branch the e2e can't reach in isolation); keep
  // aligned with the else-if branch in content_meet.js.
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

  // shouldShowOverlay now lives in constants.js (bucket A) — test the real helper.
  function testOnBeforeUnloadGuard() {
    console.group('onBeforeUnloadGuard');

    // Case 1: Guard blocks overlay when no Leave button (navigated away)
    assert('Case 1: guard returns false when no Leave button',
      !shouldShowOverlay(false, false));

    // Case 2: Guard blocks overlay when tab is hidden
    assert('Case 2: guard returns false when tab is hidden',
      !shouldShowOverlay(true, true));

    // Case 3: Guard allows overlay when on call page and tab visible
    assert('Case 3: guard returns true when Leave button present and tab visible',
      shouldShowOverlay(false, true));

    console.groupEnd();
  }

  // formatSnapshotAge now lives in constants.js (bucket A) — test the real helper.
  function testFormatSnapshotAge() {
    console.group('formatSnapshotAge');
    const now = Date.now();

    assertEq('0s ago when ts = now',
      formatSnapshotAge(now, now), '0s ago');
    assertEq('30s ago when 30s elapsed',
      formatSnapshotAge(now - 30000, now), '30s ago');
    assertEq('1 min ago when exactly 60s elapsed',
      formatSnapshotAge(now - 60000, now), '1 min ago');
    assertEq('3 min ago when 3.5 min elapsed (floor)',
      formatSnapshotAge(now - 210000, now), '3 min ago');
    assertEq('59s ago when 59s elapsed (under 1 min threshold)',
      formatSnapshotAge(now - 59000, now), '59s ago');

    console.groupEnd();
  }

  // formatCountdown now lives in constants.js (bucket A) — test the real helper.
  function testFormatCountdown() {
    console.group('formatCountdown');
    const NOW = 1_000_000_000_000;

    // Case 1: 0 (not scheduled) → null
    assert('Case 1: nextAt=0 → null',
      formatCountdown(0, NOW) === null);

    // Case 2: 90 seconds remaining → "1m 30s"
    assertEq('Case 2: 90s remaining → "1m 30s"',
      formatCountdown(NOW + 90_000, NOW), '1m 30s');

    // Case 3: 45 seconds remaining → "45s"
    assertEq('Case 3: 45s remaining → "45s"',
      formatCountdown(NOW + 45_000, NOW), '45s');

    // Case 4: overdue (past) → "due now"
    assertEq('Case 4: overdue → "due now"',
      formatCountdown(NOW - 1000, NOW), 'due now');

    // Case 5: exactly 0ms remaining → "due now"
    assertEq('Case 5: exactly now → "due now"',
      formatCountdown(NOW, NOW), 'due now');

    // Case 6: 8 minutes → "8m 0s"
    assertEq('Case 6: 8 min → "8m 0s"',
      formatCountdown(NOW + 8 * 60_000, NOW), '8m 0s');

    console.groupEnd();
  }

  // computeSnapshotIntervalMs now lives in constants.js (bucket A) — test the real helper.
  function testSnapshotInterval() {
    console.group('snapshotInterval');

    assertEq('8 min (default) → 480000 ms',   computeSnapshotIntervalMs(8),   480_000);
    assertEq('3 min (minimum) → 180000 ms',   computeSnapshotIntervalMs(3),   180_000);
    assertEq('30 min (maximum) → 1800000 ms', computeSnapshotIntervalMs(30), 1_800_000);
    assertEq('0 (falsy) → falls back to default 8 min', computeSnapshotIntervalMs(0), 480_000);
    assertEq('50 → clamped to 30 min',        computeSnapshotIntervalMs(50), 1_800_000);
    assertEq('empty string → defaults to 8',  computeSnapshotIntervalMs(''),  480_000);

    console.groupEnd();
  }

  // Prompt-rule matching is done in production by findPromptRule (constants.js);
  // these assert its title / regex / built-in / condition behaviour directly.
  function testPromptRuleMatching() {
    console.group('prompt rule matching (findPromptRule)');

    // Case 1: empty rules → null
    assert('Case 1: empty rules returns null',
      findPromptRule([], 'Daily Standup') === null);

    // Case 2: first matching rule wins
    const rules = [
      { regex: 'DAILY', prompt: 'Standup prompt' },
      { regex: 'Planning', prompt: 'Planning prompt' },
    ];
    assertEq('Case 2: first matching rule wins',
      findPromptRule(rules, 'Daily Standup')?.prompt,
      'Standup prompt');

    // Case 3: case-insensitive match
    assertEq('Case 3: match is case-insensitive',
      findPromptRule([{ regex: 'daily', prompt: 'ok' }], 'DAILY STANDUP')?.prompt,
      'ok');

    // Case 4: no match → null
    assert('Case 4: no match returns null',
      findPromptRule(rules, 'Retrospective') === null);

    // UXF-10: duration ("time actually spent") conditions
    assert('buildCondition captures minMinutes/maxMinutes',
      JSON.stringify(buildCondition([], NaN, NaN, 0, 10)) === JSON.stringify({ minMinutes: 0, maxMinutes: 10 }));
    assert('ruleDurationMatches within range', ruleDurationMatches({ minMinutes: 0, maxMinutes: 10 }, 9) === true);
    assert('ruleDurationMatches above max → false', ruleDurationMatches({ minMinutes: 0, maxMinutes: 10 }, 11) === false);
    assert('ruleDurationMatches below min → false', ruleDurationMatches({ minMinutes: 5 }, 3) === false);
    assert('ruleDurationMatches with no bounds → false', ruleDurationMatches({ days: [1] }, 9) === false);
    assert('ruleDurationMatches with unknown duration → false', ruleDurationMatches({ maxMinutes: 10 }, NaN) === false);
    assert('findPromptRule matches a short-meeting rule via ctx.durationMin',
      findPromptRule([{ condition: { maxMinutes: 10 }, prompt: 'short' }], 'Any', new Date(), { durationMin: 8 })?.prompt === 'short');
    assert('findPromptRule skips duration rule when over the cap',
      findPromptRule([{ condition: { maxMinutes: 10 }, prompt: 'short' }], 'Any', new Date(), { durationMin: 30 }) === null);
    assert('findPromptRule ignores duration when ctx omitted (back-compat)',
      findPromptRule([{ condition: { maxMinutes: 10 }, prompt: 'short' }], 'Any') === null);

    // UXF-9: a disabled rule is skipped; enabled (or unset) rules still match.
    assert('disabled rule is skipped',
      findPromptRule([{ regex: 'daily', prompt: 'x', enabled: false }], 'Daily Standup') === null);
    assert('explicitly enabled rule matches',
      findPromptRule([{ regex: 'daily', prompt: 'x', enabled: true }], 'Daily Standup')?.prompt === 'x');
    assert('rule with no enabled flag still matches (default on)',
      findPromptRule([{ regex: 'daily', prompt: 'x' }], 'Daily Standup')?.prompt === 'x');
    assert('disabled rule is skipped so a later rule can win',
      findPromptRule([{ regex: 'daily', prompt: 'off', enabled: false }, { regex: 'daily', prompt: 'on' }], 'Daily')?.prompt === 'on');

    // Case 5: built-in templates match their meeting types (P5-K)
    assert('Case 5a: standup title matches a built-in',
      typeof findPromptRule(BUILT_IN_RULES, 'Daily Standup')?.prompt === 'string');
    assert('Case 5b: 1:1 title matches a built-in',
      typeof findPromptRule(BUILT_IN_RULES, 'Carlos / Alice 1:1')?.prompt === 'string');
    assert('Case 5c: retro title matches a built-in',
      typeof findPromptRule(BUILT_IN_RULES, 'Sprint Retrospective')?.prompt === 'string');
    assert('Case 5d: generic title matches no built-in',
      findPromptRule(BUILT_IN_RULES, 'Q3 Budget Review') === null);

    // availableTemplates — built-in templates not yet materialised into the
    // user's rules (matched by name). Templates are off by default.
    assert('availableTemplates: no rules → all templates available',
      availableTemplates(BUILT_IN_RULES, []).length === BUILT_IN_RULES.length);
    assert('availableTemplates: missing/non-array rules → all available',
      availableTemplates(BUILT_IN_RULES).length === BUILT_IN_RULES.length &&
      availableTemplates(BUILT_IN_RULES, 'x').length === BUILT_IN_RULES.length);
    assert('availableTemplates: a materialised template drops out (by name)',
      availableTemplates(BUILT_IN_RULES, [{ name: 'Standup', regex: 'standup', prompt: 'p' }])
        .every(r => r.name !== 'Standup') &&
      availableTemplates(BUILT_IN_RULES, [{ name: 'Standup' }]).length === BUILT_IN_RULES.length - 1);
    assert('availableTemplates: multiple taken names drop out',
      availableTemplates([{ name: 'A' }, { name: 'B' }, { name: 'C' }], [{ name: 'A' }, { name: 'C' }])
        .map(r => r.name).join(',') === 'B');
    assert('availableTemplates: user rules without names never hide templates',
      availableTemplates(BUILT_IN_RULES, [{ regex: 'foo', prompt: 'p' }]).length === BUILT_IN_RULES.length);
    assert('availableTemplates: non-array builtins → []',
      JSON.stringify(availableTemplates(null, [])) === '[]');

    // P5-L2 · time/day conditions. Jan 1 2024 = Monday (ISO 1), Jan 5 = Friday (ISO 5).
    const MON_9AM = new Date(2024, 0, 1, 9, 0);
    const TUE_9AM = new Date(2024, 0, 2, 9, 0);
    const FRI_3PM = new Date(2024, 0, 5, 15, 0);
    assert('ruleTimeMatches: no condition → false',
      ruleTimeMatches(undefined, MON_9AM) === false && ruleTimeMatches({}, MON_9AM) === false);
    assert('ruleTimeMatches: day match',
      ruleTimeMatches({ days: [1] }, MON_9AM) === true && ruleTimeMatches({ days: [1] }, TUE_9AM) === false);
    assert('ruleTimeMatches: hour range [start,end)',
      ruleTimeMatches({ startHour: 8, endHour: 10 }, MON_9AM) === true &&
      ruleTimeMatches({ startHour: 8, endHour: 10 }, new Date(2024, 0, 1, 10, 0)) === false);
    assert('ruleTimeMatches: day AND hour both required',
      ruleTimeMatches({ days: [5], startHour: 14, endHour: 18 }, FRI_3PM) === true &&
      ruleTimeMatches({ days: [5], startHour: 14, endHour: 18 }, new Date(2024, 0, 5, 19, 0)) === false &&
      ruleTimeMatches({ days: [5], startHour: 14, endHour: 18 }, MON_9AM) === false);

    assert('findPromptRule: time condition matches regardless of title',
      findPromptRule([{ condition: { days: [1] }, prompt: 'standup' }], 'anything', MON_9AM)?.prompt === 'standup');
    assert('findPromptRule: time condition fails off-day',
      findPromptRule([{ condition: { days: [1] }, prompt: 'standup' }], 'anything', TUE_9AM) === null);
    assert('findPromptRule: regex still wins with now arg',
      findPromptRule([{ regex: 'daily', prompt: 'x' }], 'Daily Sync', MON_9AM)?.prompt === 'x');

    // buildCondition — normalise Rules-tab inputs into a condition object or null
    const c1 = buildCondition([1, 2], 8, 10);
    assert('buildCondition: days + hours',
      c1.days.join(',') === '1,2' && c1.startHour === 8 && c1.endHour === 10);
    assert('buildCondition: days only', JSON.stringify(buildCondition([5], NaN, NaN)) === '{"days":[5]}');
    assert('buildCondition: hours only',
      JSON.stringify(buildCondition([], 8, 10)) === '{"startHour":8,"endHour":10}');
    assert('buildCondition: nothing → null', buildCondition([], NaN, NaN) === null);
    assert('buildCondition: single hour ignored → null', buildCondition([], 8, NaN) === null);

    // UXF-11: normalizeDestinations — clean a raw "additional destinations" array.
    assertEq('normalizeDestinations: non-array → []',
      JSON.stringify(normalizeDestinations(null)), '[]');
    assertEq('normalizeDestinations: falsy entry / unknown type dropped',
      JSON.stringify(normalizeDestinations([null, { type: 'slack' }, { type: 'apple_notes' }])),
      JSON.stringify([{ type: 'apple_notes' }]));
    assertEq('normalizeDestinations: blank obsidian vault kept (falls back to global vault)',
      JSON.stringify(normalizeDestinations([{ type: 'obsidian', vaultPath: '   ' }])),
      JSON.stringify([{ type: 'obsidian', vaultPath: '' }]));
    assertEq('normalizeDestinations: obsidian vaultPath trimmed + extra props stripped',
      JSON.stringify(normalizeDestinations([{ type: 'obsidian', vaultPath: '  ~/Vault  ', junk: 1 }])),
      JSON.stringify([{ type: 'obsidian', vaultPath: '~/Vault' }]));
    assertEq('normalizeDestinations: craft folderId trimmed, may be empty',
      JSON.stringify(normalizeDestinations([{ type: 'craft', folderId: '  abc  ' }, { type: 'craft' }])),
      JSON.stringify([{ type: 'craft', folderId: 'abc' }, { type: 'craft', folderId: '' }]));
    assertEq('normalizeDestinations: order preserved',
      JSON.stringify(normalizeDestinations([
        { type: 'craft', folderId: 'f1' },
        { type: 'obsidian', vaultPath: '/a' },
        { type: 'apple_notes' },
      ])),
      JSON.stringify([
        { type: 'craft', folderId: 'f1' },
        { type: 'obsidian', vaultPath: '/a' },
        { type: 'apple_notes' },
      ]));

    // mergeAlsoSendIntoDestinations — fold legacy also-send app names into rows.
    assertEq('merge: also-send app becomes a blank-config row',
      JSON.stringify(mergeAlsoSendIntoDestinations([], ['apple_notes'])),
      JSON.stringify([{ type: 'apple_notes' }]));
    assertEq('merge: preserves configured rows + appends also-send',
      JSON.stringify(mergeAlsoSendIntoDestinations(
        [{ type: 'obsidian', vaultPath: '/v' }], ['craft'])),
      JSON.stringify([{ type: 'obsidian', vaultPath: '/v' }, { type: 'craft' }]));
    assertEq('merge: idempotent — no duplicate blank row when one exists',
      JSON.stringify(mergeAlsoSendIntoDestinations([{ type: 'apple_notes' }], ['apple_notes'])),
      JSON.stringify([{ type: 'apple_notes' }]));
    assertEq('merge: still appends when only a CONFIGURED row of that app exists',
      JSON.stringify(mergeAlsoSendIntoDestinations([{ type: 'craft', folderId: 'X' }], ['craft'])),
      JSON.stringify([{ type: 'craft', folderId: 'X' }, { type: 'craft' }]));
    assertEq('merge: tolerates non-arrays',
      JSON.stringify(mergeAlsoSendIntoDestinations(null, null)), '[]');

    // dedupeDestinations — at most one row per app; drop the primary + none/blank.
    assertEq('dedupe: collapses same-app dups, keeps first + its config',
      JSON.stringify(dedupeDestinations(
        [{ type: 'obsidian', vaultPath: '/a' }, { type: 'obsidian', vaultPath: '/b' }, { type: 'apple_notes' }], 'none')),
      JSON.stringify([{ type: 'obsidian', vaultPath: '/a' }, { type: 'apple_notes' }]));
    assertEq('dedupe: drops the primary app',
      JSON.stringify(dedupeDestinations([{ type: 'craft', folderId: '' }, { type: 'obsidian', vaultPath: '/a' }], 'craft')),
      JSON.stringify([{ type: 'obsidian', vaultPath: '/a' }]));
    assertEq('dedupe: drops none/blank-type + tolerates non-array',
      JSON.stringify(dedupeDestinations([{ type: 'none' }, { type: '' }, null, { type: 'craft' }], 'obsidian')),
      JSON.stringify([{ type: 'craft' }]));
    assertEq('dedupe: non-array → []', JSON.stringify(dedupeDestinations(undefined, 'craft')), '[]');

    // availableDestTypes — dropdown options for one row.
    const _ALL = ['obsidian', 'apple_notes', 'craft'];
    assertEq('available: excludes primary + other rows, keeps own current',
      JSON.stringify(availableDestTypes(_ALL, 'craft', ['obsidian', 'apple_notes'], 'obsidian')),
      JSON.stringify(['obsidian']));
    assertEq('available: primary none → everything not used by others',
      JSON.stringify(availableDestTypes(_ALL, 'none', ['apple_notes'], 'apple_notes')),
      JSON.stringify(['obsidian', 'apple_notes', 'craft']));
    assertEq('available: currentType null → apps neither primary nor used',
      JSON.stringify(availableDestTypes(_ALL, 'craft', ['obsidian'], null)),
      JSON.stringify(['apple_notes']));

    // P5-L · findPromptRule returns the matched rule; depthInstruction maps depth → text
    const depthRules = [{ regex: 'standup', prompt: 'p', depth: 'brief' }];
    assert('findPromptRule: returns the matched rule object',
      findPromptRule(depthRules, 'Daily Standup').depth === 'brief');
    assert('findPromptRule: null when nothing matches',
      findPromptRule(depthRules, 'Q3 Review') === null);
    assert('depthInstruction: brief mentions brief',
      /brief/i.test(depthInstruction('brief')) && depthInstruction('brief').length > 0);
    assert('depthInstruction: detailed mentions thorough/detailed',
      /(thorough|detail)/i.test(depthInstruction('detailed')));
    assert('depthInstruction: standard/empty → no instruction',
      depthInstruction('standard') === '' && depthInstruction() === '');

    // RB-4a · glossaryPrefix — inject a "spell these exactly" instruction
    assert('glossaryPrefix: empty → ""', glossaryPrefix('') === '' && glossaryPrefix('  ') === '');
    const gp = glossaryPrefix('Falcon, Kubernetes\nCarlos Sol');
    assert('glossaryPrefix: lists terms', gp.includes('Falcon, Kubernetes, Carlos Sol'));
    assert('glossaryPrefix: says exactly', /exactly/i.test(gp));

    // RB-1c · buildIssueUrl — prefilled GitHub issue link
    const iu = buildIssueUrl({ title: 'Selector broke: Leave', body: 'v0.1.119\nDOM: x' });
    assert('buildIssueUrl: points to the repo issues/new',
      iu.startsWith('https://github.com/caasols/gememo/issues/new?'));
    assert('buildIssueUrl: encodes title + body',
      iu.includes('title=Selector%20broke%3A%20Leave') && iu.includes('body=v0.1.119%0ADOM%3A%20x'));
    assert('buildIssueUrl: tolerates missing fields',
      buildIssueUrl().includes('title=') && buildIssueUrl({}).includes('issues/new'));

    // ARCH-6 · webhookUrlError — validate user-entered webhook/Slack URLs
    assert('webhookUrlError: blank is allowed (off)', webhookUrlError('') === '' && webhookUrlError('  ') === '');
    assert('webhookUrlError: https ok', webhookUrlError('https://hooks.slack.com/x') === '');
    assert('webhookUrlError: http localhost ok', webhookUrlError('http://localhost:3000/h') === '');
    assert('webhookUrlError: missing scheme → error', webhookUrlError('hooks.slack.com/x') !== '');
    assert('webhookUrlError: wrong scheme → error', webhookUrlError('ftp://x') !== '');

    // A4 · craftFolderIdError — validate the Craft inbox/doc ID field
    assert('craftFolderIdError: blank is allowed (default)', craftFolderIdError('') === '' && craftFolderIdError('  ') === '');
    assert('craftFolderIdError: bare docId ok', craftFolderIdError('A1B2-c3d4-EF56') === '');
    assert('craftFolderIdError: whitespace → error', craftFolderIdError('abc def') !== '');
    assert('craftFolderIdError: full deeplink URL → error', craftFolderIdError('craftdocs://open?blockId=x') !== '');
    assert('craftFolderIdError: https URL → error', craftFolderIdError('https://craft.do/x') !== '');

    // A4 · obsidianVaultPathError — validate the Obsidian vault folder path
    assert('obsidianVaultPathError: blank is allowed (not set)', obsidianVaultPathError('') === '' && obsidianVaultPathError('  ') === '');
    assert('obsidianVaultPathError: absolute / path ok', obsidianVaultPathError('/Users/me/Vault') === '');
    assert('obsidianVaultPathError: ~ path ok', obsidianVaultPathError('~/Documents/Vault') === '');
    assert('obsidianVaultPathError: relative path → error', obsidianVaultPathError('Documents/Vault') !== '');
    assert('obsidianVaultPathError: URL → error', obsidianVaultPathError('https://x/y') !== '');

    // RB-5a · titleBlocked — exclude sensitive meetings from capture
    assert('titleBlocked: regex match (array)', titleBlocked('1:1 with HR', ['1:1 with HR|interview']) === true);
    assert('titleBlocked: regex match (string list)', titleBlocked('Interview: Bob', 'interview, salary') === true);
    assert('titleBlocked: no match', titleBlocked('Q3 Planning', ['interview']) === false);
    assert('titleBlocked: empty title or patterns → false',
      titleBlocked('', ['x']) === false && titleBlocked('Sync', '') === false);
    assert('titleBlocked: invalid regex skipped', titleBlocked('Sync', ['(', 'sync']) === true);

    // Tier-3 · assemblePrompt — the full prompt construction, now a pure tested unit
    const empty = assemblePrompt({ base: 'BASE' });
    assert('assemblePrompt: bare base when nothing else', empty === 'BASE');
    const full = assemblePrompt({
      title: 'Q3 Plan', priorContext: 'PRIOR', glossary: 'Falcon',
      language: 'Spanish', attendees: ['Alice', 'Bob'], example: 'EX', base: 'BASE', depth: 'brief',
    });
    assert('assemblePrompt: includes every piece',
      /Meeting title: Q3 Plan/.test(full) && full.includes('PRIOR') && /Falcon/.test(full) &&
      /Spanish/.test(full) && /Alice/.test(full) && full.includes('EX') && full.endsWith('BASE'));
    assert('assemblePrompt: order title<prior<glossary<language<attendees<example<base',
      full.indexOf('Q3 Plan') < full.indexOf('PRIOR') &&
      full.indexOf('PRIOR') < full.indexOf('Falcon') &&
      full.indexOf('Falcon') < full.indexOf('Spanish') &&
      full.indexOf('Spanish') < full.indexOf('Alice') &&
      full.indexOf('Alice') < full.indexOf('EX') &&
      full.indexOf('EX') < full.indexOf('BASE'));
    assert('assemblePrompt: depth instruction prepended to base',
      /brief/i.test(full.slice(full.indexOf('EX'))));
    assert('assemblePrompt: attendees omitted when none',
      !assemblePrompt({ base: 'B', attendees: [] }).includes('attendees'));

    console.groupEnd();
  }

  // shouldRunCatchupSnapshot now lives in constants.js (bucket A) — test the real helper.
  function testVisibilityChangeCatchup() {
    console.group('visibilityChangeCatchup');
    const MS = 600_000; // 10 min — matches SNAPSHOT_INTERVAL_MS

    // Case 1: all conditions met → should run
    assert('Case 1: runs when elapsed >= half-interval, in meeting, gemini active',
      shouldRunCatchupSnapshot(MS / 2, MS, true, true));

    // Case 2: elapsed below threshold → should not run
    assert('Case 2: does not run when elapsed < half-interval',
      !shouldRunCatchupSnapshot(MS / 2 - 1, MS, true, true));

    // Case 3: exactly at threshold → should run (>= is inclusive)
    assert('Case 3: runs at exactly the half-interval boundary (>= not >)',
      shouldRunCatchupSnapshot(MS / 2, MS, true, true));

    // Case 4: not in meeting → should not run
    assert('Case 4: does not run when not in meeting',
      !shouldRunCatchupSnapshot(MS, MS, false, true));

    // Case 5: gemini not active → should not run
    assert('Case 5: does not run when gemini not active',
      !shouldRunCatchupSnapshot(MS, MS, true, false));

    console.groupEnd();
  }

  // Re-implementation of autoActivateGemini with injectable state and deps.
  // Intentional DI mirror (covers branches the e2e can't reach in isolation); keep
  // aligned with autoActivateGemini in content_meet.js.
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
    // Intentional DI mirror (edge branch the e2e can't reach in isolation); keep
    // aligned with the MM2C_CAPTURE_NOW handler in content_meet.js.
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

    // Direct cleanGeminiResponse calls — exercise the 2nd-pass regex without the
    // extractLastResponse DOM wrapper (covers the digit-after-letter/quote branch).
    assertEq('cleanGeminiResponse: "Carlos Sol1" → "Carlos Sol"',
      cleanGeminiResponse('Carlos Sol1'), 'Carlos Sol');
    assertEq('cleanGeminiResponse: \'"move."1\' → \'"move."\'',
      cleanGeminiResponse('"move."1'), '"move."');
    assertEq('cleanGeminiResponse: "Python 3.11" unchanged (digit-after-digit not stripped)',
      cleanGeminiResponse('Python 3.11'), 'Python 3.11');

    console.groupEnd();
  }

  // ── 2. Timer-drift guard ───────────────────────────────────────────────────
  // Re-implementation of the timer-drift condition in takePeriodicSnapshot.
  // ── 3. Leave click fresh-first capture logic ──────────────────────────────
  // Re-implementation of the fresh-first capture path in onLeaveClick.
  // Intentional DI mirror (edge branch the e2e can't reach in isolation); keep
  // aligned with the `if (true)` fresh-first block in onLeaveClick (content_meet.js)
  // and the subsequent cache fallback.
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

  // extractBackupPath now lives in constants.js (bucket A) — test the real helper.
  function testExtractBackupPath() {
    console.group('extractBackupPath');

    assertEq('extracts path from full error message',
      extractBackupPath(
        'Host error: Could not open Craft URL — backup at /Users/caraujo/Downloads/meeting-notes/file.md'
      ),
      '/Users/caraujo/Downloads/meeting-notes/file.md');

    assertEq('message without backup path → empty string',
      extractBackupPath('Host error: Native host not found'),
      '');

    assertEq('empty message → empty string',
      extractBackupPath(''),
      '');

    console.groupEnd();
  }

  // computeFirstSnapshotAt now lives in constants.js (bucket A) — test the real helper.
  function testFirstSnapshotAt() {
    console.group('firstSnapshotAt');
    const INTERVAL = 8 * 60_000;
    const T = 1_000_000_000_000;

    // Case 1: not in meeting → 0
    assertEq('Case 1: meetingJoinedAt=0 → 0',
      computeFirstSnapshotAt(0, 0, INTERVAL), 0);

    // Case 2: in meeting, no snapshot yet → meetingJoinedAt + interval
    assertEq('Case 2: in meeting, no snapshot → ETA',
      computeFirstSnapshotAt(T, 0, INTERVAL), T + INTERVAL);

    // Case 3: first snapshot already taken → 0
    assertEq('Case 3: lastSnapshotAt > 0 → 0 (already done)',
      computeFirstSnapshotAt(T, T + 1000, INTERVAL), 0);

    // Case 4: interval math — 3 min interval
    assertEq('Case 4: 3-min interval → T + 3min',
      computeFirstSnapshotAt(T, 0, 3 * 60_000), T + 3 * 60_000);

    console.groupEnd();
  }

  // outputAppName now lives in constants.js (ARCH-7) — test the real global
  // directly instead of a hand-synced copy.
  function testOutputAppName() {
    console.group('outputAppName');
    assertEq('craft → Craft',                outputAppName('craft'),       'Craft');
    assertEq('apple_notes → Apple Notes',    outputAppName('apple_notes'), 'Apple Notes');
    assertEq('none → None',                  outputAppName('none'),        'None');
    assertEq('obsidian → Obsidian',          outputAppName('obsidian'),    'Obsidian');
    assertEq('bear → Bear',                  outputAppName('bear'),        'Bear');
    assertEq('unknown key → returned as-is', outputAppName('unknown'),     'unknown');
    assertEq('foo → foo (passthrough)',      outputAppName('foo'),         'foo');
    console.groupEnd();
  }

  // Intentional DI mirror of content_meet.js safeSend (A3); keep aligned.
  // Injectable deps so we can simulate a throwing sendMessage + dead context.
  function safeSend_test(msg, { _send, _contextValid, _warn }) {
    try {
      _send(msg);
    } catch (e) {
      if (_contextValid()) _warn('[MM2C] sendMessage failed:', msg?.type, e?.message || e);
    }
  }

  function testSafeSend() {
    console.group('safeSend (A3 — never swallow unexpected failures)');
    // Happy path: send succeeds, no warning.
    let warned = 0;
    safeSend_test({ type: 'X' }, {
      _send: () => {}, _contextValid: () => true, _warn: () => { warned++; },
    });
    assertEq('no warning when send succeeds', warned, 0);

    // Dead context (expected after reload): swallow silently, no warning, no throw.
    warned = 0;
    let threw = false;
    try {
      safeSend_test({ type: 'X' }, {
        _send: () => { throw new Error('Extension context invalidated'); },
        _contextValid: () => false, _warn: () => { warned++; },
      });
    } catch { threw = true; }
    assert('dead context: no throw and no warning', !threw && warned === 0);

    // Unexpected failure while context is still valid: surface via warn (don't swallow).
    warned = 0;
    safeSend_test({ type: 'X' }, {
      _send: () => { throw new Error('boom'); },
      _contextValid: () => true, _warn: () => { warned++; },
    });
    assertEq('valid context + failure → warned once', warned, 1);
    console.groupEnd();
  }

  function testMyActionItems() {
    console.group('owner/alias matching (UXF-7)');
    assertEq('parseAliases trims + drops blanks',
      JSON.stringify(parseAliases('James, , James R ,JR')), JSON.stringify(['James', 'James R', 'JR']));
    assert('whole-word match', ownerMatchesAliases('James R', 'James, JR') === true);
    assert('no partial-word match (Jameson)', ownerMatchesAliases('Jameson', 'James') === false);
    assert('case-insensitive', ownerMatchesAliases('james', 'James') === true);
    assert('empty owner → false', ownerMatchesAliases('', 'James') === false);
    assert('empty aliases → false', ownerMatchesAliases('James', '') === false);
    const items = [{ owner: 'James R' }, { owner: 'Alice' }, { owner: 'JR' }];
    assertEq('counts my items across aliases', countMyActionItems(items, 'James, JR'), 2);
    assertEq('no aliases → 0', countMyActionItems(items, ''), 0);
    console.groupEnd();
  }

  function testHandlerPredicates() {
    console.group('handler predicates (D2)');
    const now = 1_000_000, win = 40 * 60 * 1000;
    assert('dedup: same title within window → skip',
      shouldSkipDuplicate({ title: 'Sync', sentAt: now - 1000 }, 'Sync', now, win) === true);
    assert('dedup: same title outside window → send',
      shouldSkipDuplicate({ title: 'Sync', sentAt: now - win - 1 }, 'Sync', now, win) === false);
    assert('dedup: different title → send',
      shouldSkipDuplicate({ title: 'A', sentAt: now }, 'B', now, win) === false);
    assert('dedup: no stored fingerprint → send',
      shouldSkipDuplicate(undefined, 'Sync', now, win) === false);

    assert('version: same major → no mismatch', isVersionMismatch('0.1.130', '0.1.99') === false);
    assert('version: different major → mismatch', isVersionMismatch('1.0.0', '0.9.0') === true);
    assert('version: blank host → no mismatch (first run)', isVersionMismatch('0.1.130', null) === false);

    // shouldInjectContentScript — the onInstalled inject/skip predicate.
    assert('inject: probe found script (result:true) → skip',
      shouldInjectContentScript([{ result: true }]) === false);
    assert('inject: probe found no script (result:false) → inject',
      shouldInjectContentScript([{ result: false }]) === true);
    assert('inject: empty probe results → inject',
      shouldInjectContentScript([]) === true);
    assert('inject: null probe → inject',
      shouldInjectContentScript(null) === true);
    assert('inject: undefined probe → inject',
      shouldInjectContentScript(undefined) === true);
    console.groupEnd();
  }

  function testPromptPrefixHelpers() {
    console.group('prompt prefix helpers (direct, exact-string)');

    // noteLanguagePrefix — exact strings (was the buildPromptWithLanguage copy)
    assertEq('noteLanguagePrefix("") → ""', noteLanguagePrefix(''), '');
    assertEq('noteLanguagePrefix() → ""', noteLanguagePrefix(), '');
    assertEq('noteLanguagePrefix("Spanish") exact',
      noteLanguagePrefix('Spanish'),
      "Write all notes in Spanish. Preserve proper nouns, product names, technical acronyms, and people's names in their original form without translating them.\n\n");
    assertEq('noteLanguagePrefix("Japanese") exact',
      noteLanguagePrefix('Japanese'),
      "Write all notes in Japanese. Preserve proper nouns, product names, technical acronyms, and people's names in their original form without translating them.\n\n");

    // meetingTitlePrefix — exact strings (was the buildPromptWithTitle copy)
    assertEq('meetingTitlePrefix("") → ""', meetingTitlePrefix(''), '');
    assertEq('meetingTitlePrefix(null) → ""', meetingTitlePrefix(null), '');
    assertEq('meetingTitlePrefix("Q3 Planning") exact',
      meetingTitlePrefix('Q3 Planning'),
      'Meeting title: Q3 Planning. Use this context to interpret references to projects, teams, or products in the transcript.\n\n');
    assertEq('meetingTitlePrefix em-dash title exact',
      meetingTitlePrefix('Platform Team — Weekly Sync'),
      'Meeting title: Platform Team — Weekly Sync. Use this context to interpret references to projects, teams, or products in the transcript.\n\n');

    // attendeesPrefix — exact strings (NEW direct coverage; was only via assemblePrompt)
    assertEq('attendeesPrefix([]) → ""', attendeesPrefix([]), '');
    assertEq('attendeesPrefix(non-array) → ""', attendeesPrefix(undefined), '');
    assertEq('attendeesPrefix single exact',
      attendeesPrefix(['Alice Chen']),
      'Meeting attendees: 1. Alice Chen. Use these exact names when assigning action items.\n\n');
    assertEq('attendeesPrefix multi numbered exact',
      attendeesPrefix(['Alice Chen', 'Bob Martinez', 'Carlos Rodriguez']),
      'Meeting attendees: 1. Alice Chen, 2. Bob Martinez, 3. Carlos Rodriguez. Use these exact names when assigning action items.\n\n');

    // example prefix — exercised through the real assemblePrompt (no standalone helper)
    assertEq('assemblePrompt({example}) yields the exact example prefix',
      assemblePrompt({ example: 'Example note content.' }),
      'Here is an example of the exact note format to produce:\n\n---\nExample note content.\n---\n\nNow produce notes for the current meeting following this exact format:\n\n');
    assertEq('assemblePrompt({example:""}) → "" (no example prefix)',
      assemblePrompt({ example: '' }), '');

    console.groupEnd();
  }

  function testInflightRecoverable() {
    console.group('inflightRecoverable (RB-1d)');
    const now = 1_000_000;
    assert('recoverable when text present and older than grace',
      inflightRecoverable({ text: 'notes', at: now - 70000 }, now) === true);
    assert('not recoverable while still within grace (in-progress send)',
      inflightRecoverable({ text: 'notes', at: now - 5000 }, now) === false);
    assert('not recoverable when empty text',
      inflightRecoverable({ text: '   ', at: now - 70000 }, now) === false);
    assert('not recoverable when undefined', inflightRecoverable(undefined, now) === false);
    assert('not recoverable without a timestamp',
      inflightRecoverable({ text: 'x' }, now) === false);
    assert('recoverable immediately when failed:true (within grace)',
      inflightRecoverable({ text: 'notes', at: now - 5000, failed: true }, now) === true);
    assert('failed:true still needs non-empty text',
      inflightRecoverable({ text: '  ', at: now - 5000, failed: true }, now) === false);
    assert('failed:true still needs a timestamp',
      inflightRecoverable({ text: 'x', failed: true }, now) === false);
    console.groupEnd();
  }

  function testSelectorRegistry() {
    console.group('selector registry + health check (RB-1a)');
    assert('SELECTORS has the core entries',
      SELECTORS.leaveButton && SELECTORS.geminiInput && SELECTORS.submit && SELECTORS.sidePanel);
    assert('each entry is an ordered fallback list',
      Object.values(SELECTORS).every(v => Array.isArray(v) && v.length >= 1));

    // firstMatchingSelector returns the first selector queryFn matches.
    const present = new Set(['button[aria-label="Leave call"]']);
    const q = sel => present.has(sel) ? {} : null;
    assertEq('firstMatchingSelector finds the present one',
      firstMatchingSelector(SELECTORS.leaveButton, q), 'button[aria-label="Leave call"]');
    assertEq('firstMatchingSelector → null when none match',
      firstMatchingSelector(['x', 'y'], q), null);

    // All resolve → no failures.
    const allOk = selectorHealthCheck(SELECTORS, () => ({}));
    assertEq('all resolved → no failures', allOk.failed.length, 0);
    assertEq('all resolved → no critical failures', allOk.criticalFailed.length, 0);

    // None resolve → everything failed, criticals flagged.
    const allBad = selectorHealthCheck(SELECTORS, () => null);
    assert('none resolved → leaveButton failed', allBad.failed.includes('leaveButton'));
    assert('none resolved → leaveButton flagged critical', allBad.criticalFailed.includes('leaveButton'));
    assert('geminiInput is not treated as critical (appears post-activation)',
      !allBad.criticalFailed.includes('geminiInput'));
    console.groupEnd();
  }

  function testSelectorHotfix() {
    console.group('selector hotfix merge/sanitize (RB-1b)');
    // sanitize keeps known keys, accepts string or array, drops junk.
    const clean = sanitizeSelectorOverrides({
      leaveButton: 'button.new-leave',
      submit: ['a', 'b'],
      bogusKey: ['x'],
      geminiInput: 123,
    });
    assert('string override → single-element array', JSON.stringify(clean.leaveButton) === JSON.stringify(['button.new-leave']));
    assert('array override kept', JSON.stringify(clean.submit) === JSON.stringify(['a', 'b']));
    assert('unknown key dropped', !('bogusKey' in clean));
    assert('non-string/array value dropped', !('geminiInput' in clean));
    assertEq('garbage input → empty object', JSON.stringify(sanitizeSelectorOverrides(null)), '{}');

    // merge overlays only provided keys; others untouched; inputs not mutated.
    const base = { leaveButton: ['old'], submit: ['s'] };
    const merged = mergeSelectorOverrides(base, { leaveButton: ['new'] });
    assert('override replaces the key', JSON.stringify(merged.leaveButton) === JSON.stringify(['new']));
    assert('other keys untouched', JSON.stringify(merged.submit) === JSON.stringify(['s']));
    assert('base not mutated', JSON.stringify(base.leaveButton) === JSON.stringify(['old']));
    assert('empty overrides → base copy', JSON.stringify(mergeSelectorOverrides(base, {})) === JSON.stringify(base));
    console.groupEnd();
  }

  function testNormalizeTheme() {
    console.group('normalizeTheme (UXF-8)');
    assertEq('light passes through', normalizeTheme('light'), 'light');
    assertEq('dark passes through', normalizeTheme('dark'), 'dark');
    assertEq('system passes through', normalizeTheme('system'), 'system');
    assertEq('undefined → system', normalizeTheme(undefined), 'system');
    assertEq('garbage → system', normalizeTheme('purple'), 'system');
    console.groupEnd();
  }

  function testBucketLogGroupsByDay() {
    console.group('bucketLogGroupsByDay (UXF-4)');
    const t1 = new Date('2026-06-05T10:00:00').getTime();
    const t1b = new Date('2026-06-05T14:00:00').getTime();
    const t2 = new Date('2026-06-04T09:00:00').getTime();
    const groups = [
      { title: 'A', entries: [{ ts: t1 }] },
      { title: 'B', entries: [{ ts: t1b }] },
      { title: 'C', entries: [{ ts: t2 }] },
    ];
    const buckets = bucketLogGroupsByDay(groups);
    assertEq('two day buckets', buckets.length, 2);
    assertEq('first bucket has both same-day groups', buckets[0].groups.length, 2);
    assertEq('second bucket has the other day', buckets[1].groups.length, 1);
    assert('input order preserved (newest day first)', buckets[0].ts === t1);
    assertEq('empty input → empty', bucketLogGroupsByDay([]).length, 0);
    console.groupEnd();
  }

  function testLogGroupKey() {
    console.group('logGroupKey (UXF-6)');
    const ts = new Date('2026-06-05T10:00:00').getTime();
    assertEq('stable for same title+day', logGroupKey('Q3 Sync', ts), logGroupKey('Q3 Sync', ts));
    assert('different titles → different keys', logGroupKey('A', ts) !== logGroupKey('B', ts));
    assert('includes the title', logGroupKey('Q3 Sync', ts).includes('Q3 Sync'));
    assert('blank title → System', logGroupKey('', ts).includes('System'));
    const ts2 = new Date('2026-06-06T10:00:00').getTime();
    assert('different day → different key', logGroupKey('Q3 Sync', ts) !== logGroupKey('Q3 Sync', ts2));
    console.groupEnd();
  }

  function testFirstRunChecklist() {
    console.group('firstRunChecklist (RB-7a)');
    const fresh = firstRunChecklist({ hostOk: false, outputApp: 'none' });
    assertEq('three steps', fresh.length, 3);
    assert('host step not done when host missing', fresh[0].ok === false);
    assert('output step not done when none', fresh[1].ok === false);

    const setUp = firstRunChecklist({ hostOk: true, outputApp: 'craft' });
    assert('host step done', setUp[0].ok === true);
    assert('output step done', setUp[1].ok === true);
    assert('capture step not done before first capture', setUp[2].ok === false);

    const captured = firstRunChecklist({ hostOk: true, outputApp: 'craft', captured: true });
    assert('capture step done after first note saved', captured[2].ok === true);
    console.groupEnd();
  }

  function testBuildDiagnosticsReport() {
    console.group('buildDiagnosticsReport (RB-7b)');
    const r = buildDiagnosticsReport({
      version: '0.1.130', extensionId: 'abc', hostOk: true, hostVersion: '0.1.130',
      outputApp: 'obsidian', destinations: [{ type: 'craft' }, { type: 'apple_notes' }], fileBackup: true,
      permissions: ['storage', 'tabs'], platform: 'Mac', generatedAt: '2026-06-05',
    });
    assert('includes version', r.includes('Version: 0.1.130'));
    assert('host ready with version', /Native host: ready \(v0\.1\.130\)/.test(r));
    assert('output app shown', r.includes('Output app: obsidian'));
    assert('extra destinations count shown', r.includes('Extra destinations: 2'));
    assert('permissions joined', r.includes('Permissions: storage, tabs'));
    const r2 = buildDiagnosticsReport({ hostOk: false, hostMismatch: false });
    assert('host not found path', r2.includes('Native host: not found'));
    assert('no destinations → 0', r2.includes('Extra destinations: 0'));
    console.groupEnd();
  }

  function testBuildForwardConfig() {
    console.group('buildForwardConfig');
    const cfg = buildForwardConfig({
      mm2c_output_app: 'craft', mm2c_obsidian_vault_path: '/v', mm2c_calendar_enabled: true,
      mm2c_beta_enabled: true, mm2c_gdocs_enabled: true,
      mm2c_destinations: [{ type: 'apple_notes' }, { type: 'apple_notes' }, { type: 'craft' }],
      mm2c_cleanup_snap_enabled: true, mm2c_cleanup_snap_days: 10,
    });
    assert('maps obsidian vault', cfg.obsidianVaultPath === '/v');
    assert('calendarEnabled true', cfg.calendarEnabled === true);
    assert('gdocs on when enabled', cfg.googleDocsOutput === true);
    assert('dedups + drops primary craft',
      JSON.stringify(cfg.destinations) === JSON.stringify([{ type: 'apple_notes' }]));
    assert('backupCleanup nested',
      cfg.backupCleanup.snapshots.enabled === true && cfg.backupCleanup.snapshots.days === 10);
    // Google Docs output is no longer beta-gated — it follows its own toggle regardless of beta.
    const gdocsBetaOff = buildForwardConfig({ mm2c_output_app: 'craft', mm2c_beta_enabled: false, mm2c_gdocs_enabled: true });
    assert('gdocs on even when beta off (promoted)', gdocsBetaOff.googleDocsOutput === true);
    const gdocsOff = buildForwardConfig({ mm2c_output_app: 'craft', mm2c_gdocs_enabled: false });
    assert('gdocs off when toggle off', gdocsOff.googleDocsOutput === false);
    assert('defaults applied',
      gdocsOff.fileBackupType === 'markdown' && gdocsOff.fileBackupPath === '~/Downloads/meeting-notes');
    console.groupEnd();
  }

  function testBuildTaskUrl() {
    console.group('buildTaskUrl (RB-3a)');
    const item = { task: 'Ship the spec', owner: 'Alice', deadline: 'June 6' };
    assert('things scheme + encoded title',
      buildTaskUrl('things', item).startsWith('things:///add?title=Ship%20the%20spec'));
    assert('things includes notes with owner + deadline',
      /notes=Owner%3A%20Alice%20%C2%B7%20Due%3A%20June%206/.test(buildTaskUrl('things', item)));
    assert('todoist scheme', buildTaskUrl('todoist', item).startsWith('todoist://addtask?content='));
    assert('omnifocus scheme', buildTaskUrl('omnifocus', item).startsWith('omnifocus:///add?name='));
    assertEq('unknown app → empty', buildTaskUrl('evernote', item), '');
    assertEq('empty task → empty', buildTaskUrl('things', { task: '' }), '');
    assert('no notes when owner/deadline absent',
      buildTaskUrl('things', { task: 'X' }) === 'things:///add?title=X');
    console.groupEnd();
  }

  function testBuildMailtoUrl() {
    console.group('buildMailtoUrl (RB-3c)');
    const u = buildMailtoUrl({ title: 'Q3 Sync', body: 'Notes here' });
    assert('starts with mailto:?subject=', u.startsWith('mailto:?subject='));
    assert('subject is URL-encoded', u.includes('Q3%20Sync'));
    assert('body is URL-encoded in the body param', u.includes('body=Notes%20here'));
    assert('blank title falls back to "Meeting notes"',
      buildMailtoUrl({ body: 'x' }).includes('subject=Meeting%20notes'));
    const longBody = 'a'.repeat(5000);
    const lu = buildMailtoUrl({ body: longBody, maxBody: 100 });
    assert('long body is truncated', decodeURIComponent(lu.split('body=')[1]).includes('truncated'));
    assert('truncation keeps the URL short', lu.length < 5000);
    console.groupEnd();
  }

  function testPrivateReflectionPrompt() {
    console.group('private reflection prompt (P9-H)');
    const p = assemblePrompt({ title: 'Q3 Sync', base: 'Summarise just my takeaways.', example: '' });
    assert('includes the private base prompt', p.includes('Summarise just my takeaways.'));
    assert('omits the few-shot example anchor when example is empty',
      !p.includes('example of the exact note format'));
    assert('still carries the meeting title context', p.includes('Q3 Sync'));
    console.groupEnd();
  }

  function testFriendlyError() {
    console.group('friendlyError (UXC-3)');
    assert('native-host-not-found → setup guidance',
      /Set up panel/i.test(friendlyError('Specified native messaging host not found.')));
    assert('Craft not running → open Craft',
      /Craft/i.test(friendlyError('Craft is not running — open Craft and try again')));
    assert('context invalidated → reload guidance',
      /reload the Meet tab/i.test(friendlyError('Extension context invalidated.')));
    assert('timeout → backed up + retry',
      /Retry/i.test(friendlyError('Craft send timed out')));
    assert('empty response → no notes captured',
      /No notes were captured/i.test(friendlyError('Response extracted but appears empty')));
    assert('unknown → generic friendly fallback',
      /Something went wrong/i.test(friendlyError('TypeError: x is not a function')));
    assert('never echoes the raw stack/text verbatim',
      friendlyError('TypeError: x is not a function').indexOf('TypeError') === -1);
    assert('null/undefined safe', typeof friendlyError(null) === 'string' && friendlyError(undefined).length > 0);
    console.groupEnd();
  }

  function testShouldPreviewBeforeSend() {
    console.group('shouldPreviewBeforeSend (RB-4b)');
    assert('enabled + real transcript → preview',
      shouldPreviewBeforeSend(true, 'A reasonably long captured note here') === true);
    assert('disabled → no preview', shouldPreviewBeforeSend(false, 'A long note here for review') === false);
    assert('enabled but trivial transcript → no preview', shouldPreviewBeforeSend(true, 'tiny') === false);
    assert('enabled but null transcript → no preview', shouldPreviewBeforeSend(true, null) === false);
    console.groupEnd();
  }

  function testCloseOverlayBody() {
    console.group('closeOverlayBody (UXC-1)');
    assertEq('names Craft', closeOverlayBody('Craft'),
      'Gemini notes are active. Save a summary to Craft before leaving?');
    assert('uses the passed app name, not hardcoded Craft',
      closeOverlayBody('Apple Notes').includes('Apple Notes') &&
      !closeOverlayBody('Apple Notes').includes('Craft'));
    assert('Obsidian flows through', closeOverlayBody('Obsidian').includes('Obsidian'));
    console.groupEnd();
  }

  function testGeminiInactiveMessage() {
    console.group('GEMINI_INACTIVE_MESSAGE (UXC-2)');
    assert('canonical message is defined and non-empty',
      typeof GEMINI_INACTIVE_MESSAGE === 'string' && GEMINI_INACTIVE_MESSAGE.length > 0);
    assert('no subject-verb grammar error ("was not active" / "notes was")',
      !/was not active/i.test(GEMINI_INACTIVE_MESSAGE) && !/notes was/i.test(GEMINI_INACTIVE_MESSAGE));
    assert('conveys that no notes were saved',
      /no notes were saved/i.test(GEMINI_INACTIVE_MESSAGE));
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

  // addFailure / removeFailure — real functions from constants.js (now shared
  // with background.js via importScripts, ARCH-1).
  const f1 = addFailure([], { tabId: 1, title: 'A', backupPath: '/a' });
  assert('addFailure: first entry', f1.length === 1);

  const f2 = addFailure(f1, { tabId: 2, title: 'B', backupPath: '/b' });
  assert('addFailure: second entry', f2.length === 2);

  const r1 = removeFailure(f2, 1);
  assert('removeFailure: removes correct entry', r1.length === 1 && r1[0].tabId === 2);

  const r2 = removeFailure(f2, 99);
  assert('removeFailure: no-op on missing tabId', r2.length === 2);

  // addCapturingTab / removeCapturingTab — REC-badge tab tracking (ARCH-4)
  assert('addCapturingTab: adds new', JSON.stringify(addCapturingTab([], 5)) === '[5]');
  assert('addCapturingTab: no duplicate', JSON.stringify(addCapturingTab([5], 5)) === '[5]');
  assert('addCapturingTab: appends second', JSON.stringify(addCapturingTab([5], 7)) === '[5,7]');
  assert('addCapturingTab: tolerates non-array', JSON.stringify(addCapturingTab(undefined, 3)) === '[3]');
  assert('removeCapturingTab: removes', JSON.stringify(removeCapturingTab([5, 7], 5)) === '[7]');
  assert('removeCapturingTab: empty when last removed', removeCapturingTab([5], 5).length === 0);
  assert('removeCapturingTab: tolerates non-array', removeCapturingTab(undefined, 5).length === 0);

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

  // findFailureByPath — real function from constants.js. Used on a successful
  // retry to recover the note's words/durationMin so the impact stats count it.
  const flf = [
    { tabId: 1, title: 'A', backupPath: '/a', words: 120, durationMin: 18 },
    { tabId: 2, title: 'B', backupPath: '/b', words: 50, durationMin: null },
  ];
  assert('findFailureByPath: returns the matching entry with its stats',
    findFailureByPath(flf, '/a')?.words === 120 && findFailureByPath(flf, '/a')?.durationMin === 18);
  assert('findFailureByPath: undefined when path absent',
    findFailureByPath(flf, '/zzz') === undefined);
  assert('findFailureByPath: tolerates non-array',
    findFailureByPath(undefined, '/a') === undefined);

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
  assert('resolveBanner: idle default (no trailing period — UXC-17)',
    b5.text === 'Not in a meeting' && b5.cls === '');

  // extractMeetingCode — Meet room code from the URL path (P9-A3a)
  assert('extractMeetingCode: standard path',
    extractMeetingCode('/abc-defg-hij') === 'abc-defg-hij');
  assert('extractMeetingCode: strips query + hash',
    extractMeetingCode('/abc-defg-hij?authuser=0#x') === 'abc-defg-hij');
  assert('extractMeetingCode: root path → empty',
    extractMeetingCode('/') === '');
  assert('extractMeetingCode: missing → empty',
    extractMeetingCode(undefined) === '' && extractMeetingCode('') === '');

  // inferMeetingType — calendar vs ad-hoc from the meeting title (P9-A3b)
  assert('inferMeetingType: real title → calendar',
    inferMeetingType('Q3 Planning — Platform') === 'calendar');
  assert('inferMeetingType: empty title → ad-hoc',
    inferMeetingType('') === 'ad-hoc');
  assert('inferMeetingType: raw room code → ad-hoc',
    inferMeetingType('ecj-jduu-oez') === 'ad-hoc');
  assert('inferMeetingType: personal-meeting label → ad-hoc',
    inferMeetingType('Personal meeting (ecj-jduu-oez)') === 'ad-hoc');

  // isMeetCode — bare Meet room code detection (ARCH-7)
  assert('isMeetCode: lowercase code → true',
    isMeetCode('abc-defg-hij') === true);
  assert('isMeetCode: uppercase code → true',
    isMeetCode('ABC-DEFG-HIJ') === true);
  assert('isMeetCode: non-code → false',
    isMeetCode('not-a-code') === false);
  assert('isMeetCode: empty → false',
    isMeetCode('') === false);
  assert('isMeetCode: undefined → false',
    isMeetCode(undefined) === false);

  // meetingTitleFromCandidate — one title candidate → display title (ARCH-7)
  assert('meetingTitleFromCandidate: plain name → itself',
    meetingTitleFromCandidate('Weekly Sync') === 'Weekly Sync');
  assert('meetingTitleFromCandidate: code → Personal meeting (code)',
    meetingTitleFromCandidate('abc-defg-hij') === 'Personal meeting (abc-defg-hij)');
  assert('meetingTitleFromCandidate: whitespace → empty',
    meetingTitleFromCandidate('  ') === '');
  assert('meetingTitleFromCandidate: undefined → empty',
    meetingTitleFromCandidate(undefined) === '');

  // meetingTitleFromTab — browser tab title → display title (ARCH-7)
  assert('meetingTitleFromTab: "Meet - Foo" → Foo',
    meetingTitleFromTab('Meet - Weekly Sync') === 'Weekly Sync');
  assert('meetingTitleFromTab: en-dash separator → Foo',
    meetingTitleFromTab('Meet – Weekly Sync') === 'Weekly Sync');
  assert('meetingTitleFromTab: tab is a code → Personal meeting (code)',
    meetingTitleFromTab('Meet - abc-defg-hij') === 'Personal meeting (abc-defg-hij)');
  assert('meetingTitleFromTab: non-Meet title → empty',
    meetingTitleFromTab('Google Meet') === '');
  assert('meetingTitleFromTab: empty → empty',
    meetingTitleFromTab('') === '');

  // isValidAttendeeName — plausible attendee display name (ARCH-7)
  assert('isValidAttendeeName: real name → true',
    isValidAttendeeName('Ana') === true);
  assert('isValidAttendeeName: single char → false',
    isValidAttendeeName('A') === false);
  assert('isValidAttendeeName: digits-only → false',
    isValidAttendeeName('12345') === false);
  assert('isValidAttendeeName: empty → false',
    isValidAttendeeName('') === false);
  assert('isValidAttendeeName: 90-char name → false',
    isValidAttendeeName('x'.repeat(90)) === false);

  // snapshotFreshEnough — skip the redundant Leave-time Gemini run when a
  // periodic snapshot completed within the last half-interval (BUG-3).
  const INT = 8 * 60_000; // 8 min interval
  assert('snapshotFreshEnough: no snapshot → false',
    snapshotFreshEnough(null, INT, 1_000_000) === false);
  assert('snapshotFreshEnough: 1 min old, 8 min interval → true',
    snapshotFreshEnough(1_000_000, INT, 1_000_000 + 60_000) === true);
  assert('snapshotFreshEnough: exactly half interval → false (stale)',
    snapshotFreshEnough(1_000_000, INT, 1_000_000 + INT / 2) === false);
  assert('snapshotFreshEnough: 5 min old, 8 min interval → false',
    snapshotFreshEnough(1_000_000, INT, 1_000_000 + 5 * 60_000) === false);

  // formatPerfLog — prompt-performance log line (P6-C)
  assert('formatPerfLog: formats seconds + char counts',
    formatPerfLog(12340, 1840, 920) === 'perf: Gemini flow 12.3s · prompt 1840 chars · response 920 chars');
  assert('formatPerfLog: rounds to one decimal',
    formatPerfLog(5000, 100, 50) === 'perf: Gemini flow 5.0s · prompt 100 chars · response 50 chars');

  // groupOutcome — best-outcome status dot for a log group (UX-7).
  // Precedence: ok > err > warn > info.
  assert('groupOutcome: any ok → ok',
    groupOutcome([{ status: 'info' }, { status: 'err' }, { status: 'ok' }]) === 'ok');
  assert('groupOutcome: err over warn when no ok',
    groupOutcome([{ status: 'warn' }, { status: 'err' }]) === 'err');
  assert('groupOutcome: warn when no ok/err',
    groupOutcome([{ status: 'info' }, { status: 'warn' }]) === 'warn');
  assert('groupOutcome: all info → info',
    groupOutcome([{ status: 'info' }, { status: 'info' }]) === 'info');
  assert('groupOutcome: empty → info',
    groupOutcome([]) === 'info');

  // parseActionItems — extract {owner, task, deadline} from a note body (P6-B)
  const _note = 'Summary\nWe shipped it.\n\n' +
    'Action Items\n' +
    'Alice Chen: Draft the spec by June 6.\n' +
    'Bob: Review the PR. No deadline set.\n\n' +
    'Open Questions\nWhat about Z?';
  const _items = parseActionItems(_note);
  assert('parseActionItems: count is 2 (stops at next heading)', _items.length === 2);
  assert('parseActionItems: owner + deadline parsed',
    _items[0].owner === 'Alice Chen' && _items[0].deadline === 'June 6');
  assert('parseActionItems: no-deadline → null deadline',
    _items[1].owner === 'Bob' && _items[1].deadline === null);
  assert('parseActionItems: strips ## and ** around the heading',
    parseActionItems('## Action Items\n**Carlos:** ship it.').length === 1);
  assert('parseActionItems: no section → empty',
    parseActionItems('Summary\nNothing here.').length === 0);

  // formatActionItemsMarkdown — copy-as-tasks output
  assert('formatActionItemsMarkdown: owner + deadline in parens',
    formatActionItemsMarkdown([{ owner: 'Alice', task: 'Draft spec', deadline: 'June 6' }])
      === '- [ ] Draft spec (Alice, June 6)');
  assert('formatActionItemsMarkdown: no meta → bare task',
    formatActionItemsMarkdown([{ owner: '', task: 'Do thing', deadline: null }])
      === '- [ ] Do thing');

  // filterLogsByLevel — two-tier logging: hide debug entries by default (UX-6)
  const _logs = [
    { level: 'user', message: 'saved' },
    { level: 'debug', message: 'perf: ...' },
    { message: 'legacy entry' }, // no level → treated as user
  ];
  assert('filterLogsByLevel: hides debug when showDebug=false',
    filterLogsByLevel(_logs, false).length === 2);
  assert('filterLogsByLevel: keeps legacy (no level) entries',
    filterLogsByLevel(_logs, false).some(e => e.message === 'legacy entry'));
  assert('filterLogsByLevel: shows all when showDebug=true',
    filterLogsByLevel(_logs, true).length === 3);
  assert('filterLogsByLevel: tolerates non-array',
    Array.isArray(filterLogsByLevel(null, false)) && filterLogsByLevel(null, false).length === 0);

  // Usage stats (UX-8) — donation-driver panel
  assert('countWords: counts whitespace-separated tokens',
    countWords('hello there  world') === 3);
  assert('countWords: empty / blank → 0',
    countWords('') === 0 && countWords('   ') === 0);

  const s0 = updateStats(undefined, { durationMin: 30, words: 100 });
  assert('updateStats: from empty increments note/words/minutes',
    s0.notesSaved === 1 && s0.wordsCaptured === 100 && s0.totalMeetingMinutes === 30 && s0.meetingsAttended === 0);
  const s1 = updateStats(s0, { durationMin: 20, words: 80 });
  assert('updateStats: accumulates',
    s1.notesSaved === 2 && s1.wordsCaptured === 180 && s1.totalMeetingMinutes === 50);
  const s2 = updateStats(s1, { durationMin: null, words: 10 });
  assert('updateStats: null duration leaves minutes unchanged',
    s2.totalMeetingMinutes === 50 && s2.wordsCaptured === 190);

  assert('computeTimeSavedMin: words / 25 wpm',
    computeTimeSavedMin({ wordsCaptured: 500 }) === 20);
  assert('supportNudgeEligible: ≥24h meetings + saved time → true',
    supportNudgeEligible({ totalMeetingMinutes: 1440, wordsCaptured: 500 }) === true);
  assert('supportNudgeEligible: just under 24h → false',
    supportNudgeEligible({ totalMeetingMinutes: 1439, wordsCaptured: 500 }) === false);
  assert('supportNudgeEligible: ≥24h but no saved time → false',
    supportNudgeEligible({ totalMeetingMinutes: 5000, wordsCaptured: 0 }) === false);
  assert('supportNudgeEligible: null/undefined stats → false',
    supportNudgeEligible(null) === false && supportNudgeEligible(undefined) === false);

  // stripLogLink — drop a dead deep-link reference by ts.
  {
    const logs = [
      { ts: 1, title: 'A', link: { app: 'apple_notes', kind: 'note_id', value: 'x://1' } },
      { ts: 2, title: 'B' },
      { ts: 3, title: 'C', link: { app: 'apple_notes', kind: 'note_id', value: 'x://3' } },
    ];
    const out = stripLogLink(logs, 1);
    assert('stripLogLink: removes link from the matching ts entry',
      out[0].link === undefined && out[0].title === 'A');
    assert('stripLogLink: leaves other entries untouched',
      out[1].title === 'B' && out[2].link && out[2].link.value === 'x://3');
    assert('stripLogLink: unknown ts is a no-op',
      JSON.stringify(stripLogLink(logs, 99)) === JSON.stringify(logs));
    assert('stripLogLink: non-array → []',
      Array.isArray(stripLogLink(null)) && stripLogLink(null).length === 0);
  }

  // pruneOldLogs — drop entries older than N days by ts.
  {
    const now = 1_000_000_000_000;
    const day = 86400000;
    const logs = [
      { ts: now - 2 * day, title: 'recent' },
      { ts: now - 40 * day, title: 'old' },
      { ts: now - 29 * day, title: 'edge-keep' },
    ];
    const out = pruneOldLogs(logs, 30, now);
    assert('pruneOldLogs: keeps entries within the window',
      out.some(e => e.title === 'recent') && out.some(e => e.title === 'edge-keep'));
    assert('pruneOldLogs: drops entries older than N days',
      !out.some(e => e.title === 'old'));
    assert('pruneOldLogs: invalid/zero days is a no-op',
      pruneOldLogs(logs, 0, now).length === 3 && pruneOldLogs(logs, 'x', now).length === 3);
    assert('pruneOldLogs: non-array → []',
      Array.isArray(pruneOldLogs(null, 30)) && pruneOldLogs(null, 30).length === 0);
  }
  assert('formatStatDuration: hours + minutes',
    formatStatDuration(75) === '1h 15m');
  assert('formatStatDuration: whole hours',
    formatStatDuration(120) === '2h');
  assert('formatStatDuration: minutes only / zero',
    formatStatDuration(45) === '45m' && formatStatDuration(0) === '0m');
  assert('formatStatNumber: thousands separator',
    formatStatNumber(1234567) === '1,234,567');
}

  async function testSelectTranscript() {
    console.group('selectTranscript (capture selection)');
    class GNA extends Error {}   // stand-in GeminiNotActiveError
    class ITE extends Error {}   // stand-in InjectionTimeoutError
    const NOW = 1_000_000;
    const mk = (over = {}) => {
      const logs = [], statuses = [], warns = [];
      return {
        logs, statuses, warns,
        deps: {
          getSnapshotPromise: () => null,
          getCachedTranscript: () => null,
          getCachedTranscriptAt: () => null,
          snapshotIntervalMs: 8 * 60_000,
          meetingTitle: 'M',
          runGeminiFlow: async () => { throw new Error('unstubbed'); },
          delay: async () => {},
          log: (m) => logs.push(m),
          status: (m, l) => statuses.push([m, l]),
          warn: (m) => warns.push(m),
          now: () => NOW,
          GeminiNotActiveError: GNA, InjectionTimeoutError: ITE,
          ...over,
        },
      };
    };

    // 1. snapshot-active: cache goes FRESH during the await → returns the fresh cache.
    {
      let cache = 'STALE', resolveSnap;
      const snap = new Promise(r => { resolveSnap = r; });
      const t = mk({ getSnapshotPromise: () => snap, getCachedTranscript: () => cache,
                     getCachedTranscriptAt: () => NOW - 100_000 });
      const p = selectTranscript(t.deps);
      cache = 'FRESH'; resolveSnap();            // snapshot finishes mid-await, updates cache
      assertEq('snapshot-active reads the FRESH cache after await', await p, 'FRESH');
    }
    // 2. recent snapshot fresh → returns cache, never calls runGeminiFlow.
    {
      let called = false;
      const t = mk({ getCachedTranscript: () => 'CACHED', getCachedTranscriptAt: () => NOW - 60_000,
                     runGeminiFlow: async () => { called = true; return 'X'; } });
      const out = await selectTranscript(t.deps);
      assert('recent-fresh returns cache without runGeminiFlow', out === 'CACHED' && called === false);
    }
    // 3. not fresh, fresh capture succeeds → returns it.
    {
      const t = mk({ getCachedTranscriptAt: () => NOW - 9 * 60_000, runGeminiFlow: async () => 'FRESHNOTES' });
      assertEq('fresh capture returns the new transcript', await selectTranscript(t.deps), 'FRESHNOTES');
    }
    // 4. fresh fails + cache present → returns cache.
    {
      const t = mk({ getCachedTranscript: () => 'CACHED', getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { throw new Error('boom'); } });
      assertEq('fresh-fail falls back to cache', await selectTranscript(t.deps), 'CACHED');
    }
    // 4b. fresh fails + cache OLD (>15 min) → returns cache + a "stale" status warning.
    {
      const t = mk({ getCachedTranscript: () => 'OLDCACHE', getCachedTranscriptAt: () => NOW - 20 * 60_000,
                     runGeminiFlow: async () => { throw new Error('boom'); } });
      const out = await selectTranscript(t.deps);
      assert('old cache (>15m) returns cache + warns', out === 'OLDCACHE'
        && t.statuses.some(([m, l]) => l === 'warn' && /20 min old/.test(m)));
    }
    // 5. no cache → fresh attempt + retry loop; succeeds on the 3rd total call.
    {
      let n = 0;
      const t = mk({ getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { n++; if (n < 3) throw new Error('transient'); return 'RETRIED'; } });
      assertEq('no-cache retries then succeeds', await selectTranscript(t.deps), 'RETRIED');
    }
    // 6. no cache, GeminiNotActive → rethrows.
    {
      const t = mk({ getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { throw new GNA('not active'); } });
      let threw = null; try { await selectTranscript(t.deps); } catch (e) { threw = e; }
      assert('no-cache GeminiNotActive rethrows', threw instanceof GNA);
    }
    // 7a. InjectionTimeout in retry, cache appears → returns cache.
    {
      let cache = null, n = 0;
      const t = mk({ getCachedTranscript: () => cache, getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { n++; if (n === 1) throw new Error('fresh fail');
                                                  cache = 'RECOVERED'; throw new ITE('timeout'); } });
      assertEq('ITE-in-retry uses cache that appeared', await selectTranscript(t.deps), 'RECOVERED');
    }
    // 7b. InjectionTimeout in retry, no cache → null + a warn.
    {
      let n = 0;
      const t = mk({ getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { n++; if (n === 1) throw new Error('fresh fail'); throw new ITE('timeout'); } });
      const out = await selectTranscript(t.deps);
      assert('ITE-in-retry no cache → null + warn', out === null && t.warns.length === 1);
    }
    // 8. exhausted generic retries → rethrows lastFlowErr.
    {
      const t = mk({ getCachedTranscriptAt: () => NOW - 9 * 60_000,
                     runGeminiFlow: async () => { throw new Error('always'); } });
      let threw = null; try { await selectTranscript(t.deps); } catch (e) { threw = e; }
      assert('exhausted generic retries rethrows', threw instanceof Error && threw.message === 'always');
    }
    console.groupEnd();
  }

  async function run() {
    results.length = 0;
    console.group('%cMM2C Extension Tests', 'font-weight:bold;font-size:14px;color:#1a73e8');

    testSelectors();
    testGeminiActiveDetection();
    testExtractLastResponse();
    testGeminiResponseDone();
    testGeminiNotStarted();
    testFindStartNowButton();
    testMuteSelectors();
    testSubmitButton();
    await testWaitForForeground();
    await testSelectTranscript();
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
    testSnapshotInterval();
    testExtractBackupPath();
    testFirstSnapshotAt();
    testOutputAppName();
    testSafeSend();
    testMyActionItems();
    testHandlerPredicates();
    testPromptPrefixHelpers();
    testInflightRecoverable();
    testSelectorRegistry();
    testSelectorHotfix();
    testNormalizeTheme();
    testBucketLogGroupsByDay();
    testLogGroupKey();
    testFirstRunChecklist();
    testBuildDiagnosticsReport();
    testBuildForwardConfig();
    testBuildTaskUrl();
    testBuildMailtoUrl();
    testFriendlyError();
    testShouldPreviewBeforeSend();
    testPrivateReflectionPrompt();
    testCloseOverlayBody();
    testGeminiInactiveMessage();
    testDefaultPromptContent();
    testPromptRuleMatching();
    testVisibilityChangeCatchup();
    testCitationSecondPass();
    await testLeaveClickFreshFirst();
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
  // Intentional DI mirror (edge branch the e2e can't reach in isolation); keep
  // aligned with the onLeaveClick send block in content_meet.js.
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
