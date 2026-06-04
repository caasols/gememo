# C3 — Punctuation & typography

## Summary

The codebase is largely well-written but carries a handful of punctuation inconsistencies that break the "one voice" impression. The main fault lines are:

1. **Ellipsis** — most UI strings correctly use the single Unicode character `…` (U+2026), but two visible user-facing strings in `content_meet.js` use three ASCII dots `...` instead.
2. **Trailing periods** — the idle banner `'Not in a meeting.'` ends with a period; every other single-line status/banner message does not. Full-sentence hints in `popup.html` are correctly punctuated, but one multi-sentence hint block adds a trailing period where the surrounding siblings do not.
3. **Dashes** — the `min (3–30)` unit label correctly uses an en-dash as a range separator; all other uses of dashes in UI text are hyphens (appropriate). No rogue em-dash in user-visible text.
4. **Quotes** — all user-visible strings use straight ASCII quotes consistently. No curly-quote intrusion.
5. **Spacing / parentheticals** — `(3–30)` range is correct. Spacing around punctuation is clean throughout.

Net count: **2 High**, **3 Med**, **2 Low** findings.

---

## Proposed standard

| Context | Rule |
|---|---|
| **Ellipsis** | Always use the single-character `…` (U+2026). Never write `...` in any string visible to the user (status toasts, labels, placeholders, banners, button text). |
| **Dashes — range** | Use en-dash `–` between numeric bounds: `min (3–30)`, `0–23`. |
| **Dashes — separator** | Use em-dash `—` for subject–predicate separators in multi-clause status lines (e.g. `In meeting — open the Gemini panel…`). Already done consistently in `constants.js`; apply everywhere. |
| **Trailing period** | Full-sentence hint/status that forms a complete, standalone sentence: **add period**. Fragment labels, button text, placeholder text, toast messages that complete the sentence in context: **no period**. The single-sentence idle state `'Not in a meeting.'` is the correct anchor: it is a complete standalone sentence, so the period stays. Every other one-line status/banner that is NOT a complete sentence should have no period. |
| **Quotes** | Straight ASCII quotes `"` and `'` everywhere in code strings. No curly quotes. |
| **Parentheticals** | Use `(value)` with no space before the opening paren when appended inline to a label. Range format: `(low–high)` with en-dash. |

---

## Findings

| # | Location (file:line) | Current string | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `content_meet.js:246` | `'Capturing notes...'` (showStatus call in `onLeaveClick`) | Three ASCII dots instead of `…` | High | `'Capturing notes…'` |
| 2 | `content_meet.js:1013` | `'Periodic snapshot: capturing current notes…'` — correct `…` here, but see next row below for the companion toast | — | — | (no change needed here) |
| 3 | `content_meet.js:1172` | `showStatus(\`Saving notes to ${outputAppName(currentOutputApp)}...\`)` | Three ASCII dots instead of `…` | High | `\`Saving notes to ${outputAppName(currentOutputApp)}…\`` |
| 4 | `content_meet.js:1342` | `\`Sending notes to ${outputAppName(currentOutputApp)}...\`` | Three ASCII dots instead of `…` | High | `\`Sending notes to ${outputAppName(currentOutputApp)}…\`` |
| 5 | `constants.js:370` | `{ text: 'Not in a meeting.', cls: '' }` | Only status-banner string with a trailing period. All other `resolveBanner` return values — `'Capturing notes…'`, `'In meeting — notes captured when you leave'`, `'In meeting — open the Gemini panel to enable capture'` — have no period. The period is correct here (complete sentence), but creates an inconsistency with the last-status path where `lastStatus` strings forwarded from `background.js` also lack periods. | Med | Keep the period; instead **add** a trailing period to the two in-meeting messages (`'In meeting — notes captured when you leave.'`, `'In meeting — open the Gemini panel to enable capture.'`) so all complete-sentence banners end with `.`. |
| 6 | `popup.html:995` | `'Leave blank to save to Unsorted. For a specific folder, paste its Craft deeplink docId here.'` | Two-sentence hint correctly ends with a period. However the immediately adjacent Obsidian hint at line 1004 (`'Click the field to open a folder picker and select your Obsidian vault.'`) also ends with a period — that is consistent and correct. But the webhook hints at lines 1048 and 1057 (`'POST each captured note as JSON…. Leave blank to disable.'` and `'Slack: posts the title, summary, and action-item count to an incoming webhook.'`) end with periods, while the "Also send to" hint at line 1014 (`'Send each note to these in addition to the primary app above. The primary app is ignored here.'`) also ends with a period. All these are complete sentences — the pattern is consistent within hints. No change needed here. | — | No change needed. |
| 7 | `popup.html:957` | `<option value="__custom__">Other…</option>` | Uses correct `…` (U+2026). Confirmed correct. | — | No change. |
| 8 | `popup.html:859` | `<span id="host-label">Checking native host…</span>` | Uses correct `…`. | — | No change. |
| 9 | `popup.html:1065` | `placeholder="Search past meetings…"` | Uses correct `…`. | — | No change. |
| 10 | `popup.html:1002` | `placeholder="Select vault…"` | Uses correct `…`. | — | No change. |
| 11 | `popup.js:256` | `entry.title.slice(0, 45) + '…'` | Uses correct `…`. | — | No change. |
| 12 | `popup.js:515` | `retryBtn.textContent = 'Retrying…'` | Uses correct `…`. | — | No change. |
| 13 | `popup.js:863` | `$('status').textContent = 'Capturing notes…'` (storage onChange handler) | Uses correct `…`. Consistent with `resolveBanner`. | — | No change. |
| 14 | `content_meet.js:238` | `sendLog('Tab not active — waiting to return before injecting prompt...')` | Three ASCII dots in a log string (not user-visible in the popup, but appears in the Logs panel detail). | Med | `'Tab not active — waiting to return before injecting prompt…'` |
| 15 | `popup.html:993` | `placeholder="(blank = default space)"` | Parenthetical style with descriptive text inside parens — fine as-is. But note it uses a hyphen ` = ` rather than a dash. Consistent with other placeholder text. | Low | Consider `placeholder="leave blank for default space"` to match the prose style of other hints, but current form is acceptable. |
| 16 | `popup.html:939` | `<span class="unit-label">min (3–30)</span>` | En-dash used correctly for range. | — | No change. |
| 17 | `content_meet.js:1539` | `'Gemini notes are active. Save a summary to Craft before leaving?'` (close overlay body copy) | The second sentence ends with `?` — correct. But the word "Craft" is hard-coded in an overlay that respects `currentOutputApp` for toasts elsewhere. Typography is fine; "Craft" is a semantic inconsistency noted for reference. | Low | Typography is correct. Semantic fix (`outputAppName(currentOutputApp)`) is out-of-scope for this audit dimension. |
| 18 | `content_meet.js:919` | `showStatus('Hover over the ✦ Gemini button → click "Start now" to enable notes', 'warn')` | Straight ASCII double-quotes around "Start now" — consistent with the rest of the codebase. | — | No change. |

---

### Consolidated actionable findings only

| # | Location (file:line) | Current string | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `content_meet.js:1246` | `showStatus('Capturing notes...')` | `...` should be `…` | **High** | `'Capturing notes…'` |
| 2 | `content_meet.js:1172` | `showStatus(\`Saving notes to ${outputAppName(currentOutputApp)}...\`)` | `...` should be `…` | **High** | `\`Saving notes to ${outputAppName(currentOutputApp)}…\`` |
| 3 | `content_meet.js:1343` | `showStatus(\`Sending to ${outputAppName(currentOutputApp)}...\`)` | `...` should be `…` | **High** | `\`Sending to ${outputAppName(currentOutputApp)}…\`` |
| 4 | `content_meet.js:238` | `sendLog('Tab not active — waiting to return before injecting prompt...')` | `...` in Logs-panel-visible string | **Med** | Replace `...` with `…` |
| 5 | `constants.js:358–362` | `'Capturing notes…'` / `'In meeting — notes captured when you leave'` / `'In meeting — open the Gemini panel to enable capture'` | Only `'Not in a meeting.'` has a trailing period; the two in-meeting complete sentences do not | **Med** | Add `.` to both in-meeting messages for consistency |
| 6 | `popup.html:993` | `placeholder="(blank = default space)"` | Parenthetical style inconsistent with prose hints; minor | **Low** | Optional: `"leave blank for default space"` |
| 7 | `content_meet.js:1539` | `'Save a summary to Craft before leaving?'` | "Craft" hard-coded while toasts use dynamic `outputAppName()` — typography fine, semantic gap | **Low** | Out of scope for punctuation; note for copy pass |
