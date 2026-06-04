# U10 — Iconography & glyphs

## Summary

Gememo uses **four separate icon/glyph vocabularies** that were added incrementally and have never been reconciled:

1. **Collapse/expand chevrons** — two different Unicode characters (`▾` in `.btn-collapse` vs `▶` in `.log-group-chevron` and `.snapshot-chevron`) driven by two different CSS rotation conventions (180 ° for `▾`; 90 ° for `▶`). The visual result looks nearly identical once animated, but the source characters and the open-state rotation angles differ by surface.

2. **Status-dot system** — `host-dot` and `log-dot` are both 7 × 7 px circles and share three semantic colors (ok/warn/err). However `log-dot` adds a fourth state (`info` → `--primary` blue) that `host-dot` never uses. The two dot classes are also styled independently with near-duplicate CSS blocks rather than a single shared class.

3. **Action glyphs in buttons** — rule-action buttons use `↑`/`↓` (plain Unicode arrows) for ordering and `✕` (U+2715 MULTIPLICATION X) for delete; the retry-dismiss button uses `×` (U+00D7 MULTIPLICATION SIGN — a distinct, wider character); `Retry →` in the retry card uses `→` (U+2192 rightwards arrow); the "Open ↗" external-link button uses `↗` (U+2197). Four distinct arrow/cross characters, each used for a different affordance, with no systematic vocabulary.

4. **In-page toast icons** — `content_meet.js` embeds raw Unicode glyphs directly in status message strings: `✓` (U+2713 CHECK MARK) for success and `⚠️` (U+26A0 + VS16 emoji) for warnings. `✓` is a plain Unicode symbol; `⚠️` is an emoji sequence with colour rendering. This is the only place in the product where an emoji-style rendering appears in operational UI (distinct from the intentional `☕` marketing button in About). The badge system in `background.js` uses three raw text strings — `REC`, `OK`, `!` — with no glyph at all.

The net effect: a user who pays close attention to the UI sees at least **six different expand/collapse/arrow symbols** and two visually similar but semantically different circle-dot systems. There is no single canonical "expand", "success indicator", or "delete" symbol.

---

## Proposed standard (icon/glyph vocabulary)

| Meaning | Recommended symbol | Character | Size / colour rule | Notes |
|---|---|---|---|---|
| **Collapse / expand toggle** | `›` rotated | U+203A (›) or CSS `›` entity | 13 px, `--text-muted`; 0 ° = collapsed (pointing right), 90 ° CW = expanded (pointing down) | Replace all of `▾` and `▶` with one character + one rotation convention |
| **Status: ok / success** | dot • | CSS circle | 7 × 7 px, `--success` (#34a853) | Shared `.status-dot.ok` — used by host-dot, log-dot, badge |
| **Status: warn** | dot • | CSS circle | 7 × 7 px, `--warn-text` (#92400e) | |
| **Status: error** | dot • | CSS circle | 7 × 7 px, `--danger` (#ea4335) | |
| **Status: info / neutral** | dot • | CSS circle | 7 × 7 px, `--primary` (#1a73e8) | Only used by log-dot today; explicitly opt-in |
| **Delete / remove** | × | U+00D7 (×) | 11 px, inherited colour | Use `×` everywhere; retire `✕` |
| **Move up** | ↑ | U+2191 | 11 px | Keep as-is |
| **Move down** | ↓ | U+2193 | 11 px | Keep as-is |
| **External link** | ↗ | U+2197 | 11 px | Keep as-is; one occurrence, consistent |
| **Confirm / success action** | ✓ | U+2713 | 11 px, `--success-text` | Plain symbol only — no emoji variant; retire `⚠️` in favour of a plain text prefix |
| **Warning (toast)** | text-only | — | prefix with "Warning: " | Drop `⚠️` emoji — inconsistent rendering across OS versions |
| **Badge: capturing** | REC | ASCII | Chrome badge, green bg | Keep — badge space is too narrow for Unicode |
| **Badge: success** | ✓ | U+2713 | Chrome badge, green bg | Replace "OK" with ✓ (saves a character, matches success symbol) |
| **Badge: error / warn** | ! | ASCII | Chrome badge, orange/red bg | Keep — minimal, universally readable |
| **Marketing / Ko-fi** | ☕ | U+2615 (emoji) | Intentional; isolated to About tab | The only emoji in product UI — acceptable because it is decorative, not operational |

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:879` | `▶` in `<span class="snapshot-chevron">` | Different character from `btn-collapse` (which uses `▾`). Both mean "expand this section". Mixed metaphor at the character level. | **High** | Replace `▶` with `▾` (or adopt the single `›`+rotation standard), unify the rotation angle to 180 °. |
| 2 | `popup.html:912, 916` | `▾` in `#prompt-toggle`, `#rules-toggle` `.btn-collapse` | CSS `rotate(180deg)` on `.open` state. Correct rotation direction but different source glyph from `▶` on log groups and snapshot. Two chevron characters for the same "collapse" affordance. | **High** | Standardise on one character. If keeping `▾`, rotate the `▶` instances. If adopting `›`, replace both. |
| 3 | `popup.js:471` (rendered HTML) | `▶` in `.log-group-chevron` | CSS rotates 90 ° on `.expanded`. Same character as snapshot-chevron (line 879) but rotation angle differs (90 ° vs 180 °). Already inconsistent with `btn-collapse`. | **High** | Adopt one character and one rotation convention. Open state should be identical across all three collapsible areas. |
| 4 | `popup.js:127` (rendered HTML in `renderRules`) | `✕` (U+2715) in delete `.btn-rule-action` | Delete button uses `✕` (MULTIPLICATION X, U+2715). The retry-dismiss button in the same JS file (`renderRetryList`, line 266) uses `×` (U+00D7 MULTIPLICATION SIGN) — a different, wider character. Two different cross characters for "close/delete". | **High** | Pick one. `×` (U+00D7) is the typographic standard and already wider/more readable at small sizes. Retire `✕`. |
| 5 | `popup.js:266` (rendered HTML in `renderRetryList`) | `×` in retry-dismiss `.btn` | See finding #4. This is the other side of the mixed-cross problem. | **High** | Standardise with finding #4. |
| 6 | `content_meet.js:1019, 1193, 1368` | `✓` (U+2713) in toast message strings | `✓` is a plain Unicode character — good. But it is inconsistently applied: some success toasts include it (`'✓ Notes snapshot saved'`), others do not (`'Saving notes to …'`). | **Med** | Apply `✓` prefix consistently to all `type='ok'` toasts, or omit it everywhere and rely solely on the green background colour. |
| 7 | `content_meet.js:1290, 1317` | `⚠️` (U+26A0 + U+FE0F emoji) in warn toast strings | This is the **only emoji used in an operational UI surface**. Emoji rendering varies by OS/version (colour vs monochrome). All other warn surfaces (banner, dot, badge) use colour alone, not a glyph. Inconsistent with the rest of the design. | **Med** | Replace `⚠️` with plain text prefix `Warning:` or a plain `⚠` (U+26A0 without VS16) styled in the toast's orange colour. |
| 8 | `popup.html:1108` | `↗` in "Open ↗" GitHub link button | Only one external-link occurrence; symbol is semantically appropriate. No finding for correctness. However the arrow is inside a `<a class="btn">` — styling is identical to all other `.btn` elements, making an anchor visually indistinguishable from a `<button>`. | **Low** | Consider adding a `.btn-link` modifier or `target` icon to distinguish navigating-away buttons from action buttons. |
| 9 | `popup.js:274` (rendered HTML in `renderRetryList`) | `→` in "Retry →" button | "Retry →" uses U+2192 (RIGHTWARDS ARROW). Different arrow character from `↗` (external-link, U+2197) and the up/down arrows `↑`/`↓` used in rule ordering. Three distinct arrow shapes across four affordances; none shares a character with another. | **Med** | Reserve `→` for "proceed / confirm" actions only and replace `↗` with `→` for external links — or vice versa — so arrow characters do not split across two meanings. |
| 10 | `popup.html:239–247` (`.host-dot` CSS) and `popup.html:451–461` (`.log-dot` CSS) | Two independent CSS blocks for near-identical 7 × 7 px circle dots | `host-dot` has no `info` (blue) state. `log-dot` adds `info`. They are defined separately instead of as one `.status-dot` base class with modifiers. Any future colour change requires editing two blocks. | **Low** | Merge into a single `.status-dot` base + `.ok/.warn/.err/.info` modifiers. |
| 11 | `background.js:205, 438` | `'OK'` badge text | Badge says `OK` (two characters). This is the only textual success indicator — all in-page success uses `✓`. Mixed vocabulary: the badge uses English text while the toast uses a symbol. | **Low** | Replace `'OK'` with `'✓'` (`✓`) to align with the in-page success vocabulary, and save one character width. |
| 12 | `popup.html:1125` | `☕` in Ko-fi button | Emoji intentionally used for marketing (Support on Ko-fi). Acceptable — it is decorative, isolated to the About tab, and clearly non-operational. | — | No action required; document as the one permitted emoji affordance. |
| 13 | `content_meet.js:918, 930, 984` | `✦` (referenced in string literals, not rendered by gememo) | The `✦` references in `showStatus(...)` calls describe Google Meet's own Gemini button icon — not a gememo glyph. Gememo has no control over this. | — | No action required; informational only. |
