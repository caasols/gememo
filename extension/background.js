// background.js — service worker
// Receives the Gemini transcript from content_meet.js and forwards it
// to the native messaging host if backup is enabled.

const NATIVE_HOST = 'io.gememo.host';

// ── Logging ────────────────────────────────────────────────────────────────
// Stores up to 50 log entries in chrome.storage.local under mm2c_logs.
// Each entry: { ts, status: 'ok'|'warn'|'err', title, message }
//
// Burst protection: rapid appendLog calls are buffered in pendingLogs and
// flushed as a single batched get→prepend all→set after 100 ms of quiet,
// preventing concurrent get→set pairs from overwriting each other.

let pendingLogs = []; // entries waiting to be written to storage
let flushTimer  = null; // debounce handle

function appendLog(status, title, message) {
  pendingLogs.push({ ts: Date.now(), status, title: title || '', message: message || '' });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLogs, 100);
}

function flushLogs() {
  const batch = pendingLogs.splice(0); // drain atomically before the async get
  if (!batch.length) return;
  chrome.storage.local.get(['mm2c_logs'], (data) => {
    const logs = Array.isArray(data.mm2c_logs) ? data.mm2c_logs : [];
    // batch is in call order (oldest at index 0); reverse so newest ends up at index 0
    logs.unshift(...batch.reverse());
    if (logs.length > 200) logs.splice(200);
    chrome.storage.local.set({ mm2c_logs: logs });
  });
}

const DEDUP_WINDOW_MS = 40 * 60 * 1000; // 40-minute same-meeting window

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'MM2C_CHOOSE_FOLDER':
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'choose_folder' }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { path: null, error: err } : { path: response?.path || null });
      });
      return true;

    case 'MM2C_CHECK_HOST':
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'ping' }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        const ok = !err && response?.status === 'ok';
        const hostVersion = response?.version || null;
        let versionMismatch = false;
        if (ok && hostVersion) {
          const extMajor  = chrome.runtime.getManifest().version.split('.')[0];
          const hostMajor = String(hostVersion).split('.')[0];
          versionMismatch = extMajor !== hostMajor;
        }
        if (versionMismatch) {
          const extVersion = chrome.runtime.getManifest().version;
          appendLog('warn', '', `Host version mismatch: extension v${extVersion}, host v${hostVersion}`);
        }
        sendResponse({ ok, error: err, home: response?.home || null, hostVersion, versionMismatch });
      });
      return true; // keep channel open for async response

    case 'MM2C_RESPONSE': {
      const title = msg.meetingTitle || '';
      const doForward = (sr) => {
        chrome.storage.local.get([
          'mm2c_output_app',
          'mm2c_craft_folder_id',
          'mm2c_obsidian_vault_path',
          'mm2c_file_backup_enabled', 'mm2c_file_backup_type', 'mm2c_file_backup_path',
        ], (data) => {
          forwardToNativeHost(msg.text, {
            backupType:          data.mm2c_output_app || 'craft',
            meetingTitle:        title,
            craftFolderId:       data.mm2c_craft_folder_id       || '',
            obsidianVaultPath:   data.mm2c_obsidian_vault_path   || '',
            attendees:           Array.isArray(msg.attendees) ? msg.attendees : [],
            durationMin:         msg.durationMin ?? null,
            fileBackupEnabled:   data.mm2c_file_backup_enabled === true,
            fileBackupType:      data.mm2c_file_backup_type      || 'markdown',
            fileBackupPath:      data.mm2c_file_backup_path      || '~/Downloads/meeting-notes',
          }, sr);
        });
      };
      if (!title) {
        // Empty title — skip dedup, forward directly
        doForward(sendResponse);
        return true;
      }
      chrome.storage.session.get(['mm2c_last_fingerprint'], (fpData) => {
        const stored = fpData.mm2c_last_fingerprint;
        const now = Date.now();
        if (stored && stored.title === title && (now - stored.sentAt) < DEDUP_WINDOW_MS) {
          appendLog('warn', title, 'Duplicate send skipped — notes already sent for this meeting within the last 40 minutes');
          sendResponse({ ok: true });
          return;
        }
        // Write record first, then forward — chained to avoid a narrow race
        // where a second rapid message passes the check before the write flushes.
        chrome.storage.session.set({ mm2c_last_fingerprint: { title, sentAt: now } }, () => {
          doForward(sendResponse);
        });
      });
      return true; // keep channel open for async response
    }

    case 'MM2C_RETRY': {
      const { title, backupPath } = msg;
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        type:       'retry',
        title:      title      || '',
        backupPath: backupPath || '',
      }, (response) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          appendLog('err', title, `Retry failed: ${err}`);
          sendResponse({ ok: false, error: err });
          return;
        }
        if (response?.status === 'ok') {
          chrome.storage.local.remove('mm2c_last_failed');
          chrome.storage.local.set({ mm2c_last_status: `Retry succeeded: ${response.title}` });
          appendLog('ok', title, `Retry succeeded — sent to Craft (from ${response.source || 'file'})`);
          chrome.action.setBadgeText({ text: 'OK' });
          chrome.action.setBadgeBackgroundColor({ color: '#137333' });
          setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
        } else {
          appendLog('err', title, `Retry failed: ${response?.error || 'unknown'}`);
        }
        sendResponse({ ok: response?.status === 'ok' });
      });
      return true; // async response
    }

    case 'MM2C_SNAPSHOT':
      chrome.storage.local.get([
        'mm2c_file_backup_enabled', 'mm2c_file_backup_type', 'mm2c_file_backup_path',
      ], (data) => {
        if (!data.mm2c_file_backup_enabled) return; // backup disabled — skip silently
        chrome.runtime.sendNativeMessage(NATIVE_HOST, {
          type:           'snapshot',
          transcript:     msg.text            || '',
          meetingTitle:   msg.meetingTitle     || '',
          timestamp:      msg.timestamp        || new Date().toISOString(),
          fileBackupType: data.mm2c_file_backup_type || 'markdown',
          fileBackupPath: data.mm2c_file_backup_path || '~/Downloads/meeting-notes',
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[MM2C] Snapshot backup failed:', chrome.runtime.lastError.message);
            return;
          }
          if (response?.status !== 'ok') {
            console.warn('[MM2C] Snapshot backup error:', response?.error);
          }
        });
      });
      break; // no return true — fire-and-forget, content script gets no reply

    case 'MM2C_LOG':
      appendLog('info', msg.meetingTitle || '', msg.message || '');
      break;

    case 'MM2C_WARNING':
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e37400' });
      chrome.storage.local.set({ mm2c_last_status: `Warning: ${msg.message}` });
      appendLog('warn', msg.meetingTitle || '', msg.message || '');
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
      break;

    case 'MM2C_ERROR':
      console.error('[MM2C] Error from content script:', msg.error);
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#c5221f' });
      chrome.storage.local.set({ mm2c_last_status: `Error: ${msg.error}` });
      appendLog('err', msg.meetingTitle || '', msg.error || '');
      break;

    // ── CDP hover + click ────────────────────────────────────────────────────
    // Used by autoActivateGemini to programmatically hover over the Gemini
    // toolbar button (revealing the "Start now" tray) and click elements at
    // absolute CSS-pixel coordinates in the tab's viewport.
    //
    // chrome.debugger produces isTrusted=true events via Chrome's OS-level
    // input pipeline, bypassing the isTrusted=false limitation of dispatchEvent.
    // Chrome shows a "DevTools" infobar while the debugger is attached.
    //
    // Flow:
    //   MM2C_CDP_HOVER        → attach debugger, send mouseMoved to button position
    //   MM2C_CDP_CLICK        → send mousePressed + mouseReleased, DETACH (final click)
    //   MM2C_CDP_CLICK_KEEP   → send mousePressed + mouseReleased, keep debugger attached
    //   MM2C_CDP_DETACH       → detach without clicking (cleanup on failure)
    //
    // Use MM2C_CDP_CLICK_KEEP when there are more CDP clicks to follow in the same
    // activation sequence (e.g. click "Start now" then click the panel toggle button).

    case 'MM2C_CDP_HOVER': {
      const tabId = _sender.tab.id;
      if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); break; }
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: msg.x, y: msg.y,
        }, () => {
          if (chrome.runtime.lastError) {
            chrome.debugger.detach({ tabId });
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true });
          }
        });
      });
      return true; // async
    }

    case 'MM2C_CDP_CLICK_KEEP':   // click without detaching (more clicks will follow)
    case 'MM2C_CDP_CLICK': {      // click and detach (final action in sequence)
      const tabId = _sender.tab.id;
      const keepAttached = msg.type === 'MM2C_CDP_CLICK_KEEP';
      if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); break; }
      chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: msg.x, y: msg.y, button: 'left', clickCount: 1 },
        () => {
          chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: msg.x, y: msg.y, button: 'left', clickCount: 1 },
            () => {
              if (keepAttached) { sendResponse({ ok: true }); }
              else { chrome.debugger.detach({ tabId }, () => sendResponse({ ok: true })); }
            }
          );
        }
      );
      return true; // async
    }

    case 'MM2C_CDP_DETACH': {
      const tabId = _sender.tab.id;
      if (tabId) chrome.debugger.detach({ tabId });
      sendResponse({ ok: true });
      break;
    }
  }
});

// Badge: show 'REC' (green) when a Gemini capture flow starts.
// 'OK' and '!' badges are handled inside the MM2C_RESPONSE / MM2C_ERROR handlers above.
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.mm2c_capture_state?.newValue === 'capturing') {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#137333' });
  }
});

// ── Tab monitoring ─────────────────────────────────────────────────────────
// Log whenever the user switches to a Google Meet tab — shows meeting and
// Gemini state so the Logs panel reflects what's happening in the browser.

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!tab.url?.includes('meet.google.com')) return;

    // Strip "Meet - " prefix to get just the meeting name for the log title
    const meetTitle = tab.title?.replace(/^Meet\s*[-–]\s*/i, '').trim() || 'Meet';

    chrome.tabs.sendMessage(activeInfo.tabId, { type: 'MM2C_STATUS_QUERY' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not injected yet (page still loading)
        appendLog('info', meetTitle, 'Switched to Meet tab — page loading');
        return;
      }
      if (response?.inMeeting) {
        const gemStr = response.geminiActive ? ', Gemini active' : ', Gemini not active';
        appendLog('info', meetTitle, `Switched to Meet tab — in meeting${gemStr}`);
      } else {
        appendLog('info', meetTitle, 'Switched to Meet tab — not in a meeting');
      }
    });
  });
});

function forwardToNativeHost(transcript, { backupType, meetingTitle, craftFolderId, obsidianVaultPath, attendees, durationMin, fileBackupEnabled, fileBackupType, fileBackupPath }, callback = null) {
  chrome.runtime.sendNativeMessage(
    NATIVE_HOST,
    { transcript, timestamp: new Date().toISOString(), backupType, meetingTitle, craftFolderId, obsidianVaultPath, attendees, durationMin, fileBackupEnabled, fileBackupType, fileBackupPath },
    (response) => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        console.error('[MM2C] Native messaging error:', err);
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#c5221f' });
        chrome.storage.local.set({ mm2c_last_status: `Native host error: ${err}` });
        appendLog('err', meetingTitle, `Native host error: ${err}`);
        if (callback) callback({ ok: false, error: err });
        return;
      }

      if (response?.status === 'ok') {
        const APP_LABELS = { craft: 'Craft', apple_notes: 'Apple Notes', none: 'None', obsidian: 'Obsidian' };
        const dest       = APP_LABELS[backupType] || backupType;
        const filePart  = fileBackupEnabled && response.file ? ` + ${response.file}` : '';
        const retryNote = response.retried ? ' (via snapshot retry)' : '';
        const label     = response.title
          ? `Saved to ${dest}: ${response.title}${filePart}${retryNote}`
          : `Saved to ${dest}.${filePart}${retryNote}`;
        chrome.action.setBadgeText({ text: 'OK' });
        chrome.action.setBadgeBackgroundColor({ color: '#137333' });
        chrome.storage.local.set({ mm2c_last_status: label });
        appendLog('ok', meetingTitle, label);
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
        if (callback) callback({ ok: true });
      } else {
        const detail = response?.error || 'unknown';
        const backup = response?.backupPath ? ` — backup at ${response.backupPath}` : '';
        const label  = `Host error: ${detail}${backup}`;
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#c5221f' });
        chrome.storage.local.set({ mm2c_last_status: label });
        appendLog('err', meetingTitle, label);
        // Store for retry widget — only when a backup path exists to retry from
        if (response?.backupPath) {
          chrome.storage.local.set({
            mm2c_last_failed: {
              title:      meetingTitle,
              backupPath: response.backupPath,
              failedAt:   Date.now(),
            },
          });
        }
        if (callback) callback({ ok: false, error: detail, backupPath: response?.backupPath || null });
      }
    }
  );
}
