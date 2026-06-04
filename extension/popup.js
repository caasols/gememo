const DEFAULT_FILE_PATH = '~/Downloads/meeting-notes';

// Tab ID of the Meet tab currently displayed in the popup.
// null = no Meet tab active; set by queryMeetingState().
let activeMetTabId = null;

// Logs tab tier toggle — when false, level:'debug' entries are hidden (UX-6).
let showDebugLogs = false;

const GLOBAL_KEYS = [
  'mm2c_enabled', 'mm2c_prompt',
  'mm2c_output_app',
  'mm2c_craft_folder_id',
  'mm2c_craft_space_id',
  'mm2c_file_backup_enabled', 'mm2c_file_backup_type', 'mm2c_file_backup_path',
  'mm2c_logs',
  'mm2c_note_language',
  'mm2c_prompt_rules',
  'mm2c_snapshot_interval_min',
  'mm2c_obsidian_vault_path',
  'mm2c_failed_list',
  'mm2c_last_note',
  'mm2c_webhook_url',
  'mm2c_slack_webhook_url',
  'mm2c_stats',
  'mm2c_also_send',
  'mm2c_redact_pii', 'mm2c_redact_keywords',
  'mm2c_emit_ics',
  'mm2c_glossary',
];

function tabScopedKeys(tabId) {
  if (!tabId) return [];
  return [
    tabKey('mm2c_capture_state', tabId),
    tabKey('mm2c_last_snapshot',  tabId),
    tabKey('mm2c_last_status',    tabId),
  ];
}

// Given a list of open Meet tabs and the currently active tab, returns
// {tabId, needsPicker}. needsPicker is true when 2+ Meet tabs are open
// and none is focused — the popup should show a tab selector.
function resolveMeetTab(meetTabs, activeTab) {
  const isMeet = url => url?.startsWith('https://meet.google.com/');
  if (isMeet(activeTab?.url)) return { tabId: activeTab.id, needsPicker: false };
  if (!meetTabs.length) return { tabId: null, needsPicker: false };
  if (meetTabs.length === 1) return { tabId: meetTabs[0].id, needsPicker: false };
  const sorted = [...meetTabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return { tabId: sorted[0].id, needsPicker: true };
}

// Loads both global and tab-scoped storage keys, then calls applyState.
// `live` (optional) carries fresh { inMeeting, geminiActive } from a
// MM2C_STATUS_QUERY so applyState can own the banner without a second writer.
function loadAndApplyState(tabId, live = null) {
  const keys = [...GLOBAL_KEYS, ...tabScopedKeys(tabId)];
  chrome.storage.local.get(keys, s => applyState(s, tabId, live));
}

const $ = id => document.getElementById(id);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSnapshotAge(ts, now = Date.now()) {
  const diffMs  = Math.max(0, now - ts);
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) {
    return `${Math.floor(diffMs / 1000)}s ago`;
  }
  return `${diffMin} min ago`;
}

// Returns a "Xm Ys" string for the time remaining until nextAt (ms timestamp).
// Returns null when nextAt is 0 (no snapshot scheduled yet).
function formatCountdown(nextAt, now = Date.now()) {
  if (!nextAt) return null;
  const ms = nextAt - now;
  if (ms <= 0) return 'due now';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

// Shows/hides widget AND updates content. Only called from MM2C_STATUS_QUERY callback.
function renderSnapshotWidget(snap) {
  if (!snap) {
    $('snapshot-widget').classList.add('hidden');
    return;
  }
  $('snapshot-widget').classList.remove('hidden');
  $('snapshot-age').textContent = `Last snapshot: ${formatSnapshotAge(snap.ts)}`;
  $('snapshot-preview').textContent = snap.preview || '';
}

// Updates content ONLY if widget is already visible. Called from applyState and onChanged.
function updateSnapshotContent(snap) {
  if ($('snapshot-widget').classList.contains('hidden')) return;
  if (!snap) return;
  $('snapshot-age').textContent = `Last snapshot: ${formatSnapshotAge(snap.ts)}`;
  $('snapshot-preview').textContent = snap.preview || '';
}

function renderRules(rules) {
  const list = $('rules-list');
  list.innerHTML = '';
  if (!rules || rules.length === 0) {
    list.innerHTML = '<div class="rules-empty">No rules yet. Add one to use a custom prompt for specific meetings.</div>';
    return;
  }
  const DAYS = [[1, 'Mo'], [2, 'Tu'], [3, 'We'], [4, 'Th'], [5, 'Fr'], [6, 'Sa'], [7, 'Su']];
  rules.forEach((rule, i) => {
    const cond = (rule.condition && typeof rule.condition === 'object') ? rule.condition : {};
    const selDays = Array.isArray(cond.days) ? cond.days : [];
    const item = document.createElement('div');
    item.className = 'rule-item';
    item.dataset.index = i;
    item.innerHTML = `
      <div class="rule-header">
        <input class="rule-regex" type="text" placeholder="e.g. DAILY" value="${escapeHtml(rule.regex || '')}">
        <button class="btn-rule-action" data-action="up" data-index="${i}" title="Move up" aria-label="Move rule up">↑</button>
        <button class="btn-rule-action" data-action="down" data-index="${i}" title="Move down" aria-label="Move rule down">↓</button>
        <button class="btn-rule-action danger" data-action="delete" data-index="${i}" title="Delete" aria-label="Delete rule">✕</button>
      </div>
      <textarea class="rule-prompt" rows="3" placeholder="Prompt for this meeting type">${escapeHtml(rule.prompt || '')}</textarea>
      <div class="rule-condition">
        <span class="rule-cond-label">…or when:</span>
        <span class="rule-days">${DAYS.map(([n, lbl]) =>
          `<label title="${lbl}"><input type="checkbox" class="rule-day" data-day="${n}" ${selDays.includes(n) ? 'checked' : ''}>${lbl}</label>`).join('')}</span>
        <span class="rule-hours">
          <input type="number" class="rule-hour-start" min="0" max="23" placeholder="0" value="${Number.isInteger(cond.startHour) ? cond.startHour : ''}">–
          <input type="number" class="rule-hour-end" min="0" max="24" placeholder="24" value="${Number.isInteger(cond.endHour) ? cond.endHour : ''}">h
        </span>
        <select class="rule-depth" title="Summary depth">
          <option value="" ${!rule.depth ? 'selected' : ''}>Standard depth</option>
          <option value="brief" ${rule.depth === 'brief' ? 'selected' : ''}>Brief</option>
          <option value="detailed" ${rule.depth === 'detailed' ? 'selected' : ''}>Detailed</option>
        </select>
      </div>
    `;
    list.appendChild(item);
  });
}

// Read a full rule object (regex, prompt, optional time condition) from a
// rendered .rule-item element (P5-L2).
function readRuleFromItem(item) {
  const regex  = item.querySelector('.rule-regex').value.trim();
  const prompt = item.querySelector('.rule-prompt').value.trim();
  const days   = [...item.querySelectorAll('.rule-day:checked')].map(c => parseInt(c.dataset.day, 10));
  const sh = parseInt(item.querySelector('.rule-hour-start').value, 10);
  const eh = parseInt(item.querySelector('.rule-hour-end').value, 10);
  const condition = buildCondition(days, Number.isNaN(sh) ? NaN : sh, Number.isNaN(eh) ? NaN : eh);
  const depth = item.querySelector('.rule-depth')?.value || '';
  const rule = { regex, prompt };
  if (condition) rule.condition = condition;
  if (depth) rule.depth = depth;
  return rule;
}

// Render the lifetime usage-stats panel in the About tab (UX-8).
function renderStats(stats) {
  const grid = $('stats-grid');
  if (!grid) return;
  const s = { meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0,
              ...(stats && typeof stats === 'object' ? stats : {}) };
  const cells = [
    ['Meetings attended', formatStatNumber(s.meetingsAttended)],
    ['Notes saved',       formatStatNumber(s.notesSaved)],
    ['Words captured',    formatStatNumber(s.wordsCaptured)],
    ['Meeting time',      formatStatDuration(s.totalMeetingMinutes)],
  ];
  grid.innerHTML = cells.map(([label, val]) => `
    <div class="stat-cell">
      <div class="stat-value">${escapeHtml(val)}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>`).join('');

  const savingsEl = $('stats-savings');
  if (savingsEl) {
    const saved = computeTimeSavedMin(s);
    savingsEl.innerHTML = saved > 0
      ? `These notes saved you roughly <strong>${escapeHtml(formatStatDuration(saved))}</strong> of writing time. ` +
        `If Gememo helps you, please consider <a href="https://ko-fi.com/caasols" target="_blank" rel="noopener">supporting it ☕</a>.`
      : 'Capture your first meeting to start tracking your impact.';
  }
}

// Render the action-item checklist from the last captured note (P6-B).
function renderActionItems(noteBody) {
  const widget = $('action-items-widget');
  const list   = $('action-items-list');
  if (!widget || !list) return;
  const items = parseActionItems(noteBody || '');
  if (!items.length) {
    widget.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  widget.classList.remove('hidden');
  list.innerHTML = items.map(it => {
    const meta = [it.owner, it.deadline].filter(Boolean).join(' · ');
    return `
      <label class="action-item">
        <input type="checkbox">
        <span class="action-task">${escapeHtml(it.task)}${meta ? ` <span class="action-meta">${escapeHtml(meta)}</span>` : ''}</span>
      </label>`;
  }).join('');
}

// Render local note-search results (P9-E).
function renderSearchResults(results) {
  const c = $('search-results');
  if (!c) return;
  if (!Array.isArray(results) || !results.length) {
    c.innerHTML = '<div class="search-empty">No matching past meetings.</div>';
    return;
  }
  c.innerHTML = results.map(r => `
    <div class="search-result">
      <div class="search-result-head">
        <span class="search-title">${escapeHtml(r.title || 'Untitled meeting')}</span>
        <span class="search-date">${escapeHtml(r.date || '')}</span>
      </div>
      <div class="search-snippet">${escapeHtml(r.snippet || '')}</div>
    </div>`).join('');
}

// Read-only display of the non-deletable built-in prompt templates (P5-K).
function renderBuiltInRules() {
  const container = $('builtin-rules-list');
  if (!container || typeof BUILT_IN_RULES === 'undefined') return;
  container.innerHTML = BUILT_IN_RULES.map(rule => `
    <details class="builtin-rule">
      <summary>
        <span class="bi-name">${escapeHtml(rule.name)}</span>
        <span class="bi-regex">${escapeHtml(rule.regex)}</span>
      </summary>
      <div class="bi-prompt">${escapeHtml(rule.prompt)}</div>
    </details>`).join('');
}

function renderRetryList(list) {
  const container = $('retry-list');
  if (!container) return;
  if (!Array.isArray(list) || !list.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = list.map(entry => {
    const shortTitle = entry.title
      ? (entry.title.length > 45 ? entry.title.slice(0, 45) + '…' : entry.title)
      : 'Unknown meeting';
    return `
      <div class="retry-card">
        <div class="retry-card-header">
          <div>
            <div class="retry-card-title">${escapeHtml(shortTitle)}</div>
            <div class="retry-card-hint">Notes are safe. Click Retry to resend.</div>
          </div>
          <button class="btn retry-dismiss-btn"
            data-tabid="${entry.tabId ?? ''}"
            data-backup="${escapeHtml(entry.backupPath || '')}"
            title="Dismiss">×</button>
        </div>
        <div class="retry-card-actions">
          <button class="btn retry-btn"
            data-tabid="${entry.tabId ?? ''}"
            data-title="${escapeHtml(entry.title || '')}"
            data-backup="${escapeHtml(entry.backupPath || '')}">Retry →</button>
        </div>
      </div>`;
  }).join('');
}

function applyState(s, tabId, live = null) {
  // Tab-scoped live state — falls back to defaults when key absent
  const captureStateVal = tabId ? (s[tabKey('mm2c_capture_state', tabId)] || 'idle') : 'idle';
  const lastSnapshotVal = tabId ? (s[tabKey('mm2c_last_snapshot',  tabId)] || null)   : null;
  const lastStatusVal   = tabId ? (s[tabKey('mm2c_last_status',    tabId)] || '')      : '';
  const enabled = s.mm2c_enabled !== false;
  $('enabled').checked = enabled;
  document.body.classList.toggle('ext-disabled', !enabled);

  $('prompt').value = s.mm2c_prompt || DEFAULT_PROMPT;
  $('glossary').value = s.mm2c_glossary || '';

  // Output app selector — default to 'craft' for existing users
  const outputApp = s.mm2c_output_app || 'craft';
  $('output-app').value = outputApp;
  $('craft-sub-options').classList.toggle('hidden', outputApp !== 'craft');
  $('obsidian-sub-options').classList.toggle('hidden', outputApp !== 'obsidian');
  $('obsidian-vault-path').value = s.mm2c_obsidian_vault_path || '';

  $('craft-folder-id').value = s.mm2c_craft_folder_id || '';
  $('craft-space-id').value = s.mm2c_craft_space_id || '';
  $('webhook-url').value = s.mm2c_webhook_url || '';
  $('slack-webhook-url').value = s.mm2c_slack_webhook_url || '';
  $('redact-pii').checked = s.mm2c_redact_pii === true;
  $('redact-keywords').value = s.mm2c_redact_keywords || '';
  $('emit-ics').checked = s.mm2c_emit_ics === true;
  const alsoSend = Array.isArray(s.mm2c_also_send) ? s.mm2c_also_send : [];
  document.querySelectorAll('.also-send-opt').forEach(cb => { cb.checked = alsoSend.includes(cb.value); });

  const fileBackupOn = s.mm2c_file_backup_enabled === true;
  $('file-backup-enabled').checked = fileBackupOn;
  $('file-backup-sub').classList.toggle('hidden', !fileBackupOn);
  $('file-type').value = s.mm2c_file_backup_type || 'markdown';
  $('file-path').value = s.mm2c_file_backup_path || DEFAULT_FILE_PATH;

  // Single owner of the status banner — resolveBanner applies precedence
  // (capturing > in-meeting > last status > idle) so there is no second writer.
  const banner = resolveBanner({
    capturing:    captureStateVal === 'capturing',
    inMeeting:    !!(live && live.inMeeting),
    geminiActive: !!(live && live.geminiActive),
    lastStatus:   lastStatusVal,
  });
  $('status').textContent = banner.text;
  $('status-banner').className = 'status-banner' + (banner.cls ? ' ' + banner.cls : '');

  // Update snapshot preview content (visibility is controlled by MM2C_STATUS_QUERY callback)
  updateSnapshotContent(lastSnapshotVal);

  // Render note language selection
  const lang = s.mm2c_note_language || '';
  const PRESETS = ['', 'English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian', 'Dutch'];
  if (PRESETS.includes(lang)) {
    $('note-language').value = lang;
    $('note-language-custom-row').classList.add('hidden');
  } else {
    $('note-language').value = '__custom__';
    $('note-language-custom').value = lang;
    $('note-language-custom-row').classList.remove('hidden');
  }

  renderRules(s.mm2c_prompt_rules || []);
  $('snapshot-interval').value = s.mm2c_snapshot_interval_min || 8;

  // Keep capture-now button in sync with capture + live meeting state
  const capturing = captureStateVal === 'capturing';
  const captureBtn = $('capture-now-btn');
  if (captureBtn) {
    if (capturing) {
      captureBtn.disabled    = true;
      captureBtn.textContent = 'Capturing notes…';
    } else if (live && live.inMeeting) {
      captureBtn.disabled    = !live.geminiActive;
      captureBtn.textContent = live.geminiActive ? 'Capture now' : 'Open Gemini to capture';
    } else {
      captureBtn.disabled    = false;
      captureBtn.textContent = 'Capture now';
    }
  }

  renderLogs(s.mm2c_logs);

  renderRetryList(Array.isArray(s.mm2c_failed_list) ? s.mm2c_failed_list : []);
  renderActionItems(s.mm2c_last_note);
  renderStats(s.mm2c_stats);
}

function setHostStatus(ok, error, hostVersion, versionMismatch) {
  const dot      = $('host-dot');
  const label    = $('host-label');
  const setupBtn = $('setup-btn');
  const panel    = $('setup-panel');

  if (ok && versionMismatch) {
    dot.className = 'host-dot warn';
    const extVersion = chrome.runtime.getManifest().version;
    label.textContent = `Version mismatch — click Set up to reinstall (host v${hostVersion}, extension v${extVersion})`;
    setupBtn.classList.remove('hidden');
    panel.classList.add('hidden');
  } else if (ok) {
    dot.className = 'host-dot ok';
    label.textContent = hostVersion ? `Native host ready (v${hostVersion})` : 'Native host ready';
    setupBtn.classList.add('hidden');
    panel.classList.add('hidden');
  } else {
    dot.className = 'host-dot err';
    label.textContent = error || 'Native host not found — click Set up to install';
    setupBtn.classList.remove('hidden');
    // Pre-fill the install command with the actual extension ID
    const extId = chrome.runtime.id;
    $('install-cmd').textContent = `bash "$(mdfind -name install.sh | grep gememo | head -1)" ${extId}`;
  }
}

function save(patch) {
  chrome.storage.local.set(patch);
}

// ── Logs ───────────────────────────────────────────────────────────────────

function groupLogs(logs) {
  const groups = [];
  for (const entry of logs) {
    // Skip entries with no meeting title — system/extension events that are
    // not relevant to the user. These will be reconsidered in a future redesign
    // of the logging architecture (see ROADMAP UX-6 · System log rethink).
    if (!entry.title) continue;
    const last = groups[groups.length - 1];
    if (last && last.title === entry.title) {
      last.entries.push(entry);
    } else {
      groups.push({ title: entry.title, entries: [entry] });
    }
  }
  return groups;
}

function formatLogTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${date} ${time}`;
}

function renderLogs(logs) {
  const list = $('log-list');
  const countEl = $('logs-count');

  logs = filterLogsByLevel(logs, showDebugLogs); // two-tier: hide debug by default (UX-6)

  if (!Array.isArray(logs) || logs.length === 0) {
    list.innerHTML = '<div class="log-empty">No activity yet. Notes will appear here after your meetings.</div>';
    countEl.textContent = '';
    return;
  }

  const groups = groupLogs(logs);
  countEl.textContent = `${groups.length} meeting${groups.length === 1 ? '' : 's'} · ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`;

  list.innerHTML = groups.map((group, i) => {
    const groupClass = i === 0 ? 'log-group expanded' : 'log-group';
    const groupTitle = group.title || 'System';
    const outcome = groupOutcome(group.entries);
    const groupDate = formatLogTime(group.entries[0].ts);
    const entryCount = group.entries.length;
    const meta = `${groupDate} · ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`;

    const entriesHtml = group.entries.map(entry => {
      const dotClass = entry.status === 'ok' ? 'ok' : entry.status === 'warn' ? 'warn' : entry.status === 'err' ? 'err' : 'info';
      const time = formatLogTime(entry.ts);
      const message = entry.message || '';
      const backupMatch = entry.status === 'err' ? message.match(/backup at (.+)$/) : null;
      const retryChip = backupMatch
        ? `<button class="btn log-retry-btn" data-title="${escapeHtml(entry.title || group.title || '')}" data-backup="${escapeHtml(backupMatch[1])}">Retry</button>`
        : '';
      return `
        <div class="log-entry">
          <span class="log-dot ${dotClass}"></span>
          <div class="log-content">
            <div class="log-header">
              <span class="log-time">${escapeHtml(time)}</span>
              ${retryChip}
            </div>
            <div class="log-message">${escapeHtml(message)}</div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="${groupClass}">
        <div class="log-group-header">
          <span class="log-group-chevron">▶</span>
          <span class="log-dot ${outcome}" title="Capture outcome"></span>
          <span class="log-group-title">${escapeHtml(groupTitle)}</span>
          <span class="log-group-meta">${escapeHtml(meta)}</span>
        </div>
        <div class="log-group-entries">${entriesHtml}</div>
      </div>`;
  }).join('');
}

// ── Tabs ───────────────────────────────────────────────────────────────────

const TABS = ['main', 'rules', 'settings', 'logs', 'about'];

function switchTab(tabName) {
  TABS.forEach(t => {
    const isActive = t === tabName;
    $(`tab-${t}`).classList.toggle('active', isActive);
    $(`tab-${t}`).setAttribute('aria-selected', isActive ? 'true' : 'false');
    $(`${t}-panel`).classList.toggle('hidden', !isActive);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadAndApplyState(activeMetTabId);
  renderBuiltInRules();

  // About tab — populate from Chrome runtime
  $('about-version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('about-ext-id').textContent  = chrome.runtime.id;
  // Prefill the "Report an issue" link with version + extension ID (RB-1c).
  $('report-issue').href = buildIssueUrl({
    title: '[bug] ',
    body: `Version: ${chrome.runtime.getManifest().version}\nExtension ID: ${chrome.runtime.id}\n\nWhat happened:\n\nSteps to reproduce:\n`,
  });

  $('copy-ext-id').addEventListener('click', () => {
    navigator.clipboard.writeText(chrome.runtime.id).then(() => {
      const btn = $('copy-ext-id');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  $('retry-list').addEventListener('click', (e) => {
    const retryBtn   = e.target.closest('.retry-btn');
    const dismissBtn = e.target.closest('.retry-dismiss-btn');

    if (retryBtn) {
      retryBtn.textContent = 'Retrying…';
      retryBtn.disabled = true;
      const tabId = retryBtn.dataset.tabid ? parseInt(retryBtn.dataset.tabid, 10) : null;
      chrome.runtime.sendMessage({
        type:       'MM2C_RETRY',
        title:      retryBtn.dataset.title,
        backupPath: retryBtn.dataset.backup,
        tabId,
      }, (response) => {
        if (response?.ok) {
          chrome.storage.local.get(['mm2c_failed_list'], ({ mm2c_failed_list }) => {
            renderRetryList(Array.isArray(mm2c_failed_list) ? mm2c_failed_list : []);
          });
        } else {
          retryBtn.textContent = 'Failed ✗';
          retryBtn.disabled = false;
        }
      });
    }

    if (dismissBtn) {
      const backupPath = dismissBtn.dataset.backup || '';
      chrome.storage.local.get(['mm2c_failed_list'], ({ mm2c_failed_list }) => {
        const updated = removeFailureByPath(mm2c_failed_list, backupPath);
        chrome.storage.local.set({ mm2c_failed_list: updated }, () => renderRetryList(updated));
      });
    }
  });

  // Query the active Meet tab for live meeting state — also called every 10 s to auto-refresh.
  function queryMeetingState() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (meetTabs) => {
        const { tabId, needsPicker } = resolveMeetTab(meetTabs, activeTab);
        activeMetTabId = tabId;

        // Show/hide meeting picker
        const picker = $('meeting-picker');
        const select = $('meeting-tab-select');
        if (picker && select) {
          if (needsPicker && meetTabs.length >= 2) {
            picker.classList.remove('hidden');
            select.innerHTML = meetTabs.map(tab => {
              const title = (tab.title || '').replace(/^Meet\s*[-–]\s*/i, '').trim() || 'Google Meet';
              return `<option value="${tab.id}" ${tab.id === tabId ? 'selected' : ''}>${escapeHtml(title)}</option>`;
            }).join('');
            select.onchange = () => {
              activeMetTabId = parseInt(select.value, 10);
              onTabSelected(activeMetTabId);
            };
          } else {
            picker.classList.add('hidden');
          }
        }

        if (!tabId) {
          $('capture-footer').classList.add('hidden');
          $('capture-footer-spacer').classList.add('hidden');
          $('snapshot-widget').classList.add('hidden');
          loadAndApplyState(null);
          return;
        }

        onTabSelected(tabId);
      });
    });
  }

  function onTabSelected(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'MM2C_STATUS_QUERY' }, (response) => {
      if (chrome.runtime.lastError) {
        $('capture-footer').classList.add('hidden');
        $('capture-footer-spacer').classList.add('hidden');
        $('snapshot-widget').classList.add('hidden');
        loadAndApplyState(tabId);
        return;
      }
      const inMeeting    = !!response?.inMeeting;
      const geminiActive = !!response?.geminiActive;
      $('capture-footer').classList.toggle('hidden', !inMeeting);
      $('capture-footer-spacer').classList.toggle('hidden', !inMeeting);
      if (!inMeeting) {
        $('snapshot-widget').classList.add('hidden');
        loadAndApplyState(tabId, { inMeeting: false, geminiActive });
        return;
      }
      // Show snapshot widget if snapshot exists
      chrome.storage.local.get([tabKey('mm2c_last_snapshot', tabId)], (data) => {
        const snap = data[tabKey('mm2c_last_snapshot', tabId)] || null;
        renderSnapshotWidget(snap);
        const nextEl = $('snapshot-next');
        if (nextEl) {
          const countdown = formatCountdown(response.nextSnapshotAt || 0);
          const firstEta  = formatCountdown(response.firstSnapshotAt || 0);
          if (countdown) {
            nextEl.textContent = `Next in: ${countdown}`;
            nextEl.classList.remove('hidden');
          } else if (firstEta) {
            nextEl.textContent = `First snapshot in: ${firstEta}`;
            nextEl.classList.remove('hidden');
          } else {
            nextEl.classList.add('hidden');
          }
        }
      });
      // Banner + capture button are owned solely by applyState (via resolveBanner),
      // fed the fresh live state — no second writer here (BUG-C).
      loadAndApplyState(tabId, { inMeeting: true, geminiActive });
    });
  }
  queryMeetingState();
  const refreshTimer = setInterval(queryMeetingState, 10_000);
  window.addEventListener('unload', () => clearInterval(refreshTimer));

  chrome.runtime.sendMessage({ type: 'MM2C_CHECK_HOST' }, (response) => {
    setHostStatus(response?.ok === true, response?.error, response?.hostVersion, response?.versionMismatch);
    if (response?.home) {
      // If the user hasn't saved a custom path yet, resolve ~ to the real home dir
      chrome.storage.local.get(['mm2c_file_backup_path'], (data) => {
        if (!data.mm2c_file_backup_path) {
          const fullDefault = `${response.home}/Downloads/meeting-notes`;
          $('file-path').value = fullDefault;
        }
      });
    }
  });

  // Tab switching
  TABS.forEach(t => $(`tab-${t}`).addEventListener('click', () => switchTab(t)));

  // Setup panel toggle
  $('setup-btn').addEventListener('click', () => {
    $('setup-panel').classList.toggle('hidden');
  });

  $('copy-cmd').addEventListener('click', () => {
    const cmd = $('install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      const btn = $('copy-cmd');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  $('enabled').addEventListener('change', e => {
    document.body.classList.toggle('ext-disabled', !e.target.checked);
    save({ mm2c_enabled: e.target.checked });
  });

  $('prompt-toggle').addEventListener('click', () => {
    const body   = $('prompt-body');
    const btn    = $('prompt-toggle');
    const hidden = body.classList.toggle('hidden');
    btn.classList.toggle('open', !hidden);
  });

  $('rules-toggle').addEventListener('click', () => {
    const body = $('rules-body');
    const btn  = $('rules-toggle');
    const hidden = body.classList.toggle('hidden');
    btn.classList.toggle('open', !hidden);
  });

  $('add-rule-btn').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_prompt_rules'], ({ mm2c_prompt_rules }) => {
      const rules = Array.isArray(mm2c_prompt_rules) ? mm2c_prompt_rules : [];
      rules.push({ regex: '', prompt: '' });
      save({ mm2c_prompt_rules: rules });
      renderRules(rules);
    });
  });

  $('rules-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx    = parseInt(btn.dataset.index, 10);
    const action = btn.dataset.action;
    chrome.storage.local.get(['mm2c_prompt_rules'], ({ mm2c_prompt_rules }) => {
      const rules = Array.isArray(mm2c_prompt_rules) ? [...mm2c_prompt_rules] : [];
      if (action === 'delete') {
        rules.splice(idx, 1);
      } else if (action === 'up' && idx > 0) {
        [rules[idx - 1], rules[idx]] = [rules[idx], rules[idx - 1]];
      } else if (action === 'down' && idx < rules.length - 1) {
        [rules[idx], rules[idx + 1]] = [rules[idx + 1], rules[idx]];
      }
      save({ mm2c_prompt_rules: rules });
      renderRules(rules);
    });
  });

  function saveRuleFromEvent(e) {
    const item = e.target.closest('.rule-item');
    if (!item) return;
    const idx = parseInt(item.dataset.index, 10);
    chrome.storage.local.get(['mm2c_prompt_rules'], ({ mm2c_prompt_rules }) => {
      const rules = Array.isArray(mm2c_prompt_rules) ? [...mm2c_prompt_rules] : [];
      if (!rules[idx]) return;
      rules[idx] = readRuleFromItem(item);
      save({ mm2c_prompt_rules: rules });
    });
  }
  $('rules-list').addEventListener('blur', saveRuleFromEvent, true);
  // Day checkboxes + depth select fire 'change', not 'blur' — capture those too.
  $('rules-list').addEventListener('change', (e) => {
    if (e.target.classList.contains('rule-day') || e.target.classList.contains('rule-depth')) saveRuleFromEvent(e);
  });

  $('prompt').addEventListener('change', e => {
    save({ mm2c_prompt: e.target.value.trim() || DEFAULT_PROMPT });
  });

  $('glossary').addEventListener('change', e => {
    save({ mm2c_glossary: e.target.value.trim() });
  });

  $('output-app').addEventListener('change', e => {
    const app = e.target.value;
    $('craft-sub-options').classList.toggle('hidden', app !== 'craft');
    $('obsidian-sub-options').classList.toggle('hidden', app !== 'obsidian');
    save({ mm2c_output_app: app });
  });

  $('craft-folder-id').addEventListener('change', e => {
    save({ mm2c_craft_folder_id: e.target.value.trim() });
  });

  $('craft-space-id').addEventListener('change', e => {
    save({ mm2c_craft_space_id: e.target.value.trim() });
  });

  $('webhook-url').addEventListener('change', e => {
    save({ mm2c_webhook_url: e.target.value.trim() });
  });

  $('slack-webhook-url').addEventListener('change', e => {
    save({ mm2c_slack_webhook_url: e.target.value.trim() });
  });

  $('redact-pii').addEventListener('change', e => {
    save({ mm2c_redact_pii: e.target.checked });
  });
  $('redact-keywords').addEventListener('change', e => {
    save({ mm2c_redact_keywords: e.target.value.trim() });
  });
  $('emit-ics').addEventListener('change', e => {
    save({ mm2c_emit_ics: e.target.checked });
  });

  document.querySelectorAll('.also-send-opt').forEach(cb => {
    cb.addEventListener('change', () => {
      const selected = [...document.querySelectorAll('.also-send-opt:checked')].map(c => c.value);
      save({ mm2c_also_send: selected });
    });
  });

  $('reset-prompt').addEventListener('click', () => {
    $('prompt').value = DEFAULT_PROMPT;
    save({ mm2c_prompt: DEFAULT_PROMPT });
  });

  $('file-backup-enabled').addEventListener('change', e => {
    $('file-backup-sub').classList.toggle('hidden', !e.target.checked);
    save({ mm2c_file_backup_enabled: e.target.checked });
  });

  $('file-type').addEventListener('change', e => {
    save({ mm2c_file_backup_type: e.target.value });
  });

  $('note-language').addEventListener('change', e => {
    const val = e.target.value;
    if (val === '__custom__') {
      $('note-language-custom-row').classList.remove('hidden');
    } else {
      $('note-language-custom-row').classList.add('hidden');
      save({ mm2c_note_language: val });
    }
  });

  $('note-language-custom').addEventListener('change', e => {
    const val = e.target.value.trim();
    if (val) save({ mm2c_note_language: val });
  });

  $('snapshot-interval').addEventListener('change', e => {
    const raw = parseInt(e.target.value, 10);
    const clamped = Math.max(3, Math.min(30, isNaN(raw) ? 8 : raw));
    e.target.value = clamped;
    save({ mm2c_snapshot_interval_min: clamped });
  });

  $('obsidian-vault-path').addEventListener('click', () => {
    const input = $('obsidian-vault-path');
    const prev = input.value;
    input.value = 'Selecting…';
    input.disabled = true;
    chrome.runtime.sendMessage({ type: 'MM2C_CHOOSE_FOLDER' }, (response) => {
      input.disabled = false;
      if (response?.path) {
        input.value = response.path;
        save({ mm2c_obsidian_vault_path: response.path });
      } else {
        input.value = prev;
      }
    });
  });

  $('file-path').addEventListener('click', () => {
    const input = $('file-path');
    const prev = input.value;
    input.value = 'Selecting…';
    input.disabled = true;
    chrome.runtime.sendMessage({ type: 'MM2C_CHOOSE_FOLDER' }, (response) => {
      input.disabled = false;
      if (response?.path) {
        input.value = response.path;
        save({ mm2c_file_backup_path: response.path });
      } else {
        input.value = prev;
      }
    });
  });

  // Live updates — refresh log list and capture state whenever storage changes while popup is open
  chrome.storage.onChanged.addListener((changes) => {
    if ('mm2c_logs' in changes) {
      renderLogs(changes.mm2c_logs.newValue);
    }
    if ('mm2c_failed_list' in changes) {
      renderRetryList(changes.mm2c_failed_list.newValue || []);
    }
    if ('mm2c_prompt_rules' in changes) {
      renderRules(changes.mm2c_prompt_rules.newValue || []);
    }
    if ('mm2c_last_note' in changes) {
      renderActionItems(changes.mm2c_last_note.newValue || '');
    }
    if ('mm2c_stats' in changes) {
      renderStats(changes.mm2c_stats.newValue || {});
    }

    // Tab-keyed keys: only react when the changed key belongs to the active tab
    if (!activeMetTabId) return;

    const snapKey    = tabKey('mm2c_last_snapshot',  activeMetTabId);
    const captureKey = tabKey('mm2c_capture_state',  activeMetTabId);
    const statusKey  = tabKey('mm2c_last_status',    activeMetTabId);

    if (snapKey in changes) {
      updateSnapshotContent(changes[snapKey].newValue || null);
    }

    if (captureKey in changes) {
      const capturing = changes[captureKey].newValue === 'capturing';
      const captureBtn = $('capture-now-btn');
      if (captureBtn) {
        captureBtn.disabled    = capturing;
        captureBtn.textContent = capturing ? 'Capturing notes…' : 'Capture now';
      }
      if (capturing) {
        $('status').textContent = 'Capturing notes…';
        $('status-banner').className = 'status-banner ok';
      } else {
        loadAndApplyState(activeMetTabId);
      }
    }

    if (statusKey in changes) {
      loadAndApplyState(activeMetTabId);
    }
  });

  $('log-list').addEventListener('click', (e) => {
    const retryBtn = e.target.closest('.log-retry-btn');
    if (!retryBtn) return;
    e.stopPropagation();
    retryBtn.textContent = 'Retrying…';
    retryBtn.disabled = true;
    chrome.runtime.sendMessage({
      type:       'MM2C_RETRY',
      title:      retryBtn.dataset.title,
      backupPath: retryBtn.dataset.backup,
    }, (response) => {
      retryBtn.textContent = response?.ok ? 'Sent ✓' : 'Failed ✗';
    });
  });

  // Collapsible log groups — toggle via event delegation
  $('log-list').addEventListener('click', (e) => {
    const header = e.target.closest('.log-group-header');
    if (!header) return;
    header.closest('.log-group').classList.toggle('expanded');
  });

  // Snapshot preview expand/collapse
  $('snapshot-header').addEventListener('click', () => {
    const header  = $('snapshot-header');
    const preview = $('snapshot-preview');
    const isOpen  = header.classList.toggle('expanded');
    preview.classList.toggle('hidden', !isOpen);
  });

  // Capture now — sends MM2C_CAPTURE_NOW directly to content script via tabs API
  $('capture-now-btn').addEventListener('click', () => {
    if (!activeMetTabId) return;
    chrome.tabs.sendMessage(activeMetTabId, { type: 'MM2C_CAPTURE_NOW' });
  });

  // Copy action items as Markdown task list (P6-B)
  $('copy-action-items').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_last_note'], ({ mm2c_last_note }) => {
      const md = formatActionItemsMarkdown(parseActionItems(mm2c_last_note || ''));
      if (!md) return;
      navigator.clipboard.writeText(md).then(() => {
        const btn = $('copy-action-items');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy as tasks'; }, 2000);
      });
    });
  });

  // Download logs as JSON
  $('download-logs').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_logs'], ({ mm2c_logs }) => {
      const data = JSON.stringify(mm2c_logs || [], null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `mm2c-logs-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // Clear logs
  $('clear-logs').addEventListener('click', () => {
    chrome.storage.local.set({ mm2c_logs: [] }, () => {
      renderLogs([]);
    });
  });

  // Two-tier logging toggle — show/hide diagnostic (debug) entries (UX-6)
  $('show-debug-logs').addEventListener('change', (e) => {
    showDebugLogs = e.target.checked;
    chrome.storage.local.get(['mm2c_logs'], ({ mm2c_logs }) => renderLogs(mm2c_logs));
  });

  // Local full-text search across past meeting notes (P9-E) + filters (RB-6b), debounced.
  let searchDebounce = null;
  function runSearch() {
    const q = $('note-search').value.trim();
    clearTimeout(searchDebounce);
    if (!q) { $('search-results').innerHTML = ''; return; }
    searchDebounce = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'MM2C_SEARCH',
        query: q,
        since: $('search-since').value || '',
        until: $('search-until').value || '',
        attendee: $('search-attendee').value.trim() || '',
      }, (resp) => {
        if (chrome.runtime.lastError) return;
        renderSearchResults(resp?.ok ? resp.results : []);
      });
    }, 300);
  }
  $('note-search').addEventListener('input', runSearch);
  ['search-since', 'search-until', 'search-attendee'].forEach(id => {
    $(id).addEventListener('change', runSearch);
    $(id).addEventListener('input', runSearch);
  });
});
