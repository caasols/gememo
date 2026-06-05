# Chrome Web Store listing — Gememo

Draft copy + submission notes for **RB-2c** (Chrome Web Store / Edge Add-ons publishing).
The `debugger` permission *will* draw manual-review scrutiny — the justifications
section below is written to pre-empt the reviewer's questions. Keep this file in sync
with the README positioning ("Why bot-free & no lock-in").

---

## Item name (max 75 chars)

```
Gememo — Bot-free AI Meeting Notes for Google Meet
```

## Short description / summary (max 132 chars)

> Shown in search results and the install header. Must be ≤132 characters.

```
Bot-free Google Meet notes. Captures Meet's own Gemini summary when you leave — saved to Craft, Obsidian or Apple Notes. No audio, no cloud.
```

(131 characters.)

Alternate, punchier:

```
AI meeting notes with no bot in your call. Gememo files Meet's own Gemini summary to your notes app when you leave. Private by design.
```

(130 characters.)

## Category

`Productivity` (primary). Secondary intent: Workflow & Planning.

## Language

English (add localized listings later if traffic warrants).

---

## Detailed description (max 16,000 chars)

```
Gememo turns Google Meet's built-in Gemini summary into clean, saved meeting notes — automatically, the moment you click Leave. No bot joins your call, no audio is recorded, and nothing is sent to a third-party server.

━━━━━━━━━━━━━━━━━━━━━━━━━
HOW IT'S DIFFERENT
━━━━━━━━━━━━━━━━━━━━━━━━━

Most AI note-takers send a bot into your meeting to record everyone, then process that audio on their own servers. Gememo doesn't. It reads the summary that Google's own Gemini already produced inside your meeting — the host's existing, in-product AI — and saves the text to the note app you already use.

• NO BOT — nothing joins your call or shows up in the participant list.
• NO AUDIO — Gememo never records or uploads any audio.
• NO VOICEPRINT — no biometric processing of any participant.
• NO CLOUD ACCOUNT — no sign-up, no API key, no subscription.
• NO LOCK-IN — your notes are plain Markdown files you own, saved where you choose.

━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT IT DOES
━━━━━━━━━━━━━━━━━━━━━━━━━

• Automatic capture — when you click Leave, Gememo grabs the full Gemini summary and saves it silently in the background, without stealing focus.
• Periodic snapshots — captures the running summary every few minutes so nothing is lost if something goes wrong at leave time.
• Structured notes — Attendees, Summary, Key Points, Decisions, Action Items, Next Steps, Open Questions. Fully customizable.
• Built-in templates — Standup, 1:1, and Retro formats auto-applied by meeting title.
• Per-meeting rules — match a meeting title (or a time of day) to use a different prompt.
• Recurring-meeting context — last session's summary and open action items carry forward.
• Any language — write notes in your language while preserving names and technical terms.
• Action-item checklist — extracted into the popup, copyable as Markdown tasks.
• Local search — full-text search across your saved notes, on your machine.

━━━━━━━━━━━━━━━━━━━━━━━━━
WHERE YOUR NOTES GO
━━━━━━━━━━━━━━━━━━━━━━━━━

Craft · Apple Notes · Obsidian (plain .md with YAML frontmatter) · or any webhook (Zapier, n8n, Make, your own endpoint). Optionally keep a local Markdown backup of every note.

━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━

• macOS (a small native helper saves notes via your note app).
• Google Chrome.
• A Google Workspace account with Gemini in Google Meet enabled.
• Python 3.9+ (for the one-time native-host install).

Gememo is open source (MIT). See the GitHub repository for the code, the install steps, and the full changelog.

━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━

Gememo reads only the Gemini summary text inside meet.google.com and passes it to a native helper on your own machine. It does not record audio, does not collect biometrics, does not use analytics, and sends nothing to any Gememo server (there isn't one). See the privacy policy linked below.
```

---

## Single-purpose description (required field)

```
Gememo has one purpose: to capture the text summary that Google Gemini generates inside a Google Meet call and save it as a formatted note to the user's chosen note-taking app on their own computer.
```

---

## Permission justifications (required at submission)

Reviewers ask for a per-permission justification. `debugger` is the sensitive one —
answer it head-on.

| Permission | Justification |
|---|---|
| **`nativeMessaging`** | Saving a note to a desktop app (Craft, Apple Notes, Obsidian) and writing local Markdown backups requires a native helper on the user's machine. The extension communicates with it only to hand off the captured note text. No network server is involved. |
| **`debugger`** | Google Meet's UI ignores synthetic (`isTrusted=false`) events for the Gemini panel controls, so the extension cannot open Gemini's summary panel with ordinary `click()`/`dispatchEvent`. It uses the Chrome DevTools Protocol (`Input.dispatchMouseEvent`) **only** to produce the trusted hover/click that opens the Gemini panel on `meet.google.com`. The debugger is attached for a few seconds during activation and detached immediately after. It is never used on any other site and never inspects or modifies page data. |
| **`tabs`** | To detect which tab is an active Google Meet call, scope per-tab capture state, and clean up state when a meeting tab closes. |
| **`storage`** | To persist user settings (prompt, rules, output app, language) and recent activity logs locally. No data leaves the device. |
| **`host_permissions: https://meet.google.com/*`** | The extension only runs on Google Meet. It reads the Gemini summary text from the meeting page; it does not run anywhere else. |

**Data usage disclosures (Web Store form):**
- Does the extension collect user data? **It handles meeting-note text locally; it does not transmit it to the developer.** Select the data types accurately (e.g. "Personal communications" if the note text qualifies), and check **not sold to third parties**, **not used for unrelated purposes**, **not used for creditworthiness/lending**.
- A hosted **privacy policy URL** is mandatory once any user-data box is checked. Draft one (a short page stating: reads only the Meet Gemini summary, processes on-device via the native host, no servers/analytics, user controls destinations).

---

## Pre-submission checklist

- [ ] Privacy policy page published (URL required for the data-usage form).
- [ ] `debugger` justification (above) pasted into the permission-justification field.
- [ ] Screenshots: 1280×800 or 640×400 — popup (Main, Rules, Settings), a captured note in Craft/Obsidian, the in-Meet toast. (At least 1, up to 5.)
- [ ] Small promo tile 440×280 (optional but recommended).
- [ ] Icon set present in `manifest.json` (Store requires 128×128).
- [ ] Note the macOS + native-host requirement prominently in the description (reviewers test on the listed platform; set expectations so it isn't rejected as "broken").
- [ ] Decide visibility: **Unlisted** first (share by link, sidestep broad review friction) → **Public** once the `debugger` justification clears.
- [ ] Edge Add-ons: same package; reuse this copy and justifications.

## Notes / risks

- The `debugger` permission is the single biggest review risk. If the reviewer pushes back, the fallback positions are: (a) ship **Unlisted** (lighter scrutiny), or (b) gate the CDP activation behind an explicit user action and document that the panel can be opened manually without `debugger` (degraded UX, but removes the permission from the critical path).
- Keep the listing's privacy claims identical to the README and the privacy policy — inconsistencies between them are a common rejection reason.
