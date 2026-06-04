# C2 — Terminology

## Summary

Across the six source files and three docs files, **11 distinct terminology concepts** carry conflicting labels. The most damaging are: (1) the output target has four names in active use — "note app", "Output app", "Destination", and app names inline — with no consistent hierarchy; (2) the capture artifact oscillates between "snapshot", "capture", "notes", and "note" in ways that blur what each word means; (3) "native messaging host" is shortened three different ways. No file is internally consistent on its own — the drift is cross-file. The README is the clearest reference and defines the canonical vocabulary used below.

---

## Proposed standard (glossary table)

| Concept | Canonical term | Banned / non-canonical variants |
|---|---|---|
| Where notes are saved (the app selection setting) | **output app** | "note app", "note-taking app", "Destination" (as a standalone label), "dest" |
| Individual app options | **Craft**, **Apple Notes**, **Obsidian** (proper nouns, always capitalised) | "Bear Notes" (should be "Bear"), "craft", "apple_notes" (code keys, not copy) |
| The Python bridge process | **native host** | "native messaging host", "host" (acceptable in short UI strings only), "Native host" (capitalised when starting a sentence or in a label) |
| What the extension produces on capture | **note** (final) / **snapshot** (mid-meeting backup) | "meeting notes", "meeting minutes", "transcript", "capture" (as a noun) — reserve "capture" for the verb |
| Capture as a verb / event | **capture** | "send", "save" (when used as a synonym for the whole capture+push flow) |
| The Gemini prompt (user-editable text) | **prompt** | "instructions", "summary instructions" |
| The prompt-matching entry | **rule** (one entry) / **rules** (the list) | "template" (reserved for built-in templates only), "Meeting rules" (widget title, acceptable as a section header) |
| Pre-configured read-only prompt entries | **built-in template** | "Built-in templates" (acceptable as section heading), "built-in rules" (code/comment, not copy) |
| A Google Meet session | **meeting** | "call" (acceptable in "Leave call" since that is the Meet button's own aria-label), "session" |
| The badge character during capture | **REC** | "REC" is correct — do not write "recording" in badge contexts |
| Product name | **Gememo** | "gememo", "MM2C", "meeting-minutes-to-craft" (legacy internal only) |

---

## Findings

| # | Location (file:line) | Current term | Should be | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:968` | `<div class="widget-title">Output app</div>` + `<span class="label">Destination</span>` | Widget title = "Output app"; row label should also say "App" or be omitted — not "Destination" | High | Change `Destination` label to `App` or remove it; the widget title already names the concept |
| 2 | `README.md:8` | "saves it to your **note app**" | "saves it to your **output app**" | High | Replace "note app" with "output app" — README defines this as the canonical term at line 55 ("**Output apps**") but then uses "note app" in the one-liner |
| 3 | `README.md:8` | "saves formatted notes to **Craft, Obsidian, Bear, or Apple Notes**" (`context.md:9`) | context.md line 9 lists "Bear" which is not a shipped output app (only Craft, Obsidian, Apple Notes are in the dropdown); README line 20 correctly lists "**Craft**, **Apple Notes**, or **Obsidian**" | High | Remove "Bear" from context.md line 9 — it is roadmap-only (5.8), not a current output app; its presence creates false expectations |
| 4 | `popup.html:979` | `<option disabled>Bear Notes</option>` | "Bear" (the app is named Bear, not "Bear Notes") | Med | Change "Bear Notes" to "Bear" in the coming-soon option group |
| 5 | `README.md:43` | "captures the full **Gemini summary** of your meeting" | "captures the **Gemini transcript**" — or, more precisely, "captures the **Gemini notes**"; the extension reads a transcript and formats it into notes; "summary" here pre-empts what Gemini produces | Med | Use "captures the Gemini notes" or "captures the running Gemini response" to match what actually happens |
| 6 | `content_meet.js:1171` | `sendLog('Gemini deactivated — sending notes to Craft')` | "sending notes to **[output app]**" — hardcodes "Craft" even though `currentOutputApp` is already in scope | Med | Replace with `sendLog(\`Gemini deactivated — sending notes to ${outputAppName(currentOutputApp)}\`)` |
| 7 | `background.js:204` | `appendLog('ok', title, \`Retry succeeded — sent to Craft (from ${response.source || 'file'})\`)` | "sent to **[output app]**" — `backupType` is available in the `MM2C_RETRY` handler scope | Med | Parameterise the destination label; use the APP_LABELS map already defined at line 431 |
| 8 | `README.md:36` | "**Verify:** Open the extension popup — the Main tab should show a green dot with '**Native host ready**'." | Consistent: the popup itself says "Native host ready" (`popup.js:377`) — this is fine. But README line 16 says "**native messaging host** is macOS-only" while all other references say "native host". | Med | Standardise README to "native host" throughout; "native messaging host" (line 16) is the only occurrence of the long form in user-facing copy |
| 9 | `context.md:56` | `architecture` block: `meeting_minutes_host.py — receives transcript, parses sections, **pushes to Craft**` | "pushes to **output app**" (Craft is only one of three destinations) | Med | Update context.md line 56 to "routes to the output app (Craft / Apple Notes / Obsidian)" |
| 10 | `popup.html:910` — widget title | `<div class="widget-title">Meeting rules</div>` | "Meeting rules" (acceptable as a section header) but hint text at line 912 says "Match meeting titles with a **regex** to apply a **custom prompt**" — mixing "rule" with "prompt" when the widget is named "rules". The UI calls the text field "Prompt for this meeting type" (`popup.js:129`). Consistent: rule contains a prompt — this is fine. | Low | No change needed; the hierarchy (rule → contains a prompt) is clear. Flag closed. |
| 11 | `popup.html:899` | `<div class="widget-title">Default prompt</div>` | Consistent with README ("**Default prompt**" line 51) — acceptable. | Low | No change needed. |
| 12 | `README.md:51` | "**Default prompt** — structured sections: … Fully customisable from the **Rules tab**" | README calls it "Rules tab" but `popup.html:829` uses `id="tab-rules"` and the visible label is "Rules". Consistent — acceptable. | Low | No change needed. |
| 13 | `README.md:51` | "**Built-in templates** — Standup, 1:1, and Retro formats auto-applied…" then line 53 "**Per-meeting rules**" | "Built-in templates" vs "Per-meeting rules" — these are two distinct concepts and are correctly differentiated in the README. In the popup HTML the section headings are "Built-in templates" (`popup.html:918`) and "Your rules" (`popup.html:921`). README says "Per-meeting rules" while UI says "Your rules". | Med | Align README line 53 label to match popup: "**Your rules**" instead of "Per-meeting rules"; or align popup to README — pick one |
| 14 | `content_meet.js:1013` | `sendLog('Periodic snapshot: capturing current notes…')` | "capturing current **notes**" — here "notes" refers to the snapshot mid-capture; canonical terms are: snapshot = the mid-meeting backup, notes = the final formatted output. Using "notes" for a snapshot blurs the distinction. | Low | Change to `'Periodic snapshot: capturing…'` (remove "current notes") or `'Periodic snapshot: running Gemini capture…'` |
| 15 | `content_meet.js:1019` | `showStatus('✓ Notes snapshot saved', 'ok')` | "Notes snapshot" = redundant blend of both terms. A snapshot is already a notes artifact. | Low | Change to `'✓ Snapshot saved'` |
| 16 | `popup.html:887` | `<div class="widget-title">Action items</div>` | "Action items" (lowercase "items") — README always writes "Action Items" (title case, matching the note section heading). Inconsistent capitalisation. | Low | Change to "Action Items" to match the note section heading the widget reads from |
| 17 | `popup.js:172` (stats cell) | `['Notes saved', ...]` | "Notes saved" — consistent with the concept of a saved note. Acceptable. | Low | No change needed. |
| 18 | `background.js:385` | `appendLog('info', meetTitle, \`Switched to Meet tab — in meeting${gemStr}\`, 'debug')` | "in meeting" — elsewhere the codebase uses "in a meeting" or "in meeting". Minor but inconsistent phrasing. | Low | Change to `'Switched to Meet tab — in a meeting${gemStr}'` for consistency with `content_meet.js:1484` |
| 19 | `README.md:60` | "**Extension badge** — shows '**REC**' (green) during active capture, '**!**' on error" | Consistent with `background.js:339` (`setBadgeText({ text: 'REC' })`). No issue. | Low | No change needed. |
| 20 | `CHANGELOG.md:10` | "receiving transcript, formats it" — body of "The story so far" | Uses "transcript" where the product copy calls it "Gemini response" or "notes". This is internal doc, not user-facing; acceptable. | Low | No change needed (internal doc). |
| 21 | `popup.html:1057` | `<p class="hint">Slack: posts the title, summary, and action-item count to an incoming webhook.</p>` | Consistent with README line 56 ("**Slack** option (title, summary, action-item count)"). No issue. | Low | No change needed. |
| 22 | `content_meet.js:1539` (close overlay) | `"Gemini notes are active. Save a summary to **Craft** before leaving?"` | Hardcodes "Craft" — the user may have selected Apple Notes or Obsidian | High | Change to `Save a summary to ${outputAppName(currentOutputApp)} before leaving?` — `outputAppName` is already defined and in scope at line 1201 |
| 23 | `README.md:85` (config table) | Row: `Output app \| Where notes are saved \| Craft` | Row label "Output app" is consistent with the widget title. However the next row says `Also send to` which matches `popup.html:1009` exactly. Consistent. | Low | No change needed. |
| 24 | `README.md:100` (troubleshooting #5) | `python3 scripts/push_to_craft.py` | The troubleshooting step references a Craft-specific script path, implying manual recovery is Craft-only. Apple Notes and Obsidian users have no equivalent command. | Med | Add a note that manual recovery for Apple Notes/Obsidian requires `meeting_minutes_host.py` directly, or generalize the step |
| 25 | `context.md:9` | "saves formatted notes to **Craft, Obsidian, Bear, or Apple Notes**" | Bear is roadmap-only (5.8). See finding #3. | High | (Duplicate of finding #3 — same location.) |

---

### Severity summary

| Severity | Count |
|---|---|
| High | 4 (findings #1, #2, #3/#25, #22) |
| Med | 8 (findings #4, #5, #6, #7, #8, #9, #13, #24) |
| Low | 13 (findings #10, #11, #12, #14, #15, #16, #17, #18, #19, #20, #21, #23) |

---

## Top 3 one-liners

1. **"Destination" vs "Output app" — two names for the same widget** (`popup.html:968+971`): the widget title says "Output app" but the row label says "Destination"; pick one word and use it everywhere.
2. **"note app" in the README one-liner** (`README.md:8`): the very first user-facing sentence uses a term the rest of the product never uses — "note app" should be "output app" to match the Settings tab label.
3. **"Save a summary to Craft"** hardcoded in the close-guard overlay (`content_meet.js:1539`): this copy lies to every Apple Notes and Obsidian user; `outputAppName(currentOutputApp)` is already defined three lines above.
