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
  'Format everything as plain text. Do not use asterisks, underscores, backticks, or any other markdown formatting characters.';

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
  'Carlos to confirm dates with the infrastructure team.';

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

// Pure helper — return the prompt of the first rule whose regex matches the
// meeting title, or null when none match. Shared by content_meet.js (live
// matching) and tests.js. Invalid regexes are skipped silently.
function matchPromptRule(rules, meetingTitle) {
  if (!Array.isArray(rules)) return null;
  const title = meetingTitle || '';
  for (const r of rules) {
    if (!r?.regex) continue;
    try {
      if (new RegExp(r.regex, 'i').test(title)) return r.prompt?.trim() || null;
    } catch { /* invalid regex — skip */ }
  }
  return null;
}

// Pure response-extraction logic shared between content_meet.js and tests.js.
// Takes an element (the Gemini side-panel aside) and returns the last model
// reply with UI chrome stripped, or null if no response is present.
// content_meet.js wraps this with a live document.querySelector call;
// tests.js passes a mock element directly.
function extractLastResponseFromEl(el) {
  const full = el?.innerText?.trim() || '';
  const parts = full.split('Gemini response\n');
  if (parts.length < 2) return null;
  return parts[parts.length - 1]
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

// Pure helper — produces the tab-scoped storage key name.
// Used by popup.js and background.js (background.js defines its own
// one-liner copy since it cannot import constants.js as a service worker).
function tabKey(base, tabId) {
  return `${base}_${tabId}`;
}

// Pure helper — removes a failed-send entry by its backupPath. This is the
// identity used by user-initiated retry/dismiss, because the log-retry path
// carries no tabId (tabId is only reliable for per-tab dedup and tab-close
// cleanup). background.js keeps a one-liner copy.
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
function inferMeetingType(title) {
  const t = String(title || '').trim();
  if (!t || _MEET_CODE_RE.test(t) || /^Personal meeting \(/.test(t)) return 'ad-hoc';
  return 'calendar';
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
  return { text: 'Not in a meeting.', cls: '' };
}
