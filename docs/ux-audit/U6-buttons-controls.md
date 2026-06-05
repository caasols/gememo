# U6 — Buttons & controls

## Summary

The popup has **8 distinct button-ish elements** and **5 form control types**, accumulated across two files
(`popup.html` inline CSS + `popup.js` innerHTML) plus a fully independent style system in
`content_meet.js`. Heights range across four sizes (22 / 24 / 28 / 32 px), radii across three
(4 / 6 / 18 px), and several controls share a height declaration but diverge on font-size, border
colour, or focus treatment. The overlay buttons in `content_meet.js` are entirely disconnected from
the popup's CSS token system — they hard-code dark-theme hex values and use pill radii (18 px)
while the popup uses rounded-rectangle radii (6 px). Two accidental drifts also exist inside the
popup itself: `#add-rule-btn` (28 px, dashed border, `border-radius:4px`) does not match any
peer button class, and `.btn-rule-action` / `.btn-collapse` share 22 px height but differ in
colour scheme from `.btn` without a semantic reason.

---

## Proposed standard (button taxonomy + control specs)

### Button taxonomy

| Role | Class | Height | Padding | Radius | Border | Background | Text | Font |
|---|---|---|---|---|---|---|---|---|
| **Primary CTA** | `.btn-primary` | 32 px | 0 14 px | 6 px | none | `--primary` | `#fff` | 13 px / 500 |
| **Secondary** | `.btn` | 28 px | 0 10 px | 6 px | 1 px `--border-strong` | `--surface` | `--primary` | 12 px / 500 |
| **Icon** | `.btn-icon` | 22 px | 0 (square) | 4 px | 1 px `--border-strong` | `--surface-subtle` | `--text-muted` | 13 px / 400 |
| **Destructive secondary** | `.btn.danger` | inherits `.btn` | — | — | hover: `--danger-border` | hover: `--danger-bg` | `--danger` | — |
| **Ghost / link** | `.btn-ghost` (replaces `.reset-link`) | auto | 0 | 0 | none | none | `--primary` | 11 px / 400 |
| **Tab** | `.tab` | 30 px | — | 0 | 2 px bottom | none | `--text-muted` / `--primary` active | 12 px / 500 |

Notes:
- Retire `#add-rule-btn` as a unique element; replace with a `.btn` (28 px secondary) with a `+` prefix label or keep the dashed style only if the "ghost add" pattern is intentionally distinct — in that case extract to a `.btn-add` class.
- `.btn-collapse` and `.btn-rule-action` both map to **Icon** role — unify to `.btn-icon`.
- `btn-capture-now` maps to **Primary CTA** — rename to `.btn-primary` to share the class.
- Overlay buttons in `content_meet.js` should reference the same height/radius family even though they must be self-contained (dark-theme inline styles are acceptable there, but heights and border-radii should align with popup tokens).

### Form control specs (unified target)

| Control | Height | Padding | Radius | Border | Focus |
|---|---|---|---|---|---|
| `select`, `input[type=text]`, `input[type=number]` | 28 px | 0 8 px | 6 px | 1 px `--border` | `--primary` |
| `textarea`, `.rule-prompt` | auto (min-height) | 8 px | 6 px | 1 px `--border` | `--primary` |
| `.note-search` | 28 px (match other inputs) | 6 px 8 px | 6 px | 1 px `--border` | `--primary` |

Current issue: `select` and `input[type=text/number]` declare `height:24px` but `.note-search`
uses `padding:6px 8px` with no explicit height, producing ~32 px. Standardise all at 28 px.

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:555–569` `.btn-capture-now` | height:32px, radius:6px, border:none, bg:`--primary`, font:13px/500 | Unique class for what is just a full-width primary CTA; not reusable | **Med** | Replace with a composable `.btn-primary` plus `width:100%`; retire `.btn-capture-now` |
| 2 | `popup.html:147–164` `.btn-collapse` | height:22px width:22px, radius:4px, border:`--border-strong`, bg:`--surface-subtle`, color:`--text` | Same size/shape as `.btn-rule-action` but different colour (`--text` vs `--text-muted`) — two classes for one icon-button role | **Med** | Merge into a single `.btn-icon` class; use a `.danger` modifier for the delete variant |
| 3 | `popup.html:627–643` `.btn-rule-action` | height:22px width:22px, radius:4px, border:`--border-strong`, bg:`--surface-subtle`, color:`--text-muted` | Same shape as `.btn-collapse` but different text colour without a semantic reason | **Med** | Merge into `.btn-icon` (see finding #2) |
| 4 | `popup.html:665–677` `#add-rule-btn` | height:28px, radius:4px, border:1px **dashed** `--border-strong`, bg:none, color:`--primary`, font:12px | ID selector (not reusable), unique height among all buttons (28px), dashed border is not used anywhere else, radius:4px while other buttons are 6px | **Med** | Extract to a `.btn-add` class or collapse into `.btn` with a label; standardise radius to 6px |
| 5 | `content_meet.js:1542–1544` `#mm2c-close-leave` | height:36px, radius:18px (pill), border:1px solid `#5f6368`, bg:transparent, color:`#e8eaed`, font:13px | Height (36px) and pill radius (18px) are completely divorced from the popup's 22/24/28/32px family; uses hard-coded hex instead of shared tokens | **High** | Standardise height to 36px-is-acceptable-for-overlay but align radius to 8px; document overlay height as intentionally larger in a comment |
| 6 | `content_meet.js:1547–1549` `#mm2c-close-save` | height:36px, radius:18px (pill), bg:`#1a73e8`, color:`#fff`, font:13px/500, border:none | Same pill radius drift as #5; primary blue is correct but hard-coded (`#1a73e8`) rather than using a shared constant | **High** | Same as #5; add `/* overlay-primary */` comment referencing the popup's `--primary` token value |
| 7 | `popup.html:209–230` `.btn` | height:24px, font:11px | Used as the standard secondary button but 24px is shorter than all form controls (28px select/input) and shorter than the proposed 28px secondary target; 11px font is the smallest of all button fonts | **Med** | Increase height to 28px, font-size to 12px to align with select/input row height so paired controls look level |
| 8 | `popup.html:331–340` `input[type=text]`, `input[type=number]` | height:24px, padding:0 8px, radius:6px | `height:24px` — 4px shorter than the 28px target; no `:focus-visible` outline, only `border-color` change | **Low** | Set height:28px; add `outline:none` + `box-shadow:0 0 0 2px var(--focus)` on `:focus-visible` to match accessibility expectations |
| 9 | `popup.html:317–329` `select` | height:24px, padding:0 8px, radius:6px | Same 24px height inconsistency as inputs; lacks `:focus-visible` outline | **Low** | height:28px; add focus style matching inputs (finding #8) |
| 10 | `popup.html:383–393` `.note-search` | padding:6px 8px, no explicit height, radius:6px | No explicit height → computed ~32px, taller than every other 24px control in the same panels | **Med** | Add `height:28px; padding:0 8px` to unify with other single-line inputs |
| 11 | `popup.html:308–315` `.reset-link` | `<a>` styled with `font-size:11px; color:--primary; cursor:pointer; text-decoration:none` | Not a button, not an `<a href>` — semantically ambiguous; sits in the same visual tier as `.btn` but has no border, no height, and no focus style | **Low** | Replace with a `.btn-ghost` class on a `<button type="button">` for correct keyboard handling and focus state |
| 12 | `popup.html:99–114` `.tab` | height:30px, border:none, border-bottom:2px transparent, font:12px/500 | Height (30px) sits between 28px and 32px without landing on the standard grid; not composable with `.btn` family since it uses negative-margin bottom border trick | **Low** | Keep tab pattern separate (it is genuinely a different widget role) but document it explicitly; height 30px is acceptable if declared as a tab-specific constant |
| 13 | `popup.html:641–658` `.rule-prompt` / `popup.html:292–305` `textarea` | `.rule-prompt`: radius:4px, font:11px; `textarea`: radius:6px, font:12px | Two textarea variants with different radii (4px vs 6px) and font sizes (11px vs 12px) for no semantic reason | **Med** | Unify: both should be `border-radius:6px; font-size:12px`; use `min-height` to control size difference |
| 14 | `popup.html:725–726` `.rule-hours input` | `width:38px; padding:2px 4px; font-size:11px` inline under `.rule-hours` | Overrides the global `input[type=number]` styles (height:24px, padding:0 8px) with a shorter, un-themed variant — creates visual inconsistency within the same rule row | **Low** | Introduce a `.input-compact` modifier instead of ad-hoc inline style on a descendant selector |
| 15 | `popup.js:452` `.log-retry-btn` (generated HTML) | inherits `.btn` + `font-size:11px; padding:1px 6px; margin-left:auto` | Overrides `.btn` padding to `1px 6px` and height is effectively unset (falls below 24px) — retry button in the log list is visually smaller than all other `.btn` instances | **Med** | Use `.btn` base without overriding padding; control size via `height:20px` explicitly as a `.btn--compact` modifier |
