# U7 — Containers & layout

## Summary

The popup uses six distinct "card/box/widget" surface types plus two log-specific containers, but they share no single canonical anatomy. Padding, background, border colour, border-radius, and header structure all vary across `.widget`, `.setup-panel`, `.retry-card`, `.stat-cell`, `.builtin-rule`, `.search-result`, `.log-list-wrap`, and `.log-group-header`. The net effect is that the popup looks assembled from parts rather than built from one design system.

Three root problems drive all findings:

1. **Fragmented container chrome** — four background values (`var(--surface)`, `var(--surface-subtle)`, `var(--danger-bg)`, none), two radii (6 px / 4 px), and two border colours (`var(--border)` / `var(--danger-border)`) appear across containers that sit at the same visual level.
2. **No canonical header structure** — some widgets use `.widget-header` + `.widget-title` (correct), some use a bare `.widget-title` without a wrapper, some use a one-off `.snapshot-header` div with custom inline font styles, and the About identity block uses a fully inline-styled `<div>` inside `.widget-header` with no `.widget-title` at all.
3. **Dynamic JS containers don't reuse static classes** — `renderStats` emits `.stat-cell` divs without `.widget` context; `renderSearchResults` emits `.search-result` cards that duplicate `.widget` chrome at a different spec; `renderRetryList` emits `.retry-card` with its own padding/border variables instead of composing on `.widget`.

---

## Proposed standard (canonical container + header anatomy)

### Container

```css
.widget {
  padding: var(--widget-py) var(--widget-px);   /* 10 px / 12 px — already defined */
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);                   /* default: white */
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
/* Tinted modifier — replaces .setup-panel, .stat-cell, .search-result bg */
.widget.surface-subtle { background: var(--surface-subtle); }
/* Danger modifier — replaces .retry-card */
.widget.danger { border-color: var(--danger-border); background: var(--danger-bg); }
```

### Header anatomy

Every widget that has a title should use exactly this structure (already used in the best cases):

```html
<div class="widget-header">          <!-- flex row, space-between -->
  <div class="widget-title">…</div>  <!-- uppercase 10 px label -->
  <!-- optional: <button class="btn-collapse"> or <button class="btn"> -->
</div>
```

Rules:
- If the title needs a subtitle (e.g. About identity), add a `.hint` below `.widget-title` inside a wrapping `<div>`, not inline styles.
- Collapsible sections always use `.btn-collapse` + the existing `.open` rotation; no other chevron patterns.
- `.snapshot-header` should be retired and folded into `.widget-header` with the same `.btn-collapse` pattern.

### Section dividers

Internal separation between logically distinct rows inside one widget should always use `.sub-options` (`border-top: 1px solid var(--border); padding-top: 10px`). Ad-hoc `margin-top` or standalone `border-top` on individual child elements should be eliminated.

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | popup.html:251–262 | `.setup-panel` has `background: var(--surface-subtle)` and `font-size: 11px; color: var(--text-muted)` hardcoded | Separate class duplicates `.widget` padding/border/radius at a different background and font spec; sits at the same DOM level as `.widget` on main panel | High | Replace `.setup-panel` with `.widget.surface-subtle`; move the 11 px muted-text hint into a `.hint` child |
| 2 | popup.html:775–810 | `.retry-card` defines its own `padding: var(--widget-py) var(--widget-px)`, `border-radius: 6px`, `display: flex; flex-direction: column; gap: var(--gap)` — full duplication of `.widget` | Entire box structure is copy-pasted from `.widget` with only the border/bg differing; `.retry-card-header` / `.retry-card-title` / `.retry-card-hint` / `.retry-card-actions` are one-off sub-components that don't map to any shared header pattern | High | Replace `.retry-card` with `.widget.danger`; rename `.retry-card-header` → `.widget-header`, `.retry-card-title` → `.widget-title`, move hint to `.hint` |
| 3 | popup.html:687–694 / popup.js:177–181 | `.stat-cell` (`border-radius: 6px`, `padding: 8 px 10 px`, `background: var(--surface-subtle)`, `border: 1px solid var(--border)`) is emitted by JS inside a `.widget` | Nested card-inside-card uses slightly different padding (8/10 vs 10/12) and its own radius/border, producing a double-border grid look that differs from every other container; `.stats-grid` wrapper sits outside any canonical layout token | Med | Keep grid layout; replace `.stat-cell` chrome with a lighter token (e.g. background only, no border) OR promote to `.widget.surface-subtle` children with consistent padding |
| 4 | popup.html:396–402 / popup.js:223–230 | `.search-result` (`border-radius: 6px`, `padding: 6 px 8 px`, `background: var(--surface-subtle)`, `border: 1px solid var(--border)`) | Third card type at same visual level as `.widget` with smaller padding; emitted by `renderSearchResults` without using `.widget` class | Med | Replace with `.widget.surface-subtle` and adjust inner element classes; or add a `--widget-py-sm` / `--widget-px-sm` variant for dense cards |
| 5 | popup.html:572–600 | `.snapshot-header` is a custom collapsible header (`font-size: 12px; color: var(--text-muted)`) inside `#snapshot-widget.widget`, using `.snapshot-chevron` and JS class `.expanded` | Duplicates the `.widget-header` + `.btn-collapse` pattern already used in Rules panel widgets; `.snapshot-chevron` is a third chevron style alongside `.btn-collapse` and `.log-group-chevron` | High | Replace `.snapshot-header` with `.widget-header` + `.widget-title` + `.btn-collapse`; delete `.snapshot-chevron` and `.snapshot-header` CSS |
| 6 | popup.html:1087–1094 | About identity block: `<div class="widget-header"><div style="font-size:15px;font-weight:600;color:var(--text-strong)">Gememo</div>…</div>` — inline styles inside `.widget-header`, no `.widget-title` | Heading uses inline style instead of a token class; the `.widget-header` wrapper has no action button so the flex row serves no purpose here | Med | Replace inline `<div>` with `<h1 class="widget-title">` (override font-size locally via one class modifier) + `.hint` sibling; remove empty `.widget-header` wrapper |
| 7 | popup.html:727–762 | `.builtin-rule` uses `border-radius: 4px` (vs 6 px everywhere else) and `padding: 6 px 8 px` (vs 10/12) | Inconsistent radius/padding for a card sitting in the same widget column as `.rule-item` rows | Med | Standardise to `border-radius: 6px`; align padding to `var(--widget-py) var(--widget-px)` or introduce a documented small-card token |
| 8 | popup.html:429–434 | `.log-list-wrap` (`border: 1px solid var(--border); border-radius: 6px; overflow: hidden`) wraps `#log-list` which already contains `.log-group-header` with its own `background: var(--surface-subtle)` and `border-bottom` | Log panel is the only panel where a `.widget`-shaped shell exists without the `.widget` class; the outer border interacts visually with the inner `.log-group-header` border producing a doubled-border effect at top | Med | Give `.log-list-wrap` the `.widget` class (or alias it); or drop `.log-list-wrap`'s own border and background in favour of `.widget` |
| 9 | popup.html:604–610 / popup.html:517–524 | `.rule-item` uses `border-top: 1px solid var(--border); padding-top: 10px` directly on the element; `.sub-options` also uses `border-top` | Two competing divider patterns at the same semantic level: `.sub-options` (correct canonical divider) and ad-hoc `border-top` on `.rule-item` | Low | Unify: `.rule-item` should use `.sub-options` pattern or be wrapped in a `.sub-options` container; remove redundant per-item border-top |
| 10 | popup.html:278–289 | `.sub-options .sub-options` override sets `border-top-color: transparent; padding-top: 0` — negates the parent divider for nested sub-options | Nesting rule is fragile and has no visual equivalent in other panels; nested sub-options (craft/obsidian) appear to float without dividers | Low | Add an explicit modifier class (`.sub-options--nested`) instead of relying on CSS descendant specificity hack |
| 11 | popup.html:934–943 / popup.html:1019–1043 | Settings panel widgets `#snapshot-frequency`, `#note-language`, `#output-app`, `#file-backup` each use `.widget-title` without `.widget-header` wrapper | Inconsistent: Rules panel widgets use `.widget-header` + `.widget-title` (correct) but Settings panel widgets use bare `.widget-title` as direct child of `.widget` | Med | Wrap all lone `.widget-title` elements in `.widget-header` for uniform DOM structure; this enables the collapse affordance to be added later without refactor |
| 12 | popup.html:1114–1118 | About → Extension ID widget: `<div class="row" style="gap:6px;margin-top:4px">` uses inline `margin-top: 4px` | Inline spacing overrides the `.widget`'s `gap: var(--gap)` (8 px), reducing the row gap to 4 px inconsistently | Low | Remove `margin-top: 4px`; let `.widget`'s gap token govern spacing uniformly |
| 13 | popup.html:840–844 | Meeting picker (`#meeting-picker`) uses a bare `<div class="row" style="gap:6px">` with inline `style="font-size:12px;color:var(--text-muted)"` on the label span | No container chrome at all — the picker floats in the panel gap with no visual grouping; inline styles bypass the token system | Low | Wrap in `.widget` (or at minimum `.status-banner`) so it has the same border/radius/padding as surrounding surfaces |
| 14 | popup.js:254–278 | `renderRetryList` builds HTML strings with hardcoded `.retry-card`, `.retry-card-header`, `.retry-card-title`, `.retry-card-hint`, `.retry-card-actions` | Dynamic HTML doesn't reuse `.widget`, `.widget-header`, `.widget-title`, `.hint`, mirroring the static duplication issue (#2) in JS | High | After resolving #2, update template string to use canonical classes |
| 15 | popup.js:177–181 | `renderStats` builds `.stat-cell` divs with no `.widget` ancestry in the template string | Dynamic cells emitted without referencing any canonical container pattern | Med | After resolving #3, update template string accordingly |
| 16 | popup.js:223–230 | `renderSearchResults` builds `.search-result` divs as top-level cards | Dynamic cards don't compose on `.widget`; emitted outside any `.panel` container context | Med | After resolving #4, update template string |
| 17 | popup.html:665–677 | `#add-rule-btn` uses `border-radius: 4px` and `margin-top: 8px` (inline margin breaking gap token) | Radius inconsistency (4 px vs 6 px system-wide) and margin bypasses `.widget`'s `gap` | Low | Change to `border-radius: 6px`; remove `margin-top` and let `gap` handle spacing |
