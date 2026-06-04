# U9 — Inline-style audit

## Summary

| File | Inline-style occurrences | Notes |
|---|---|---|
| `extension/popup.html` | 12 | Mix of static one-offs and redundant layout overrides inside the static HTML below line 812 |
| `extension/popup.js` | 0 | Zero `.style.x =` or `cssText` assignments; all visibility changes go through class toggles — clean |
| `extension/content_meet.js` | 14 | Two separate surfaces: (a) toast `showStatus()` sets `el.style.bottom` and `el.style.background` dynamically; (b) `showCloseOverlay()` builds an entire component with `style=""` on every element |

**Total occurrences: 26**
Severity breakdown: **High 6 · Medium 11 · Low 9**

---

## Proposed standard

> **Rule: no static inline styles anywhere in the codebase; runtime-only styles must use CSS custom properties or modifier classes.**

1. **Allowed** — an inline style is legitimate only when the value is computed at runtime and cannot be expressed as a predefined class or token:
   - Example: `el.style.bottom = (toolbar.offsetHeight + 12) + 'px'` — toolbar height is unknown until the DOM renders.

2. **Not allowed** — everything that is a fixed literal belongs in the stylesheet:
   - Fixed typography (`font-size:15px`, `font-weight:600`, `color:var(--text-strong)`) → use or create a CSS class.
   - Layout helpers (`display:flex`, `gap:2px`) that repeat existing patterns → extend `.row`, `.widget-header`, etc.
   - Color choices (`background:#202124`, `color:#e8eaed`) from the in-page overlay → add tokens to `:root` and reference them from a stylesheet injected into Meet's page.

3. **For content_meet.js specifically** — the toast and overlay live in Google Meet's page, not the extension popup, so they cannot reference popup.html's `<style>`. The correct fix is a dedicated `content_meet.css` manifest entry that injects the sheet alongside the script, following the same token/class approach as popup.html.

4. **Enforcement** — enforce with an ESLint `no-restricted-syntax` rule targeting `.style.` property assignments whose right-hand side is a string literal, and a linting pass on HTML files blocking `style="` attributes outside the `<style>` tag.

---

## Findings

| # | Location (file:line) | Current inline style | Should be | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `popup.html:840` | `style="gap:6px"` on `.row` in `#meeting-picker` | `.row` already has `gap: var(--gap)` (8px); this just overrides to 6px | High | Remove override; if 6px gap is intentional, add `.row--tight` modifier with `gap:6px` |
| 2 | `popup.html:841` | `style="font-size:12px;color:var(--text-muted)"` on `<span class="label">` inside `#meeting-picker` | `.label` is 13px/var(--text). The override introduces a one-off muted-label variant | High | Add `.label--muted` class: `font-size:12px; color:var(--text-muted)` — reusable across pickers |
| 3 | `popup.html:842` | `style="flex:1;max-width:200px"` on `<select id="meeting-tab-select">` | Static sizing for this specific select | Med | Add `#meeting-tab-select` rule to stylesheet: `flex:1; max-width:200px` |
| 4 | `popup.html:875` | `style="display:flex;flex-direction:column;gap:2px"` on anonymous `<div>` inside `.snapshot-header` | Static layout, duplicates the `.panel` / `.widget` gap idiom at a smaller scale | High | Add `.snapshot-header__meta` class with these three declarations |
| 5 | `popup.html:877` | `style="font-size:11px;color:var(--text-muted)"` on `<span id="snapshot-next">` | Duplicate of `.hint` (10px/muted) — 11px is a one-off | Med | Either reuse `.hint` (accept 10px) or introduce `.text-xs` (11px/muted) used elsewhere too |
| 6 | `popup.html:936` | `style="display:flex;align-items:center;gap:6px"` on anonymous `<div>` wrapping the snapshot-interval number+unit pair | Static layout. The `.row` class does the same but with `justify-content:space-between` | Med | Add `.inline-pair` utility: `display:flex; align-items:center; gap:6px` (reusable for any label+control pair) |
| 7 | `popup.html:1090` | `style="font-size:15px;font-weight:600;color:var(--text-strong)"` on `<div>` (app name in About) | Exact duplicate of `h1` rule in stylesheet (15px/600/var(--text-strong)) | High | Replace div with `<h2>` or add class `.about-app-name` that reuses the h1 styles; eliminates literal duplication |
| 8 | `popup.html:1091` | `style="margin-top:2px"` on `<div class="hint" id="about-version">` | Spacing override on an existing class | Low | Add `.hint--top-tight { margin-top: 2px }` or accept `.hint` default (margin:0 already) |
| 9 | `popup.html:1094` | `style="margin:0"` on `<p class="hint">` | `.hint` already declares `margin:0` in the stylesheet — this is a no-op override | Low | Remove: the inline style is redundant (`.hint { margin: 0 }` is defined at line 368) |
| 10 | `popup.html:1101` | `style="margin:10px 0 0"` on `<p class="hint stats-savings">` | One-off top margin for the savings paragraph | Low | Move to `.stats-savings { margin-top: 10px }` already in the stylesheet stub at line 694 — that rule exists but has no `margin` declaration |
| 11 | `popup.html:1115` | `style="gap:6px;margin-top:4px"` on `.row` inside Extension ID widget | Same 6px gap override as #1; adds a top margin not present on other rows | Med | `.row--tight` (gap) + spacing utility, or just set via the `#about-ext-id` widget's `.widget` padding |
| 12 | `popup.html:1116` | `style="font-family:Monaco,Menlo,'Ubuntu Mono',monospace;font-size:11px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"` on `<span id="about-ext-id">` | 7-property inline style mixing typography, color, layout, and overflow — large drift surface | High | Add `#about-ext-id` rule to stylesheet; or create `.id-display` class (matches `.id-box` pattern at line 264 almost identically — likely the same intent) |
| 13 | `popup.html:1125` | `style="margin-top:4px"` on `<a class="btn kofi-btn">` | One-off spacing nudge | Low | Either add `.kofi-btn { margin-top: 4px }` to stylesheet, or rely on widget's `gap: var(--gap)` |
| 14 | `content_meet.js:1419` | `el.style.bottom = (toolbar ? toolbar.offsetHeight + 12 : 120) + 'px'` | Runtime computed value based on DOM measurement | **Legitimately dynamic** | Keep as-is; document that this is the only allowed `.style.` assignment in the file |
| 15 | `content_meet.js:1423–1426` | `el.style.background = type === 'err' ? '#c5221f' : type === 'warn' ? '#e37400' : type === 'ok' ? '#137333' : '#1a73e8'` | Hard-coded hex values that duplicate the popup's `--danger`, `--warn-text`, `--success-text`, `--primary` tokens | High | Move color map into `content_meet.css` as modifier classes `.mm2c-toast--err`, `--warn`, `--ok`, `--info`; swap the `el.style.background` assignment for `el.className = 'mm2c-toast mm2c-toast--' + type`. Tokens should be repeated in `content_meet.css` since it runs in a different page context |
| 16 | `content_meet.js:1401–1408` | Inline `<style>` string injected via `s.textContent` for `.mm2c-toast{…}` | Static CSS being assembled as a JS string — bypasses manifest CSS pipeline entirely | Med | Declare `.mm2c-toast` in `content_meet.css` (add to manifest `content_scripts[].css`); remove the runtime `<style>` injection block |
| 17 | `content_meet.js:1525–1529` | `closeOverlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px)'` | Entire overlay wrapper style as a `cssText` blob | High | Move to `#mm2c-close-overlay` CSS rule in `content_meet.css`; remove `cssText` assignment |
| 18 | `content_meet.js:1532–1534` | `style="background:#202124;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:…;font-family:…;color:#e8eaed;text-align:center;"` on overlay card `<div>` | 9-property inline style; hard-coded Meet dark-theme colors (#202124, #e8eaed) | High | `.mm2c-overlay-card` CSS class in `content_meet.css` |
| 19 | `content_meet.js:1535–1536` | `style="font-size:18px;font-weight:500;margin-bottom:10px;"` on overlay title `<div>` | Static typography + spacing | Med | `.mm2c-overlay-title` class in `content_meet.css` |
| 20 | `content_meet.js:1538–1539` | `style="font-size:13px;color:#9aa0a6;margin-bottom:24px;line-height:1.5;"` on overlay body `<div>` | Static typography; `#9aa0a6` is Meet's muted text — not in popup token set | Med | `.mm2c-overlay-body` class; add `--meet-text-muted: #9aa0a6` token to `content_meet.css` |
| 21 | `content_meet.js:1541` | `style="display:flex;gap:12px;justify-content:center;"` on overlay button row `<div>` | Static layout | Med | `.mm2c-overlay-actions` class in `content_meet.css` |
| 22 | `content_meet.js:1543–1545` | `style="flex:1;height:36px;border-radius:18px;border:1px solid #5f6368;background:transparent;color:#e8eaed;font-size:13px;cursor:pointer;"` on "Leave without notes" button | 7-property inline style; ghost button design for Meet dark theme | Med | `.mm2c-btn-ghost` class in `content_meet.css` |
| 23 | `content_meet.js:1547–1549` | `style="flex:1;height:36px;border-radius:18px;border:none;background:#1a73e8;color:#fff;font-size:13px;font-weight:500;cursor:pointer;"` on "Save & leave" button | Primary button inline style; `#1a73e8` = `--primary` token in popup but hard-coded here | Med | `.mm2c-btn-primary` class in `content_meet.css`; share `--primary` value via token |

---

## Classification summary

| Category | Count | Items |
|---|---|---|
| Legitimately dynamic | 1 | #14 (toast bottom position) |
| Duplicates existing class/token | 5 | #9 (margin:0 no-op), #7 (h1 clone), #12 (.id-box clone), #15 (popup tokens), #3 |
| One-off value bypassing design system | 20 | all others |

---

## Top 3 highest-impact fixes

1. **`content_meet.js:1525–1549` — entire close-overlay (7 inline styles / cssText blob):** Create `content_meet.css`, add it to the manifest `content_scripts` `css` array, and move all overlay and toast styles there. This single file creation eliminates 8 findings (#16–#23) in one pass and gives the overlay a real stylesheet it can share tokens with.

2. **`popup.html:1116` — `#about-ext-id` 7-property inline block:** This is nearly identical to the existing `.id-box` class (line 264). Replacing the `<span>`'s inline style with `class="id-box"` (or a thin `.id-display` variant) costs one line and removes 7 hard-coded properties from HTML.

3. **`content_meet.js:1423–1426` — toast background color map with raw hex values:** Four hard-coded hex colors bypass both the popup design tokens and any future theme change. Introduce `.mm2c-toast--err/warn/ok/info` CSS classes in `content_meet.css`; the JS reduces to a single `el.className` swap and the colors live in one authoritative place.
