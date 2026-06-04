# C7 — Empty states & placeholders

## Summary

The UI mixes three distinct placeholder philosophies, two different null-value glyphs, and alternates between a helpful empty-state model and a terse one. Nothing is obviously broken, but the inconsistency creates a "different author" feeling whenever a user moves between widgets. Placeholders range from real-URL examples (`https://hooks.example.com/...`) to instructional labels (`Select vault…`) to parenthetical hints (`(blank = default space)`) — all within the same Settings panel. Null-value display uses an em-dash ("—") in the snapshot widget but the string `"Untitled meeting"` elsewhere. Empty-state messages vacillate between a friendly sentence with context (`.log-empty`) and bare statements with none (`.rules-empty`, `.search-empty`).

---

## Proposed standard

### Placeholder philosophy — ghost examples only
Every `placeholder` attribute should show the lightest possible real-world example that demonstrates expected format, not instructions, parenthetical meta-commentary, or imperative verbs. Read-only fields that open a picker on click should have no placeholder at all — the click-to-pick affordance is communicated by a `hint` below the row, not the input itself.

| Pattern | Approved form | Examples |
|---|---|---|
| URL field | Lowest-friction real URL, trailing `...` to show it continues | `https://hooks.example.com/...` ✓ |
| Path field | Canonical default path | `~/Downloads/meeting-notes` ✓ |
| Text (free) | Shortest recognisable example | `Japanese` (not `e.g. Japanese`) |
| Regex field | Shortest recognisable pattern | `DAILY` ✓ |
| Prompt textarea | One short imperative | `Focus on decisions and owners.` |
| Read-only picker | *(empty — hint carries the instruction)* | — |
| Optional ID field | *(empty — leave truly blank)* | — |

### Empty-state template
Every container that can be devoid of content must show exactly:

> **One sentence** that (a) confirms the list is empty and (b) tells the user what will fill it or what to do.

Format: plain sentence, sentence-case, period at the end.

```
No rules yet. Add one below to apply a custom prompt for specific meetings.
No matching meetings. Try a shorter search term.
No activity yet. Notes will appear here after your meetings.   ← already correct
```

### Null-value glyph — em-dash everywhere
When a live value is not yet available (no snapshot taken, no countdown started), display `—` (U+2014 em-dash). Never substitute a fallback string like `"Untitled meeting"` for a value that is genuinely absent; use `—` or omit the field until the value exists.

---

## Findings

| # | Location (file:line) | Current string | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | popup.html:993 | `placeholder=""` (Craft "Inbox folder ID") | Blank placeholder — field purpose is unclear; no example of what a Craft docId looks like. Low discoverability. | High | Use ghost example: `a1b2c3d4-…` (short docId fragment) or remove and rely solely on the `hint` below. |
| 2 | popup.html:994 | `placeholder="(blank = default space)"` | Parenthetical instruction inside a placeholder is a third philosophy not used anywhere else. Reads like a code comment, not a UI hint. | High | Replace with the existing `hint` text below (which already says "Leave blank to save to Unsorted") and leave the placeholder empty or use `default space`. |
| 3 | popup.html:1002 | `placeholder="Select vault…"` | Imperative verb + ellipsis is the "instructional" style. All other read-only picker fields have no placeholder or a path example. The field is read-only; the `hint` on line 1004 already gives the instruction. | High | Remove the placeholder entirely (field is read-only; hint text carries the message). |
| 4 | popup.html:963 | `placeholder="e.g. Japanese"` | "e.g." prefix is prose narration, not a ghost example. All other placeholders omit the "e.g." prefix. | Med | `Japanese` (drop the prefix). |
| 5 | popup.html:1039 | `placeholder="~/Downloads/meeting-notes"` | This is the correct ghost-example form — but it is also the hardcoded `DEFAULT_FILE_PATH` constant. When the host resolves `~` to a real path (popup.js:638), the resolved path is placed in `.value`, but if the user clears the field the placeholder re-shows the `~` form. Cosmetically inconsistent. | Med | Keep as-is but note: after host resolution, also update the placeholder via JS so it matches the resolved default. |
| 6 | popup.html:1051 | `placeholder="https://hooks.example.com/..."` | Correct ghost-example style with trailing ellipsis — the best pattern in the file. No issue. Documented as the **reference pattern** for all other URL fields. | — | No change needed. |
| 7 | popup.html:1055 | `placeholder="https://hooks.slack.com/services/..."` | Correct ghost-example style. Trailing `...` consistent with #6. | — | No change needed. |
| 8 | popup.js:113–114 | `'<div class="rules-empty">No rules yet. Add one to use a custom prompt for specific meetings.</div>'` | Content is helpful but sentence flow is slightly awkward ("Add one to use…"). Also, the "Add rule" button that fulfils the call to action is hidden behind the collapsed `rules-body` when the empty state is shown. The call to action directs the user to a control they cannot see. | Med | Rewrite: `No rules yet. Expand this section and click "Add rule" to apply a custom prompt for specific meetings.` — or ensure the empty-state only renders when rules-body is visible. |
| 9 | popup.js:221 | `'<div class="search-empty">No matching past meetings.</div>'` | Single sentence with no action hint. Consistent with the proposed standard in its factual statement, but lacks the "what to do" half of the template. | Med | `No matching meetings. Try a shorter search term.` (removes redundant "past", adds the nudge.) |
| 10 | popup.html:1077 & popup.js:430–431 | `'No activity yet. Notes will appear here after your meetings.'` | Best-in-class empty state — correct length, explains what will fill it, no imperative. **Reference model.** | — | No change; this is the target for all other empty states. |
| 11 | popup.js:96 & 104 | `` `Last snapshot: ${formatSnapshotAge(snap.ts)}` `` and initial HTML `Last snapshot: —` (popup.html:877) | The initial HTML correctly shows `—` as the null glyph. Once a snapshot exists, the age is injected. Consistent. | — | No change needed. |
| 12 | popup.html:878 | `Next in: —` (initial static text, `id="snapshot-next"`, immediately hidden) | Em-dash used as null glyph here too — consistent with `Last snapshot: —`. The element is hidden until a live value is available, so the `—` is never actually rendered. No user-facing issue, but the hidden element could simply be left empty. | Low | Either leave blank (`Next in: `) or keep `—`; ensure no other countdown field uses a different null glyph. |
| 13 | popup.js:257 | `'Unknown meeting'` (fallback in `renderRetryList` when `entry.title` is absent) | Uses a prose fallback string instead of the project-wide em-dash `—` null glyph. Breaks the "null = em-dash" convention. | Med | Replace with `—` or omit the title row when no title is available, consistent with how `renderLogs` handles `groupTitle` (uses `'System'` — see finding #14). |
| 14 | popup.js:441 | `` const groupTitle = group.title \|\| 'System'; `` | Falls back to `'System'` when a log group has no title. The convention established by the snapshot widget is em-dash for unknown/missing values. `'System'` is a semantic label (not a missing-value glyph), which is defensible, but it diverges from the em-dash standard if it ever surfaces alongside retry cards that use `'Unknown meeting'`. | Low | Decide: keep `'System'` as a deliberate semantic label (add a comment) or align to `—`. Either is fine; just be consistent with finding #13. |
| 15 | popup.js:129 | `placeholder="Prompt for this meeting type"` (rule-prompt textarea) | Instructional style, not ghost-example style. Uses sentence-case imperative, no period. Inconsistent with the ghost-example standard. | Low | Replace with a concrete ghost example: `Summarise action items and owners only.` |
| 16 | popup.js:124 | `placeholder="e.g. DAILY"` (rule-regex input) | "e.g." prefix. See finding #4 — same issue in a dynamically generated element. | Low | `DAILY` (drop the prefix, consistent with finding #4 fix). |
| 17 | popup.html:949 | `<option value="">Auto (same as meeting)</option>` | Select default is instructional + parenthetical, mixing philosophies. Compare with `<option value="none">None</option>` which is clean. | Low | `Auto` (move the parenthetical to a `hint` element below the row if clarification is needed). |

**Total findings: 17**
- High: 3 (findings #1, #2, #3)
- Medium: 5 (findings #4, #5, #8, #9, #13)
- Low: 6 (findings #12, #14, #15, #16, #17; finding #5 is Med but also has a Low cosmetic note)
- No change / reference: 3 (findings #6, #7, #10, #11)

---

## Top 3 one-liners

1. **Three placeholder philosophies in one panel** — `(blank = default space)`, `Select vault…`, and `https://hooks.example.com/...` all appear in Settings within 60px of each other; standardise to ghost examples or remove.
2. **`'Unknown meeting'` vs `—`** — the retry card uses a prose fallback where every other null-value display uses an em-dash, making the error state feel written by a different author.
3. **Helpful empty state exists once, not everywhere** — `.log-empty` ("No activity yet. Notes will appear here after your meetings.") is the only empty state that explains what will fill it; `.rules-empty` and `.search-empty` stop short of the action nudge.
