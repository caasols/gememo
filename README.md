[![CI](https://github.com/caasols/gememo/actions/workflows/ci.yml/badge.svg)](https://github.com/caasols/gememo/actions/workflows/ci.yml)
![Chrome](https://img.shields.io/badge/Chrome-MV3-black?logo=googlechrome&style=flat)
![macOS](https://img.shields.io/badge/macOS-only-black?logo=apple&style=flat)
![License](https://img.shields.io/badge/license-MIT-black?style=flat)

![No bot](https://img.shields.io/badge/✓%20no%20bot-black?style=flat)
![No audio](https://img.shields.io/badge/✓%20no%20audio-black?style=flat)
![No voiceprint](https://img.shields.io/badge/✓%20no%20voiceprint-black?style=flat)
![No lock-in](https://img.shields.io/badge/✓%20no%20lock--in-black?style=flat)

# Gememo

**No bot · no audio · no voiceprint · no cloud account · no lock-in.** The meeting's own AI summarizes; Gememo just files the result where you want it.

A Chrome extension that captures Google Meet notes automatically when you leave a call — using Google's own Gemini AI that's already running inside your meeting. No bot, no API key, no subscription.

Unlike Fireflies, Otter.ai, or Granola, Gememo doesn't send a bot into your call. It reads the Gemini summary that's already in your browser, formats it, and saves it to your note app the moment the call ends — silently, in the background, without stealing focus. Your notes land as **plain Markdown files you own**, in Craft, Apple Notes, your Obsidian vault, Bear, Google Docs, or a local folder.

## Why bot-free & no lock-in

Most AI note-takers work by sending a bot into your call to record everyone, then processing that audio on their servers. That model has two problems Gememo is built to avoid:

**The bot records — and that's a consent problem.** A visible bot joins, captures audio from every participant, and ships it to a third party. In 2025–2026 that approach drew real legal fire: Otter.ai was hit with a federal class action alleging it recorded private conversations without all-party consent, with pre-meeting notifications turned **off by default** ([Brewer v. Otter.ai](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit), [analysis](https://natlawreview.com/article/ai-notetaking-tools-under-fire-lessons-otterai-class-action-complaint)). Fireflies.ai was sued under Illinois' biometric privacy law for generating **voiceprints** of participants — including someone who never had an account ([Cruz v. Fireflies.AI](https://www.ebglaw.com/insights/publications/ai-meeting-assistants-and-biometric-privacy-lessons-from-the-fireflies-ai-lawsuit)). Around **12 US states require all-party consent** to record a conversation.

Gememo sends **no bot**, records **no audio**, and generates **no voiceprint**. It reads the summary Google's own Gemini already produced inside your meeting — the meeting's existing, in-product AI — and saves the *text*. Nothing new is recorded, and nothing leaves your machine except the note you choose to save where you choose to save it.

**Your notes shouldn't be trapped in someone's app.** Even the better bot-free tools keep your notes locked in. Granola, for instance, has no export function — users resort to copy-paste or reverse-engineering the desktop app to get their own notes into Obsidian ([teardown](https://meetingnotes.com/blog/granola-ai-teardown), [the reverse-engineering write-up](https://josephthacker.com/hacking/2025/05/08/reverse-engineering-granola-notes.html)), and the community had to build [unofficial sync plugins](https://github.com/dannymcc/Granola-to-Obsidian) to escape the lock-in.

Gememo writes **plain Markdown files you own** — with YAML frontmatter — straight into Craft, Apple Notes, your Obsidian vault, Bear, Google Docs, or a local folder. No proprietary store, no API to reverse-engineer, no subscription to keep your own meeting notes readable.

> **In short:** no bot, no audio, no voiceprint, no cloud account, no lock-in. The meeting's own AI does the summarizing; Gememo just files the result where you want it.

## How it works

```
  Google Meet  ──▶  Gemini summary    ──▶  Gememo reads the text  ──▶  Craft · Apple Notes · Obsidian
  (your call)       (already running        (no bot, no audio)          Bear · Google Docs · local .md
                     inside the call)                                   the moment you leave the call
```

A content script keeps Meet's built-in **Ask Gemini** panel active and snapshots its running summary every few minutes. When the call ends, Gememo picks the freshest summary and hands it to a small **macOS native host** that formats it (YAML frontmatter + clean Markdown) and files it to the app(s) you chose.

## Installation

### Prerequisites

- **macOS** (the native messaging host is macOS-only)
- **Google Chrome** or **Microsoft Edge** (Chromium) — `install.sh` registers the host for whichever is installed
- A **Google account with Gemini in Google Meet** enabled
- **Python 3.9+**
- At least one output: **Craft**, **Apple Notes**, **Obsidian**, **Bear**, **Google Docs**, or just a local folder

> **Tested outputs:** Craft, Apple Notes, and **Obsidian** are actively tested (Obsidian live-verified). **Bear is implemented but not yet verified against a live app** — please report issues. **Google Docs** is a one-click OAuth connect (see [Google Docs](#google-docs-optional)). *Obsidian tip: keep the vault **out of** iCloud "Desktop & Documents" sync — iCloud can reconcile away freshly-written notes.*

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

`install.sh` registers the host, sets up an isolated Python venv, and fetches the shared Google OAuth client so the Docs connect works out of the box.

> **Verify:** open the popup — the **Today** tab should show a green dot with "Native host ready". Then open Settings, pick a **Primary output**, and you're set.

## Features

### Capture

- **Automatic** — when the call ends, Gememo captures the full Gemini summary and files it to your output app(s), silently in the background.
- **Resilient leave detection** — the Leave-button interception is delegated at the document level, so it survives Meet re-rendering its toolbar mid-call.
- **Capture-on-meeting-end safety net** — if the call ends *without* a clean Leave click (the host ends it, a network drop, a missed click), Gememo still saves from the latest snapshot.
- **Periodic snapshots** — captures the running Gemini summary every 8 minutes (configurable 3–30) so nothing is lost if something goes wrong at leave time.
- **Proactive capture** — if Gemini deactivates mid-meeting (e.g. someone leaves a 1:1), Gememo captures immediately rather than waiting for Leave.
- **"Capture now"** button + keyboard shortcut (**Cmd/Ctrl+Shift+Y**, rebindable at `chrome://extensions/shortcuts`).
- **Retry & recovery** — a failed push surfaces a per-destination **Retry** card; an interrupted send is recoverable from the popup; and the **History** tab flags any meeting that ended without saving with a one-click **Save now** (see below).
- **Multi-meeting** — handles several Meet tabs at once.

### Prompt & output

- **Default prompt** — structured sections (Attendees, Summary, Key Points, Decisions Made, Action Items, Next Steps, Open Questions). It's the always-on fallback and is fully customisable in the **Rules** tab.
- **Built-in templates** — Standup, 1:1, and Retro starting points, **off by default**. Switch one on and it becomes a normal, editable rule (title regex → prompt) you can tweak, reorder, or delete.
- **Per-meeting rules** — match a meeting by **title regex** and/or a **time window**, with an optional **summary depth** (Brief / Standard / Detailed) per rule.
- **Recurring-meeting context** — for a repeating meeting, the previous session's summary and open action items are fed back into the prompt so notes build on each other.
- **Per-rule title templates** — name notes with `{date} {time} {name} {type} {code}` placeholders.
- **Auto-tags** — Gemini emits a few topic tags, promoted to YAML `tags:` for Dataview/Bear/Notion filtering.
- **Output apps** — pick a **Primary output** and add any number of **Additional destinations**, each with its own config (e.g. two Obsidian vaults, or a Craft folder + Apple Notes). Menus only show apps Gememo can detect; a connectable app (Google Docs) stays visible but greyed until connected.

### Backups

- **Local backup** — every note can also be written as a local `.md` (or `.txt`) with YAML frontmatter, into a folder you choose (default `~/Documents/gememo-meeting-notes`). On a fresh install this is **on** by default.
- **Auto-cleanup** — optionally prune old snapshots, old notes, and old activity-log entries after N days (default 7), so the folder and History don't grow forever.

### History & diagnostics

- **History tab** — activity grouped by meeting, each with a definitive **save-state dot**: 🟢 saved (all destinations) · 🟡 partial · 🔴 failed. A meeting that ended **without saving** shows **"Not saved" + a "Save now" button** (and a recovery card) that re-files it from its latest snapshot in one click.
- **Diagnostics** (Settings) — **Copy diagnostics report** puts version, host status, your settings and permissions on the clipboard for a bug report. A **Developer mode** toggle reveals the verbose internal log rows and a raw activity-log download (debug-only).

### UX

- **Theme** — tri-state **System / Light / Dark** (defaults to System).
- **First-run checklist** — a guided welcome card for install → pick an output → first capture.
- **Snapshot countdown** in the popup, and a nudge if snapshots pause (tab unfocused).
- **About tab** — version, GitHub link, extension ID, a "Report an issue" link, a Ko-fi tip panel, and a "Your impact" panel (meetings attended, notes saved, words captured, time saved).
- **Accessible** — keyboard/screen-reader-friendly tab roles, labels, and focus rings.

## Output apps

| App | How it works | Config |
|---|---|---|
| **Craft** | Creates a document via `craftdocs://` with inline Markdown content | Optional folder / space ID in Settings |
| **Apple Notes** | Creates a note via `osascript` with an HTML body (headings, bullets, paragraphs) | None |
| **Obsidian** | Writes a YAML-frontmatted `.md` straight into your vault (readable `YYYYMMDD HH:MM Title.md`). A blank vault path auto-detects your open vault from Obsidian's own config | Vault path optional; keep the vault **out of** iCloud Desktop & Documents sync |
| **Bear** *(untested)* | Creates a note via `bear://x-callback-url/create` | None |
| **Google Docs** | Creates a Google Doc via the Docs API after a one-click connect | [Connect once](#google-docs-optional) |

Backup `.md` files (and Obsidian notes) carry YAML frontmatter — `date`, `title`, `attendees`, `duration_min`, `meeting_code`, `meeting_type`, `recording`, `tags` — so they're searchable and usable in Obsidian Dataview, Bear, or Notion.

### Google Docs (optional)

Want notes filed as Google Docs? Open the popup → **Settings → Google Docs connection → Connect** (or use the onboarding Connect button), authorize the **Documents** scope once, and pick Google Docs as your primary output or an additional destination. The installer ships a shared OAuth client, so there's **no Google Cloud project to create** and no file to place.

> The consent screen is currently in Google's **Testing** mode (up to 100 test users) until the sensitive Docs scope is verified for a public launch. Disconnect anytime from the same row.

## Configuration

Open the popup → **Settings**:

| Setting | Description | Default |
|---|---|---|
| Appearance | System / Light / Dark theme | System |
| Snapshot frequency | How often to snapshot mid-meeting | 8 min |
| Primary output | Where notes are saved | None (pick on first run) |
| Additional destinations | Extra apps to also send each note to, each with its own config | — |
| Google Docs connection | Connect / disconnect a Google account for the Docs output | Not connected |
| File backup | Save a local `.md`/`.txt` copy of every note (type + folder) | On · `~/Documents/gememo-meeting-notes` |
| Privacy settings | Auto-delete old snapshots / notes / log entries after N days; **Clear** the History tab | Auto-delete on, 7 days |
| Diagnostics | Copy a diagnostics report; Developer mode (verbose logs + log download) | Developer mode off |

## Troubleshooting

1. **Leave button behaves normally — no capture** — the extension may not be attached. Make sure it's enabled in `chrome://extensions` and reload the Meet tab. (Captures are now resilient to mid-call toolbar re-renders.)
2. **A meeting ended but no note appeared** — open **History**. If it shows **"Not saved"**, click **Save now** to re-file it from its latest snapshot. If a push failed, a **Retry** card appears on Today.
3. **Red `!` badge** — click the icon; the Today tab shows the error. "Native host not found" → re-run `bash native_host/install.sh` with the correct extension ID.
4. **"Open the Gemini panel to enable capture"** — hover the ✦ icon in the Meet toolbar and click "Start now"; Gememo retries automatically.
5. **"Gemini may be disabled for your account"** — your Google Workspace admin may have blocked Gemini; check with them.
6. **Manually re-file a backup to Craft** — `python3 scripts/push_to_craft.py --title "TITLE" --content-file ~/Documents/gememo-meeting-notes/YOUR-FILE.md --background`
7. **Selectors broken after a Meet update** — run `npm test` to see which selectors fail, then open an issue with the old and new values.
8. **Host version mismatch** — re-run `bash native_host/install.sh` (the report under Settings → Diagnostics shows both versions).

## Contributing

1. Fork, then branch off `main`: `git checkout -b my-feature`
2. Run the suite green:
   ```bash
   python3 -m pytest native_host/ -q   # native-host unit tests
   npx playwright test                 # extension E2E + fake-Meet E2E + the in-popup unit suite
   ```
   The Apple Notes integration tests are opt-in (they launch the Notes app) and skip by default; run them deliberately with `GEMEMO_NOTES_INTEGRATION=1 python3 -m pytest native_host/test_apple_notes.py`.
3. Add a `## [Unreleased]` entry in `CHANGELOG.md` and bump `manifest.json` + `HOST_VERSION` together.
4. Open a pull request. Please open a discussion first for larger changes.

**Maintainers** — cut a release with `scripts/release.sh` (reads the version from `manifest.json`, uses the matching `CHANGELOG.md` section as the notes, attaches a source zip, then tags and publishes via `gh`). Preview with `scripts/release.sh --dry-run`.

## License

Released under the [MIT License](./LICENSE).
