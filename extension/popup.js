const DEFAULT_FILE_PATH = '~/Documents/gememo-meeting-notes';

// Tab ID of the Meet tab currently displayed in the popup.
// null = no Meet tab active; set by queryMeetingState().
let activeMetTabId = null;

// History tab tier toggle — when false, level:'debug' entries are hidden (UX-6).
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
  'mm2c_redact_pii', 'mm2c_redact_keywords', 'mm2c_blocklist',
  'mm2c_emit_ics',
  'mm2c_beta_enabled',
  'mm2c_expanded_groups',
  'mm2c_theme',
  'mm2c_wikilinks',
  'mm2c_inflight',
  'mm2c_selector_hotfix_url',
  'mm2c_setup_done',
  'mm2c_preview_before_send',
  'mm2c_cleanup_snap_enabled', 'mm2c_cleanup_snap_days',
  'mm2c_cleanup_final_enabled', 'mm2c_cleanup_final_days',
  'mm2c_logs_cleanup_enabled', 'mm2c_logs_cleanup_days', 'mm2c_show_debug_logs',
  'mm2c_destinations',
];

// Render the first-run setup checklist (RB-7a) from live host status + config.
function renderSetupWizard(hostOk) {
  const panel = $('setup-wizard');
  if (!panel) return;
  chrome.storage.local.get(['mm2c_setup_dismissed', 'mm2c_output_app', 'mm2c_stats', 'mm2c_google_connected'], ({ mm2c_setup_dismissed, mm2c_output_app, mm2c_stats, mm2c_google_connected }) => {
    // Only a manual ✕ permanently hides the card. (Finishing the required steps
    // no longer hides it forever — a still-pending optional step like Connect
    // Google should keep showing until done or dismissed.)
    if (mm2c_setup_dismissed === true) { panel.classList.add('hidden'); return; }
    const captured = !!(mm2c_stats && typeof mm2c_stats === 'object' && (mm2c_stats.notesSaved || 0) > 0);
    const steps = firstRunChecklist({ hostOk, outputApp: mm2c_output_app || 'none', captured, googleConnected: mm2c_google_connected === true });
    $('setup-wizard-steps').innerHTML = steps.map(s =>
      `<div style="display:flex;gap:7px;align-items:center;margin-top:6px">
         <span style="color:${s.ok ? 'var(--success)' : 'var(--text-muted)'}">${s.ok ? '✓' : '○'}</span>
         <span style="color:var(--text)">${escapeHtml(s.label)}</span>
         ${s.id === 'google' && !s.ok
           ? `<button type="button" id="setup-google-connect" class="btn"
                style="margin-left:auto;padding:2px 10px;font-size:12px">Connect</button>`
           : ''}
       </div>`).join('')
      + `<div id="setup-google-error" style="color:var(--danger,#e5534b);font-size:12px;margin-top:8px;display:none"></div>`;
    // The onboarding "Connect" button for the still-pending Google step: kick off
    // the combined one-flow connect, then poll status until it flips. A doomed
    // connect (no credentials.json on this Mac, libs missing, or the user cancels
    // consent) surfaces an error + resets the button rather than spinning (BUG-14).
    const gbtn = $('setup-google-connect');
    if (gbtn) {
      const showErr = (errMsg) => {
        const el = $('setup-google-error');
        if (el) { el.textContent = errMsg || ''; el.style.display = errMsg ? 'block' : 'none'; }
      };
      const resetBtn = (errMsg) => { gbtn.disabled = false; gbtn.textContent = 'Connect'; showErr(errMsg); };
      gbtn.addEventListener('click', () => {
        showErr(''); // clear any prior error
        gbtn.disabled = true;
        gbtn.textContent = 'Connecting…';
        chrome.runtime.sendMessage({ type: 'MM2C_GOOGLE', action: 'google_connect' }, (resp) => {
          // The host fails fast when it can't connect — show why, don't poll.
          if (chrome.runtime.lastError || !resp || resp.status === 'error' || resp.ok === false) {
            resetBtn((resp && resp.error) || chrome.runtime.lastError?.message
              || 'Couldn’t start the Google connection.');
            return;
          }
          // The flow runs detached; poll status (~2s, cap ~90s) until connected.
          let tries = 0;
          const timer = setInterval(() => {
            tries++;
            chrome.runtime.sendMessage({ type: 'MM2C_GOOGLE', action: 'google_status' }, (r) => {
              if (!chrome.runtime.lastError && r && r.connected) {
                clearInterval(timer);
                chrome.storage.local.set({ mm2c_google_connected: true }, () => renderSetupWizard(lastHostOk));
              }
            });
            if (tries > 45) { clearInterval(timer); resetBtn('Connection didn’t complete — try again.'); }
          }, 2000);
        });
      });
    }
    // Hide once EVERY step (including the optional Connect-Google one) is done —
    // nothing left to show. Otherwise keep the card up so pending steps stay visible.
    if (steps.every(s => s.ok)) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
  });
}

// Status sync: ask the host whether the combined Google grant is live. If so,
// tick the onboarding step (so a host connected outside the popup reflects here).
// We never forcibly UN-tick — a user who dismissed/declined isn't pestered.
function syncGoogleConnected(cb) {
  chrome.runtime.sendMessage({ type: 'MM2C_GOOGLE', action: 'google_status' }, (r) => {
    if (!chrome.runtime.lastError && r && r.connected) {
      chrome.storage.local.set({ mm2c_google_connected: true }, () => cb && cb());
      return;
    }
    if (cb) cb();
  });
}

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
  // Include mm2c_also_send for one-time migration in applyState (not a GLOBAL_KEY).
  const keys = [...GLOBAL_KEYS, 'mm2c_also_send', ...tabScopedKeys(tabId)];
  chrome.storage.local.get(keys, s => applyState(s, tabId, live));
}

const $ = id => document.getElementById(id);

// Flash a copy button to "Copied" then restore its label (UXC-10).
function flashCopied(btn, label, ms = 2000) {
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, ms);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// formatCountdown lives in constants.js (loaded before this script) — shared so
// it's unit-tested directly against the real code.

// The snapshot "peek" lives inside the living-status card: a chevron appears when
// a snapshot exists; clicking it expands the preview. Called from the status query.
function renderSnapshotWidget(snap) {
  const chevron = $('status-chevron');
  const preview = $('snapshot-preview');
  if (!snap) {
    chevron.classList.add('hidden');
    chevron.classList.remove('expanded');
    preview.classList.add('hidden');
    preview.textContent = '';
    return;
  }
  chevron.classList.remove('hidden');          // a snapshot exists → offer the peek
  preview.textContent = snap.preview || '';     // collapsed until the chevron is clicked
}

// Refresh just the preview text (visibility owned by renderSnapshotWidget + the chevron).
function updateSnapshotContent(snap) {
  if (!snap) return;
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

  const saved = computeTimeSavedMin(s);
  const eligible = supportNudgeEligible(s);

  // Hero banner — the headline time-saved, promoted to the top of About. Gated at
  // the same 24h-of-meetings threshold as the support nudge: we only claim the
  // impact once the product has demonstrably earned it.
  const hero = $('impact-hero');
  if (hero) {
    if (eligible) {
      const notes = s.notesSaved || 0, meetings = s.meetingsAttended || 0;
      $('impact-hero-headline').innerHTML =
        `You've saved roughly <strong>${escapeHtml(formatStatDuration(saved))}</strong> with Gememo`;
      $('impact-hero-sub').textContent =
        `${formatStatNumber(notes)} note${notes === 1 ? '' : 's'} saved across ` +
        `${formatStatNumber(meetings)} meeting${meetings === 1 ? '' : 's'}.`;
      hero.classList.remove('hidden');
    } else {
      hero.classList.add('hidden');
    }
  }

  const savingsEl = $('stats-savings');
  if (savingsEl) {
    if (eligible) {
      // Earned the ask: ≥24h of meetings + real saved-time. The time itself now
      // lives in the hero banner, so this line is just the support ask.
      savingsEl.innerHTML =
        `If Gememo helps you, please consider <a href="https://ko-fi.com/caasols" target="_blank" rel="noopener">supporting it ☕</a>.`;
      savingsEl.classList.remove('hidden');
    } else if (saved === 0) {
      // No captures yet — onboarding nudge.
      savingsEl.textContent = 'Capture your first meeting to start tracking your impact.';
      savingsEl.classList.remove('hidden');
    } else {
      // Some usage, but under the 24h gate — hide the whole block.
      savingsEl.textContent = '';
      savingsEl.classList.add('hidden');
    }
  }
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

  // Output app selector — default to 'none' so onboarding's "Choose an output
  // app" step is a real choice (and nothing is silently saved before you pick).
  const outputApp = s.mm2c_output_app || 'none';
  $('output-app').value = outputApp;
  $('craft-sub-options').classList.toggle('hidden', outputApp !== 'craft');
  $('obsidian-sub-options').classList.toggle('hidden', outputApp !== 'obsidian');
  refreshDestinationStatus(); // OUT-1: grey out unavailable outputs + warn on the selected one
  // Google Docs connection visibility is handled by renderDestinations →
  // updateGdocsConnVisibility (covers both primary + additional-destination use).
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
  $('wikilinks').checked = s.mm2c_wikilinks === true;
  $('selector-hotfix-url').value = s.mm2c_selector_hotfix_url || '';
  $('cleanup-snap-enabled').checked = s.mm2c_cleanup_snap_enabled === true;
  $('cleanup-snap-days').value = s.mm2c_cleanup_snap_days || 7;
  $('cleanup-final-enabled').checked = s.mm2c_cleanup_final_enabled === true;
  $('cleanup-final-days').value = s.mm2c_cleanup_final_days || 7;
  $('logs-cleanup-enabled').checked = s.mm2c_logs_cleanup_enabled === true;
  $('logs-cleanup-days').value = s.mm2c_logs_cleanup_days || 7;
  // Developer-logs view filter — persisted (promoted to Settings → Diagnostics).
  // Restored BEFORE renderLogs() below so the persisted filter applies on first paint.
  showDebugLogs = s.mm2c_show_debug_logs === true;
  $('show-debug-logs').checked = showDebugLogs;
  // Unified destinations: fold legacy "Also send to" apps in, dedupe to one per
  // app, drop the primary, persist the cleaned list (self-heal), then render.
  const _primary = s.mm2c_output_app || 'none';
  const _merged = mergeAlsoSendIntoDestinations(s.mm2c_destinations, s.mm2c_also_send);
  const _cleanDests = dedupeDestinations(normalizeDestinations(_merged), _primary);
  const _hadAlsoSend = Array.isArray(s.mm2c_also_send) && s.mm2c_also_send.length;
  if (_hadAlsoSend || JSON.stringify(_cleanDests) !== JSON.stringify(normalizeDestinations(s.mm2c_destinations))) {
    save({ mm2c_destinations: _cleanDests });
    if (_hadAlsoSend) chrome.storage.local.remove('mm2c_also_send');
  }
  renderDestinations(_cleanDests, _primary);
  const betaOn = s.mm2c_beta_enabled === true;
  $('beta-enabled').checked = betaOn;
  document.body.classList.toggle('beta-enabled', betaOn);
  // The Beta tab is hidden when experimental features are off — don't strand
  // the user on a now-hidden tab (UXF-14).
  if (!betaOn && $('tab-beta').classList.contains('active')) switchTab('settings');
  applyTheme(s.mm2c_theme);
  const fileBackupOn = s.mm2c_file_backup_enabled === true;
  $('file-backup-enabled').checked = fileBackupOn;
  $('file-backup-sub').classList.toggle('hidden', !fileBackupOn);
  $('file-type').value = s.mm2c_file_backup_type || 'markdown';
  $('file-path').value = s.mm2c_file_backup_path || DEFAULT_FILE_PATH;

  // Feed the living-status card — renderStatus() is the single owner of the lead
  // line + detail (resolveBanner applies precedence inside it).
  _status.capturing    = captureStateVal === 'capturing';
  _status.inMeeting    = !!(live && live.inMeeting);
  _status.geminiActive = !!(live && live.geminiActive);
  _status.lastStatus   = lastStatusVal;
  renderStatus();

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
  // History auto-cleanup: when on, drop entries older than N days on open and
  // persist the trim (so reopening reflects it without waiting for new activity).
  let logsToRender = s.mm2c_logs;
  if (s.mm2c_logs_cleanup_enabled === true && Array.isArray(s.mm2c_logs)) {
    const pruned = pruneOldLogs(s.mm2c_logs, s.mm2c_logs_cleanup_days || 30);
    if (pruned.length !== s.mm2c_logs.length) {
      logsToRender = pruned;
      chrome.storage.local.set({ mm2c_logs: pruned });
    }
  }
  renderLogs(logsToRender);

  renderRetryList(Array.isArray(s.mm2c_failed_list) ? s.mm2c_failed_list : []);
  renderRecovery(s.mm2c_inflight);
  renderStats(s.mm2c_stats);
}

// Single source of truth for the living-status card. Every writer (host check,
// applyState, the status query) updates _status, then calls renderStatus() — one
// renderer, no dual-writer race.
const _status = {
  hostOk: null, hostVersion: '', versionMismatch: false,
  inMeeting: false, geminiActive: false, capturing: false, lastStatus: '',
  joinedAt: 0, snapshotCount: 0, nextInLabel: '',
};

function renderStatus() {
  const dot = $('host-dot'), label = $('host-label'), detail = $('status-detail');
  const card = $('status-card'), setupBtn = $('setup-btn');
  if (!card) return;
  detail.classList.add('hidden'); detail.textContent = '';
  card.classList.remove('warn', 'err');

  // Host not set up overrides everything (nothing saves without it).
  if (_status.versionMismatch) {
    dot.className = 'host-dot warn'; card.classList.add('warn');
    label.textContent = `Version mismatch — click Set up to reinstall (host v${_status.hostVersion}, extension v${chrome.runtime.getManifest().version})`;
    setupBtn.classList.remove('hidden');
    return;
  }
  if (_status.hostOk === false) {
    dot.className = 'host-dot err'; card.classList.add('err');
    label.textContent = "I'm not set up yet — click Set up to finish installing";
    setupBtn.classList.remove('hidden');
    return;
  }
  setupBtn.classList.add('hidden');

  // Otherwise the meeting/last-result narrative (resolveBanner owns precedence).
  const banner = resolveBanner({
    capturing: _status.capturing, inMeeting: _status.inMeeting,
    geminiActive: _status.geminiActive, lastStatus: _status.lastStatus,
  });
  const cls = banner.cls || 'ok';
  dot.className = 'host-dot ' + cls;       // 'ok' pulses (alive); warn/err don't
  if (cls === 'warn' || cls === 'err') card.classList.add(cls);
  label.textContent = banner.text;

  // Compact in-meeting detail: "You've been here 12 min · 3 snapshots · next in 4m".
  if (_status.inMeeting && _status.geminiActive && !_status.capturing) {
    const elapsedMin = _status.joinedAt ? Math.floor((Date.now() - _status.joinedAt) / 60000) : 0;
    const d = meetingStatusDetail({ elapsedMin, snapshotCount: _status.snapshotCount, nextInLabel: _status.nextInLabel });
    if (d) { detail.textContent = d; detail.classList.remove('hidden'); }
  }
}

function setHostStatus(ok, error, hostVersion, versionMismatch) {
  lastHostOk = ok === true;
  // Sync the combined-Google connection from the host (ticks the step when an
  // already-connected host reports it), THEN refresh the checklist (RB-7a).
  if (lastHostOk) {
    syncGoogleConnected(() => renderSetupWizard(lastHostOk));
  } else {
    renderSetupWizard(lastHostOk);
  }
  _status.hostOk = ok === true;
  _status.hostVersion = hostVersion || '';
  _status.versionMismatch = !!(ok && versionMismatch);
  // Surface the native-host version in About (next to the Extension ID).
  const aboutHost = $('about-host-version');
  if (aboutHost) aboutHost.textContent = ok ? (hostVersion ? `v${hostVersion}` : 'ready') : 'not installed';
  // The install command + setup panel only matter when the host isn't found.
  if (!ok && !versionMismatch) {
    $('install-cmd').textContent = `bash "$(mdfind -name install.sh | grep gememo | head -1)" ${chrome.runtime.id}`;
  } else {
    $('setup-panel').classList.add('hidden');
  }
  renderStatus();
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
  { value: 'bear',        label: 'Bear' },
  { value: 'google_docs', label: 'Google Docs' },
];
const _DEST_TYPE_VALUES = _DEST_TYPES.map(t => t.value);

// Primary output app — excluded from extra destinations. Set by renderDestinations.
let _destPrimary = 'none';
// Last destination-availability map from the host (OUT-1). Cached so a re-render
// can grey unavailable apps SYNCHRONOUSLY — otherwise a freshly-rebuilt row has a
// window where an un-connected app (e.g. Google Docs) is selectable, unlike the
// primary dropdown (a static element greyed once). undefined = not fetched yet.
let _lastDestStatus;

// Build one repeater row. opts.usedTypes = every row's type (so the dropdown can
// exclude apps taken by OTHER rows); opts.primaryApp = the primary output app.
function buildDestinationRow(entry = {}, opts = {}) {
  const primaryApp = opts.primaryApp != null ? opts.primaryApp : _destPrimary;
  const usedTypes  = Array.isArray(opts.usedTypes) ? opts.usedTypes : [];
  const type = entry.type || _DEST_TYPE_VALUES[0];
  const row = document.createElement('div');
  row.className = 'row dest-row';

  const select = document.createElement('select');
  select.className = 'dest-type';
  select.setAttribute('aria-label', 'Destination type');
  const allowed = availableDestTypes(_DEST_TYPE_VALUES, primaryApp, usedTypes, type);
  for (const t of _DEST_TYPES) {
    if (!allowed.includes(t.value)) continue;
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
  removeBtn.className = 'btn-rule-action danger dest-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove destination';
  removeBtn.setAttribute('aria-label', 'Remove destination');

  row.appendChild(select);
  row.appendChild(config);
  row.appendChild(removeBtn);

  applyDestRowType(row, type, entry);

  // Structural changes (type/remove) re-render so other rows' dropdowns and the
  // Add button update; config typing only persists (no re-render → keeps focus).
  select.addEventListener('change', () => { applyDestRowType(row, select.value, {}); persistAndRerender(); });
  config.addEventListener('input', persistDestinations);
  removeBtn.addEventListener('click', () => { row.remove(); persistAndRerender(); });

  return row;
}

// Configure a row's config input to match the selected type (placeholder /
// visibility / seed value). apple_notes has no config so the field is hidden.
function applyDestRowType(row, type, entry = {}) {
  const config = row.querySelector('.dest-config');
  if (type === 'obsidian') {
    config.classList.remove('hidden');
    config.placeholder = 'Obsidian vault — optional (uses your vault if blank)';
    config.setAttribute('aria-label', 'Obsidian vault folder path');
    config.value = entry.vaultPath || '';
  } else if (type === 'craft') {
    config.classList.remove('hidden');
    config.placeholder = 'Craft folder — optional';
    config.setAttribute('aria-label', 'Craft folder ID');
    config.value = entry.folderId || '';
  } else { // apple_notes / google_docs — no extra config
    config.classList.add('hidden');
    config.value = '';
  }
  // When a type has no config field, let the dropdown fill the row so the ✕ stays
  // right-aligned with the other rows instead of leaving a dangling gap.
  row.classList.toggle('no-config', config.classList.contains('hidden'));
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

// Persist the deduped, primary-excluded list (storage stays clean); no re-render.
function persistDestinations() {
  save({ mm2c_destinations: dedupeDestinations(normalizeDestinations(readDestinationsFromDom()), _destPrimary) });
}

// After a structural change: persist the cleaned list and re-render from it.
function persistAndRerender() {
  const clean = dedupeDestinations(normalizeDestinations(readDestinationsFromDom()), _destPrimary);
  save({ mm2c_destinations: clean });
  renderDestinations(clean, _destPrimary);
}

// Disable "Add destination" when no app is available (all used, or only primary).
function updateAddDestinationState() {
  const btn = $('add-destination');
  if (!btn) return;
  const used = normalizeDestinations(readDestinationsFromDom()).map(e => e.type);
  btn.disabled = availableDestTypes(_DEST_TYPE_VALUES, _destPrimary, used, null).length === 0;
}

// Show the Google Docs connection control whenever Google Docs is in use — as the
// primary output OR as an additional destination — so its OAuth is reachable either way.
function updateGdocsConnVisibility() {
  const widget = $('gdocs-conn');
  if (!widget) return;
  const asPrimary = $('output-app').value === 'google_docs';
  const asExtra = normalizeDestinations(readDestinationsFromDom()).some(e => e.type === 'google_docs');
  widget.classList.toggle('hidden', !(asPrimary || asExtra));
}

// OUT-1: ask the host which output destinations can currently receive a note,
// then grey out the dead ones in #output-app and surface a warning banner when
// the *selected* primary is unavailable. Fail-open: any host error leaves every
// option enabled and the banner hidden so a missing host never blocks the UI.
// Reflect each option's destination availability (OUT-1), for BOTH the primary
// #output-app and every additional-destination row so they agree:
//   • not installed (app absent from this Mac) → HIDE it — you can't act on it, so
//     only show what we can detect. EXCEPT the current selection, which stays
//     visible (greyed) so you can see + change your pick.
//   • not connected / needs config (e.g. Google Docs) → keep VISIBLE + greyed with
//     the reason, so a one-click-away integration stays discoverable.
//   • available → normal.
function applyDestAvailabilityToSelect(select, dests) {
  const selected = select.value;
  Array.from(select.options).forEach((opt) => {
    if (!opt.value || opt.value === 'none') return;
    if (opt.disabled && !opt.dataset.out1) return; // markup-disabled (Coming soon)
    const { enabled, reason } = destinationAvailability(dests, opt.value);
    // "Not installed" is the host's signal for an absent local app → hide it,
    // unless it's the current pick (don't strip the user's own selection).
    const hide = !enabled && reason === 'Not installed' && opt.value !== selected;
    opt.hidden = hide;
    if (!enabled && !hide) {
      // Remember the original label once, then show the reason inline (not just
      // on hover) — rebuilt from the base each call so repeats don't stack.
      if (opt.dataset.out1Base === undefined) opt.dataset.out1Base = opt.textContent;
      opt.disabled = true;
      opt.title = reason;
      opt.textContent = reason ? `${opt.dataset.out1Base} — ${reason}` : opt.dataset.out1Base;
      opt.dataset.out1 = '1';
    } else if (opt.dataset.out1) {
      // available, or now hidden → restore to the clean enabled label
      opt.disabled = false;
      opt.title = '';
      if (opt.dataset.out1Base !== undefined) {
        opt.textContent = opt.dataset.out1Base;
        delete opt.dataset.out1Base;
      }
      delete opt.dataset.out1;
    }
  });
}

function refreshDestinationStatus() {
  chrome.runtime.sendMessage({ type: 'MM2C_DESTINATION_STATUS' }, (reply) => {
    if (chrome.runtime.lastError) return; // fail open — leave the UI untouched
    const select = $('output-app');
    if (!select) return;
    const banner = $('output-unavailable');
    const dests = (reply && reply.status !== 'error') ? reply.destinations : null;
    _lastDestStatus = dests; // cache for synchronous greying on the next render
    applyDestAvailabilityToSelect(select, dests);
    // Same availability treatment for the additional-destination rows so they
    // can't offer an un-installed/un-connected app the primary already greys.
    document.querySelectorAll('select.dest-type').forEach((sel) =>
      applyDestAvailabilityToSelect(sel, dests));
    // Banner for the currently-selected primary.
    if (banner) {
      const warning = primaryOutputWarning(select.value, dests, outputAppName);
      if (warning) {
        banner.textContent = warning;
        banner.hidden = false;
      } else {
        banner.textContent = '';
        banner.hidden = true;
      }
    }
  });
}

// Render the repeater from a destinations list, deduped + primary-excluded.
function renderDestinations(destinations, primaryApp = _destPrimary) {
  _destPrimary = primaryApp;
  const list = $('destinations-list');
  if (!list) return;
  const deduped = dedupeDestinations(normalizeDestinations(destinations), primaryApp);
  const usedTypes = deduped.map(e => e.type);
  list.innerHTML = '';
  for (const entry of deduped) list.appendChild(buildDestinationRow(entry, { primaryApp, usedTypes }));
  updateAddDestinationState();
  updateGdocsConnVisibility();
  // Grey unavailable apps in the just-built rows SYNCHRONOUSLY from the cached
  // status (no window where Google Docs is selectable while not connected), then
  // refresh from the host to update the cache + catch any change.
  if (_lastDestStatus !== undefined) {
    list.querySelectorAll('select.dest-type').forEach((sel) => applyDestAvailabilityToSelect(sel, _lastDestStatus));
  }
  refreshDestinationStatus(); // OUT-1: refresh from the host + re-apply
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
  countEl.textContent = `${groups.length} meeting${groups.length === 1 ? '' : 's'} in the past days`;

  const renderGroup = (group) => {
    const groupTitle = group.title || 'System';
    // Default collapsed; expanded only if persisted in the set (UXF-6).
    const key = logGroupKey(groupTitle, group.entries[0].ts);
    const groupClass = expandedGroups.has(key) ? 'log-group expanded' : 'log-group';
    const outcome = groupOutcome(group.entries);
    // Meta is just the time — the date lives in the day section header (UXF-4).
    const meta = formatTimeOnly(group.entries[0].ts);

    // "Open ↗" — if a saved note left a deep-link reference (Apple Notes for now),
    // surface a control to re-open it. Beta-gated until the round-trip is verified.
    const linkEntry = group.entries.find(e => e.link && e.link.app === 'apple_notes' && e.link.value);
    const openChip = linkEntry
      ? `<button class="log-open-btn beta" title="Open in Apple Notes" data-ts="${linkEntry.ts}" data-noteid="${escapeHtml(linkEntry.link.value)}">Open ↗</button>`
      : '';

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
          ${openChip}
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

const TABS = ['main', 'logs', 'rules', 'settings', 'about', 'beta'];

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
      flashCopied(btn, 'Copy');
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
          renderSnapshotWidget(null);
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
        renderSnapshotWidget(null);
        loadAndApplyState(tabId);
        return;
      }
      const inMeeting    = !!response?.inMeeting;
      const geminiActive = !!response?.geminiActive;
      $('capture-footer').classList.toggle('hidden', !inMeeting);
      $('capture-footer-spacer').classList.toggle('hidden', !inMeeting);
      if (!inMeeting) {
        renderSnapshotWidget(null);
        loadAndApplyState(tabId, { inMeeting: false, geminiActive });
        return;
      }
      // Single storage read for the whole in-meeting panel (C2). Previously this
      // did get(snapKey) here AND a second get of an overlapping key set inside
      // loadAndApplyState. Now one get renders the snapshot widget and applies
      // state. Banner + capture button stay owned solely by applyState (BUG-C).
      chrome.storage.local.get([...GLOBAL_KEYS, 'mm2c_also_send', ...tabScopedKeys(tabId)], (s) => {
        renderSnapshotWidget(s[tabKey('mm2c_last_snapshot', tabId)] || null);
        // Feed the in-meeting detail fields; applyState() → renderStatus() renders them.
        _status.joinedAt      = response.meetingJoinedAt || 0;
        _status.snapshotCount = response.snapshotCount || 0;
        const countdown       = formatCountdown(response.nextSnapshotAt || 0);
        _status.nextInLabel   = countdown || formatCountdown(response.firstSnapshotAt || 0) || '';
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
          const fullDefault = `${response.home}/Documents/gememo-meeting-notes`;
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

  // First-run setup checklist dismiss (RB-7a) — manual ✕ hides it for good.
  $('setup-wizard-dismiss').addEventListener('click', () => {
    save({ mm2c_setup_dismissed: true });
    $('setup-wizard').classList.add('hidden');
  });

  $('copy-cmd').addEventListener('click', () => {
    const cmd = $('install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      const btn = $('copy-cmd');
      flashCopied(btn, 'Copy');
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


  $('output-app').addEventListener('change', e => {
    const app = e.target.value;
    $('craft-sub-options').classList.toggle('hidden', app !== 'craft');
    $('obsidian-sub-options').classList.toggle('hidden', app !== 'obsidian');
    updateGdocsConnVisibility(); // Google Docs connection shows if primary or an extra
    save({ mm2c_output_app: app });
    renderSetupWizard(lastHostOk); // checking off the "choose output app" step (RB-7a)
    refreshDestinationStatus(); // OUT-1: re-evaluate the unavailable banner for the new pick
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
  $('selector-hotfix-url').addEventListener('change', e => {
    const url = e.target.value.trim();
    $('selector-hotfix-url').value = url;
    save({ mm2c_selector_hotfix_url: url });
    chrome.runtime.sendMessage({ type: 'MM2C_REFRESH_HOTFIX' }, () => void chrome.runtime.lastError);
  });
  // Backup-folder auto-cleanup (UXF-13) — beta.
  const clampDays = v => Math.max(1, Math.min(3650, parseInt(v, 10) || 30));
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
  // Activity-history auto-cleanup — prune mm2c_logs entries older than N days.
  $('logs-cleanup-enabled').addEventListener('change', e => save({ mm2c_logs_cleanup_enabled: e.target.checked }));
  $('logs-cleanup-days').addEventListener('change', e => {
    const days = clampDays(e.target.value);
    e.target.value = days;
    save({ mm2c_logs_cleanup_days: days });
  });
  // Additional destinations repeater (UXF-11) — add a fresh row.
  $('add-destination').addEventListener('click', () => {
    const clean = dedupeDestinations(normalizeDestinations(readDestinationsFromDom()), _destPrimary);
    const avail = availableDestTypes(_DEST_TYPE_VALUES, _destPrimary, clean.map(e => e.type), null);
    if (!avail.length) return; // all apps used or are the primary
    clean.push({ type: avail[0] });
    save({ mm2c_destinations: clean });
    renderDestinations(clean, _destPrimary);
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
        _status.capturing = true;
        renderStatus();
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

  // "Open ↗" — re-open a saved note (Apple Notes) via the host. If the note is
  // gone, drop the dead reference so it isn't offered again (auto re-renders).
  $('log-list').addEventListener('click', (e) => {
    const openBtn = e.target.closest('.log-open-btn');
    if (!openBtn) return;
    e.stopPropagation();
    const ts = Number(openBtn.dataset.ts);
    openBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'MM2C_OPEN_NOTE', noteId: openBtn.dataset.noteid }, (resp) => {
      if (resp && resp.ok) return; // Notes is now frontmost
      if (resp && resp.reason === 'not_found') {
        openBtn.textContent = 'Note gone';
        chrome.storage.local.get(['mm2c_logs'], ({ mm2c_logs }) => {
          chrome.storage.local.set({ mm2c_logs: stripLogLink(mm2c_logs, ts) });
        });
      } else {
        openBtn.disabled = false; // transient failure (host down) — allow retry
      }
    });
  });

  // Collapsible log groups — toggle the DOM and persist the choice (UXF-6) so
  // the 10 s auto-refresh and future sessions remember it.
  $('log-list').addEventListener('click', (e) => {
    if (e.target.closest('.log-open-btn')) return; // Open handled above; don't toggle
    const header = e.target.closest('.log-group-header');
    if (!header) return;
    const nowExpanded = header.closest('.log-group').classList.toggle('expanded');
    const key = header.dataset.groupKey;
    if (!key) return;
    if (nowExpanded) expandedGroups.add(key);
    else             expandedGroups.delete(key);
    save({ mm2c_expanded_groups: [...expandedGroups] });
  });

  // Snapshot peek — the chevron toggles the latest-snapshot preview in the status card.
  $('status-chevron').addEventListener('click', () => {
    const chevron = $('status-chevron');
    const preview = $('snapshot-preview');
    const isOpen  = chevron.classList.toggle('expanded');
    preview.classList.toggle('hidden', !isOpen);
  });

  // Capture now — sends MM2C_CAPTURE_NOW directly to content script via tabs API
  $('capture-now-btn').addEventListener('click', () => {
    if (!activeMetTabId) return;
    chrome.tabs.sendMessage(activeMetTabId, { type: 'MM2C_CAPTURE_NOW' });
  });

  // Run diagnostics — gather host/settings/permissions into a shareable report (RB-7b)
  $('run-diagnostics').addEventListener('click', () => {
    const btn = $('run-diagnostics');
    btn.disabled = true;
    btn.textContent = 'Running…';
    chrome.runtime.sendMessage({ type: 'MM2C_CHECK_HOST' }, (hostResp) => {
      chrome.storage.local.get(
        ['mm2c_output_app', 'mm2c_file_backup_enabled', 'mm2c_destinations'],
        (s) => {
          const report = buildDiagnosticsReport({
            version:       chrome.runtime.getManifest().version,
            extensionId:   chrome.runtime.id,
            hostOk:        hostResp?.ok === true,
            hostVersion:   hostResp?.hostVersion,
            hostMismatch:  hostResp?.versionMismatch === true,
            outputApp:     s.mm2c_output_app || 'craft',
            destinations:  Array.isArray(s.mm2c_destinations) ? s.mm2c_destinations : [],
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
      flashCopied(btn, 'Copy report');
    });
  });

  // Wire an OAuth service row (status render + connect/disconnect + 30-try poll).
  // gdocs and the combined Google connect share this; they differ only in ids,
  // actions, and save hooks.
  function wireOAuthService({ statusId, connectBtnId, statusAction,
                              connectAction, disconnectAction, onConnect, onDisconnect }) {
    function render() {
      chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: statusAction }, (r) => {
        if (chrome.runtime.lastError || !r) return;
        const label = $(statusId);
        const btn = $(connectBtnId);
        if (r.connected) {
          label.textContent = r.email ? `Connected as ${r.email}` : 'Connected';
          btn.textContent = 'Disconnect';
          btn.dataset.action = 'disconnect';
        } else if (r.needs_reconnect) {
          label.textContent = 'Session expired';
          btn.textContent = 'Reconnect';
          btn.dataset.action = 'connect';
        } else {
          label.textContent = r.available === false ? 'Not set up — re-run install' : 'Not connected';
          btn.textContent = 'Connect';
          btn.dataset.action = 'connect';
        }
      });
    }
    render();
    $(connectBtnId).addEventListener('click', () => {
      const action = $(connectBtnId).dataset.action || 'connect';
      if (action === 'disconnect') {
        chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: disconnectAction }, () => {
          if (onDisconnect) onDisconnect();
          render();
        });
        return;
      }
      $(statusId).textContent = 'Opening browser — approve access, then return…';
      chrome.runtime.sendMessage({ type: 'MM2C_GCAL', action: connectAction }, (resp) => {
        // The host fails fast when it can't connect (no credentials.json / libs) —
        // show why and reset instead of polling a doomed connect forever (BUG-14).
        if (chrome.runtime.lastError || (resp && (resp.status === 'error' || resp.ok === false))) {
          $(statusId).textContent = (resp && resp.error) || chrome.runtime.lastError?.message || 'Couldn’t connect';
          render();
          return;
        }
        if (onConnect) onConnect();
        // The flow runs detached; poll status until it flips to connected.
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          render();
          if (tries > 30) clearInterval(timer);
        }, 2000);
      });
    });
  }

  // Google Docs connect/disconnect/status (5.7) — separate OAuth grant for the
  // Google Docs primary output; rides the existing MM2C_GCAL relay (forwards the
  // action as the host type). No save hooks: the connection is independent of
  // which primary is selected (you can connect before/after choosing Google Docs).
  wireOAuthService({
    statusId: 'gdocs-status', connectBtnId: 'gdocs-connect',
    statusAction: 'gdocs_status', connectAction: 'gdocs_connect', disconnectAction: 'gdocs_disconnect',
  });

  // Combined Google connect/disconnect in Settings → Privacy (one consent covers
  // Docs — the same grant the onboarding "Connect" button uses). Disconnecting
  // clears the onboarding tick (mm2c_google_connected) and re-greys Google Docs
  // via the OUT-1 destination probe.
  wireOAuthService({
    statusId: 'google-acct-status', connectBtnId: 'google-acct-btn',
    statusAction: 'google_status', connectAction: 'google_connect', disconnectAction: 'google_disconnect',
    onConnect: () => { save({ mm2c_google_connected: true }); refreshDestinationStatus(); },
    onDisconnect: () => { save({ mm2c_google_connected: false }); refreshDestinationStatus(); },
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
    save({ mm2c_show_debug_logs: showDebugLogs });
    chrome.storage.local.get(['mm2c_logs'], ({ mm2c_logs }) => renderLogs(mm2c_logs));
  });

});
