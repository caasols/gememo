# Competitor UX & Polish Research — patterns to borrow for Gememo

> Web research pass (June 2026) into what leading AI-notetakers — **Granola**,
> **Otter.ai**, and comparable tools (Fathom, Fireflies, plus polish exemplars
> Linear/Superhuman) — do well, and **where each pattern maps into Gememo**.
> Sources cited inline. Companion to the 20-agent consistency audit
> (`00-MASTER-ANALYSIS.md`) and the `UXC-*` roadmap items.
>
> *Note: "Altar" in the request appears to be a mis-transcription of "Otter" —
> there is no notable meeting-notes app named Altar. Otter.ai is covered below.*

---

## The big strategic insight: Gememo already owns Granola's winning thesis

The single most-cited reason Granola feels premium and hit ~70% retention is its
**"invisible AI"** model: no bot joins the call, nothing is announced, the
*process* disappears while the user keeps agency. Otter's most-cited weakness is
the opposite — a visible bot that joins the call, creating "psychological
friction," self-censorship, and skipped recordings for sensitive meetings.
([UX Planet](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17), [zackproser](https://zackproser.com/blog/granola-vs-otter), [aloa](https://aloa.co/ai/comparisons/ai-note-taker-comparison/otter-ai-vs-granola))

**Gememo is structurally bot-free already** — it reads Gemini's own transcript,
no bot, no join, no announcement. That means the market's premium-defining
quality is your *architecture*, not something to build. The gap is that the
**UI doesn't yet celebrate or reassure around it.** Most recommendations below
are about making the experience live up to the architecture.

---

## Part 1 — Patterns to borrow, mapped to Gememo

### 1. Calm, minimal, "process-disappears" status feedback
**What they do:** Granola lives as a *quiet* menu-bar icon and a small,
unobtrusive, **draggable** floating recording "nub" — visible enough to reassure,
quiet enough to ignore. The design is deliberately non-intrusive.
([WonderTools](https://wondertools.substack.com/p/granolaguide), Granola docs)
**Map to Gememo:**
- The in-Meet toast (`content_meet.js`) is the equivalent of the nub. Make it
  *calm and consistent* — one position, gentle motion, muted until something
  needs attention. This is exactly **UXC-6/UXC-7** (re-skin toast/overlay to the
  popup's quiet token system) and **UXC-13** (drop the lone `⚠️` emoji).
- The toolbar `REC` badge already does the "quietly recording" job — keep it,
  align its colors to the palette (**UXC-5**).

### 2. Confirm the result *after* the call — don't let it vanish
**What they do:** Granola surfaces enhanced notes *after* the meeting ends — the
payoff moment is explicit and reliable. ([UX Planet](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17))
**Map to Gememo:** Your biggest UX hole here is already on the roadmap as
**RB-7e**: the in-page toast disappears the instant the Meet tab closes —
*exactly* when capture finishes — so the user often never sees the outcome.
Research strongly supports prioritizing the **OS notification on success/failure**
("✓ Notes saved to Obsidian"). This is the single highest-value polish item:
it's the difference between "did it work?" anxiety and Granola's reliable payoff.

### 3. Verifiable output builds trust ("invisible, but auditable")
**What they do:** Every AI-added line in Granola hyperlinks back to the exact
transcript moment it came from; outputs start "clear and verifiable" before
getting fancy. Trust is earned through auditability. ([UX Planet](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17), [intelligentinterfaces](https://intelligentinterfaces.substack.com/p/how-granola-enhances-note-taking))
**Map to Gememo:**
- In the **output note**, add a small provenance footer — e.g.
  *"Captured automatically by Gememo · {date} · source: Google Meet + Gemini"* —
  so the note is self-explaining when found later in Craft/Obsidian.
- Gememo already keeps the raw snapshot in the cache; a future option to attach
  or link it gives Granola-style "see the source." Feeds **RB-4b** (preview/edit).

### 4. Keep the human in control — offer a review beat
**What they do:** Granola augments *after* but never removes user agency; the
note is the user's, AI just enhances. ([UX Planet](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17))
**Map to Gememo:** This is **RB-4b** (optional "review for ~15s before sending"
with a Regenerate button) — research says this is what makes AI notes feel
trustworthy rather than fire-and-forget. Keep it *opt-in* so the default stays
zero-friction.

### 5. Frictionless onboarding + a first "magic moment"
**What they do:** Granola is praised for a near-zero learning curve and seamless
setup — no platform connections, no bot invites. ([zackproser](https://zackproser.com/blog/granola-vs-otter), [todayonmac](https://www.todayonmac.com/granola-the-ai-powered-notepad-thatll-make-you-actually-look-forward-to-meetings/))
**Map to Gememo:** Your install (hand-copy the extension ID into `install.sh`) is
the *opposite* — it's the highest-friction moment in the product. This is
**RB-7a** (first-run setup wizard + health check). Borrow Granola's "first magic
moment": end onboarding with a **guided test capture** that proves it works and
shows the user their first saved note. The green "Native host ready" dot is a
good start; make the whole first run a guided, self-verifying flow.

### 6. Empty states that teach, not blank panels
**What the field says (NN/g):** every empty state should (a) communicate status,
(b) explain *what* the area is for, (c) explain *how* to fill it, and (d) offer a
direct action button. Distinguish first-use vs filtered-empty vs loading.
([NN/g](https://www.nngroup.com/articles/empty-state-interface-design/))
**Map to Gememo:** Directly upgrades **UXC-21 / C7**:
- `.log-empty` is already good ("No activity yet. Notes will appear here…").
- `.rules-empty` → *"No custom rules yet. Add one to use a different prompt for
  specific meetings."* **+ [Add rule] button** in the empty state.
- `.search-empty` → confirm "no matches" (filtered-empty), don't reuse first-use copy.

### 7. Microcopy discipline (verb+object CTAs, what/why/how errors, one voice)
**What the field says:** CTAs = verb + object ("Download report", not "Next");
errors explain *what happened, why, and what to do*, in a gentle tone; pick one
voice — contractions or not, 1st vs 2nd person — and hold it everywhere.
([Justinmind](https://www.justinmind.com/ux-design/microcopy), [Smashing](https://www.smashingmagazine.com/2024/06/how-improve-microcopy-ux-writing-tips-non-ux-writers/), [Parallel](https://www.parallelhq.com/blog/ux-writing-best-practices))
**Map to Gememo:** This is the external backing for the copy items already
queued — **UXC-16** (terminology), **UXC-18** (button labels: imperative
verb+object), **UXC-19** (error templates: what/why/how, used in **UXC-3** to
replace raw `Error: ${err.message}`), **UXC-20** (hint style). Your README voice
(confident, plain, 2nd-person, lightly informal) is the brand voice to enforce.

### 8. Ruthless feature minimalism = perceived premium
**What they do:** Granola "cut out half the features" after beta to focus only on
what users loved — credited as a driver of retention and the premium, focused
feel. ([UX Planet](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17))
**Map to Gememo:** The popup has 5 tabs and many settings. Don't cut features, but
apply **progressive disclosure**: keep advanced settings (Craft IDs, webhooks,
file-type) collapsed by default behind the patterns you already have
(`.sub-options`, collapse chevrons). Make the default surface feel calm and
single-purpose. Reinforces **UXC-10** (one collapse/header pattern).

### 9. Templates per meeting type — you already have this; surface it
**What they do:** Granola ships customizable templates for different meeting
types as a headline polish feature. ([zackproser](https://zackproser.com/blog/granola-vs-otter))
**Map to Gememo:** You already have built-in Standup/1:1/Retro templates — but
they're read-only and buried in the Rules tab. This is a *validated* premium
pattern; give it more prominence (e.g. a one-line "Templates auto-apply by
meeting title" explainer, and make the built-ins feel like a feature, not a
footnote).

### 10. Microinteractions: consistent, intentional motion
**What the field says:** Premium feel comes from *consistent*, purposeful motion
with smooth (non-linear) easing and visible focus states; ad-hoc/linear motion
feels "mechanical and plain." ([UX Design Institute](https://www.uxdesigninstitute.com/blog/how-to-design-micro-interactions/), [OSU BUX](https://bux.osu.edu/blog/microinteractions/))
**Map to Gememo:** Backs **UXC-9** — the audit found transition durations are
ad-hoc (0.1 / 0.15 / 0.2 / 0.3s). Standardize one duration + one easing curve as
tokens (UXC-0), and add the missing `:focus-visible` rings.

### 11. Chrome-popup-specific best practices
**What the field says:** popups should be content-driven (avoid hard-fixed
heights that clip), keep all fonts/styles local (no CDN), provide visible focus
states, and handle loading/error explicitly; great extension UIs are "invisible."
([Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/ui), [Reintech](https://reintech.io/blog/building-user-interfaces-chrome-extensions))
**Map to Gememo:**
- Gememo hard-fixes `body { height: 580px; overflow: hidden }` with a hidden
  scrollbar — **review for content clipping** on the busiest panels (Settings,
  Logs); let content drive height up to a max, or confirm nothing is cut off.
- Fonts are already system-stack/local (good — keep it).
- Loading states: add explicit in-progress feedback for async actions
  (Capture now, Retry) — currently missing (audit **U8**); a spinner/disabled
  state during the round-trip.

---

## Part 2 — What Gememo does that the leaders charge for (lean into these)

These are existing Gememo strengths the research surfaced as premium
differentiators — worth foregrounding in copy/marketing/About, not building:

- **Bot-free / no announcement** — Granola's headline advantage; Gememo has it
  natively *and* without recording audio at all (it reads the existing Gemini
  transcript). Even stronger privacy story than Granola's system-audio capture.
- **No subscription / no API key / your own note app** — Otter & Granola are
  paid SaaS that lock notes in their cloud; Gememo pushes to Craft/Notes/Obsidian
  you already own. This is a real wedge — say it plainly in About + README.
- **Local, you-own-the-data** — privacy is now a purchase criterion
  ([itsconvo](https://www.itsconvo.com/blog/granola-vs-otter-vs-fathom)); your
  architecture is the trust story competitors can't match.

---

## Part 3 — Suggested new roadmap items (competitor-inspired, net-new)

Proposed `UXC-22…25` (or fold into existing items as noted):

| ID | Item | Borrowed from | Maps to / effort |
|----|------|---------------|------------------|
| UXC-22 | **Reliable post-capture confirmation** — prioritize the OS notification so the outcome survives the tab closing | Granola's reliable payoff moment | = **RB-7e**; ~1–2 h |
| UXC-23 | **Provenance footer in the output note** — "Captured by Gememo · {date} · Meet+Gemini" | Granola source-linking / verifiable output | `constants.js`, host; ~1 h |
| UXC-24 | **Guided first-run + test capture** ending in a visible first saved note | Granola zero-friction onboarding + magic moment | = **RB-7a**; ~4 h |
| UXC-25 | **Action-driven empty states** (Add-rule button in `.rules-empty`, filtered-empty search copy) | NN/g empty-state rules | extends **UXC-21**; ~1 h |

Plus reinforcement (no new work, just prioritization): **RB-4b** (review/edit
beat) and the copy items **UXC-16/18/19/20** are externally validated as
premium-defining — bump their priority.

---

## Sources
- Granola design teardown — [UX Planet: The Art of Invisible AI](https://uxplanet.org/the-art-of-invisible-ai-what-granolas-70-retention-teaches-us-about-product-design-2de5a2836d17)
- [Intelligent Interfaces: How Granola enhances note-taking](https://intelligentinterfaces.substack.com/p/how-granola-enhances-note-taking)
- [zackproser: Granola vs Otter.ai (hands-on)](https://zackproser.com/blog/granola-vs-otter)
- [aloa: Otter.ai vs Granola](https://aloa.co/ai/comparisons/ai-note-taker-comparison/otter-ai-vs-granola)
- [itsconvo: Granola vs Otter vs Fathom 2026](https://www.itsconvo.com/blog/granola-vs-otter-vs-fathom)
- [WonderTools: Granola guide](https://wondertools.substack.com/p/granolaguide) · [TodayOnMac](https://www.todayonmac.com/granola-the-ai-powered-notepad-thatll-make-you-actually-look-forward-to-meetings/) · [Granola Docs: Notifications](https://docs.granola.ai/help-center/taking-notes/notifications)
- Empty states — [NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)
- Microcopy — [Justinmind](https://www.justinmind.com/ux-design/microcopy) · [Smashing Magazine](https://www.smashingmagazine.com/2024/06/how-improve-microcopy-ux-writing-tips-non-ux-writers/) · [Parallel](https://www.parallelhq.com/blog/ux-writing-best-practices)
- Microinteractions / premium feel — [UX Design Institute](https://www.uxdesigninstitute.com/blog/how-to-design-micro-interactions/) · [OSU Buckeye UX](https://bux.osu.edu/blog/microinteractions/)
- Chrome extension UI — [Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/ui) · [Reintech](https://reintech.io/blog/building-user-interfaces-chrome-extensions)
