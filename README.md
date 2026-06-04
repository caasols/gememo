[![CI](https://github.com/caasols/gememo/actions/workflows/ci.yml/badge.svg)](https://github.com/caasols/gememo/actions/workflows/ci.yml)
![Chrome](https://img.shields.io/badge/Chrome-MV3-black?logo=googlechrome&style=flat)
![macOS](https://img.shields.io/badge/macOS-only-black?logo=apple&style=flat)
![License](https://img.shields.io/badge/license-MIT-black?style=flat)

A Chrome extension that captures Google Meet notes automatically when you leave a call — using Google's own Gemini AI that's already running inside your meeting. No bot, no API key, no subscription.

Unlike Fireflies, Otter.ai, or Granola, Gememo doesn't send a bot into your call. It reads the Gemini transcript that's already in your browser, formats it, and saves it to your note app the moment you click Leave — silently, in the background, without stealing focus.

<!-- ![Gememo Screenshot](./metadata/gememo-1.png) -->

## Installation

### Prerequisites

- **macOS** (native messaging host is macOS-only)
- **Google Chrome**
- **Google Workspace** account with Gemini in Google Meet enabled
- **Python 3.9+**
- One of: **Craft**, **Apple Notes**, or **Obsidian**

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

- **Automatic** — when you click Leave, the extension captures the full Gemini summary of your meeting and saves it to your note app, silently in the background
- **Periodic snapshots** — captures the running Gemini summary every 8 minutes (configurable 3–30 min) so no content is lost if something goes wrong at leave time
- **Proactive capture** — if Gemini deactivates mid-meeting (e.g. someone leaves a 1:1), the extension captures immediately rather than waiting for Leave
- **"Capture now" button** — visible in the popup during meetings; triggers a snapshot immediately
- **Retry on failure** — if the note app push fails, a Retry widget appears in the popup; the extension picks the freshest available content (2h cache → snapshot backup)

### Prompt & output

- **Default prompt** — structured sections: Attendees, Summary, Key Points, Decisions Made, Action Items, Next Steps, Open Questions. Fully customisable from the Rules tab
- **Built-in templates** — Standup, 1:1, and Retro formats auto-applied when the meeting title matches (e.g. `daily standup` → Blockers/Done/Next). Shown read-only in the Rules tab; your own rules always take precedence
- **Per-meeting rules** — match a meeting title with a regex to use a completely different prompt
- **Recurring-meeting context** — for a repeating meeting, the previous session's summary and open action items are fed back into the prompt so notes build on each other
- **Note language** — write notes in any language while preserving proper nouns, product names, and technical acronyms in their original form
- **Output apps** — Craft, Apple Notes, and Obsidian are all supported; select in Settings
- **Generic webhook** — POST every captured note as structured JSON to any URL (Zapier, n8n, Make, or your own endpoint)

### UX

- **Extension badge** — shows 'REC' (green) during active capture, '!' on error
- **Snapshot countdown** — "Next in: Xm Ys" and "First snapshot in: Xm Ys" in the popup
- **Action items** — extracted from each capture into a popup checklist with a "Copy as tasks" button (Markdown `- [ ]`)
- **Logs tab** — activity grouped by meeting with a capture-outcome dot per group, per-entry Retry, and a Diagnostics toggle that hides routine internal events by default
- **Search past meetings** — local full-text search across your backup notes (title, date, snippet); no API, runs on your machine
- **About tab** — version, GitHub link, extension ID, and a "Your impact" panel (meetings attended, notes saved, words captured, time saved)

## Output apps

| App | How it works | Config |
|---|---|---|
| **Craft** | Creates a document via `craftdocs://createdocument` with inline markdown content | Optional folder ID in Settings |
| **Apple Notes** | Creates a note via `osascript` with HTML body (headings, bullets, paragraphs) | No config needed |
| **Obsidian** | Writes a YAML-frontmatted `.md` file directly to your vault folder | Select vault folder in Settings |
| **Webhook** (any) | POSTs the note as structured JSON to a URL — runs alongside whichever app above is selected | Webhook URL in Settings |

Backup `.md` files (and Obsidian notes) include YAML frontmatter: `date`, `title`, `attendees`, `duration_min`, `meeting_code`, `meeting_type` (calendar vs ad-hoc), and `recording` — so they're searchable and usable in Obsidian Dataview, Bear, or Notion.

## Configuration

Open the extension popup → **Settings tab**:

| Setting | Description | Default |
|---|---|---|
| Output app | Where notes are saved | Craft |
| Craft folder ID | Destination folder (leave blank for Unsorted) | — |
| Obsidian vault | Path to your Obsidian vault | — |
| Snapshot interval | How often to capture mid-meeting | 8 min |
| Note language | Language for generated notes | Auto |
| Webhook URL | POST each note as JSON to this URL (blank = off) | — |
| File backup | Save a local `.md` copy of every note | Off |
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
