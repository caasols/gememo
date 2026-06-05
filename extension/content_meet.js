// content_meet.js — runs on meet.google.com
// Intercepts the Leave call button. Opens the in-meeting Gemini panel,
// injects the summary prompt, waits for streaming to finish, reads the
// response directly from the DOM, then leaves the call.
//
// All selectors verified against live Google Meet on 2026-05-24:
//   Leave button : button[aria-label="Leave call"]
//   Mic mute     : button[aria-label="Turn off microphone"]
//   Camera mute  : button[aria-label="Turn off camera"]
//   Gemini toggle: button[aria-label="Gemini"]
//   Input        : div[aria-label="Ask Gemini"][contenteditable="true"]
//   Submit       : button[aria-label="Submit"]
//   Panel        : aside[aria-label="Side panel"]
//   Response     : panel innerText split on "Gemini response\n", last part
(function () {
  'use strict';

  // Remove any status toast left behind by a previous content script instance
  // (e.g. "Waiting for Gemini…" stuck on screen after an extension reload)
  (() => { const s = document.getElementById('mm2c-status'); if (s) s.remove(); })();

  // Sentinel error — Gemini wasn't active, not a real failure
  class GeminiNotActiveError extends Error {}

  // Sentinel error — tab never returned to foreground during prompt injection
  class InjectionTimeoutError extends Error {}

  let intercepting = false;
  let hooked = null;
  let enabled = false;
  let observer = null;             // main MutationObserver — assigned in storage.get callback, referenced by attachInterceptor
  let observedNode = document.body; // current observation target; narrowed to toolbar once in meeting (shared with attachInterceptor)
  let geminiWasActive = false;     // tracks last known Gemini state for change detection
  let capturedProactively = false;         // true once proactive capture has saved the notes
  let captureProactivelyAttempted = false; // true once a live proactive attempt has started; reset by resetMeetingState()
  let geminiFlowPromise = null;    // Promise while a runGeminiFlow() call is in-flight; null when idle
  let cachedTranscript   = null;   // most recent periodic snapshot (in memory, not yet in Craft)
  let cachedTranscriptAt = null;   // Date.now() timestamp of the last cachedTranscript save
  let currentMeetingTitle = '';    // cached at join time — getMeetingTitle() returns '' after call ends
  let currentMeetingCode  = '';    // Meet room code from the URL path, cached at join (P9-A3a)
  let currentMeetingType  = '';    // 'calendar' | 'ad-hoc', inferred from the title at join (P9-A3b)
  let meetingRecording    = false; // sticky: true if a recording indicator was ever seen (P9-A3c)
  let priorContext        = '';    // prior-session context for recurring meetings, fetched at join (P9-C)
  let meetingBlocked      = false;  // true when the title matches the capture blocklist (RB-5a)
  let panelAutoOpened  = false;    // Gemini panel opened in this meeting; cleared by resetMeetingState()
  let geminiActivating = false;    // true while autoActivateGemini() async call is in-flight
  let meetingJoinedAt      = 0;          // Date.now() when Leave button first appeared; used by snapshot age log
  let snapshotIntervalMs   = 8 * 60_000; // effective snapshot interval; set from storage in .then() callback
  let lastSnapshotAt       = 0;          // Date.now() of most recent snapshot; 0 before first snapshot
  let meetingSnapshotTimer = null;       // setTimeout handle for meeting-anchored snapshot schedule
  let currentOutputApp     = 'craft';    // mirrors mm2c_output_app; updated from storage
  let currentTitleTemplate = '';         // per-rule note-title template, resolved at join (RB-4d)

  // ── Meeting state reset ────────────────────────────────────────────────────
  // Zeros all per-meeting flags. Called from the MutationObserver lifecycle block
  // (see chrome.storage.local.get callback below) when a new meeting starts in a
  // tab that already had a previous meeting (back-to-back calls). NOT called on
  // first join — `meetingEndedAt > 0` guard ensures that.
  //
  // `hooked` and `enabled` are intentionally NOT reset: `hooked` is reused by
  // `attachInterceptor()` if Meet reuses the same Leave button DOM node, and
  // `enabled` is a user preference that survives across meetings.
  //
  // `geminiFlowPromise` is cleared unconditionally. If a flow happens to be
  // running at reset time (back-to-back meetings in the same tab), any
  // onLeaveClick that checks the variable after the reset will see null and
  // skip the await. The flow's finally will still fire and releaseLock()
  // will resolve the old Promise, which is now held only by references
  // inside that flow — no leak. This edge case is benign: resetMeetingState
  // is only called on new-meeting join, by which point the old leave flow
  // has already completed or been force-abandoned.

  function resetMeetingState() {
    intercepting        = false;
    capturedProactively = false;
    panelAutoOpened     = false;
    geminiActivating    = false;
    geminiWasActive     = false;
    geminiFlowPromise   = null;
    cachedTranscript    = null;
    cachedTranscriptAt  = null;
    currentMeetingTitle         = '';
    currentMeetingCode          = '';
    currentMeetingType          = '';
    currentTitleTemplate        = '';
    meetingRecording            = false;
    priorContext                = '';
    meetingBlocked              = false;
    captureProactivelyAttempted = false;
    if (meetingSnapshotTimer) { clearTimeout(meetingSnapshotTimer); meetingSnapshotTimer = null; }
    safeSend({ type: 'MM2C_SET_SNAPSHOT', snapshot: null });
    sendLog('Meeting state reset for new meeting');
  }

  // ── Popup status query ─────────────────────────────────────────────────────
  // The popup asks the content script for live meeting state when it opens.

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'MM2C_STATUS_QUERY') {
      sendResponse({
        inMeeting:       !!getLeaveButton(),
        geminiActive:    isGeminiAvailable(),
        nextSnapshotAt:  lastSnapshotAt > 0 ? lastSnapshotAt + snapshotIntervalMs : 0,
        firstSnapshotAt: meetingJoinedAt > 0 && lastSnapshotAt === 0
          ? meetingJoinedAt + snapshotIntervalMs
          : 0,
      });
    }
    if (msg.type === 'MM2C_CAPTURE_NOW') {
      takePeriodicSnapshot();
      sendResponse({ ok: true });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  chrome.storage.local.get(['mm2c_enabled', 'mm2c_snapshot_interval_min', 'mm2c_output_app', 'mm2c_selector_overrides']).then((data) => {
    enabled = data.mm2c_enabled !== false;
    currentOutputApp = data.mm2c_output_app || 'craft';
    // Apply any remote selector hotfix overrides (RB-1b) over the bundled registry.
    if (typeof SELECTORS !== 'undefined') {
      effectiveSelectors = mergeSelectorOverrides(SELECTORS, data.mm2c_selector_overrides);
    }
    // Reset capture state for a fresh meeting. (The popup reads the tab-keyed
    // mm2c_last_status_<tabId>, written by background.js — there is no global
    // status key to clear here.)
    if (enabled) {
      safeSend({ type: 'MM2C_SET_CAPTURE_STATE', state: 'idle' });
    }
    // ── Meeting lifecycle variables ──────────────────────────────────────────
    // Closure-scoped (not module-level) because they only need to survive across
    // observer firings, not across the entire page lifetime.
    // NOTE: observer and observedNode are declared at module scope (above) so
    // that attachInterceptor() — a hoisted function at IIFE scope — can reference
    // them. The remaining vars below are only needed inside this callback.
    let wasInMeeting        = false; // true while Leave button is present
    let meetingEndedAt      = 0;     // Date.now() of last Leave-button disappearance; 0 = never left
    observedNode            = document.body; // reset to body on each storage.get (extension reload)
    let attachDebounceTimer = null;          // debounce handle for attachInterceptor calls from observer

    observer = new MutationObserver(() => {
      // ── Observer target health check ─────────────────────────────────────
      // If Meet replaced the toolbar container mid-meeting (e.g. network reconnect),
      // the narrowed target is now detached. Fall back to document.body so we can
      // re-detect the toolbar when it reappears.
      if (observedNode !== document.body && !observedNode.isConnected) {
        observer.disconnect();
        observer.observe(document.body, { childList: true, subtree: true });
        observedNode = document.body;
      }

      // ── Meeting lifecycle tracking ───────────────────────────────────────
      // Detect Leave-button appearance / disappearance to reset state between
      // consecutive meetings in the same tab.
      const inMeeting = !!getLeaveButton();
      if (wasInMeeting && !inMeeting) {
        // Just left a meeting
        wasInMeeting   = false;
        meetingEndedAt = Date.now();
      } else if (!wasInMeeting && inMeeting) {
        // Joined a meeting (or page loaded mid-meeting)
        wasInMeeting = true;
        if (meetingEndedAt > 0) {
          // Second or subsequent meeting in this tab — reset all per-meeting state
          resetMeetingState();
        }
      }

      // Debounce attachInterceptor — the Leave button rarely changes; no need to
      // re-query and potentially re-hook on every mutation burst.
      clearTimeout(attachDebounceTimer);
      attachDebounceTimer = setTimeout(attachInterceptor, 200);
      // Detect Gemini becoming active or going inactive while in a meeting.
      // Guard: check Leave button first, BUT also allow through when geminiWasActive
      // is true. When a meeting auto-ends ("everyone left"), Meet removes the Leave
      // button BEFORE the Gemini toolbar disappears, so without the `|| geminiWasActive`
      // branch the observer would silently skip the deactivation event and never save.
      if (getLeaveButton() || geminiWasActive) {
        const geminiNow = isGeminiAvailable();
        if (geminiNow !== geminiWasActive) {
          geminiWasActive = geminiNow;
          if (geminiNow) {
            sendLog('Gemini notes became active');
            // Gemini button just appeared — auto-open the panel if we haven't yet
            autoActivateGemini();
          } else {
            // Gemini deactivated — start proactive capture immediately so we get the
            // notes before the panel disappears (covers both manual and auto-ended calls).
            captureProactively(currentMeetingTitle || getMeetingTitle());
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    attachInterceptor();

    // Snapshot interval — read from storage; scheduling starts when meeting joins
    // (see attachInterceptor → scheduleMeetingSnapshot).
    const rawIntervalMin = parseInt(data.mm2c_snapshot_interval_min || '8', 10) || 8;
    const SNAPSHOT_INTERVAL_MS = Math.max(3, Math.min(30, rawIntervalMin)) * 60 * 1000;
    snapshotIntervalMs = SNAPSHOT_INTERVAL_MS;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // Tab just became visible — run a catch-up snapshot if the last one
      // was skipped or too long ago (more than half the interval).
      const elapsed = Date.now() - lastSnapshotAt;
      if (elapsed >= SNAPSHOT_INTERVAL_MS / 2 && getLeaveButton() && isGeminiAvailable()) {
        sendLog('Tab active again — running catch-up snapshot');
        lastSnapshotAt = Date.now();
        takePeriodicSnapshot();
      }
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ('mm2c_enabled' in changes) {
      enabled = changes.mm2c_enabled.newValue !== false;
      if (enabled) {
        attachInterceptor();
      } else if (hooked) {
        hooked.removeEventListener('click', onLeaveClick, true);
        hooked = null;
      }
    }
    if ('mm2c_output_app' in changes) {
      currentOutputApp = changes.mm2c_output_app.newValue || 'craft';
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Resolves immediately when the tab is already active (document.hidden === false).
  // If the tab is hidden, attaches a visibilitychange listener and resolves the next
  // time the tab comes to the foreground. Rejects with InjectionTimeoutError if
  // timeoutMs elapses before the tab becomes active.
  //
  // timeoutMs should be the REMAINING time in the enclosing flow (e.g.
  // deadline - Date.now()), making this a persistent monitor for the full
  // flow window rather than a short fixed wait.
  function waitForForeground(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!document.hidden) return resolve();
      sendLog('Tab not active — waiting to return before injecting prompt...');
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
        // Future PiP hook: log if a Picture-in-Picture window is active so we
        // can investigate whether Meet's PiP exposes the Gemini input.
        if (document.pictureInPictureElement) {
          sendLog('PiP window active during injection timeout — future: investigate Gemini panel access in PiP context');
        }
        cleanup();
        reject(new InjectionTimeoutError('Tab did not become active within the flow deadline'));
      }, timeoutMs);
    });
  }

  // Effective selector registry (RB-1a) = bundled SELECTORS overlaid with any
  // remote hotfix overrides (RB-1b), loaded from storage at startup. Defaults to
  // the bundled set so the linchpin selectors work before overrides load.
  let effectiveSelectors = (typeof SELECTORS !== 'undefined') ? SELECTORS : {};
  function firstSel(name, fallback) {
    const list = effectiveSelectors[name];
    return (Array.isArray(list) && list[0]) ? list[0] : fallback;
  }

  function getLeaveButton() {
    return document.querySelector(firstSel('leaveButton', 'button[aria-label="Leave call"]'));
  }

  // Returns the "Start now" button that Meet shows when Gemini has not been
  // activated yet for this call (e.g. you joined alone before others arrived).
  // Clicking it begins the recording session; without it the Gemini panel opens
  // but stays in "Find information" / no-transcript mode.
  //
  // Try aria-label first (reliable when present), then fall back to text-content
  // matching so the selector survives Meet UI variations.
  function getGeminiStartNowButton() {
    const byLabel = document.querySelector(
      'button[aria-label*="Start now" i], button[aria-label*="start gemini" i]'
    );
    if (byLabel) return byLabel;
    // Also check role=button elements (Meet uses DIVs for some controls).
    // Use a contains-match rather than exact-match so the star emoji prefix
    // ("⭐ Start now") in the Ask Gemini popup doesn't break detection.
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      if (/start now/i.test(btn.textContent.trim())) return btn;
    }
    return null;
  }

  // Returns the element that opens/toggles the Ask Gemini panel.
  // Meet shows different UI entry points depending on state (confirmed 2026-05-30):
  //
  //   1. <button aria-label*="Gemini"> — older Meet versions (aria-label present)
  //   2. DIV[role="button"] text "Gemini<icon>" (e.g. "Geminispark_off") — newer
  //      Meet, no aria-label. This is the star/spark toggle in the toolbar.
  //      Clicking it opens the Ask Gemini popup or the panel directly.
  //   3. DIV[role="button"] text "Take notes with Gemini<icon>" — a DIFFERENT
  //      feature (AI-generated notes, not the Ask Gemini chat). Clicking it has no
  //      effect on the Ask Gemini panel. Used only as a last-resort fallback.
  //
  // NOTE: "Start now" in the popup that appears after clicking (2) is rendered
  // inside a cross-origin iframe and cannot be clicked programmatically. The
  // extension handles this gracefully — see autoActivateGemini().
  function getGeminiTriggerElement() {
    // 1. aria-label match (older Meet / future-proofing)
    const starBtn = document.querySelector('button[aria-label*="Gemini" i], [role="button"][aria-label*="Gemini" i]');
    if (starBtn) return starBtn;
    // 2. Gemini star/spark toolbar button (text starts with "Gemini", NOT "Take notes")
    for (const el of document.querySelectorAll('[role="button"]')) {
      const t = el.textContent.trim();
      if (/^Gemini/i.test(t) && !/take notes/i.test(t)) return el;
    }
    // 3. "Take notes with Gemini" fallback
    for (const el of document.querySelectorAll('[role="button"]')) {
      if (/take notes with gemini/i.test(el.textContent)) return el;
    }
    return null;
  }

  // Meet keeps panel DOM alive even when the panel is "closed" (slides
  // off-screen). querySelector finds the input even when invisible, so we must
  // check the rendered position. Used by both _runGeminiFlowInner and
  // autoActivateGemini — must be defined at IIFE scope, not inside either fn.
  function isInViewport(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      && r.left < window.innerWidth && r.top < window.innerHeight;
  }

  // ── Mute ───────────────────────────────────────────────────────────────────
  // Exact label match only — a wildcard fallback could accidentally unmute.

  function muteAll() {
    const mic = document.querySelector('button[aria-label="Turn off microphone"]');
    if (mic) mic.click();
    const cam = document.querySelector('button[aria-label="Turn off camera"]');
    if (cam) cam.click();
  }

  // ── Response extraction ────────────────────────────────────────────────────
  // The Gemini panel's innerText contains "Gemini response\n" before each model
  // reply. We split on that label and take the last segment, then strip UI chrome.

  function extractLastResponse() {
    return extractLastResponseFromEl(
      document.querySelector('aside[aria-label="Side panel"]'));
  }

  // ── Wait for response to finish streaming ──────────────────────────────────
  // Resolves when the extracted Gemini response has been unchanged for 3 s
  // wall-clock and is non-trivially long (> 10 chars).
  //
  // Uses a MutationObserver (never throttled by Chrome in background tabs) as the
  // primary trigger, with a 2-second setTimeout fallback for the case where
  // mutations stop arriving after streaming ends. The old pure-setTimeout approach
  // failed because Chrome throttles timers in hidden tabs to ≥1 s/call and can
  // clamp them to 60 s/call after 5+ minutes of inactivity, turning a 3-second
  // stability window into an 8-minute wait.
  //
  // Wall-clock stability (3 s since last change) replaces the old count-based
  // approach (3 consecutive equal checks). A single trailing formatting token no
  // longer resets the entire count; it just shifts the 3 s window forward.

  function waitForResponseComplete(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const aside = document.querySelector('aside[aria-label="Side panel"]');
      if (!aside) return reject(new Error('Gemini side panel not found'));

      const deadline = Date.now() + timeoutMs;
      let lastText = '';
      let lastChangeAt = 0; // wall-clock time of the last content change (0 = not yet seen)
      let done = false;

      const finish = (err) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(deadlineTimer);
        clearTimeout(fallbackTimer);
        err ? reject(err) : resolve();
      };

      const check = () => {
        if (done) return;
        if (Date.now() > deadline) {
          return finish(new Error('Timed out waiting for Gemini response'));
        }
        const current = extractLastResponse() || '';

        // Placeholder text while Gemini is still gathering context
        if (!current || current.includes('Collecting info') || current.includes('Thinking')) {
          lastText = '';
          lastChangeAt = 0;
          return;
        }

        // Wall-clock stability: resolve once the response hasn't changed for 3 s.
        // Avoids the staleCount cascade: a single trailing token no longer forces
        // 3 more full check cycles. The 3 s window is short enough to feel instant
        // but long enough to let Gemini finish any final formatting pass.
        if (current !== lastText) {
          lastText = current;
          lastChangeAt = Date.now();
        } else if (lastChangeAt > 0 && current.length > 10 && Date.now() - lastChangeAt >= 3000) {
          // Before resolving, check Gemini isn't still regenerating.
          // The Stop button is visible whenever Gemini is actively streaming a response.
          if (aside.querySelector('button[aria-label*="Stop"]')) {
            lastChangeAt = 0; // reset stability clock — regeneration in progress
            return;
          }
          finish(); // response stable for ≥ 3 s and no Stop button visible
        }
      };

      // MutationObserver fires on every streaming token — not timer-throttled
      const observer = new MutationObserver(check);
      observer.observe(aside, { childList: true, subtree: true, characterData: true });

      // Fallback: poll every 2 s in case mutations stop after streaming ends.
      // In heavily throttled tabs Chrome clamps this to ~1 s/call — acceptable.
      let fallbackTimer;
      const scheduleFallback = () => {
        fallbackTimer = setTimeout(() => { check(); if (!done) scheduleFallback(); }, 2000);
      };
      scheduleFallback();

      // Hard wall-clock deadline (Date.now()-based, not timer-fire-based)
      const deadlineTimer = setTimeout(() => {
        finish(new Error('Timed out waiting for Gemini response'));
      }, timeoutMs);

      // Immediate check in case the response is already complete
      check();
    });
  }

  // Resolves with the Gemini input element the moment it enters the viewport.
  // Meet always keeps div[aria-label="Ask Gemini"] in the DOM even when the
  // panel is closed — it is just sized/positioned off-screen. IntersectionObserver
  // fires when the panel slides in, without relying on setTimeout (not throttled).
  // Rejects with an Error on hard timeout; caller sets input = null and falls
  // through to the existing diagnostic logging block.
  function waitForPanelVisible(timeoutMs) {
    const SELECTOR = 'div[aria-label="Ask Gemini"][contenteditable="true"]';
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (result, err) => {
        if (done) return;
        done = true;
        clearTimeout(deadlineTimer);
        err ? reject(err) : resolve(result);
      };

      const deadlineTimer = setTimeout(
        () => finish(null, new Error('Gemini panel did not become visible within timeout')),
        timeoutMs
      );

      function setupViewportWait(input) {
        if (isInViewport(input)) { finish(input, null); return; }
        const intObs = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) { intObs.disconnect(); finish(input, null); }
        }, { threshold: 0 });
        intObs.observe(input);
      }

      // If input already in DOM, go straight to viewport wait.
      const existing = document.querySelector(SELECTOR);
      if (existing) { setupViewportWait(existing); return; }

      // Input not in DOM yet (Gemini not started). Use MutationObserver to wait
      // for it to appear (e.g. user clicks "Start now" in the popup, or Gemini
      // auto-starts when another participant joins). Once it appears, hand off
      // to the IntersectionObserver for the viewport check.
      const mutObs = new MutationObserver(() => {
        const input = document.querySelector(SELECTOR);
        if (input) { mutObs.disconnect(); setupViewportWait(input); }
      });
      mutObs.observe(document.body, { childList: true, subtree: true });

    });
  }

  // Resolves when the Submit button's `disabled` attribute is removed, or when
  // the timeout fires (caller checks submit.disabled and logs accordingly).
  // Never rejects — mirrors the semantics of the old polling loop.
  function waitForSubmitEnabled(submit, timeoutMs) {
    return new Promise((resolve) => {
      if (!submit.disabled) return resolve();

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(deadlineTimer);
        resolve();
      };

      const observer = new MutationObserver(() => {
        if (!submit.disabled) finish();
      });
      observer.observe(submit, { attributes: true, attributeFilter: ['disabled'] });

      const deadlineTimer = setTimeout(finish, timeoutMs);
    });
  }

  // Generic observe→check→timeout→disconnect helper (ARCH-5). Resolves with the
  // first truthy result of check() — immediately if already truthy, otherwise as
  // soon as a mutation on `target` makes it truthy — or with null on timeout.
  // The three appearance waiters below are thin wrappers; the bespoke waiters
  // (response-complete, panel-visible, foreground) keep their own logic.
  function waitForCondition(check, timeoutMs, target = document.body,
                            observeOptions = { childList: true, subtree: true }) {
    return new Promise((resolve) => {
      const immediate = check();
      if (immediate) return resolve(immediate);
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(deadlineTimer);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        const r = check();
        if (r) finish(r);
      });
      observer.observe(target, observeOptions);
      const deadlineTimer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // Resolves with the Gemini trigger element as soon as it appears in the DOM,
  // or with null after timeoutMs (ARCH-5: wraps waitForCondition).
  function waitForGeminiTrigger(timeoutMs) {
    return waitForCondition(getGeminiTriggerElement, timeoutMs);
  }

  // Resolves with the "Start now" button as soon as it appears, or null after
  // timeoutMs (null is the normal case — Gemini was already active).
  function waitForStartNowButton(timeoutMs) {
    return waitForCondition(getGeminiStartNowButton, timeoutMs);
  }

  // Injects `prompt` into the Gemini contenteditable input.
  //
  // Two injection paths:
  //   Path A — execCommand (preferred): selectAll → delete → insertText.
  //     Works when the tab has real keyboard focus. Fires browser-trusted events
  //     that Meet's framework handles natively.
  //   Path B — direct textContent (fallback): sets textContent directly and
  //     dispatches a synthetic InputEvent. Used when execCommand silently no-ops
  //     despite the tab being in the foreground (trusted-focus restriction in
  //     newer Chrome builds).
  //
  // Verification note: we check el.textContent.trim() != '' rather than
  // startsWith(prompt.slice(0,80)). After execCommand('insertText') the browser
  // converts \n characters to <div>/<br> block elements; textContent strips those
  // back to nothing, so a startsWith check on a prompt containing \n\n always
  // fails even when the injection succeeded.
  //
  // Throws InjectionTimeoutError if both paths leave the input empty.
  async function injectPromptWithVerification(input, prompt, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new InjectionTimeoutError('Deadline passed before injection');

    // Block until the tab is in the foreground — execCommand requires focus.
    await waitForForeground(remaining);

    // Re-fetch the live node — the reference passed in may be stale if Meet
    // re-rendered the panel between when _runGeminiFlowInner grabbed it and now.
    const el = document.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]') || input;

    el.focus();

    // ── Path A: execCommand ──────────────────────────────────────────────────
    // All three calls run synchronously — yielding between them gives Meet's
    // framework time to re-render and can make the stale reference no-op.
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, prompt);
    // Fire an explicit InputEvent so Meet's components update their internal state.
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false }));

    if (el.textContent.trim()) {
      sendLog(`Prompt injected via execCommand (${prompt.length} chars)`);
      return;
    }

    // ── Path B: direct textContent ───────────────────────────────────────────
    // Reached only when execCommand produced an empty result (silent no-op).
    sendLog(`execCommand injection empty — falling back to direct textContent ` +
            `(tab ${document.hidden ? 'hidden' : 'visible'})`);
    el.textContent = prompt;
    // Move cursor to end so Meet treats this as a normal typing state.
    try {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* selection API may fail in edge cases — non-fatal */ }
    // Dispatch events that Meet's Lit components observe.
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText',
      data: prompt.slice(0, 200), // `data` only needs to be truthy — actual text is in el
    }));

    if (!el.textContent.trim()) {
      sendLog('Both injection paths failed — input still empty');
      throw new InjectionTimeoutError(
        'Failed to inject prompt — both execCommand and direct textContent left the input empty');
    }
    sendLog(`Prompt injected via direct textContent (${prompt.length} chars)`);
  }

  // ── Gemini panel flow ──────────────────────────────────────────────────────

  async function runGeminiFlow(timeoutMs = 120000) {
    if (geminiFlowPromise) throw new Error('Another Gemini capture is already running');
    let releaseLock;
    geminiFlowPromise = new Promise(resolve => { releaseLock = resolve; });
    safeSend({ type: 'MM2C_SET_CAPTURE_STATE', state: 'capturing' });
    try {
      return await _runGeminiFlowInner(timeoutMs);
    } finally {
      releaseLock();            // unblocks any onLeaveClick awaiting this promise
      geminiFlowPromise = null; // null so guard check passes for the next caller
      safeSend({ type: 'MM2C_SET_CAPTURE_STATE', state: 'idle' });
    }
  }

  async function _runGeminiFlowInner(timeoutMs = 120000) {
    const { mm2c_prompt, mm2c_note_language, mm2c_prompt_rules, mm2c_glossary } = isContextValid()
      ? await chrome.storage.local.get(['mm2c_prompt', 'mm2c_note_language', 'mm2c_prompt_rules', 'mm2c_glossary'])
      : {};
    const promptBase = mm2c_prompt?.trim() || DEFAULT_PROMPT;

    // Rule matching: user rules win first, then built-in templates, then default.
    const rules = Array.isArray(mm2c_prompt_rules) ? mm2c_prompt_rules : [];
    const durMin = meetingJoinedAt > 0 ? Math.round((Date.now() - meetingJoinedAt) / 60_000) : NaN;
    const matchedRule =
      findPromptRule(rules, currentMeetingTitle, new Date(), { durationMin: durMin }) ||
      findPromptRule(BUILT_IN_RULES, currentMeetingTitle);

    // Full prompt construction lives in the (unit-tested) assemblePrompt helper.
    const prompt = assemblePrompt({
      title:       currentMeetingTitle,
      priorContext,                                  // recurring-meeting context (P9-C)
      glossary:    mm2c_glossary,                     // custom vocabulary (RB-4a)
      language:    mm2c_note_language,
      attendees:   getAttendeeNames(),
      example:     EXAMPLE_NOTES,
      base:        matchedRule?.prompt?.trim() || promptBase,
      depth:       matchedRule?.depth,
    });

    // Helper: returns true only when an element is rendered inside the viewport.
    // 1. Find the Gemini toolbar button first — if it's gone, Gemini isn't active.
    const geminiBtn = document.querySelector('button[aria-label*="Gemini" i]');
    if (!geminiBtn) throw new GeminiNotActiveError('Gemini notes were not active in this meeting');

    // 2. Open Gemini panel if it isn't visible in the viewport.
    //    Do NOT rely on querySelector alone — the panel DOM persists off-screen.
    let input = document.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');

    if (!isInViewport(input)) {
      // Panel is closed or off-screen — click the toolbar button to slide it in.
      const btnLabel = geminiBtn.getAttribute('aria-label');
      sendLog(`Opening Gemini panel (button: "${btnLabel}")...`);
      geminiBtn.click();

      // Wait (observer-based, not timer-throttled) for the panel input to enter
      // the viewport. Rejects on timeout — catch sets input = null so the
      // diagnostic block below runs exactly as before.
      try { input = await waitForPanelVisible(4000); }
      catch { input = null; }

      // Diagnostic: if still not visible, log panel state for debugging.
      if (!input) {
        const aside = document.querySelector('aside[aria-label="Side panel"]');
        const panelText = aside?.innerText?.slice(0, 200).trim().replace(/\n+/g, ' ') || '(empty)';
        const editables = [...document.querySelectorAll('[contenteditable="true"]')]
          .map(el => `"${el.getAttribute('aria-label') || el.tagName}"`)
          .join(', ') || 'none';
        sendLog(`Panel not ready — aside: ${!!aside}, editables: [${editables}], panel text: "${panelText}"`);
      }
    } else {
      sendLog('Gemini panel already open');
    }

    // 3. If the input still isn't in the viewport, Gemini was never started.
    if (!input) {
      throw new GeminiNotActiveError(
        "Gemini wasn't active during this meeting. " +
        'Start Gemini at the beginning of your next meeting to get a summary.'
      );
    }

    // 4. Inject prompt (verified + retry)
    // execCommand('delete') and execCommand('insertText') silently no-op when
    // the tab is in the background. injectPromptWithVerification reads back
    // input.textContent after each call to confirm it landed, waits for the
    // tab to become active via visibilitychange, and retries up to
    // MAX_INJECT_RETRIES times. Throws InjectionTimeoutError if the flow
    // deadline expires before injection succeeds.
    sendLog('Injecting summary prompt into Gemini...');
    const flowDeadline = Date.now() + timeoutMs;
    const perfStart = Date.now(); // P6-C: measure inject → response-complete
    await injectPromptWithVerification(input, prompt, flowDeadline);

    // 5. Submit
    // Re-query both elements in case DOM updated since we injected the text.
    const freshInput = document.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
    const submit = document.querySelector('button[aria-label="Submit"]');
    if (!submit) throw new Error('Submit button not found');

    // Wait (observer-based) for Meet to enable the button.
    await waitForSubmitEnabled(submit, 5000);
    if (submit.disabled) {
      sendLog('Submit button still disabled after 5 s — clicking anyway');
    }

    // Primary path: dispatch Enter on the focused input.
    // submit.click() fires isTrusted=false which Meet's React handler silently
    // ignores; a KeyboardEvent Enter on a focused chat input is the natural
    // submission gesture and is processed regardless of isTrusted.
    if (freshInput) {
      freshInput.focus();
      freshInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true,
      }));
    }
    // Belt-and-suspenders: also click the button after a short pause so one of
    // the two methods always lands.
    await delay(150);
    if (!submit.disabled) submit.click();
    showStatus('Waiting for Gemini…');

    // 6. Wait for response to finish
    // Periodic snapshots pass a shorter timeout (90 s) so a slow response
    // doesn't block the lock for a full 2 minutes before the next snapshot fires.
    sendLog('Waiting for Gemini to finish writing...');
    await waitForResponseComplete(timeoutMs);

    // 7. Read response from DOM
    const response = extractLastResponse();
    sendLog(`Gemini response received (${response?.length ?? 0} chars)`);
    sendLog(formatPerfLog(Date.now() - perfStart, prompt.length, response?.length ?? 0), 'debug');
    if (!response || response.length < 20) {
      throw new Error('Response extracted but appears empty');
    }
    return response;
  }

  // ── Auto-activate Gemini ───────────────────────────────────────────────────
  // Opens the Gemini side panel automatically when a meeting starts so note-
  // taking begins from the very first moment without any manual action.
  //
  // Called from attachInterceptor() at join time AND from the MutationObserver
  // whenever the Gemini button first appears (it loads a few seconds after the
  // Leave button on slower connections).
  //
  // Two guards prevent redundant work:
  //   panelAutoOpened  — set once the panel is confirmed open; cleared between meetings
  //   geminiActivating — narrow async lock; true only while this call is in-flight
  //
  // Unlike the old geminiAutoActivated flag, geminiActivating is ALWAYS released
  // in the finally block, so if the button isn't in the DOM yet the MutationObserver
  // can call us again when it appears — without needing an explicit flag reset.
  //
  // Two-step activation:
  //   Meet shows a "Start now" card when Gemini hasn't been activated for this
  //   call yet (e.g. you're the first to join, or alone in the meeting). Clicking
  //   the Gemini button opens that card — we then look for "Start now" and click
  //   it to actually begin the recording session.

  // Resolves with button[aria-label*="Gemini"] as soon as it appears in DOM, or
  // null after timeout. Used after clicking "Start now" to detect when Meet
  // creates the active-state Gemini toggle (which can then be clicked to open
  // the panel). Distinguished from the no-aria-label "Geminispark_off" button.
  function waitForActiveGeminiButton(timeoutMs) {
    return waitForCondition(
      () => document.querySelector('button[aria-label*="Gemini" i]'), timeoutMs);
  }

  // ── Auto-activation state machine ─────────────────────────────────────────
  // Meet has three Gemini states (confirmed 2026-05-30 live DOM inspection):
  //
  //   State 1 — "not started"
  //     Toolbar: DIV role=button text="Geminispark_off" (no aria-label)
  //              DIV role=button text="Take notes with Geminipen_spark"
  //     To start: hover "Geminispark_off" → hover tray appears in MAIN DOM with
  //               BUTTON text="sparkStart now" → click it → Gemini begins recording
  //     Clicking (not hovering) opens a CROSS-ORIGIN IFRAME popup — inaccessible.
  //
  //   State 2 — "started, panel closed"
  //     Toolbar: button[aria-label="Gemini"] (proper <button>, accessible)
  //     To open: click the button → panel slides in, input enters viewport
  //
  //   State 3 — "panel open"
  //     div[aria-label="Ask Gemini"][contenteditable="true"] in viewport → can inject
  //
  // The extension must drive State 1→2→3 automatically on meeting join.
  // State 1→2 requires a real hover (synthetic events don't trigger the jsaction).
  // We try ArrowDown keyboard shortcut (tooltip: "Press down arrow to open tray")
  // as a programmatic alternative to hover. If that also fails, we show guidance
  // and let the MutationObserver retry when Gemini becomes active.

  async function autoActivateGemini() {
    if (panelAutoOpened || geminiActivating) {
      sendLog(`autoActivateGemini: skipped (panelAutoOpened=${panelAutoOpened} geminiActivating=${geminiActivating})`);
      return;
    }
    geminiActivating = true;
    sendLog('autoActivateGemini: starting...');

    try {
      if (!isContextValid()) { sendLog('autoActivateGemini: context invalid'); return; }
      if (!getLeaveButton())  { sendLog('autoActivateGemini: no Leave button'); return; }

      // ── State 3 check: panel already open ────────────────────────────────
      const existingInput = document.querySelector(
        'div[aria-label="Ask Gemini"][contenteditable="true"]'
      );
      sendLog(`autoActivateGemini: input=${!!existingInput} inViewport=${isInViewport(existingInput)}`);
      if (isInViewport(existingInput)) {
        sendLog('Gemini panel already open — skipping');
        panelAutoOpened = true;
        return;
      }

      // ── State 1→2: "Start now" hover tray already open ───────────────────
      // (e.g. extension reloaded while hover was active, or panel showed itself)
      let startNow = getGeminiStartNowButton();
      sendLog(`autoActivateGemini: immediateStartNow=${!!startNow}`);

      if (!startNow) {
        // Find the Gemini toolbar button
        const trigger = await waitForGeminiTrigger(2500);
        sendLog(`autoActivateGemini: trigger=${!trigger ? 'null' : (trigger.getAttribute('aria-label') || trigger.textContent.trim().slice(0,40))}`);
        if (!trigger) {
          sendLog('autoActivateGemini: trigger not found — retry on next mutation');
          return;
        }

        const hasLabel = !!trigger.getAttribute('aria-label');
        sendLog(`autoActivateGemini: trigger hasAriaLabel=${hasLabel}`);

        if (hasLabel) {
          // ── State 2→3: Gemini already started — click button to open panel ─
          sendLog(`Opening panel: click "${trigger.getAttribute('aria-label')}"`);
          trigger.click();
          // waitForPanelVisible handles the rest below
        } else {
          // ── State 1→2: Gemini not started ("spark_off" button) ────────────
          // Chrome's dispatchEvent always produces isTrusted=false, which Meet's
          // jsaction framework ignores for hover events — so synthetic mouseenter/
          // keydown don't open the hover tray.
          //
          // Use chrome.debugger + CDP Input.dispatchMouseEvent instead. CDP sends
          // events through Chrome's OS-level input pipeline, producing isTrusted=true.
          // Flow: CDP mouseMoved → hover tray appears in main DOM → wait for
          // "Start now" button → CDP mousePressed/mouseReleased on it.
          //
          // Coordinates are the button's CSS-pixel center from getBoundingClientRect
          // (already in viewport coordinates, no screen-scale conversion needed for CDP).
          const r = trigger.getBoundingClientRect();
          const btnX = Math.round(r.x + r.width  / 2);
          const btnY = Math.round(r.y + r.height / 2);

          sendLog(`Gemini not started — CDP hover at (${btnX}, ${btnY}) to open hover tray...`);

          // Step 1: CDP mouseMoved — triggers hover tray to appear
          const hoverRes = await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'MM2C_CDP_HOVER', x: btnX, y: btnY }, resolve)
          );
          if (!hoverRes?.ok) {
            sendLog(`CDP hover failed (${hoverRes?.error}) — showing manual guidance`);
            showStatus('Hover over the ✦ Gemini button → click "Start now" to enable notes', 'warn');
            return;
          }

          // Step 2: Wait for the hover tray's "Start now" button to appear in the DOM
          startNow = await waitForStartNowButton(2000);
          sendLog(`autoActivateGemini: startNow after CDP hover=${!!startNow}`);

          if (!startNow) {
            // Hover tray didn't appear (CDP approach may not work in this Meet version)
            sendLog('Hover tray did not open via CDP — showing manual guidance');
            chrome.runtime.sendMessage({ type: 'MM2C_CDP_DETACH' });
            showStatus('Hover over the ✦ Gemini button → click "Start now" to enable notes', 'warn');
            return;
          }

          // Found "Start now" — use KEEP variant so debugger stays attached
          // for the subsequent panel-toggle click (also needs isTrusted=true)
          sendLog('Using CDP_CLICK_KEEP for "Start now" — will follow up with panel toggle click');
        }
      }

      // ── Click "Start now" if we have it ──────────────────────────────────
      if (startNow) {
        const sr = startNow.getBoundingClientRect();
        const snX = Math.round(sr.x + sr.width  / 2);
        const snY = Math.round(sr.y + sr.height / 2);
        sendLog(`Clicking "Start now" via CDP_KEEP at (${snX}, ${snY})...`);

        // Use KEEP variant — debugger stays attached for the panel toggle click below.
        // Both "Start now" and the panel toggle button require isTrusted=true;
        // plain .click() (isTrusted=false) only works for "warm" panels (already initialised).
        const clickRes = await new Promise(resolve =>
          chrome.runtime.sendMessage({ type: 'MM2C_CDP_CLICK_KEEP', x: snX, y: snY }, resolve)
        );
        sendLog(`CDP_KEEP click result: ${clickRes?.ok ? 'ok' : (clickRes?.error || 'no response')}`);

        // After "Start now": wait for button[aria-label="Gemini"] then CDP-click it to open the panel.
        sendLog('Waiting for active Gemini button (3 s)...');
        const activeBtn = await waitForActiveGeminiButton(3000);
        sendLog(`autoActivateGemini: activeBtn=${!activeBtn ? 'null' : activeBtn.getAttribute('aria-label')}`);
        if (activeBtn) {
          const ar = activeBtn.getBoundingClientRect();
          const abX = Math.round(ar.x + ar.width  / 2);
          const abY = Math.round(ar.y + ar.height / 2);
          sendLog(`Opening panel: CDP click "${activeBtn.getAttribute('aria-label')}" at (${abX}, ${abY})`);
          // Final CDP click — detaches debugger after this
          await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'MM2C_CDP_CLICK', x: abX, y: abY }, resolve)
          );
        } else {
          // No panel button found — detach to clean up
          chrome.runtime.sendMessage({ type: 'MM2C_CDP_DETACH' });
        }
      }

      // ── State 3: Wait for panel to enter viewport ─────────────────────────
      sendLog('autoActivateGemini: waiting for panel visible (8 s)...');
      try {
        await waitForPanelVisible(8000);
      } catch (e) {
        const inputInDom = !!document.querySelector(
          'div[aria-label="Ask Gemini"][contenteditable="true"]'
        );
        if (!inputInDom) {
          sendLog('Panel input never appeared — Gemini not started');
          showStatus('Hover over ✦ Gemini button → click "Start now" to enable notes', 'warn');
        } else {
          sendLog(`Panel never entered viewport — may be admin-disabled`);
          showStatus('Gemini may be disabled for your account — check with your Google Admin', 'warn');
        }
        return;
      }

      geminiWasActive = true;
      panelAutoOpened = true;
      sendLog('Gemini panel opened — note-taking started');
    } finally {
      geminiActivating = false;
    }
  }

  // ── Periodic snapshot ──────────────────────────────────────────────────────
  // Captures a fresh summary from Gemini every 10 minutes and holds it in
  // memory. Nothing is sent to Craft yet — that happens only once, on leave.
  // This ensures there is always a recent transcript available even if Gemini
  // deactivates right before the user clicks Leave.

  async function takePeriodicSnapshot() {
    if (meetingBlocked) return; // RB-5a — sensitive meeting, never capture
    if (!enabled || intercepting || capturedProactively || geminiFlowPromise || !isContextValid()) return;
    if (!getLeaveButton() || !isGeminiAvailable()) return;

    // Timer-drift guard: the setInterval starts from extension load, not meeting join.
    // If you join a meeting at minute 7, the first interval fires after just 1 min
    // in the meeting. Block snapshots until a full interval has elapsed since join.
    sendLog('Periodic snapshot: capturing current notes…');
    try {
      const transcript = await runGeminiFlow(90_000); // 90 s timeout for background snapshots
      cachedTranscript   = transcript;
      cachedTranscriptAt = Date.now();
      sendLog(`Periodic snapshot saved (${transcript.length} chars)`);
      showStatus('✓ Notes snapshot saved', 'ok'); // auto-dismisses in 5 s
      // Store a short preview so the popup can show "Last snapshot: N min ago ▸"
      safeSend({
        type: 'MM2C_SET_SNAPSHOT',
        snapshot: { ts: Date.now(), preview: transcript.slice(0, 300) },
      });
      refreshRecordingState(); // re-check: recording may have started after join (P9-A3c)
      // Back up this snapshot to disk (fire-and-forget — no callback needed).
      // background.js checks mm2c_file_backup_enabled before writing.
      if (isContextValid()) {
        safeSend({
          type: 'MM2C_SNAPSHOT',
          text: transcript,
          meetingTitle: currentMeetingTitle || getMeetingTitle() || '',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      sendLog(`Periodic snapshot skipped: ${err instanceof GeminiNotActiveError ? 'Gemini not accessible' : err.message}`);
      // Clear the "Waiting for Gemini…" toast that runGeminiFlow left behind
      const toast = document.getElementById('mm2c-status');
      if (toast) toast.remove();
    }
  }

  // ── Attendee names ────────────────────────────────────────────────────────
  // Returns display names of visible participants from the Meet video grid.
  // Uses multiple fallback selectors — Meet's DOM changes across versions.
  // Returns an empty array (never throws) when no names are found.
  function getAttendeeNames() {
    const names = new Set();
    const selectors = [
      '[data-participant-id] [data-self-name]',
      '[data-participant-id] [jsname="r4nke"]',
      '[data-ssrc] [data-self-name]',
    ];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const n = (el.textContent || el.dataset?.selfName || '').trim();
          if (n.length > 1 && n.length < 80 && !/^\d+$/.test(n)) names.add(n);
        });
      } catch { /* selector unsupported in this Meet build — try the next one */ }
    }
    return [...names];
  }

  // ── Meeting title ──────────────────────────────────────────────────────────
  // Tab title is "Meet - MEETING NAME". Extract the name part.

  function getMeetingTitle() {
    // Meet generates codes like "abc-defg-hij" — not useful as titles
    const isMeetCode = s => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(s);

    // 1. Tab title: "Meet - Meeting Name" (scheduled calendar meetings)
    const raw = document.title || '';
    const m = raw.match(/^Meet\s*[-–]\s*(.+)$/i);
    if (m) {
      const name = m[1].trim();
      if (name && !isMeetCode(name)) return name;
      // Tab title IS the room code — personal Meet link with no calendar event
      if (name && isMeetCode(name)) return `Personal meeting (${name})`;
    }

    // 2. DOM fallback — filter out codes here too
    const candidates = [
      document.querySelector('div[data-meeting-title]')?.dataset?.meetingTitle,
      document.querySelector('span[jsname="r4nke"]')?.textContent,
      document.querySelector('c-wiz div[jsname="Tmhsfe"] span')?.textContent,
    ];
    for (const c of candidates) {
      const t = c?.trim();
      if (t && !isMeetCode(t)) return t;
      if (t && isMeetCode(t)) return `Personal meeting (${t})`;
    }

    return '';
  }

  // Detect Meet's "this meeting is being recorded" indicator (P9-A3c). The exact
  // selector varies across Meet builds, so probe several candidates defensively.
  // NOTE: selector set still needs live verification — treat a false as "unknown".
  function isRecording() {
    const selectors = [
      'div[aria-label*="recording" i]',
      'span[aria-label*="recording" i]',
      '[data-tooltip*="recording" i]',
      '[aria-label*="is being recorded" i]',
    ];
    for (const s of selectors) {
      try { if (document.querySelector(s)) return true; } catch { /* bad selector for this build — skip */ }
    }
    return false;
  }

  // Sticky: once a recording indicator is seen, the meeting is marked recorded.
  function refreshRecordingState() {
    if (!meetingRecording && isRecording()) {
      meetingRecording = true;
      sendLog('Meeting is being recorded');
    }
  }

  // ── Proactive capture ──────────────────────────────────────────────────────
  // When Gemini deactivates mid-meeting (e.g. other person leaves a 1:1),
  // we immediately try to capture notes BEFORE the user clicks Leave.
  //
  // If cachedTranscript is null (meeting shorter than ~10 min, no snapshot yet),
  // a live runGeminiFlow(60 s) is attempted. intercepting is set during the attempt
  // to block onLeaveClick from starting a concurrent flow.
  //
  // captureProactivelyAttempted blocks double-runs from the MutationObserver,
  // which can fire multiple times on a single Gemini-deactivation event.

  async function captureProactively(meetingTitle) {
    if (meetingBlocked) return; // RB-5a — sensitive meeting, never capture
    if (intercepting || capturedProactively || captureProactivelyAttempted || !isContextValid()) return;
    captureProactivelyAttempted = true;

    if (!cachedTranscript) {
      // No periodic snapshot yet — attempt a live Gemini capture (60 s timeout).
      // intercepting blocks onLeaveClick from starting a concurrent flow.
      intercepting = true;
      sendLog('Gemini deactivated — no snapshot yet, attempting live capture (60 s)...');
      showStatus('Meeting ended — capturing notes…');
      try {
        const transcript = await runGeminiFlow(60_000);
        cachedTranscript   = transcript;
        cachedTranscriptAt = Date.now();
        sendLog(`Live proactive capture succeeded (${transcript.length} chars)`);
        // Fall through to Craft send below
      } catch (err) {
        intercepting = false; // release so Leave button can still fire normally
        if (err instanceof GeminiNotActiveError) {
          sendLog('Proactive live capture: Gemini not active — meeting too short for notes');
          showStatus(GEMINI_INACTIVE_MESSAGE, 'warn');
          safeSend({ type: 'MM2C_WARNING', message: GEMINI_INACTIVE_MESSAGE, meetingTitle });
        } else {
          sendLog(`Proactive live capture failed: ${err.message}`, 'debug');
          showStatus(friendlyError(err.message), 'err');
          safeSend({ type: 'MM2C_ERROR', error: err.message, meetingTitle });
        }
        return;
      }
    }

    // We have a transcript — either from the live attempt above or a periodic snapshot.
    intercepting        = true; // ensure set (may already be from live attempt branch)
    capturedProactively = true;
    sendLog('Gemini deactivated — sending notes to Craft');
    showStatus(`Saving notes to ${outputAppName(currentOutputApp)}…`);

    chrome.runtime.sendMessage({
      type: 'MM2C_RESPONSE',
      text: cachedTranscript,
      meetingTitle,
      attendees: getAttendeeNames(),
      durationMin: meetingJoinedAt > 0 ? Math.round((Date.now() - meetingJoinedAt) / 60_000) : null,
      meetingCode: currentMeetingCode,
      meetingType: currentMeetingType,
      titleTemplate: currentTitleTemplate,
      recording: meetingRecording,
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        const err = chrome.runtime.lastError?.message || response?.error || 'unknown error';
        sendLog(`Proactive capture failed: ${err}`, 'debug');
        safeSend({ type: 'MM2C_ERROR', error: err, meetingTitle });
        showStatus(friendlyError(err), 'err');
        capturedProactively         = false;
        captureProactivelyAttempted = false;
        intercepting                = false;
      } else {
        showStatus(`✓ Saved to ${outputAppName(currentOutputApp)}`, 'ok');
        // Keep intercepting = true so the next Leave click passes through normally.
      }
    });
  }

  // ── Leave button interceptor ───────────────────────────────────────────────

  function outputAppName(appKey) {
    return ({ craft: 'Craft', apple_notes: 'Apple Notes', none: 'None', obsidian: 'Obsidian', bear: 'Bear' })[appKey] || appKey;
  }

  function isContextValid() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }

  // Fire-and-forget chrome.runtime.sendMessage that doesn't blindly swallow (A3).
  // A dead extension context (expected after a reload) is the one benign failure
  // and stays silent; any OTHER failure is surfaced via console.warn instead of
  // vanishing into an empty catch.
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (isContextValid()) console.warn('[MM2C] sendMessage failed:', msg?.type, e?.message || e);
    }
  }

  // Durable in-flight note (RB-1d). Persist the formatted note to storage just
  // before sending so a mid-flow crash can be recovered from the popup; clear it
  // on a confirmed save (or handled error). cachedTranscript itself is RAM-only
  // and disk snapshots are raw transcripts, so this is the only durable copy of
  // the FORMATTED note.
  function setInflightNote(title, text) {
    if (!isContextValid()) return;
    try { chrome.storage.local.set({ mm2c_inflight: { title: title || '', text: text || '', at: Date.now() } }); } catch {}
  }
  function clearInflightNote() {
    if (!isContextValid()) return;
    try { chrome.storage.local.remove('mm2c_inflight'); } catch {}
  }

  // ── Persistent log helper ──────────────────────────────────────────────────
  // Sends a log entry to background.js which stores it in mm2c_logs.
  // Silently ignored if the runtime context is dead.

  function sendLog(message, level = 'user') {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'MM2C_LOG',
        message,
        meetingTitle: getMeetingTitle() || '',
        level,
      });
    } catch (e) {
      // Context was valid above but the send still failed — never swallow a
      // logger failure silently (A3). Use console directly (sendLog can't recurse).
      console.warn('[MM2C] sendLog failed:', e?.message || e);
    }
  }

  async function onLeaveClick(e) {
    if (!enabled) return;
    if (meetingBlocked) { sendLog('Leave clicked — meeting on blocklist, not captured', 'user'); return; }
    if (intercepting) {
      // Either the leave flow already ran (and called btn.click() in finally),
      // or proactive capture is in progress / succeeded. Either way let through.
      if (capturedProactively) sendLog('Leave clicked — notes already captured proactively');
      return;
    }
    // If the extension was reloaded while this tab was open, the runtime
    // context is dead. Let the click fall through so the user can still leave.
    if (!isContextValid()) return;
    intercepting = true;

    // Capture title immediately — the tab title changes once the call ends
    const meetingTitle = getMeetingTitle();

    e.preventDefault();
    e.stopImmediatePropagation();

    sendLog('Leave clicked — capturing meeting notes');
    muteAll();
    showStatus('Capturing notes…');

    try {
      let transcript = null;

      // If a periodic snapshot is currently running, await its natural completion.
      // No cap or force-release — the snapshot is bounded by its own 90 s timeout
      // in runGeminiFlow(90_000). When it finishes, cachedTranscript is up to date.
      // If a periodic snapshot was actively running when Leave was clicked,
      // wait for it and use that result directly — no point running Gemini again
      // immediately after it just finished. If no snapshot was in progress,
      // always attempt a fresh capture to get the final minutes of discussion.
      const snapshotWasActive = !!geminiFlowPromise;
      if (snapshotWasActive) {
        sendLog('Snapshot in progress when Leave clicked — waiting for it to complete...');
        await geminiFlowPromise;
        sendLog('Snapshot complete — using result directly, skipping redundant Gemini run');
      } else if (snapshotFreshEnough(cachedTranscriptAt, snapshotIntervalMs)) {
        // A periodic snapshot finished very recently (within half an interval) —
        // it already covers the final minutes. Skip the 20–60 s fresh Gemini run
        // and use the cached result directly (BUG-3).
        const ageSec = Math.round((Date.now() - cachedTranscriptAt) / 1000);
        sendLog(`Recent snapshot is fresh (${ageSec}s old) — using it, skipping redundant Gemini run`);
      } else {
        sendLog('Leave clicked — attempting fresh Gemini capture for final notes...');
        try {
          transcript = await runGeminiFlow(60_000);
          sendLog(`Fresh Leave capture succeeded (${transcript.length} chars)`);
        } catch (freshErr) {
          if (freshErr instanceof GeminiNotActiveError) {
            // Gemini was never running — fall through to cache or no-notes path below.
          } else {
            sendLog(`Fresh Leave capture failed (${freshErr.message}) — falling back to cache`);
          }
        }
      }

      const ageMin = cachedTranscriptAt ? Math.round((Date.now() - cachedTranscriptAt) / 60000) : null;
      const ageSuffix = ageMin !== null ? `, ${ageMin} min old` : '';

      if (!transcript && cachedTranscript) {
        // Fresh flow failed or Gemini was not active — use last periodic snapshot.
        sendLog(`Using cached snapshot as fallback (${cachedTranscript.length} chars${ageSuffix})`);
        if (ageMin !== null && ageMin > 15) {
          showStatus(`Snapshot is ${ageMin} min old — recent discussion may be missing`, 'warn');
        }
        transcript = cachedTranscript;
      } else if (!transcript) {
        // No cache and fresh flow already failed — retry up to 3 times.
        // GeminiNotActiveError is rethrown immediately (Gemini was never running).
        // InjectionTimeoutError falls back to cachedTranscript if available,
        // otherwise shows a warning and leaves without notes (transcript stays null).
        // Other transient errors (DOM race, "Submit button not found") are
        // retried with a 3 s backoff.
        let lastFlowErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            transcript = await runGeminiFlow();
            break; // success — exit retry loop
          } catch (flowErr) {
            lastFlowErr = flowErr;

            if (flowErr instanceof GeminiNotActiveError) throw flowErr;

            if (flowErr instanceof InjectionTimeoutError) {
              // Tab never came to the foreground during the inject window.
              sendLog(`Prompt injection timed out: ${flowErr.message}`);
              safeSend({ type: 'MM2C_WARNING', message: flowErr.message, meetingTitle });
              if (cachedTranscript) {
                sendLog(`Falling back to cached snapshot (${cachedTranscript.length} chars${ageSuffix})`);
                if (ageMin !== null && ageMin > 15) {
                  showStatus(`Snapshot is ${ageMin} min old — recent discussion may be missing`, 'warn');
                }
                transcript = cachedTranscript;
              } else {
                showStatus('Could not inject prompt — switch to this tab during capture', 'warn');
                // transcript stays null — Craft send is skipped; finally always leaves
              }
              break; // no retry after timeout
            }

            if (attempt < 3) {
              sendLog(`Gemini flow attempt ${attempt} failed: ${flowErr.message} — retrying in 3 s`);
              await delay(3000);
            }
          }
        }
        // Re-throw if we exhausted retries with no transcript and the failure
        // was not a handled InjectionTimeoutError.
        if (!transcript && lastFlowErr && !(lastFlowErr instanceof InjectionTimeoutError)) {
          throw lastFlowErr;
        }
      }

      // Send to Craft only if a transcript was acquired by any path above.
      if (transcript) {
        sendLog(`Sending notes to ${outputAppName(currentOutputApp)}...`);
        showStatus(`Sending to ${outputAppName(currentOutputApp)}…`);

        // Await the Craft send before clicking Leave — the native host (Python)
        // needs 2-10 s to respond; leaving immediately would race the response
        // and risk silent data loss. A 20 s timeout ensures we always leave.
        // Persist the formatted note before sending so a crash mid-send is
        // recoverable from the popup (RB-1d); cleared once the send resolves.
        setInflightNote(meetingTitle, transcript);
        await new Promise((resolve) => {
          const giveUp = setTimeout(() => {
            sendLog('Craft send timed out — leaving anyway');
            resolve();
          }, 20_000);
          chrome.runtime.sendMessage({
            type: 'MM2C_RESPONSE',
            text: transcript,
            meetingTitle,
            attendees: getAttendeeNames(),
            durationMin: meetingJoinedAt > 0 ? Math.round((Date.now() - meetingJoinedAt) / 60_000) : null,
            meetingCode: currentMeetingCode,
            meetingType: currentMeetingType,
            titleTemplate: currentTitleTemplate,
            recording: meetingRecording,
          }, (response) => {
            clearTimeout(giveUp);
            clearInflightNote(); // send completed (ok or handled error) — no longer stuck
            if (chrome.runtime.lastError || !response?.ok) {
              const err = chrome.runtime.lastError?.message || response?.error || 'unknown error';
              sendLog(`Send failed: ${err}`, 'debug');
              showStatus(friendlyError(err), 'err');
            } else {
              showStatus(`✓ Saved to ${outputAppName(currentOutputApp)}`, 'ok');
            }
            resolve();
          });
        });
      }

    } catch (err) {
      if (err instanceof GeminiNotActiveError) {
        console.info('[MM2C] Gemini not active, skipping summary.');
        showStatus(GEMINI_INACTIVE_MESSAGE, 'warn');
        safeSend({ type: 'MM2C_WARNING', message: GEMINI_INACTIVE_MESSAGE, meetingTitle });
      } else {
        console.error('[MM2C]', err);
        safeSend({ type: 'MM2C_ERROR', error: err.message, meetingTitle });
        showStatus(friendlyError(err.message), 'err');
      }
    } finally {
      // Always leave the call
      await delay(400);
      const btn = getLeaveButton();
      if (btn) btn.click();
    }
  }

  // ── Status toast ───────────────────────────────────────────────────────────

  function showStatus(msg, type = 'info') {
    // Inject base CSS class once — avoids re-setting all styles on every call
    if (!document.getElementById('mm2c-toast-styles')) {
      const s = document.createElement('style');
      s.id = 'mm2c-toast-styles';
      s.textContent = [
        '.mm2c-toast{',
          'position:fixed;left:50%;transform:translateX(-50%);',
          'z-index:99999;padding:10px 22px;border-radius:20px;',
          // Shared font stack (UXC-12) — same system-UI family as the popup.
          `font-family:${TOKENS.font.ui};font-size:13px;`,
          'font-weight:500;color:#fff;pointer-events:none;',
          'box-shadow:0 2px 10px rgba(0,0,0,.3)',
        '}',
      ].join('');
      document.head.appendChild(s);
    }

    let el = document.getElementById('mm2c-status');
    if (!el) {
      el           = document.createElement('div');
      el.id        = 'mm2c-status';
      el.className = 'mm2c-toast';
      // Position above the call controls toolbar; fall back to 120px if toolbar absent
      const toolbar    = document.querySelector('div[aria-label="Call controls"]');
      el.style.bottom  = (toolbar ? toolbar.offsetHeight + 12 : 120) + 'px';
      document.body.appendChild(el);
    }
    el.textContent      = msg;
    // Toast fill from the shared token map (UXC-5) — same palette as the badge.
    el.style.background = tokenStatusFill(type);
    el.style.color      = TOKENS.color.onColor;
    if (type === 'err')  setTimeout(() => el.remove(), 8000);
    if (type === 'warn') setTimeout(() => el.remove(), 6000);
    if (type === 'ok')   setTimeout(() => el.remove(), 5000);
  }

  // ── Attach interceptor ─────────────────────────────────────────────────────

  function attachInterceptor() {
    if (!enabled) return;
    const btn = getLeaveButton();
    if (!btn || btn === hooked) return;
    if (hooked) hooked.removeEventListener('click', onLeaveClick, true);
    btn.addEventListener('click', onLeaveClick, { capture: true });
    const firstHook = !hooked;
    hooked = btn;
    if (firstHook) {
      meetingJoinedAt = Date.now();
      // Schedule meeting-anchored snapshots: first fires exactly snapshotIntervalMs after
      // joining, then every snapshotIntervalMs after that. Stops automatically when the
      // meeting ends (getLeaveButton() returns null). Clears on resetMeetingState().
      // Seed lastSnapshotAt to meeting join time so the visibilitychange catch-up
      // listener doesn't fire immediately (elapsed = Date.now() - 0 = huge when
      // lastSnapshotAt is 0, triggering a premature snapshot on the first tab switch).
      lastSnapshotAt = meetingJoinedAt;
      if (meetingSnapshotTimer) clearTimeout(meetingSnapshotTimer);
      (function scheduleMeetingSnapshot() {
        meetingSnapshotTimer = setTimeout(() => {
          if (!getLeaveButton()) { meetingSnapshotTimer = null; return; } // meeting ended
          if (document.hidden) {
            sendLog('Periodic snapshot deferred: tab not active');
          } else {
            lastSnapshotAt = Date.now();
            takePeriodicSnapshot();
          }
          scheduleMeetingSnapshot();
        }, snapshotIntervalMs);
      })();
      geminiWasActive = isGeminiAvailable(); // seed baseline so change tracker is accurate
      currentMeetingTitle = getMeetingTitle(); // cache now — DOM title disappears after call ends
      currentMeetingCode  = extractMeetingCode(window.location.pathname);
      currentMeetingType  = inferMeetingType(currentMeetingTitle);
      refreshRecordingState();
      // Capture blocklist (RB-5a) + per-rule title template (RB-4d) — resolved
      // once at join against the cached meeting title.
      if (currentMeetingTitle && isContextValid()) {
        chrome.storage.local.get(['mm2c_blocklist', 'mm2c_prompt_rules']).then(({ mm2c_blocklist, mm2c_prompt_rules }) => {
          meetingBlocked = titleBlocked(currentMeetingTitle, mm2c_blocklist || '');
          if (meetingBlocked) sendLog('Meeting excluded by blocklist — capture disabled for this meeting', 'user');
          const rules = Array.isArray(mm2c_prompt_rules) ? mm2c_prompt_rules : [];
          currentTitleTemplate = findPromptRule(rules, currentMeetingTitle)?.titleTemplate?.trim() || '';
        }).catch(() => {});
      }
      safeSend({ type: 'MM2C_STAT_JOINED' }); // UX-8 stats
      // Fetch prior-session context for recurring meetings (P9-C) — fire-and-forget.
      if (currentMeetingTitle) {
        try {
          chrome.runtime.sendMessage(
            { type: 'MM2C_PRIOR_CONTEXT', meetingTitle: currentMeetingTitle },
            (resp) => {
              if (chrome.runtime.lastError) return;
              priorContext = resp?.context || '';
              if (priorContext) sendLog('Loaded context from a previous session of this meeting', 'debug');
            },
          );
        } catch (e) {
          if (isContextValid()) console.warn('[MM2C] prior-context request failed:', e?.message || e);
        }
      }
      const geminiNote = geminiWasActive ? ', Gemini active' : ', Gemini not yet detected';
      sendLog(`Meeting joined — ready to capture notes${geminiNote}`);
      // Selector health self-test (RB-1a) — surface a Meet DOM change as an
      // observable diagnostic instead of a silent capture failure.
      try {
        const health = selectorHealthCheck(effectiveSelectors, sel => document.querySelector(sel));
        if (health.criticalFailed.length) {
          sendLog(`Selector health: critical selectors unresolved (${health.criticalFailed.join(', ')}) — Meet may have changed its DOM`, 'user');
          safeSend({ type: 'MM2C_WARNING', message: 'Meet UI changed — capture may not work. Please report an issue.', meetingTitle: currentMeetingTitle });
        } else if (health.failed.length) {
          sendLog(`Selector health: ${health.failed.join(', ')} not present yet (normal pre-activation)`, 'debug');
        } else {
          sendLog('Selector health: all resolved', 'debug');
        }
      } catch (e) { console.warn('[MM2C] selector health check failed:', e?.message || e); }
      // Auto-open the Gemini panel so note-taking starts immediately.
      // If the button isn't visible yet the function resets its flag so the
      // MutationObserver branch above retries when it appears.
      autoActivateGemini();
      // Narrow the MutationObserver from document.body to the call controls bar.
      // Most in-meeting mutations (streaming transcript, video tiles, chat) are
      // outside the toolbar — narrowing eliminates the vast majority of firings.
      // Also watch toolbar.parentElement (childList only, no subtree) so we detect
      // if Meet removes the toolbar node entirely — the isConnected guard in the
      // callback then falls back to document.body.
      const toolbar = document.querySelector('div[aria-label="Call controls"]');
      if (toolbar?.parentElement) {
        observer.disconnect();
        observer.observe(toolbar, { childList: true, subtree: true });
        observer.observe(toolbar.parentElement, { childList: true });
        observedNode = toolbar;
      }
    }
  }

  // ── Close guard ───────────────────────────────────────────────────────────
  // Intercepts Cmd+W, tab X, browser close, and navigation away — but only
  // when Gemini notes are active in the meeting.
  // Shows a custom in-page overlay instead of the browser's native dialog
  // (Chrome no longer allows custom text in beforeunload dialogs).

  function isGeminiAvailable() {
    // Check both known UI entry points across Meet versions:
    //   • <button aria-label*="Gemini"> — star icon shown after Gemini is started
    //   • DIV[role="button"] "Take notes with Gemini" — shown before first activation
    return !!getGeminiTriggerElement();
  }

  let closeOverlay = null;

  function showCloseOverlay() {
    if (closeOverlay) return;

    closeOverlay = document.createElement('div');
    closeOverlay.id = 'mm2c-close-overlay';
    closeOverlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(3px)',
    ].join(';');

    closeOverlay.innerHTML = `
      <div style="background:#202124;border-radius:12px;padding:28px 32px;max-width:380px;
                  width:90%;box-shadow:0 8px 30px rgba(0,0,0,.5);
                  font-family:'Google Sans',Roboto,sans-serif;color:#e8eaed;text-align:center;">
        <div style="font-size:18px;font-weight:500;margin-bottom:10px;">
          Leaving without notes?
        </div>
        <div style="font-size:13px;color:#9aa0a6;margin-bottom:24px;line-height:1.5;">
          ${closeOverlayBody(outputAppName(currentOutputApp))}
        </div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="mm2c-close-leave"
            style="flex:1;height:36px;border-radius:18px;border:1px solid #5f6368;
                   background:transparent;color:#e8eaed;font-size:13px;cursor:pointer;">
            Leave without notes
          </button>
          <button id="mm2c-close-save"
            style="flex:1;height:36px;border-radius:18px;border:none;
                   background:#1a73e8;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">
            Save &amp; leave
          </button>
        </div>
      </div>`;

    document.body.appendChild(closeOverlay);

    document.getElementById('mm2c-close-save').addEventListener('click', () => {
      sendLog('User chose: Save & leave from close prompt');
      removeCloseOverlay();
      const btn = getLeaveButton();
      if (btn && !intercepting) btn.click();
    });

    document.getElementById('mm2c-close-leave').addEventListener('click', () => {
      sendLog('User chose: Leave without notes from close prompt');
      removeCloseOverlay();
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Navigate to Meet's home page — reliable in Meet's SPA context.
      // window.close() only works if Chrome opened the tab; history.go(-1) may
      // navigate to an unrelated page. Direct navigation always works.
      window.location.href = 'https://meet.google.com/';
    });
  }

  function removeCloseOverlay() {
    if (closeOverlay) { closeOverlay.remove(); closeOverlay = null; }
  }

  function onBeforeUnload(e) {
    if (!enabled || intercepting || !getLeaveButton()) return;
    if (!isGeminiAvailable()) {
      // Gemini deactivated before the user left. If proactive capture didn't already
      // handle it, log that notes were skipped.
      if (geminiWasActive && !capturedProactively) {
        sendLog('Leaving — Gemini deactivated and proactive capture failed, notes not saved');
      }
      return;
    }
    sendLog('Tab/browser close detected — showing "save or leave" prompt');
    e.preventDefault();
    e.returnValue = '';
    // Show our overlay — visible if the user clicks "Stay" in the browser dialog.
    // Guard: only mount if still on the Meet call page (Leave button present, tab not hidden).
    // Without the guard, the overlay can mount on the next page if the tab navigates
    // before this 0 ms timer fires.
    setTimeout(() => {
      if (!document.hidden && getLeaveButton()) showCloseOverlay();
    }, 0);
  }

  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', removeCloseOverlay);

  // Intercept clicks that navigate away from Meet while in a call
  document.addEventListener('click', (e) => {
    if (!enabled || intercepting || capturedProactively || !getLeaveButton() || !isGeminiAvailable()) return;
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showCloseOverlay();
  }, true);

  // Expose DOM-reading functions for offline fixture tests.
  // Only active when MM2C_FIXTURE_MODE = true (set by fixture-dom.html).
  if (window.MM2C_FIXTURE_MODE) {
    window.MM2C_SELECTORS = { getMeetingTitle, getAttendeeNames, getGeminiTriggerElement, getLeaveButton };
  }

})();
