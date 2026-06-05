# U4 — Sizing & Dimensions

## Summary

The popup uses **five different heights** for interactive controls that logically belong to a single family: `.btn` 24 px, `.tab` 30 px, `.btn-capture-now` 32 px, `.btn-collapse`/`.btn-rule-action` 22 px, and `#add-rule-btn` 28 px. Inputs and selects land consistently at 24 px, which is the same as `.btn` — that's the one coherent pairing. The tab bar (30 px), the primary CTA (32 px), and the two icon-button sizes (22 px collapse/rule-action vs. no fixed size on `#add-rule-btn`) each sit on their own unrelated rung of the ladder, producing a visual weight that shifts depending on which panel is active. Width conventions are equally loose: `input[type="text"]` is hard-coded at 140 px in some rows and `flex:1` in others; `input[type="number"]` is 52 px globally except `.rule-hours` inputs which get 38 px via a scoped rule with no height override. The close-guard overlay in `content_meet.js` uses fully inline sizing (max-width 380 px card, buttons 36 px height, 18 px border-radius) that duplicates the popup's token values without referencing them, creating a maintenance surface. Status dot diameters are the one genuinely consistent dimension: both `.host-dot` and `.log-dot` are 7 × 7 px.

---

## Proposed Standard (unified control-height scale + width conventions)

### Height scale (4 tiers)

| Tier | Height | Intended use |
|------|--------|--------------|
| XS   | 22 px  | Compact icon-only actions nested inside list items (`.btn-collapse`, `.btn-rule-action`) |
| S    | 26 px  | All inline text controls: `.btn`, `input[type="text"]`, `input[type="number"]`, `select` |
| M    | 30 px  | Navigation targets: `.tab`, `#add-rule-btn` |
| L    | 36 px  | Primary CTAs: `.btn-capture-now`; also aligns with the overlay buttons in `content_meet.js` |

The current 24 px `.btn` and 24 px inputs/selects can move together to 26 px (one step up) so inline controls are visually separate from icon-buttons but clearly smaller than tab targets. The 28 px `#add-rule-btn` can snap to 30 px M to match the tab bar, since both are "navigate/add" affordances spanning the full widget width.

### Width conventions

| Control | Convention |
|---------|-----------|
| `input[type="text"]` (settings rows) | `flex:1` capped at `max-width:180px` (replace the blanket 140 px) |
| `input[type="number"]` | 52 px (keep; matches digits) |
| `.rule-hours input` | Align to 52 px (same as global `input[type="number"]`) |
| `select` (settings rows) | `flex:1` with `max-width:180px` |
| `#meeting-tab-select` | Keep `max-width:200px` (already explicit) |

### Status dots

Keep 7 × 7 px — already consistent across `.host-dot` and `.log-dot`.

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|----------------------|---------|-------|----------|---------------|
| 1 | popup.html:212 `.btn` height | 24 px | Buttons are 24 px while inputs/selects are also 24 px — fine pairing — but mismatches every other interactive tier | Med | Raise to 26 px (S tier); all three control types become S and share one rung |
| 2 | popup.html:98 `.tab` height | 30 px | Tab bar is 6 px taller than `.btn` (24 px) with no documented reason; creates visual jump between header and body controls | Med | Formalise 30 px as M tier for navigation targets; document intent |
| 3 | popup.html:557 `.btn-capture-now` height | 32 px | Primary CTA is only 2 px taller than tabs (30 px) — not enough differentiation for an action vs. a navigation affordance; also differs from overlay buttons (36 px) in `content_meet.js:1543` | High | Raise to 36 px (L tier); aligns CTA with overlay for visual consistency |
| 4 | popup.html:149/629 `.btn-collapse` / `.btn-rule-action` height | 22 px each | Two icon-button families share 22 px — consistent internally, but not documented as XS tier | Low | Retain 22 px and formally name it XS; add a comment token |
| 5 | popup.html:666 `#add-rule-btn` height | 28 px | Sits between S (24 px) and M (30 px); shares neither rung with any other control | High | Snap to 30 px M tier (same as `.tab`); both are full-width, navigate/add affordances |
| 6 | popup.html:341 `input[type="text"]` width | 140 px hard-coded | Fixed width collapses on long values; inconsistent with `.id-box` and `input[type="text"]` rows that use `flex:1` | Med | Replace with `flex:1; max-width:180px` across all settings rows |
| 7 | popup.html:357 `input[type="number"]` width | 52 px | Consistent with its own global rule, but `.rule-hours input` (popup.html:725) overrides to 38 px with no height declaration, silently inheriting 24 px | Med | Remove the 38 px override; let `.rule-hours input[type="number"]` inherit the global 52 px |
| 8 | popup.html:725 `.rule-hours input` | `width:38px; padding:2px 4px; font-size:11px` — no height | Height is unset, so the browser default (~21 px) diverges from the 24 px `input[type="number"]` rule; rule-condition row appears shorter than settings rows | Med | Remove scoped rule; let `.rule-hours input[type="number"]` inherit global styles |
| 9 | popup.html:188 `.toggle-track` | 34 × 20 px track, 16 × 16 px thumb | Toggle is 20 px tall — 4 px shorter than the 24 px `.btn`; side-by-side with a button it appears vertically misaligned even though `align-items:center` compensates | Low | Optionally raise to 22 × 22 px (XS tier) or leave as-is with a note that toggle height is intentionally compact |
| 10 | popup.html:549 `#capture-footer` width | `width:340px` hard-coded inline | Duplicates the body width; breaks if body width ever changes | Low | Replace with `width:100%` or `left:0;right:0` (already has `left:0`) |
| 11 | popup.html:60 `#capture-footer-spacer` height | 52 px | Footer pad = 10 px top + 10 px bottom + 32 px button = 52 px; matches correctly only at the current 32 px button height — will drift if CTA height changes | Med | Derive from a CSS custom property, e.g. `--footer-h: 52px`, used in both rules |
| 12 | popup.html:599 `.snapshot-preview` max-height | 120 px | Standalone pixel value with no relationship to any spacing token; truncates previews at ~7 lines (11 px font × 1.5 lh ≈ 17 px/line) | Low | Document as intentional or tie to a `--preview-max-h` token |
| 13 | popup.html:302 `textarea` min-height | 88 px | Main prompt textarea has 88 px min-height; `.rule-prompt` has 60 px min-height (popup.html:653); two textarea types with no shared token | Low | Introduce `--textarea-min-h-default:88px` and `--textarea-min-h-compact:60px` |
| 14 | popup.html:844 `#meeting-tab-select` inline style | `style="flex:1;max-width:200px"` | Inline style on `<select>` while all other selects are styled in the `<style>` block; mix of inline and class-based sizing | Low | Move to a `.tab-select` class or the `select` global rule with an id-specific max-width override |
| 15 | popup.html:875–878 snapshot `style` attributes | `style="display:flex;flex-direction:column;gap:2px"` and `style="font-size:11px;color:var(--text-muted)"` | Inline layout and typography on two `<div>`s inside `#snapshot-widget`; not sizing violations per se but break the pattern of class-based sizing used everywhere else | Low | Extract to `.snapshot-meta` / `.snapshot-next` classes |
| 16 | popup.html:1091–1094 about-panel inline styles | `style="font-size:15px;font-weight:600;color:var(--text-strong)"` and `style="margin-top:2px"` | About-panel title and version hint use inline sizing, while the identical visual treatment in the `<h1>` uses class styles | Low | Re-use `<h1>` or introduce `.about-app-name` class |
| 17 | popup.html:1116 about ext-id inline style | `style="font-family:…;font-size:11px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"` | Seven inline style declarations on a single `<span>`; sizing (flex:1, 11px) is the same as `.id-box` but does not use that class | Med | Apply `.id-box` class (already defined with these exact properties) |
| 18 | popup.html:1125 `.kofi-btn` inline style | `style="margin-top:4px"` | Inline spacing override on a button that already has a class; minor but inconsistent with the spacing approach used in `.widget` gap | Low | Add `margin-top:4px` to the `.kofi-btn` rule or use `padding-top` on the parent widget |
| 19 | content_meet.js:1532–1553 overlay card | `max-width:380px; padding:28px 32px; border-radius:12px; buttons height:36px; border-radius:18px` | All dimensions are inline on a JS-created element, duplicating popup token values with no shared source of truth | High | Extract to a static CSS block in the injected `mm2c-toast-styles` `<style>` tag so values live in one place |
| 20 | content_meet.js:1543/1548 overlay buttons | `height:36px` each | 36 px is not used anywhere in the popup (closest is `.btn-capture-now` at 32 px); overlay CTA and secondary button heights are unrelated to popup CTA | Med | Adopt 36 px as the L-tier CTA height in the popup too (see finding #3), making both files consistent |
| 21 | popup.html:936 snapshot-interval `input[type="number"]` | inherits global 52 px / 24 px | Snapshot interval number input has `min/max/value` but no explicit `width`; inherits the global 52 px — fine on its own but sits next to a `<span>` unit label with no gap defined via class | Low | Wrap in a classed container so spacing is class-driven, not proximity-based |
