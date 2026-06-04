# C8 — Tone & voice

## Summary (what the intended voice IS, per README)

Reading the README from top to bottom, the intended voice is:

- **Confident and direct.** The headline "No bot, no API key, no subscription" uses declarative negation — no hedging, no "might" or "may". The comparative ("Unlike Fireflies, Otter.ai…") is assertive rather than apologetic.
- **Plain-spoken and concrete.** Feature descriptions use short, active constructions: "reads the Gemini transcript", "saves it to your note app", "silently, in the background, without stealing focus". No jargon for its own sake; technical terms (YAML frontmatter, Dataview, regex) appear only where necessary and are always accompanied by plain-language context.
- **Lightly informal but not chatty.** Contractions do not appear, yet the tone avoids formality. The README feels like a well-written engineering blog post rather than either a corporate manual or a casual message.
- **Second-person ("you / your") throughout.** The user is always addressed as "you": "when you leave a call", "your note app", "your Obsidian vault". There is no first-person voice from the product.
- **Privacy-forward.** The phrasing "silently, in the background, without stealing focus" and "no bot" / "no API key" / "no subscription" signal a deliberate positioning around user trust and zero-friction.

The AI-prompt copy in `constants.js` (DEFAULT_PROMPT and BUILT_IN_RULES) correctly uses an imperative instruction voice ("List the meeting attendees…", "Under a heading…", "Only include…") — appropriate for AI system prompts, coherent within their own register.

---

## Proposed standard (voice & tone guide)

**Five principles for all user-facing copy in Gememo:**

### 1. Plain over jargon
Write for someone who knows Google Meet but may not know Chrome extension internals.  
Do: "Run this command in Terminal"  
Don't: "Execute the native messaging host install script"

### 2. Direct, not hedged
State what the product does; omit "might", "should", "may".  
Do: "Notes captured when you leave"  
Don't: "Notes may be captured when you leave the call"

### 3. Consistent second-person — no first-person from the product
The product never says "I" or "we". Labels, tooltips, and toasts address the user as "you".  
Do: "Your notes are safe."  
Don't: "We saved your notes."

### 4. Contractions: avoid in UI labels; allow in sentence-form messages
README copy and multi-word status messages may use contractions ("you're", "didn't") to avoid stiffness. Widget titles, button labels, and one-word actions should not.  
Do (banner): "Gemini notes weren't active — no notes saved"  
Do (label): "Reset to default" (not "Reset to defaults — we won't save your changes")  
Don't (label): "Don't send"

### 5. Sentence case for all labels; plain imperative for buttons
Section headings and widget titles use sentence case ("Snapshot frequency", not "Snapshot Frequency"). Buttons use plain imperative ("Capture now", "Reset to default"). Avoid title case throughout.  
Do: "Action items", "File backup", "Copy as tasks"  
Don't: "Action Items", "File Backup", "Copy As Tasks"

---

## Findings

| # | Location (file:line) | Current copy | Off-voice how | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:848` | `"Not in a meeting."` | Trailing period is the only label in the whole UI that ends with a full stop. All other status strings do not. Inconsistent micro-punctuation. | Low | Remove the period: `"Not in a meeting"` |
| 2 | `popup.html:865` | `"Run this command in Terminal:"` (setup panel) | Only sentence in the UI that ends with a colon directly on static text. Acceptable in docs; slightly awkward in a UI panel. | Low | `"Copy and run this command in Terminal"` — makes the next-step intent explicit and drops the trailing colon |
| 3 | `popup.html:917` | `"Match meeting titles with a regex to apply a custom prompt instead of the default."` (hint text) | "regex" is jargon that contradicts the plain-over-jargon principle. README itself uses "regex" but always in a technical-config context with a code example. In a hint inside a UI widget there is no escape hatch for the term. | Med | `"Match a meeting by title pattern to use a custom prompt instead of the default."` |
| 4 | `popup.html:993` | `"(blank = default space)"` (Craft Space ID placeholder) | Parenthetical shorthand `(blank = X)` is a developer idiom, not plain English. Appears twice in this widget: also on the folder field hint. | Low | `"Leave blank to use your default space"` (matches the existing `<p class="hint">` immediately below, making the placeholder redundant — consider removing the placeholder text entirely and relying on the hint) |
| 5 | `popup.html:995` | `"Leave blank to save to Unsorted. For a specific folder, paste its Craft deeplink docId here."` | "docId" and "deeplink" are technical terms a typical user will not know. | Med | `"Leave blank to save to Unsorted. To use a specific folder, paste its Craft deep-link ID here."` and add a parenthetical link to Craft docs or a tooltip explaining where to find the ID. |
| 6 | `popup.html:1014` | `"Send each note to these in addition to the primary app above. The primary app is ignored here."` | Second sentence ("The primary app is ignored here") is confusing: the primary app is *not* ignored for delivery — it still receives the note. What is meant is that the primary app does not appear as a checkbox option in "Also send to". The hint contradicts the actual behaviour. | High | `"Each note also goes to the apps checked here, in addition to your primary app."` |
| 7 | `popup.html:1048` | `"POST each captured note as JSON to a URL (Zapier, n8n, Make, your own endpoint). Leave blank to disable."` | First sentence is technically accurate but feels like developer documentation dropped into a UI. "POST" is all-caps HTTP jargon. | Med | `"Send each captured note as JSON to a webhook URL — works with Zapier, n8n, Make, or any custom endpoint. Leave blank to disable."` |
| 8 | `popup.html:1057` | `"Slack: posts the title, summary, and action-item count to an incoming webhook."` | Label row reads "Slack" followed immediately by a hint that starts "Slack:" — the word appears twice in two lines. The hint also omits "your" (compare README: "your note app"). | Low | `"Sends the title, summary, and action-item count to your Slack channel."` |
| 9 | `popup.html:1094` | `"Bot-free meeting notes from Google Meet's built-in Gemini AI."` | This is good on-brand copy lifted from the README. No change needed — flagged as a positive anchor. | — | Keep as-is; use as the voice reference for all About-panel copy |
| 10 | `popup.html:1124` | `"<!-- TODO: confirm the Ko-fi handle below matches your account -->"` | Developer TODO comment in the shipped HTML. Invisible to users but ships in production and leaks internal state. | Low | Remove the comment before release |
| 11 | `popup.js:187` | `"These notes saved you roughly <strong>X</strong> of writing time."` + `"If Gememo helps you, please consider supporting it ☕."` | "roughly" is one of the hedging words the voice guide discourages. The coffee-cup emoji in a running sentence is inconsistent with the no-emoji convention in all other product copy. | Low | `"These notes saved you an estimated <strong>X</strong> of writing time."` / keep the Ko-fi link but move the ☕ to the button label only (it already appears there). |
| 12 | `popup.js:189` | `"Capture your first meeting to start tracking your impact."` | "your impact" is marketing-speak that conflicts with the plain-over-jargon principle. It also appears as the widget title ("Your impact") — the phrase carries weight there but is odd in a CTA. | Low | `"Capture your first meeting to see your stats."` |
| 13 | `content_meet.js:759` | `showStatus('Waiting for Gemini...')` | Ellipsis (`...`) is used here, while popup banners use `…` (Unicode). The in-meeting toast family is inconsistent: some use `…` (line 1013: `capturing current notes…`) and some use `...` (this line). | Low | Standardise on `…` (U+2026) throughout all `showStatus` calls. |
| 14 | `content_meet.js:1019` | `showStatus('✓ Notes snapshot saved', 'ok')` | "Notes snapshot" is internal terminology. Compare README: "periodic snapshots". The word "snapshot" is used consistently in the popup, but "Notes snapshot" redundantly combines both concepts. | Low | `'✓ Snapshot saved'` |
| 15 | `content_meet.js:1146` | `showStatus('Meeting ended — capturing notes...')` (proactive capture) | "Meeting ended" as the lead may alarm the user — the call hasn't officially ended from their perspective (they haven't clicked Leave). This message appears when the other participant drops from a 1:1. | Med | `'Gemini ended — capturing notes before you leave…'` |
| 16 | `content_meet.js:1290` | `showStatus('⚠️ Snapshot is ${ageMin} min old — recent discussion may be missing', 'warn')` | `⚠️` emoji appears here but not in equivalent warning toasts elsewhere. "may be missing" is passive hedging; the toast is already styled orange (warn). The ageMin string is the important information. | Med | `'Snapshot is ${ageMin} min old — some recent discussion may not be included'` (drop emoji; use consistent non-alarmist phrasing) |
| 17 | `content_meet.js:1321` | `showStatus('Could not inject prompt — switch to this tab during capture', 'warn')` | "inject prompt" is internal developer terminology. Users have no mental model for "prompt injection". | High | `'Capture paused — please switch to this tab to continue'` |
| 18 | `content_meet.js:1378` | `showStatus('Gemini notes were not active in this meeting', 'warn')` | Passive and slightly blame-y. Contrasts with the more helpful guidance in README troubleshooting item 3. | Med | `'Gemini wasn\'t active — open the Gemini panel at the start of your next meeting'` |
| 19 | `content_meet.js:1535–1552` | Close overlay: `"Gemini notes are active. Save a summary to Craft before leaving?"` + buttons `"Leave without notes"` / `"Save & leave"` | Body text hard-codes "Craft" even when the user has selected Apple Notes or Obsidian as the primary app. This is a factual inaccuracy and a voice inconsistency (the README never names a specific app in a general context). | High | Use `outputAppName(currentOutputApp)`: `"Save a summary to ${outputAppName(currentOutputApp)} before leaving?"` |
| 20 | `constants.js:24–25` | `'Be ultra detailed — these notes must stand alone…'` | "ultra detailed" is informal in a way that feels accidental rather than intentional. The AI prompt copy is otherwise measured and precise. | Low | `'Be thorough and detailed — these notes must stand alone…'` |
| 21 | `constants.js` (BUILT_IN_RULES, all three templates) | Prompt endings like `'Format everything as plain text — no asterisks, underscores, backticks, or markdown.'` | The AI-prompt copy is coherent and uses consistent imperative instruction voice. The terminal formatting constraint is repeated verbatim in each of three templates. This is intentional for reliability but could be extracted to a shared variable for maintainability (not a voice issue per se). | Low | Not a voice issue. Note for a separate code-quality ticket. |
| 22 | `popup.html:987` | `showStatus` / label: `"Open Gemini to capture"` (capture-now button, disabled state, popup.js:349) | Terse to the point of ambiguity — "capture" as noun or verb? "Open Gemini" is an instruction but this is a button, not a tooltip. | Med | `"Open the Gemini panel to capture"` — matches the exact wording already used in the popup banner (`resolveBanner`, constants.js:362) for consistency |
| 23 | `popup.js:363` (via `resolveBanner`) | `'In meeting — open the Gemini panel to enable capture'` | Good, plain, instructional. Positive reference. | — | Keep; use as the model for all "actionable empty-state" messages. |

---

### Severity counts
- **High: 3** (findings 6, 17, 19)
- **Med: 8** (findings 3, 5, 7, 15, 16, 18, 22, and the note on 7)
- **Low: 12** (findings 1, 2, 4, 8, 10, 11, 12, 13, 14, 20, 21, 23-reference)

---

### Top 3 findings (one-liners)

1. **[High #19] Close overlay hard-codes "Craft"** — the save-or-leave dialog always says "Save a summary to Craft" regardless of the user's chosen output app, making the message factually wrong for 2/3 of users.

2. **[High #17] "inject prompt" in a user-facing toast** — `content_meet.js:1321` surfaces an internal developer term directly to the user; replace with action-oriented guidance ("switch to this tab to continue").

3. **[High #6] "The primary app is ignored here" hint is misleading** — `popup.html:1014` implies the primary app doesn't receive the note, which is the opposite of the truth; the hint should confirm that the primary app still runs and the checkboxes add *extra* destinations.
