# Design: DOM Fixture Tests (6.2) + E2E Smoke Test (6.8)

**Date:** 2026-06-01  
**Status:** Approved  
**Roadmap items:** 6.2 — Offline DOM fixture tests, 6.8 — E2E smoke test

---

## Problem

Two gaps in the current test suite:

1. **6.2:** The DOM-reading functions in `content_meet.js` (`getMeetingTitle`, `getAttendeeNames`, `getGeminiTriggerElement`) have zero fixture tests. A silent Meet DOM change (renamed attribute, new selector) would only be caught during a real meeting — never in CI.

2. **6.8:** No test verifies that, given a completed Gemini capture, the outbound `MM2C_RESPONSE` message is well-formed. The Leave flow logic is untested end-to-end.

---

## Approach

Follow the established pattern in the codebase:

- DOM assertions live as JS test cases inside a self-contained suite loaded by a fixture HTML page.
- Logic tests use injectable-dep test helpers (same pattern as `captureProactively_test`).
- Playwright spec files are thin harnesses: navigate → run suite → assert zero failures.

No new infrastructure. No chrome stub. No divergence from existing conventions.

---

## New Files

```
tests/
  dom_fixtures.spec.js     # Playwright harness for 6.2
  fixture-dom.html         # Static HTML with Meet DOM snippets + MM2C_DOM_TESTS suite
  e2e_smoke.spec.js        # Playwright harness for 6.8
```

## Modified Files

```
extension/tests.js         # Add onLeaveClick_test helper + MM2C_TESTS.runSmoke() entry point
```

No changes to `playwright.config.js` or `package.json` — Playwright picks up all `tests/*.spec.js` files automatically.

---

## 6.2 — DOM Fixture Tests

### fixture-dom.html

Loads `constants.js` + `content_meet.js` with `window.MM2C_FIXTURE_MODE = true` and `window.MM2C_SKIP_AUTORUN = true`. Defines `window.MM2C_DOM_TESTS` with a `run()` method — identical shape to `MM2C_TESTS`.

Each test case uses `withFixture(html, fn)` to mount a DOM snippet, run assertions, then clean up.

### Test cases

**`getMeetingTitle` — 5 cases**

| Case | Input | Expected |
|---|---|---|
| Scheduled meeting | `document.title = "Meet - Sprint Planning"` | `"Sprint Planning"` |
| Em-dash variant | `document.title = "Meet – Q3 Review"` | `"Q3 Review"` |
| Room code in title | `document.title = "Meet - abc-defg-hij"` | `""` |
| DOM fallback | `document.title = "Google Meet"`, `div[data-meeting-title="Roadmap sync"]` in DOM | `"Roadmap sync"` |
| No title | `document.title = "Google Meet"`, no DOM | `""` |

**`getAttendeeNames` — 4 cases**

| Case | DOM | Expected |
|---|---|---|
| Two participants | Two `[data-participant-id]` nodes with `data-self-name` | `["Alice", "Bob"]` |
| Duplicate name | Same name on two nodes | `["Alice"]` |
| Numeric string | Node text `"123"` | `[]` |
| Empty node | Node text `""` | `[]` |

**`getGeminiTriggerElement` — 4 cases**

| Case | DOM | Expected |
|---|---|---|
| `button[aria-label="Gemini"]` | Present | returns element |
| `div[role="button"]` text `"Geminispark_off"` | Present, no aria-label | returns element |
| `div[role="button"]` text `"Take notes with Gemini"` | Present (fallback) | returns element |
| None present | Empty | `null` |

**`getLeaveButton` — 2 cases**

| Case | DOM | Expected |
|---|---|---|
| Button present | `button[aria-label="Leave call"]` | returns element |
| Button absent | Empty | `null` |

**Total: 15 new fixture test cases**

### dom_fixtures.spec.js

```js
// Loads fixture-dom.html, calls MM2C_DOM_TESTS.run(), asserts zero failures.
// Mirrors run_tests.spec.js exactly.
```

---

## 6.8 — E2E Smoke Test

### onLeaveClick_test helper (extension/tests.js)

```js
function onLeaveClick_test({ cachedTranscript, meetingTitle, attendees, outputApp, sendMessageSpy })
```

A re-implementation of the Leave click send path with injectable dependencies — same pattern as `captureProactively_test`. Replaces `chrome.runtime.sendMessage` with `sendMessageSpy` and seeds meeting state via parameters.

### Test cases — 3

| Case | Setup | Assert |
|---|---|---|
| Happy path | `cachedTranscript = "full notes"`, title set, 2 attendees | `sendMessageSpy` called once with `{ type: 'MM2C_RESPONSE', transcript, meetingTitle, attendees, outputApp }` |
| Empty transcript | `cachedTranscript = null` | `sendMessageSpy` not called |
| Output app forwarded | `outputApp = "apple_notes"` | payload contains `outputApp: "apple_notes"` |

### MM2C_TESTS.runSmoke()

New entry point on the existing `MM2C_TESTS` object — runs only the smoke test cases. Called by `e2e_smoke.spec.js`.

### e2e_smoke.spec.js

```js
// Loads fixture.html (existing), waits for MM2C_TESTS,
// calls MM2C_TESTS.runSmoke(), asserts zero failures.
```

---

## Test count after implementation

```
tests/run_tests.spec.js       existing ~191 JS tests
tests/dom_fixtures.spec.js    +15 DOM fixture cases
tests/e2e_smoke.spec.js       +3 smoke cases
```

`npm run test:all` runs all three suites.

---

## Out of scope

- Chrome extension test harness (`chrome-extension://` loading in a real browser profile)
- Mocking `chrome.runtime`, `chrome.storage`, or `chrome.tabs` globally
- Any changes to `playwright.config.js` or `package.json`
