# U12 — In-page injected UI

## Summary

Three surfaces are injected directly into Google Meet's DOM: a **status toast** (`.mm2c-toast`), a **close-confirmation overlay** (`#mm2c-close-overlay`), and a **toolbar badge** managed via `chrome.action`. All three were styled independently and in isolation from the popup design system defined in `popup.html`. The result is a product that looks and feels like it was built by three different teams:

- The toast uses a pill shape (border-radius: 20px), Google's own font stack, and hardcoded hex colours (`#c5221f`, `#e37400`, `#137333`, `#1a73e8`) that are close to — but not identical to — the popup palette tokens.
- The overlay card uses dark-mode colours (`#202124`, `#e8eaed`, `#9aa0a6`) and a 12 px radius, sharply contradicting the popup's 6 px system radius and its light-only surface palette.
- The badge error/warning colours (`#c5221f`, `#e37400`) disagree with the popup `--danger` (`#ea4335`) and `--warn-text` (`#92400e`), creating a three-way colour inconsistency across badge ↔ toast ↔ popup for the same semantic states.

Ten discrete divergences are catalogued below.

---

## Proposed standard

Even though injected CSS cannot import popup.html's `:root` variables, the token values themselves are portable. The table below gives the target for each injected surface element:

| Element | Property | Target (from popup tokens) | Notes |
|---|---|---|---|
| Toast background — error | background | `#ea4335` (`--danger`) | Replace `#c5221f` |
| Toast background — warn | background | `#e37400` (keep; matches badge) | See warning note below* |
| Toast background — ok | background | `#137333` (`--success-text`) | Already matches; keep |
| Toast background — info | background | `#1a73e8` (`--primary`) | Already matches; keep |
| Toast border-radius | border-radius | `20px` (keep pill — intentional) | Pill on a dark page is acceptable; not a priority fix |
| Toast font-family | font-family | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | Match popup body font; drop Meet-specific 'Google Sans' |
| Toast font-size | font-size | `13px` | Already matches; keep |
| Overlay card background | background | `#ffffff` (`--surface`) | Replace `#202124`; popup is light-only |
| Overlay card text | color | `#202124` (`--text`) | Replace `#e8eaed` |
| Overlay card secondary text | color | `#6b7280` (`--text-muted`) | Replace `#9aa0a6` |
| Overlay card border-radius | border-radius | `6px` | Replace `12px` to match popup system radius |
| Overlay card padding | padding | `20px 24px` | Replace `28px 32px`; popup widget uses `10px 12px`; a modal warrants more but should be proportionally closer |
| Overlay "Leave" button — radius | border-radius | `6px` | Replace `18px` (pill); popup `.btn` uses `6px` |
| Overlay "Leave" button — border | border | `1px solid var(--border-strong)` → `#d1d5db` | Replace `1px solid #5f6368` (dark-mode grey) |
| Overlay "Leave" button — color | color | `#202124` (`--text`) | Replace `#e8eaed` (dark-mode) |
| Overlay "Save & leave" button — radius | border-radius | `6px` | Replace `18px` (pill) |
| Overlay "Save & leave" button — height | height | `32px` (popup `.btn-capture-now`) | Replace `36px` |
| Badge — error color | setBadgeBackgroundColor | `#ea4335` | Replace `#c5221f` in background.js |
| Badge — warning color | setBadgeBackgroundColor | `#e37400` (keep; closest to warn family) | *`#92400e` is text-on-light; not suitable for badge bg. `#e37400` is fine. |

> *`--warn-text` (`#92400e`) is a dark text colour for use on a light `--warn-bg`; it is not a suitable badge background. `#e37400` (orange) is already used for both badge and toast warn — make this the canonical "warn action colour" and document it.

---

## Findings

| # | Location (file:line) | Current | Divergence from popup system | Severity | Recommendation |
|---|---|---|---|---|---|
| 1 | `content_meet.js:1423` | Toast error bg `#c5221f` | Popup `--danger` is `#ea4335`; 3-surface mismatch (badge also `#c5221f`, but popup uses `#ea4335`) | High | Change to `#ea4335` in toast; change badge (see #10) so all error surfaces agree |
| 2 | `content_meet.js:1532` | Overlay card `background:#202124` | Popup `--surface` is `#ffffff`; popup has no dark-mode; overlay looks like a different product entirely | High | Switch to `#ffffff` background with `color:#202124` (`--text`); add `box-shadow:0 4px 16px rgba(0,0,0,.15)` for elevation |
| 3 | `content_meet.js:1543–1549` | Overlay buttons `border-radius:18px` (pill) | Popup `.btn` and all controls use `6px`; 18 px pill contradicts the entire popup shape language | High | Change both buttons to `border-radius:6px` |
| 4 | `content_meet.js:1534` | Overlay card `color:#e8eaed` (near-white) | Popup `--text` is `#202124`; text colour implies a dark-mode card that does not exist in the popup | High | Change to `#202124` (primary text) and `#6b7280` (secondary) to match `--text` / `--text-muted` |
| 5 | `background.js:258` | Badge error `setBadgeBackgroundColor('#c5221f')` | Popup `--danger` is `#ea4335`; `#c5221f` is Google's own Material Red 700 — not the popup token | High | Replace with `#ea4335` everywhere in background.js (lines 258, 421, 459) |
| 6 | `content_meet.js:1404` | Toast `font-family:'Google Sans',Roboto,sans-serif` | Popup uses `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` — Meet's own font first | Med | Lead with the system stack: `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif` |
| 7 | `content_meet.js:1532` | Overlay card `border-radius:12px` | Popup uses `6px` for all widgets, cards, and buttons; 12 px exists nowhere in the system | Med | Change to `6px` |
| 8 | `content_meet.js:1538` | Overlay secondary text `color:#9aa0a6` | Popup `--text-muted` is `#6b7280`; `#9aa0a6` is a grey from Google's Material palette, not the popup token | Med | Change to `#6b7280` |
| 9 | `content_meet.js:1543` | Overlay "Leave" button `border:1px solid #5f6368` | Popup `--border-strong` is `#d1d5db`; `#5f6368` is a dark-mode grey | Med | Change to `#d1d5db`; also update text colour from `#e8eaed` to `#202124` |
| 10 | `background.js:205,439,451` | Badge ok text `'OK'`, error text `'!'`, capturing text `'REC'` | No direct popup equivalent; badge communicates state that the popup status banner also communicates via semantic colour classes (.ok/.warn/.err) — the two surfaces are out of sync on warn semantics: badge warn uses `#e37400` while popup `.warn` uses `#92400e` on `#fffbeb` | Low | Document `#e37400` as the canonical "warn action colour" for badges/toasts (foreground-safe); no change needed to badge text strings — they serve a distinct purpose (glanceable from tab strip) |

---

### Severity breakdown
- **High**: 5
- **Med**: 4
- **Low**: 1

---

### Top 3 one-liners

1. **The close-overlay is a dark-mode card on a light-mode product** — `background:#202124` with `color:#e8eaed` text creates a jarring context switch; replace with popup's `--surface` (#ffffff) and `--text` (#202124).
2. **Error red is split three ways** — toast uses `#c5221f`, popup uses `--danger: #ea4335`, badge uses `#c5221f`; consolidating on `#ea4335` closes the gap across all surfaces with one grep-replace.
3. **Pill buttons (border-radius:18px) in the overlay contradict the 6 px system radius used by every popup button and widget** — this single change makes the overlay feel native to the design system.
