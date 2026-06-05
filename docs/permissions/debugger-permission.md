# Justification for the `"debugger"` permission

## Summary

Gememo requests the `"debugger"` permission for a single, narrow purpose: to
deliver one **trusted** hover-and-click gesture to Google Meet's own "✦ Gemini →
Start now" control so that note-taking activates automatically when the user
joins a meeting. We attach `chrome.debugger` only transiently during this
activation, send a small number of `Input.dispatchMouseEvent` commands on the
**current Google Meet tab**, and detach immediately afterward. We never read page
content, intercept network traffic, evaluate arbitrary JavaScript, persist an
attachment, or touch any other tab or site.

CDP domain / methods used: **`Input.dispatchMouseEvent`** only
(`type: "mouseMoved"`, `"mousePressed"`, `"mouseReleased"`).

## 1. What we use it for, precisely

The extension's content script (`extension/content_meet.js`,
`autoActivateGemini()` — the only caller) needs to:

1. Hover the Gemini toolbar button to reveal Meet's "Start now" tray, then
2. Click "Start now" (and the resulting panel toggle) so Gemini meeting notes
   begin recording without the user having to do it manually.

The background service worker (`extension/background.js`, message handlers
`MM2C_CDP_HOVER`, `MM2C_CDP_CLICK`, `MM2C_CDP_CLICK_KEEP`, `MM2C_CDP_DETACH`)
performs this with exactly two CDP calls:

- `chrome.debugger.attach({ tabId }, "1.3")` on the active Meet tab, and
- `chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", …)` with
  `mouseMoved` (hover), then `mousePressed` + `mouseReleased` (click) at the
  control's viewport coordinates.

After the click sequence completes we call `chrome.debugger.detach({ tabId })`.
On any failure path we also detach (`MM2C_CDP_DETACH`). The debugger is never
left attached.

## 2. Why it is necessary (no lighter alternative)

Google Meet's UI is built on Google's **jsaction** framework, which ignores DOM
events whose `isTrusted === false` — i.e. anything produced by `dispatchEvent()`
or `element.click()` from extension code. The "Start now" hover-tray only opens
in response to a **trusted** hover, and "Start now" itself only responds to a
trusted click.

Chrome extensions can produce trusted (`isTrusted === true`) input events for an
arbitrary element **only** through the CDP `Input.dispatchMouseEvent` pipeline,
which routes events through Chrome's OS-level input stack — and that pipeline is
reachable only via `chrome.debugger`. We verified that `chrome.scripting`,
content-script synthetic events, and `.click()` do **not** activate this specific
Meet control (see the comments in `content_meet.js` around `autoActivateGemini()`
and in `background.js` around the CDP message handlers). There is no lighter
permission that accomplishes this.

## 3. Scope and restraint

- **Host scope is locked down.** `host_permissions` is limited to
  `https://meet.google.com/*` (see `extension/manifest.json`). The content script
  runs only on that origin.
- **Transient attachment.** The debugger is attached only for the brief
  activation sequence and detached immediately after the final click (or on
  failure). It is never persisted across the meeting.
- **Single, minimal CDP surface.** The only CDP method ever sent is
  `Input.dispatchMouseEvent` (`mouseMoved` / `mousePressed` / `mouseReleased`).
  No other CDP domain or method is used.
- **One tab only.** We attach to the specific Meet tab that initiated activation
  (`_sender.tab.id`) — never to other tabs, windows, or sites.

## 4. User-visible signal

While the debugger is attached, Chrome displays its standard
**"Gememo started debugging this browser" / DevTools** infobar at the top of the
window. The user is therefore always visibly informed whenever the permission is
in use, and the infobar disappears as soon as we detach.

## 5. What we are NOT doing

To be explicit about the surface we deliberately do **not** touch:

- **No `Runtime.evaluate`** — we never execute arbitrary JavaScript in the page.
- **No `Network.*`** — we never observe, intercept, or modify network traffic.
- **No `Page.*` / DOM content access** — we never read page content, the DOM
  tree, cookies, or screenshots via the debugger.
- **No persistence** — the attachment lives only for the click sequence.
- **No other tabs or origins** — strictly the current `meet.google.com` tab.

In short: the `"debugger"` permission is used purely to synthesize a single
**trusted mouse gesture** on Google Meet's own "Start now" control, on the Meet
tab, with the user informed by Chrome's infobar, and nothing more.
