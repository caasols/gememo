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
- **Per-meeting rules** — match a meeting title with a regex to use a completely different prompt (e.g. `standup` → Blockers/Done/Next format)
- **Note language** — write notes in any language while preserving proper nouns, product names, and technical acronyms in their original form
- **Output apps** — Craft, Apple Notes, and Obsidian are all supported; select in Settings

### UX

- **Extension badge** — shows 'REC' (green) during active capture, '!' on error
- **Snapshot countdown** — "Next in: Xm Ys" and "First snapshot in: Xm Ys" in the popup
- **Logs tab** — full activity log grouped by meeting; per-entry Retry button on errors
- **About tab** — version, GitHub link, extension ID copy button

## Output apps

| App | How it works | Config |
|---|---|---|
| **Craft** | Creates a document via `craftdocs://createdocument` with inline markdown content | Optional folder ID in Settings |
| **Apple Notes** | Creates a note via `osascript` with HTML body (headings, bullets, paragraphs) | No config needed |
| **Obsidian** | Writes a YAML-frontmatted `.md` file directly to your vault folder | Select vault folder in Settings |

## Configuration

Open the extension popup → **Settings tab**:

| Setting | Description | Default |
|---|---|---|
| Output app | Where notes are saved | Craft |
| Craft folder ID | Destination folder (leave blank for Unsorted) | — |
| Obsidian vault | Path to your Obsidian vault | — |
| Snapshot interval | How often to capture mid-meeting | 8 min |
| Note language | Language for generated notes | Auto |
| File backup | Save a local `.md` copy of every note | Off |
| Backup folder | Where backup files are written | `~/Downloads/meeting-notes` |

## Troubleshooting

1. **Leave button behaves normally — no capture** — extension didn't attach. Make sure it's enabled in `chrome://extensions` and reload the Meet tab.
2. **Red `!` badge** — click the icon; the Main tab shows the error. If it says "Native host not found", run `bash native_host/install.sh` with the correct extension ID.
3. **"Open the Gemini panel to enable capture"** — hover over the ✦ icon in the Meet toolbar and click "Start now". The extension will try again automatically.
4. **"Gemini may be disabled for your account"** — your Google Workspace admin may have blocked Gemini. Check with your admin.
5. **No note appeared** — check the Logs tab. If a push failed, the Retry widget shows in the Main tab. The backup file path is shown in the error entry so you can recover manually.
6. **Selectors broken after a Meet update** — run `npm test` to identify which selectors fail, then open an issue with the old and new values.
7. **Host version mismatch** — re-run `bash native_host/install.sh` to update the native host.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-new-feature`
3. Run the test suite: `npm run test:all`
4. Commit your changes: `git commit -am 'Add some feature'`
5. Push to the branch: `git push origin my-new-feature`
6. Submit a pull request

Please open a discussion first for larger changes so we can align on the approach. The [ROADMAP.md](ROADMAP.md) has a prioritised work queue if you're looking for where to start.

## License

Released under the [MIT License](./LICENSE).
