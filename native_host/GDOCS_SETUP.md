# Google Docs output setup (5.7)

One-time, ~5 minutes. When enabled, Gememo also creates **one Google Doc per
captured meeting note**. This is a **beta** feature — enable *Experimental
features* in the popup to see it.

## This is a SEPARATE connection from Google Calendar

Google Docs output uses its **own** OAuth grant, scope, and token file
(`~/.config/gememo/token_docs.json`) — completely independent of the Calendar
beta (which uses `token.json`). Connecting Docs does **not** touch your Calendar
connection, and existing Calendar users are unaffected. You reuse the **same**
OAuth client (`~/.config/gememo/credentials.json`).

## Steps

1. If you already set up Calendar (see [`CALENDAR_SETUP.md`](CALENDAR_SETUP.md)),
   you already have `~/.config/gememo/credentials.json` and the venv — reuse them.
   Otherwise follow that doc's steps 1–6 first to create the OAuth client and
   download `credentials.json`.
2. In <https://console.cloud.google.com/>, for the same project:
   **APIs & Services → Library** → enable **Google Docs API**.
3. **APIs & Services → OAuth consent screen**: add the scope
   `https://www.googleapis.com/auth/documents` (alongside any Calendar scope you
   already added). This is a **write** scope — Gememo creates Docs in your Drive.
4. Re-run `bash native_host/install.sh` once if you installed Gememo before this
   release (the Docs API uses the same `googleapiclient` library, so no new
   dependency — but the venv must exist).
5. In the extension: **Settings → enable Experimental features → Google Docs
   output → Connect**. A browser window opens; approve access. Then flip the
   **Create a Google Doc per note** toggle on.

## Notes

- The toggle and the connection are independent: connecting grants access; the
  toggle decides whether a Doc is created on each capture.
- In **testing** mode the refresh token expires ~weekly — just click **Reconnect**.
- This scope lets Gememo **create** Google Docs. It is independent of the
  read-only Calendar scope; revoking one does not affect the other.
- If the Google libraries aren't installed (venv step failed), the widget shows
  *Not installed* and the feature stays off — core capture is unaffected.
- Beta off ⇒ Gememo never creates Docs (the host receives `googleDocsOutput:false`).
