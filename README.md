[![CI](https://github.com/caasols/gememo/actions/workflows/ci.yml/badge.svg)](https://github.com/caasols/gememo/actions/workflows/ci.yml)
![Chrome](https://img.shields.io/badge/Chrome-MV3-black?logo=googlechrome&style=flat)
![macOS](https://img.shields.io/badge/macOS-only-black?logo=apple&style=flat)
![License](https://img.shields.io/badge/license-MIT-black?style=flat)

![No bot](https://img.shields.io/badge/✓%20no%20bot-black?style=flat)
![No audio](https://img.shields.io/badge/✓%20no%20audio-black?style=flat)
![No voiceprint](https://img.shields.io/badge/✓%20no%20voiceprint-black?style=flat)
![No lock-in](https://img.shields.io/badge/✓%20no%20lock--in-black?style=flat)

**No bot · no audio · no voiceprint · no cloud account · no lock-in.** The meeting's own AI summarizes; Gememo just files the result where you want it.

A Chrome extension that captures Google Meet notes automatically when you leave a call — using Google's own Gemini AI that's already running inside your meeting. No bot, no API key, no subscription.

Unlike Fireflies, Otter.ai, or Granola, Gememo doesn't send a bot into your call. It reads the Gemini transcript that's already in your browser, formats it, and saves it to your output app the moment you click Leave — silently, in the background, without stealing focus.

<!-- ![Gememo Screenshot](./metadata/gememo-1.png) -->

## Why bot-free & no lock-in

Most AI note-takers work by sending a bot into your call to record everyone, then processing that audio on their servers. That model has two problems Gememo is built to avoid:

**The bot records — and that's a consent problem.** A visible bot joins, captures audio from every participant, and ships it to a third party. In 2025–2026 that approach drew real legal fire: Otter.ai was hit with a federal class action alleging it recorded private conversations without all-party consent, with pre-meeting notifications turned **off by default** ([Brewer v. Otter.ai](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit), [analysis](https://natlawreview.com/article/ai-notetaking-tools-under-fire-lessons-otterai-class-action-complaint)). Fireflies.ai was sued under Illinois' biometric privacy law for generating **voiceprints** of participants — including someone who never had an account ([Cruz v. Fireflies.AI](https://www.ebglaw.com/insights/publications/ai-meeting-assistants-and-biometric-privacy-lessons-from-the-fireflies-ai-lawsuit)). Around **12 US states require all-party consent** to record a conversation.

Gememo sends **no bot**, records **no audio**, and generates **no voiceprint**. It reads the summary Google's own Gemini already produced inside your meeting — the meeting host's existing, in-product AI — and saves the *text*. Nothing new is recorded, and nothing leaves your machine except the note you choose to save where you choose to save it.

**Your notes shouldn't be trapped in someone's app.** Even the better bot-free tools keep your notes locked in. Granola, for instance, has no export function — users resort to copy-paste or reverse-engineering the desktop app to get their own notes into Obsidian ([teardown](https://meetingnotes.com/blog/granola-ai-teardown), [the reverse-engineering write-up](https://josephthacker.com/hacking/2025/05/08/reverse-engineering-granola-notes.html)), and the community had to build [unofficial sync plugins](https://github.com/dannymcc/Granola-to-Obsidian) to escape the lock-in.

Gememo writes **plain Markdown files you own** — with YAML frontmatter — straight into Craft, Apple Notes, your Obsidian vault, a local folder, or any webhook. No proprietary store, no API to reverse-engineer, no subscription to keep your own meeting notes readable.

> **In short:** no bot, no audio, no voiceprint, no cloud account, no lock-in. The meeting's own AI does the summarizing; Gememo just files the result where you want it.

## Installation

### Prerequisites

- **macOS** (native messaging host is macOS-only)
- **Google Chrome** or **Microsoft Edge** (Chromium) — `install.sh` registers the native host for whichever is installed
- **Google Workspace** account with Gemini in Google Meet enabled
- **Python 3.9+**
- One of: **Craft**, **Apple Notes**, **Obsidian**, or **Bear**

> **Note:** Craft and Apple Notes are the actively-tested output apps. **Obsidian and Bear are implemented but not yet verified against a live app** — please report any issues.

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/caasols/gememo.git
cd gememo

# 2. Load the extension in Chrome
#    chrome://extensions → Developer mode → Load unpacked → select extension/

# 3. Install the native messaging host (run once — needs the extension ID from step 2)
bash native_host/install.sh
```

> **Verify:** Open the extension popup — the Main tab should show a green dot with "Native host ready".

## Features

### Capture

- **Automatic** — when you click Leave, the extension captures the full Gemini summary of your meeting and saves it to your output app, silently in the background
- **Periodic snapshots** — captures the running Gemini summary every 8 minutes (configurable 3–30 min) so no content is lost if something goes wrong at leave time
- **Proactive capture** — if Gemini deactivates mid-meeting (e.g. someone leaves a 1:1), the extension captures immediately rather than waiting for Leave
- **"Capture now" button** — visible in the popup during meetings; triggers a snapshot immediately
- **Keyboard shortcut** — Cmd/Ctrl+Shift+Y triggers a capture without opening the popup (rebindable at `chrome://extensions/shortcuts`)
- **Retry on failure** — if the output app push fails, a Retry widget appears in the popup; the extension picks the freshest available content (2h cache → snapshot backup)
- **Crash recovery** — the formatted note is persisted in-flight; if a send is interrupted, the popup offers to recover and resend it
- **Review before saving** *(opt-in)* — show the captured notes for a quick review (with Discard / Save) when you leave a call
- **Selector self-test** — a Meet DOM change surfaces as a diagnostic instead of a silent failure; an optional remote selector-hotfix URL can patch it without a release

### Prompt & output

- **Default prompt** — structured sections: Attendees, Summary, Key Points, Decisions Made, Action Items, Next Steps, Open Questions. Fully customisable from the Rules tab
- **Built-in templates** — Standup, 1:1, and Retro formats auto-applied when the meeting title matches (e.g. `daily standup` → Blockers/Done/Next). Shown read-only in the Rules tab; your own rules always take precedence
- **Per-meeting rules** — match a meeting by **title regex** and/or a **time window** (days of week + hour range) to apply a different prompt, with an optional **summary depth** (Brief / Standard / Detailed) per rule
- **Recurring-meeting context** — for a repeating meeting, the previous session's summary and open action items are fed back into the prompt so notes build on each other
- **Note language** — write notes in any language while preserving proper nouns, product names, and technical acronyms in their original form
- **Glossary** — names, codenames, and acronyms you list are injected into the prompt with an instruction to spell them exactly
- **Per-rule title templates** — name notes with `{date} {time} {name} {type} {code}` placeholders per rule
- **Auto-tags** — Gemini emits 3–5 topic tags, promoted to YAML `tags:` for Dataview/Bear/Notion filtering
- **Wikilinks** *(opt-in)* — wrap attendee names in `[[double brackets]]` so each note links into your Obsidian/Craft graph
- **Action items → tasks** — send each captured action item to **Things / Todoist / OmniFocus**, and flag items assigned to you with a "N for you" badge
- **Private reflection** *(beta)* — optionally run a second Gemini pass with a private prompt and save it to a separate destination
- **Google Calendar enrichment** *(beta)* — connect a Google account once; each note's frontmatter gains the matching event's attendees, agenda, recurrence, and scheduled time (read-only; one-time setup in [`native_host/CALENDAR_SETUP.md`](native_host/CALENDAR_SETUP.md))
- **Output apps** — Craft and Apple Notes (tested), plus Obsidian and Bear (untested); pick a primary app and optionally **"Also send to"** others (multi-destination)
- **Webhooks** — POST every captured note as structured JSON to any URL (Zapier, n8n, Make, your own endpoint), plus a dedicated **Slack** option (title, summary, action-item count)
- **.ics export** — optionally write a calendar file next to each note, one all-day event per **Next Steps** line (no Calendar OAuth)

### Privacy

- **PII redaction** — optionally strip emails, phone numbers, and card-like numbers (plus your own keywords) from the note **before anything is written or sent** — file backup, output app, and webhook payloads alike
- **Capture blocklist** — list title regexes (e.g. `interview`, `1:1 with HR`) and matching meetings are never captured — no snapshots, no notes

### UX

- **Extension badge** — shows 'REC' (green) during active capture, '!' on error
- **Snapshot countdown** — "Next in: Xm Ys" and "First snapshot in: Xm Ys" in the popup
- **Action items** — extracted from each capture into a popup checklist with a "Copy as tasks" button (Markdown `- [ ]`)
- **Logs tab** — activity grouped by meeting with a capture-outcome dot per group, per-entry Retry, and a Diagnostics toggle that hides routine internal events by default
- **Search past meetings** — local full-text search across your backup notes (title, date, snippet) with date-range and attendee filters; no API, runs on your machine
- **Theme** — tri-state **System / Light / Dark** appearance control (defaults to System)
- **Logs** — grouped under **date sections** (Today / Yesterday / date), collapsed by default with your expand/collapse state remembered
- **First-run checklist** — a guided welcome card walks you through install, picking an output app, and your first capture
- **Run diagnostics** — one click produces a shareable report (host version, output app, permissions, platform)
- **Experimental features** — a Settings toggle reveals in-progress beta features
- **Accessible** — keyboard/screen-reader friendly tab roles, labels, and focus rings
- **About tab** — version, GitHub link, extension ID, a "Report an issue" link, a Ko-fi tip panel, and a "Your impact" panel (meetings attended, notes saved, words captured, time saved)

## Output apps

| App | How it works | Config |
|---|---|---|
| **Craft** | Creates a document via `craftdocs://createdocument` with inline markdown content | Optional folder ID in Settings |
| **Apple Notes** | Creates a note via `osascript` with HTML body (headings, bullets, paragraphs) | No config needed |
| **Obsidian** *(untested)* | Writes a YAML-frontmatted `.md` file directly to your vault folder | Select vault folder in Settings |
| **Bear** *(untested)* | Creates a note via `bear://x-callback-url/create` | No config needed |
| **Webhook** (any) | POSTs the note as structured JSON to a URL — runs alongside whichever app above is selected | Webhook URL in Settings |

Backup `.md` files (and Obsidian notes) include YAML frontmatter: `date`, `title`, `attendees`, `duration_min`, `meeting_code`, `meeting_type` (calendar vs ad-hoc), and `recording` — so they're searchable and usable in Obsidian Dataview, Bear, or Notion.

## Configuration

Open the extension popup → **Settings tab**:

| Setting | Description | Default |
|---|---|---|
| Output app | Where notes are saved | Craft |
| Also send to | Additional apps to send each note to | — |
| Craft folder ID / Space ID | Destination folder / Craft space (blank = defaults) | — |
| Obsidian vault | Path to your Obsidian vault | — |
| Snapshot interval | How often to capture mid-meeting | 8 min |
| Note language | Language for generated notes | Auto |
| Glossary | Terms to keep spelled exactly | — |
| Webhook URL / Slack | POST each note as JSON / to a Slack incoming webhook (blank = off) | — |
| Redact PII / keywords | Strip emails, phones, cards (+ keywords) before write/send | Off |
| Never capture (blocklist) | Title regexes whose meetings are never captured | — |
| File backup | Save a local `.md` copy of every note | Off |
| .ics for Next Steps | Write a calendar file next to each note | Off |
| Backup folder | Where backup files are written | `~/Downloads/meeting-notes` |

## Troubleshooting

1. **Leave button behaves normally — no capture** — extension didn't attach. Make sure it's enabled in `chrome://extensions` and reload the Meet tab.
2. **Red `!` badge** — click the icon; the Main tab shows the error. If it says "Native host not found", run `bash native_host/install.sh` with the correct extension ID.
3. **"Open the Gemini panel to enable capture"** — hover over the ✦ icon in the Meet toolbar and click "Start now". The extension will try again automatically.
4. **"Gemini may be disabled for your account"** — your Google Workspace admin may have blocked Gemini. Check with your admin.
5. **No note appeared** — check the Logs tab. If a push failed, the Retry widget shows in the Main tab. The backup file path is shown in the error entry so you can recover manually. To push a backup file manually: `python3 scripts/push_to_craft.py --title "TITLE" --content-file ~/Downloads/meeting-notes/YOUR-FILE.md --background`
6. **Note content contains `%` (percentages) and didn't reach Craft** — upgrade to v0.1.87+. Earlier versions silently failed when note content included `%` characters.
7. **Selectors broken after a Meet update** — run `npm test` to identify which selectors fail, then open an issue with the old and new values.
8. **Host version mismatch** — re-run `bash native_host/install.sh` to update the native host.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-new-feature`
3. Run the test suite: `npm run test:all` (the Apple Notes integration tests are opt-in — they launch the Notes app — and skip by default; run them deliberately with `GEMEMO_NOTES_INTEGRATION=1 python3 -m pytest native_host/test_apple_notes.py`)
4. Commit your changes: `git commit -am 'Add some feature'`
5. Push to the branch: `git push origin my-new-feature`
6. Submit a pull request

Please open a discussion first for larger changes so we can align on the approach.

**Maintainers** — cut a release with `scripts/release.sh` (reads the version from `manifest.json`, uses the matching `CHANGELOG.md` section as the notes, attaches a source zip, then tags and publishes via `gh`). Preview first with `scripts/release.sh --dry-run`.

## License

Released under the [MIT License](./LICENSE).
