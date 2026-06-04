# U5 — Borders, radii & shadows

## Summary

The popup uses **two corner-radius values** for rectangular components: **6px** (widgets, banners, buttons, inputs, log containers) and **4px** (small inline inputs, rule controls). This 4/6 split is not documented as intentional and creates a visible inconsistency: `.rule-regex`, `.rule-prompt`, `.builtin-rule`, `#add-rule-btn`, and `.id-box` all sit 6px-radius neighbors but render at 4px themselves. The overlay in `content_meet.js` introduces two additional radii (12px card, 18px pill buttons, 20px toast) that are entirely unrelated to the popup scale. Shadows are used in only two places — the toggle knob (`0 1px 2px`) and the overlay card (`0 8px 30px`) — and are absent from components where they would help (fixed capture footer, toast over Meet UI). Border colors are mostly tokenized (`var(--border)`, `var(--border-strong)`) but the overlay uses hardcoded hex (`#5f6368`) for one button border. The dashed border on `#add-rule-btn` is a unique style not applied anywhere else, making it visually incongruent.

---

## Proposed standard (radius scale + border + shadow conventions)

### Radius scale (4 tiers)

| Token (proposed) | Value | Use |
|---|---|---|
| `--r-sm` | 4px | Micro controls: inline monospace inputs inside rule rows (`rule-regex`, `rule-prompt`, `id-box`) |
| `--r-md` | 6px | All other rectangular UI: widgets, banners, buttons, selects, text inputs, search, stat cells, log containers, retry cards, builtin rules, `#add-rule-btn` |
| `--r-lg` | 12px | Floating overlays / modals injected into host pages (close overlay card) |
| `--r-pill` | 999px / 50% | Toggles, dots, pill buttons (overlay action buttons → unify to 999px, not 18px) |

**Ruling on the 4/6 split:** The split should be *intentional and documented*. Recommended: promote all rule-area inputs to 6px (`--r-md`) so the entire popup is uniform at 6px, and drop the separate 4px tier for popup elements. Keep 4px only if a deliberate micro-control tier is desired — but document it and apply it consistently to every inline control of that class.

### Border convention

- All borders: `1px solid var(--border)` for resting state; `1px solid var(--border-strong)` for controls that need emphasis (button outlines, collapse buttons, rule-action buttons).
- Semantic variant borders (success, warn, danger) use their dedicated tokens (`--success-border`, `--warn-border`, `--danger-border`) — already correct.
- No hardcoded hex in border values. Overlay's `#5f6368` border → `var(--border-strong)` or equivalent dark-surface token.
- Dashed border on `#add-rule-btn` is acceptable as a deliberate "add" affordance, but should be its own token or comment to signal intent.

### Shadow convention

| Tier | Value | Use |
|---|---|---|
| Knob | `0 1px 2px rgba(0,0,0,.15)` | Toggle knob only |
| Elevated surface | `0 2px 8px rgba(0,0,0,.12)` | Fixed footer (`#capture-footer`), which should cast a subtle upward shadow to separate it from scrollable content |
| Overlay | `0 8px 30px rgba(0,0,0,.5)` | Injected overlays on host pages (dark surface, strong shadow appropriate) |

The toast's current `0 2px 10px rgba(0,0,0,.3)` is acceptable but could align to the overlay tier for consistency.

---

## Findings

| # | Location (file:line) | Current | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:621` `.rule-regex` | `border-radius: 4px` | Sits inside a 6px-radius widget next to 6px siblings; 4px is visually jarring — no documented intent for a 4px tier here | High | Change to 6px (or adopt `--r-sm: 4px` token with explicit rule that only applies to inline mono inputs) |
| 2 | `popup.html:649` `.rule-prompt` | `border-radius: 4px` | Same widget, textarea sibling to `.rule-regex` above — both 4px while the containing widget is 6px | High | Change to 6px |
| 3 | `popup.html:669` `#add-rule-btn` | `border-radius: 4px; border: 1px dashed var(--border-strong)` | 4px radius inconsistent with other buttons (6px); dashed border is the only dashed element in the popup — no comment or token explains the intent | High | Radius → 6px; if dashed is intentional "add" affordance, add a code comment and consider a `--border-dashed` token |
| 4 | `popup.html:738` `.builtin-rule` | `border-radius: 4px` | Read-only template cards rendered alongside user rule items at 4px, but surrounding widget is 6px | High | Change to 6px |
| 5 | `popup.html:270` `.id-box` | `border-radius: 4px` | Inline ID display box — the only 4px element in the setup panel; its 6px-radius `.setup-panel` parent and the 6px `.btn` sibling on the same row create a mismatch | Med | Change to 6px, or consistently use 4px for all mono-code display spans and document the micro tier |
| 6 | `content_meet.js:1403` toast `.mm2c-toast` | `border-radius:20px` | Toast pill uses 20px, not aligned to any popup-scale tier; overlay pill buttons use 18px — two slightly-off pill values in the same file | Med | Unify to `999px` (full pill); avoids the fragile absolute value and is the same token as the toggle track |
| 7 | `content_meet.js:1543` overlay "Leave without notes" button | `border:1px solid #5f6368` | Hardcoded hex color — only hardcoded border color in the entire codebase; the hex is Google's dark-surface border shade, not tracked by any token | Med | Replace with a CSS variable or at minimum a named constant; if the overlay lives outside the popup's CSS scope, define a small inline `:root{}` block for the injected style sheet |
| 8 | `content_meet.js:1543–1548` overlay action buttons | `border-radius:18px` | Pill buttons at 18px rather than `999px`; 18px on a 36px-tall button produces a full pill anyway, but it's not self-documenting | Low | Change to `border-radius:999px` to match the toggle convention and make intent clear |
| 9 | `popup.html:544–554` `#capture-footer` | No `box-shadow` | Fixed footer overlays scrollable content with only a `border-top`; no elevation shadow makes the layering feel flat when content scrolls behind it | Low | Add `box-shadow: 0 -2px 8px rgba(0,0,0,.08)` (upward shadow) to separate footer from scroll content |
| 10 | `content_meet.js:1532–1533` overlay card | `box-shadow:0 8px 30px rgba(0,0,0,.5)` | Strong shadow is contextually correct (dark background host page), but the value is inline and undocumented | Low | Add a comment or named constant; keep the value, it reads well on Google Meet's dark UI |
| 11 | `popup.html:100` `.tab` | `border-bottom: 2px solid transparent` (active: `var(--primary)`) | Tab active indicator uses a raw `2px` value with no token or comment; it's the only 2px border in the popup | Low | Acceptable as a one-off tab-indicator pattern, but add a brief comment (`/* active tab underline indicator */`) to clarify intent |
| 12 | `popup.html:630` `.btn-rule-action` | `border: 1px solid var(--border-strong); border-radius: 4px` | 22×22px micro icon button at 4px radius; `.btn-collapse` is functionally identical (also 22×22px, `border: 1px solid var(--border-strong)`) but already uses 4px, so these match — inconsistency is internal to the "what is the micro-button radius?" question, not a cross-component mismatch | Low | Both micro icon buttons share 4px — acceptable as a micro-button tier if documented. If the popup moves to a single 6px radius, raise both to 6px together |
