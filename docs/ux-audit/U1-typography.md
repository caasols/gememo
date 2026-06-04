# U1 — Typography

## Summary

The popup uses eight distinct font-sizes (10 / 11 / 12 / 13 / 15 / 18 px) with no documented scale rationale, and the same semantic roles (section sub-heads, metadata, hints) land on different sizes depending on where they appear. The in-Meet overlay introduces a ninth size (18 px at 500 weight) and a completely separate font-family stack (`'Google Sans', Roboto`) that has no relationship to the popup's system-UI stack, creating a visible split identity between the popup and the in-page surface. Monospace is declared three different ways (`Monaco, Menlo, 'Ubuntu Mono', monospace` / `ui-monospace, monospace` / bare `monospace`), and the About tab's "Gememo" identity heading uses a raw inline `font-size:15px; font-weight:600` instead of the shared `h1` rule that carries the same values—fragile duplication rather than reuse.

---

## Proposed standard

### Type scale (popup)
| Token name (proposed) | px  | Use |
|---|---|---|
| `--fs-xs`   | 10 | Timestamps, metadata, micro-chevrons |
| `--fs-sm`   | 11 | Muted sub-labels, hints, log messages, mono IDs |
| `--fs-base` | 12 | Primary body copy, log titles, table rows, tab labels |
| `--fs-md`   | 13 | Row labels (`.label`), primary CTA button, body default |
| `--fs-lg`   | 15 | Page/section heading (`h1`, About identity) |
| `--fs-xl`   | 18 | Stats values only — intentional "display" size |

*Drop the isolated 12 px on `body` (should be 13 px = `--fs-md`) and remove the free-floating 11 px `font-size` override on `.label` inside `#meeting-picker` (redundant, counter to `.label`'s 13 px).*

### Weight rules
| Role | Weight |
|---|---|
| Page title / identity | 600 |
| Section heading (widget-title) | 600 |
| Section sub-heading (rules-subhead) | 600 |
| Primary CTA / log group titles | 500 |
| All other body / labels | 400 (inherit) |
| Stats display value | 700 (intentional) |

*`700` is only acceptable for `.stat-value` (large display numbers). Eliminate it everywhere else.*

### Font-family rules
| Context | Stack |
|---|---|
| Body / all UI text | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` (already on `body`) |
| Monospace (IDs, regex, snapshot, id-box) | `ui-monospace, 'Cascadia Code', Menlo, monospace` — single canonical declaration |
| In-Meet toast & overlay | Mirror popup stack; drop 'Google Sans' hardcode |

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `content_meet.js:1404` | `font-family:'Google Sans',Roboto,sans-serif` on `.mm2c-toast` | In-page toast uses a different font stack from the popup. 'Google Sans' is not available in all contexts and diverges from the extension's system-UI brand. | High | Replace with the popup's `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` stack. |
| 2 | `content_meet.js:1534` | `font-family:'Google Sans',Roboto,sans-serif` on close-overlay container | Same separate stack as the toast—entire in-Meet UI family is inconsistent with popup. | High | Same fix as #1; use popup body stack. |
| 3 | `popup.html:1090` | `style="font-size:15px;font-weight:600;color:var(--text-strong)"` on About "Gememo" div | The `h1` rule (lines 68-72) already defines `font-size:15px; font-weight:600` for exactly this semantic role, but the About panel doesn't use `<h1>`—it uses a `<div>` with duplicated inline values. The two are visually identical today but will drift apart when either is changed. | High | Replace the inline-styled `<div>` with `<h1>` (or add a shared `.page-title` class) so it inherits the shared rule. |
| 4 | `content_meet.js:1535` | `font-size:18px;font-weight:500` on overlay heading "Leaving without notes?" | A one-off 18 px / 500 heading inside the overlay. The popup's only 18 px usage is `.stat-value` (700 weight—display numbers). Two different 18 px meanings with different weights is confusing. The overlay heading is closer to `h1` semantics (15 px / 600). | High | Lower to 15 px and use weight 600 to align with the popup's heading convention. |
| 5 | `popup.html:732-734` | `.rules-subhead { font-size:11px; font-weight:600; letter-spacing:0.04em }` | Sub-section heading inside the Rules panel uses 11 px / 600 with `letter-spacing:0.04em`. `.widget-title` (the canonical section label) uses 10 px / 600 with `letter-spacing:0.6px`. Same semantic role ("section label"), different size and tracking. | High | Merge `.rules-subhead` into `.widget-title`, or explicitly document a two-tier label system. Currently the difference is accidental. |
| 6 | `popup.html:692` | `.stat-value { font-size:18px; font-weight:700 }` | 18 px / 700 is the only weight-700 usage in the entire popup. It stands out strongly—intentional for big-number "display" use. Not a bug per se, but there is no CSS variable or comment marking this as an intentional exception. | Med | Add a comment `/* display — intentional exception */` so future developers know not to add more 700-weight text. |
| 7 | `popup.html:841` | `style="font-size:12px;color:var(--text-muted)"` on `#meeting-picker .label` span | `.label` is globally defined as `font-size:13px` (line 173). This inline override shrinks it to 12 px only inside the meeting picker—same element type, same role, different size. | Med | Remove the inline `font-size:12px` override; let `.label` rule apply uniformly. |
| 8 | `popup.html:752-753` | `.bi-regex { font-family:ui-monospace, monospace }` | Built-in rule regex badge uses `ui-monospace, monospace`, while `.id-box` (line 266), `input[type="text"]` (line 343), `.snapshot-preview` (line 594), and `#about-ext-id` inline (line 1116) all use `Monaco, Menlo, 'Ubuntu Mono', monospace`. Three separate monospace stacks in the same file (`Monaco…`, `ui-monospace, monospace`, and the inline bare `monospace`). | Med | Introduce a single `--font-mono` CSS variable and reference it everywhere. |
| 9 | `popup.html:877` | `style="font-size:11px;color:var(--text-muted)"` on `#snapshot-next` | The snapshot-next countdown is set via inline style instead of a CSS class. `.snapshot-header` already sets `font-size:12px` on the parent—this child shrinks it to 11 px inline. Inconsistency with the established pattern. | Med | Extract a `.snapshot-meta` class at 11 px and apply it; remove the inline style. |
| 10 | `content_meet.js:1538` | `color:#9aa0a6` on overlay body text | Hardcoded Google-Material grey—not a popup CSS variable. The popup uses `--text-muted: #6b7280` as its muted text token. Both are grey but different values, creating a slight visual mismatch visible on careful inspection. | Med | If the overlay should ever share visual language with the popup, map to the nearest popup token. For a dark overlay, define a local `--overlay-text-muted: #9aa0a6` constant. |
| 11 | `popup.html:83-84` | `.status-banner { line-height:1.4 }` | The main body textarea (line 304) also uses `line-height:1.5`, `.rule-prompt` uses 1.4, `.log-message` uses 1.4, `.log-empty` uses 1.5. Two values (1.4 and 1.5) alternate across multi-line text elements with no clear rule for which applies where. | Med | Standardise multi-line body text at `line-height: 1.5` (more readable); reserve 1.4 only for the compact `.hint` class where vertical density matters. |
| 12 | `popup.html:134-137` | `.widget-title { font-size:10px; letter-spacing:0.6px }` | Specifying letter-spacing as absolute `px` (not `em`) means the spacing does not scale if font-size changes. Also, `0.6px` on a 10 px font is effectively `0.06em`—acceptable value but expressed inconsistently (`.rules-subhead` uses `0.04em` on the same kind of label). | Low | Use `letter-spacing: 0.06em` on `.widget-title` and `0.04em` on `.rules-subhead` (or unify both to 0.05em) so both uppercase labels use proportional tracking. |
| 13 | `popup.html:158-159` | `.btn-collapse { font-size:13px; line-height:1 }` | The collapse chevron button uses `font-size:13px` (matching the base body size), but `.btn` (the primary action button style) uses `font-size:11px`. Both are small interactive buttons yet sit at different sizes. | Low | The collapse button's `13px` is probably a copy-paste from `.label`. Drop to `12px` to visually match button-sized controls, or document the intentional difference. |
| 14 | `popup.html:259-261` | `.setup-panel { font-size:11px; line-height:1.4 }` | The setup panel's paragraph copy is 11 px while all other explanatory paragraph text (`.hint`) is 10 px. The setup panel looks like a hint area but renders larger. | Low | Either use `.hint` for setup-panel copy (10 px), or explicitly justify the 11 px value. |
| 15 | `popup.html:407-408` | `.search-result-head { font-size:12px }` and `.search-title { font-weight:600 }` (no explicit font-size on `.search-title`) | Search result title inherits 12 px from the parent and adds weight 600—visually similar to `.log-group-title` (12 px / 500). Same semantic role (meeting title in a list), different weight. | Low | Align `.search-title` to `font-weight: 500` to match `.log-group-title`, or deliberately keep 600 and document the distinction. |
| 16 | `popup.html:562-564` | `.btn-capture-now { font-size:13px; font-weight:500 }` | The primary CTA button uses 13 px / 500. Regular `.btn` uses 11 px / 500. The CTA is intentionally larger (32 px height vs 24 px), but 13 px is the `.label` / body baseline—no visual hierarchy signal beyond height. | Low | Consider 14 px for the CTA to create a clear step above the 13 px body baseline, reinforcing its primary action role. |
| 17 | `content_meet.js:1544,1549` | Both overlay buttons use `font-size:13px` — "Leave without notes" (weight default / 400) and "Save & leave" (weight 500) | The primary overlay action ("Save & leave") uses 500, the secondary uses 400. This is the right pattern but would benefit from a CSS class rather than inline duplication. | Low | No visual bug, but refactor both buttons to use a shared overlay button class. |
