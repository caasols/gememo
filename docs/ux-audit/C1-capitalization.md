# C1 — Capitalization

## Summary

The codebase has four distinct capitalization issues across its text roles:

1. **Button labels are split between Sentence case and Title Case** — "Capture now" and "Add rule" (Sentence case) coexist with "Open Gemini to capture", "Copy as tasks", "Save & leave" (Title/mixed case) and "Retry →", "Copy", "Set up" (other patterns). No single convention is applied.
2. **Widget/section titles (.widget-title) are styled `text-transform: uppercase` in CSS**, so the source text is written in mixed case ("Action items", "Default prompt") but renders as ALL-CAPS. The `.rules-subhead` class also has `text-transform: uppercase`. Both classes force uppercase visually, making their source-case effectively irrelevant — but the two classes use inconsistent `letter-spacing` (0.6px vs 0.04em ≈ 0.52px at 13 px), a minor presentational inconsistency.
3. **Row labels (.label) have no consistent case**: "Inbox folder ID" (capitalised abbreviation mid-word), "Space ID", "Vault folder", "Custom language", "Language", "Enabled", "File type", "Folder", "URL", "Slack", "Also send to", "Destination", "GitHub" — mostly Sentence case but with inconsistent treatment of product names and abbreviations.
4. **Dynamic status/toast strings** mix sentence-ending period style inconsistently: "Not in a meeting." has a period; "In meeting — notes captured when you leave" does not; "Capturing notes…" uses an ellipsis; "Gemini notes were not active in this meeting" has neither.

Overall, **Sentence case** is the dominant intent for most roles (buttons, labels, hints, status strings), but Title Case intrudes in several buttons and overlay text.

---

## Proposed standard (capitalization rule per text role)

| Role | CSS class / element | Proposed convention | Notes |
|---|---|---|---|
| Page / app title | `h1`, About name | Title Case | Proper noun ("Gememo") — already correct |
| Tab labels | `.tab` button | Title Case | Single-word tabs are identical in both cases; standardise for future multi-word tabs |
| Widget / section titles | `.widget-title` | Source text: Sentence case (rendered uppercase by CSS) | CSS `text-transform:uppercase` handles display; source should be Sentence case for consistency |
| Sub-section labels | `.rules-subhead` | Source text: Sentence case (rendered uppercase by CSS) | Same as `.widget-title` |
| Row labels | `.label` | Sentence case | Capitalise only proper nouns and accepted abbreviations (ID, URL) |
| Button labels | `.btn`, `.btn-capture-now`, etc. | Sentence case | "Copy", "Set up", "Add rule", "Capture now", "Save & leave", "Leave without notes" |
| Select `<option>` labels | `<option>` | Sentence case for generic options; preserve proper nouns | "Auto (same as meeting)", "Markdown (.md)", "Plain text (.txt)" — correct; "None" — correct |
| Placeholder text | `placeholder=""` | Sentence case | Already consistent |
| Hint text | `.hint` | Sentence case, no trailing period except at end of multi-sentence hints | Harmonise termination style |
| Status / toast strings | `resolveBanner`, `showStatus`, `renderRetryList` | Sentence case, no trailing period (banners are inline labels, not sentences) | "Not in a meeting." should drop its period to match the rest |
| Log messages | `sendLog`, `appendLog` | Sentence case, no trailing period | Already mostly consistent; a few violations |
| DEFAULT_PROMPT section headings | Quoted strings inside `DEFAULT_PROMPT` | Title Case (these become rendered headings in the note output) | "Attendees", "Summary", "Key Points", "Decisions Made", "Action Items", "Next Steps", "Open Questions" — already Title Case; keep |
| BUILT_IN_RULES section headings | Strings inside rule `prompt` values | Title Case | Mixed (see findings) |
| Stats labels | `.stat-label` via `renderStats` | Sentence case | Already consistent |
| Overlay text (close guard) | `showCloseOverlay` inline HTML | Sentence case | "Leaving without notes?" heading is acceptable as Sentence case; body copy is correct |

---

## Findings

| # | Location (file:line) | Current string | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | popup.html:887 | `"Action items"` (widget-title source) | Source text Title Case mix: "Action items" uses lowercase 'i'. Irrelevant at runtime (CSS uppercases it) but inconsistent with other widget-title sources which are all Sentence case. Low impact since CSS overrides display. | Low | Keep as Sentence case: "Action items" — already correct. Flag that all `.widget-title` source text must be Sentence case. |
| 2 | popup.html:859 | `Set up` (button label) | Sentence case — correct. But compare with popup.js:349 `"Open Gemini to capture"` (also a button label, Sentence case). These are consistent. | — | No change needed; document as the standard. |
| 3 | popup.html:869 | `Copy` (button — copy install cmd) | Single-word, case-neutral. Consistent with other "Copy" buttons. | — | No change. |
| 4 | popup.html:906 | `Reset to default` (`.reset-link`) | Sentence case — correct for this role. | — | No change. |
| 5 | popup.html:922 | `Add rule` (button `#add-rule-btn`) | Sentence case — correct. | — | No change. |
| 6 | popup.html:949 | `Auto (same as meeting)` (`<option>`) | Sentence case — correct. | — | No change. |
| 7 | popup.html:989 | `Inbox folder ID` (`.label`) | "ID" in all-caps mid-label is the accepted abbreviation. Consistent with "Space ID" on line 993. | — | No change; document "ID" and "URL" as accepted all-caps abbreviations in labels. |
| 8 | popup.html:993 | `Space ID` (`.label`) | Correct — see finding 7. | — | No change. |
| 9 | popup.html:1001 | `Vault folder` (`.label`) | Sentence case — correct. | — | No change. |
| 10 | popup.html:1070 | `Diagnostics` (checkbox label) | Title Case for a single-word inline label — ambiguous but acceptable since single-word labels are case-neutral. | Low | Acceptable as-is; no change required. |
| 11 | popup.html:1094 | `"Bot-free meeting notes from Google Meet's built-in Gemini AI."` (About `.hint`) | Sentence case with trailing period — correct for a full sentence description. | — | No change. |
| 12 | popup.html:1125 | `"☕ Support on Ko-fi"` (button) | Title Case ("Support", "Ko-fi" is a proper noun). "Support on Ko-fi" is Sentence case if read as a phrase; "Ko-fi" is a brand name. Acceptable. | Low | Accept as brand-name exception. No change. |
| 13 | popup.js:349 | `'Open Gemini to capture'` (capture button text when Gemini not active) | Sentence case — correct. Consistent with "Capture now". | — | No change. |
| 14 | popup.js:346 | `'Capturing notes…'` (capture button text while capturing) | Sentence case with ellipsis — correct. | — | No change. |
| 15 | popup.js:503–506 | `'Copied!'` / `'Copy'` (copy-ext-id button toggle) | "Copied!" uses an exclamation mark; other copy buttons use "Copy" / "Copied!" inconsistently — popup.html:869 `Copy`, popup.js:656 `'Copied!'`, popup.js:657 `'Copy'`, popup.js:919 `'Copied!'`, popup.js:920 `'Copy as tasks'`. The "Copied!" feedback form is consistent across all instances. | Low | Consistent. No change needed. |
| 16 | popup.js:529 | `'Failed ✗'` (retry button on error) | Title fragment, Sentence case — acceptable for a short state label. | Low | Acceptable. |
| 17 | popup.js:515 | `'Retrying…'` (retry button while retrying) | Sentence case — correct. | — | No change. |
| 18 | popup.js:263 | `'Notes are safe. Click Retry to resend.'` (retry card hint) | Sentence case with period — correct for a full sentence. "Retry" is capitalised as a proper button-name reference — acceptable. | — | No change. |
| 19 | popup.js:274 | `'Retry →'` (retry card button) | Title Case fragment with arrow. Compare "Save & leave" and "Leave without notes" in content_meet.js:1545,1542. Inconsistent arrow usage — no other button uses an arrow. | Med | Change to `"Retry"` (plain Sentence case, no arrow glyph) to match all other buttons. |
| 20 | popup.js:358 | `'Capturing notes…'` (status banner text — resolveBanner) | Sentence case with ellipsis, no period — correct. | — | No change. |
| 21 | popup.js:360 | `'In meeting — notes captured when you leave'` (status banner) | Sentence case, no period — correct pattern. | — | No change. |
| 22 | popup.js:362 | `'In meeting — open the Gemini panel to enable capture'` (status banner) | Sentence case, no period — correct pattern. | — | No change. |
| 23 | constants.js:370 | `'Not in a meeting.'` (resolveBanner idle state) | **Trailing period** — the only status banner string that ends with a period. All other banner strings (lines 358, 360, 362) have no period. Inconsistent punctuation style within the same role. | High | Remove the period: `'Not in a meeting'` |
| 24 | popup.js:189 | `'Capture your first meeting to start tracking your impact.'` (stats savings hint) | Sentence case with period — correct for a full sentence. | — | No change. |
| 25 | popup.js:187 | `'These notes saved you roughly … of writing time. If Gememo helps you, please consider …'` | Sentence case, two sentences each ending with period — correct. | — | No change. |
| 26 | popup.js:113 | `'No rules yet. Add one to use a custom prompt for specific meetings.'` (rules-empty) | Sentence case, period — correct. | — | No change. |
| 27 | popup.js:429 | `'No activity yet. Notes will appear here after your meetings.'` (log-empty) | Sentence case, period — correct. Consistent with line 77 in popup.html which shows the static initial value. | — | No change. |
| 28 | popup.js:220 | `'No matching past meetings.'` (search-empty) | Sentence case, period — correct for a full sentence. | — | No change. |
| 29 | popup.js:226 | `'Untitled meeting'` (search result fallback title) | Sentence case — correct for a dynamic fallback label. | — | No change. |
| 30 | popup.js:436 | `` `${groups.length} meeting${…} · ${logs.length} entr${…}` `` (logs-count) | Lowercase throughout — correct for a count label. | — | No change. |
| 31 | popup.js:373 | `'Version mismatch — click Set up to reinstall …'` (host label) | "Set up" is capitalised to match the adjacent button label — correct cross-reference. | — | No change. |
| 32 | popup.js:377 | `'Native host ready'` / `'Native host ready (v…)'` (host label) | Sentence case — correct. | — | No change. |
| 33 | popup.js:382 | `'Native host not found — click Set up to install'` (host label error) | Sentence case — correct. | — | No change. |
| 34 | content_meet.js:759 | `'Waiting for Gemini...'` (showStatus toast) | Sentence case — correct. Uses `...` (three ASCII periods) while all popup banner strings use `…` (Unicode ellipsis U+2026). Inconsistent ellipsis character. | Med | Replace `...` with `…`: `'Waiting for Gemini…'` |
| 35 | content_meet.js:1013 | `'Periodic snapshot: capturing current notes…'` (sendLog) | Sentence case, colon, Unicode ellipsis — acceptable log style. | — | No change. |
| 36 | content_meet.js:1019 | `'✓ Notes snapshot saved'` (showStatus ok toast) | Sentence case — correct. Uses checkmark prefix (consistent with other ok toasts). | — | No change. |
| 37 | content_meet.js:1146 | `'Meeting ended — capturing notes...'` (showStatus while capturing) | Sentence case — correct for a toast. Again uses ASCII `...` instead of Unicode `…`. | Med | Change to `'Meeting ended — capturing notes…'` |
| 38 | content_meet.js:1172 | `` `Saving notes to ${outputAppName(currentOutputApp)}...` `` (showStatus) | ASCII `...` ellipsis, same issue as finding 34/37. | Med | Change to Unicode `…`. |
| 39 | content_meet.js:1246 | `'Capturing notes...'` (showStatus at Leave) | ASCII `...` once more. | Med | Change to `'Capturing notes…'` |
| 40 | content_meet.js:1343 | `` `Sending to ${outputAppName(currentOutputApp)}...` `` (showStatus) | ASCII `...`. | Med | Use `…`. |
| 41 | content_meet.js:1535 | `'Leaving without notes?'` (close overlay heading) | Sentence case — correct. | — | No change. |
| 42 | content_meet.js:1539 | `'Gemini notes are active. Save a summary to Craft before leaving?'` (close overlay body) | Sentence case, period — correct. "Craft" is a proper noun — correct capitalisation. | — | No change. |
| 43 | content_meet.js:1542 | `'Leave without notes'` (close overlay button) | Sentence case — correct. | — | No change. |
| 44 | content_meet.js:1548 | `'Save &amp; leave'` (close overlay button) | Sentence case — correct. Consistent with "Leave without notes". | — | No change. |
| 45 | background.js:167 | `'Duplicate send skipped — notes already sent for this meeting within the last 40 minutes'` | Sentence case — correct for a log message. | — | No change. |
| 46 | background.js:204 | `` `Retry succeeded — sent to Craft (from ${response.source \|\| 'file'})` `` | Sentence case — correct. | — | No change. |
| 47 | background.js:431 | `APP_LABELS` object: `{ craft: 'Craft', apple_notes: 'Apple Notes', none: 'None', obsidian: 'Obsidian' }` | "None" is capitalised — matching the `<option>` label in popup.html:972 (`None`). Consistent. "Apple Notes", "Obsidian", "Craft" are proper nouns — correct. | — | No change. |
| 48 | background.js:433–437 | `` `Saved to ${dest}: ${response.title}…` `` / `` `Saved to ${dest}.…` `` | Sentence case — correct. Note: the second form ends with a period before `${filePart}` only when filePart is empty, producing "Saved to Craft." with a period or "Saved to Craft. + file.md" with odd punctuation. This is a punctuation/formatting bug, not a capitalization issue. | — | Out of scope for C1. |
| 49 | constants.js:6–29 | `DEFAULT_PROMPT` — heading strings: `"Attendees"`, `"Summary"`, `"Key Points"`, `"Decisions Made"`, `"Action Items"`, `"Next Steps"`, `"Open Questions"` | All Title Case — correct for document section headings that appear in the final note output. Consistent throughout. | — | No change. |
| 50 | constants.js:161–203 | `BUILT_IN_RULES[0]` (Standup): heading strings in prompt: `"Attendees"`, `"Updates"`, `"Blockers"` | Title Case — consistent with DEFAULT_PROMPT headings. Correct. | — | No change. |
| 51 | constants.js:176–189 | `BUILT_IN_RULES[1]` (1:1): headings: `"Summary"`, `"Discussion"`, `"Decisions"`, `"Action Items"`, `"Follow-up"` | `"Follow-up"` uses a hyphen and lowercase 'u' — consistent Sentence-case-style heading. **However**, `"Decisions"` (without "Made") breaks the pattern established by DEFAULT_PROMPT's `"Decisions Made"`. Inconsistency across DEFAULT_PROMPT vs BUILT_IN_RULES. | Med | Standardise 1:1 prompt heading to `"Decisions Made"` to match DEFAULT_PROMPT, OR explicitly document that shorter names are intentional for the 1:1 template. |
| 52 | constants.js:193–202 | `BUILT_IN_RULES[2]` (Retro): headings: `"What Went Well"`, `"What To Improve"`, `"Action Items"` | `"What To Improve"` — **Title Case** with "To" capitalised is inconsistent with standard Title Case rules (prepositions of 3 letters or fewer are typically lowercased: "What to Improve"). More critically, `"What To Improve"` uses Title Case while `"What Went Well"` also does. Both are consistent with each other but the preposition "To" should be lowercase in Title Case. | Low | Change to `"What to Improve"` (standard Title Case: don't capitalise short prepositions). |
| 53 | constants.js:119 | `_NOTE_HEADING_RE` pattern includes lowercase variants: `'what went well'`, `'what to improve'` | The regex is case-insensitive (`/i` flag) so this is not a capitalisation bug — it correctly matches both cases. | — | No change. |
| 54 | popup.html:828–832 | Tab labels: `"Main"`, `"Rules"`, `"Settings"`, `"Logs"`, `"About"` | All Title Case — consistent. Single-word labels are case-neutral but Title Case is the standard for navigation tabs. | — | No change; document as the standard. |
| 55 | popup.html:848 | `'Not in a meeting.'` — static initial value in `<span id="status">` | Same period issue as finding 23 (this is the static HTML seed that resolveBanner replaces at runtime). | High | Change to `'Not in a meeting'` (no period), matching the convention fix in finding 23. |
| 56 | popup.html:1077 | `'No activity yet. Notes will appear here after your meetings.'` — static log-empty div | Sentence case with period — correct for multi-sentence copy. | — | No change. |
| 57 | popup.html:1033 | `Markdown (.md)` / `Plain text (.txt)` (`<option>` labels) | Sentence case with proper nouns — correct. | — | No change. |
| 58 | popup.html:972 | `None` (`<option>`) | Capitalised — matches the `APP_LABELS` map in background.js. Consistent. | — | No change. |
| 59 | popup.html:976 | `<optgroup label="Coming soon">` | "Coming soon" — Sentence case — correct for an inline group label. | — | No change. |
| 60 | popup.html:976–980 | Disabled options: `Notion`, `Google Docs`, `Bear Notes`, `Evernote` | All proper nouns — correct capitalisation. | — | No change. |
| 61 | popup.html:1055 | `.label` `"Slack"` (webhook row label) | Proper noun — correct. | — | No change. |
| 62 | popup.html:1099 | `.widget-title` source `"Your impact"` | Sentence case — correct (CSS uppercases for display). | — | No change. |
| 63 | popup.html:1122 | `.widget-title` source `"Support development"` | Sentence case — correct. | — | No change. |
| 64 | content_meet.js:918 | `'Hover over the ✦ Gemini button → click "Start now" to enable notes'` (showStatus warn) | Sentence case — correct. "Start now" is quoted to match the in-UI label. | — | No change. |
| 65 | content_meet.js:984 | `'Hover over ✦ Gemini button → click "Start now" to enable notes'` (showStatus warn, second occurrence) | Sentence case — correct. Note: this string differs slightly from finding 64 (drops "the" before "✦ Gemini button"). Minor wording inconsistency, not a capitalisation issue. | — | Out of scope for C1. |
| 66 | content_meet.js:987 | `'Gemini may be disabled for your account — check with your Google Admin'` (showStatus warn) | "Google Admin" — Title Case for a proper product role name — correct. "Gemini" — proper noun — correct. | — | No change. |
| 67 | content_meet.js:1378 | `'Gemini notes were not active in this meeting'` (showStatus warn) | Sentence case, no period — correct for a toast message. | — | No change. |
| 68 | background.js:385 | `` `Switched to Meet tab — in meeting${gemStr}` `` where gemStr is `', Gemini active'` or `', Gemini not active'` | Sentence case (lowercase after dash separator) — correct for a log message. | — | No change. |
| 69 | popup.js:887 | `'Sent ✓'` (log retry button on success) | Title fragment — acceptable short feedback state. | Low | Acceptable. |
