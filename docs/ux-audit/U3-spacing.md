# U3 — Spacing & Box Model

## Summary

The popup defines three spacing tokens: `--widget-py: 10px`, `--widget-px: 12px`, and `--gap: 8px`.
In practice, roughly half of all spacing values are written as literal px numbers that bypass these tokens entirely.
The de-facto spacing scale in use is: **2 · 3 · 4 · 6 · 7 · 8 · 9 · 10 · 12 · 16 · 22 · 24 · 28 · 32 px** — 14 distinct values, compared to the 3 that the token system implies.
The result is visually noisy rhythm: components that look superficially similar (`.widget` vs `.stat-cell` vs `.builtin-rule` vs `.search-result`) carry different internal padding, and small one-off offsets (2px, 3px, 4px, 5px, 7px, 9px, 10px gaps) accumulate to produce irregular row height and inconsistent inter-component breathing room.

Key failure modes:
1. **Token bypass on padding** — `.status-banner`, `.note-search`, `.log-empty`, `.log-group-header`, `.log-group-entries`, `.rules-empty`, and both overlay cards hard-code their padding instead of referencing `--widget-py`/`--widget-px`.
2. **Proliferating micro-gaps** — gaps of 2px, 3px, 4px, 6px, 7px appear across inline rows and sub-components where a consistent sub-token (4px or 6px) would suffice.
3. **Literal margin where gap should be used** — `margin-top`, `margin-bottom`, and `margin-left: auto` are scattered through the stylesheet in places already controlled by flex/grid layout; several could be replaced by gap on the parent.

---

## Proposed Standard (Canonical Spacing Scale + Token Rules)

### Canonical token set

```css
:root {
  /* Primary spatial tokens — the only values that should appear in padding/margin/gap */
  --space-1: 2px;   /* hairline: toggle thumb offset, dot margin-top */
  --space-2: 4px;   /* tight: action-item gap, rule-header btn gap    */
  --space-3: 6px;   /* snug: host-row gap, id-row gap, inline chips   */
  --space-4: 8px;   /* base (= current --gap): all inter-row gaps     */
  --space-5: 10px;  /* widget block-padding (= current --widget-py)   */
  --space-6: 12px;  /* widget inline-padding (= current --widget-px)  */
  --space-7: 16px;  /* page-level padding (#main-content, footer)     */
  --space-8: 24px;  /* empty-state vertical padding (log-empty, etc.) */

  /* Keep existing aliases for backwards compat during migration */
  --widget-py: var(--space-5);
  --widget-px: var(--space-6);
  --gap:       var(--space-4);
}
```

### Rules

| Context | Token to use |
|---|---|
| All `.widget`, `.setup-panel`, `.retry-card` padding | `--widget-py --widget-px` |
| All inter-row / inter-item `gap` inside a panel or widget | `--gap` (8px) |
| Inline chip gaps (host-row, id-row, rule-header) | `--space-3` (6px) |
| Tight icon/label pairs (toggle dots, action-item checkbox) | `--space-2` (4px) |
| Page-level container padding and footer padding | `--space-7` (16px) |
| Empty-state / group-header block padding | `--space-8` or `var(--widget-py) var(--widget-px)` |
| Avoid `margin-top`/`margin-bottom` inside flex columns | Replace with `gap` on parent |
| Never use ad-hoc values 9px, 22px, 28px, 32px | Nearest token or a new named token |

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:51` | `padding: 16px` on `#main-content` | Magic number; page container padding should be a token | Med | Use `var(--space-7)` |
| 2 | `popup.html:77` | `.status-banner { padding: 8px var(--widget-px) }` | Block-axis padding is 8px, not `--widget-py` (10px); inconsistent with every other widget | High | Change to `var(--widget-py) var(--widget-px)` or add `--banner-py: 8px` as named token |
| 3 | `popup.html:94` | `.tab-bar { margin: 0 -2px }` | Ad-hoc negative margin used to correct visual bleed; coupling to internal layout | Low | Replace with a proper border-overlap technique or `overflow: visible` |
| 4 | `popup.html:237` | `.host-row { gap: 6px }` | Literal 6px bypasses `--gap`; different from the 8px used on all other rows | Med | Use `--gap` (8px) or introduce `--space-3: 6px` and apply consistently |
| 5 | `popup.html:263` | `.id-row { gap: 6px }` | Same 6px inconsistency as host-row; these sibling rows should share a value | Med | Use `--space-3` (same as host-row) |
| 6 | `popup.html:271` | `.id-box { padding: 3px 6px }` | Sub-token literal pair; 3px vertical is not in any scale | Low | Use `var(--space-1) var(--space-3)` → `2px 6px`, or `4px 6px` |
| 7 | `popup.html:283` | `.sub-options { padding-top: 10px }` | Hard-coded 10px equals `--widget-py` but is written as a literal | Med | Use `var(--widget-py)` |
| 8 | `popup.html:298` | `textarea { padding: 8px }` | Literal 8px = `--gap`; should be referenced as token for legibility | Low | `var(--gap)` |
| 9 | `popup.html:319` | `select { padding: 0 8px }` | Literal 8px; inline-padding should match `--widget-px` or use `--gap` consistently | Low | `var(--gap)` (8px) — keep height-based control, acknowledge this is form-element padding |
| 10 | `popup.html:332` | `input[type=text/number] { padding: 0 8px }` | Same as select; literal 8px | Low | `var(--gap)` |
| 11 | `popup.html:387` | `.note-search { margin-bottom: 8px; padding: 6px 8px }` | `margin-bottom` should be `gap` on parent `.panel`; padding 6px vertical differs from 8px used on textarea | High | Remove `margin-bottom`; use `gap` on `.panel`. Normalise padding to `var(--gap)` both axes |
| 12 | `popup.html:395` | `#search-results:not(:empty) { margin-bottom: 8px }` | Another rogue `margin-bottom` inside a flex column; should be gap | High | Remove; add `gap: var(--gap)` to `.panel` (already has it — just remove the margin) |
| 13 | `popup.html:398` | `.search-result { padding: 6px 8px; margin-bottom: 6px }` | 6px vertical padding vs widget's 10px; `margin-bottom` duplicates gap | High | Normalize to `var(--widget-py) var(--widget-px)`; remove `margin-bottom` |
| 14 | `popup.html:411` | `.search-snippet { margin-top: 3px }` | 3px is not in the scale; micro-margin inside a flex column | Low | Use `gap: var(--space-2)` on `.search-result` and remove individual margins |
| 15 | `popup.html:437` | `.log-entry { padding: 9px 0 }` | 9px is not in any token; closest is `--widget-py` (10px) or `--gap` (8px) | High | Use `var(--gap)` (8px) or `var(--widget-py)` (10px) — pick one and apply globally |
| 16 | `popup.html:447` | `.log-retry-btn { padding: 1px 6px; margin-left: auto }` | 1px block-padding is a sub-pixel hack; `margin-left: auto` in a flex row with `gap` | Med | Set height: 20px with `padding: 0 var(--space-3)` instead; keep margin-left:auto or move to gap spacer |
| 17 | `popup.html:456` | `.log-dot { margin-top: 3px }` | 3px magic offset to optically align dot with first text line | Low | Document intent with comment `/* optical align */`; or change to `align-self: flex-start; margin-top: var(--space-1)` |
| 18 | `popup.html:469` | `.log-header { gap: 6px; margin-bottom: 2px }` | gap 6px ≠ `--gap`; margin-bottom 2px is micro-offset inside flex column | Med | Use `gap: var(--gap)`; replace `margin-bottom` with `gap` on `.log-content` |
| 19 | `popup.html:495` | `.log-empty { padding: 28px var(--widget-px) }` | 28px block-padding is not tokenized; used only here | Med | Introduce `--space-8: 24px` (or 28px) as "empty-state" token and document it |
| 20 | `popup.html:503` | `.log-group-header { gap: 6px; padding: 8px var(--widget-px) }` | gap 6px ≠ `--gap`; block padding 8px ≠ `--widget-py` (10px) | High | Use `gap: var(--gap)`; use `var(--widget-py) var(--widget-px)` for padding |
| 21 | `popup.html:541` | `.log-group-entries { padding: 0 var(--widget-px) }` | Zero block-padding means entries flush to group header edge; no breathing room at top/bottom of expanded group | Med | Add `padding: var(--gap) var(--widget-px)` to give entries vertical air |
| 22 | `popup.html:552` | `#capture-footer { padding: 10px 16px }` | Mixed values: 10px = `--widget-py` ✓, but 16px is a literal (should be `--space-7`) | Med | `padding: var(--widget-py) var(--space-7)` |
| 23 | `popup.html:589` | `.snapshot-preview { margin-top: 8px; padding-top: 8px }` | Double-spacing via margin + padding; should be one or the other | Med | Keep `padding-top: var(--gap)` (the visual separator is from `border-top`); remove `margin-top` |
| 24 | `popup.html:603` | `.rule-item { padding-top: 10px; gap: 6px }` | padding-top literal 10px = `--widget-py`; gap 6px ≠ `--gap` | Med | `padding-top: var(--widget-py)`; `gap: var(--gap)` |
| 25 | `popup.html:614` | `.rule-header { gap: 4px }` | 4px gap for icon-buttons; narrower than any other row gap; creates cramped button cluster | Med | Use `var(--space-2)` (4px) as a named tight-gap token; document it |
| 26 | `popup.html:622` | `.rule-regex { padding: 3px 6px }` | Same as `.id-box`; 3px block-padding below the scale | Low | `padding: var(--space-1) var(--space-3)` |
| 27 | `popup.html:650` | `.rule-prompt { padding: 6px }` | 6px all-around vs textarea's 8px; two text inputs with different internal padding | Med | Normalise to `var(--gap)` (8px) to match `textarea` |
| 28 | `popup.html:662` | `.rules-empty { padding: 12px 0 }` | 12px not in token set; only used for this empty state | Low | Use `var(--widget-py)` (10px) or introduce `--space-empty` |
| 29 | `popup.html:675` | `#add-rule-btn { height: 28px; margin-top: 8px }` | `margin-top` inside flex column that already has `gap: var(--gap)` on `.sub-options` — double-spacing | High | Remove `margin-top`; rely on parent `gap: var(--gap)` |
| 30 | `popup.html:683` | `.stats-grid { gap: 8px; margin-top: 8px }` | Both literal 8px = `--gap`; should use token | Med | `gap: var(--gap); margin-top: var(--gap)` — or better, remove `margin-top` and use `gap` on `.widget` |
| 31 | `popup.html:688` | `.stat-cell { padding: 8px 10px }` | 8px vertical / 10px horizontal is an inverted ratio vs widget (10px/12px); creates visually flatter cells | Med | Use `var(--widget-py) var(--widget-px)` for consistency, or introduce `--cell-py/px` tokens |
| 32 | `popup.html:693` | `.stat-label { margin-top: 2px }` | 2px micro-margin inside a block stack; not tokenized | Low | Use `gap: var(--space-1)` on `.stat-cell` flex column |
| 33 | `popup.html:697` | `#action-items-list { gap: 4px }` | 4px gap between items; tighter than standard `--gap` (8px) — produces cramped list | Med | Use `var(--gap)` for consistency; if intentionally tighter, use `var(--space-2)` with a comment |
| 34 | `popup.html:700` | `.action-item { gap: 7px }` | 7px is not in any scale; between `--space-3` (6px) and `--gap` (8px) | Med | Use `var(--gap)` (8px) |
| 35 | `popup.html:705` | `.action-item input { margin-top: 2px }` | Optical alignment hack; unlabelled | Low | Comment intent; use `var(--space-1)` |
| 36 | `popup.html:710` | `.also-send { gap: 10px; margin-top: 8px }` | gap 10px = `--widget-py` value but used as inline gap; inconsistent with `--gap` (8px) | Med | Use `gap: var(--gap)`; remove `margin-top` and rely on parent `gap` |
| 37 | `popup.html:711` | `.also-send label { gap: 3px }` | 3px not in scale | Low | Use `var(--space-1)` (2px) or `var(--space-2)` (4px) |
| 38 | `popup.html:718` | `.rule-condition { gap: 6px; margin-top: 5px }` | gap 6px ≠ `--gap`; margin-top 5px is not in scale | Med | `gap: var(--space-3)` (keep 6px as a named snug-gap); `margin-top: var(--space-2)` |
| 39 | `popup.html:723` | `.rule-days { gap: 4px }` | Literal 4px; ok for checkboxes but should be `var(--space-2)` | Low | `gap: var(--space-2)` |
| 40 | `popup.html:724` | `.rule-days label { gap: 2px }` | 2px gap for checkbox+label pair; fine but unlabelled | Low | `gap: var(--space-1)` |
| 41 | `popup.html:725` | `.rule-hours input { padding: 2px 4px }` | Literal micro-padding; not tokenized | Low | `padding: var(--space-1) var(--space-2)` |
| 42 | `popup.html:734` | `.rules-subhead { margin: 10px 0 4px }` | Top margin 10px = `--widget-py`; bottom 4px not in scale; margin instead of gap | Med | Use `margin: var(--widget-py) 0 var(--space-2)` or restructure to use gap on parent |
| 43 | `popup.html:738` | `.builtin-rule { padding: 6px 8px; margin-bottom: 6px }` | 6px vertical vs widget 10px; margin-bottom duplicates parent gap | High | `padding: var(--widget-py) var(--widget-px)`; remove `margin-bottom` |
| 44 | `popup.html:762` | `.builtin-rule .bi-prompt { margin-top: 6px }` | Literal 6px margin inside a flex/block stack | Low | Use `var(--space-3)` or add `gap` to `.builtin-rule` |
| 45 | `popup.html:786` | `.retry-card-header { gap: 8px }` | Literal 8px = `--gap`; should use token | Low | `gap: var(--gap)` |
| 46 | `popup.html:806` | `.retry-card-actions { gap: 6px; margin-top: 4px }` | gap 6px ≠ `--gap`; `margin-top` inside flex column that already has `gap: var(--gap)` from `.retry-card` | High | `gap: var(--gap)`; remove `margin-top` (parent gap handles spacing) |
| 47 | `popup.html:840` | Inline `style="gap:6px"` on `.row` in meeting-picker | Overrides `.row { gap: var(--gap) }` with 6px literal | Med | Remove inline override; let `.row` use `--gap` |
| 48 | `popup.html:875` | Inline `style="display:flex;flex-direction:column;gap:2px"` on snapshot inner div | 2px gap hardcoded inline in HTML | Low | Extract to `.snapshot-meta` class with `gap: var(--space-1)` |
| 49 | `popup.html:936` | Inline `style="display:flex;align-items:center;gap:6px"` in snapshot-interval row | Bypasses `.row` class and `--gap` token | Med | Use `<div class="row">` |
| 50 | `popup.html:1091` | Inline `style="margin-top:2px"` on `#about-version` hint | Micro-margin in HTML | Low | Move to `.hint + .hint { margin-top: var(--space-1) }` or use gap on parent |
| 51 | `popup.html:1094` | Inline `style="margin:0"` on `.hint` in about panel | Resets margin set elsewhere; indicates hint's default margin is wrong | Med | Set `.hint { margin: 0 }` globally in the stylesheet (it's already 0 on line 367 — this override is redundant) |
| 52 | `popup.html:1101` | Inline `style="margin:10px 0 0"` on `#stats-savings` | Literal 10px top margin = `--widget-py`; better handled by `.stats-grid + p` gap rule | Med | Remove inline style; add `margin-top: var(--gap)` in `.stats-grid` rule or use CSS sibling selector |
| 53 | `popup.html:1115` | Inline `style="gap:6px;margin-top:4px"` on extension-ID row | Two ad-hoc values; `margin-top` inside a widget that already uses `gap: var(--gap)` | Med | Remove inline style; use `<div class="row">` (inherits `gap: var(--gap)`); remove `margin-top` |
| 54 | `popup.html:1125` | Inline `style="margin-top:4px"` on Ko-fi button | `margin-top` inside widget with `gap: var(--gap)` — double-spacing | Med | Remove; rely on parent gap |
| 55 | `content_meet.js:1400–1406` | Toast CSS: `padding:10px 22px` | 22px horizontal padding is not in the popup token set | Med | Acceptable for an overlay (different surface/context), but document the value. If a shared token file existed, reference it. |
| 56 | `content_meet.js:1532` | Close-overlay card: `padding:28px 32px` | Two values (28px, 32px) not in any token | High | Use consistent overlay tokens: `padding: 28px 32px` is reasonable for a modal but should be named. Add `/* overlay-py: 28px, overlay-px: 32px */` comment until a shared token exists. |
| 57 | `content_meet.js:1535` | Close-overlay card: `margin-bottom:10px` on title div | 10px literal | Low | Acceptable in an isolated overlay; add comment `/* = --widget-py */` |
| 58 | `content_meet.js:1538` | Close-overlay card: `margin-bottom:24px` on body text | 24px not in scale | Med | Should align with a spacing step; use 20px (nearest round step) or 24px as a named overlay-gap |
| 59 | `content_meet.js:1541` | Close-overlay buttons row: `gap:12px` | 12px = `--widget-px` value but used as gap; not tokenized in overlay context | Low | Acceptable; add comment `/* gap between overlay buttons */` |

---

### De-facto spacing scale observed

| Value | Occurrences | Contexts |
|---|---|---|
| 2px | 4 | toggle offset, micro margins, snapshot-meta gap |
| 3px | 4 | dot margin-top, id-box/rule-regex block padding, search-snippet margin |
| 4px | 5 | rule-header gap, action-items gap, rule-days gap, retry-card-actions margin-top, about margin-top |
| 5px | 1 | rule-condition margin-top |
| 6px | 11 | host-row gap, id-row gap, search-result padding, log-header/group gap, rule-item gap, rule-prompt padding, builtin-rule padding/margin, retry-card-actions gap, meeting-picker override, also-send label gap |
| 7px | 1 | action-item gap |
| 8px | 14 | --gap token, status-banner-py, textarea, select/input padding, snapshot margin/padding, log-entry padding, stats-grid gap/margin, sub-options padding (via token), retry-card-header gap |
| 9px | 1 | log-entry padding-block |
| 10px | 6 | --widget-py token, sub-options padding-top (literal), also-send gap, capture-footer py, stats-savings margin, rules-subhead top margin |
| 12px | 3 | --widget-px token, rules-empty padding, close-overlay button gap |
| 16px | 2 | #main-content padding, capture-footer px |
| 22px | 1 | toast horizontal padding |
| 24px | 1 | close-overlay body margin-bottom |
| 28px | 2 | log-empty block padding, close-overlay card block padding |
| 32px | 1 | close-overlay card inline padding |

**14 distinct spacing values in production** vs 3 defined tokens. Target: ≤ 8 distinct values (the proposed token set above).
