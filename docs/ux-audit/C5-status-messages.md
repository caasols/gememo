# C5 — Status, toast & notification messages

## Summary

Gememo uses three distinct message surfaces — the **popup status banner** (popup.js / constants.js), **in-page toast notifications** (content_meet.js `showStatus()`), and **background log entries** (background.js `appendLog()`) which are read back into the popup Logs tab. There are no OS-level `chrome.notifications` calls; "notification" in this codebase means log rows and badge icons.

Across ~40 distinct user-facing strings, the copy quality is high overall but has six meaningful consistency problems:

1. **Three different phrasings for "Gemini not active"** spread across all three surfaces.
2. **Ellipsis inconsistency**: in-progress states use `...` (ASCII) in toasts but `…` (Unicode) in the banner.
3. **Period on the idle banner only** — `"Not in a meeting."` is the only message with a trailing period; nothing else has one.
4. **"Craft" hard-coded in the close overlay** even though the user may have chosen Obsidian, Apple Notes, or Webhook.
5. **Two warning toasts differ by one word** for the same "hover to start Gemini" guidance (lines 918/930 vs 984).
6. **Raw technical strings surface in the banner** — `"Native host error: …"`, `"Host error: …"`, `"Error: …"` are prefixed labels from backend code, not user-friendly prose.

---

## Proposed standard (message templates per level)

| Level | Template | Rules |
|-------|----------|-------|
| **success** | `Saved to {App}` · `Notes snapshot saved` · `Retry sent to {App}` | Lead with outcome. No trailing period. Checkmark prefix (`✓`) only on toasts (scannable at a glance), not on banner/log. |
| **info / in-progress** | `Capturing notes…` · `Waiting for Gemini…` · `Sending to {App}…` | End with Unicode ellipsis `…`. Never end with ASCII `...`. |
| **warning** | `{What happened} — {what to do}` e.g. `Gemini not active — hover the ✦ button and click Start now` | Em dash separator. Sentence case. No trailing period. |
| **error** | `{What failed}: {plain-English detail}. {Recovery step if possible.}` e.g. `Could not save notes: connection lost. Your notes are backed up — click Retry.` | Avoid raw exception text. Always mention the backup / retry path when one exists. |

---

## Findings

| # | Location (file:line) | Current message | Issue | Severity | Recommendation |
|---|----------------------|-----------------|-------|----------|----------------|
| 1 | `constants.js:370` (popup banner) | `"Not in a meeting."` | Only message in the entire codebase with a trailing period. Inconsistent with all other strings. | Low | Remove the period → `"Not in a meeting"` |
| 2 | `constants.js:358` (popup banner) | `"Capturing notes…"` | Uses `…` (correct). But the inline storage-change handler at `popup.js:864` sets the same banner via a direct `textContent` write using a *different* literal: `'Capturing notes…'` — both are Unicode ellipsis here so this is OK, but see #3. | Low | No change needed; note the second write path exists. |
| 3 | `content_meet.js:759` (toast) | `"Waiting for Gemini..."` | ASCII `...` triple-dot. All banner messages use Unicode `…`. Visually similar but typographically inconsistent. | Low | Change to `"Waiting for Gemini…"` |
| 4 | `content_meet.js:1246` (toast) | `"Capturing notes..."` | ASCII `...`. Matches banner text but wrong character. | Low | Change to `"Capturing notes…"` |
| 5 | `content_meet.js:1172` (toast) | `"Saving notes to ${outputAppName(currentOutputApp)}..."` | ASCII `...`. | Low | Change to `"Saving notes to ${outputAppName(currentOutputApp)}…"` |
| 6 | `content_meet.js:1343` (toast) | `"Sending to ${outputAppName(currentOutputApp)}..."` | ASCII `...`. | Low | Change to `"Sending to ${outputAppName(currentOutputApp)}…"` |
| 7 | `content_meet.js:918` (toast) | `"Hover over the ✦ Gemini button → click \"Start now\" to enable notes"` | Contains `"the ✦ Gemini button"`. | Med | See #9. |
| 8 | `content_meet.js:930` (toast) | `"Hover over the ✦ Gemini button → click \"Start now\" to enable notes"` | Identical to #7 — same string repeated at two code paths (lines 918 and 930). Only one place needs fixing since it's the same message, but the code duplication means they could drift. | Med | Extract to a named constant `MSG_GEMINI_START_GUIDANCE`. |
| 9 | `content_meet.js:984` (toast) | `"Hover over ✦ Gemini button → click \"Start now\" to enable notes"` | Same intent as #7/#8 but missing the article `"the"` before `"✦ Gemini button"`. Three strings for the same event. | High | Unify all three to one constant: `"Hover over the ✦ Gemini button and click Start now to enable notes"`. Drop `→` arrow (informal instruction syntax). |
| 10 | `content_meet.js:681` (thrown error → toast/banner) | `"Gemini notes were not active in this meeting"` | First of three phrasings for "Gemini not active". Capitalised first word, no period. | High | See #11 and #12 — unify all three. |
| 11 | `content_meet.js:715–716` (thrown error → toast/banner) | `"Gemini notes was not active during this meeting. Start Gemini at the beginning of your next meeting to get a summary."` | Subject–verb disagreement: `"notes was"` should be `"notes were"`. Two sentences; second gives good guidance. Inconsistent with #10 (different tense, extra sentence). | High | Fix grammar; unify with #10 and #12. Proposed: `"Gemini notes were not active — start Gemini at the beginning of your next meeting"` (one sentence, actionable). |
| 12 | `content_meet.js:1378` (toast, warn) | `"Gemini notes were not active in this meeting"` | Same wording as #10 but at a different call site. Duplicated. | Med | Collapse into the same constant used for #10. |
| 13 | `content_meet.js:1157` (toast, warn) | `"Meeting ended — Gemini was not active, no notes saved"` | Different framing again: `"Gemini was not active"` (shorter, different subject) and extra clause `"no notes saved"`. This path fires when the proactive capture attempt fails after Gemini deactivation. | Med | Adopt unified phrasing: `"Gemini notes were not active — no notes saved for this meeting"`. |
| 14 | `content_meet.js:1539` (close overlay body) | `"Gemini notes are active. Save a summary to Craft before leaving?"` | Hard-codes `"Craft"` regardless of the configured output app (`currentOutputApp` is in scope). User who configured Obsidian sees wrong app name. | High | Replace `"Craft"` with `outputAppName(currentOutputApp)`. |
| 15 | `content_meet.js:1161` (toast, err) | `` `Capture failed: ${err.message}` `` | Surfaces raw JS exception message (`err.message`) directly to the user. Could be `"TypeError: Cannot read properties of undefined"` or other cryptic text. | High | Wrap unknown errors: `"Capture failed — please try again"`. Reserve the raw message for the log entry. |
| 16 | `content_meet.js:1366` (toast, err) | `` `Error: ${err}` `` | Same pattern — raw error surfaced. No guidance on what to do. | High | Same fix: user-friendly copy on toast; raw detail in log only. |
| 17 | `content_meet.js:1383` (toast, err) | `` `Error: ${err.message}` `` | Third instance of same pattern. | High | Same fix. |
| 18 | `background.js:423–425` (banner via `mm2c_last_status`) | `` `Native host error: ${err}` `` | Surfaces raw native-messaging error. `"Native host"` is an implementation detail invisible to users. | High | `"Could not save notes — native host unreachable. Your notes are backed up; click Retry."` |
| 19 | `background.js:459–461` (banner via `mm2c_last_status`) | `` `Host error: ${detail}${backup}` `` | `"Host error"` is jargon. The backup path is appended with ` — backup at /path/to/file`, which is filesystem noise for most users. | High | `"Notes not saved — {detail}. Backed up locally — click Retry to resend."` Keep backup path in log only. |
| 20 | `background.js:248–250` (banner via `mm2c_last_status`) | `` `Warning: ${msg.message}` `` | The prefix `"Warning: "` is redundant — the banner already uses a yellow class to communicate severity. Banner will read `"Warning: Meeting too short — Gemini was not active"`. | Med | Strip the `"Warning: "` prefix; let CSS class carry the severity. |
| 21 | `background.js:258–262` (banner via `mm2c_last_status`) | `` `Error: ${msg.error}` `` | Same redundant prefix as #20. Banner reads `"Error: Timed out waiting for Gemini response"`. | Med | Strip `"Error: "` prefix; let `cls:'err'` carry severity. Improve the underlying message (see #15–17). |
| 22 | `background.js:167` (log entry) | `"Duplicate send skipped — notes already sent for this meeting within the last 40 minutes"` | Functional log string, not user-facing. Good level of detail. No issue for users. | Low | — (informational only; consider shortening to `"Duplicate send skipped — already sent within 40 min"`) |
| 23 | `background.js:204` (log + banner) | `` `Retry succeeded — sent to Craft (from ${response.source || 'file'})` `` | Hard-codes `"Craft"` regardless of `backupType`. Also surfaces the internal `source` value (`'file'`). | Med | Dynamically use the `backupType` label as in `forwardToNativeHost`. Remove `(from ${source})` from user-visible log; move to debug level. |
| 24 | `content_meet.js:1290` (toast, warn) | `` `⚠️ Snapshot is ${ageMin} min old — recent discussion may be missing` `` | Emoji in warning text (`⚠️`). Every other warn toast uses the background color alone to signal severity. Inconsistent. | Low | Remove the `⚠️` emoji, or adopt it consistently across all warn toasts. |
| 25 | `popup.js:864` (banner, direct write) | `'Capturing notes…'` | This is a **second writer** for the banner — it bypasses `resolveBanner` and sets both `.textContent` and `.className` directly when a storage-change event fires. It will be overwritten on the next `loadAndApplyState` call, but in the brief window the two paths race. Architecturally inconsistent; the code comment says `resolveBanner` is the "single owner". | Med | Remove the direct write at `popup.js:860–865`; let `loadAndApplyState` (already triggered at line 867) own the update via `resolveBanner`. |
| 26 | `content_meet.js:1019` (toast, ok) | `"✓ Notes snapshot saved"` | The checkmark `✓` prefix is used only here and at `"✓ Saved to …"` toasts. Other ok toasts (none remaining) would need to follow the same pattern to make it systematic. | Low | Good — adopt `✓` prefix as the standard for all ok toasts (enforce for any future ones). |
| 27 | `popup.js:529` (retry button text) | `"Failed ✗"` | The `✗` suffix is a cross mark used only here. The log-retry button at line 887 also uses it. Visually ok; just ensure it's used consistently (not mixed with `×` elsewhere in the UI). | Low | — (consistent with log-retry at line 887; no change needed). |

---

### Cross-surface message alignment for the same event

| Event | Popup banner | In-page toast | Log entry |
|-------|-------------|---------------|-----------|
| Capture in progress | `"Capturing notes…"` (ok) | `"Capturing notes..."` (info) | none |
| Waiting for Gemini response | — | `"Waiting for Gemini..."` (info) | `"Waiting for Gemini to finish writing..."` |
| Success — saved | `"Saved to Craft: {title}"` (ok) | `"✓ Saved to {App}"` (ok) | `"Saved to Craft: {title}"` |
| Gemini not active | `"Warning: Gemini notes were not active in this meeting"` (warn) | `"Gemini notes were not active in this meeting"` (warn) | `"Proactive live capture: Gemini not active — meeting too short for notes"` |
| Host error | `"Native host error: {raw}"` (err) | `"Error: {raw}"` (err) | `"Native host error: {raw}"` |

Key gaps: (a) the in-progress toast uses ASCII `...` while the banner uses `…`; (b) success copies match each other well but the log hard-codes "Craft"; (c) error copies expose raw internals on all three surfaces simultaneously.
