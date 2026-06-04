# C6 — Hints & helper text

## Summary

Twelve hint/helper strings were found across `popup.html` (10) and `popup.js` (2). They read as if written by several different people at different times: some end with a period, some do not; some are imperative ("Leave blank to…"), some are descriptive ("POST each captured note…"); lengths range from a 5-word fragment to a 26-word double sentence. Parallel settings sections (Craft, Obsidian, Webhook, Slack, "Also send to") that all explain a single input field use three different structural patterns. Three hints are missing entirely for settings that have peers with hints. One hint ("Slack: posts the title…") uses a redundant label prefix that no other hint uses.

**Counts by severity:** High — 4 · Med — 6 · Low — 3

---

## Proposed standard (hint style rules)

1. **Sentence case.** Start with a capital letter; all other words lowercase unless they are proper nouns or product names (Craft, Obsidian, Slack, Zapier, etc.).
2. **End with a period.** Every hint ends with `.` No exceptions.
3. **≤ 140 characters.** If longer, cut or split into two hints only when the second sentence is genuinely different information.
4. **Lead with the user benefit or the controlling action.** Pattern: _"[Verb] [what the user does or gets]. [Optional: consequence or fallback.]"_ — e.g. "Leave blank to save to Unsorted." or "Paste your Craft deeplink docId to route notes to a specific folder."
5. **No label prefix inside the hint.** Never repeat the field label as a prefix ("Slack: posts…" → "Posts the title, summary, and action-item count to an incoming webhook.").
6. **Parallel settings get parallel shapes.** Craft folder, Obsidian vault, Webhook URL, Slack webhook, and "Also send to" all explain one field/section — they should all follow the same sentence structure.
7. **No sentence fragments as standalone hints.** A hint should be a full sentence (subject + verb), not a bare noun phrase or fragment.

---

## Findings

| # | Location (file:line) | Current hint | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:916` | `"Match meeting titles with a regex to apply a custom prompt instead of the default."` | Good content, but sits **outside** the collapsible `#rules-body` div — it is always visible even when the rules list is collapsed, making it feel orphaned. Also 82 chars, no peer issues. | Med | Move inside `#rules-body` alongside the rule list so it only appears when the section is open. Keep text as-is (it already ends with a period and is well-formed). |
| 2 | `popup.html:995` | `"Leave blank to save to Unsorted. For a specific folder, paste its Craft deeplink docId here."` | Two sentences, 93 chars — acceptable length. Ends with period. However, it covers **both** the Inbox folder ID field **and** the Space ID field indiscriminately, yet the Space ID already has its own inline placeholder `(blank = default space)`. The hint is ambiguous about which field it refers to. | High | Split into two focused hints: one for Inbox folder ID ("Leave blank to save to Unsorted. Paste a Craft deeplink docId to route notes to a specific folder.") and one for Space ID ("Leave blank to use your default Craft space."). |
| 3 | `popup.html:1004` | `"Click the field to open a folder picker and select your Obsidian vault."` | Imperative, ends with period, 71 chars — well-formed. However, peers (Craft, Webhook) lead with the user benefit; this leads with the mechanism. Minor tone drift. | Low | "Select the folder that contains your Obsidian vault." (benefit-first, 53 chars). |
| 4 | `popup.html:1014` | `"Send each note to these in addition to the primary app above. The primary app is ignored here."` | Two sentences, 95 chars, ends with period. Second sentence ("The primary app is ignored here.") is confusing — it contradicts the first sentence's meaning ("in addition to the primary app"). Likely means the checkboxes here are independent of whichever app is the primary, but reads as if the primary app is skipped. | High | "Copy each note to these apps in addition to the primary destination." (66 chars, one sentence, no contradiction). |
| 5 | `popup.html:1048` | `"POST each captured note as JSON to a URL (Zapier, n8n, Make, your own endpoint). Leave blank to disable."` | Two sentences, 104 chars, ends with period. Starts with HTTP verb `POST` in all-caps — reads technical/developer, inconsistent with the informal tone elsewhere. "Leave blank to disable" is a useful fallback pattern used elsewhere. | Med | "Sends each captured note as JSON to a URL (Zapier, n8n, Make, or your own endpoint). Leave blank to disable." — lowercase verb, consistent voice. |
| 6 | `popup.html:1057` | `"Slack: posts the title, summary, and action-item count to an incoming webhook."` | Starts with label prefix `"Slack: "` — no other hint does this. Redundant because the field label above already reads "Slack". Fragment-ish (no explicit subject, relies on the prefix). Does not end with a period (the period after "webhook" closes the sentence but the colon prefix means the "subject" is the label, not a real grammatical subject). | High | "Posts the meeting title, summary, and action-item count to a Slack incoming webhook. Leave blank to disable." — removes prefix, adds subject, adds fallback, ends with period. |
| 7 | `popup.html:865` | `"Run this command in Terminal:"` | Setup panel instructional text (not a `.hint` element but functions as one). Ends with a colon, not a period. Imperative — fine. But "Terminal" is capitalized as a proper noun (macOS app name) which is correct. Colon is acceptable here as it introduces a code block. | Low | Acceptable as-is given the code-block context. If standardizing: "Run this command in Terminal to install the native host." (more informative). |
| 8 | `popup.html:1077` | `"No activity yet. Notes will appear here after your meetings."` | Empty-state text (`.log-empty`, not a `.hint`). Ends with period, sentence case, two sentences, 62 chars. Well-formed. Consistent with the pattern at line 113 in `popup.js` ("No rules yet…"). | Low | No change needed. |
| 9 | `popup.html:1094` | `"Bot-free meeting notes from Google Meet's built-in Gemini AI."` | About-panel tagline in a `.hint` element. Ends with period, sentence case, 62 chars. Functions as marketing copy rather than a hint. Voice is descriptive, not imperative — appropriate for the About tab. | Low | No change needed; context justifies the descriptive tone. |
| 10 | `popup.js:263` (inside `renderRetryList`) | `"Notes are safe. Click Retry to resend."` | Dynamically injected into `.retry-card-hint`. Two short sentences, ends with period, 39 chars. Well-formed and reassuring. | Low | No change needed. |
| 11 | `popup.html` (Snapshot frequency widget) | *(no hint present)* | The snapshot interval input has only a `.unit-label` `"min (3–30)"` — a bare constraint annotation, not a hint. Peers like Webhook and Craft all have `.hint` paragraphs. Users have no guidance on what snapshot frequency does or why they'd change it. | High | Add: `"How often Gemini is asked to summarize the meeting so far. Lower values give more frequent notes; higher values reduce API calls."` (≤140 chars, benefit-first). |
| 12 | `popup.html` (File backup widget) | *(no hint present)* | The File backup section has no `.hint`. The Folder field has a click-to-pick interaction (same as Obsidian vault) but no hint tells the user to click the field. Obsidian has hint #3 for this. Missing peer hint. | Med | Add under the folder row: `"Click the folder field to choose where notes are saved. Markdown files are named after the meeting title."` |
| 13 | `popup.html` (Note language widget) | *(no hint present)* | No `.hint` under the Note language selector. The "Auto (same as meeting)" option partially self-documents, but there is no explanation of what happens when a language is set (forces the AI to write in that language regardless of meeting language). All other output-affecting settings (prompt rules, webhook, Craft) have hints. | Med | Add: `"Forces the note language regardless of the meeting's spoken language. Leave on Auto to match the meeting."` |

---

### Cross-cutting pattern comparison

The table below shows how the four "destination" settings handle their hint — same information type, different shapes:

| Setting | Has hint? | Ends with period? | Voice | Length |
|---|---|---|---|---|
| Craft folder | Yes | Yes | Imperative ("Leave blank…") | 93 chars |
| Obsidian vault | Yes | Yes | Imperative ("Click the field…") | 71 chars |
| Webhook URL | Yes | Yes | Descriptive ("POST each…") | 104 chars |
| Slack webhook | Yes | No period (colon prefix) | Label-prefixed fragment | 79 chars |
| Also send to | Yes | Yes | Descriptive ("Send each…") | 95 chars |
| File backup folder | **No** | — | — | — |

Craft and Obsidian use imperative; Webhook and Slack use descriptive. Adopting the imperative/benefit-first form across all six would unify the section.
