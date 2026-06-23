// background.js — service worker
// Receives the Gemini transcript from content_meet.js and forwards it
// to the native messaging host if backup is enabled.

// Load the shared pure helpers (tabKey, addFailure, removeFailure,
// removeFailureByPath, countWords, updateStats, …) from the single source of
// truth. A classic MV3 service worker can importScripts, and constants.js is
// DOM-free — this replaces the hand-copied helpers that used to drift (ARCH-1).
importScripts('design_tokens.js', 'constants.js');

const NATIVE_HOST = 'io.gememo.host';

// First-run defaults — on a *fresh* install, seed sensible, safe defaults: a local
// file backup on (~/Documents/gememo-meeting-notes) and the three auto-cleanups on
// at 7 days. Gated to reason 'install' (an existing user updating is reason
// 'update' → untouched), and firstRunDefaults only fills keys that are still
// unset, so we never override a choice or retroactively enable auto-delete on an
// existing user's backups. The user can change any of these afterwards.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.storage.local.get(Object.keys(FIRST_RUN_DEFAULTS), (have) => {
    const seed = firstRunDefaults(have);
    if (Object.keys(seed).length) chrome.storage.local.set(seed);
  });
});

// ── Logging ────────────────────────────────────────────────────────────────
// Stores up to 50 log entries in chrome.storage.local under mm2c_logs.
// Each entry: { ts, status: 'ok'|'warn'|'err', title, message }
//
// Burst protection: rapid appendLog calls are buffered in pendingLogs and
// flushed as a single batched get→prepend all→set after 100 ms of quiet,
// preventing concurrent get→set pairs from overwriting each other.

let pendingLogs = []; // entries waiting to be written to storage
let flushTimer  = null; // debounce handle

function appendLog(status, title, message, level = 'user', link = null) {
  const entry = { ts: Date.now(), status, title: title || '', message: message || '', level };
  if (link) entry.link = link; // deep-link reference (e.g. saved Apple Notes note id)
  pendingLogs.push(entry);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLogs, 100);
}

function flushLogs() {
  const batch = pendingLogs.splice(0); // drain atomically before the async get
  if (!batch.length) return;
  chrome.storage.local.get(
    ['mm2c_logs', 'mm2c_logs_cleanup_enabled', 'mm2c_logs_cleanup_days'],
    (data) => {
      let logs = Array.isArray(data.mm2c_logs) ? data.mm2c_logs : [];
      // batch is in call order (oldest at index 0); reverse so newest ends up at index 0
      logs.unshift(...batch.reverse());
      // Optional age-based pruning (History auto-cleanup).
      if (data.mm2c_logs_cleanup_enabled === true) {
        logs = pruneOldLogs(logs, data.mm2c_logs_cleanup_days || 30);
      }
      if (logs.length > 200) logs.splice(200);
      chrome.storage.local.set({ mm2c_logs: logs });
    });
}

const DEDUP_WINDOW_MS = 40 * 60 * 1000; // 40-minute same-meeting window

// The storage keys both the capture and recover handlers read to build the
// forward payload (see buildForwardConfig). Defined once so they can't drift.
const FORWARD_KEYS = [
  'mm2c_output_app', 'mm2c_craft_folder_id', 'mm2c_craft_space_id', 'mm2c_obsidian_vault_path',
  'mm2c_file_backup_enabled', 'mm2c_file_backup_type', 'mm2c_file_backup_path',
  'mm2c_cleanup_snap_enabled', 'mm2c_cleanup_snap_days',
  'mm2c_cleanup_final_enabled', 'mm2c_cleanup_final_days',
  'mm2c_destinations', 'mm2c_also_send',
];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'MM2C_CHOOSE_FOLDER':
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'choose_folder' }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { path: null, error: err } : { path: response?.path || null });
      });
      return true;

    case 'MM2C_GCAL':
      // Generic per-app relay: forwards { type: msg.action } to the host. Used by
      // the Google Docs connect (gdocs_connect / gdocs_status / gdocs_disconnect).
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: msg.action }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { ok: false, error: err } : (response || {}));
      });
      return true; // async

    case 'MM2C_GOOGLE':
      // Relay a google_connect / google_status / google_disconnect message to the
      // host — the one-flow Google connect (Docs). Mirrors MM2C_GCAL.
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: msg.action }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { ok: false, error: err } : (response || {}));
      });
      return true; // async

    case 'MM2C_DESTINATION_STATUS':
      // Ask the host which output destinations can currently receive a note
      // (OUT-1). Reply mirrors the host: { status:'ok', destinations:{…} }. On any
      // host error we send { status:'error' } so the popup fails open (everything
      // stays enabled rather than getting greyed out on a transient hiccup).
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'destination_status' }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { status: 'error', error: err } : (response || { status: 'error' }));
      });
      return true; // async

    case 'MM2C_OPEN_NOTE':
      // Ask the host to re-open a saved note by id. Reply { ok, reason? } — a
      // not_found lets the popup drop the dead deep-link reference.
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'open_note', noteId: msg.noteId }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse(err ? { ok: false, error: err } : (response || { ok: false }));
      });
      return true; // async

    case 'MM2C_STAT_JOINED':
      // Count a meeting attended in the background (UX-8), once per meeting.
      chrome.storage.local.get(['mm2c_stats'], ({ mm2c_stats }) => {
        const s = { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0,
                    ...(mm2c_stats && typeof mm2c_stats === 'object' ? mm2c_stats : {}) };
        s.meetingsAttended += 1;
        chrome.storage.local.set({ mm2c_stats: s });
      });
      break;

    case 'MM2C_PRIOR_CONTEXT':
      chrome.storage.local.get(['mm2c_file_backup_path'], (data) => {
        chrome.runtime.sendNativeMessage(NATIVE_HOST, {
          type: 'prior_context',
          meetingTitle: msg.meetingTitle || '',
          fileBackupPath: data.mm2c_file_backup_path || '~/Documents/gememo-meeting-notes',
        }, (response) => {
          const err = chrome.runtime.lastError?.message || null;
          sendResponse(err ? { ok: false, context: '' } : { ok: true, context: response?.context || '' });
        });
      });
      return true; // async

    case 'MM2C_CHECK_HOST':
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'ping' }, (response) => {
        const err = chrome.runtime.lastError?.message || null;
        const ok = !err && response?.status === 'ok';
        const hostVersion = response?.version || null;
        let versionMismatch = false;
        if (ok && hostVersion) {
          versionMismatch = isVersionMismatch(chrome.runtime.getManifest().version, hostVersion);
        }
        if (versionMismatch) {
          const extVersion = chrome.runtime.getManifest().version;
          appendLog('warn', '', `Host version mismatch: extension v${extVersion}, host v${hostVersion}`, 'debug');
        }
        sendResponse({ ok, error: err, home: response?.home || null, hostVersion, versionMismatch });
      });
      return true; // keep channel open for async response

    case 'MM2C_RESPONSE': {
      const title = msg.meetingTitle || '';
      const tabId = _sender.tab?.id;
      const doForward = (sr) => {
        chrome.storage.local.get(FORWARD_KEYS, (data) => {
          forwardToNativeHost(msg.text, {
            ...buildForwardConfig(data),
            backupType:    data.mm2c_output_app || 'none',
            meetingTitle:  title,
            attendees:     Array.isArray(msg.attendees) ? msg.attendees : [],
            durationMin:   msg.durationMin ?? null,
            meetingCode:   msg.meetingCode || '',
            meetingType:   msg.meetingType || '',
            titleTemplate: msg.titleTemplate || '',
            recording:     msg.recording === true,
            tabId,
          }, sr);
        });
      };
      if (!title) {
        // Empty title — skip dedup, forward directly
        doForward(sendResponse);
        return true;
      }
      // Tab-keyed dedup: each tab gets its own fingerprint so two concurrent
      // meetings with the same title don't block each other.
      const fpKey = tabId ? tabKey('mm2c_last_fingerprint', tabId) : 'mm2c_last_fingerprint';
      chrome.storage.session.get([fpKey], (fpData) => {
        const stored = fpData[fpKey];
        const now = Date.now();
        if (shouldSkipDuplicate(stored, title, now, DEDUP_WINDOW_MS)) {
          appendLog('warn', title, 'Duplicate send skipped — notes already sent for this meeting within the last 40 minutes');
          sendResponse({ ok: true });
          return;
        }
        chrome.storage.session.set({ [fpKey]: { title, sentAt: now } }, () => {
          doForward(sendResponse);
        });
      });
      return true; // keep channel open for async response
    }

    case 'MM2C_RETRY': {
      const { title, backupPath, tabId } = msg;
      chrome.storage.local.get(['mm2c_output_app', 'mm2c_obsidian_vault_path', 'mm2c_craft_folder_id'], (cfg) => {
      const outApp = cfg.mm2c_output_app || 'craft';
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        type:       'retry',
        title:      title      || '',
        backupPath: backupPath || '',
        // BUG-11 B: route the retry to the user's PRIMARY output, not always Craft.
        backupType:        outApp,
        obsidianVaultPath: cfg.mm2c_obsidian_vault_path || '',
        craftFolderId:     cfg.mm2c_craft_folder_id || '',
      }, (response) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          appendLog('err', title, `Retry failed: ${err}`);
          sendResponse({ ok: false, error: err });
          return;
        }
        if (response?.status === 'ok') {
          // Remove this entry from mm2c_failed_list by backupPath — the only
          // identity both retry paths carry (the log-retry path has no tabId).
          // Before removing, fold the recovered note into the usage stats
          // (UX-8): the original send failed and never counted, so a successful
          // retry is when this meeting's note/words/minutes should be tallied.
          // We only count when a matching entry still exists, which keeps the
          // count idempotent — a second retry of the same path finds nothing.
          if (backupPath) {
            chrome.storage.local.get(['mm2c_failed_list', 'mm2c_stats'], ({ mm2c_failed_list, mm2c_stats }) => {
              const entry = findFailureByPath(mm2c_failed_list, backupPath);
              const next = { mm2c_failed_list: removeFailureByPath(mm2c_failed_list, backupPath) };
              if (entry) {
                next.mm2c_stats = updateStats(mm2c_stats, {
                  durationMin: entry.durationMin ?? null,
                  words: entry.words || 0,
                });
              }
              chrome.storage.local.set(next);
            });
          }
          const statusLabel = `Retry succeeded: ${response.title}`;
          if (tabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', tabId)]: statusLabel });
          else        chrome.storage.local.set({ mm2c_last_status: statusLabel });
          appendLog('ok', title, `Retry succeeded — sent to ${outputAppName(outApp)} (from ${response.source || 'file'})`);
          chrome.action.setBadgeText({ text: 'OK' });
          chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.success });
          setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
        } else {
          appendLog('err', title, `Retry failed: ${response?.error || 'unknown'}`);
        }
        sendResponse({ ok: response?.status === 'ok' });
      });
      }); // close chrome.storage.local.get for the retry config
      return true; // async response
    }

    case 'MM2C_RECOVER':
      // Re-send a note that was persisted in-flight but never confirmed (RB-1d).
      chrome.storage.local.get(['mm2c_inflight', ...FORWARD_KEYS], (data) => {
        const note = data.mm2c_inflight;
        if (!note?.text) { sendResponse({ ok: false, error: 'nothing to recover' }); return; }
        forwardToNativeHost(note.text, {
          ...buildForwardConfig(data),
          // BUG-11 #3: recovery fires only when the PRIMARY failed; the additional
          // destinations (best-effort) may already have succeeded, so re-pushing
          // them would duplicate (e.g. a 2nd Craft doc). Re-send the primary only.
          destinations: [],
          backupType:   data.mm2c_output_app || 'none',
          meetingTitle: note.title || '',
          attendees: [], durationMin: note.durationMin ?? null, meetingCode: '', meetingType: '', titleTemplate: '', recording: false,
          recover: true, // RB-1d — let the host pick the freshest copy
          timestamp: note.at ? new Date(note.at).toISOString() : new Date().toISOString(),
          tabId: null,
        }, (r) => {
          if (r?.ok) chrome.storage.local.remove('mm2c_inflight');
          sendResponse(r);
        });
      });
      return true; // async

    case 'MM2C_RECOVER_SNAPSHOT':
      // Leave-time fallback: Gemini wasn't capturable live, so ask the host to file
      // the latest on-disk snapshot for this meeting. Replies { ok } so the content
      // script shows "saved" or falls back to the "no notes saved" warning.
      chrome.storage.local.get(FORWARD_KEYS, (data) => {
        chrome.runtime.sendNativeMessage(NATIVE_HOST, {
          type: 'recover_snapshot',
          ...buildForwardConfig(data),
          backupType: data.mm2c_output_app || 'none',
          meetingTitle: msg.meetingTitle || '',
        }, (response) => {
          const err = chrome.runtime.lastError?.message || null;
          if (!err && response?.status === 'ok') {
            const dest  = outputAppName(data.mm2c_output_app || 'none');
            const label = `Recovered from the latest snapshot → ${dest}${response.title ? `: ${response.title}` : ''}`;
            chrome.storage.local.set({ mm2c_last_status: label });
            appendLog('ok', msg.meetingTitle || '', label, 'user', response.link || null);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, reason: response?.reason || err || 'error' });
          }
        });
      });
      return true; // async

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
          fileBackupPath: data.mm2c_file_backup_path || '~/Documents/gememo-meeting-notes',
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
      appendLog('info', msg.meetingTitle || '', msg.message || '', msg.level || 'user');
      break;

    case 'MM2C_WARNING':
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.warn });
      { const wTabId = _sender.tab?.id;
        const wStatus = `Warning: ${msg.message}`;
        if (wTabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', wTabId)]: wStatus });
        else         chrome.storage.local.set({ mm2c_last_status: wStatus }); }
      appendLog('warn', msg.meetingTitle || '', msg.message || '');
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
      break;

    case 'MM2C_SNAPSHOTS_PAUSED':
      // Periodic snapshots are paused (Meet tab hidden mid-meeting) — show an
      // amber ⏸ badge so the user knows their notes are going stale.
      chrome.action.setBadgeText({ text: '⏸' });
      chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.warn });
      break;

    case 'MM2C_SNAPSHOTS_RESUMED':
      // Tab returned / snapshot taken / meeting ended — clear the paused badge.
      chrome.action.setBadgeText({ text: '' });
      break;

    case 'MM2C_ERROR':
      console.error('[MM2C] Error from content script:', msg.error);
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.danger });
      { const eTabId = _sender.tab?.id;
        // Banner shows friendly copy (UXC-3); the 'Error:' prefix keeps
        // resolveBanner classifying it as an error. Raw text → the log below.
        const eStatus = `Error: ${friendlyError(msg.error)}`;
        if (eTabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', eTabId)]: eStatus });
        else         chrome.storage.local.set({ mm2c_last_status: eStatus }); }
      appendLog('err', msg.meetingTitle || '', msg.error || '');
      break;

    case 'MM2C_SET_CAPTURE_STATE': {
      const tabId = _sender.tab?.id;
      if (!tabId) break;
      const newState = msg.state || 'idle';
      chrome.storage.local.set({ [tabKey('mm2c_capture_state', tabId)]: newState }, () => {
        // Badge reflects whether ANY tab is capturing — tracked in a tiny array
        // (mm2c_capturing_tabs) instead of scanning all of storage (ARCH-4).
        chrome.storage.local.get(['mm2c_capturing_tabs'], ({ mm2c_capturing_tabs }) => {
          const tabs = newState === 'capturing'
            ? addCapturingTab(mm2c_capturing_tabs, tabId)
            : removeCapturingTab(mm2c_capturing_tabs, tabId);
          chrome.storage.local.set({ mm2c_capturing_tabs: tabs });
          if (tabs.length) {
            chrome.action.setBadgeText({ text: 'REC' });
            chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.success });
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
        });
      });
      break;
    }

    case 'MM2C_SET_SNAPSHOT': {
      const tabId = _sender.tab?.id;
      if (!tabId) break;
      const key = tabKey('mm2c_last_snapshot', tabId);
      if (msg.snapshot === null) {
        chrome.storage.local.remove(key);
      } else {
        chrome.storage.local.set({ [key]: msg.snapshot });
      }
      break;
    }
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
      if (chrome.runtime.lastError) return; // page still loading — not in a meeting, skip log
      if (response?.inMeeting) {
        const gemStr = response.geminiActive ? ', Gemini active' : ', Gemini not active';
        appendLog('info', meetTitle, `Switched to Meet tab — in meeting${gemStr}`, 'debug');
      }
      // Not in a meeting — nothing useful to log
    });
  });
});

// ── Tab cleanup ────────────────────────────────────────────────────────────
// When a Meet tab closes, remove all its tab-scoped storage keys and its
// entry from mm2c_failed_list. Prevents unbounded key accumulation.

// Keyboard shortcut → trigger a snapshot without opening the popup (RB-7d).
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-now') return;
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (!tabs.length) return;
    const target = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    chrome.tabs.sendMessage(target.id, { type: 'MM2C_CAPTURE_NOW' }, () => void chrome.runtime.lastError);
  });
});

// On install/update, inject the content script into any already-open Meet tabs
// that don't have one yet (e.g. Gememo was installed/enabled while a meeting was
// already open). Chrome cannot hot-replace a RUNNING content script — re-injecting
// over it throws on `const` redeclaration and double-binds listeners — so we PROBE
// for an existing script and skip those tabs (they need a manual reload to pick up
// new code). We never reload the tab, so a live call is never interrupted.
chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.scripting) return; // requires the "scripting" permission
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Probe the isolated world: constants.js declares extractLastResponseFromEl
        // (a global fn in any version); content_meet sets window.__mm2cLoaded.
        func: () => (typeof extractLastResponseFromEl !== 'undefined') || !!window.__mm2cLoaded,
      }).then((results) => {
        if (!shouldInjectContentScript(results)) return; // a script is already live — leave it
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['design_tokens.js', 'constants.js', 'content_meet.js'],
        });
      }).catch(() => { /* restricted/closed tab, or redeclaration on a stale tab — ignore */ });
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([
    tabKey('mm2c_capture_state', tabId),
    tabKey('mm2c_last_snapshot',  tabId),
    tabKey('mm2c_last_status',    tabId),
  ]);
  chrome.storage.session.remove(tabKey('mm2c_last_fingerprint', tabId));
  // Drop the closed tab from the REC-badge set; clear the badge if it was the last (ARCH-4).
  chrome.storage.local.get(['mm2c_capturing_tabs'], ({ mm2c_capturing_tabs }) => {
    if (!Array.isArray(mm2c_capturing_tabs) || !mm2c_capturing_tabs.includes(tabId)) return;
    const tabs = removeCapturingTab(mm2c_capturing_tabs, tabId);
    chrome.storage.local.set({ mm2c_capturing_tabs: tabs });
    if (!tabs.length) chrome.action.setBadgeText({ text: '' });
  });
  chrome.storage.local.get(['mm2c_failed_list'], ({ mm2c_failed_list }) => {
    if (!Array.isArray(mm2c_failed_list)) return;
    const updated = removeFailure(mm2c_failed_list, tabId);
    if (updated.length !== mm2c_failed_list.length) {
      chrome.storage.local.set({ mm2c_failed_list: updated });
    }
  });
});

function forwardToNativeHost(transcript, { backupType, meetingTitle, craftFolderId, craftSpaceId, obsidianVaultPath, attendees, durationMin, meetingCode, meetingType, titleTemplate, recording, fileBackupEnabled, fileBackupType, fileBackupPath, backupCleanup, destinations, recover, timestamp, tabId }, callback = null) {
  chrome.runtime.sendNativeMessage(
    NATIVE_HOST,
    { transcript, timestamp: timestamp || new Date().toISOString(), backupType, meetingTitle, craftFolderId, craftSpaceId, obsidianVaultPath, attendees, durationMin, meetingCode, meetingType, titleTemplate, recording, fileBackupEnabled, fileBackupType, fileBackupPath, backupCleanup, destinations, recover },
    (response) => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        console.error('[MM2C] Native messaging error:', err);
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.danger });
        const errStatus = `Error: ${friendlyError(err)}`;  // friendly banner (UXC-3)
        if (tabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', tabId)]: errStatus });
        else        chrome.storage.local.set({ mm2c_last_status: errStatus });
        appendLog('err', meetingTitle, `Native host error: ${err}`);  // raw in the log
        if (callback) callback({ ok: false, error: err });
        return;
      }

      const status = response?.status;
      // BUG-11 Fix C: the host now replies with per-destination saved/failed and a
      // status of 'ok' | 'partial' | 'error'. A 'partial' counts as a successful
      // capture ONLY when the PRIMARY succeeded (primaryOk) — recovery re-sends the
      // primary, so a secondary-only failure must NOT trigger the recovery path.
      const primaryOk = status === 'partial' ? response?.primaryOk === true : status === 'ok';

      if (status === 'ok' || (status === 'partial' && primaryOk)) {
        const dest = outputAppName(backupType);
        const filePart  = fileBackupEnabled && response.file ? ` + ${response.file}` : '';
        const retryNote = response.retried ? ' (via snapshot retry)' : '';
        const saved  = Array.isArray(response.saved)  ? response.saved  : [];
        const failed = Array.isArray(response.failed) ? response.failed : [];
        let label;
        if (status === 'partial') {
          // Primary saved, a secondary failed — warn but treat as saved.
          const savedPart = saved.length ? `Saved to ${saved.join(' · ')}` : `Saved to ${dest}`;
          label = `${savedPart} · ${failed.join(', ')} failed${filePart}${retryNote}`;
        } else {
          label = response.title
            ? `Saved to ${dest}: ${response.title}${filePart}${retryNote}`
            : `Saved to ${dest}.${filePart}${retryNote}`;
        }
        chrome.action.setBadgeText({ text: status === 'partial' ? '!' : 'OK' });
        chrome.action.setBadgeBackgroundColor({
          color: status === 'partial' ? TOKENS.color.warn : TOKENS.color.success });
        // Store the note so the popup can surface its action items (P6-B).
        chrome.storage.local.set({ mm2c_last_note: transcript || '' });
        // Update lifetime usage stats (UX-8) — the primary saved, so this counts.
        chrome.storage.local.get(['mm2c_stats'], ({ mm2c_stats }) => {
          chrome.storage.local.set({
            mm2c_stats: updateStats(mm2c_stats, { durationMin, words: countWords(transcript) }),
          });
        });
        if (tabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', tabId)]: label });
        else        chrome.storage.local.set({ mm2c_last_status: label });
        // Deep-link reference (e.g. Apple Notes note id) so History can re-open it.
        appendLog(status === 'partial' ? 'warn' : 'ok', meetingTitle, label, 'user', response.link || null);
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
        // ok:true → the content script clears the in-flight note (no recovery card),
        // because the PRIMARY succeeded.
        if (callback) callback({ ok: true });
      } else {
        const detail = response?.error || 'unknown';
        const backup = response?.backupPath ? ` — backup at ${response.backupPath}` : '';
        const rawLabel = `Host error: ${detail}${backup}`;     // log keeps "backup at" for the retry chip
        const banner   = `Error: ${friendlyError(detail)}`;    // friendly banner (UXC-3)
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: TOKENS.color.danger });
        if (tabId) chrome.storage.local.set({ [tabKey('mm2c_last_status', tabId)]: banner });
        else        chrome.storage.local.set({ mm2c_last_status: banner });
        appendLog('err', meetingTitle, rawLabel);
        // Store for retry widget — only when a backup path exists to retry from
        if (response?.backupPath) {
          chrome.storage.local.get(['mm2c_failed_list'], ({ mm2c_failed_list }) => {
            const updated = addFailure(
              removeFailure(mm2c_failed_list, tabId),
              // words + durationMin are stashed here so a later successful retry
              // can fold them into the usage stats (UX-8) — the failure path
              // skips updateStats, so a recovered note must be counted on retry.
              { tabId: tabId || null, title: meetingTitle, backupPath: response.backupPath,
                failedAt: Date.now(), words: countWords(transcript), durationMin: durationMin ?? null }
            );
            chrome.storage.local.set({ mm2c_failed_list: updated });
          });
        }
        if (callback) callback({ ok: false, error: detail, backupPath: response?.backupPath || null });
      }
    }
  );
}
