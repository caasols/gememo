# Changelog

All notable changes to Gememo are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## The story so far

Gememo started as a single-file proof-of-concept that could leave a Google Meet call and save a Craft note. By v0.1.84 it has a full prompt pipeline, three output destinations, offline DOM tests, CI, and a retry system for failed sends. The sections below trace that arc.

---

## [0.1.92] – 2026-06-04 · Meet metadata frontmatter (P9-A3a/b)

### Added
- **Meeting code in frontmatter (P9-A3a)** — the Meet room code (e.g. `abc-defg-hij`) is extracted from the URL path at join via the new pure `extractMeetingCode()` and written as `meeting_code:` in every `.md` backup. Useful for dedup and recurring-meeting correlation.
- **Meeting type inference (P9-A3b)** — each meeting is classified `calendar` vs `ad-hoc` via the new pure `inferMeetingType()` (calendar = has a human title; ad-hoc = empty title / room code / personal-meeting label) and written as `meeting_type:` frontmatter.
- Both values are cached at meeting join in `content_meet.js`, passed through `background.js` to the native host, and added to `build_yaml_frontmatter()` (omitted when empty). 8 new JS tests + 4 new Python tests.

---

## [0.1.91] – 2026-06-04 · Code-review bugfix bundle + test hardening

### Fixed
- **Native-host error status was invisible in the popup** — `forwardToNativeHost`'s `chrome.runtime.lastError` branch wrote the global `mm2c_last_status` key, but the popup reads the tab-keyed `mm2c_last_status_<tabId>`. Native-messaging failures now write the tab-keyed key (with global fallback) so the error shows in the popup banner.
- **Dash-strip regex mangled 4+ dash lines** — `^-{3,}(?=\S)` greedily back-tracked on `----`/`-----` separator lines, leaving an orphan `-`. Tightened to `^-{3,}(?=[^\s-])` in `meeting_minutes_host.py` and the new extracted `normalize_headings()` in `push_to_craft.py`.
- **Status-banner race in the popup** — `onTabSelected` and `applyState` both wrote `#status` from independent async callbacks. Centralised into a pure `resolveBanner()` in `constants.js`; `applyState` is now the sole writer.
- **Log-tab retry never cleared its card** — failed-send retry/dismiss keyed on `tabId`, but the log-retry path carries no tabId. Switched user-action identity to `backupPath` via `removeFailureByPath()`; `tabId` retained for per-tab dedup and tab-close cleanup.
- **Apple Notes integration tests launched the app on every run** — `TestPushToAppleNotesIntegration` was gated by `skipUnless(HAS_OSASCRIPT)`, which never skips on macOS, so every `npm run test:all` fired `osascript` at Notes. Now opt-in behind `GEMEMO_NOTES_INTEGRATION=1`.

### Changed
- Removed a dead global `mm2c_last_status: ''` write in `content_meet.js` (nothing reads that key).
- Converted legacy `console.assert` checks in `testTabState` to the enforced `assert()` helper so the U7 tab-state regression tests are actually counted by the runner.
- Tests: +4 Python (dash regex), +12 JS (`resolveBanner`, `removeFailureByPath`), +10 JS (now-enforced tab-state checks).

---

## [0.1.90] – 2026-06-03 · U7 Multiple simultaneous meetings

### Added
- **U7 multi-meeting support** — two concurrent Google Meet tabs now capture independently. All live-state storage keys (`mm2c_capture_state`, `mm2c_last_snapshot`, `mm2c_last_status`, `mm2c_last_fingerprint`) are now tab-scoped (`_<tabId>` suffix). Content scripts send `MM2C_SET_CAPTURE_STATE` / `MM2C_SET_SNAPSHOT` messages instead of writing storage directly. `mm2c_last_failed` replaced by `mm2c_failed_list` array — popup shows one retry card per failed meeting. Popup resolves the active Meet tab on open; shows a meeting picker when 2+ Meet tabs are open and none is focused. `chrome.tabs.onRemoved` cleans up orphaned keys automatically.

---

## [0.1.89] – 2026-06-03 · Apple Notes formatting + Meet DOM audit

### Fixed
- **UX-1 Apple Notes formatting** — `body_to_html()` now emits one `<p>` per prose line instead of concatenating consecutive lines into one paragraph; attendee names, action item owners, and Key Points entries each render as distinct paragraphs with proper visual separation; no empty `<p>` or `<ul>` emitted for missing sections. 5 new tests added.

### Added
- **P9-A3 Meet DOM audit** — investigated all candidate metadata fields; confirmed feasible: meeting code (`window.location.pathname`), meeting type inference (room-code pattern), recording state (DOM indicator); not feasible from DOM: agenda/description (requires Calendar OAuth), Gemini language (model-internal), host identity (not exposed). Three new ROADMAP implementation items: P9-A3a (meeting code), P9-A3b (meeting type), P9-A3c (recording state).

---

## [0.1.88] – 2026-06-03 · Formatting fixes for recovery and `---Heading` artifacts

### Fixed
- **Backup file recovery** — `push_to_craft.py` now strips YAML frontmatter (added by `build_yaml_frontmatter`) before pushing to Craft; previously the frontmatter rendered as bold text at the top of every recovered note
- **`---Attendees` artifact** — `parse_transcript` now strips leading `---` dashes from section headings before the normalisation regex runs; Gemini occasionally copies the `---Heading` delimiter pattern from `EXAMPLE_NOTES` and writes `---Attendees` as a single token — it now becomes `## Attendees` correctly
- **`Next Steps` heading** — added to the heading normalisation regex so Gemini-produced `Next Steps` lines are promoted to `## Next Steps` (was missing from the regex despite being in the prompt)

---

## [0.1.87] – 2026-06-03 · Craft push `%` bug fix

### Fixed
- **BUG-1 (partial)** — `%` characters in note content (e.g. "50% of traffic") silently prevented Craft from creating the document. Root cause: macOS `open` decodes `%25` (the URL-encoding of `%`) back to a bare `%` before handing the URL to Craft; Craft's URL parser then sees `%` not followed by valid hex and silently aborts. Fix: pre-escape `%` as `%25` in `push_to_craft.py` before calling `quote()` so the double-decode lands correctly. Any note containing a percentage sign now reaches Craft. Added `BUG-7` to ROADMAP for cross-domain Gemini meeting captures (e.g. joining a Monzo-hosted meeting with a personal Google account).

---

## [0.1.84] – 2026-06-01 · Log hygiene, install rename, room code labels

### Added
- **CI** — GitHub Actions workflow running `npm run test:all` on every push (`ubuntu-latest`, Node 20, Python 3.11)
- **CHANGELOG** — full version history from v1.0.0 to present in keepachangelog format
- **README** — rewritten in project style: badges, one-liner + differentiator, feature bullets with bold label/em-dash, output app table, config table, numbered troubleshooting

### Fixed
- **UX-5a** — personal Meet room codes (e.g. `ecj-jduu-oez`) now show as `"Personal meeting (ecj-jduu-oez)"` in logs and YAML frontmatter instead of a raw unreadable code
- **UX-5b** — removed "Switched to Meet tab — not in a meeting" log entries; non-meeting tab visits no longer generate log noise or create a spurious "Google Meet" log group
- **BUG-5** — `install.sh` renamed install directory from `MeetingMinutesToCraft` → `Gememo`; switched from file copies to symlinks so changes to `meeting_minutes_host.py` and `push_to_craft.py` in the project directory propagate automatically without re-running install; old directory removed on upgrade

---

## [0.1.83] – 2026-06-01 · Snapshot timing fix

### Fixed
- **BUG-2 premature catch-up snapshot** — when `lastSnapshotAt` was `0` (no snapshot yet), the `visibilitychange` catch-up computed elapsed time as `Date.now() - 0` ≈ 1.7 trillion ms, always ≥ the 4-minute threshold, so the first tab switch after joining triggered an immediate snapshot of the social small talk at the start of the meeting. Fix: seed `lastSnapshotAt = meetingJoinedAt` when the meeting starts so the catch-up doesn't fire until real meeting time has elapsed.

---

## [0.1.82] – 2026-06-01 · Craft push rewritten

### Fixed
- Replaced `craftdocs://x-callback-url/importDocument?filePath=…` (which requires Craft to read a file from disk — blocked by macOS sandbox in Craft 3.4.x) with `craftdocs://createdocument?content=…` (inline percent-encoded markdown, no file access needed). This is the correct URL scheme per Craft's own documentation and removes all staging, callback server, and sandbox complexity.

---

## [0.1.81] – 2026-06-01 · Craft sandbox investigation

### Fixed
- Identified that Craft 3.4.x cannot read files outside its sandbox container. Attempted workaround: stage note file in Craft's group container before firing the import URL. (Superseded by v0.1.82.)

---

## [0.1.80] – 2026-06-01 · Craft fire-and-forget

### Fixed
- Removed the 10-second blocking wait in `push_to_craft.py` — the x-callback-url callback Craft was supposed to call never arrived, causing the native host to hang and Chrome to kill the native messaging connection ("Native host has exited"). Fire-and-forget eliminates the wait. (Superseded by v0.1.82.)

---

## [0.1.79] – 2026-06-01 · Retry failed sends

### Added
- **`choose_retry_file()`** — pure function that picks the freshest available content for a retry: the CACHE_DIR copy (full final capture, if < 2 hours old) or the snapshot backup file on disk.
- **`handle_retry` message type** in the native host — runs `push_to_craft.py` with the chosen file and returns `{source: 'cache'|'backup'}`.
- **`MM2C_RETRY` handler** in `background.js` — sends retry to native host, clears `mm2c_last_failed` on success, logs result.
- **`mm2c_last_failed` storage** — written when a native host error response includes a backup path; cleared on retry success or user dismiss.
- **Retry widget in Main tab** — red banner showing the failed meeting title, "Notes are safe", Retry → and × dismiss buttons.
- **Per-entry Retry chip in Logs tab** — inline button on any error log entry whose message contains "backup at …"; uses `entry.title` and the extracted backup path.

---

## [0.1.78] – 2026-06-01 · YAML frontmatter enrichment

### Added
- `build_yaml_frontmatter()` gains `attendees` (YAML block list, one name per line) and `duration_min` (integer minutes, computed from `meetingJoinedAt`). Both fields are passed from `content_meet.js` through `background.js` to the native host in the `MM2C_RESPONSE` payload. Both are omitted when empty or `None` — backward-compatible with all existing callers.

---

## [0.1.76] – 2026-05-31 · Obsidian output + Apple Notes formatting + first-snapshot ETA

### Added
- **Obsidian output** — vault folder picker in Settings (reuses the existing folder-picker osascript); writes YAML-frontmatted `.md` files directly to the vault folder; Obsidian watches the folder and picks them up automatically. Enabled in the output dropdown.
- **U6 first-snapshot ETA** — `firstSnapshotAt` added to `MM2C_STATUS_QUERY` response; popup shows "First snapshot in: Xm Ys" in the snapshot widget from meeting join until the first snapshot fires.

### Fixed
- **UX-1 Apple Notes formatting** — `body_to_html()` now skips `---` separator lines (Gemini was copying them from the few-shot example delimiters) and adds `<br>` before all but the first `<h2>` heading for visual section spacing. `parse_transcript()` also strips `---` lines so backup files and Craft notes are clean.

---

## [0.1.75] – 2026-05-31 · About tab + output-aware toasts

### Added
- **UX-3 About tab** — 5th tab in the popup; shows version number (from manifest), GitHub link, extension ID with one-click copy, and a donation placeholder.
- **UX-4 output-aware toasts** — `outputAppName()` helper maps storage keys to display names (`craft` → "Craft", `apple_notes` → "Apple Notes", etc.). All four hardcoded "Saved to Craft" strings in `content_meet.js` and the dest label in `background.js` now use this helper. Toasts say "Saving to Apple Notes…" / "✓ Saved to Apple Notes" when Apple Notes is selected.

---

## [0.1.74] – 2026-05-31 · Snapshot timer anchored to meeting join

### Fixed
- The periodic snapshot `setInterval` started from extension load, not meeting join. Depending on when the tab was opened, the first snapshot could fire anywhere from 8 to 16+ minutes into a meeting. Fixed by replacing the drift-guarded `setInterval` with a meeting-join-anchored recursive `setTimeout` started when `attachInterceptor()` fires: first snapshot fires exactly `snapshotIntervalMs` after joining, every subsequent snapshot exactly `snapshotIntervalMs` later.

---

## [0.1.73] – 2026-05-31 · Apple Notes output

### Added
- **Apple Notes output** — `body_to_html()` converts the plain-text note body to Apple Notes–compatible HTML (`<h2>` headings, `<ul>/<li>` bullets, `<p>` paragraphs); `push_to_apple_notes()` writes the HTML body to a temp file and imports it via `osascript` (avoids inline AppleScript string-escaping issues); `route_output()` in the native host branches on `backupType`. Apple Notes enabled in the output app dropdown. `background.js` now reads `mm2c_output_app` from storage instead of hardcoding `'craft'`.

---

## [0.1.72] – 2026-05-31 · YAML frontmatter in backup files

### Added
- `build_yaml_frontmatter()` prepends a YAML front-matter block to every `.md` backup file — `date`, `title`, `source: google-meet`, `tags: [meeting, YYYY/MM]`. Snapshot files also get `snapshot: true`. `.txt` files and Craft note content unchanged. Unlocks Obsidian Dataview, Bear metadata, and Notion property mapping without any user action.

---

## [0.1.71] – 2026-05-31 · Attendee injection, badge, snapshot countdown

### Added
- **P5-J attendee injection** — `getAttendeeNames()` reads participant name labels from the Meet video grid (three fallback selectors); prepends a numbered attendee list to the Gemini prompt so action items are attributed correctly.
- **P6-A extension badge** — `storage.onChanged` listener in `background.js` sets the toolbar icon badge to green 'REC' when `mm2c_capture_state` changes to `'capturing'`. Existing 'OK' and '!' handlers on response/error unchanged.
- **U5 snapshot countdown** — `lastSnapshotAt` lifted to module scope; `nextSnapshotAt` added to `MM2C_STATUS_QUERY` response; popup shows "Next in: Xm Ys" in the snapshot widget.

---

## [0.1.70] – 2026-05-31 · Prompt quality batch 2

### Added
- **P5-B** — Action Items: pronoun ban ("never write 'I' or 'they'") + "no deadline set" fallback.
- **P5-C** — Hallucination guard: ban vague filler phrases ("the team discussed"), forbid invented facts, omit headings with no content.
- **P5-A1** — Open Questions extended to include risks and concerns raised during the meeting, not just unanswered questions.
- **P5-A2** — New "Next Steps" section for shared calendar commitments (meetings, demos, reviews) distinct from individual action items.
- **P5-G** — `EXAMPLE_NOTES` constant (~200 words): a model note prepended to every prompt as a few-shot anchor showing the expected format, detail level, and section structure.

---

## [0.1.69] – 2026-05-31 · Prompt quality batch 1

### Added
- **P5-D** — Adaptive summary length: 1–2 sentences for short meetings, 3–4 for longer ones.
- **P5-E** — Decision signal guard: only classify something as a decision if the transcript contains explicit agreement language ("we decided", "we agreed", "it was confirmed", etc.).
- **P5-F** — Short meeting fallback: if the transcript contains very little content, a single brief paragraph is sufficient — no empty section headings.
- **P5-H** — Meeting title context: the meeting title is prepended to the prompt ("Meeting title: X. Use this context to interpret references…").
- **P5-I** — Proper noun protection: the language prefix is extended to preserve attendee names, product names, and technical acronyms in their original form even when notes are written in another language.

---

## [0.1.68] – 2026-05-31 · Back-to-back meeting dedup fix

### Fixed
- `mm2c_last_fingerprint` changed from a `title|date` string to `{title, sentAt}`. A send is now skipped only if the same title sent notes within the last 40 minutes — preventing the second meeting of the day in a personal Meet space from being silently dropped while still preventing duplicate sends on accidental rejoins.

---

## [0.1.66] – 2026-05-30 · UI polish and copy consistency

### Changed
- 9 new CSS custom properties replace all hardcoded colour values; font-size scale corrected; 20+ copy rewrites for consistent voice and clearer status messages.

---

## [0.1.65] – 2026-05-30 · Popup redesign

### Changed
- New 4-tab popup: **Main** (enable toggle, status, host, snapshot widget), **Rules** (default prompt + meeting rules), **Settings** (frequency, language, output app, backup), **Logs** (grouped by meeting). Cleaner information hierarchy.

---

## [0.1.64] – 2026-05-30 · Output app selector

### Added
- "Save to note-taking app" dropdown in Settings: Craft and None are selectable; Obsidian, Notion, Apple Notes, Google Docs, Bear, Evernote are shown greyed-out as coming-soon options. `mm2c_output_app` storage key.

---

## [0.1.63] – 2026-05-29 · Three correctness fixes

### Fixed
- Meeting title timestamps now use local time instead of UTC (`datetime.fromisoformat().astimezone()`).
- Snapshot timer drift: `meetingJoinedAt` anchors the first snapshot to meeting join time; `takePeriodicSnapshot` skips the tick if a full interval hasn't elapsed since joining.
- Citation stripping: a second regex pass handles edge cases like `Sol1`, `."1` (digit directly after a letter or closing quote at end of line).

---

## [0.1.61–0.1.62] – 2026-05-28 · CDP automation: fully trusted events

### Added
- **v0.1.61** — CDP hover automation: `chrome.debugger` + `Input.dispatchMouseEvent` replaces the "hover over ✦" guidance toast. The extension now programmatically hovers to reveal the "Start now" tray and clicks it — completely automatic, no user interaction required.
- **v0.1.62** — CDP click modes: `MM2C_CDP_CLICK_KEEP` (click without detaching the debugger) added for the panel toggle, which also requires `isTrusted=true`; full State 1→2→3 activation now uses only CDP trusted events throughout.

### Changed
- `"debugger"` permission added to `manifest.json` — required for `chrome.debugger` attach/detach cycle.

---

## [0.1.59–0.1.60] – 2026-05-27 · Gemini activation rewrite

### Fixed
- **v0.1.59** — Complete `autoActivateGemini` rewrite based on live DOM inspection: 3-state machine (not-started / started+closed / open), `waitForActiveGeminiButton` helper, State 2→3 via direct click of `button[aria-label="Gemini"]`, State 1→2 via ArrowDown keyboard shortcut with guidance toast fallback. `waitForPanelVisible` uses MutationObserver + IntersectionObserver instead of polling.
- **v0.1.60** — Leave now always attempts a fresh 60-second Gemini capture first; falls back to `cachedTranscript` only on failure. The old "use cache directly" path was silently losing the last minutes of discussion.

---

## [0.1.54–0.1.58] – 2026-05-26 · Hotfix series

### Fixed
- **v0.1.54** — `observer` variable scoping bug: declared `const` inside `.then()` callback but referenced at IIFE scope, causing `ReferenceError` on meeting join.
- **v0.1.55** — Same root cause for `observedNode`.
- **v0.1.56** — "Start now" regex `/^start now$/i` broke on "⭐ Start now" emoji prefix; also fixed click-order: check for "Start now" before clicking trigger (clicking trigger dismisses the popup).
- **v0.1.58** — Correct Gemini trigger button: the star toggle ("Geminispark_off") was being confused with "Take notes with Gemini" (a different feature); `waitForPanelVisible` now uses MutationObserver instead of rejecting immediately when the input isn't yet in the DOM.

---

## [0.1.50–0.1.53] – 2026-05-25 · Power features

### Added
- **v0.1.50** — Prompt routing: `mm2c_prompt_rules [{regex, prompt}]`; first match wins; fallback to `DEFAULT_PROMPT`. Rules tab in popup with add/delete/reorder.
- **v0.1.51** — Configurable snapshot interval: `mm2c_snapshot_interval_min` (default 8 min, range 3–30); read at meeting join; Settings numeric input.
- **v0.1.52** — Popup layout fixes: `body` fixed to `height:580px`; tab switching no longer resizes the popup window.
- **v0.1.53** — Capture button state: button disables with "Open Gemini first" tooltip when Gemini is inactive; re-enables automatically when Gemini activates.

---

## [0.1.49] – 2026-05-24 · Note language

### Added
- `mm2c_note_language` storage key; `_runGeminiFlowInner` prepends "Write all notes in [LANGUAGE]. Preserve proper nouns…" when set. Settings dropdown with 7 language presets + Other.

---

## [0.1.41–0.1.48] – 2026-05-23 · Observability and UX polish

### Added
- **v0.1.41** — "Capture now" button: shown at the bottom of the popup when in a meeting; triggers `takePeriodicSnapshot()` immediately.
- **v0.1.42** — Snapshot preview: "Last snapshot: N min ago ▸" with expandable preview of first 300 chars.
- **v0.1.43** — `beforeunload` guard: overlay only mounts when still on the Meet page (prevents ghost overlays after navigation).
- **v0.1.44** — Popup auto-refresh: `queryMeetingState()` called every 10 seconds while popup is open; status stays current during long captures.
- **v0.1.45** — Logs: cap raised 50 → 200 entries; "Download" button exports as JSON.
- **v0.1.46** — Toast position: computed from toolbar height instead of hardcoded `120px`; doesn't overlap on smaller displays.
- **v0.1.47–v0.1.48** — Test coverage: `autoActivateGemini` and `visibilitychange` catch-up logic fully covered with injectable dependencies.

---

## [0.1.38–0.1.40] – 2026-05-22 · Note quality

### Fixed
- **v0.1.38** — Plain-text enforcement: `DEFAULT_PROMPT` bans asterisks, underscores, backticks; `parse_transcript()` strips `**bold**` and `` `code` `` markers that Gemini produces despite the instruction.
- **v0.1.39** — Heading detection: regex now handles `## Name`, `**Name**`, `Name:`, and case variants so all six section headings promote correctly to Craft headings regardless of Gemini's formatting.
- **v0.1.40** — Regeneration guard: `waitForResponseComplete` now checks for the "Stop generating" button before resolving; if present, resets the stability clock and keeps waiting.

---

## [0.1.31–0.1.37] – 2026-05-21 · Reliability batch 2

### Fixed
- **v0.1.31** — All polling loops replaced with observer-based waits (`IntersectionObserver` for panel visibility, `MutationObserver` for submit button, `waitForGeminiTrigger`, `waitForStartNowButton`). Eliminates background-tab timer throttling across the entire injection flow.
- **v0.1.32** — Short meeting live fallback: `captureProactively()` now attempts a live 60-second Gemini run when there's no cached transcript (e.g. meeting under 8 minutes or Gemini deactivated before first snapshot).
- **v0.1.33** — Promise-based flow mutex replaces the `geminiFlowLock` boolean; `onLeaveClick` awaits snapshot completion naturally without a force-reset deadline. Resolves a race condition where both flows could write to `cachedTranscript` concurrently.
- **v0.1.34** — Deduplication: `MM2C_RESPONSE` checks `chrome.storage.session` for a `meetingTitle|date` fingerprint before forwarding; duplicate sends (e.g. from "Save & leave" overlay + auto-capture race) are skipped with a warn log.
- **v0.1.35** — Admin-disabled detection: after clicking the Gemini trigger, `autoActivateGemini` polls 5 seconds for the panel to appear; if it doesn't, shows a persistent "Gemini may be disabled for your account" warning.
- **v0.1.36** — Snapshot backup to disk: `takePeriodicSnapshot` fires `MM2C_SNAPSHOT`; `background.js` forwards to native host when file backup is enabled; `handle_snapshot` writes `YYYYMMDD-HHMMSS-{slug}-snap.md`; `prune_snapshots` keeps last 3 per meeting.
- **v0.1.37** — Craft failure detection: `push_to_craft.py` starts a local HTTP server for the x-callback-url confirmation signal; failure triggers a retry with the most recent snapshot file; backup path surfaced in popup on persistent failure.

---

## [0.1.22–0.1.30] – 2026-05-20 · Code hygiene and observability

### Changed
- **v0.1.22** — Tests synced with production two-path injection logic (Path A: `execCommand` + read-back; Path B: direct `textContent` fallback).
- **v0.1.23** — `DEFAULT_PROMPT` extracted to `extension/constants.js`; no longer duplicated in `content_meet.js` and `popup.js`.
- **v0.1.24** — `extractLastResponseFromEl()` extracted to `constants.js`; no longer duplicated in `content_meet.js` and `tests.js`.
- **v0.1.25** — `MutationObserver` narrowed from `document.body` to `div[aria-label="Call controls"]`; 200 ms debounce on `attachInterceptor`.
- **v0.1.26** — `mm2c_capture_state` storage key; popup shows "Capturing notes…" in real time via `storage.onChanged`.
- **v0.1.27** — `appendLog` burst protection: `pendingLogs[]` buffer + 100 ms debounce flushes as a single batched write, preventing concurrent `get→set` pairs from dropping entries.
- **v0.1.28** — Snapshot age logged at Leave time; warning toast if snapshot > 15 minutes old.
- **v0.1.29** — Logs grouped by meeting: `groupLogs()` buckets entries by title; collapsible log-group sections in popup.
- **v0.1.30** — Version negotiation: `HOST_VERSION` in native host ping response; popup warns on major-version mismatch with link to reinstall.

---

## [0.1.19–0.1.21] – 2026-05-17 · Reliability group A

### Fixed
- **v0.1.19** — `autoActivateGemini` fully rewritten: per-meeting `panelAutoOpened` flag, async `geminiActivating` lock, late-appearing Gemini button handled by MutationObserver. `resetMeetingState()` added and called on back-to-back meeting transitions. `push_to_craft.py` switched from inline-content URL to `craftdocs://x-callback-url/importDocument?filePath=…` (no URL length limit). Native host writes notes to `~/.cache/mm2c/` instead of a temp file.
- **v0.1.20** — Two-step activation: after clicking the Gemini toggle, waits for the "Start now" card and clicks it if the panel is in the greyed-out unstarted state.
- **v0.1.21** — `getGeminiTriggerElement()` two-probe helper detects both `button[aria-label*="Gemini"]` and the `DIV[role="button"]` "Take notes with Gemini" pre-activation entry point.

---

## [0.1.13–0.1.18] – 2026-05-14 · Prompt injection hardening

### Fixed
- **v0.1.13** — `waitForResponseComplete` rewritten to `MutationObserver`; eliminates background-tab timer throttling on the response-completion wait.
- **v0.1.14** — Citation regex, retry logic in `onLeaveClick` (3 attempts, 3s backoff), attendee name cleaning, `choose_folder` timeout, and several smaller fixes.
- **v0.1.15** — `injectPromptWithVerification`: verified `execCommand` with `textContent` read-back + `waitForForeground` monitor; `InjectionTimeoutError` fallback to `cachedTranscript`.
- **v0.1.16–v0.1.18** — Three iterations fixing the injection verification logic: `querySelector` vs `isInViewport`, 200 ms re-fetch after `delete`, and finally the root cause — `textContent.trim()` non-empty check (the earlier `startsWith` check always failed because `textContent` strips `\n\n` block-element newlines).

---

## [0.1.10–0.1.12] – 2026-05-13 · Submit and snapshot polish

### Fixed
- **v0.1.10** — Enter key dispatch replaces `submit.click()` to bypass `isTrusted=false`.
- **v0.1.11** — Gemini panel auto-opens at meeting join.
- **v0.1.12** — Snapshot toast shows "✓ Notes snapshot saved"; auto-dismisses on success, clears on error.

---

## [0.1.0–0.1.9] – 2026-05-11 · Core capture pipeline

### Added
- **v0.1.0** — Close guard overlay: intercepts Cmd+W, tab close, and navigation away from a meeting page.
- **v0.1.1** — `MutationObserver` watches for the Leave button appearing/disappearing; `captureProactively()` fires when Gemini deactivates mid-meeting.
- **v0.1.2** — Attendee trailing number stripping: `Carlos Sol1` → `Carlos Sol` in native host.
- **v0.1.3** — `isInViewport()` check prevents off-screen Gemini panel from being treated as open.
- **v0.1.4** — `geminiFlowLock` mutex; periodic snapshots every 10 minutes.
- **v0.1.5** — Extension awaits Craft confirmation before clicking Leave (20-second timeout).
- **v0.1.6** — Submit button enable polling (100 ms intervals, 3-second max).
- **v0.1.7** — `runGeminiFlow` timeout parameter; snapshot timeout 90 seconds; Selection API cleared before `insertText`.
- **v0.1.8** — Background-tab snapshot guard (`document.hidden`); `visibilitychange` catch-up snapshot; `cachedTranscript` used directly on Leave when snapshot is fresh.
- **v0.1.9** — MutationObserver guard for auto-ended meetings (`|| geminiWasActive`); meeting title cached at join so it's available after the DOM clears.

---

## [1.0.0] – 2026-05-01 · Initial release

### Added
- Leave button intercept via `click` event capture on `button[aria-label="Leave call"]`.
- Gemini flow: open panel → inject `DEFAULT_PROMPT` → wait for streaming to complete → extract response.
- Native messaging host (`meeting_minutes_host.py`): receives transcript, parses sections, pushes to Craft via `craftdocs://` URL scheme.
- Periodic snapshots every 10 minutes.
- Close-guard overlay preventing accidental tab closure during a capture.
