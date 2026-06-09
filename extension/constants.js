// Shared extension constants.
// Loaded before content_meet.js (via manifest content_scripts) and before
// popup.js (via popup.html). Edit DEFAULT_PROMPT here only — nowhere else.

const DEFAULT_PROMPT =
  'List the meeting attendees by name under a heading "Attendees".\n\n' +
  'Write 1–2 sentences for meetings under 30 minutes, or 3–4 sentences for longer meetings, under a heading "Summary" describing the purpose and main outcome of this meeting.\n\n' +
  'Under a heading "Key Points", summarise the discussion as detailed bullet points. ' +
  'Each bullet must start with a topic label followed by a colon, then a thorough explanation with full context.\n\n' +
  'Under a heading "Decisions Made", list every concrete agreement or decision reached during the meeting as bullet points. ' +
  'Only classify something as a decision if the transcript contains agreement language such as "we decided", "we agreed", "the team will", "it was confirmed", or an explicit vote. ' +
  'Include the rationale when stated.\n\n' +
  'Under a heading "Action Items", list all follow-up tasks grouped by owner. ' +
  'Use the speaker\'s name as it appears in the transcript — never write "I" or "they". ' +
  'For each item include the deadline if mentioned, otherwise write "no deadline set". ' +
  'Do not invent action items not explicitly stated.\n\n' +
  'Under a heading "Next Steps", list agreed follow-up meetings, reviews, demos, and conditional checkpoints. ' +
  'These are shared calendar commitments — not individual tasks. ' +
  'Include the date or trigger condition when stated. ' +
  'If no shared events were mentioned, omit this section.\n\n' +
  'Under a heading "Open Questions", list both unresolved questions that require decisions or research before progress, ' +
  'and risks or concerns raised during the meeting — even if no action was agreed immediately.\n\n' +
  'Only include information explicitly discussed in the meeting. ' +
  'Be ultra detailed — these notes must stand alone so anyone reading them later knows exactly what happened and what to do next. ' +
  'If the transcript contains very little content (a brief exchange with fewer than 2–3 minutes of real discussion), a single brief paragraph is sufficient — do not create empty section headings. ' +
  'Do not use vague filler phrases like "the team discussed" or "various topics were covered". ' +
  'Do not invent facts, names, dates, or commitments not in the transcript. ' +
  'If a section has no content, omit the heading entirely. ' +
  'Format everything as plain text. Do not use asterisks, underscores, backticks, or any other markdown formatting characters.\n\n' +
  // Auto-tagging (RB-4c) — a final machine-parseable line; stripped from the
  // body and promoted to YAML tags: by the native host.
  'Finally, end with a single line starting with "Tags:" followed by 3–5 short lowercase topic tags (single words or hyphenated-words), comma-separated — for example: Tags: payments, kafka, q3-planning.';

// Few-shot example prepended to every prompt so Gemini has a concrete format anchor.
// Shows: 4 attendees, 2 decisions with rationale, 3 action items with owner names + deadlines,
// 1 Next Step, 1 risk, 1 open question — exactly what DEFAULT_PROMPT instructs.
const EXAMPLE_NOTES =
  'Attendees\n' +
  'Alice Chen, Bob Martinez, Carlos Rodriguez, Diana Kim\n\n' +
  'Summary\n' +
  'The team reviewed the Q3 payments architecture proposal and agreed to adopt an event-driven approach. ' +
  'The database migration was deferred to Q4 to avoid overlap with the peak-period load tests.\n\n' +
  'Key Points\n' +
  'Event-driven architecture: Alice presented a Kafka-based proposal for decoupling the payments service. ' +
  'Bob confirmed the p99 latency target of 200ms is achievable. The team approved moving forward pending the schema spec.\n' +
  'Database migration deferral: Carlos flagged that running the migration during Q3 feature freeze creates unacceptable risk ' +
  'given the load test dependency. The team agreed to push it to Q4.\n' +
  'Monitoring gaps: Diana noted that the current Datadog dashboards do not cover the new event consumers ' +
  'and must be extended before rollout.\n\n' +
  'Decisions Made\n' +
  'Adopt event-driven architecture for the payments service. ' +
  'Rationale: decouples scaling and keeps latency within the p99 target.\n' +
  'Defer database migration to Q4. ' +
  'Rationale: Q3 timing conflicts with the peak period; load test results are needed first.\n\n' +
  'Action Items\n' +
  'Alice Chen: Draft the event schema spec by June 6.\n' +
  'Bob Martinez: Prototype the Kafka consumer and share results by June 10.\n' +
  'Diana Kim: Extend Datadog monitors for event consumers before rollout. No deadline set.\n\n' +
  'Next Steps\n' +
  'Architecture review scheduled for June 13 to validate the schema spec before implementation begins.\n\n' +
  'Open Questions\n' +
  'What is the fallback if Kafka is unavailable during a payments spike? No decision reached.\n' +
  'Risk: the Q4 migration window may conflict with the holiday freeze. ' +
  'Carlos to confirm dates with the infrastructure team.\n\n' +
  'Tags: payments, kafka, database-migration';

// ── Usage stats (UX-8) ───────────────────────────────────────────────────────
// Lifetime cumulative stats shown in the About tab as a donation driver.
// Shape: { meetingsAttended, notesSaved, wordsCaptured, totalMeetingMinutes }.

// Pure helper — word count of a note body.
function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Pure helper — fold one capture into the cumulative stats (notes/words/minutes).
// meetingsAttended is incremented separately (at meeting join), so it is preserved.
function updateStats(prev, { durationMin = null, words = 0 } = {}) {
  const s = {
    meetingsAttended: 0, notesSaved: 0, wordsCaptured: 0, totalMeetingMinutes: 0,
    ...(prev && typeof prev === 'object' ? prev : {}),
  };
  return {
    ...s,
    notesSaved: s.notesSaved + 1,
    wordsCaptured: s.wordsCaptured + (words || 0),
    totalMeetingMinutes: s.totalMeetingMinutes + (Number.isFinite(durationMin) ? durationMin : 0),
  };
}

// Pure helper — estimated manual note-taking time avoided (minutes). Composing
// structured meeting notes by hand runs ~25 effective words/min (thinking +
// organising + typing); this is the headline "time saved" donation number.
function computeTimeSavedMin(stats) {
  return Math.round(((stats && stats.wordsCaptured) || 0) / 25);
}

// Pure helper — minutes → "Xh Ym" / "Xh" / "Ym".
function formatStatDuration(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h && rem) return `${h}h ${rem}m`;
  if (h) return `${h}h`;
  return `${rem}m`;
}

// Pure helper — integer with thousands separators.
function formatStatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// Pure helper — two-tier logging (UX-6). Returns the log entries visible at the
// current tier: when showDebug is false, entries explicitly marked level:'debug'
// are hidden. Legacy entries with no level are treated as user-facing.
function filterLogsByLevel(logs, showDebug) {
  return (Array.isArray(logs) ? logs : []).filter(e => showDebug || e.level !== 'debug');
}

// Section headings the note pipeline produces — used to bound the Action Items
// block when extracting tasks (P6-B).
const _NOTE_HEADING_RE = /^#{0,3}\s*\*{0,2}\s*(attendees|summary|key points|decisions made|action items|next steps|open questions|updates|blockers|discussion|decisions|follow-up|what went well|what to improve)\s*\*{0,2}\s*:?\s*$/i;

// Pure helper — extract action items from a note body as {owner, task, deadline}
// (P6-B). Reads the lines under the "Action Items" heading until the next
// section heading. Owner is the text before the first colon; deadline is a
// best-effort "by <when>" suffix ("no deadline set" → null).
function parseActionItems(body) {
  const lines = String(body || '').split('\n');
  const items = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const hm = line.match(_NOTE_HEADING_RE);
    if (hm) { inSection = /action items/i.test(hm[1]); continue; }
    if (!inSection || !line) continue;
    const text = line.replace(/^[-•*]\s+/, '').replace(/\*\*/g, '').trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    let owner = '', task = text;
    if (colon > 0 && colon <= 40) { owner = text.slice(0, colon).trim(); task = text.slice(colon + 1).trim(); }
    let deadline = null;
    if (!/no deadline set/i.test(task)) {
      const m = task.match(/\bby ([^.]+?)\.?$/i);
      if (m) deadline = m[1].trim();
    }
    items.push({ owner, task, deadline });
  }
  return items;
}

// Task managers Gememo can route action items to via their URL schemes (RB-3a).
// No OAuth — the same x-callback-url pattern as the Craft/Bear push.
const TASK_APPS = {
  things:    'Things',
  todoist:   'Todoist',
  omnifocus: 'OmniFocus',
};

// Pure helper — build a task-manager URL for one action item (RB-3a). Owner +
// deadline become the task note. Returns '' for an unknown app or empty task.
function buildTaskUrl(app, item = {}) {
  const title = String(item.task || '').trim();
  if (!title) return '';
  const notes = [item.owner ? `Owner: ${item.owner}` : '', item.deadline ? `Due: ${item.deadline}` : '']
    .filter(Boolean).join(' · ');
  const t = encodeURIComponent(title);
  const n = encodeURIComponent(notes);
  switch (app) {
    case 'things':    return `things:///add?title=${t}${notes ? `&notes=${n}` : ''}`;
    case 'todoist':   return `todoist://addtask?content=${t}${notes ? `&description=${n}` : ''}`;
    case 'omnifocus': return `omnifocus:///add?name=${t}${notes ? `&note=${n}` : ''}`;
    default:          return '';
  }
}

// Pure helper — normalise the "Additional destinations" repeater array (UXF-11)
// into a clean, storable list. Each kept entry is an object with a known `type`
// and only that type's own config; everything else is dropped. Non-array/falsy
// input → []. obsidian rows with a blank vaultPath are dropped (no target);
// craft folderId is optional ('' = the default inbox). Order is preserved.
function normalizeDestinations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.type;
    if (type === 'obsidian') {
      const vaultPath = String(entry.vaultPath || '').trim();
      if (!vaultPath) continue; // no vault → nothing to write to
      out.push({ type, vaultPath });
    } else if (type === 'craft') {
      out.push({ type, folderId: String(entry.folderId || '').trim() });
    } else if (type === 'apple_notes') {
      out.push({ type });
    }
    // unknown type → dropped
  }
  return out;
}

// Pure helper — split a comma-separated alias string into a clean list (UXF-7).
function parseAliases(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Pure helper — does an action-item owner match any of the user's aliases
// (UXF-7)? Whole-word, case-insensitive, so "James R" matches the alias "James"
// but "Jameson" does not. Identity is user-confirmed (the aliases field), never
// silently inferred. `aliases` may be an array or a comma-separated string.
function ownerMatchesAliases(owner, aliases) {
  const o = String(owner || '').trim();
  if (!o) return false;
  return parseAliases(Array.isArray(aliases) ? aliases.join(',') : aliases).some(a => {
    if (!a) return false;
    try { return new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(o); }
    catch { return false; }
  });
}

// Pure helper — count action items owned by the user (UXF-7).
function countMyActionItems(items, aliases) {
  return (Array.isArray(items) ? items : []).filter(it => ownerMatchesAliases(it.owner, aliases)).length;
}

// Pure helper — render action items as Markdown task list lines (P6-B).
function formatActionItemsMarkdown(items) {
  return (Array.isArray(items) ? items : []).map(it => {
    const meta = [it.owner, it.deadline].filter(Boolean).join(', ');
    return `- [ ] ${it.task}${meta ? ` (${meta})` : ''}`;
  }).join('\n');
}

// Built-in prompt templates for the most common meeting types (P5-K). These are
// matched AFTER the user's own rules (so users can override) and BEFORE the
// DEFAULT_PROMPT fallback. They are non-deletable; the Rules tab shows them as a
// read-only "Built-in templates" group so the routing engine isn't a blank slate.
const BUILT_IN_RULES = [
  {
    name: 'Standup',
    regex: 'standup|stand-up|daily|scrum',
    prompt:
      'This is a short daily standup. Keep the notes brief.\n\n' +
      'Under a heading "Attendees", list who spoke.\n\n' +
      'Under a heading "Updates", add one bullet per person: start with their name, then ' +
      'what they completed, what they are working on next, and any blockers. ' +
      'Use the speaker\'s name as it appears in the transcript — never "I" or "they".\n\n' +
      'Under a heading "Blockers", list anything explicitly called out as blocking, with the owner. ' +
      'Omit this heading if there were none.\n\n' +
      'Only include what was explicitly said. Omit empty headings. ' +
      'Format everything as plain text — no asterisks, underscores, backticks, or markdown.',
  },
  {
    name: '1:1',
    regex: '1:1|1-1|one.?on.?one|1 on 1',
    prompt:
      'This is a 1:1 meeting.\n\n' +
      'Under a heading "Summary", write 1–3 sentences on what this 1:1 covered.\n\n' +
      'Under a heading "Discussion", summarise the topics raised as detailed bullet points, ' +
      'each starting with a topic label and a colon.\n\n' +
      'Under a heading "Decisions", list any agreements reached. Omit if none.\n\n' +
      'Under a heading "Action Items", list follow-ups grouped by owner, with a deadline if stated ' +
      'or "no deadline set". Use real names — never "I" or "they".\n\n' +
      'Under a heading "Follow-up", note any next 1:1 or check-in that was scheduled. Omit if none.\n\n' +
      'Only include what was explicitly discussed. Omit empty headings. ' +
      'Format everything as plain text — no asterisks, underscores, backticks, or markdown.',
  },
  {
    name: 'Retro',
    regex: 'retro|retrospective|post.?mortem|postmortem',
    prompt:
      'This is a team retrospective.\n\n' +
      'Under a heading "What Went Well", list the positives raised, as bullet points.\n\n' +
      'Under a heading "What To Improve", list the problems and pain points raised, as bullet points.\n\n' +
      'Under a heading "Action Items", list the agreed improvements grouped by owner, ' +
      'with a deadline if stated or "no deadline set". Use real names — never "I" or "they".\n\n' +
      'Be concrete and specific; do not use vague filler. Only include what was explicitly said. ' +
      'Omit empty headings. Format everything as plain text — no asterisks, underscores, backticks, or markdown.',
  },
];

// Pure helper — built-in templates not yet added to the user's rules (by name).
// Templates are off by default; switching one on "materialises" it into
// mm2c_prompt_rules as a normal editable rule, after which it drops out of the
// suggestion list (matched by name). Returns the still-addable templates.
function availableTemplates(builtins, rules) {
  const taken = new Set(
    (Array.isArray(rules) ? rules : []).map(r => r && r.name).filter(Boolean)
  );
  return (Array.isArray(builtins) ? builtins : []).filter(r => r && !taken.has(r.name));
}

// Pure helper — normalise Rules-tab inputs into a rule `condition` object, or
// null when nothing usable was entered (P5-L2). Hours require BOTH bounds.
// minMinutes/maxMinutes (UXF-10) add a "time actually spent" range; either bound
// is optional. Extra args are optional so existing 3-arg callers are unchanged.
function buildCondition(days, startHour, endHour, minMinutes, maxMinutes) {
  const out = {};
  const validDays = (Array.isArray(days) ? days : []).filter(d => Number.isInteger(d) && d >= 1 && d <= 7);
  if (validDays.length) out.days = validDays;
  if (Number.isInteger(startHour) && Number.isInteger(endHour) &&
      startHour >= 0 && startHour <= 23 && endHour >= 0 && endHour <= 24 && startHour < endHour) {
    out.startHour = startHour;
    out.endHour = endHour;
  }
  if (Number.isInteger(minMinutes) && minMinutes >= 0) out.minMinutes = minMinutes;
  if (Number.isInteger(maxMinutes) && maxMinutes >= 0) out.maxMinutes = maxMinutes;
  return Object.keys(out).length ? out : null;
}

// Pure helper — does a rule's duration condition match the time actually spent
// (UXF-10)? minMinutes/maxMinutes form an inclusive range; either is optional.
// Returns false when no duration bounds are set or durationMin is unknown.
function ruleDurationMatches(condition, durationMin) {
  if (!condition || !Number.isFinite(durationMin)) return false;
  const hasMin = Number.isInteger(condition.minMinutes);
  const hasMax = Number.isInteger(condition.maxMinutes);
  if (!hasMin && !hasMax) return false;
  if (hasMin && durationMin < condition.minMinutes) return false;
  if (hasMax && durationMin > condition.maxMinutes) return false;
  return true;
}

// Pure helper — does a rule's time condition match the given moment (P5-L2)?
// condition: { days?: number[] (ISO 1=Mon..7=Sun), startHour?, endHour? (0-23, [start,end)) }.
// Returns true only when the condition is non-empty AND every specified part holds.
function ruleTimeMatches(condition, date) {
  if (!condition || typeof condition !== 'object') return false;
  const hasDays  = Array.isArray(condition.days) && condition.days.length > 0;
  const hasHours = Number.isInteger(condition.startHour) && Number.isInteger(condition.endHour);
  if (!hasDays && !hasHours) return false;
  if (hasDays) {
    const iso = date.getDay() === 0 ? 7 : date.getDay(); // JS 0=Sun → ISO 7
    if (!condition.days.includes(iso)) return false;
  }
  if (hasHours) {
    const h = date.getHours();
    if (!(h >= condition.startHour && h < condition.endHour)) return false;
  }
  return true;
}

// Pure helper — return the first rule that matches, or null. A rule matches when
// its regex matches the title OR its time condition matches `now` (P5-L2).
// Shared by content_meet.js and tests.js; invalid regexes are skipped.
function findPromptRule(rules, meetingTitle, now = new Date(), ctx = {}) {
  if (!Array.isArray(rules)) return null;
  const title = meetingTitle || '';
  for (const r of rules) {
    if (!r) continue;
    if (r.enabled === false) continue; // UXF-9 — a disabled rule is skipped (default on)
    let matched = false;
    if (r.regex) {
      try { matched = new RegExp(r.regex, 'i').test(title); } catch { /* skip bad regex */ }
    }
    if (!matched && r.condition) matched = ruleTimeMatches(r.condition, now);
    // Time-actually-spent condition (UXF-10) — ctx.durationMin from the live meeting.
    if (!matched && r.condition && Number.isFinite(ctx.durationMin)) {
      matched = ruleDurationMatches(r.condition, ctx.durationMin);
    }
    if (matched) return r;
  }
  return null;
}

// Pure helper — the matched rule's prompt, or null (thin wrapper over findPromptRule).
function matchPromptRule(rules, meetingTitle, now = new Date()) {
  return findPromptRule(rules, meetingTitle, now)?.prompt?.trim() || null;
}

// Pure helper — is this meeting title on the capture blocklist (RB-5a)?
// patterns may be an array or a comma/newline-separated string of regexes.
function titleBlocked(title, patterns) {
  const t = String(title || '');
  if (!t) return false;
  const pats = (Array.isArray(patterns) ? patterns : String(patterns || '').split(/[\n,]/))
    .map(p => p.trim()).filter(Boolean);
  return pats.some(p => {
    try { return new RegExp(p, 'i').test(t); } catch { return false; }
  });
}

// Pure helper — validate a user-entered webhook URL (ARCH-6). Returns '' when
// the URL is blank (= disabled) or a valid http(s):// URL, else an error string.
function webhookUrlError(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\/\S+$/i.test(u)) return 'Enter a full http:// or https:// URL';
  return '';
}

// Pure helper — validate a Craft inbox folder / doc ID (A4). Blank = use the
// default (Unsorted); otherwise it must be a bare deeplink docId — never a full
// URL and never containing whitespace. Returns '' when valid, else an error.
function craftFolderIdError(id) {
  const v = String(id || '').trim();
  if (!v) return '';
  if (/\s/.test(v)) return 'Paste just the Craft doc ID — no spaces';
  if (/:\/\/|craftdocs:|\//.test(v)) return 'Paste just the Craft doc ID, not a URL';
  return '';
}

// Pure helper — validate an Obsidian vault folder path (A4). Blank = not set;
// otherwise it must be an absolute path (starts with / or ~). Returns '' when
// valid, else an error string.
function obsidianVaultPathError(path) {
  const v = String(path || '').trim();
  if (!v) return '';
  if (!/^(\/|~)/.test(v)) return 'Enter an absolute folder path (starting with / or ~)';
  return '';
}

// Pure helper — build a mailto: URL for emailing a captured note (RB-3c, beta).
// Zero-config "just email me the summary" destination. The body is truncated to
// keep the URL within mail-client length limits; the full note stays in the
// saved file/output app.
function buildMailtoUrl({ title = '', body = '', maxBody = 1500 } = {}) {
  const subject = encodeURIComponent(title ? String(title) : 'Meeting notes');
  let b = String(body || '');
  if (b.length > maxBody) {
    b = b.slice(0, maxBody) + '\n\n…(truncated — open the saved note for the full text)';
  }
  return `mailto:?subject=${subject}&body=${encodeURIComponent(b)}`;
}

// Pure helper — assemble a shareable plain-text diagnostics report (RB-7b) from
// already-gathered facts. Keeping the formatting pure makes it unit-testable;
// popup.js gathers the inputs (host ping, storage, manifest) and renders this.
function buildDiagnosticsReport(info = {}) {
  const alsoSend = Array.isArray(info.alsoSend) && info.alsoSend.length ? info.alsoSend.join(', ') : 'none';
  const perms = Array.isArray(info.permissions) && info.permissions.length ? info.permissions.join(', ') : 'none';
  const host = info.hostOk
    ? `ready (v${info.hostVersion || '?'})${info.hostMismatch ? ' — version mismatch' : ''}`
    : 'not found';
  return [
    'Gememo diagnostics',
    `Version: ${info.version || '?'}`,
    `Extension ID: ${info.extensionId || '?'}`,
    `Native host: ${host}`,
    `Output app: ${info.outputApp || 'none'}`,
    `Also send to: ${alsoSend}`,
    `File backup: ${info.fileBackup ? 'on' : 'off'}`,
    `Permissions: ${perms}`,
    `Platform: ${info.platform || '?'}`,
    `Generated: ${info.generatedAt || new Date().toISOString()}`,
  ].join('\n');
}

// Pure helper — the first-run setup checklist (RB-7a). Given the live host
// status and chosen output app, returns the ordered steps with their done
// state. The capture step completes itself in the first meeting.
function firstRunChecklist({ hostOk = false, outputApp = '' } = {}) {
  return [
    { id: 'host',    label: 'Install the native host', ok: !!hostOk },
    { id: 'output',  label: 'Choose an output app',     ok: !!outputApp && outputApp !== 'none' },
    { id: 'capture', label: 'Capture your first meeting', ok: false },
  ];
}

// Pure helper — is setup ready to capture (RB-7a)? True once the host + output
// steps are done; the capture step is informational and excluded.
function firstRunReady(list) {
  return (Array.isArray(list) ? list : []).filter(s => s.id !== 'capture').every(s => s.ok);
}

// Pure helper — build a prefilled GitHub "new issue" URL (RB-1c).
function buildIssueUrl(report) {
  const enc = s => encodeURIComponent(String(s == null ? '' : s));
  const title = enc((report && report.title) || 'Gememo issue');
  const body = enc((report && report.body) || '');
  return `https://github.com/caasols/gememo/issues/new?title=${title}&body=${body}`;
}

// Pure prompt-prefix builders (extracted from content_meet so the whole prompt
// construction is unit-testable — a bug here means bad AI notes).
function meetingTitlePrefix(title) {
  return title
    ? `Meeting title: ${title}. Use this context to interpret references to projects, teams, or products in the transcript.\n\n`
    : '';
}
function noteLanguagePrefix(lang) {
  return lang
    ? `Write all notes in ${lang}. Preserve proper nouns, product names, technical acronyms, and people's names in their original form without translating them.\n\n`
    : '';
}
function attendeesPrefix(names) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  return list.length
    ? `Meeting attendees: ${list.map((n, i) => `${i + 1}. ${n}`).join(', ')}. Use these exact names when assigning action items.\n\n`
    : '';
}

// Pure helper — assemble the full Gemini prompt from its parts in the canonical
// order: title → prior-session context → glossary → language → attendees →
// few-shot example → (depth-prefixed) base prompt.
function assemblePrompt({ title = '', priorContext = '', glossary = '', language = '',
                          attendees = [], example = '', base = '', depth = '' } = {}) {
  const depthPfx = depthInstruction(depth);
  const effectiveBase = depthPfx ? `${depthPfx}\n\n${base}` : base;
  const examplePfx = example
    ? `Here is an example of the exact note format to produce:\n\n---\n${example}\n---\n\nNow produce notes for the current meeting following this exact format:\n\n`
    : '';
  const priorPfx = priorContext ? `${priorContext}\n\n` : '';
  return meetingTitlePrefix(title)
    + priorPfx
    + glossaryPrefix(glossary)
    + noteLanguagePrefix(language)
    + attendeesPrefix(attendees)
    + examplePfx
    + effectiveBase;
}

// Pure helper — map a raw error string to friendly "what happened + what to do"
// copy for the in-page toast and popup banner (UXC-3). The raw text is kept only
// in the debug log; the user never sees a bare JS / native-messaging string.
function friendlyError(raw) {
  const s = String(raw == null ? '' : raw);
  if (/native (messaging )?host not found|not found.*host|host.*not found|forbidden|not allowed|access to the specified native messaging host is forbidden/i.test(s))
    return 'Native host not found — open the Set up panel to install it.';
  if (/Craft is not running/i.test(s))
    return "Craft isn't running — open Craft and click Retry.";
  if (/context invalidated|Extension context/i.test(s))
    return 'The extension reloaded mid-capture — reload the Meet tab and try again.';
  if (/timed out|timeout/i.test(s))
    return 'Saving timed out — your notes are backed up; click Retry.';
  if (/transcript is empty|appears empty|Response extracted|Submit button not found/i.test(s))
    return 'No notes were captured — Gemini may not have produced a summary.';
  return 'Something went wrong saving your notes. Check the Logs tab for details.';
}

// Pure helper — should the capture be shown for review before sending (RB-4b)?
// Only when the user opted in AND there's a non-trivial transcript to review.
function shouldPreviewBeforeSend(enabled, transcript) {
  return !!enabled && typeof transcript === 'string' && transcript.trim().length > 20;
}

// Pure helper — body copy for the leave-confirmation overlay (UXC-1). Names the
// user's actual output app instead of a hardcoded "Craft", which was factually
// wrong for Apple Notes / Obsidian users.
function closeOverlayBody(appName) {
  return `Gemini notes are active. Save a summary to ${appName} before leaving?`;
}

// Canonical user-facing copy for "Gemini wasn't active in this meeting" (UXC-2).
// One string routed to every surface — the in-page toast, the popup status
// banner (via MM2C_WARNING → mm2c_last_status), and the GeminiNotActiveError
// path — so the wording and grammar stay in sync. Previously three different
// strings existed, one with a subject-verb agreement error ("Gemini notes was
// not active").
const GEMINI_INACTIVE_MESSAGE = "Gemini wasn't active in this meeting — no notes were saved.";

// Pure helper — custom vocabulary/glossary → a prompt prefix (RB-4a). Terms are
// comma- or newline-separated; the model is told to keep them verbatim.
function glossaryPrefix(glossary) {
  const terms = String(glossary || '').split(/[\n,]/).map(t => t.trim()).filter(Boolean);
  if (!terms.length) return '';
  return `Spell the following names and terms exactly as written, never translating, abbreviating, or altering them: ${terms.join(', ')}.\n\n`;
}

// Pure helper — per-rule summary depth → an instruction prefix (P5-L).
function depthInstruction(depth) {
  if (depth === 'brief') {
    return 'Keep these notes brief: a short Summary and only the most important points. Omit minor detail and any section with little to say.';
  }
  if (depth === 'detailed') {
    return 'Be especially thorough and detailed: capture full context, rationale, owners, and nuance for every point.';
  }
  return '';
}

// ── Selector registry (RB-1a) ───────────────────────────────────────────────
// Every Meet DOM selector the content script depends on, each an ordered list
// of fallbacks (first match wins). Centralising them turns a silent capture
// failure after a Meet UI change into an observable, diagnosable one — and is
// the foundation for a remote selector hotfix (RB-1b). content_meet.js resolves
// live elements through this map; selectorHealthCheck() probes them on join.
const SELECTORS = {
  leaveButton:  ['button[aria-label="Leave call"]'],
  micOff:       ['button[aria-label="Turn off microphone"]'],
  camOff:       ['button[aria-label="Turn off camera"]'],
  geminiInput:  ['div[aria-label="Ask Gemini"][contenteditable="true"]'],
  submit:       ['button[aria-label="Submit"]'],
  sidePanel:    ['aside[aria-label="Side panel"]'],
  callControls: ['div[aria-label="Call controls"]'],
  // The "Copy" action button Meet renders under a COMPLETED Gemini response
  // (action row: Copy / Report / 👍 / 👎). Its presence is the reliable
  // "the answer has finished" signal — the old "Gemini response" text label
  // was dropped in Meet's 2026-06 redesign.
  geminiCopy:   ['button[jsname="WmNl5c"]', 'button[data-action-type="15"]'],
  // Visible while Gemini is actively streaming a response.
  geminiStop:   ['button[aria-label*="Stop"]'],
};

// Selectors that should always be present once a meeting is joined. Their
// failure indicates a Meet DOM change that breaks capture; geminiInput / submit
// / sidePanel appear only after Gemini activation and are excluded here.
const CRITICAL_SELECTORS = ['leaveButton', 'callControls', 'micOff', 'camOff'];

// Pure helper — return the first selector in `list` for which queryFn yields a
// truthy element, or null. queryFn is injected so this is unit-testable without
// a live DOM. Bad selectors are skipped.
function firstMatchingSelector(list, queryFn) {
  for (const sel of (Array.isArray(list) ? list : [list])) {
    try { if (queryFn(sel)) return sel; } catch { /* invalid selector — skip */ }
  }
  return null;
}

// Pure helper — probe a selector registry. Returns { resolved: {name:selector},
// failed: [names], criticalFailed: [names] }. The caller logs/badges from this.
function selectorHealthCheck(registry, queryFn, critical = CRITICAL_SELECTORS) {
  const resolved = {};
  const failed = [];
  for (const [name, list] of Object.entries(registry || {})) {
    const sel = firstMatchingSelector(list, queryFn);
    if (sel) resolved[name] = sel; else failed.push(name);
  }
  const criticalFailed = failed.filter(n => critical.includes(n));
  return { resolved, failed, criticalFailed };
}

// Pure helper — validate a fetched selectors.json into a safe overrides object
// (RB-1b). Only known registry keys are kept; each value must be a non-empty
// string or array of strings. Anything else is dropped — a malformed remote
// file can never inject arbitrary keys or break the bundled registry.
function sanitizeSelectorOverrides(json, allowedKeys) {
  const allowed = Array.isArray(allowedKeys) ? allowedKeys : Object.keys(SELECTORS);
  const out = {};
  if (!json || typeof json !== 'object') return out;
  for (const key of allowed) {
    const v = json[key];
    if (Array.isArray(v)) {
      const clean = v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
      if (clean.length) out[key] = clean;
    } else if (typeof v === 'string' && v.trim()) {
      out[key] = [v.trim()];
    }
  }
  return out;
}

// Pure helper — overlay validated remote overrides onto the bundled registry
// (RB-1b). A key present in overrides replaces the bundled fallback list; all
// other keys are untouched. Returns a new object (inputs not mutated).
function mergeSelectorOverrides(base, overrides) {
  const merged = { ...(base || {}) };
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (Array.isArray(v) && v.length) merged[k] = v;
    }
  }
  return merged;
}

// Pure response-extraction logic shared between content_meet.js and tests.js.
// Takes an element (the Gemini side-panel aside) and returns the last model
// reply with UI chrome stripped, or null if no response is present.
// content_meet.js wraps this with a live document.querySelector call;
// tests.js passes a mock element directly.
// Strip Gemini's trailing UI chrome + citation artefacts from a raw response string.
function cleanGeminiResponse(text) {
  return String(text || '')
    .replace(/\n\n\nNote:.*$/s, '')       // "Note: No relevant info..." disclaimer
    .replace(/\n+Copy\n.*$/s, '')          // Copy / Report / thumbs feedback row
    .replace(/\n*(\d+\n){1,4}\d+ source.*$/s, '') // citation footer e.g. "1\n1 source"
    .replace(/(?<=[a-zA-Z])\.(\d{1,3})(?=[^a-zA-Z0-9.]|$)/g, '.') // "word.1" → "word."
    // Second citation pass: strip digits directly after letters or closing quotes
    // Handles: "Carlos Sol1" → "Sol", '"move."1' → '"move."'
    // Uses single-digit [1-9] to avoid corrupting "Python 3.11" (digit precedes digit → no match)
    .replace(/(?<=[a-zA-Z"'])([1-9])(?=[\s\n]|$)/gm, '')
    .trim();
}

// Find the "Copy" action button under a completed Gemini response. `copySelectors`
// defaults to SELECTORS.geminiCopy; a locale-dependent text match ("copy") is the
// last resort. Returns the element or null.
function findGeminiCopyButton(root, copySelectors) {
  if (!root || !root.querySelectorAll) return null;
  const sels = Array.isArray(copySelectors) ? copySelectors
    : ((typeof SELECTORS !== 'undefined' && SELECTORS.geminiCopy) || []);
  // Return the LAST match — the latest response's action row is the relevant one.
  for (const s of sels) {
    try { const els = root.querySelectorAll(s); if (els.length) return els[els.length - 1]; }
    catch { /* bad selector */ }
  }
  let last = null;
  for (const b of root.querySelectorAll('button')) {
    const label = ((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || '').trim().toLowerCase();
    if (label === 'copy') last = b;
  }
  return last;
}

// True once the latest Gemini response is fully rendered: a Copy action button is
// present and nothing is actively streaming (no Stop button). Robust to the Meet
// 2026-06 redesign that removed the "Gemini response" text label.
function geminiResponseDone(root, opts) {
  if (!root || !root.querySelector) return false;
  const o = opts || {};
  const stopSels = o.stop || ((typeof SELECTORS !== 'undefined' && SELECTORS.geminiStop) || []);
  for (const s of stopSels) {
    try { if (root.querySelector(s)) return false; } catch { /* bad selector */ }
  }
  return !!findGeminiCopyButton(root, o.copy);
}

// Extract the last Gemini response text from the side-panel element.
// Fast path: legacy panels labelled each reply with "Gemini response\n".
// Fallback (new DOM, no label): anchor on the latest response's Copy action
// button, walk up to its message bubble, drop the action buttons/icons, read text.
function extractLastResponseFromEl(el) {
  if (!el) return null;
  const full = el.innerText ? el.innerText.trim() : '';

  if (full.includes('Gemini response\n')) {
    const parts = full.split('Gemini response\n');
    const out = cleanGeminiResponse(parts[parts.length - 1]);
    if (out) return out;
  }

  const copy = findGeminiCopyButton(el);
  if (!copy || !copy.parentElement) return null;
  const toolbar = copy.parentElement;
  const baseLen = (toolbar.innerText || '').trim().length;
  let bubble = null;
  let node = toolbar;
  while (node && node !== el) {
    const t = (node.innerText || '').trim();
    // Stop before climbing into the composer / suggestion chips.
    if (/Ask Gemini|Summarise the discussion|can make mistakes/i.test(t)) break;
    // First ancestor with clearly more than the action-row text = the message bubble.
    if (t.length > baseLen + 40) { bubble = node; break; }
    node = node.parentElement;
  }
  if (!bubble || !bubble.cloneNode) return null;
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('button, [role="button"], svg').forEach(n => n.remove());
  return cleanGeminiResponse(clone.innerText) || null;
}

// Pure helper — should this send be skipped as a duplicate (D2)? True when the
// stored fingerprint has the same title and was sent within the dedup window.
function shouldSkipDuplicate(stored, title, now, windowMs) {
  return !!(stored && stored.title === title && (now - stored.sentAt) < windowMs);
}

// Pure helper — do the extension and native host disagree on major version (D2)?
// Blank/unknown versions are treated as "no mismatch" (don't nag on first run).
function isVersionMismatch(extVersion, hostVersion) {
  if (!extVersion || !hostVersion) return false;
  return String(extVersion).split('.')[0] !== String(hostVersion).split('.')[0];
}

// True when the background's onInstalled injector should inject the content
// script into a tab — i.e. the probe found NO existing script there.
function shouldInjectContentScript(probeResults) {
  return !(Array.isArray(probeResults) && probeResults[0] && probeResults[0].result);
}

// Pure helper — produces the tab-scoped storage key name.
// Used by popup.js and background.js (background.js defines its own
// one-liner copy since it cannot import constants.js as a service worker).
function tabKey(base, tabId) {
  return `${base}_${tabId}`;
}

// Pure helpers — track which tabs are actively capturing so the REC badge can be
// decided from a tiny array instead of scanning ALL of storage (ARCH-4).
function addCapturingTab(tabs, tabId) {
  const arr = Array.isArray(tabs) ? tabs : [];
  return arr.includes(tabId) ? arr : [...arr, tabId];
}
function removeCapturingTab(tabs, tabId) {
  return (Array.isArray(tabs) ? tabs : []).filter(t => t !== tabId);
}

// Pure helper — append a failed-send entry to the list.
function addFailure(list, entry) {
  return [...(Array.isArray(list) ? list : []), entry];
}

// Pure helper — remove a failed-send entry by tabId (per-tab dedup + tab-close
// cleanup). User-initiated retry/dismiss uses removeFailureByPath instead.
function removeFailure(list, tabId) {
  return (Array.isArray(list) ? list : []).filter(f => f.tabId !== tabId);
}

// Pure helper — removes a failed-send entry by its backupPath. This is the
// identity used by user-initiated retry/dismiss, because the log-retry path
// carries no tabId (tabId is only reliable for per-tab dedup and tab-close
// cleanup).
function removeFailureByPath(list, backupPath) {
  return (Array.isArray(list) ? list : []).filter(f => f.backupPath !== backupPath);
}

// Pure helper — extract the Meet room code from a URL pathname (P9-A3a).
// '/abc-defg-hij?authuser=0' → 'abc-defg-hij'. Returns '' for the root path
// or a missing pathname. The code is the stable per-space identifier.
function extractMeetingCode(pathname) {
  return String(pathname || '').replace(/^\//, '').split(/[?#/]/)[0] || '';
}

// Pure helper — classify a meeting as 'calendar' or 'ad-hoc' from its title
// (P9-A3b). A calendar event supplies a human title; personal/ad-hoc rooms have
// no title (getMeetingTitle returns '' or a 'Personal meeting (code)' label, and
// a bare room code can leak through). All of those are ad-hoc.
const _MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
// Pure helper — is this string a bare Meet room code like "abc-defg-hij"?
// (ARCH-7) Deduped from the inline regex in content_meet.js getMeetingTitle.
function isMeetCode(s) {
  return _MEET_CODE_RE.test(String(s || ''));
}
function inferMeetingType(title) {
  const t = String(title || '').trim();
  if (!t || isMeetCode(t) || /^Personal meeting \(/.test(t)) return 'ad-hoc';
  return 'calendar';
}

// Pure helper — normalise a stored theme value to one of system|light|dark
// (UXF-8). Anything unrecognised (including undefined) falls back to 'system'.
function normalizeTheme(v) {
  return (v === 'light' || v === 'dark') ? v : 'system';
}

// Pure helper — bucket already-built log groups by calendar day (UXF-4) for the
// Date → meeting → entries hierarchy. Preserves the input order (newest first),
// so the newest day floats to the top. Each bucket: { day, ts, groups }.
function bucketLogGroupsByDay(groups) {
  const buckets = [];
  const byDay = new Map();
  for (const g of (Array.isArray(groups) ? groups : [])) {
    const ts = (g.entries && g.entries[0] && g.entries[0].ts) || 0;
    const day = new Date(ts).toDateString();
    if (!byDay.has(day)) {
      const b = { day, ts, groups: [] };
      byDay.set(day, b);
      buckets.push(b);
    }
    byDay.get(day).groups.push(g);
  }
  return buckets;
}

// Pure helper — a stable key for a log/meeting group (UXF-6), used to persist
// which groups the user expanded across re-renders and the 10 s auto-refresh.
// Keyed by calendar day + title so the same meeting keeps its disclosure state.
function logGroupKey(title, ts) {
  const day = new Date(ts).toDateString();
  return `${day}|${title || 'System'}`;
}

// Pure helper — best-outcome status for a log group's entries (UX-7), shown as
// a dot on the collapsed group header. Precedence by severity-of-interest:
// a successful send (ok) wins; else any error; else any warning; else info.
function groupOutcome(entries) {
  const has = s => Array.isArray(entries) && entries.some(e => e.status === s);
  if (has('ok'))   return 'ok';
  if (has('err'))  return 'err';
  if (has('warn')) return 'warn';
  return 'info';
}

// Pure helper — format a prompt-performance log line (P6-C). Captures the
// Gemini flow duration alongside prompt + response sizes so correlation between
// prompt length and latency becomes visible in the Logs tab over many captures.
function formatPerfLog(elapsedMs, promptChars, responseChars) {
  return `perf: Gemini flow ${(elapsedMs / 1000).toFixed(1)}s · prompt ${promptChars} chars · response ${responseChars} chars`;
}

// Pure helper — is the cached snapshot recent enough to use at Leave time
// without a fresh Gemini run (BUG-3)? True when a snapshot exists and completed
// within the last half snapshot-interval, so re-running Gemini would add 20–60 s
// for a result that is already current.
function snapshotFreshEnough(cachedTranscriptAt, intervalMs, now = Date.now()) {
  if (!cachedTranscriptAt) return false;
  return (now - cachedTranscriptAt) < intervalMs / 2;
}

// Pure helper — should the popup offer to recover an in-flight note (RB-1d)?
// content_meet persists the formatted note to mm2c_inflight just before sending
// and clears it on confirmed save. If it's still present and older than the
// grace window when the popup opens, the send never completed (e.g. a crash) —
// offer recovery. The grace window avoids flashing the card during a normal
// in-progress send that will clear within seconds.
function inflightRecoverable(inflight, now = Date.now(), graceMs = 60000) {
  return !!(inflight && typeof inflight.text === 'string' && inflight.text.trim()
            && Number.isFinite(inflight.at) && (now - inflight.at) > graceMs);
}

// Pure helper — the single source of truth for the popup status-banner text and
// CSS class. Centralising this removes the dual-writer race where onTabSelected
// and applyState both wrote #status from independent async callbacks (BUG-C).
// Precedence: capturing > in-meeting message > last status > idle default.
function resolveBanner({ capturing = false, inMeeting = false, geminiActive = false, lastStatus = '' } = {}) {
  if (capturing) return { text: 'Capturing notes…', cls: 'ok' };
  if (inMeeting) {
    return geminiActive
      ? { text: 'In meeting — notes captured when you leave', cls: 'ok' }
      : { text: 'In meeting — open the Gemini panel to enable capture', cls: 'warn' };
  }
  if (lastStatus) {
    const cls = (lastStatus.startsWith('Error') || lastStatus.startsWith('Native host') || lastStatus.startsWith('Host'))
      ? 'err'
      : lastStatus.startsWith('Warning') ? 'warn' : 'ok';
    return { text: lastStatus, cls };
  }
  return { text: 'Not in a meeting', cls: '' };
}

// Pure helper — map an output-app key to its human label (ARCH-7). Moved
// verbatim from content_meet.js; unknown keys pass through unchanged.
function outputAppName(appKey) {
  return ({ craft: 'Craft', apple_notes: 'Apple Notes', none: 'None', obsidian: 'Obsidian', bear: 'Bear' })[appKey] || appKey;
}

// Pure helper — turn one meeting-title candidate into a display title (ARCH-7).
// Empty/whitespace → ''; a bare room code → "Personal meeting (code)"; otherwise
// the trimmed candidate itself.
function meetingTitleFromCandidate(str) {
  const t = (str || '').trim();
  if (!t) return '';
  return isMeetCode(t) ? `Personal meeting (${t})` : t;
}

// Pure helper — extract the meeting title from the browser tab title (ARCH-7).
// "Meet - Foo" → "Foo", "Meet - abc-defg-hij" → "Personal meeting (abc-defg-hij)".
// A non-Meet title (or no match) → ''. Keeps the en-dash variant of the separator.
function meetingTitleFromTab(documentTitle) {
  const m = String(documentTitle || '').match(/^Meet\s*[-–]\s*(.+)$/i);
  return m ? meetingTitleFromCandidate(m[1]) : '';
}

// Pure helper — is this a plausible attendee display name (ARCH-7)? Filters out
// empties, single chars, over-long strings, and pure-numeric ids.
function isValidAttendeeName(n) {
  const s = (n || '').trim();
  return s.length > 1 && s.length < 80 && !/^\d+$/.test(s);
}
