[![CI](https://github.com/caasols/gememo/actions/workflows/ci.yml/badge.svg)](https://github.com/caasols/gememo/actions/workflows/ci.yml)
![Chrome](https://img.shields.io/badge/Chrome-MV3-black?logo=googlechrome&style=flat)
![macOS](https://img.shields.io/badge/macOS-only-black?logo=apple&style=flat)
![License](https://img.shields.io/badge/license-MIT-black?style=flat)

![No bot](https://img.shields.io/badge/✓%20no%20bot-black?style=flat)
![No audio](https://img.shields.io/badge/✓%20no%20audio-black?style=flat)
![No voiceprint](https://img.shields.io/badge/✓%20no%20voiceprint-black?style=flat)
![No lock-in](https://img.shields.io/badge/✓%20no%20lock--in-black?style=flat)

# Gememo

### Bot-free Google Meet notes, filed to your apps the moment you leave the call.

Gememo uses Meet's own built-in **Ask Gemini** — the private, in-meeting AI assistant — to summarize your call, then saves the note as **plain Markdown you own** in Craft, Apple Notes, Obsidian, Bear, Google Docs, or a local folder. No bot, no audio, no API key, no subscription.

<p align="center">
  <!-- 🎬 DEMO GIF — drop the file at docs/media/gememo-demo.gif, then replace the <i> line below with:
       <img src="docs/media/gememo-demo.gif" alt="Gememo files your Google Meet note the moment you leave the call" width="720"> -->
  <i>🎬 &nbsp;Demo GIF coming soon — Gememo capturing a call and filing the note automatically.</i>
</p>

## ✨ What you get

- ⚡ **Zero-effort capture** — your note is filed the moment you leave the call. No "save" button, no focus stolen.
- 🛟 **Never lose a note** — periodic snapshots + a capture-on-meeting-end safety net; and any meeting that slips through is **one click to recover** from the History tab.
- 📝 **Your apps, your format** — Craft, Apple Notes, Obsidian, Bear, Google Docs, or local Markdown — to one app or several at once. Plain files you own, with YAML frontmatter.
- 🎯 **Notes that fit the meeting** — a structured default prompt plus per-meeting rules, summary depth, and recurring-meeting context — all editable.
- 🔒 **Private by design** — no bot joins, no audio is recorded, no voiceprint is made. It runs on your Mac; nothing leaves except the note you choose to save.

## Why bot-free & no lock-in

Most AI note-takers send a bot into your call to record everyone, then process that audio on their servers. That model has two problems Gememo is built to avoid:

**The bot records — and that's a consent problem.** A visible bot joins, captures audio from every participant, and ships it to a third party. In 2025–2026 that drew real legal fire: Otter.ai was hit with a federal class action alleging it recorded private conversations without all-party consent, with notifications **off by default** ([Brewer v. Otter.ai](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit)). Fireflies.ai was sued under Illinois' biometric privacy law for generating **voiceprints** of participants — including someone who never had an account ([Cruz v. Fireflies.AI](https://www.ebglaw.com/insights/publications/ai-meeting-assistants-and-biometric-privacy-lessons-from-the-fireflies-ai-lawsuit)). Around **12 US states require all-party consent** to record.

Gememo sends **no bot**, records **no audio**, and makes **no voiceprint**. It uses Meet's own **Ask Gemini** — the private, in-product assistant that records nothing, stores no captions, and is visible only to you — to summarize the call, then saves the *text*.

**Your notes shouldn't be trapped in someone's app.** Even the better bot-free tools lock notes in — Granola has no export, so users [reverse-engineer the desktop app](https://josephthacker.com/hacking/2025/05/08/reverse-engineering-granola-notes.html) and build [unofficial sync plugins](https://github.com/dannymcc/Granola-to-Obsidian) to get their own notes into Obsidian. Gememo writes **plain Markdown files you own** — no proprietary store, no API to reverse-engineer, no subscription to keep your own notes readable.

## How it works

```
  Google Meet  ──▶  Ask Gemini       ──▶  Gememo reads the text  ──▶  Craft · Apple Notes · Obsidian
  (your call)       summarizes the         (no bot, no audio)          Bear · Google Docs · local .md
                    call in-browser                                    the moment you leave the call
```

A content script keeps Meet's built-in **Ask Gemini** panel active and snapshots its running summary every few minutes. When the call ends, Gememo picks the freshest summary and hands it to a small **macOS native host** that formats it (YAML frontmatter + clean Markdown) and files it to the app(s) you chose.

## Install

```bash
git clone https://github.com/caasols/gememo.git && cd gememo
# Load it: chrome://extensions → Developer mode → Load unpacked → select extension/
bash native_host/install.sh    # run once — needs the extension ID from the step above
```

`install.sh` registers the native host, sets up an isolated Python venv, and fetches the shared Google OAuth client so the Docs connect works out of the box. **Verify:** open the popup — Today should show a green "Native host ready", then pick a Primary output in Settings.

<details>
<summary><b>Requirements</b></summary>

- **macOS** (the native messaging host is macOS-only)
- **Google Chrome** or **Microsoft Edge** (Chromium) — `install.sh` registers the host for whichever is installed
- A **Google Workspace plan with Ask Gemini in Meet** — Business Standard/Plus, Enterprise Standard/Plus, or an eligible Gemini add-on. The meeting **organizer's** plan is what unlocks it; free Gmail and Business Starter accounts don't have Ask Gemini.
- **Python 3.9+**
- At least one output: Craft, Apple Notes, Obsidian, Bear, Google Docs, or just a local folder

> **Tested outputs:** Craft, Apple Notes, Obsidian, and **Bear** all work (Obsidian live-verified). **Google Docs** is a one-click OAuth connect, currently **in development** (see [Output apps](#output-apps)). *Obsidian tip: keep the vault **out of** iCloud "Desktop & Documents" sync — iCloud can reconcile away freshly-written notes.*
</details>

## Output apps

| App | How it works | Config |
|---|---|---|
| **Craft** | Document via `craftdocs://` with inline Markdown | Optional folder / space ID |
| **Apple Notes** | Note via `osascript` with an HTML body | None |
| **Obsidian** | YAML-frontmatted `.md` straight into your vault (`YYYYMMDD HH:MM Title.md`); a blank vault auto-detects your open vault | Vault path optional; keep it out of iCloud Desktop & Documents sync |
| **Bear** | Note via `bear://x-callback-url/create` | None |
| **Google Docs** *(in development)* | A Google Doc via the Docs API after a one-click connect | [Connect once](#google-docs-in-development) |

Backup `.md` files (and Obsidian notes) carry YAML frontmatter — `date`, `title`, `attendees`, `duration_min`, `meeting_code`, `meeting_type`, `recording`, `tags` — usable in Obsidian Dataview, Bear, or Notion. Pick a **Primary output** and add any number of **Additional destinations**, each with its own config.

### Google Docs (in development)

Open the popup → **Settings → Google Docs connection → Connect**, authorize the **Documents** scope once, and pick Google Docs as your primary output or an additional destination. The installer ships a shared OAuth client, so there's **no Google Cloud project to create**.

> Still being finalized: the consent screen is in Google's **Testing** mode (up to 100 test users) until the sensitive Docs scope is verified, and the live OAuth + Doc-creation flow isn't fully maintainer-verified yet. Disconnect anytime from the same row.

## Features

<details>
<summary><b>Capture</b> — automatic, resilient, recoverable</summary>

- **Automatic** — when the call ends, Gememo captures the full summary and files it to your output app(s), silently in the background.
- **Resilient leave detection** — Leave-button interception is delegated at the document level, so it survives Meet re-rendering its toolbar mid-call.
- **Capture-on-meeting-end safety net** — if the call ends *without* a clean Leave click (host ends it, a network drop, a missed click), Gememo still saves from the latest snapshot.
- **Periodic snapshots** — captures the running summary every 8 minutes (configurable 3–30) so nothing is lost at leave time.
- **Proactive capture** — if Gemini deactivates mid-meeting (e.g. someone leaves a 1:1), Gememo captures immediately.
- **"Capture now"** button + keyboard shortcut (**Cmd/Ctrl+Shift+Y**, rebindable at `chrome://extensions/shortcuts`).
- **Retry & recovery** — a failed push surfaces a per-destination **Retry** card; an interrupted send is recoverable from the popup; and **History** flags any meeting that ended without saving with one-click **Save now**.
- **Multi-meeting** — handles several Meet tabs at once.
</details>

<details>
<summary><b>Prompt & output</b> — notes that fit each meeting</summary>

- **Default prompt** — structured sections (Attendees, Summary, Key Points, Decisions Made, Action Items, Next Steps, Open Questions). The always-on fallback, fully customisable in the **Rules** tab.
- **Built-in templates** — Standup, 1:1, Retro, **off by default**. Switch one on and it becomes a normal, editable rule (title regex → prompt).
- **Per-meeting rules** — match by **title regex** and/or a **time window**, with an optional **summary depth** (Brief / Standard / Detailed) per rule.
- **Recurring-meeting context** — the previous session's summary and open action items are fed back into the prompt so notes build on each other.
- **Per-rule title templates** — `{date} {time} {name} {type} {code}` placeholders.
- **Auto-tags** — Gemini emits a few topic tags, promoted to YAML `tags:`.
- **Output apps** — pick a Primary output and add any number of Additional destinations, each with its own config (e.g. two Obsidian vaults, or a Craft folder + Apple Notes). Menus only show apps Gememo can detect.
</details>

<details>
<summary><b>Backups · History · UX</b></summary>

- **Local backup** — every note can also be written as a local `.md`/`.txt` with YAML frontmatter, into a folder you choose (default `~/Documents/gememo-meeting-notes`). On a fresh install this is **on**.
- **Auto-cleanup** — optionally prune old snapshots, notes, and log entries after N days (default 7).
- **History tab** — activity grouped by meeting, each with a definitive **save-state dot**: 🟢 saved · 🟡 partial · 🔴 failed. A meeting that ended without saving shows **"Not saved" + Save now** to re-file it from its latest snapshot.
- **Diagnostics** (Settings) — **Copy diagnostics report** for bug reports; a **Developer mode** toggle reveals verbose log rows + a raw activity-log download.
- **Theme** — System / Light / Dark. **First-run checklist**, snapshot countdown, and an **About** tab (version, GitHub, ext id, report-issue, Ko-fi, "Your impact" stats). Keyboard/screen-reader accessible.
</details>

<details>
<summary><b>Settings reference</b></summary>

| Setting | Description | Default |
|---|---|---|
| Appearance | System / Light / Dark theme | System |
| Snapshot frequency | How often to snapshot mid-meeting | 8 min |
| Primary output | Where notes are saved | None (pick on first run) |
| Additional destinations | Extra apps to also send each note to | — |
| Google Docs connection | Connect / disconnect for the Docs output | Not connected |
| File backup | Local `.md`/`.txt` copy (type + folder) | On · `~/Documents/gememo-meeting-notes` |
| Privacy settings | Auto-delete old snapshots / notes / log entries; **Clear** History | On, 7 days |
| Diagnostics | Copy a diagnostics report; Developer mode | Developer mode off |
</details>

<details>
<summary><b>Troubleshooting</b></summary>

1. **Leave button works but no capture** — make sure the extension is enabled in `chrome://extensions` and reload the Meet tab.
2. **A meeting ended but no note appeared** — open **History**; if it shows **"Not saved"**, click **Save now**. If a push failed, a **Retry** card appears on Today.
3. **Red `!` badge** — click the icon; Today shows the error. "Native host not found" → re-run `bash native_host/install.sh` with the correct extension ID.
4. **"Open the Gemini panel to enable capture"** — hover the ✦ icon in the Meet toolbar and click "Start now"; Gememo retries automatically.
5. **"Gemini may be disabled for your account"** — your Workspace admin may have blocked Gemini.
6. **Manually re-file a backup to Craft** — `python3 scripts/push_to_craft.py --title "TITLE" --content-file ~/Documents/gememo-meeting-notes/YOUR-FILE.md --background`
7. **Host version mismatch** — re-run `bash native_host/install.sh` (Settings → Diagnostics shows both versions).
</details>

## Contributing

Branch off `main`, then run the suite green — `python3 -m pytest native_host/ -q` (host) and `npx playwright test` (extension E2E + fake-Meet E2E + the in-popup unit suite). Add a `## [Unreleased]` CHANGELOG entry and bump `manifest.json` + `HOST_VERSION` together. Open a PR (a discussion first for larger changes). The Apple Notes integration tests are opt-in: `GEMEMO_NOTES_INTEGRATION=1 python3 -m pytest native_host/test_apple_notes.py`.

**Maintainers** — cut a release with `scripts/release.sh` (preview with `--dry-run`).

## License

[MIT](./LICENSE).
