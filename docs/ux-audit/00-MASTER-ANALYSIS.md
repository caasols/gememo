# Gememo — UX & Copy Consistency Analysis (Master)

> Goal: make the whole product feel designed and built by **one person** — one
> design system, one voice. This document consolidates a 20-agent specialist
> audit (12 visual, 8 copy) into ranked themes and a remediation roadmap.
>
> **Scope:** the 5 user-facing surfaces — `popup.html` (the design system + popup
> UI), `popup.js` (dynamic DOM), `content_meet.js` (in-Meet toast + close
> overlay), `background.js` (toolbar badge + notifications), `constants.js`
> (prompt/template copy).
>
> **Totals:** ~255 visual findings + ~132 copy findings across 20 sub-reports.
> Don't read this as "387 bugs" — most collapse into ~12 root-cause themes below.

---

## How to read this

- Sub-reports live alongside this file: `U1`…`U12` (visual), `C1`…`C8` (copy).
  Each has a **Proposed standard** section — those are the design tokens / style
  rules to adopt. This master ranks them and removes duplication.
- Severity in sub-reports is per-dimension. Here I re-prioritize by **blast
  radius** (how many surfaces / how visible) and **convergence** (how many
  independent agents flagged the same root cause).

---

## Part 0 — Correctness issues found along the way (not just consistency)

These are not cosmetic. Surfaced by the copy agents; verified against source.

| # | Issue | Location | Evidence |
|---|---|---|---|
| K1 | **Close overlay always says "Craft"** regardless of the user's chosen output app — wrong for Apple Notes / Obsidian users. `outputAppName()` already exists in the same file. | `content_meet.js:~1535–1552` (helper at `:1201`) | Verified: helper used for toast (1172/1193) but not the overlay. |
| K2 | **"Gemini not active" is worded 3 different ways** across the 3 surfaces, including a subject-verb agreement error ("Gemini notes **was** not active"). | popup / toast / notification (see C5) | C5 #1 |
| K3 | **Raw exception text shown to users** — `Error: ${err.message}`, `Native host error: ${err}` surface JS/native errors with no plain-English wrapper or recovery step. | 3+ call sites (see C5) | C5 #2 |
| K4 | **"The primary app is ignored here" hint contradicts behavior** — misleading instruction next to "Also send to". | `popup.html:1014` | C6 #2 / C8 #6 |

> Correction to U11: the report's "log entries render with no title" (flagged
> High/functional) is **overstated**. Log entries intentionally show
> time + message under a group title; `.log-title` (popup.html:472) is a
> **dead/orphan CSS class**, never rendered — a Low cleanup, not a bug.

---

## Part A — Visual / UX consistency

### The single biggest theme: three disconnected "visual worlds"

The popup has a clean, token-driven design system. The **in-Meet surfaces were
authored independently and never reconciled with it.** Six agents (U4, U5, U6,
U8, U9, U12) independently flagged the same components.

**A1 — The close-confirmation overlay is effectively a different app.** `content_meet.js:~1523–1552`
- Dark card (`background:#202124`, `color:#e8eaed`) inside an otherwise **light** product (U12).
- **Pill buttons** (`border-radius:18px`) vs the system's 6px (U5, U6).
- Hardcoded hex border `#5f6368` — the only one in the codebase (U5).
- **Zero interaction states** — no hover, focus ring, or active feedback on the
  two most consequential buttons in the product (U8).
- All dimensions hardcoded inline, invisible to the token system (U4, U9).
- **Fix:** rebuild the overlay against popup tokens (white surface, 6px radius,
  `.btn`-equivalent buttons, system type). Best done by shipping a real
  `content_meet.css` (see A6).

**A2 — Color is split three ways.** (U2, U9, U12 — highest convergence)
- Error red: popup token `--danger:#ea4335`, but badge **and** toast use `#c5221f`.
- Warn: popup has only `--warn-text:#92400e` (dark amber **text**); badge/toast
  use `#e37400` (orange **fill**) — there is no warn-fill token at all.
- Success: badge/toast use `#137333`, which is the popup's `--success-**text**`
  value, not `--success:#34a853` (the brighter fill). Filled success states
  therefore render darker than the popup's success dots.
- **Fix:** define one semantic palette with **both** a text-weight and a
  fill-weight per state (success/warn/danger/info), and make the badge + toast
  use those exact values. A single grep-replace of `#c5221f → #ea4335` closes
  three divergences at once.

### Control sizing & the button family

**A3 — Button heights are uncoordinated: 22 / 24 / 28 / 32 / 36px.** (U4, U6, U11)
- `.btn`24 · `.tab`30 · `.btn-collapse`/`.btn-rule-action`22 · `.btn-capture-now`32
  · `#add-rule-btn`28 · `.log-retry-btn`~18 (via `padding:1px 6px`) · overlay buttons 36.
- `.note-search` renders ~32px while every sibling input/select is 24px, so
  Settings rows visually misalign (U6).
- **Fix:** adopt a 3-tier height scale (e.g. **S 22 / M 28–30 / L 36** + a 24px
  input/control baseline), assign each button a role, and snap orphans
  (`#add-rule-btn`→M, `.btn-capture-now`→L to match the overlay it pairs with).

**A4 — `.btn-collapse` and `.btn-rule-action` are duplicate icon-button classes**
with identical box but different text color for no semantic reason — merge into
one `.btn-icon`. (U6, U7)

### Structure, spacing, radii

**A5 — Container chrome is copy-pasted, not shared.** (U7 — 17 findings)
- `.retry-card` is `.widget` with border/bg swapped → should be `.widget.danger`.
- `.snapshot-header` is a **third** collapse/chevron pattern duplicating
  `.widget-header` + `.btn-collapse`.
- Five Settings widgets use a bare `.widget-title` with **no** `.widget-header`
  wrapper, while Rules widgets use the full header — inconsistent anatomy.
- **Fix:** one canonical container (`.widget`, optional `.danger`) + one header
  anatomy (`.widget-header > .widget-title [+ .btn-collapse]`).

**A6 — Styling escapes the system in ~26 inline-style sites.** (U9)
- popup.html 13 · content_meet.js 14 (1 legitimately dynamic) · popup.js mostly clean.
- `#about-ext-id` reimplements the existing `.id-box` class inline (swap = 7
  properties gone). The About "Gememo" heading reimplements `h1` inline (U1).
- **Fix:** extract a `content_meet.css` (kills ~8 overlay findings + the toast
  color map), swap inline blocks for existing classes, forbid static inline styles.

**A7 — Radius scale has an accidental 4/6 split.** Rules-panel controls use 4px
while everything else uses 6px; the overlay adds 12/18/20px. Pick **one** radius
(6px) + one pill exception if truly needed. (U5)

**A8 — Spacing tokens are under-used.** (U3 — 59 findings, mostly Low/Med)
- Literal `6px` gap appears 11× (never tokenized); `margin-*` inside flex columns
  double-counts the parent `gap` in ~9 places; log entry/header use mismatched
  block padding (9px vs 8px) producing uneven rows in the most-viewed panel.
- **Fix:** add `--space-3:6px`, replace literals, delete redundant margins.

### Typography, icons, states

**A9 — Type roles drift.** (U1) Two "section label" styles for the same role
(`.widget-title` 10px/0.6px vs `.rules-subhead` 11px/0.04em); About heading
inline-duplicates `h1`; in-Meet surfaces use a `'Google Sans',Roboto` stack vs
the popup's system-UI stack. **Fix:** one type scale, shared across surfaces.

**A10 — Icon vocabulary is split.** (U10) Two chevrons mean "expand" (`▾` at 180°
vs `▶` at 90°); two cross glyphs for dismiss (`✕` U+2715 vs `×` U+00D7); a lone
`⚠️` emoji in one warn toast where every other warn surface uses color only.
**Fix:** one symbol per meaning.

**A11 — Accessibility: focus-visible is near-absent.** (U8 — High) Tabs, toggles,
collapse/rule-action buttons, the capture CTA, and the Logs search input have **no
keyboard focus ring**. Also the `.copied` success pattern is applied to 2 of 3
copy buttons (the third only changes text), and transition durations are
ad-hoc (0.1/0.15/0.2/0.3s). **Fix:** global `:focus-visible` ring via `--focus`,
apply `.copied` everywhere, standardize one transition duration.

---

## Part B — Copy consistency

**B1 — Terminology drift for core concepts.** (C2 — 25 findings)
- Output target called **"Output app"** (title) vs **"Destination"** (its own
  row label) vs **"note app"** (README hero) — three words, one concept, within
  one widget.
- **Fix:** pick one canonical term per concept (glossary in C2) — recommend
  **"output app"** everywhere — and align the README hero to the in-product term.

**B2 — Ellipsis & trailing-period inconsistency.** (C1, C3 — high convergence)
- ASCII `...` in every `content_meet.js` `showStatus()` call vs Unicode `…` in
  popup banners. **Fix:** always `…`.
- `"Not in a meeting."` is the **only** status banner with a trailing period;
  its sibling in-meeting messages are full sentences with none. **Fix:** pick one
  rule — recommend periods on full-sentence status/hints, none on fragments/buttons.

**B3 — Button-label voice.** (C4) All three copy buttons emit `"Copied!"`
(should be `"Copied"`, no `!`, and reset to their own idle label). `"Open ↗"` is
the only non-verb label (→ "View on GitHub"). `"Retry →"` is the only button with
a decorative glyph (→ "Retry"). Overlay pair isn't parallel
("Leave without notes" vs "Save & leave"). **Fix:** imperative, sentence case,
no glyphs, ≤3 words, one done-state pattern.

**B4 — Status/toast/notification messages lack a shared shape.** (C5 — see also
K2/K3) Same event worded differently across the 3 surfaces; errors leak raw
exceptions; no consistent "what happened + what to do" structure. **Fix:** adopt
per-level templates (success/info/warn/error) and route all three surfaces
through the same strings for a given event.

**B5 — Hints don't share a shape.** (C6) One opens with a `"Slack:"` label-colon
no other hint uses; one is self-contradictory (K4); the Snapshot-frequency input
is the only output-affecting setting with no hint. **Fix:** one hint style —
sentence case, ends with period, ≤140 chars, benefit/action-first.

**B6 — Three placeholder philosophies + inconsistent null glyph.** (C7) Within
60px in Settings: ghost-example (`https://hooks.example.com/...`), instruction
(`Select vault…`), and hint-in-placeholder (`(blank = default space)`). Null
values use `—` everywhere except the retry card's prose `"Unknown meeting"`.
Empty states explain the next action only in `.log-empty`, not in `.rules-empty`
/`.search-empty`. **Fix:** one placeholder style; `—` for all nulls; every empty
state = one friendly sentence + the action.

**B7 — Voice is broadly consistent; 3 off-voice spikes.** (C8) README voice =
confident, plain-spoken, 2nd-person, lightly informal, privacy-forward, no
hedging. Product mostly matches; the exceptions are the correctness items K1
(wrong app name), K3-adjacent jargon leak ("inject prompt" in a user toast,
`content_meet.js:1321`), and K4 (misleading hint).

---

## Prioritized remediation roadmap

**P0 — Correctness (ship first; these are wrong, not just inconsistent)**
1. K1 — overlay: use `outputAppName(currentOutputApp)` instead of hardcoded "Craft".
2. K2 — unify the "Gemini not active" message (fix the grammar error).
3. K3 — wrap raw exceptions in plain-English + a recovery step.
4. K4 — rewrite the "Also send to" hint to match actual behavior.

**P1 — High-blast-radius consistency (most visible "different product" feel)**
5. A2 — one semantic palette (text + fill weights); kill `#c5221f`/`#e37400`/`#137333` drift.
6. A1 — rebuild the close overlay against popup tokens.
7. A6 — create `content_meet.css`; remove inline-style + JS color map.
8. A3 — adopt the control-height scale; snap orphan buttons.
9. A11 — global `:focus-visible` ring (accessibility) + consistent `.copied`.

**P2 — System hygiene (one design language)**
10. A5/A4 — collapse duplicate containers/icon-buttons into shared classes.
11. A7 — single radius scale (6px). A9 — single type scale across surfaces.
12. A10 — one glyph per meaning (chevron, dismiss).
13. B1 — apply the terminology glossary. B3 — button-label pass.

**P3 — Copy polish**
14. B2 (ellipsis/periods), B4 (message templates), B5 (hints), B6 (placeholders/empty states).
15. A8 — spacing token cleanup; remove dead `.log-title`.

---

## Suggested foundation: a shared token contract

The root cause of ~70% of findings is that **`content_meet.js` and `background.js`
can't see the popup's CSS variables.** Recommend a single source of truth:

- A `design-tokens.js` (or JSON) exporting the palette / radii / type / spacing
  as plain values, imported by `background.js` (badge colors) and
  `content_meet.js` (toast/overlay), and mirrored 1:1 by the `:root` CSS vars in
  `popup.html` (+ the new `content_meet.css`).
- This makes "change the brand red once" actually possible, and is what lets the
  three visual worlds converge permanently rather than drifting again.

*Sub-reports: U1–U12 (visual), C1–C8 (copy) in this directory.*
