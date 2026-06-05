# U2 — Color

## Summary

The popup defines a well-structured 20-token CSS custom-property palette in `popup.html :root`.
All popup CSS and inline `style=` attributes consume only those tokens — zero raw hex leaks in the
popup layer.

The two other surfaces — `background.js` (toolbar badge) and `content_meet.js` (in-page toast +
close overlay) — were built independently and hardcode every color as a raw hex string.  Several
of those hex values **do not match** the nearest popup token:

| Surface | Usage | Raw hex used | Nearest popup token | Delta |
|---|---|---|---|---|
| `background.js` / `content_meet.js` — error badge/toast | danger | `#c5221f` | `--danger #ea4335` | Very different (darker brick vs. Google red) |
| `background.js` / `content_meet.js` — warn badge/toast | warning | `#e37400` | `--warn-text #92400e` | Different family; no warn foreground token for icon use |
| `background.js` / `content_meet.js` — success badge/toast | success | `#137333` | `--success-text #137333` | **Exact match** — but used where `--success (#34a853)` would be more appropriate for a filled background |
| `content_meet.js` — overlay panel background | surface | `#202124` | `--text #202124` | Token exists but semantically wrong (text token reused as a background) |
| `content_meet.js` — overlay body text | — | `#e8eaed` | no token | Unregistered color |
| `content_meet.js` — overlay muted text | — | `#9aa0a6` | `--text-muted #6b7280` | Different value (Google Material grey vs. Tailwind grey) |
| `content_meet.js` — overlay border / leave-btn border | — | `#5f6368` | `--border-strong #d1d5db` | Different family (dark-mode border on a dark card) |
| `content_meet.js` — toast text | — | `#fff` | `--surface #ffffff` | Equivalent, unregistered shorthand |

The popup also has one shadow using a raw `rgba(0,0,0,.15)` literal, which is acceptable as a
box-shadow value that has no semantic token equivalent.

---

## Proposed standard — canonical unified palette

Every surface should import or mirror the tokens defined in `popup.html :root`. For surfaces that
cannot use CSS variables (service-worker `background.js`, inline strings in `content_meet.js`)
a **constant map** should be the single source of truth, ideally in `constants.js`.

### Token table

| Token | Hex | Semantic role |
|---|---|---|
| `--surface` | `#ffffff` | Panel / card background (light) |
| `--surface-subtle` | `#f9fafb` | Recessed / zebra background |
| `--border` | `#e5e7eb` | Default border |
| `--border-strong` | `#d1d5db` | Emphasized border, toggle track |
| `--text` | `#202124` | Primary body text |
| `--text-muted` | `#6b7280` | Secondary / caption text |
| `--text-strong` | `#111827` | Headings |
| `--primary` | `#1a73e8` | Brand blue — links, active states, CTA fill |
| `--primary-dark` | `#1557b0` | Hover/pressed primary |
| `--success` | `#34a853` | Success fill (dot, badge background, toast background) |
| `--success-text` | `#137333` | Success text on light bg |
| `--success-bg` | `#f0fdf4` | Success tinted background |
| `--success-border` | `#bbf7d0` | Success border |
| `--warn-text` | `#92400e` | Warning text on light bg |
| `--warn-bg` | `#fffbeb` | Warning tinted background |
| `--warn-border` | `#fde68a` | Warning border |
| `--danger` | `#ea4335` | Danger fill (dot, badge background, toast background) |
| `--danger-text` | `#b91c1c` | Danger text on light bg |
| `--danger-bg` | `#fef2f2` | Danger tinted background |
| `--danger-border` | `#fecaca` | Danger border |
| `--focus` | `#9ca3af` | Focus ring / hover border accent |
| `--hover-primary` | `#e8f0fe` | Primary hover tint |

### Raw hex → token mapping (all hardcoded values found)

| Raw hex (as used) | Recommended token | Notes |
|---|---|---|
| `#137333` | `--success-text` | Exact match — but for filled backgrounds (badge, toast) use `--success (#34a853)` instead |
| `#e37400` | _new token needed_: `--warn` `#e37400` | No filled-warn token exists yet; add `--warn: #e37400` to `:root` |
| `#c5221f` | `--danger` → `#ea4335` | Mismatch — `#c5221f` is a darker Google-internal shade; normalize to `--danger` |
| `#1a73e8` | `--primary` | Exact match |
| `#fff` / `#ffffff` | `--surface` | Equivalent; use the token |
| `#202124` | `--text` | Token exists; this value is reused as a **dark overlay bg** in the close overlay — needs a dedicated dark-surface token instead |
| `#e8eaed` | _new token needed_: `--surface-dark-text` | Light text on dark backgrounds; no token exists |
| `#9aa0a6` | `--text-muted` (`#6b7280`) | Different value; pick one and register it; preference: keep Tailwind `#6b7280` and update overlay to match |
| `#5f6368` | `--border-strong` (`#d1d5db`) | Dark-mode border; only used on the dark overlay; once overlay adopts tokens this resolves |

---

## Findings

| # | Location (file:line) | Current value | Issue | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `background.js:258`, `background.js:421`, `background.js:458` | `#c5221f` (error badge) | Danger color is `#c5221f` but the popup danger token is `--danger #ea4335` — visually different shades; badge and popup dot use different reds | **High** | Change to `#ea4335` (`--danger`) so the badge matches the popup dot color |
| 2 | `content_meet.js:1423` | `#c5221f` (err toast bg) | Same mismatch as above — in-page error toast uses a different red than the popup | **High** | Change to `#ea4335` (`--danger`) |
| 3 | `background.js:246` | `#e37400` (warn badge) | No warning fill token exists in the popup palette. `--warn-text` is `#92400e` (dark amber for text), not an orange fill. The badge uses a bright orange that has no equivalent anywhere | **High** | Add `--warn: #e37400` to `:root` and use that constant in `background.js`; use the same value in `content_meet.js:1424` |
| 4 | `content_meet.js:1424` | `#e37400` (warn toast bg) | Same missing token issue as finding #3; warn toast and popup warn state use semantically inconsistent colors | **High** | Align to new `--warn: #e37400` token |
| 5 | `content_meet.js:1532` | `#202124` (overlay card bg) | Uses `--text` value as a dark background — semantic mismatch. Also not a CSS variable so it drifts silently | **Med** | Introduce `--surface-dark: #202124` or `--overlay-bg: #1e2022` and use it here |
| 6 | `content_meet.js:1534` | `#e8eaed` (overlay body text color) | Unregistered color; no popup token corresponds to light-on-dark text | **Med** | Add `--surface-dark-text: #e8eaed` to `:root` and reference the constant in the overlay |
| 7 | `content_meet.js:1538` | `#9aa0a6` (overlay muted text) | Popup uses `--text-muted: #6b7280` (Tailwind grey); overlay uses `#9aa0a6` (Google Material grey) — two different muted-text values in the same product | **Med** | Standardize on `--text-muted: #6b7280`; update overlay to use that constant |
| 8 | `content_meet.js:1543` | `#5f6368` (leave-btn border) | Unregistered dark-surface border color; no token exists for dark-mode borders | **Med** | Add `--border-dark: #5f6368` to `:root`; reference in overlay |
| 9 | `background.js:206`, `background.js:340`, `background.js:439` | `#137333` (success badge) | Value matches `--success-text` exactly, but it is used as a **filled background** for the badge. Filled semantic states should use `--success (#34a853)`, not the text variant | **Med** | Change to `#34a853` (`--success`) for the badge fill; reserve `#137333` for text |
| 10 | `content_meet.js:1425` | `#137333` (ok toast bg) | Same semantic misuse as finding #9 — success background filled with text-weight green | **Med** | Change to `#34a853` (`--success`) |
| 11 | `content_meet.js:1405` | `#fff` (toast text color) | Inline raw `#fff` — functional equivalent of `--surface` but not using the token | **Low** | Use the `--surface` constant in the constants map (or just keep `#fff` as an accepted shorthand — document the decision) |
| 12 | `content_meet.js:1549` | `#1a73e8` (overlay save-btn bg), `#fff` (save-btn text) | Hardcoded instead of constants — will drift if `--primary` ever changes | **Low** | Reference `--primary` constant |
| 13 | `popup.html:203` | `rgba(0,0,0,.15)` (toggle thumb shadow) | Raw rgba in popup CSS; no shadow token exists | **Low** | Acceptable as-is (box-shadow alphas are not typically tokenized) — document or add `--shadow-sm` if more shadows are added |
