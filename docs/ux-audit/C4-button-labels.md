# C4 — Button & action labels

## Summary

Eleven distinct button/link labels and three dynamic button states were audited across `popup.html`, `popup.js`, and `content_meet.js`. The copy is mostly clean but has three meaningful inconsistencies: (1) the two clipboard-copy buttons share the same idle label ("Copy") yet diverge in their done-state ("Copied!" vs. no exclamation mark after a 2-second reset on `copy-cmd`, and "Copied!" on `copy-ext-id`; meanwhile `copy-action-items` resets to the noun phrase "Copy as tasks" rather than to its own done-state label "Copied!"); (2) the retry done-states in the Logs panel use icon-decorated labels ("Sent ✓" / "Failed ✗") while the retry-card done-state uses plain ASCII ("Retrying…" / "Failed ✗"), producing a mixed decoration convention; (3) the overlay's two paired buttons ("Leave without notes" / "Save & leave") are asymmetric in phrasing pattern and word order. One label ("Open ↗") is an outlier style relative to every other button in the UI.

---

## Proposed standard (button-label voice rules + done-state pattern)

| Rule | Definition |
|------|-----------|
| **Imperative verb, sentence case** | Every button/link label starts with a verb in base form. Sentence case (first word capitalised only). No trailing period. |
| **≤ 4 words** | Longer labels are allowed only for explanatory paired choices (overlay buttons) where the context makes the action unambiguous. |
| **No trailing punctuation** | Exclamation marks, arrows, and emoji are decorators, not part of the core label. Use sparingly and consistently. |
| **Done-state pattern** | Append "ed" to the idle verb (Copy → Copied, Send → Sent). No trailing "!" on done-state labels. Reset to the original idle label after the feedback window. |
| **Error-state pattern** | Plain "Failed" with no symbol decoration; the error colour provides the signal. |
| **Paired/destructive choices** | Both options must start with a verb; keep roughly parallel word counts; put the safer/primary action second (right). |
| **Link-as-button** | When an `<a>` is styled as a button, its label must follow the same verb rules (e.g. "Open on GitHub", not a bare noun "GitHub" with an arrow glyph). |

---

## Findings

| # | Location (file:line) | Current label | Issue | Severity | Recommendation |
|---|----------------------|---------------|-------|----------|----------------|
| 1 | `popup.html:869` | `Copy` (copy-cmd idle) | Done-state (`popup.js:655`) is `"Copied!"` with `!`; sister button `copy-action-items` done-state is also `"Copied!"` but resets to `"Copy as tasks"` (not `"Copy"`). Inconsistent exclamation mark. | Med | Standardise all copy done-states to `"Copied"` (no `!`). Each button resets to its own idle label. |
| 2 | `popup.js:504–506` | `copy-ext-id` done-state: `"Copied!"` | Same `!` inconsistency vs. bare `"Copied"` convention (see #1). | Med | Change to `"Copied"`. |
| 3 | `popup.js:919` | `copy-action-items` done-state: `"Copied!"` → resets to `"Copy as tasks"` | Done-state uses `!`; reset target is a noun phrase, not the verb idle label. Breaks the Copy→Copied→Copy pattern. | Med | Done-state: `"Copied"`. Reset to `"Copy as tasks"`. |
| 4 | `popup.html:1108` | `Open ↗` (GitHub link-button) | Only label in the UI that is a directional-glyph decorator rather than an imperative verb. Row label `"GitHub"` carries the noun; the button is a bare glyph-arrow. Inconsistent with every other button label. | Med | Change to `"Open on GitHub"` and drop the `↗` glyph, or keep `↗` and relabel as `"View on GitHub"`. |
| 5 | `popup.html:1125` | `☕ Support on Ko-fi` | Leading emoji + sentence fragment; does not start with an imperative verb. Emoji decoration is unique to this button. | Low | Relabel as `"Support on Ko-fi"` (drop emoji from label text; move to adjacent decorative span if desired). |
| 6 | `popup.js:529` | `"Failed ✗"` (retry-card failure state) | Icon-decorated failure label. The same `"Failed ✗"` is also used in the Logs retry chip (`popup.js:887`). Decoration is consistent between the two failure paths, but it is inconsistent with the proposed no-symbol done-state rule. Consider whether symbols are desired at all. | Low | Either adopt `"Failed ✗"` everywhere (including future error states) or drop the symbol and use `"Failed"` everywhere. Pick one and document it. |
| 7 | `popup.js:887` | `"Sent ✓"` (log retry-chip success) | Unique success label; other save-confirmation paths use `"✓ Saved to …"` or the button just disappears. Mixed pattern. | Low | Align with done-state rule: `"Sent"` (no glyph). If glyph is kept, use consistently across all success done-states. |
| 8 | `content_meet.js:1545–1550` | `"Leave without notes"` / `"Save & leave"` (close overlay) | Paired buttons but asymmetric structure: first is `Verb + preposition + noun`; second is `Verb + conjunction + verb`. The safer primary action is correctly placed on the right. However, word order within each label is not parallel. | Low | Rewrite as a parallel pair: `"Leave without saving"` / `"Save and leave"` (or `"Leave anyway"` / `"Save & leave"`). |
| 9 | `popup.js:515` | `"Retrying…"` (retry-card in-progress) | Gerund in-progress label is fine; but the accompanying dismiss button (`×`) has no visible text label — only a title attribute `"Dismiss"`. Screen-reader label is present but sighted label is a bare `×`. | Low | Either add a visible `"Dismiss"` text label or confirm the `×` convention is intentional and document it. |
| 10 | `popup.html:859` | `"Set up"` (setup-btn) | Two-word verb form is correct ("Set up" as a verb). No issue with the form itself. Verify that no other location uses the one-word noun "Setup" for the same action. | Info | No change needed. Confirmed correct imperative form. |
| 11 | `popup.html:922` | `"Add rule"` (add-rule-btn) | Correct imperative, sentence case, ≤ 4 words. Conforms to proposed standard. | Info | No change. |
| 12 | `popup.html:906` | `"Reset to default"` (reset-prompt link) | Correct imperative, sentence case. Slightly long but context demands it. | Info | No change. |
| 13 | `popup.js:348–349` | `"Open Gemini to capture"` (capture-now-btn disabled state) | Instructional label, not an action label — used as a disabled hint. Matches the pattern established by `"Capturing notes…"`. | Info | No change. Acceptable disabled-state hint. |

---

### Severity counts

| Severity | Count |
|----------|-------|
| High | 0 |
| Med | 4 |
| Low | 5 |
| Info | 4 |

---

### Top 3 one-liners

1. **Done-state "!" leak** — `copy-cmd`, `copy-ext-id`, and `copy-action-items` all emit `"Copied!"` but should use `"Copied"` (no `!`) and each reset to their own idle label (`popup.js:504`, `655`, `919`).
2. **"Open ↗" is a glyph, not a verb** — the GitHub link-button is the only label in the UI that doesn't start with an imperative word; rename to `"View on GitHub"` (`popup.html:1108`).
3. **Overlay pair is not parallel** — `"Leave without notes"` vs. `"Save & leave"` mix verb-phrase structures; rewrite as `"Leave anyway"` / `"Save & leave"` or another consistent pair (`content_meet.js:1545–1550`).
