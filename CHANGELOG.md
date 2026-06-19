# Changelog

All notable changes to Gememo are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## The story so far

Gememo started as a single-file proof-of-concept that could leave a Google Meet call and save a Craft note. It now has a full prompt pipeline (built-in meeting templates, time/day rules, per-rule depth, recurring-meeting context, a custom glossary), three output destinations plus generic + Slack webhooks and multi-destination send, privacy controls (PII redaction, a capture blocklist), `.ics` export, searchable rich-metadata backups, an action-item checklist, usage stats, dark mode, accessibility, and a capture hotkey. Quality: CI, offline DOM + smoke tests, **97% native-host coverage**, **measured/guarded JS coverage** (`constants.js` ~99%), an extension E2E harness that loads the real unpacked extension headlessly, and a fake-Meet content-script E2E. The sections below trace that arc.

---

## [Unreleased]

### Changed
- **Google Calendar enrichment is now gated behind the Experimental (beta) flag.** It's an opt-in extra that adds the matching event's attendees/agenda to a note's frontmatter, but a persisted connection was running on every capture even with Experimental off — and an expired token could stall the save. Enrichment now runs only when **both** Calendar is connected **and** Experimental is enabled; with beta off it's never invoked. The Calendar widget already lived in the beta section of Settings.

### Fixed
- **Obsidian note titles keep ordinary punctuation (`%`, `&`, `:`, `()`, …).** The filename sanitizer was an aggressive allowlist that stripped everything except letters, numbers, spaces and hyphens — so a meeting like "Support 100% rollout … & … A/B" became "Support 100 rollout … AB" in Obsidian, even though Craft and the note's own `title` kept the full text. It now strips only genuinely-unsafe characters (path separators, the Windows-reserved set, control chars), so titles read like Craft shows them. (Host change → re-run `install.sh`.)
- **The native host no longer hard-crashes on an unexpected error.** If a capture hit an unhandled exception before its internal error handler (e.g. during parsing, redaction, or the file backup), the process exited on the traceback and Chrome surfaced the cryptic "Native host has exited" — the popup then showed a generic "something went wrong" with no detail. `main()` now wraps the whole dispatch in a last-resort guard that replies a single clean error and logs `replied status=uncaught`, so a recoverable failure never takes the process down. (Host change → re-run `install.sh`.)
- **A stalled Google Calendar lookup can no longer freeze a capture.** Calendar enrichment makes two network calls (token refresh + events query) through a client with no network timeout, so if either stalled, the whole capture hung right after parsing — no note written, no error, and the in-app "Send now" retry hit the same wall. Enrichment now runs under a hard 12-second wall-clock budget (a try/except can't interrupt a *hang*); on timeout or any error the note saves normally without the calendar fields, and the timeout is logged to the heartbeat. (Host change → re-run `install.sh`.)
- **Obsidian notes now get a readable title instead of a lowercased hyphen-slug.** Obsidian shows the filename as the note's title, so notes were titled `20260616-1129-trip-advisor-migration-discussion` — a machine slug. They're now named like Craft shows them, e.g. `20260616 11:29 Trip Advisor Migration Discussion` (real words and casing, a `HH:MM` time, illegal characters dropped). A long title is trimmed at a word boundary rather than mid-word. Internal backup/snapshot filenames still use the slug, so recovery is unaffected. (Host change → re-run `install.sh`.)
- **An Obsidian "additional destination" with a blank vault no longer silently does nothing.** The vault field's hint said "uses your vault if blank," but that fallback was never implemented — so if Obsidian wasn't your *primary* output (e.g. Craft primary + Obsidian as an extra), a blank row meant the host skipped Obsidian on every capture with no note, log, or notification. The host now makes that promise real: a blank Obsidian vault falls back to the global default and then to the vault auto-detected from Obsidian's own config (`obsidian.json`, preferring your open vault). Obsidian writes now also fire a "→ Obsidian" notification like the other destinations, and an unresolvable vault is logged instead of skipped silently. (Host change → re-run `install.sh`.)

### Changed
- **The About tab now leads with a "you've saved …" hero banner.** Once you've logged enough meetings (the same 24h threshold that earns the support ask), About opens with a headline — e.g. _"You've saved roughly **3h 12m** with Gememo"_ and _"42 notes saved across 18 meetings."_ — instead of burying that figure in a footnote. The support line below it is now just the Ko-fi ask, so the time isn't repeated. Inspired by VoiceInk's stats screen.
- **The Today tab now opens with one "living status" card instead of three separate boxes.** The status banner, the host line, and the snapshot widget used to stack as three disconnected panels; they're now a single card where Gememo speaks in the first person ("I'm in your meeting — I'll save your notes when you leave") with a pulsing dot and one compact detail line underneath — e.g. _"You've been here 12 min · 3 snapshots · next in 4m 4s."_ The chevron still expands the latest snapshot preview inline. Idle copy is the friendlier "I'm here whenever you need meeting notes."

### Internal (no behavior change)
- The host's destination tests no longer write into the real `~/.cache/mm2c`. The craft-branch tests in `test_destinations.py` mocked `subprocess.run` but not `CACHE_DIR`, so the staging-file write landed in the user's live cache (it left a stray `Q3 Planning.md`). `TestSendToDestinations` now redirects `CACHE_DIR` to a temp dir per test; verified a full `pytest` run leaves the real cache untouched.
- Status rendering is now driven by a single `_status` object + `renderStatus()` renderer (no more dual writers racing between `setHostStatus` and `applyState`), and the in-meeting detail line is a pure, unit-tested `meetingStatusDetail()` helper. Pruned the now-orphaned `formatSnapshotAge` helper.

---

## [0.2.18] – 2026-06-15 · Google Docs as a first-class output, leave-flow fixes & a UI/copy polish pass

### Internal (no behavior change)
- **In-meeting overlay CSS now uses one palette of CSS variables.** `content_meet.css` had the design-token hex values repeated across rules + a per-rule dark-mode block; it now defines `--mm2c-*` vars once (light) and flips them in a single `@media (prefers-color-scheme: dark)` block. Identical colors, far less duplication.

### Fixed
- **"Gemini wasn't active — no notes saved" no longer fires when a snapshot exists.** If the Gemini panel wasn't detectable at the moment you left *and* the in-memory cache was empty, the leave-capture gave up and warned "no notes saved" — even though the host had a fresh on-disk snapshot of the meeting. It now falls back to that snapshot (a new `recover_snapshot` host action files the latest one for the meeting) and only shows the warning when there's genuinely nothing to recover. (Host change → re-run `install.sh`.)
- **Clicking a link shared in Meet chat no longer drags you out of the call.** The in-call navigation guard treated *every* link click as "leaving" — so opening a URL from chat popped the "leave without notes?" prompt, and both of its buttons exited the meeting. Now links that open in a new tab (chat URLs are `target="_blank"`) and modifier/middle clicks pass straight through, and the prompt gained a **"Stay in meeting"** option to abort the leave entirely.

### Changed
- **Small CSS/markup tidy.** Extracted a repeated inline `display:flex;…;gap:6px` (the number-input + unit rows) into a reusable `.inline-row` class, and fixed a malformed `font-size` rule in `.field-error`. No visual change.
- **History tab is now wrapped in a card**, matching Today/Rules/Settings/About (the count + Developer-logs toggle form the header; the log list sits inside). Visual consistency only.
- **Copy consistency pass.** Standardized "Save and leave" (was mixed with "Save & leave"); dropped dev-jargon from user-visible log lines ("Proactive live capture…", "Periodic snapshot deferred…"); removed lingering "native host" / "install.sh" / internal-ticket jargon from a couple of statuses and hints; reworded the leave prompt to **"Save your notes before you go?"**; softened the no-notes message to **"No notes this time — Gemini didn't make a summary for this meeting."**; and made "notes" (vs "summary") the consistent term for the saved item.
- **Friendlier status on the Today tab.** The green status dot now gently pulses (a calm "alive" heartbeat; respects reduced-motion), the line speaks in Gememo's voice — **"I'm here whenever you need meeting notes."** (or "I'm not set up yet — click Set up…") — and the version number is gone from there; the status line is now pinned to the **top** of the Today tab (above the "Not in a meeting" banner). The native-host version now lives in **About**, next to the Extension ID.
- **Tidied the About tab.** "Your impact" stats now sit at the top; the app identity/version, GitHub + Report-issue links, Extension ID, and "Support on Ko-fi" are unified into one card; and **Run diagnostics** moved to Settings (it's a maintenance tool). Same controls, fewer cards.
- **Google Docs is now a first-class output — both Primary and an Additional destination.** Replaces the old "also create a Doc" toggle. Pick it as your **Primary output** (files each note straight to Google Docs; "not connected" surfaces as a capture error, like Obsidian without a vault), **and/or** add it under **Additional destinations** to send a Doc alongside another primary. A single **Google Docs connection** control (its own OAuth grant, separate from Calendar) appears whenever Google Docs is in use either way; it can't be both your primary and an extra (deduped). (As the primary, the created Doc's URL is recorded for a future "Open in Docs" History link.)
- **Renamed the "Output app" setting to "Primary output"** and removed the stale "Google Docs" entry from its "Coming soon" list. The dropdown is your single primary app; Additional destinations (incl. Google Docs) run alongside it — "Primary output" makes that relationship clear. Notion/Evernote remain under "Coming soon".

---

## [0.2.17] – 2026-06-13 · Privacy settings, Google Docs (main) & open saved notes from History

### Added
- **History auto-cleanup — delete activity entries older than N days.** Privacy settings → Activity history gains an **Auto-delete old entries** toggle + "…older than N days" (default 30, alongside the existing "Clear"). When on, History entries past the cutoff are pruned automatically — on new activity and when you open the popup. Off by default; only the in-extension activity log is affected (saved notes and on-disk backups aren't touched).
- **Open a saved note from History — Apple Notes (🧪 under testing, Beta).** When a note is saved to Apple Notes, the host now records the created note's id; the History row shows an **"Open ↗"** control (behind Experimental) that re-opens it in Apple Notes. If the note no longer exists, the host reports it and the extension drops the dead reference so it isn't offered again. Beta-gated until the AppleScript re-open is confirmed against a live Notes. (Host change → re-run `install.sh`.) Obsidian + Google Docs reuse the same mechanism next.

### Fixed
- **Additional destinations: rows with no config field no longer leave a gap.** An Apple Notes row (which has no folder/vault field) used to render as "dropdown … big gap … ✕". Now the dropdown fills the row so the remove (✕) button lines up with the other rows.

### Changed
- **Google Docs output is now a main feature (out of Beta).** "Create a Google Doc per note" + its Connect button moved from the Beta tab to **Settings → Google Docs output** (right after Additional destinations) and no longer requires Experimental. It still uses its own Google OAuth grant (separate consent + token; needs the Docs scope set up — see `native_host/GDOCS_SETUP.md`).
- **Moved the History "Clear" button into Privacy settings.** Clearing your activity history is a privacy action, so it now lives under **Privacy settings → Activity history** (always available) instead of the History-tab footer. The History footer now holds only the Beta "Download" export, so it's hidden entirely unless Experimental is on.
- **Grouped all privacy controls under one "Privacy settings" section.** The production "Backup cleanup" widget and the Beta "Privacy" (PII redaction) widget are now a single **Privacy settings** card: a **Local backups** section (delete old snapshots/notes after N days — always shown) and a **Redaction & blocklist** section (Redact PII, keywords, never-capture blocklist — appears inside the card only when Experimental is on). Same toggles, same storage; just regrouped so the privacy-related settings live together.
- **History tab summary now reads "N meetings in the past days"** (was "N meetings · M entries") — the raw entry count was noise; only the meeting count is meaningful.
- **The impact "time saved · please support" line now appears only after 24h of meetings.** The About-panel nudge ("These notes saved you roughly X of writing time. If Gememo helps you, please consider supporting it ☕") stays hidden until you've logged **24h of cumulative meeting time** — so the ask only shows once Gememo has demonstrably saved you real time. Below the threshold the block is hidden entirely; the four stat cells still render throughout, and the "Capture your first meeting…" onboarding line is unchanged.
- **Simplified the About → "Support development" widget to a single Ko-fi link.** It previously stacked an embedded Ko-fi tip **iframe** *and* a "Support on Ko-fi" link that both pointed at the same page — two ways to do one thing. The iframe (plus its lazy-load JS and CSS) is removed; the link stays. (No host change.)

### Internal (no behavior change)
- **Dead-code sweep (popup):** removed an unused `formatLogTime()` (superseded by `formatTimeOnly` + the day-section label), an orphaned `.rules-empty` CSS rule (the empty-state it styled is gone now that the Default rule is always present), and a redundant `id="snapshot-chevron"` (the chevron is styled by its class, never selected by id).

---

## [0.2.16] – 2026-06-13 · Unify destinations + Today/History tabs + BUG-9 layers 0/1

### Internal (no behavior change)
- **Extracted the leave-capture transcript-selection into a unit-tested `selectTranscript`** (`constants.js`) — the logic that decides *which* note is saved (snapshot-in-progress / recent-snapshot / fresh-capture / cached-fallback / retry) was a ~90-line block trapped in the DOM flow; it now has 9 branch unit tests (incl. the live-cache-after-await case). Behavior-preserving (the content-meet leave e2e is the integration guard).
- **Anti-drift cleanup (audit follow-up):** extracted `_file_slug` (host) for the repeated filename slug, reused `outputAppName` instead of an inline label dict (background), added a `flashCopied` popup helper for the 4× copy-button snippet, and removed a dead `_tabKey` alias + stale comments.
- **Extracted `handle_capture` from the host `main()` god-function** — the ~220-line capture pipeline is now a named function; `main()` is just dispatch. Verbatim move (host test suite identical before/after).
- **Deduped the gcal/gdocs OAuth wiring into one `wireOAuthService`** (popup) — ~45 duplicated lines (status render + connect/disconnect + 30-try poll) collapsed to one parameterised helper; the two services now differ only in element ids, message actions, and save hooks. Behavior-preserving (3 existing render e2e tests as guard + 1 new e2e for the disconnect hook).

### Added
- **Diagnostic: native-host stage heartbeat (BUG-9 Layer 0).** The host now writes a durable, content-free trail to `~/.cache/mm2c/host_heartbeat.log` — one fsync'd line per capture stage (`start` → `parsed` → `backup_written` → `webhooks_done` → `extras_done` → `craft_push_start` → `craft_push_done` → `replied`). When the host dies mid-send ("Native host has exited"), the tail names the last stage reached, so the real failing stage can be identified instead of guessed. Always on, self-bounding (~64 KB); records only stage names, timestamps, pid, return codes, and character counts — never note content. (Host change → re-run `install.sh`.)

### Changed
- **Renamed + reordered the popup tabs.** "Main" is now **Today** and "Logs" is now **History**, and the bar reads **Today · History · Rules · Settings · About** (History moved up next to Today, since they're the two you reach for most). Element ids are unchanged, so deep links, saved state, and the Experimental **Beta** tab are unaffected.
- **Unified "Also send to" + "Additional destinations" into one mechanism.** Both fanned a copy of each note to extra apps; the repeater was just the superset (per-row folder/vault). Now there is a single **Additional destinations** repeater backed by one storage key and one host function (`send_to_destinations`); a row's folder/vault is **optional** and falls back to your default for that app (a blank row behaves exactly like the old checkbox). The legacy "Also send to" checkboxes are removed, and existing settings migrate automatically.
- **Settings: moved "Additional destinations" directly below "Output app"** so the "where do notes go" controls (primary app, then additional destinations) sit together.

### Fixed
- **Recovered notes now get the full treatment and the right date.** A recovered note (RB-1d "Send now") previously skipped backup cleanup, Google Docs output, and Calendar enrichment, and was dated at recover-time — because the recover path had silently drifted from the normal capture path. Both now share one config builder (`buildForwardConfig`), and recovery re-uses the meeting's original timestamp.
- **Extra Obsidian destinations now include Calendar metadata** in their YAML frontmatter (previously only the primary Obsidian output did). Internal: the duplicated Obsidian-write and Craft exit-message blocks were extracted to one place to prevent this class of drift.
- **Additional destinations now refuse duplicates and your primary app.** After the consolidation you could add the same app many times (e.g. six Obsidian rows → the same vault) or add your primary output app again (double-send). Each extra app is now allowed at most once, your primary is never offered, "Add destination" disables when nothing valid remains, and any existing duplicate rows self-heal when you open the popup. Enforced at send time too, so stale data can't double-send. (Extension reload only — no host change.)
- **Additional destinations were silently inert in production.** After the repeater was promoted to Settings, the background still only threaded its rows when Experimental was ON — so with beta off they went nowhere. Now always threaded.
- **Additional-destinations row overflow** — the Remove control was clipped at the popup edge; rows now fit (compact ✕ button + shrinkable config field).
- **In-flight recovery now works after a failed send (BUG-9 Layer 1, RB-1d).** The recovery card never appeared because `content_meet.js` cleared the in-flight note on *failure* too — the very callback that saw the host-exit deleted the only recovery copy. Now the note is kept and stamped `failed`, so the card shows immediately (and the 60s grace still surfaces it if the service worker is killed mid-send with no callback at all). "Recover" re-sends the **most complete** copy: the host compares the in-flight text against the latest on-disk snapshot for that meeting and files whichever is longer. (Host change → re-run `install.sh`.)
- **Rules tab: the "Default" rule name now matches the built-in template names** (bold, full-strength text) instead of the muted grey badge style — the shared `.rule-name` forced 11px/muted, so the always-on Default looked subordinate to Standup/1:1/Retro. Its `.rule-default` override now mirrors `.bi-name` (12px, `var(--text)`, 600).

---

## [0.2.14] – 2026-06-11 · Apple Notes title, onboarding & recovery-stats fixes

### Fixed
- **Apple Notes title was rendered as plain, demoted text.** The meeting title was passed only as the AppleScript `name` property, which Apple Notes injects as an un-styled first line — smaller than the bold `<h2>` section headings, so the title looked subordinate to "Attendees"/"Summary". **Fix:** new `build_apple_notes_body` leads the note body with the title as an `<h1>` (Notes' 24px bold "Title" style) and **drops the `name` property** — Notes derives the note name from the `<h1>`, so the title now shows exactly once, properly styled, with a blank line before the first heading. The title is HTML-escaped so `&`/`<`/`>`/`"` aren't mangled. (Host change → re-run `install.sh`.)
- **Onboarding "Capture your first meeting" step never completed.** `firstRunChecklist` hard-coded that step to `ok: false`, so it stayed ○ no matter how many meetings were captured. It's now driven by the usage stats (`notesSaved > 0`), and the welcome card auto-dismisses once all three steps are done.
- **Recovered notes weren't counted in the impact stats.** A capture that failed at send time (e.g. "Native host has exited") and was later recovered via the failed-list **retry** never updated `notesSaved`/`wordsCaptured`/`totalMeetingMinutes`, so "Meeting time" under-reported exactly the meetings that first failed. The failure path now stashes `words` + `durationMin` on the retry entry, and a successful retry folds them into the stats — counted **once** (idempotent; a second retry of the same path is a no-op).
- **The fixed "Capture now" footer covered the bottom of the last Settings widget.** Its spacer was a flex child of the scroll container and collapsed to 0px on overflow; `flex-shrink: 0` (and a 56px height) now reserve clearance behind the footer.

### Changed
- **Settings layout tidy-up.** "Backup cleanup" now sits directly under "File backup" (it prunes that same folder), and the "Experimental" toggle is always the last widget in the tab.

---

## [0.2.13] – 2026-06-10 · Fix premature/partial capture (Copy-button visibility)

### Fixed
- **Snapshots/notes were captured mid-stream and truncated** (sometimes down to just the Attendees section). Root-caused with a live DOM probe: Meet's redesigned Ask Gemini inserts the reply's **Copy button into the DOM while it is still HIDDEN** (width 0) part-way through streaming, and only makes it **visible** when the response actually finishes. `geminiResponseDone()` checked the button's **presence only**, so completion fired early and `extractLastResponse()` grabbed a fragment. **Fix:** require the Copy button to be **visible** (non-zero box) — the reliable completion signal (Ask Gemini shows no "Stop" button to lean on). Also hardened the 3 s stability backstop to fire only once a Copy button is present, so it can't trip during an early "thinking" pause (the probe observed a ~10 s mid-stream pause). +unit test (`geminiResponseDone` hidden vs visible) and an end-to-end fixture-dom test on the real `waitForResponseComplete` (waits while the Copy button is hidden, resolves when it becomes visible). Extension + native host → `0.2.13`.

### Changed
- **Promoted multi-destination + backup-cleanup out of beta into production.** "Also send to", "Additional destinations" (UXF-11) and "Backup cleanup" (UXF-13) no longer require the Experimental toggle — the latter two moved from the Beta tab into Settings (IDs unchanged, so persistence/wiring is intact). E2E tests updated to assert these are visible with beta **off**.

### Internal (no behavior change)
- **Test-refactor: retired hand-synced `*_test` mirrors in favour of testing the real shipping code.** Replaced the prompt-prefix copies with exact-string tests on the real `constants.js` helpers; covered the real `extractLastResponse` / `waitForResponseComplete` / `injectPromptWithVerification` via the `fixture-dom` harness; and deleted a ghost (`waitForActiveGeminiButton_test` — its function was removed in 0.2.9) plus two drifted copies (`getGeminiTriggerElement_test`, `captureBtnState_test`) that were silently passing on logic the real code no longer has. The remaining `*_test` mirrors are relabeled as intentional dependency-injected tests of browser-only edge branches (tab-hidden timeout, single-flight concurrency, double-run guard).
- **Extracted pure scheduling/timing logic from `content_meet.js` into tested `constants.js` helpers** (`computeSnapshotIntervalMs`, `shouldRunCatchupSnapshot`, `shouldShowOverlay`, `computeFirstSnapshotAt`), replacing the inline expressions with calls and pointing the unit tests at the real helpers (removing hand-synced `*_test` copies). Behaviour-preserving; the helpers reproduce the original expressions exactly.
- **Moved `popup.js` display formatters `formatSnapshotAge`/`formatCountdown` into `constants.js`** (popup now uses the shared globals) and extracted `extractBackupPath` from the inline log-rendering regex, pointing the unit tests at the real helpers. Also removed `captureBtnState_test`, a drifted copy asserting button text the real popup no longer produces (the live capture-button rendering is covered by the popup-render E2E). Behaviour-preserving.
- **Pointed the send-dedup unit test at the real `shouldSkipDuplicate`** (already in `constants.js`, used by `background.js`) and deleted the redundant `isDuplicateSend_test` copy. The copy had drifted on the empty-title edge case; the test now asserts prod's actual behaviour (untitled meetings are deduped within the window — protecting one untitled meeting from a double-send). Behaviour-preserving (prod unchanged).

---

## [0.2.12] – 2026-06-09 · Remove obsolete Craft importDocument path

### Removed
- **The dead `craftdocs://x-callback-url/importDocument` subsystem in `scripts/push_to_craft.py`.** Craft's sandbox blocked it from reading staged files on macOS 26.5+, so the host switched to the inline-content `craftdocs://createdocument` path; the old code was only reachable from tests. Removed `build_import_url`, `wait_for_craft_callback`, `_CallbackHandler`, `stage_for_craft`, `_prune_craft_uploads`, and `CRAFT_UPLOADS_DIR`, plus their tests and the now-unused imports (`threading`, `http.server`, `urllib.parse.urlparse/parse_qs`); rewrote the module docstring (the `createdocument` path returns only exit 0/2 — the x-callback exit 3 is gone).

### Tests
- **Added a guard** that `build_createdocument_url` carries a large (~25 KB) note inline in full without our code truncating it — locking in that the committed path handles real-world note sizes before the fallback was removed. *(An OS-level `craftdocs://` URL-length ceiling, if any, is separate and outside the builder.)*

Extension + native host → `0.2.12`. Suite green: 511 pure JS + 73 Playwright + 327 Python.

---

## [0.2.11] – 2026-06-09 · Dead-code cleanup + real-code test coverage

### Removed
- **Dead code identified by a full audit** (no behavior change): the unused `TASK_APPS` constant and the vestigial `geminiStop` selector entry (the "Stop button" heuristic it served was dropped in the response-detection rewrite) from `constants.js`; the test-only wrappers `matchPromptRule()` (production uses `findPromptRule`) and `firstRunReady()` (production uses `firstRunChecklist`); the unused `timezone` import in `meeting_minutes_host.py`; and the stale `native_host/io.gememo.host.json` template (`install.sh` writes the host manifest inline). The `matchPromptRule` tests were **redirected to `findPromptRule`** so built-in-template and day-condition coverage is preserved.

### Tests (internal, no behavior change)
- **Cover the response-extraction + streaming-completion logic against the REAL `content_meet.js`.** `extractLastResponse` and `waitForResponseComplete` are now exposed in `MM2C_FIXTURE_MODE` and exercised by `tests/fixture-dom.html` — so the code that actually ships is tested (previously this regression-prone logic was only covered indirectly). New cases: latest-reply extraction, multi-reply (returns the last), no-reply, legacy side-panel fallback; and the streaming state machine (resolves on the Copy button, no premature finish on a prior answer, times out when no reply appears).

Extension + native host → `0.2.11`. Suite green: 511 pure JS + 73 Playwright (dom_fixtures 31/31) + 332 Python.

---

## [0.2.10] – 2026-06-09 · Remove dead CDP code + `debugger` permission

### Removed
- **`chrome.debugger`/CDP machinery, now unused.** The 0.2.9 rewrite drives Ask Gemini auto-activation with plain `element.click()`, so the CDP path is dead code. Removed the `MM2C_CDP_HOVER` / `MM2C_CDP_CLICK` / `MM2C_CDP_CLICK_KEEP` / `MM2C_CDP_DETACH` handlers from `background.js` and dropped the **`debugger`** permission from `manifest.json` — which also removes Chrome's "Gememo started debugging this browser" infobar. No behavior change (the CDP path had no test coverage and was no longer invoked). Extension + native host → `0.2.10`.

---

## [0.2.9] – 2026-06-09 · Meet 2026-06 auto-activation, rebuilt from live DOM

### Fixed
- **Auto-activation now actually starts Ask Gemini** (Meet 2026-06). Root-caused via a live DOM session, which overturned two assumptions the previous fixes were built on:
  - **It was clicking the wrong control.** When `autoActivateGemini` ran, the genuine Ask Gemini toggle often wasn't in the DOM yet (Meet **auto-hides/removes toolbar controls when the mouse is idle**), so `getGeminiTriggerElement` fell through to its last-resort **"Take notes with Gemini"** match (`div[role=button][jsname="ocqpFe"]`, `pen_spark`, no aria-label) — a *different feature*. It clicked that (`"Opening panel: click null"`) and the panel never opened. **Fix:** `getGeminiTriggerElement` now resolves only the real toggle — `button[jsname="wptEcf"]` (off) / `button[jsname="J4YcA"]` (active) / `aria-label*="Gemini"` — and the "Take notes" fallback is removed. If the toggle isn't present yet, it retries on the next mutation instead of mis-clicking.
  - **No CDP/hover is needed.** The old code attached `chrome.debugger` to do a "trusted hover" because a hover *tray* once gated "Start now", and believed a click opened a dead cross-origin popup. Live DOM shows the opposite: a **plain `element.click()`** on the toggle opens an in-page "Start now" card (`span[jsname="V67aGc"]` inside `button[jsname="R6SlF"]`), and clicking that starts Gemini — no popup, no hover, `isTrusted=false` clicks are honoured. **Fix:** the whole flow is now ordinary clicks (`toggle → "Start now" → panel`); the CDP-hover path is gone.
- New **e2e** drives the full path against an OFF-state fake-Meet fixture (toggle → "Start now" card → panel opens), incl. a decoy "Take notes" control to prove it isn't mistaken for the toggle; DOM-fixture assertions updated to the new toggle contract. Extension + native host → `0.2.9`.

---

## [0.2.8] – 2026-06-09 · Meet 2026-06 "Start now" detection

### Fixed
- **Auto-activation now finds the redesigned "Start now" control** (Meet 2026-06). After 0.2.7 correctly hovered the off-state Gemini toggle, the hover tray's "Start now" still wasn't clicked automatically — the extension showed the manual "click Start now" toast instead. Cause: the redesigned tray renders "Start now" as a `<span jsname="V67aGc" class="YUhpIc-vQzf8d">Start now</span>` whose clickable wrapper is a **non-semantic `[jsaction]` div**, not a `<button>`/`[role="button"]` — so the old text scan (limited to buttons) never matched it. Fix: a new pure `findStartNowButton(root)` matches the tray by the **label text "Start now"** (the `V67aGc` jsname is shared with the Copy button, so it can't be used alone) and climbs to the nearest clickable (falling back to the label span, since CDP clicks by coordinates); it also keeps the aria-label and legacy-button paths. `getGeminiStartNowButton` delegates to it. +pure tests covering the new tray shape, the Copy-span false-positive, aria-label, legacy button, and a big-container guard. Extension + native host → `0.2.8`.

---

## [0.2.7] – 2026-06-09 · Meet 2026-06 auto-activation fix

### Fixed
- **Auto-activation no longer skips the hover step** (Meet 2026-06 redesign). `autoActivateGemini` decided "Gemini already started → just click to open" vs "not started → hover to reveal *Start now*" by checking whether the toolbar toggle had an `aria-label`. The redesign gave the **off-state** toggle a permanent `aria-label` ("Gemini can't answer your questions at the moment") plus a `spark_off` icon — so the off button was misread as "started", taking the click branch (which opens a dead cross-origin popup) and **never hovering to activate**. Fix: a new `geminiNotStarted(el)` decides started-vs-not by the **icon/label state** (`spark_off` icon, or a "can't answer / not available" label) instead of mere label presence; `getGeminiTriggerElement` also matches the toggle by its stable `jsname="wptEcf"`. +pure tests for `geminiNotStarted` across off/active shapes. Extension + native host → `0.2.7`.

---

## [0.2.6] – 2026-06-09 · Meet 2026-06 response-detection fix

### Fixed
- **Capture no longer hangs on "Waiting for Gemini…" / never reaches the output app** (Meet 2026-06 redesign). The capture flow read the reply and detected completion within `aside[aria-label="Side panel"]` — but the redesign **moved the Gemini conversation out of that panel** (now empty) into a `role="list"` of `role="listitem"` rows. So the prompt injected, the reply rendered, but the extension found nothing in the (empty) side panel → `waitForResponseComplete` timed out and the leave/snapshot path retried forever, never pushing to Craft. Fix: a new `lastGeminiResponseEl()` resolves the **latest reply list-item** (the row with a Copy action button or the "Gemini response" label; legacy/side-panel fallback kept), and completion (`geminiResponseDone()`) now means **that last message has its Copy button** — which also means a still-streaming reply (no Copy yet) can't complete on a *prior* answer, with no fragile "Stop button" heuristic. `extractLastResponse` and `waitForResponseComplete` (now observing `document.body`) operate on the reply element instead of the empty aside. *Diagnosed by inspecting the live Meet DOM.* +new pure tests for `lastGeminiResponseEl`/`geminiResponseDone` (incl. the streaming-no-premature-completion case) and the real list-item text shape; the fake-Meet E2E now renders the `role="listitem"` structure. Extension + native host → `0.2.6`.

### Changed
- **`.ics for Next Steps` moved behind the Experimental toggle.** The `.ics` export row (inside File backup) now carries the `.beta` class, so it's hidden unless *Settings → Experimental features* is on — consistent with the other advanced features. UI-only gating; the export behavior is unchanged when enabled. A focused E2E asserts it's hidden/shown with Experimental off/on (with file backup enabled).
- **Extension + native host bumped to `0.2.6` (lockstep).** Re-run `bash native_host/install.sh` to refresh the version the popup shows; not required for compatibility (major unchanged).

---

## [0.2.5] – 2026-06-09 · Lean default UI, unified Rules, new betas & Meet-redesign resilience

### Added
- **Built-in templates unified into the rules list (off by default, materialise on enable).** Built-in templates (Standup, 1:1, Retro) are no longer a separate read-only section — they appear inline in the one Meeting-rules list, **off by default**, each a bordered row with the enable toggle and the expand/collapse chevron together on the **right** (inside the box, coherent with the rest of the app), and the chevron reveals the template's prompt. Switching one on **materialises** it into your rules as a normal, fully-editable rule (name + regex + prompt, enabled) — it joins the rules above and drops out of the template suggestions; deleting it brings the suggestion back. So **no template auto-applies until you turn it on** (previously they always matched). Matching simplifies to the user's rules only — `content_meet.js` no longer matches `BUILT_IN_RULES` separately. New pure `availableTemplates(builtins, rules)` helper; the per-rule enable toggle also moved to the right. Pure + popup E2E tests updated.
- **P9-G — Pre-meeting brief** (beta, off by default). A new Beta-tab widget surfaces a ≤3-bullet prep brief — **Agenda** (first sentence/line of the invite description, else "No agenda in the invite."), **Who** (attendee count + up to ~3 names/emails + organizer, emails omitted when PII redaction is on), **Context** (recurring flag + scheduled start/duration) — for the Meet tab you currently have open, built from its matching Calendar event. The **autonomous deliverable is the host "brain"** (pure + mocked): a pure `build_pre_meeting_brief(fields)` and a best-effort `pre_meeting_brief(..., events_provider=...)` in `gcal.py` that reuse the existing 5.3 match/extract path and the injected `events_provider` (so they're fully unit-testable without network). A **manual trigger** ("Brief me on the active meeting") in the popup → `MM2C_PRE_BRIEF` in `background.js` → host. **Automatic pre-start detection + in-page card injection in `content_meet.js` is deferred** as a live-verify follow-up (do after the ARCH-7 split, with the maintainer) — `content_meet.js` is untouched here. Beta-gated like UXF-11/5.7: the handler reads `mm2c_beta_enabled` and returns `{ok:false, error:'beta_off'}` **without calling the host** when off (a test asserts the native stub is never called), so beta-off behavior is byte-identical. Reuses the existing Calendar token + `googleapiclient` (no new pip dependency). Flagged **🧪 under testing** — the live Calendar match needs a connected account + a real meeting. New `native_host/test_brief.py` (16 tests) + 6 background/popup E2E tests; host `0.2.3 → 0.2.4`.
- **5.7 — Google Docs output** (beta, off by default). When enabled, each captured note is also created as a **Google Doc** (one per note). The note markdown is converted into Docs API `batchUpdate` requests (`#/##/###` → heading styles, `-`/`*` → bullets, `**bold**` → bold ranges) by a pure `markdown_to_docs_requests`, then created via `documents().create` + `batchUpdate`. **Critical safety decision:** rather than adding the `documents` scope to the *already-shipped* Calendar grant (which would force re-consent and risk regressing Calendar for connected users), Google Docs gets its **own** self-contained module (`native_host/gdocs.py`) with an **independent** OAuth grant — its own `documents` scope, its own token file (`token_docs.json`, distinct from Calendar's `token.json`), and its own connect/status/disconnect. `gcal.py` / `token.json` / the Calendar feature are **untouched** and byte-identical; a future single-grant unification is deferred until it can be live-verified. Double-gated like UXF-11: the widget only appears with Experimental on, and `background.js` threads `googleDocsOutput` to the host **only** when beta is enabled (off ⇒ always `false` ⇒ host no-op), so beta-off behavior is byte-identical. Host-side creation is best-effort (never blocks or fails capture). Reuses the existing `googleapiclient` (no new pip dependency). Flagged **🧪 under testing** — live OAuth consent + real Doc creation are maintainer-verified, not autonomously. New `native_host/gdocs.py` + `native_host/test_gdocs.py` (20 tests) + background/popup E2E (4 tests) + `native_host/GDOCS_SETUP.md`; host `0.2.2 → 0.2.3`.
- **UXF-11 — "Additional destinations" repeater** (beta, off by default). A new Beta-tab repeater that sends each captured note to **N** extra destinations, where every row carries its **own** inline config (its own Obsidian vault path, its own Craft folder) instead of the legacy global singletons — so you can fan a note out to e.g. two different Obsidian vaults at once. Purely **additive** and independent of the existing primary + "Also send to" path, which is untouched. Double-gated for safety: the widget only appears with Experimental on, and `background.js` threads the destinations into the host **only** when beta is enabled (off ⇒ always `[]` ⇒ host no-op), so beta-off behavior is byte-identical. Host dispatch is best-effort per row (a failing destination never affects the primary capture or the others). Pure `normalizeDestinations` helper + new `native_host/test_destinations.py` (9 tests) + background/popup E2E + pure fixtures; host `0.2.1 → 0.2.2`.

### Changed
- **Rules tab unified into one list.** The Default prompt, built-in templates, and your rules were three visually different things that are conceptually the same (a prompt, optionally gated by a regex). They're now one **"Rules"** section: a single list of identical collapsed rows. **Default** is the first row, marked `always on · fallback` (no toggle — it's what applies when nothing else matches; expand to edit its prompt + Reset). **Your rules** and the **built-in templates** follow in the same row style. Dropped the separate "Default prompt"/"Meeting rules" widgets, the two widget-level collapse arrows, the verbose paragraph (→ one short hint), and the "No custom rules yet" empty state. Purely visual/structural — the matching engine is unchanged (Default still in `mm2c_prompt`, templates still materialise into `mm2c_prompt_rules`).
- **Logs tab: sticky action footer + gated developer controls.** **Clear** and **Download** moved to a footer pinned to the bottom of the Logs tab (`position: sticky`), so they stay reachable while a long log list scrolls. **Download** and the diagnostics checkbox are now behind the Experimental toggle (the checkbox is renamed **"Developer logs"**); **Clear** stays always available, so a non-experimental user just sees their logs + Clear.
- **No more horizontal shift when a tab scrolls.** The popup's scroll container now reserves the scrollbar gutter (`scrollbar-gutter: stable`), so content keeps the same width whether or not a tab overflows — switching from a short tab (e.g. Main) to a scrolling one (e.g. Rules) no longer nudges everything left.
- **Leaner default UI — advanced features moved behind the Experimental toggle.** To keep the out-of-the-box experience focused on core capture, these are now hidden unless *Settings → Experimental features* is on (gated in place — each stays in its current tab, just hidden): **Glossary**, **Your name** (action-item aliases), **"Also send to"**, **Wikilinks for graph apps**, **Webhook** (generic + Slack), **Privacy** (PII redaction, keywords, capture blocklist), **action items** (both the in-popup checklist + the task-manager routing), **past-meeting search** (Logs-tab search box + filters), **Note language**, and **Review notes before saving**. Beta widgets get a "Beta" pill. Gating is UI-only (`.beta` class) — no behavior change for users who already configured these. +2 E2E tests assert the on/off visibility.
- **Default output app is now "None".** The first-run "Choose an output app" onboarding step is computed live as done whenever the output app isn't `none`, but the fallback default was `craft` — so a clean install showed step 2 pre-checked and onboarding never felt fresh. Defaulting to `none` (in `popup.js`, `background.js`, `constants.js`) makes it a real choice; a fresh user explicitly picks a destination and nothing is silently saved before they do.
- **Consistent collapse chevrons.** The Rules-tab "Default prompt" and "Meeting rules" collapse arrows were a bulky 22×22 bordered box (`.btn-collapse`); they now use the same clean, small (10px), borderless triangle that the Logs meeting-groups and snapshot rows already use — rotating 90° when open. The built-in-rule template `<details>` rows (which previously showed no disclosure marker at all because the `<summary>` is `display:flex`) gain the same chevron. The rule up/down/delete action buttons keep their box. CSS-only.
- **ARCH-7 increment 1 — extract pure cores from `content_meet.js`.** Moved the genuinely-pure helpers `outputAppName`, `isMeetCode`, `meetingTitleFromCandidate`, `meetingTitleFromTab`, and `isValidAttendeeName` out of the `content_meet.js` IIFE into the unit-tested `constants.js` layer (injected before `content_meet`), deduped the Meet-code regex onto the existing `_MEET_CODE_RE`, and rewired `getMeetingTitle`/`getAttendeeNames` to delegate. No behavior change.

### Fixed
- **Reordering/deleting a rule no longer corrupts the list** (found via a coverage audit). Clicking a rule's ↑/↓/✕ focuses that button; the handler then re-renders the list, and the button's resulting `blur` fired `saveRuleFromEvent`, which raced the reorder/delete's own save and wrote a **stale** row back — so reorder **duplicated** a rule and delete kept the **wrong** survivor. `saveRuleFromEvent` now only persists blurs from actual fields (`input`/`textarea`/`select`), never from action buttons. Regression tests assert reorder swaps the stored order and delete keeps the correct rule.
- **Rule row no longer overflows when a template is activated.** A materialised rule's header (name + regex + ↑↓✕ + the right-side toggle) was wider than the 340px popup, pushing the enable toggle off-screen and breaking the layout. The regex input now gets `min-width: 0` so it shrinks and the whole row fits. Regression test asserts the row stays within the popup width.
- **Editable rules are now collapsible too.** Previously only template rows had an expand/collapse chevron — when a template materialised into an editable rule it lost it, leaving a tall always-open card. Every rule now has the same right-side chevron and a collapsible body (prompt + title template + conditions). Rules render **collapsed by default** (tidy, like the templates; the regex stays visible/editable in the header); newly added rules open for editing, and the expanded state survives the save-triggered re-render.
- **Gemini response detection survives Meet's 2026-06 redesign (no more re-inject loop).** Meet dropped the literal **"Gemini response"** label the capture flow relied on to (a) read the answer and (b) know it had finished — so `extractLastResponse()` returned nothing, completion never fired, the flow timed out, and the leave path retried up to 3× (≈6 min of re-injecting the prompt: the endless "Waiting for Gemini…" loop). Now completion keys off the response's **Copy action button** (`geminiResponseDone()` — Copy present + nothing streaming), and extraction **falls back** to reading the answer bubble anchored on that Copy button when the old label is absent (the `"Gemini response\n"` fast path is kept, so legacy panels don't regress). New `findGeminiCopyButton`/`geminiResponseDone`/`cleanGeminiResponse` helpers + `SELECTORS.geminiCopy`/`geminiStop` (overridable via the selector hotfix). +11 pure tests for the new-DOM extraction/completion; the fake-Meet e2e now renders the new DOM (capture completes via the Copy button — and ~7× faster). *Verified the Copy button + all current selectors against the live Meet DOM.*
- **Auto-inject the content script into already-open Meet tabs on install/update.** When Gememo is installed or updated (or reloaded in dev) while a Meet tab is already open, that tab may have **no content script** — so the popup shows "Not in a meeting" and capture silently does nothing. A new `chrome.runtime.onInstalled` handler now injects `content_meet.js` into open `meet.google.com` tabs that lack one (probed via the isolated-world globals; guarded by `window.__mm2cLoaded`), using `chrome.scripting` (new permission). It **never reloads the tab**, so a live call is never dropped, and it **skips tabs that already have a running script** (Chrome can't hot-replace running content-script code — those still need a one-time manual tab reload to pick up *new* code). Extension version `0.2.4 → 0.2.5`.

### Tests
- **Second coverage-gap audit (post-redesign).** +24 tests over the recent extension-JS work: pure (`cleanGeminiResponse` citation pass — the last uncovered slice of `constants.js`, `findGeminiCopyButton` fallback/last-match, `shouldInjectContentScript`, direct prefix-helper assertions), background E2E (`MM2C_SNAPSHOT` skip/forward, `MM2C_SET_SNAPSHOT` set/null), popup E2E (Add-rule auto-expand, Default-row expand, **reorder/delete regression** — see Fixed), and a DOM-fixture guard. Suite: 496 pure JS + 71 Playwright + 23 DOM-fixture + 332 Python.
- **Coverage-gap audit — handler-wiring & dispatch tests.** A systematic coverage audit (Python `coverage`, JS `coverage.spec.js`) confirmed the pure layers are fully covered (`constants.js` 99.3%; host pure logic) and that every real gap was at the **handler-wiring / dispatch / capture-hook** layer — mostly the new beta features' `main()` wiring + background error branches. Filled them, **test-only**: **+33 Python tests** raising `meeting_minutes_host.py` **90% → 97%** — the host message-dispatch for `gcal_*`/`gdocs_*`/`pre_meeting_brief` (incl. the detached-`Popen` connect paths and the `GCAL_AVAILABLE` guard), and the capture-path hooks for Google Docs (`create_doc` called + best-effort isolation when it raises), `destinations`, Calendar enrichment (`cal_fields` reach the frontmatter), wikilinks, backup-cleanup, and the timestamp fallback, plus edge branches (empty message, folder-picker timeout/no-selection, prior-context with an existing note, `create_doc` not-connected) and pure micro-branches. **+8 background/popup E2E + 1 content_meet E2E**: `MM2C_RESPONSE` host-error → `mm2c_failed_list` append (the retry-recovery entry point), duplicate-send skip, `MM2C_CHECK_HOST` version-mismatch warn, `MM2C_RETRY` failure branch, `chrome.tabs.onRemoved` tab-scoped cleanup, the Pre-meeting-brief per-error friendly strings, Google Docs/Calendar status-render branches, backup-cleanup `clampDays`, and the genuine **Leave-click → primary `MM2C_RESPONSE`** capture path (distinct from the snapshot path). **+4 DOM-fixture** cases for `isRecording` (previously zero coverage; exposed via the existing `MM2C_FIXTURE_MODE` selector export). The only non-test change is that one fixture-mode export line.
- **TEST-1 Phase 2 — content_meet fake-Meet E2E.** The real `content_meet.js` is now injected into a live page in CI: the extension is loaded with its manifest matches widened to localhost (code byte-identical), a fake Meet page reproducing the `SELECTORS` contract is served over an ephemeral-port HTTP server, and two tests assert (a) the content script injects + the join lifecycle fires (`MM2C_STAT_JOINED` → `meetingsAttended`), and (b) a genuine `MM2C_CAPTURE_NOW` runs the real Gemini flow (prompt-inject → submit → stability wait → extract) and forwards the sentinel transcript to the native-host stub. Closes the last big coverage gap (`content_meet` was DOM-fixture-only); foundation for ARCH-7.
- **TEST-1 Layer 1 — extension E2E harness.** Playwright now loads the *real* unpacked extension headlessly (runs on GitHub Actions CI) and exercises `background.js` and `popup.js` (the two previously-**0%** files), with `chrome.runtime.sendNativeMessage` stubbed at the service-worker boundary as the assertion seam. `tests/ext-harness.js` owns launch/seed/stub/popup. **18 E2E tests** cover the background handlers — `MM2C_RESPONSE` (forward payload + stats/status/last-note), `MM2C_STAT_JOINED`, `MM2C_CHECK_HOST`, `MM2C_SET_CAPTURE_STATE`, `MM2C_WARNING`/`MM2C_ERROR` (incl. the UXC-3 friendlyError mapping), `MM2C_RETRY`, `MM2C_RECOVER` (RB-1d), `MM2C_GCAL`/`MM2C_SEARCH` relays — and popup render (stats, logs, rules, retry card, crash-recovery card, a settings toggle). Foundation for ARCH-7 and for E2E-verifying the beta items; the `content_meet` fake-Meet capture flow is Phase 2. The remaining uncovered handlers are the `chrome.debugger` CDP paths + the network hotfix fetch (Phase-2/content_meet territory).

---

## [0.2.1] – 2026-06-06 · Google Calendar enrichment (5.3, beta)

### Added
- **Google Calendar enrichment (5.3)** — a beta-gated **"Connect Google Calendar"** in Settings. After a one-time OAuth connect (host-side loopback flow, read-only `calendar.readonly`), the native host matches each captured meeting to its Calendar event **by Meet room code** (time/title fallback) and enriches the note's YAML frontmatter with `attendee_emails`, `recurring_event_id`, `description` (the agenda — **delivers P9-A2**), `organizer`, and `scheduled_start/end/duration_min` (**exposes the data UXF-10 needs**). Best-effort: any failure (not connected / no match / API error) silently degrades to the existing DOM-derived data — capture is never blocked. Attendee emails are omitted when **Redact PII** is on. The stored token is reusable by the future Docs (5.7) / brief (P9-G) features.
- All Google logic is isolated in `native_host/gcal.py` (pure match/extract/orchestration **unit-tested**, 22 new tests; OAuth/API behind a `GCAL_AVAILABLE` import guard). The Google libraries install into an **isolated venv** (best-effort) so the core host stays stdlib-only and **non-breaking** if they're absent.

### Docs
- README gains a **Beta / experimental features 🧪** section listing every beta-gated / opt-in feature (Calendar, private reflection, email, review-before-send, task-manager routing, selector hotfix, Obsidian/Bear) and flagging each as *under testing* until verified end-to-end.

### Notes
- Requires a one-time GCP setup (`native_host/CALENDAR_SETUP.md`). Built against a **testing-mode** OAuth client; Google verification + Web Store publishing (RB-2c) are a separate downstream track on the **same code**. Existing users re-run `install.sh` once to get the venv/libs.
- Coverage: `gcal.py` pure layer fully unit-tested (26 tests); host coverage stays high (the OAuth/network functions are the intentional untested boundary).

---

## [0.2.0] – 2026-06-05 · Roadmap sweep — UX, privacy, resilience & integrations

A large batch clearing the Tier 0–4 backlog. Every item ships with tests; new
pure logic lands in the measured `constants.js`/host layers. JS tests 307 → 436,
Python 186 → 210.

### Added
- **Design-token contract (UXC-0)** — `extension/design_tokens.js` is now the single source of truth for palette/radii/spacing/type across the popup, the in-Meet toast/overlay, and the toolbar badge. A drift-guard spec (`tests/tokens.spec.js`) keeps the popup `:root` and badge/toast in sync.
- **Selector resilience** — a centralized selector registry with a join-time **health self-test** (RB-1a) turns a Meet DOM change into an observable diagnostic; an opt-in **remote selector hotfix** (RB-1b) can patch a broken selector via a `selectors.json` URL without a release.
- **Crash recovery (RB-1d)** — the formatted note is persisted in-flight and offered for recovery in the popup if a send never completes.
- **Note quality** — content-derived **topic tags** in frontmatter (RB-4c), opt-in **wikilinks** for graph apps (RB-4e), per-rule **title templates** (RB-4d), and a **provenance footer** on every note (UXC-22).
- **Action items leave the note** — push to **Things / Todoist / OmniFocus** (RB-3a) and a **"N for you"** badge that flags items assigned to you (UXF-7).
- **Outputs** — **Bear** output (5.8) and **email via mailto:** (RB-3c, beta). Obsidian and Bear are flagged **untested**.
- **Power features (beta)** — **private reflection** dual-output pass (P9-H) and **review-before-send** (RB-4b).
- **UX** — tri-state **System/Light/Dark** theme (UXF-8), **date-sectioned logs** (UXF-4), persisted/collapsed log groups (UXF-6), a **beta-features** toggle (UXF-1), a **first-run checklist** (RB-7a), a **Run diagnostics** report (RB-7b), per-rule **enable/disable** + **time-spent** conditions (UXF-9/UXF-10), and **Microsoft Edge** support (RB-2b).

### Changed
- **Friendly errors (UXC-3)** — raw exception strings no longer reach the banner/toast; the raw text stays in the debug log.
- **Consistency** — one canonical "Gemini wasn't active" message (UXC-2), a single output-target term ("output app", UXC-16), a unified semantic colour palette/type/radius/spacing scale (UXC-5/8/11/12/14), focus rings + consistent copy buttons (UXC-9/18), and the in-Meet toast/overlay extracted to `content_meet.css` and rebuilt on the tokens (UXC-7/6).
- **Robustness** — errors are no longer swallowed (A3), popup storage reads are batched (C2), input paths are validated (A4), the `waitForX` helpers are collapsed (ARCH-5), and background handler predicates are extracted + tested (D2). The popup is content-driven with a visible scrollbar (UXF-12).

### Notes
- **Deferred (need live verification or external access):** the Craft folder picker (5.2), the full `content_meet.js` module split + E2E harness (ARCH-7/ARCH-9, = the parked TEST-1), and the live-Gemini halves of dual-output/review (regenerate). Code for verify-blocked items ships behind opt-in toggles.

---

## [0.1.125] – 2026-06-04 · Testable prompt construction (Tier 3 audit)

### Changed
- Extracted the entire Gemini **prompt construction** out of `content_meet.js` into a pure, unit-tested `assemblePrompt()` (+ `meetingTitlePrefix`/`noteLanguagePrefix`/`attendeesPrefix`) in `constants.js`. The most bug-prone logic — where a mistake means bad AI notes, and which had carried the new glossary/prior-context/depth/language wiring as untested string concatenation — is now covered at the 99.5% pure-layer level. Output is byte-identical; no behavior change. 6 new JS tests.

---

## [0.1.124] – 2026-06-04 · Capture blocklist (RB-5a)

### Added
- **RB-5a** — a **"Never capture"** blocklist (Privacy settings): meetings whose title matches any of your regex patterns (comma/newline separated) are excluded from capture entirely — no snapshots, no proactive capture, no capture on Leave. Evaluated once at meeting join via the new pure `titleBlocked()`; an empty blocklist is a no-op, so there's zero impact unless you set one. 5 new JS tests.

---

## [0.1.123] – 2026-06-04 · Webhook URL validation (ARCH-6)

### Added
- **ARCH-6** — the Webhook and Slack URL fields now show an inline error when the value isn't a full `http(s)://` URL, so a typo'd hook is caught at entry instead of failing silently at capture time. New pure `webhookUrlError()` (blank = disabled, localhost allowed). 5 new JS tests.

---

## [0.1.122] – 2026-06-04 · Capture-now keyboard shortcut (RB-7d)

### Added
- **RB-7d** — a `chrome.commands` shortcut (**Cmd/Ctrl+Shift+Y**, rebindable at `chrome://extensions/shortcuts`) triggers "Capture now" on the active Meet tab without opening the popup. Background routes the command to the most recently used Meet tab.

---

## [0.1.121] – 2026-06-04 · Desktop notification on failure (RB-7e)

### Added
- **RB-7e** — the native host now fires a macOS notification when a capture **fails** (Craft push failure or an unexpected error), not only on success. Since the in-page toast is gone once the Meet tab closes, this is often the user's only signal that something went wrong. 1 new main-flow test.

---

## [0.1.120] – 2026-06-04 · Report-an-issue link (RB-1c)

### Added
- **RB-1c** — a **"Report an issue"** button in the About tab opens a prefilled GitHub issue (version + extension ID + a template) so bug reports arrive with context. New pure `buildIssueUrl()`. 3 new JS tests. (The auto-prompt-on-selector-failure with a DOM snapshot is deferred — it needs a live meeting to validate.)

---

## [0.1.119] – 2026-06-04 · Accessibility pass (RB-7c)

### Added
- **RB-7c** — popup accessibility: the tab bar is a `role="tablist"` with `role="tab"`/`aria-selected` buttons (kept in sync on switch) wired to `role="tabpanel"` panels; icon-only rule buttons (↑ ↓ ✕) gained `aria-label`s; the native-host status dot is an `aria-label`led `role="img"` so its colour-only state is announced.

---

## [0.1.118] – 2026-06-04 · Dark mode (RB-7f)

### Added
- **RB-7f** — the popup now follows the OS theme via `prefers-color-scheme`. Only the colour tokens flip (a Google-style dark palette); spacing is unchanged. Form controls get `color-scheme: dark` so native inputs render correctly. CSS-only, no behavior change.

---

## [0.1.117] – 2026-06-04 · Custom glossary (RB-4a)

### Added
- **RB-4a** — a **Glossary** field (Rules tab): names, codenames, and acronyms you list are injected into the prompt with an instruction to spell them exactly, never translating or abbreviating. New pure `glossaryPrefix()`; wired into the prompt build alongside the existing prefixes. 3 new JS tests.

---

## [0.1.116] – 2026-06-04 · .ics for Next Steps (RB-3b)

### Added
- **RB-3b** — an opt-in setting writes a standards-compliant `.ics` next to each backup note, with one all-day VEVENT per line of the **Next Steps** section, so shared follow-ups land on your calendar with no Calendar OAuth. New pure `build_ics()` (RFC-5545 CRLF, escaped text, bullet markers stripped). 4 new Python tests.

---

## [0.1.115] – 2026-06-04 · Search filters (RB-6b)

### Added
- **RB-6b** — the "Search past meetings" box now has **date-range** (from/to) and **attendee** filters. `search_notes()` gained `since`/`until` (inclusive YYYY-MM-DD bounds on the note date) and `attendee` params, threaded through the `search` message + `MM2C_SEARCH`. Results stay newest-first. 2 new Python tests.

---

## [0.1.114] – 2026-06-04 · PII redaction (RB-5b)

### Added
- **RB-5b** — an opt-in **"Redact PII"** privacy setting strips emails, phone numbers, and card-like numbers (plus your own comma-separated keywords) from the note **before anything is written or sent** — file backup, output app, and webhook payloads alike. New pure `redact_pii()` in the host (precise phone patterns so dates and "Name 1" attendee suffixes survive). 9 new Python tests.

---

## [0.1.113] – 2026-06-04 · REC badge without a full-storage scan (ARCH-4)

### Changed
- **ARCH-4** — the toolbar REC badge no longer calls `chrome.storage.local.get(null)` (which deserialized **all** of storage — logs, snapshots, stats, the last note — on every capture-state change just to look for a `mm2c_capture_state_*` key). Capturing tabs are now tracked in a tiny `mm2c_capturing_tabs` array via new pure `addCapturingTab()`/`removeCapturingTab()` helpers; `tabs.onRemoved` also prunes it and clears the badge if the closing tab was the last. 7 new JS tests. No user-visible behavior change.

---

## [0.1.112] – 2026-06-04 · De-duplicate service-worker helpers (ARCH-1)

### Changed
- **ARCH-1** — `background.js` now `importScripts('constants.js')` instead of hand-copying six helpers (`tabKey`, `addFailure`, `removeFailure`, `removeFailureByPath`, `countWords`, `updateStats`). `constants.js` is the single source of truth (it's DOM-free, so a classic MV3 service worker can load it). Removes the drift risk where a fix in `constants.js` silently didn't reach the worker. `addFailure`/`removeFailure` moved into `constants.js` and are now unit-tested as the real shared functions. No behavior change.

---

## [0.1.111] – 2026-06-04 · Reliability: subprocess timeouts + shorter webhook waits (ARCH-2/3)

### Fixed
- **ARCH-2** — every `subprocess.run` in the native host now has a `timeout` (osascript for Apple Notes/notifications: 30 s/10 s; Craft push + snapshot-retry: 45 s; `open`: 30 s). Previously an AppleScript modal or permission prompt could hang the host **forever**, stalling Chrome's native-messaging port and silently losing the capture. `notify()` swallows its own timeout (best-effort). 6 new Python tests.
- **ARCH-3** — the post-capture webhook + Slack POSTs now use a 2.5 s timeout (was 6 s each), cutting the worst-case delay before the "Saved" response from ~12 s to ~5 s on the post-meeting page.

### Coverage
- Native-host coverage **95% total** (`meeting_minutes_host.py` 91%, `push_to_craft.py` 92%); 164 Python tests.

---

## [0.1.110] – 2026-06-04 · Configurable Craft space (5.5)

### Added
- **5.5** — a **Craft Space ID** field in Settings routes notes to a specific Craft space (previously only settable via the `CRAFT_SPACE_ID` env var). The per-meeting value takes precedence over the env fallback. Threaded via `background.js`; 1 new main-flow test asserts `--space-id` reaches the push command.

---

## [0.1.109] – 2026-06-04 · Slack post after capture (P9-B)

### Added
- **P9-B** — an optional **Slack webhook** in Settings posts the meeting title, summary, and action-item count to a Slack incoming webhook after each capture. New pure `build_slack_payload()`; reuses the existing `post_webhook()` (best-effort, no deps). Threaded via `background.js`. 3 new Python tests.

---

## [0.1.108] – 2026-06-04 · Multi-destination output (P9-X)

### Added
- **P9-X** — an "Also send to" multi-select in Settings sends each captured note to additional apps (Craft / Apple Notes / Obsidian) on top of the primary output. New host `resolve_extras()` (dedupes, excludes the primary + `none`) and `send_to_extras()` (best-effort — a failed secondary never affects the primary result). Threaded via `background.js`. 4 new Python tests (incl. a main-flow test asserting the extra fires).

---

## [0.1.107] – 2026-06-04 · Per-rule summary depth (P5-L)

### Added
- **P5-L** — each meeting rule can set a **summary depth** (Standard / Brief / Detailed). When a rule matches, a depth instruction is prepended to its prompt — e.g. a standup rule set to "Brief" yields terse notes, a strategy-meeting rule set to "Detailed" yields exhaustive ones. New pure `findPromptRule()` (returns the matched rule) and `depthInstruction()`; `matchPromptRule()` is now a thin wrapper. Depth `<select>` added per rule in the Rules tab. 5 new JS tests.

---

## [0.1.106] – 2026-06-04 · Time- and day-based prompt rules (P5-L2)

### Added
- **P5-L2** — meeting rules can now match on **time** as well as title. Each rule gains an optional condition (days of week + an hour range); a rule fires when its regex matches the title **or** the current time falls in its window (e.g. "before 9am → standup", "Friday afternoon → weekly wrap-up"). New pure helpers `ruleTimeMatches()`, `buildCondition()`; `matchPromptRule()` now takes the current time and evaluates conditions. The Rules tab gains per-rule day checkboxes + an hour range. 12 new JS tests.

---

## [0.1.105] – 2026-06-04 · Test-coverage audit (internal)

### Added
- **Native-host coverage 81% → 93%.** New `test_main_flow.py` drives `main()` end-to-end with `read_message`/`send_message`/`subprocess` mocked — covering the Craft success path, file-backup write, push-failure + snapshot-retry, the `none`/route-output path, and the `ping`/`choose_folder`/`snapshot`/`search`/`prior_context`/`retry` dispatch. New `handle_retry` tests (success, empty-title fallback, missing file, push failure) in `test_host.py`. New `push_to_craft` tests for `cleanup_cache`, `stage_for_craft`, `_prune_craft_uploads`, and `main()` (frontmatter strip + `%` double-encode). +22 Python tests (120 → 142).

### Removed
- Dead `date_str` computation in `parse_transcript` (computed but never used).

### Notes
- `meeting_minutes_host.py` 87%, `push_to_craft.py` 88%; the remaining uncovered lines are `osascript` side-effects (Apple Notes, notifications, the folder dialog) covered only by the opt-in `GEMEMO_NOTES_INTEGRATION` tests. Measure with `python3 -m coverage run --source=native_host,scripts -m pytest native_host/ && python3 -m coverage report -m` (coverage.py is a dev-only tool, not a project dependency).

---

## [0.1.104] – 2026-06-04 · Usage stats in the About tab (UX-8)

### Added
- **UX-8** — the About tab now shows a "Your impact" panel with lifetime stats: meetings attended, notes saved, words captured, and total meeting time, plus a derived "these notes saved you ~Xh of writing time" line that links to Ko-fi. Stats accumulate in `chrome.storage.local` under `mm2c_stats` — incremented on each successful capture (notes/words/minutes) and once per meeting at join (`MM2C_STAT_JOINED`). New pure helpers `countWords()`, `updateStats()`, `computeTimeSavedMin()`, `formatStatDuration()`, `formatStatNumber()`. The Support link is now a live Ko-fi button. 10 new JS tests.

---

## [0.1.103] – 2026-06-04 · Recurring-meeting context injection (P9-C)

### Added
- **P9-C** — for recurring meetings, the previous session's Summary and open Action Items are now prepended to the Gemini prompt ("Build on this… do not repeat verbatim"), so notes carry continuity across a series. At meeting join the content script requests context for the current title (`MM2C_PRIOR_CONTEXT` → host); the host finds the most-recent prior final note for the same series by frontmatter-title slug (snapshots and today's note excluded) and returns a context block. New host helpers `note_slug()`, `find_prior_note()`, `build_prior_context()` + `prior_context` message type. Reuses existing backup files — no new storage. 9 new Python tests.

---

## [0.1.102] – 2026-06-04 · Generic webhook output (P9-D)

### Added
- **P9-D** — an optional **Webhook URL** in Settings. On each capture the host POSTs the note as structured JSON (`title, date, attendees, duration_min, summary, key_points, decisions, action_items, next_steps, open_questions`) to the URL — covering Zapier / n8n / Make and custom endpoints with no per-app connector. New host helpers `parse_note_sections()`, `build_webhook_payload()`, `post_webhook()` (urllib, no deps, no CORS/host-permissions); best-effort and never affects the capture result. 5 new Python tests.

---

## [0.1.101] – 2026-06-04 · Local full-text search across notes (P9-E)

### Added
- **P9-E** — a "Search past meetings" box in the Logs tab searches your backup `.md` notes locally (no API). New host `search_notes()` does a case-insensitive scan of final notes (snapshots excluded), returning newest-first matches with title, date, and a context snippet, via a new `search` native-message type and `MM2C_SEARCH` background handler. 7 new Python tests.

---

## [0.1.100] – 2026-06-04 · Two-tier logging (UX-6)

### Added
- **UX-6** — log entries now carry a `level` (`user` | `debug`). The Logs tab shows user-facing entries by default and hides diagnostics (tab-switch events, host version-mismatch, prompt `perf:` lines) behind a new "Diagnostics" toggle. New pure `filterLogsByLevel()`; `appendLog`/`sendLog`/`MM2C_LOG` gained a level param (default `user`); legacy entries without a level are treated as user-facing. 4 new JS tests.

---

## [0.1.99] – 2026-06-04 · Action-item checklist in popup (P6-B)

### Added
- **P6-B** — after each capture, the Main tab surfaces the meeting's action items as a checkbox list (owner · deadline shown as metadata), with a "Copy as tasks" button that copies them as Markdown (`- [ ] Task (Owner, deadline)`). New pure `parseActionItems()` (reads the Action Items section, tolerant of `##`/`**` heading variants and bullet markers) and `formatActionItemsMarkdown()` in `constants.js`; `background.js` stores the captured note as `mm2c_last_note` on success and the popup parses it. 7 new JS tests.

---

## [0.1.98] – 2026-06-04 · Built-in prompt templates (P5-K / UX-2)

### Added
- **P5-K / UX-2** — three non-deletable built-in prompt templates (Standup, 1:1, Retro) now ship in `constants.js` as `BUILT_IN_RULES`. The rule matcher was centralised into a pure `matchPromptRule()`; `_runGeminiFlowInner` resolves prompts as user rules → built-in templates → DEFAULT_PROMPT, so a standup/1:1/retro meeting gets a tailored format with zero configuration (and a user rule still overrides). The Rules tab shows them as a read-only "Built-in templates" group with expandable prompts. 7 JS tests (updated `testMatchPromptRule` now uses the real function + built-in coverage).

### Note
- `DEFAULT_PROMPT` was left unchanged: it is fully generic (Attendees/Summary/Key Points/Decisions/Action Items/Next Steps/Open Questions) with no standup/retro-specific text to remove, so trimming it would only weaken the fallback.

---

## [0.1.97] – 2026-06-04 · Recording-state frontmatter (P9-A3c)

### Added
- **P9-A3c** — when Meet's "being recorded" indicator is detected, the meeting is marked recorded (sticky `meetingRecording` flag, checked at join and on each snapshot) and `recording: true` is written to the `.md` frontmatter, with a "Meeting is being recorded" log entry. New defensive `isRecording()` helper probes several candidate selectors. 2 new Python tests.
- **Note:** the recording-indicator selector set still needs verification in a live recorded meeting; a negative result is treated as "unknown" (field omitted), never a false "not recorded".

---

## [0.1.96] – 2026-06-04 · Capture-outcome dot on log groups (UX-7)

### Added
- **UX-7** — each collapsed log group now shows a status dot reflecting the best outcome across its entries (green = sent ok, red = error, amber = warning, grey = info only) via the new pure `groupOutcome()`, so past meetings' capture results are visible at a glance without expanding. 5 new JS tests.

---

## [0.1.95] – 2026-06-04 · Prompt performance monitor (P6-C)

### Added
- **P6-C** — each Gemini capture now logs a `perf:` line with the inject→response-complete duration alongside prompt and response character counts (new pure `formatPerfLog()`), so the correlation between prompt length and latency becomes visible in the Logs tab over many captures. No new UI. 2 new JS tests.

---

## [0.1.94] – 2026-06-04 · Retry works for untitled meetings (BUG-6)

### Fixed
- **BUG-6** — `handle_retry` rejected any retry with an empty title ("No title provided for retry"), so a failed send from an untitled/ad-hoc meeting could never be retried even though a valid backup file existed. Now it only rejects when both title and backup path are missing, and derives a readable note title from the backup filename via the new pure `retry_title_fallback()` (strips date/time prefix and `-snap` suffix). 4 new Python tests.

---

## [0.1.93] – 2026-06-04 · Skip redundant Leave-time Gemini run (BUG-3)

### Fixed
- **BUG-3** — when Leave was clicked shortly after a periodic snapshot completed (but no snapshot was actively in progress), `onLeaveClick` still kicked off a fresh 20–60 s `runGeminiFlow`, making the user wait on the post-meeting page for a result that was already current. New pure `snapshotFreshEnough(cachedTranscriptAt, intervalMs)` helper; when the cached snapshot is younger than half the snapshot interval, the fresh run is skipped and the cache is used directly. 4 new JS tests.

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
