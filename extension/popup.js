const DEFAULT_FILE_PATH = '~/Downloads/meeting-notes';

// Tab ID of the Meet tab currently displayed in the popup.
// null = no Meet tab active; set by queryMeetingState().
let activeMetTabId = null;

// Logs tab tier toggle — when false, level:'debug' entries are hidden (UX-6).
let showDebugLogs = false;

// Persisted set of expanded log-group keys (UXF-6). Loaded from
// mm2c_expanded_groups in applyState; mutated + saved by the toggle handler.
// Default: all groups collapsed.
let expandedGroups = new Set();
// Rule indices the user has expanded (rules render collapsed by default, like the
// template rows). Kept in-memory so a re-render on save doesn't reset the state.
let expandedRuleIdx = new Set();

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
  'mm2c_redact_pii', 'mm2c_redact_keywords', 'mm2c_blocklist',
  'mm2c_emit_ics',
  'mm2c_glossary',
  'mm2c_beta_enabled',
  'mm2c_expanded_groups',
  'mm2c_theme',
  'mm2c_wikilinks',
  'mm2c_task_app',
  'mm2c_inflight',
  'mm2c_my_aliases',
  'mm2c_selector_hotfix_url',
  'mm2c_setup_done',
  'mm2c_calendar_enabled',
  'mm2c_gdocs_enabled',
  'mm2c_preview_before_send',
  'mm2c_dual_output', 'mm2c_private_prompt', 'mm2c_private_app',
  'mm2c_cleanup_snap_enabled', 'mm2c_cleanup_snap_days',
  'mm2c_cleanup_final_enabled', 'mm2c_cleanup_final_days',
  'mm2c_destinations',
];

// Render the first-run setup checklist (RB-7a) from live host status + config.
function renderSetupWizard(hostOk) {
  const panel = $('setup-wizard');
  if (!panel) return;
  chrome.storage.local.get(['mm2c_setup_done', 'mm2c_output_app', 'mm2c_stats'], ({ mm2c_setup_done, mm2c_output_app, mm2c_stats }) => {
    if (mm2c_setup_done === true) { panel.classList.add('hidden'); return; }
    const captured = !!(mm2c_stats && typeof mm2c_stats === 'object' && (mm2c_stats.notesSaved || 0) > 0);
    const steps = firstRunChecklist({ hostOk, outputApp: mm2c_output_app || 'none', captured });
    $('setup-wizard-steps').innerHTML = steps.map(s =>
      `<div style="display:flex;gap:7px;align-items:center;margin-top:6px">
         <span style="color:${s.ok ? 'var(--success)' : 'var(--text-muted)'}">${s.ok ? '✓' : '○'}</span>
         <span style="color:var(--text)">${escapeHtml(s.label)}</span>
       </div>`).join('');
    // Once every step is complete the card has served its purpose — dismiss it
    // so it doesn't linger after the user is fully onboarded.
    if (steps.every(s => s.ok)) { chrome.storage.local.set({ mm2c_setup_done: true }); panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
  });
}

// The user's name aliases (UXF-7), loaded in applyState; used by renderActionItems.
let myAliases = '';

// Last known native-host status (RB-7a) so the setup checklist can refresh when
// the output app changes without re-pinging the host.
let lastHostOk = false;

// Apply a theme (system|light|dark) to <html> and the segmented control (UXF-8).
function applyTheme(theme) {
  const t = normalizeTheme(theme);
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('#theme-control button').forEach(b => {
    b.classList.toggle('active', b.dataset.themeValue === t);
  });
}

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

// Hide the "Also send to" option that matches the current primary output app
// and uncheck it if it was selected (UXF-11) — a destination must never appear
// as both primary and also-send.
function syncAlsoSend(primaryApp) {
  let changed = false;
  document.querySelectorAll('.also-send-opt').forEach(cb => {
    const isPrimary = cb.value === primaryApp;
    const label = cb.closest('label');
    if (label) label.classList.toggle('hidden', isPrimary);
    if (isPrimary && cb.checked) { cb.checked = false; changed = true; }
  });
  if (changed) {
    const selected = [...document.querySelectorAll('.also-send-opt:checked')].map(c => c.value);
    chrome.storage.local.set({ mm2c_also_send: selected });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// formatSnapshotAge + formatCountdown now live in constants.js (loaded before
// this script) — shared so they're unit-tested directly against the real code.

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
  if (!rules || rules.length === 0) return; // Default row + templates are always shown
  const DAYS = [[1, 'Mo'], [2, 'Tu'], [3, 'We'], [4, 'Th'], [5, 'Fr'], [6, 'Sa'], [7, 'Su']];
  rules.forEach((rule, i) => {
    const cond = (rule.condition && typeof rule.condition === 'object') ? rule.condition : {};
    const selDays = Array.isArray(cond.days) ? cond.days : [];
    const item = document.createElement('div');
    item.className = 'rule-item';
    item.dataset.index = i;
    const open = expandedRuleIdx.has(i); // collapsed by default; survives re-renders
    item.innerHTML = `
      <div class="rule-header">
        ${rule.name ? `<span class="rule-name" title="Added from a built-in template">${escapeHtml(rule.name)}</span>` : ''}
        <input class="rule-regex" type="text" placeholder="e.g. DAILY" value="${escapeHtml(rule.regex || '')}">
        <button class="btn-rule-action" data-action="up" data-index="${i}" title="Move up" aria-label="Move rule up">↑</button>
        <button class="btn-rule-action" data-action="down" data-index="${i}" title="Move down" aria-label="Move rule down">↓</button>
        <button class="btn-rule-action danger" data-action="delete" data-index="${i}" title="Delete" aria-label="Delete rule">✕</button>
        <label class="toggle-wrap rule-toggle" title="${rule.enabled === false ? 'Rule disabled' : 'Rule enabled'}" style="transform:scale(0.85)">
          <input type="checkbox" class="rule-enabled" ${rule.enabled === false ? '' : 'checked'}>
          <span class="toggle-track"></span>
        </label>
        <button class="btn-collapse rule-expand ${open ? 'open' : ''}" type="button" aria-label="Expand or collapse this rule">▶</button>
      </div>
      <div class="rule-body ${open ? '' : 'hidden'}">
        <textarea class="rule-prompt" rows="3" placeholder="Prompt for this meeting type">${escapeHtml(rule.prompt || '')}</textarea>
        <input class="rule-title-template" type="text" placeholder="Title template (optional) — {date} {time} {name} {type} {code}" value="${escapeHtml(rule.titleTemplate || '')}">
        <div class="rule-condition">
          <span class="rule-cond-label">…or when:</span>
          <span class="rule-days">${DAYS.map(([n, lbl]) =>
            `<label title="${lbl}"><input type="checkbox" class="rule-day" data-day="${n}" ${selDays.includes(n) ? 'checked' : ''}>${lbl}</label>`).join('')}</span>
          <span class="rule-hours">
            <input type="number" class="rule-hour-start" min="0" max="23" placeholder="0" value="${Number.isInteger(cond.startHour) ? cond.startHour : ''}">–
            <input type="number" class="rule-hour-end" min="0" max="24" placeholder="24" value="${Number.isInteger(cond.endHour) ? cond.endHour : ''}">h
          </span>
          <span class="rule-hours" title="Time actually spent in the meeting (minutes)">
            <input type="number" class="rule-min-spent" min="0" placeholder="min" value="${Number.isInteger(cond.minMinutes) ? cond.minMinutes : ''}">–
            <input type="number" class="rule-max-spent" min="0" placeholder="max" value="${Number.isInteger(cond.maxMinutes) ? cond.maxMinutes : ''}">m
          </span>
          <select class="rule-depth" title="Summary depth">
            <option value="" ${!rule.depth ? 'selected' : ''}>Standard depth</option>
            <option value="brief" ${rule.depth === 'brief' ? 'selected' : ''}>Brief</option>
            <option value="detailed" ${rule.depth === 'detailed' ? 'selected' : ''}>Detailed</option>
          </select>
        </div>
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
  const mn = parseInt(item.querySelector('.rule-min-spent')?.value, 10);
  const mx = parseInt(item.querySelector('.rule-max-spent')?.value, 10);
  const condition = buildCondition(
    days,
    Number.isNaN(sh) ? NaN : sh, Number.isNaN(eh) ? NaN : eh,
    Number.isNaN(mn) ? NaN : mn, Number.isNaN(mx) ? NaN : mx,
  );
  const depth = item.querySelector('.rule-depth')?.value || '';
  const titleTemplate = item.querySelector('.rule-title-template')?.value.trim() || '';
  const enabled = item.querySelector('.rule-enabled')?.checked !== false;
  const rule = { regex, prompt };
  if (condition) rule.condition = condition;
  if (depth) rule.depth = depth;
  if (titleTemplate) rule.titleTemplate = titleTemplate;
  if (!enabled) rule.enabled = false; // only persist when off (default on)
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
  // Email-this-note widget (RB-3c, beta) — available whenever a note exists.
  // .beta keeps it hidden unless beta is on; .hidden tracks note presence.
  const emailWidget = $('email-note-widget');
  if (emailWidget) emailWidget.classList.toggle('hidden', !String(noteBody || '').trim());

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
  // Show "Send to tasks" only when a task app is configured (RB-3a).
  const sendBtn = $('send-to-tasks');
  if (sendBtn) sendBtn.classList.toggle('hidden', !$('task-app')?.value);
  // "N for you" badge — action items assigned to the user's aliases (UXF-7).
  const badge = $('my-items-badge');
  if (badge) {
    const mine = countMyActionItems(items, myAliases);
    badge.textContent = mine ? `${mine} for you` : '';
    badge.classList.toggle('hidden', !mine);
  }
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
    c.innerHTML = '<div class="search-empty">No matching past meetings. Try a different term or widen the date range.</div>';
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

// Built-in templates shown inline at the bottom of the rules list — OFF by
// default. Only templates not yet added (by name) are shown; switching the toggle
// ON materialises it into mm2c_prompt_rules as a normal editable rule (so it joins
// the rules above and drops out of here). The enable toggle and the expand chevron
// both sit INSIDE the bordered box on the right; the chevron (a plain button, not a
// native <details>) toggles the prompt, so clicking the toggle never expands it.
function renderTemplates(available) {
  const container = $('builtin-rules-list');
  if (!container || typeof BUILT_IN_RULES === 'undefined') return;
  const list = Array.isArray(available) ? available : [];
  container.innerHTML = list.map(rule => `
    <div class="builtin-rule">
      <div class="builtin-head">
        <span class="bi-name">${escapeHtml(rule.name)}</span>
        <span class="bi-regex">${escapeHtml(rule.regex)}</span>
        <label class="toggle-wrap" title="Switch on to add this template as a rule" style="transform:scale(0.85)">
          <input type="checkbox" class="builtin-enabled" data-name="${escapeHtml(rule.name)}">
          <span class="toggle-track"></span>
        </label>
        <button class="btn-collapse bi-expand" type="button" aria-label="Show this template's prompt">▶</button>
      </div>
      <div class="bi-prompt hidden">${escapeHtml(rule.prompt)}</div>
    </div>`).join('');
}

// Render the crash-recovery card from a persisted in-flight note (RB-1d).
function renderRecovery(inflight) {
  const container = $('recovery-list');
  if (!container) return;
  if (!inflightRecoverable(inflight)) { container.innerHTML = ''; return; }
  const title = inflight.title
    ? (inflight.title.length > 45 ? inflight.title.slice(0, 45) + '…' : inflight.title)
    : 'Untitled meeting';
  container.innerHTML = `
    <div class="retry-card">
      <div class="retry-card-header">
        <div>
          <div class="retry-card-title">${escapeHtml(title)}</div>
          <div class="retry-card-hint">An unsent note was recovered after an interrupted capture.</div>
        </div>
      </div>
      <div class="retry-card-actions">
        <button class="btn" id="recover-send">Send now</button>
        <button class="btn retry-dismiss-btn" id="recover-dismiss" title="Dismiss">✕</button>
      </div>
    </div>`;
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
      : 'Untitled meeting';  // one prose-null term, matching search results (UXC-21)
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
            title="Dismiss">✕</button>
        </div>
        <div class="retry-card-actions">
          <button class="btn retry-btn"
            data-tabid="${entry.tabId ?? ''}"
            data-title="${escapeHtml(entry.title || '')}"
            data-backup="${escapeHtml(entry.backupPath || '')}">Retry</button>
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

  // Output app selector — default to 'none' so onboarding's "Choose an output
  // app" step is a real choice (and nothing is silently saved before you pick).
  const outputApp = s.mm2c_output_app || 'none';
  $('output-app').value = outputApp;
  $('craft-sub-options').classList.toggle('hidden', outputApp !== 'craft');
  $('obsidian-sub-options').classList.toggle('hidden', outputApp !== 'obsidian');
  $('obsidian-vault-path').value = s.mm2c_obsidian_vault_path || '';

  $('craft-folder-id').value = s.mm2c_craft_folder_id || '';
  $('craft-space-id').value = s.mm2c_craft_space_id || '';
  $('craft-folder-error').textContent = craftFolderIdError(s.mm2c_craft_folder_id || '');
  $('obsidian-vault-error').textContent = obsidianVaultPathError(s.mm2c_obsidian_vault_path || '');
  $('webhook-url').value = s.mm2c_webhook_url || '';
  $('slack-webhook-url').value = s.mm2c_slack_webhook_url || '';
  $('webhook-error').textContent = webhookUrlError(s.mm2c_webhook_url || '');
  $('slack-error').textContent = webhookUrlError(s.mm2c_slack_webhook_url || '');
  $('redact-pii').checked = s.mm2c_redact_pii === true;
  $('redact-keywords').value = s.mm2c_redact_keywords || '';
  $('blocklist').value = s.mm2c_blocklist || '';
  $('emit-ics').checked = s.mm2c_emit_ics === true;
  $('preview-before-send').checked = s.mm2c_preview_before_send === true;
  const dualOn = s.mm2c_dual_output === true;
  $('dual-output').checked = dualOn;
  $('dual-output-sub').classList.toggle('hidden', !dualOn);
  $('private-prompt').value = s.mm2c_private_prompt || '';
  $('private-app').value = s.mm2c_private_app || '';
  $('wikilinks').checked = s.mm2c_wikilinks === true;
  $('task-app').value = s.mm2c_task_app || '';
  myAliases = s.mm2c_my_aliases || '';
  $('my-aliases').value = myAliases;
  $('selector-hotfix-url').value = s.mm2c_selector_hotfix_url || '';
  $('gdocs-enabled').checked = s.mm2c_gdocs_enabled === true;
  $('cleanup-snap-enabled').checked = s.mm2c_cleanup_snap_enabled === true;
  $('cleanup-snap-days').value = s.mm2c_cleanup_snap_days || 30;
  $('cleanup-final-enabled').checked = s.mm2c_cleanup_final_enabled === true;
  $('cleanup-final-days').value = s.mm2c_cleanup_final_days || 30;
  renderDestinations(s.mm2c_destinations); // UXF-11 additional-destinations repeater
  const betaOn = s.mm2c_beta_enabled === true;
  $('beta-enabled').checked = betaOn;
  document.body.classList.toggle('beta-enabled', betaOn);
  // The Beta tab is hidden when experimental features are off — don't strand
  // the user on a now-hidden tab (UXF-14).
  if (!betaOn && $('tab-beta').classList.contains('active')) switchTab('settings');
  applyTheme(s.mm2c_theme);
  const alsoSend = Array.isArray(s.mm2c_also_send) ? s.mm2c_also_send : [];
  document.querySelectorAll('.also-send-opt').forEach(cb => { cb.checked = alsoSend.includes(cb.value); });
  syncAlsoSend(outputApp);

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
  renderTemplates(availableTemplates(BUILT_IN_RULES, s.mm2c_prompt_rules || []));
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

  expandedGroups = new Set(Array.isArray(s.mm2c_expanded_groups) ? s.mm2c_expanded_groups : []);
  renderLogs(s.mm2c_logs);

  renderRetryList(Array.isArray(s.mm2c_failed_list) ? s.mm2c_failed_list : []);
  renderRecovery(s.mm2c_inflight);
  renderActionItems(s.mm2c_last_note);
  renderStats(s.mm2c_stats);
}

function setHostStatus(ok, error, hostVersion, versionMismatch) {
  lastHostOk = ok === true;
  renderSetupWizard(lastHostOk); // refresh the first-run checklist (RB-7a)
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

// ── Additional destinations repeater (UXF-11) ───────────────────────────────
// Beta feature: each row is a destination instance with its own inline config.
// Purely additive — independent of the primary + also-send path. Rows render
// from mm2c_destinations on load; any add/change/remove rebuilds the array from
// the DOM, runs it through normalizeDestinations, and persists it.

const _DEST_TYPES = [
  { value: 'obsidian',    label: 'Obsidian' },
  { value: 'apple_notes', label: 'Apple Notes' },
  { value: 'craft',       label: 'Craft' },
];

// Build one repeater row element from a (possibly partial) destination entry.
function buildDestinationRow(entry = {}) {
  const type = entry.type || 'obsidian';
  const row = document.createElement('div');
  row.className = 'row dest-row';

  const select = document.createElement('select');
  select.className = 'dest-type';
  select.setAttribute('aria-label', 'Destination type');
  for (const t of _DEST_TYPES) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    select.appendChild(opt);
  }
  select.value = type;

  const config = document.createElement('input');
  config.type = 'text';
  config.className = 'dest-config ltr';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn dest-remove';
  removeBtn.textContent = 'Remove';
  removeBtn.setAttribute('aria-label', 'Remove destination');

  row.appendChild(select);
  row.appendChild(config);
  row.appendChild(removeBtn);

  // Show/hide + seed the per-type config field.
  applyDestRowType(row, type, entry);

  select.addEventListener('change', () => {
    applyDestRowType(row, select.value, {});
    persistDestinations();
  });
  config.addEventListener('input', persistDestinations);
  removeBtn.addEventListener('click', () => { row.remove(); persistDestinations(); });

  return row;
}

// Configure a row's config input to match the selected type (placeholder /
// visibility / seed value). apple_notes has no config so the field is hidden.
function applyDestRowType(row, type, entry = {}) {
  const config = row.querySelector('.dest-config');
  if (type === 'obsidian') {
    config.classList.remove('hidden');
    config.placeholder = 'Vault folder path (e.g. ~/Obsidian/Meetings)';
    config.setAttribute('aria-label', 'Obsidian vault folder path');
    config.value = entry.vaultPath || '';
  } else if (type === 'craft') {
    config.classList.remove('hidden');
    config.placeholder = 'Craft folder ID (optional)';
    config.setAttribute('aria-label', 'Craft folder ID');
    config.value = entry.folderId || '';
  } else { // apple_notes — no extra config
    config.classList.add('hidden');
    config.value = '';
  }
}

// Read the current rows out of the DOM into a raw destinations array.
function readDestinationsFromDom() {
  return [...document.querySelectorAll('#destinations-list .dest-row')].map(row => {
    const type = row.querySelector('.dest-type').value;
    const cfg = row.querySelector('.dest-config').value;
    if (type === 'obsidian') return { type, vaultPath: cfg };
    if (type === 'craft')    return { type, folderId: cfg };
    return { type };
  });
}

// Rebuild → normalize → persist. Drops invalid/blank rows from storage but
// leaves the (possibly mid-edit) DOM untouched so typing isn't interrupted.
function persistDestinations() {
  save({ mm2c_destinations: normalizeDestinations(readDestinationsFromDom()) });
}

// Render the repeater rows from stored (already-normalized) destinations.
function renderDestinations(destinations) {
  const list = $('destinations-list');
  if (!list) return;
  list.innerHTML = '';
  for (const entry of normalizeDestinations(destinations)) {
    list.appendChild(buildDestinationRow(entry));
  }
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

// Just the HH:MM time — used for the group meta under a date section (UXF-4).
function formatTimeOnly(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Friendly day-section label: Today / Yesterday / "5 Jun" (UXF-4).
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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

  const renderGroup = (group) => {
    const groupTitle = group.title || 'System';
    // Default collapsed; expanded only if persisted in the set (UXF-6).
    const key = logGroupKey(groupTitle, group.entries[0].ts);
    const groupClass = expandedGroups.has(key) ? 'log-group expanded' : 'log-group';
    const outcome = groupOutcome(group.entries);
    // Meta is just the time — the date lives in the day section header (UXF-4).
    const meta = formatTimeOnly(group.entries[0].ts);

    const entriesHtml = group.entries.map(entry => {
      const dotClass = entry.status === 'ok' ? 'ok' : entry.status === 'warn' ? 'warn' : entry.status === 'err' ? 'err' : 'info';
      const time = formatTimeOnly(entry.ts);
      const message = entry.message || '';
      const backupPath = entry.status === 'err' ? extractBackupPath(message) : '';
      const retryChip = backupPath
        ? `<button class="btn log-retry-btn" data-title="${escapeHtml(entry.title || group.title || '')}" data-backup="${escapeHtml(backupPath)}">Retry</button>`
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
        <div class="log-group-header" data-group-key="${escapeHtml(key)}">
          <span class="log-dot ${outcome}" title="Capture outcome"></span>
          <span class="log-group-title">${escapeHtml(groupTitle)}</span>
          <span class="log-group-meta">${escapeHtml(meta)}</span>
          <span class="log-group-chevron">▶</span>
        </div>
        <div class="log-group-entries">${entriesHtml}</div>
      </div>`;
  };

  // Date → meeting → entries hierarchy (UXF-4): one section per calendar day.
  list.innerHTML = bucketLogGroupsByDay(groups).map(bucket => `
    <div class="log-day">
      <div class="log-day-header">${escapeHtml(dayLabel(bucket.ts))}</div>
      ${bucket.groups.map(renderGroup).join('')}
    </div>`).join('');
}

// ── Tabs ───────────────────────────────────────────────────────────────────

const TABS = ['main', 'rules', 'settings', 'logs', 'about', 'beta'];

function switchTab(tabName) {
  TABS.forEach(t => {
    const isActive = t === tabName;
    $(`tab-${t}`).classList.toggle('active', isActive);
    $(`tab-${t}`).setAttribute('aria-selected', isActive ? 'true' : 'false');
    $(`${t}-panel`).classList.toggle('hidden', !isActive);
  });
  // Lazy-load the Ko-fi tip iframe only on first About open (MON-1) — never
  // during capture, and never if the user never visits About.
  if (tabName === 'about') {
    const frame = $('kofi-frame');
    if (frame && !frame.src && frame.dataset.src) {
      frame.src = frame.dataset.src;
      frame.classList.remove('hidden');
    }
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadAndApplyState(activeMetTabId);
  renderTemplates(typeof BUILT_IN_RULES !== 'undefined' ? BUILT_IN_RULES : []);

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
      btn.textContent = 'Copied';
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

  // Crash-recovery card actions (RB-1d)
  $('recovery-list').addEventListener('click', (e) => {
    const sendBtn = e.target.closest('#recover-send');
    const dismissBtn = e.target.closest('#recover-dismiss');
    if (sendBtn) {
      sendBtn.textContent = 'Sending…';
      sendBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'MM2C_RECOVER' }, (resp) => {
        if (resp?.ok) {
          $('recovery-list').innerHTML = '';
        } else {
          sendBtn.textContent = 'Failed';
          sendBtn.disabled = false;
        }
      });
    }
    if (dismissBtn) {
      chrome.storage.local.remove('mm2c_inflight', () => { $('recovery-list').innerHTML = ''; });
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
      // Single storage read for the whole in-meeting panel (C2). Previously this
      // did get(snapKey) here AND a second get of an overlapping key set inside
      // loadAndApplyState. Now one get renders the snapshot widget and applies
      // state. Banner + capture button stay owned solely by applyState (BUG-C).
      chrome.storage.local.get([...GLOBAL_KEYS, ...tabScopedKeys(tabId)], (s) => {
        renderSnapshotWidget(s[tabKey('mm2c_last_snapshot', tabId)] || null);
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
        applyState(s, tabId, { inMeeting: true, geminiActive });
      });
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

  // First-run setup checklist dismiss (RB-7a)
  $('setup-wizard-dismiss').addEventListener('click', () => {
    save({ mm2c_setup_done: true });
    $('setup-wizard').classList.add('hidden');
  });

  $('copy-cmd').addEventListener('click', () => {
    const cmd = $('install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      const btn = $('copy-cmd');
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  $('enabled').addEventListener('change', e => {
    document.body.classList.toggle('ext-disabled', !e.target.checked);
    save({ mm2c_enabled: e.target.checked });
  });

  // Default rule (always-on fallback) — expand/collapse its prompt + reset.
  $('default-expand').addEventListener('click', () => {
    const body = $('default-rule').querySelector('.rule-body');
    const shown = !body.classList.toggle('hidden');
    $('default-expand').classList.toggle('open', shown);
  });

  $('add-rule-btn').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_prompt_rules'], ({ mm2c_prompt_rules }) => {
      const rules = Array.isArray(mm2c_prompt_rules) ? mm2c_prompt_rules : [];
      rules.push({ regex: '', prompt: '' });
      expandedRuleIdx.add(rules.length - 1); // open the new rule for editing
      save({ mm2c_prompt_rules: rules });
      renderRules(rules);
    });
  });

  $('rules-list').addEventListener('click', (e) => {
    // Collapse/expand a rule's body (chevron on the right, like the templates).
    const expandBtn = e.target.closest('.rule-expand');
    if (expandBtn) {
      const idx  = parseInt(expandBtn.closest('.rule-item')?.dataset.index, 10);
      const body = expandBtn.closest('.rule-item')?.querySelector('.rule-body');
      if (!body) return;
      const shown = !body.classList.toggle('hidden');
      expandBtn.classList.toggle('open', shown);
      if (Number.isInteger(idx)) shown ? expandedRuleIdx.add(idx) : expandedRuleIdx.delete(idx);
      return;
    }
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
      expandedRuleIdx.clear(); // indices shifted — reset collapse state
      save({ mm2c_prompt_rules: rules });
      renderRules(rules);
    });
  });

  function saveRuleFromEvent(e) {
    // Only persist edits to actual rule FIELDS (regex / prompt / conditions /
    // toggle / depth). A blur from an ↑/↓/✕ action button must NOT trigger a
    // save: clicking one focuses it, and the resulting blur would fire a save
    // that races the reorder/delete handler's own save and clobbers it
    // (reorder → duplicated row, delete → wrong survivor).
    if (!e.target.matches || !e.target.matches('input, textarea, select')) return;
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
    if (e.target.classList.contains('rule-day') || e.target.classList.contains('rule-depth') || e.target.classList.contains('rule-enabled')) saveRuleFromEvent(e);
  });

  // Expand/collapse a template's prompt — the chevron is a plain button (not a
  // native <details>), so it never interferes with the enable toggle next to it.
  $('builtin-rules-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.bi-expand');
    if (!btn) return;
    const prompt = btn.closest('.builtin-rule')?.querySelector('.bi-prompt');
    if (!prompt) return;
    const shown = !prompt.classList.toggle('hidden');
    btn.classList.toggle('open', shown);
  });

  // Built-in templates: switching a toggle ON materialises that template into the
  // user's rules as an editable rule. Event delegation on the container.
  $('builtin-rules-list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('builtin-enabled')) return;
    if (!e.target.checked) return; // templates only ever switch ON here → materialise
    const name = e.target.dataset.name;
    chrome.storage.local.get(['mm2c_prompt_rules'], ({ mm2c_prompt_rules }) => {
      const rules = Array.isArray(mm2c_prompt_rules) ? mm2c_prompt_rules : [];
      if (rules.some(r => r && r.name === name)) return; // already added
      const tpl = (typeof BUILT_IN_RULES !== 'undefined' ? BUILT_IN_RULES : []).find(t => t.name === name);
      if (!tpl) return;
      // Materialise the template into the user's rules as a normal editable rule.
      rules.push({ name: tpl.name, regex: tpl.regex, prompt: tpl.prompt, enabled: true });
      save({ mm2c_prompt_rules: rules });
      renderRules(rules);
      renderTemplates(availableTemplates(BUILT_IN_RULES, rules));
    });
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
    syncAlsoSend(app); // never offer the primary as an also-send target (UXF-11)
    save({ mm2c_output_app: app });
    renderSetupWizard(lastHostOk); // checking off the "choose output app" step (RB-7a)
  });

  $('craft-folder-id').addEventListener('input', e => {
    $('craft-folder-error').textContent = craftFolderIdError(e.target.value);
  });
  $('craft-folder-id').addEventListener('change', e => {
    save({ mm2c_craft_folder_id: e.target.value.trim() });
  });

  $('craft-space-id').addEventListener('change', e => {
    save({ mm2c_craft_space_id: e.target.value.trim() });
  });

  $('webhook-url').addEventListener('input', e => {
    $('webhook-error').textContent = webhookUrlError(e.target.value);
  });
  $('webhook-url').addEventListener('change', e => {
    save({ mm2c_webhook_url: e.target.value.trim() });
  });

  $('slack-webhook-url').addEventListener('input', e => {
    $('slack-error').textContent = webhookUrlError(e.target.value);
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
  $('blocklist').addEventListener('change', e => {
    save({ mm2c_blocklist: e.target.value.trim() });
  });
  $('emit-ics').addEventListener('change', e => {
    save({ mm2c_emit_ics: e.target.checked });
  });
  $('wikilinks').addEventListener('change', e => {
    save({ mm2c_wikilinks: e.target.checked });
  });
  $('preview-before-send').addEventListener('change', e => {
    save({ mm2c_preview_before_send: e.target.checked });
  });
  $('dual-output').addEventListener('change', e => {
    $('dual-output-sub').classList.toggle('hidden', !e.target.checked);
    save({ mm2c_dual_output: e.target.checked });
  });
  $('private-prompt').addEventListener('change', e => save({ mm2c_private_prompt: e.target.value.trim() }));
  $('private-app').addEventListener('change', e => save({ mm2c_private_app: e.target.value }));
  $('selector-hotfix-url').addEventListener('change', e => {
    const url = e.target.value.trim();
    $('selector-hotfix-url').value = url;
    save({ mm2c_selector_hotfix_url: url });
    chrome.runtime.sendMessage({ type: 'MM2C_REFRESH_HOTFIX' }, () => void chrome.runtime.lastError);
  });
  // Backup-folder auto-cleanup (UXF-13) — beta.
  const clampDays = v => Math.max(1, Math.min(3650, parseInt(v, 10) || 30));
  $('gdocs-enabled').addEventListener('change', e => save({ mm2c_gdocs_enabled: e.target.checked }));
  $('cleanup-snap-enabled').addEventListener('change', e => save({ mm2c_cleanup_snap_enabled: e.target.checked }));
  $('cleanup-snap-days').addEventListener('change', e => {
    const days = clampDays(e.target.value);
    e.target.value = days;
    save({ mm2c_cleanup_snap_days: days });
  });
  $('cleanup-final-enabled').addEventListener('change', e => save({ mm2c_cleanup_final_enabled: e.target.checked }));
  $('cleanup-final-days').addEventListener('change', e => {
    const days = clampDays(e.target.value);
    e.target.value = days;
    save({ mm2c_cleanup_final_days: days });
  });
  // Additional destinations repeater (UXF-11) — add a fresh row.
  $('add-destination').addEventListener('click', () => {
    $('destinations-list').appendChild(buildDestinationRow({ type: 'obsidian' }));
    // A new obsidian row has a blank vault → normalizeDestinations drops it
    // until the user types a path; that's fine, we still persist on input.
    persistDestinations();
  });
  $('my-aliases').addEventListener('change', e => {
    myAliases = e.target.value.trim();
    save({ mm2c_my_aliases: myAliases });
    chrome.storage.local.get(['mm2c_last_note'], ({ mm2c_last_note }) => renderActionItems(mm2c_last_note));
  });
  $('task-app').addEventListener('change', e => {
    save({ mm2c_task_app: e.target.value });
    // Reflect the new choice on the action-items "Send to tasks" button now.
    chrome.storage.local.get(['mm2c_last_note'], ({ mm2c_last_note }) => renderActionItems(mm2c_last_note));
  });

  // Send captured action items to the configured task manager (RB-3a)
  $('send-to-tasks').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_last_note', 'mm2c_task_app'], ({ mm2c_last_note, mm2c_task_app }) => {
      const app = mm2c_task_app || '';
      if (!app) return;
      const items = parseActionItems(mm2c_last_note || '');
      let opened = 0;
      items.forEach(it => {
        const url = buildTaskUrl(app, it);
        if (url) { window.open(url, '_blank'); opened++; }
      });
      const btn = $('send-to-tasks');
      btn.textContent = opened ? `Sent ${opened}` : 'No items';
      setTimeout(() => { btn.textContent = 'Send to tasks'; }, 2000);
    });
  });
  $('beta-enabled').addEventListener('change', e => {
    document.body.classList.toggle('beta-enabled', e.target.checked);
    // If experimental is turned off while on the Beta tab, fall back to
    // Settings so the user isn't stranded on a now-hidden tab (UXF-14).
    if (!e.target.checked && $('tab-beta').classList.contains('active')) switchTab('settings');
    save({ mm2c_beta_enabled: e.target.checked });
  });

  // Tri-state appearance control (UXF-8)
  $('theme-control').addEventListener('click', e => {
    const btn = e.target.closest('button[data-theme-value]');
    if (!btn) return;
    const theme = normalizeTheme(btn.dataset.themeValue);
    applyTheme(theme);
    save({ mm2c_theme: theme });
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
        // Route through resolveBanner so there is one banner writer (UXC-15) —
        // no hardcoded text/class that can drift from applyState's version.
        const b = resolveBanner({ capturing: true });
        $('status').textContent = b.text;
        $('status-banner').className = 'status-banner' + (b.cls ? ' ' + b.cls : '');
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

  // Collapsible log groups — toggle the DOM and persist the choice (UXF-6) so
  // the 10 s auto-refresh and future sessions remember it.
  $('log-list').addEventListener('click', (e) => {
    const header = e.target.closest('.log-group-header');
    if (!header) return;
    const nowExpanded = header.closest('.log-group').classList.toggle('expanded');
    const key = header.dataset.groupKey;
    if (!key) return;
    if (nowExpanded) expandedGroups.add(key);
    else             expandedGroups.delete(key);
    save({ mm2c_expanded_groups: [...expandedGroups] });
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
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy as tasks'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  // Run diagnostics — gather host/settings/permissions into a shareable report (RB-7b)
  $('run-diagnostics').addEventListener('click', () => {
    const btn = $('run-diagnostics');
    btn.disabled = true;
    btn.textContent = 'Running…';
    chrome.runtime.sendMessage({ type: 'MM2C_CHECK_HOST' }, (hostResp) => {
      chrome.storage.local.get(
        ['mm2c_output_app', 'mm2c_also_send', 'mm2c_file_backup_enabled'],
        (s) => {
          const report = buildDiagnosticsReport({
            version:       chrome.runtime.getManifest().version,
            extensionId:   chrome.runtime.id,
            hostOk:        hostResp?.ok === true,
            hostVersion:   hostResp?.hostVersion,
            hostMismatch:  hostResp?.versionMismatch === true,
            outputApp:     s.mm2c_output_app || 'craft',
            alsoSend:      Array.isArray(s.mm2c_also_send) ? s.mm2c_also_send : [],
            fileBackup:    s.mm2c_file_backup_enabled === true,
            permissions:  (chrome.runtime.getManifest().permissions || []),
            platform:      navigator.userAgent,
            generatedAt:   new Date().toISOString(),
          });
          const out = $('diag-output');
          out.textContent = report;
          out.classList.remove('hidden');
          $('copy-diagnostics').classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Run diagnostics';
        }
      );
    });
  });
  $('copy-diagnostics').addEventListener('click', () => {
    navigator.clipboard.writeText($('diag-output').textContent || '').then(() => {
      const btn = $('copy-diagnostics');
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy report'; btn.classList.remove('copied'); }, 2000);
    });
  });

  // Google Calendar connect/disconnect/status (5.3, beta)
  function renderGcalStatus() {
    chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gcal_status' }, (r) => {
      if (chrome.runtime.lastError || !r) return;
      const label = $('gcal-status');
      const btn = $('gcal-connect');
      if (r.connected) {
        label.textContent = r.email ? `Connected as ${r.email}` : 'Connected';
        btn.textContent = 'Disconnect';
        btn.dataset.action = 'disconnect';
      } else if (r.needs_reconnect) {
        label.textContent = 'Session expired';
        btn.textContent = 'Reconnect';
        btn.dataset.action = 'connect';
      } else {
        label.textContent = r.available === false ? 'Not installed (re-run install.sh)' : 'Not connected';
        btn.textContent = 'Connect';
        btn.dataset.action = 'connect';
      }
    });
  }
  renderGcalStatus();
  $('gcal-connect').addEventListener('click', () => {
    const action = $('gcal-connect').dataset.action || 'connect';
    if (action === 'disconnect') {
      chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gcal_disconnect' }, () => {
        save({ mm2c_calendar_enabled: false });
        renderGcalStatus();
      });
      return;
    }
    $('gcal-status').textContent = 'Opening browser — approve access, then return…';
    chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gcal_connect' }, () => {
      save({ mm2c_calendar_enabled: true });
      // The flow runs detached; poll status until it flips to connected.
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        renderGcalStatus();
        if (tries > 30) clearInterval(timer);
      }, 2000);
    });
  });

  // Google Docs connect/disconnect/status (5.7, beta) — separate OAuth grant,
  // rides the existing MM2C_GCAL relay (it forwards msg.action as the host type).
  function renderGdocsStatus() {
    chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gdocs_status' }, (r) => {
      if (chrome.runtime.lastError || !r) return;
      const label = $('gdocs-status');
      const btn = $('gdocs-connect');
      if (r.connected) {
        label.textContent = r.email ? `Connected as ${r.email}` : 'Connected';
        btn.textContent = 'Disconnect';
        btn.dataset.action = 'disconnect';
      } else if (r.needs_reconnect) {
        label.textContent = 'Session expired';
        btn.textContent = 'Reconnect';
        btn.dataset.action = 'connect';
      } else {
        label.textContent = r.available === false ? 'Not installed (re-run install.sh)' : 'Not connected';
        btn.textContent = 'Connect';
        btn.dataset.action = 'connect';
      }
    });
  }
  renderGdocsStatus();
  $('gdocs-connect').addEventListener('click', () => {
    const action = $('gdocs-connect').dataset.action || 'connect';
    if (action === 'disconnect') {
      chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gdocs_disconnect' }, () => {
        save({ mm2c_gdocs_enabled: false });
        $('gdocs-enabled').checked = false;
        renderGdocsStatus();
      });
      return;
    }
    $('gdocs-status').textContent = 'Opening browser — approve access, then return…';
    chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: 'gdocs_connect' }, () => {
      // The flow runs detached; poll status until it flips to connected.
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        renderGdocsStatus();
        if (tries > 30) clearInterval(timer);
      }, 2000);
    });
  });

  // Pre-meeting brief (P9-G, beta) — ask the background to brief the active Meet
  // tab; render the host's bullets, or a friendly message per error branch.
  function renderPreBrief(resp) {
    const out = $('pre-brief-out');
    out.textContent = '';
    if (!resp || resp.ok === false) {
      const msg = {
        beta_off: 'Enable experimental features first.',
        no_meet_tab: 'Open a Google Meet tab first.',
      }[resp && resp.error] || 'Connect Google Calendar first.';
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = msg;
      out.appendChild(p);
      return;
    }
    if (resp.matched === false || !(resp.bullets || []).length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No matching calendar event for this meeting.';
      out.appendChild(p);
      return;
    }
    const ul = document.createElement('ul');
    ul.setAttribute('aria-label', 'Brief bullets');
    for (const b of resp.bullets) {
      const li = document.createElement('li');
      li.textContent = String(b);
      ul.appendChild(li);
    }
    out.appendChild(ul);
  }

  $('pre-brief-btn').addEventListener('click', () => {
    const out = $('pre-brief-out');
    out.textContent = '';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Briefing…';
    out.appendChild(p);
    chrome.runtime.sendMessage({ type: 'MM2C_PRE_BRIEF' }, (resp) => {
      if (chrome.runtime.lastError) { renderPreBrief({ ok: false }); return; }
      renderPreBrief(resp);
    });
  });

  // Email the most recent note via the OS mail client (RB-3c, beta)
  $('email-note-btn').addEventListener('click', () => {
    chrome.storage.local.get(['mm2c_last_note'], ({ mm2c_last_note }) => {
      const body = String(mm2c_last_note || '').trim();
      if (!body) return;
      window.open(buildMailtoUrl({ title: 'Meeting notes', body }), '_blank');
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
