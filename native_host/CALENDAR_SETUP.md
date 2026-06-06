# Google Calendar setup (5.3)

One-time, ~10 minutes. Gives Gememo **read-only** access to your Calendar so
captured notes can be enriched with the matching event's attendees, agenda,
recurrence, and scheduled time. This is a **beta** feature — enable
*Experimental features* in the popup to see it.

## Steps

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (or **Internal** if your Workspace allows it — Internal
     skips verification and token expiry).
   - App name "Gememo"; your email as support + developer contact.
   - **Scopes** → add `.../auth/calendar.readonly`.
   - **Test users** → add your own Google address.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Desktop app** → Create → **Download JSON**.
5. Save it as `~/.config/gememo/credentials.json`:
   ```bash
   mkdir -p ~/.config/gememo
   mv ~/Downloads/client_secret_*.json ~/.config/gememo/credentials.json
   ```
6. Re-run `bash native_host/install.sh` once if you installed Gememo before this
   release (it adds the Google libraries into a venv).
7. In the extension: **Settings → enable Experimental features → Google Calendar →
   Connect**. A browser window opens; approve access. The widget then shows
   *Connected as you@…*.

## Notes

- In **testing** mode the refresh token expires ~weekly — just click **Reconnect**.
  Submitting the app for **OAuth verification** (or using an **Internal** Workspace
  consent screen) removes that and lets other users connect.
- The scope is read-only; Gememo never writes to your calendar.
- **Google Docs output (5.7)** is a **separate** connect — it needs its own
  `https://www.googleapis.com/auth/documents` scope on the consent screen and
  stores its own token (`token_docs.json`), so it never touches this Calendar
  connection. Existing Calendar users are unaffected. See
  [`GDOCS_SETUP.md`](GDOCS_SETUP.md).
- If the Google libraries aren't installed (venv step failed), the widget shows
  *Not installed* and the feature stays off — core capture is unaffected.
