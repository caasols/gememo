#!/usr/bin/env python3
"""
Native messaging host for the Gememo Chrome extension.

Receives one transcript message from Chrome, parses it, and pushes it directly
to Craft via craftdocs://. No watcher process required.

Chrome communicates via stdin/stdout using the native messaging wire format:
  - 4-byte little-endian length prefix
  - UTF-8 JSON payload
"""

from __future__ import annotations

import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

# Resolve through the install symlink so sibling modules (gcal.py) import at
# runtime whether run directly or via the symlinked wrapper.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gcal  # 5.3 — Google Calendar enrichment (self-guards if google libs absent)
import gdocs  # 5.7 — Google Docs output (self-guards; separate OAuth grant + token)
import gauth  # combined one-flow Google connect (Calendar + Docs in one consent)

HOST_VERSION = '0.2.36'  # in lockstep with manifest.json (major stays 0 → re-run install.sh only to refresh the shown version; not required for compatibility)

SCRIPT_DIR = Path(__file__).parent
# push_to_craft.py is copied alongside the host during install.
# Fall back to the project scripts/ dir when running from source.
_push_local = SCRIPT_DIR / "push_to_craft.py"
_push_dev   = SCRIPT_DIR.parent / "scripts" / "push_to_craft.py"
PUSH_PY     = _push_local if _push_local.exists() else _push_dev
CACHE_DIR   = Path.home() / ".cache" / "mm2c"
HEARTBEAT_FILE = CACHE_DIR / "host_heartbeat.log"   # BUG-9 Layer 0 stage trail
_HEARTBEAT_MAX_BYTES = 64 * 1024

# Exit-code → human message map (must match push_to_craft.py exit codes).
_PUSH_EXIT_MESSAGES = {
    1: 'Craft is not running — open Craft and try again',
    2: 'Note file not found — try capturing again',
    3: 'Could not open Craft URL',
}


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    length = struct.unpack("<I", raw_len)[0]
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode("utf-8"))


def send_message(data: dict) -> None:
    encoded = json.dumps(data).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _heartbeat(stage: str) -> None:
    """Append one fsync'd line to the heartbeat log so the last stage reached is
    durable across a SIGKILL (BUG-9 diagnosis). Best-effort — never raises."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        line = f"{datetime.now().astimezone().isoformat()} pid={os.getpid()} {stage}\n"
        with open(HEARTBEAT_FILE, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
    except Exception:
        pass


def _heartbeat_rotate() -> None:
    """Trim the heartbeat log to its last lines when it exceeds the size cap.
    Best-effort — never raises."""
    try:
        if HEARTBEAT_FILE.exists() and HEARTBEAT_FILE.stat().st_size > _HEARTBEAT_MAX_BYTES:
            data = HEARTBEAT_FILE.read_text(encoding="utf-8", errors="replace")
            tail = data[-_HEARTBEAT_MAX_BYTES:]          # bound to the cap
            nl = tail.find("\n")
            HEARTBEAT_FILE.write_text(tail[nl + 1:] if nl != -1 else tail, encoding="utf-8")
    except Exception:
        pass


_PII_EMAIL = re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b')
# Credit-card-like: 13–19 digits in groups of 1+ separated by spaces/dashes.
_PII_CARD = re.compile(r'\b(?:\d[ -]?){13,19}\b')
# Phones, high-precision to avoid eating dates/IDs: international (+…),
# dashed/dotted groups, or a 10+ digit run.
_PII_PHONE = (
    re.compile(r'\+\d[\d\s().-]{7,}\d'),
    re.compile(r'\b\d{3}[-.]\d{3}[-.]\d{4}\b'),
    re.compile(r'\b\d{10,}\b'),
)


def _ics_escape(s: str) -> str:
    return (s.replace('\\', '\\\\').replace(';', '\\;')
             .replace(',', '\\,').replace('\n', '\\n'))


_DEFAULT_BACKUP_PATH = "~/Documents/gememo-meeting-notes"


def _resolve_backup_path(raw, home=None):
    """Resolve a stored backup folder agnostically of which Mac account saved it.

    The extension stores a folder path, but that path can be saved on one laptop
    and run on another (e.g. a personal vs. work account with an iCloud-synced
    Documents folder). Only the part *below* the home dir is meaningful:
      - '~/…'                       → expand against the CURRENT home
      - '/Users/<anyone>/<rest>'    → re-home <rest> under the CURRENT home
      - anything else (e.g. /Volumes/…) → left as-is
    `home` is injectable for testing; defaults to the real home (BUG-12)."""
    home = home or Path.home()
    raw = (str(raw).strip() if raw is not None else "") or _DEFAULT_BACKUP_PATH
    if raw.startswith("~"):
        rest = raw[1:].lstrip("/")
        return home / rest if rest else home
    parts = Path(raw).parts
    if len(parts) >= 3 and parts[1] == "Users":   # /Users/<name>/<rest…>
        return home.joinpath(*parts[3:])
    return Path(raw)


def _homerel_path(abs_path, home=None):
    """Store a picked folder agnostically: an absolute path under the current home
    becomes '~/…' so it travels across machines/users. Anything else is unchanged."""
    home = home or Path.home()
    try:
        return str(Path("~") / Path(abs_path).relative_to(home))
    except (ValueError, TypeError):
        return abs_path


def build_ics(steps, dt, meeting_title: str = '') -> str:
    """Build a VCALENDAR with one all-day VEVENT per Next Step line (RB-3b).

    Steps are freeform follow-ups; each becomes an all-day reminder on the
    meeting date (deterministic — no fuzzy date parsing). CRLF line endings per
    RFC 5545. Returns '' when there are no usable steps.
    """
    clean = [s.strip().lstrip('-•* ').strip() for s in (steps or []) if s and s.strip()]
    clean = [s for s in clean if s]
    if not clean:
        return ''
    date  = dt.strftime('%Y%m%d')
    stamp = dt.strftime('%Y%m%dT%H%M%S')
    out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gememo//Meeting Notes//EN']
    for i, step in enumerate(clean):
        out += [
            'BEGIN:VEVENT',
            f'UID:{stamp}-{i}@gememo',
            f'DTSTAMP:{stamp}',
            f'DTSTART;VALUE=DATE:{date}',
            f'SUMMARY:{_ics_escape(step)}',
        ]
        if meeting_title:
            out.append(f'DESCRIPTION:{_ics_escape("From: " + meeting_title)}')
        out.append('END:VEVENT')
    out.append('END:VCALENDAR')
    return '\r\n'.join(out) + '\r\n'


def redact_pii(text, keywords=None):
    """Strip emails, phone numbers, card-like numbers, and user keywords from a
    note before it is written/sent (RB-5b). Best-effort, order matters: emails
    and cards first so the broad phone patterns can't mangle them.
    """
    if not text:
        return text
    text = _PII_EMAIL.sub('[redacted-email]', text)
    text = _PII_CARD.sub('[redacted-number]', text)
    for pat in _PII_PHONE:
        text = pat.sub('[redacted-phone]', text)
    for kw in (keywords or []):
        kw = (kw or '').strip()
        if kw:
            text = re.sub(re.escape(kw), '[redacted]', text, flags=re.IGNORECASE)
    return text


def parse_transcript(text: str) -> tuple[str, str]:
    lines = text.strip().splitlines()
    title = ""
    body_lines = []

    for line in lines:
        if line.startswith("TITLE: ") and not title:
            title = line[7:].strip()
        else:
            body_lines.append(line)

    body = "\n".join(body_lines).strip()

    # Gemini sometimes copies the ---Heading pattern from the EXAMPLE_NOTES
    # delimiter format (e.g. "---Attendees" as one token). Strip the leading
    # dashes so the heading normalisation regex below can promote it correctly.
    body = re.sub(r'^-{3,}(?=[^\s-])', '', body, flags=re.MULTILINE)

    body = re.sub(
        r'^#{0,3}\s*\*{0,2}(Action Items|Attendees|Summary|Key Points|Decisions Made|Open Questions|Next Steps)\*{0,2}:?\s*$',
        r'## \1', body, flags=re.MULTILINE | re.IGNORECASE
    )

    # Strip Meet-generated trailing digits from attendee names.
    # When participants share a display name Meet appends a number suffix
    # (e.g. "Carlos Sol1", "Alice2"). Apply only inside the Attendees block
    # so legitimate numbers elsewhere in the notes are not affected.
    #
    # Narrowed to capital-first tokens only (proper nouns) to avoid false
    # positives like "ext.4321" or phone numbers in parenthetical suffixes.
    # Each line is split on the first "(" so the name portion is cleaned
    # independently of any parenthetical annotation.
    def _clean_attendee_line(line: str) -> str:
        parts = line.split('(', 1)
        name_part = re.sub(r'\b([A-Z][a-z]+)\d+\b', r'\1', parts[0])
        return name_part + ('(' + parts[1] if len(parts) > 1 else '')

    body = re.sub(
        r'(## Attendees\n)(.*?)(?=\n## |\Z)',
        lambda m: m.group(1) + '\n'.join(
            _clean_attendee_line(ln) for ln in m.group(2).split('\n')
        ),
        body,
        flags=re.DOTALL,
    )

    # Strip markdown bold (**text**) and inline code (`text`) that Gemini
    # sometimes produces despite the plain-text instruction in the prompt.
    body = re.sub(r'\*\*(.+?)\*\*', r'\1', body, flags=re.DOTALL)
    body = re.sub(r'`([^`]+)`',      r'\1', body)

    # Strip separator lines (---) that Gemini copies from example format delimiters.
    body = re.sub(r'^-{3,}\s*$', '', body, flags=re.MULTILINE)
    body = re.sub(r'\n{3,}', '\n\n', body)   # collapse extra blank lines created by removal

    return title, body


def render_title_template(template: str, dt: datetime, name: str = '',
                          meeting_type: str = '', code: str = '') -> str:
    """Render a per-rule note title from a template (RB-4d). Placeholders:
      {date} → YYYYMMDD · {time} → HH:MM · {name} → meeting label ·
      {type} → calendar|ad-hoc · {code} → Meet room code.
    A blank template falls back to the default 'YYYYMMDD HH:MM name' format.
    Collapses doubled spaces left by empty placeholders.
    """
    name = (name or 'Meeting').strip()
    default = f"{dt.strftime('%Y%m%d %H:%M')} {name}"
    if not template or not template.strip():
        return default
    repl = {
        '{date}': dt.strftime('%Y%m%d'),
        '{time}': dt.strftime('%H:%M'),
        '{name}': name,
        '{type}': meeting_type or '',
        '{code}': code or '',
    }
    out = template
    for k, v in repl.items():
        out = out.replace(k, v)
    out = re.sub(r'\s{2,}', ' ', out).strip(' -—·|')
    return out or default


def extract_tags(body: str):
    """Pull a 'Tags: a, b, c' line out of the note body (RB-4c).

    Returns (tags_list, body_without_that_line). Tags are lowercased, spaces →
    hyphens, deduped, capped at 5. Returns ([], body) when no Tags line exists.
    """
    m = re.search(r'^\s*tags:\s*(.+?)\s*$', body, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return [], body
    tags: list[str] = []
    for raw in re.split(r'[,•;]', m.group(1)):
        slug = re.sub(r'\s+', '-', raw.strip().lower())
        slug = re.sub(r'[^a-z0-9\-/]', '', slug)
        if slug and slug not in tags:
            tags.append(slug)
        if len(tags) >= 5:
            break
    cleaned = body[:m.start()] + body[m.end():]
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip()
    return tags, cleaned


def apply_wikilinks(body: str, attendees: list | None) -> str:
    """Wrap each attendee's name in [[ ]] throughout the note body (RB-4e), so
    every meeting note becomes a node in the user's Obsidian/Craft graph.

    Names are wrapped longest-first so 'Bob Martinez' is linked before 'Bob';
    a negative lookbehind for '[' keeps already-wrapped names from being
    double-linked. Off by default — only sent when the user enables wikilinks.
    """
    names = sorted(
        {(n or '').strip() for n in (attendees or []) if (n or '').strip()},
        key=len, reverse=True,
    )
    for name in names:
        body = re.sub(rf'(?<!\[)\b{re.escape(name)}\b(?!\]\])', f'[[{name}]]', body)
    return body


def build_provenance_footer(dt: datetime) -> str:
    """Return the provenance footer appended to every captured note (UXC-22).

    Gives an anonymous file in Craft/Obsidian/Notes a durable signal of where it
    came from and that it was AI-assisted. Plain text (no markdown) so it reads
    the same in every destination. Leading blank lines separate it from the body.
    """
    return (
        "\n\nCaptured automatically by Gememo · "
        f"{dt.strftime('%Y-%m-%d')} · source: Google Meet + Gemini"
    )


def build_yaml_frontmatter(
    title: str,
    dt: datetime,
    snapshot: bool = False,
    attendees: list | None = None,
    duration_min: int | None = None,
    meeting_code: str | None = None,
    meeting_type: str | None = None,
    recording: bool = False,
    topic_tags: list | None = None,
    cal_fields: dict | None = None,
) -> str:
    """Return a YAML front-matter block for a .md backup file.

    Only called for .md files — callers guard on file_ext == '.md'.
    The snapshot flag is set to true for intermediate snapshots so they
    are distinguishable from the final capture in Obsidian / Bear / Notion.
    Attendees and duration_min are optional; omitted when empty/None.
    meeting_code (the Meet room code) and meeting_type ('calendar'|'ad-hoc')
    are optional metadata from the Meet DOM; omitted when empty/None.
    """
    safe_title = title.replace('\\', '\\\\').replace('"', '\\"')
    lines = [
        "---",
        f"date: {dt.strftime('%Y-%m-%d')}",
        f'title: "{safe_title}"',
        "source: google-meet",
    ]
    if snapshot:
        lines.append("snapshot: true")
    if meeting_code:
        lines.append(f"meeting_code: {meeting_code}")
    if meeting_type:
        lines.append(f"meeting_type: {meeting_type}")
    if recording:
        lines.append("recording: true")
    if attendees:
        lines.append("attendees:")
        for name in attendees:
            lines.append(f"  - {name}")
    if duration_min is not None:
        lines.append(f"duration_min: {duration_min}")
    if cal_fields:
        cf = cal_fields
        if cf.get('recurring_event_id'):
            lines.append(f"recurring_event_id: {cf['recurring_event_id']}")
        if cf.get('organizer'):
            lines.append(f"organizer: {cf['organizer']}")
        if cf.get('scheduled_start'):
            lines.append(f"scheduled_start: {cf['scheduled_start']}")
        if cf.get('scheduled_end'):
            lines.append(f"scheduled_end: {cf['scheduled_end']}")
        if cf.get('scheduled_duration_min') is not None:
            lines.append(f"scheduled_duration_min: {cf['scheduled_duration_min']}")
        if cf.get('attendee_emails'):
            lines.append("attendee_emails:")
            for em in cf['attendee_emails']:
                lines.append(f"  - {em}")
        if cf.get('description'):
            folded = ' '.join(str(cf['description']).split())
            safe = folded.replace('\\', '\\\\').replace('"', '\\"')
            lines.append(f'description: "{safe}"')
    all_tags = ['meeting', dt.strftime('%Y/%m')] + [t for t in (topic_tags or []) if t]
    lines.append(f"tags: [{', '.join(all_tags)}]")
    lines.append("---")
    return "\n".join(lines) + "\n"


def body_to_html(text: str) -> str:
    """Convert plain-text meeting notes to Apple Notes-compatible HTML.

    Rules:
    - Lines matching ^-{3,}$ (separator artifacts from Gemini) → skipped
    - '## Heading' → <h2>Heading</h2> (with <br> prefix for all but the first)
    - Lines starting with '- ' or '• ' → grouped into <ul><li>…</li></ul>
    - Blank lines → paragraph break (each blank-separated prose block → own <p>)
    - Empty blocks (blank lines between heading and next heading) → no output
    - Everything else → each blank-line-delimited block → <p>…</p>
    """
    import re as _re
    if not text.strip():
        return ''
    lines = text.splitlines()
    parts: list[str] = []
    first_heading = True
    i = 0
    while i < len(lines):
        line = lines[i]
        if _re.match(r'^-{3,}$', line.strip()):
            i += 1  # skip separator artifact
        elif line.startswith('## '):
            prefix = '' if first_heading else '<br>'
            parts.append(f'{prefix}<h2>{line[3:].strip()}</h2>')
            first_heading = False
            i += 1
        elif line.startswith('- ') or line.startswith('• '):
            items: list[str] = []
            while i < len(lines) and (lines[i].startswith('- ') or lines[i].startswith('• ')):
                items.append(f'<li>{lines[i][2:].strip()}</li>')
                i += 1
            parts.append('<ul>' + ''.join(items) + '</ul>')
        elif not line.strip():
            i += 1  # blank line — prose blocks are collected one at a time below
        else:
            # Each non-blank prose line → its own <p> for clear visual separation.
            # Blank lines are already skipped above, so each pass here handles one line.
            parts.append('<p>' + line.strip() + '</p>')
            i += 1
    return ''.join(parts)


def build_apple_notes_body(title: str, body_html: str) -> str:
    """Lead the note body with the title as an <h1>.

    Apple Notes renders an AppleScript `name` property as a plain, un-styled
    first line (smaller than its bold <h2> "Heading" style), which made the
    meeting title look demoted below the section headings. Instead we omit
    `name` entirely and lead the body with an <h1> — Notes renders that in its
    24px "Title" style and derives the note name from it, so the title shows
    exactly once and properly styled. A <br> separates it from the first
    heading. The title is HTML-escaped so '&', '<', '>', '"' aren't mangled.
    """
    import html as _html
    if not title.strip():
        return body_html
    return f'<h1>{_html.escape(title.strip())}</h1><br>' + body_html


def push_to_apple_notes(title: str, body_html: str) -> str | None:
    """Push a note to Apple Notes via osascript; return the created note's id.

    HTML body is written to a temp file to avoid AppleScript string-escaping
    issues with embedded quotes, backslashes, and newlines. The note name is
    derived by Apple Notes from the leading <h1> (see build_apple_notes_body),
    so no `name` property is set here.

    Returns the note id (an `x-coredata://…` URI) so callers can deep-link back
    to the note later, or None if the id can't be read (the save still succeeds).
    Raises subprocess.CalledProcessError on osascript failure.
    """
    import tempfile
    full_body = build_apple_notes_body(title, body_html)
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.html', delete=False, encoding='utf-8'
    ) as f:
        f.write(full_body)
        tmp_path = f.name
    try:
        script = (
            f'set noteBody to read (POSIX file "{tmp_path}") as «class utf8»\n'
            f'tell application "Notes"\n'
            f'  set theNote to make new note with properties {{body:noteBody}}\n'
            f'  return id of theNote\n'
            f'end tell'
        )
        # timeout guards against AppleScript hanging on a modal/permission prompt,
        # which would otherwise block the native host (and Chrome's port) forever.
        proc = subprocess.run(['osascript', '-e', script], check=True,
                              capture_output=True, text=True, timeout=30)
        note_id = (getattr(proc, 'stdout', '') or '').strip()
        return note_id or None
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def open_apple_note(note_id: str) -> bool:
    """Bring the Apple Notes note with this id to the front.

    Returns True if the note was shown, False if it no longer exists (so the
    caller can drop the stored deep-link reference). Bounded by a timeout so a
    permission/modal prompt can't hang the host.
    """
    if not note_id:
        return False
    safe_id = note_id.replace('"', '')  # coredata URIs carry no quotes; strip defensively
    script = (
        f'tell application "Notes"\n'
        f'  try\n'
        f'    show note id "{safe_id}"\n'
        f'    activate\n'
        f'    return "ok"\n'
        f'  on error\n'
        f'    return "not_found"\n'
        f'  end try\n'
        f'end tell'
    )
    try:
        proc = subprocess.run(['osascript', '-e', script],
                              capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return False
    return (getattr(proc, 'stdout', '') or '').strip() == 'ok'


def notify(title: str, message: str) -> None:
    script = f'display notification "{message}" with title "{title}"'
    try:
        subprocess.run(["osascript", "-e", script], check=False, capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        pass  # best-effort notification — never block on it


def prune_snapshots(backup_path: Path, slug: str, file_ext: str, keep: int = 3) -> None:
    """Delete all but the `keep` most-recently-modified snapshot files for this slug."""
    pattern = f"*-{slug}-snap{file_ext}"
    snap_files = sorted(
        backup_path.glob(pattern),
        key=lambda p: p.stat().st_mtime,
    )
    for old_file in snap_files[:-keep] if len(snap_files) > keep else []:
        try:
            old_file.unlink()
        except OSError:
            pass


def cleanup_backups(backup_path, cfg, now=None, stamp_path=None, throttle=True):
    """Retention-prune the backup folder (UXF-13). Best-effort; never raises.

    cfg = {'snapshots': {'enabled': bool, 'days': int},
           'finalNotes': {'enabled': bool, 'days': int}}.
    Snapshots = *-snap.md/.txt; final notes = other .md/.txt (incl *-RECOVERED.md).
    .ics files are never touched. A file is deleted only if its rule is enabled AND
    its mtime is older than that rule's retention days. Both rules off ⇒ no-op.
    Throttled to once/24h via a stamp file unless throttle=False. Returns the list
    of deleted Paths (for tests).
    """
    cfg = cfg or {}
    snap = cfg.get('snapshots') or {}
    fin = cfg.get('finalNotes') or {}
    snap_on, snap_days = bool(snap.get('enabled')), int(snap.get('days', 30))
    fin_on, fin_days = bool(fin.get('enabled')), int(fin.get('days', 30))
    if not snap_on and not fin_on:
        return []
    if now is None:
        now = time.time()
    stamp = Path(stamp_path) if stamp_path else (Path.home() / '.cache' / 'mm2c' / 'last_cleanup')
    if throttle and stamp.exists():
        try:
            if (now - stamp.stat().st_mtime) < 86400:
                return []
        except OSError:
            pass
    folder = Path(backup_path).expanduser()
    deleted = []
    if folder.is_dir():
        for p in folder.iterdir():
            if p.suffix not in ('.md', '.txt'):
                continue
            is_snap = p.name.endswith('-snap.md') or p.name.endswith('-snap.txt')
            rule_on, days = (snap_on, snap_days) if is_snap else (fin_on, fin_days)
            if not rule_on:
                continue
            try:
                if (now - p.stat().st_mtime) > days * 86400:
                    p.unlink()
                    deleted.append(p)
            except OSError:
                pass
    # Record the run so the next capture within 24h skips (set mtime = now for tests).
    try:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.touch()
        os.utime(stamp, (now, now))
    except OSError:
        pass
    return deleted


def handle_snapshot(msg: dict) -> None:
    """Write a timestamped snapshot file to the backup folder and prune old ones."""
    file_backup_type = msg.get("fileBackupType", "markdown")
    file_backup_path = _resolve_backup_path(msg.get("fileBackupPath"))
    transcript       = msg.get("transcript", "").strip()
    if not transcript:
        return

    file_backup_path.mkdir(parents=True, exist_ok=True)

    timestamp_str = msg.get("timestamp", "")
    try:
        # Parse as UTC-aware then convert to local system timezone so filenames
        # and titles reflect wall-clock time rather than UTC.
        dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        dt = datetime.now()  # local time as fallback

    meeting_title = msg.get("meetingTitle", "").strip()
    label         = meeting_title or "Meeting"
    date_prefix   = dt.strftime("%Y%m%d")
    time_str      = dt.strftime("%H%M%S")
    slug          = _file_slug(label)

    file_ext  = ".txt" if file_backup_type == "txt" else ".md"
    snap_path = file_backup_path / f"{date_prefix}-{time_str}-{slug}-snap{file_ext}"
    fm = build_yaml_frontmatter(label, dt, snapshot=True) if file_ext == ".md" else ""
    snap_path.write_text(fm + transcript, encoding="utf-8")

    prune_snapshots(file_backup_path, slug, file_ext, keep=3)


def choose_retry_file(
    title: str,
    backup_path_str: str,
    now: float | None = None,
    cache_dir: Path | None = None,
) -> tuple[Path | None, str]:
    """Return (file_path, source) for the best available retry content.

    Priority:
    1. cache_dir/{safe_title}.md — the full final capture, if < 2 hours old
    2. backup_path_str — the snapshot file on disk (older but persistent)

    Returns (None, '') when nothing is available.
    cache_dir defaults to CACHE_DIR; now defaults to time.time().
    Both are injectable for testing.
    """
    if now is None:
        now = time.time()
    if cache_dir is None:
        cache_dir = CACHE_DIR

    safe_title = re.sub(r'[^\w\s\-]', '', title)[:80].strip()
    if safe_title:
        cache_file = cache_dir / f"{safe_title}.md"
        try:
            if cache_file.exists() and (now - cache_file.stat().st_mtime) <= 7200:
                return cache_file, 'cache'
        except OSError:
            pass

    if backup_path_str:
        bp = Path(backup_path_str)
        if bp.exists():
            return bp, 'backup'

    return None, ''


_WEBHOOK_SECTIONS = ['Attendees', 'Summary', 'Key Points', 'Decisions Made',
                     'Action Items', 'Next Steps', 'Open Questions']


def parse_note_sections(body: str) -> dict:
    """Split a note body into {snake_case_heading: text} for the webhook payload.

    Tolerates `##`, `**`, and plain headings. Unknown lines before any heading
    are ignored; missing sections are simply absent from the dict.
    """
    heading_re = re.compile(
        r'^#{0,3}\s*\*{0,2}\s*(' + '|'.join(re.escape(s) for s in _WEBHOOK_SECTIONS) + r')\s*\*{0,2}\s*:?\s*$',
        re.IGNORECASE,
    )
    sections: dict = {}
    current = None
    buf: list = []

    def flush():
        if current is not None:
            sections[current] = '\n'.join(buf).strip()

    for line in (body or '').split('\n'):
        m = heading_re.match(line.strip())
        if m:
            flush()
            current = m.group(1).lower().replace(' ', '_')
            buf = []
        elif current is not None:
            buf.append(line)
    flush()
    return sections


def build_webhook_payload(title: str, date_str: str, attendees, duration_min, sections: dict) -> dict:
    """Build the JSON payload POSTed to a generic webhook (P9-D)."""
    return {
        'title': title,
        'date': date_str,
        'attendees': attendees or [],
        'duration_min': duration_min,
        'summary': sections.get('summary', ''),
        'key_points': sections.get('key_points', ''),
        'decisions': sections.get('decisions_made', ''),
        'action_items': sections.get('action_items', ''),
        'next_steps': sections.get('next_steps', ''),
        'open_questions': sections.get('open_questions', ''),
    }


def build_slack_payload(title: str, sections: dict) -> dict:
    """Build a Slack incoming-webhook message from the note (P9-B): bold title,
    the Summary, and a count of action items."""
    summary = (sections.get('summary') or '').strip()
    ai = (sections.get('action_items') or '').strip()
    ai_count = len([ln for ln in ai.split('\n') if ln.strip()]) if ai else 0
    text = f"*{title}*"
    if summary:
        text += f"\n{summary}"
    text += f"\n\n*Action items:* {ai_count}"
    return {"text": text}


def post_webhook(url: str, payload: dict, timeout: float = 8.0) -> tuple[bool, str]:
    """POST payload as JSON to url. Best-effort; returns (ok, error_message)."""
    import json as _json
    import urllib.request
    try:
        data = _json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST',
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= resp.status < 300:
                return True, ''
            return False, f'webhook returned HTTP {resp.status}'
    except Exception as exc:
        return False, str(exc)


def _note_title_from(text: str, path: Path) -> str:
    """Best note title: YAML `title:` if present, else a readable filename slug."""
    m = re.search(r'^title:\s*"?(.*?)"?\s*$', text, re.MULTILINE)
    if m and m.group(1).strip():
        return m.group(1).strip()
    stem = re.sub(r'-snap$', '', path.stem)
    stem = re.sub(r'^\d{8}(-\d{6})?-', '', stem)
    return stem.replace('-', ' ').strip() or path.stem


def _note_date_from(text: str, path: Path) -> str:
    """Best note date: YAML `date:` if present, else the filename YYYYMMDD prefix."""
    m = re.search(r'^date:\s*(\d{4}-\d{2}-\d{2})', text, re.MULTILINE)
    if m:
        return m.group(1)
    fm = re.match(r'(\d{8})', path.stem)
    if fm:
        d = fm.group(1)
        return f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
    return ''


def _snippet_around(text: str, q_lower: str, width: int = 80) -> str:
    """A single-line snippet of context around the first match of q_lower."""
    idx = text.lower().find(q_lower)
    if idx < 0:
        return ''
    start = max(0, idx - width // 2)
    end   = min(len(text), idx + len(q_lower) + width // 2)
    snippet = ' '.join(text[start:end].split())
    return ('…' if start > 0 else '') + snippet + ('…' if end < len(text) else '')


def note_slug(label: str) -> str:
    """Normalise a meeting label to a comparable slug (P9-C series matching)."""
    return re.sub(r'[^\w]+', '-', (label or '').lower()).strip('-')[:50]


def find_prior_note(label: str, backup_dir, today: str | None = None):
    """Most-recent prior final note for the same meeting series, or None (P9-C).

    Matches on the slug of each note's frontmatter title (the meeting label),
    excludes snapshot files and any note dated today (the current meeting), and
    returns the newest remaining match by filename date prefix.
    """
    base = Path(backup_dir).expanduser()
    target = note_slug(label)
    if not target or not base.exists():
        return None
    today = today or datetime.now().strftime('%Y%m%d')
    candidates = []
    for p in base.glob('*.md'):
        if p.name.endswith('-snap.md') or p.stem[:8] == today:
            continue
        try:
            text = p.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        if note_slug(_note_title_from(text, p)) == target:
            candidates.append(p)
    return max(candidates, key=lambda p: p.name) if candidates else None


def build_prior_context(note_text: str, date_str: str) -> str:
    """Build the recurring-context prompt prefix from a prior note (P9-C).

    Pulls the previous Summary and Action Items; returns '' when neither exists.
    """
    sections = parse_note_sections(note_text)
    summary = sections.get('summary', '').strip()
    actions = sections.get('action_items', '').strip()
    if not summary and not actions:
        return ''
    header = (f"Context from the previous session of this recurring meeting ({date_str}):"
              if date_str else "Context from the previous session of this recurring meeting:")
    parts = [header]
    if summary:
        parts.append(f"Previous summary: {summary}")
    if actions:
        parts.append(f"Previous open action items:\n{actions}")
    parts.append("Build on this where relevant, but do not repeat it verbatim — "
                 "focus on what is new or changed in the current meeting.")
    return '\n'.join(parts)


def search_notes(query: str, backup_dir, limit: int = 20,
                 since: str = None, until: str = None, attendee: str = None) -> list:
    """Full-text search over final-note .md files in backup_dir (P9-E, RB-6b).

    Case-insensitive substring match, newest-first. Snapshot files (`*-snap.md`)
    are excluded so each meeting appears once. Optional filters: `since`/`until`
    (inclusive YYYY-MM-DD bounds on the note date) and `attendee` (name must
    appear in the note). Each result is {file, title, date, snippet}. Returns []
    for an empty query or missing dir.
    """
    if not query or not query.strip():
        return []
    base = Path(backup_dir).expanduser()
    if not base.exists():
        return []
    q = query.strip().lower()
    att = (attendee or '').strip().lower()
    files = sorted(
        (p for p in base.glob('*.md') if p.is_file() and not p.name.endswith('-snap.md')),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    results = []
    for f in files:
        try:
            text = f.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        low = text.lower()
        if q not in low:
            continue
        if att and att not in low:
            continue
        date = _note_date_from(text, f)
        if since and date and date < since:
            continue
        if until and date and date > until:
            continue
        results.append({
            'file': str(f),
            'title': _note_title_from(text, f),
            'date': date,
            'snippet': _snippet_around(text, q),
        })
        if len(results) >= limit:
            break
    return results


def retry_title_fallback(title: str, file_path: Path) -> str:
    """Return the title, or a readable fallback derived from the backup filename.

    A failed send from an untitled meeting (ad-hoc / personal room with no
    calendar name) carries an empty title. Rather than reject the retry, derive
    a name from the backup filename: strip the date/time prefix and the `-snap`
    suffix, turn dashes into spaces (BUG-6).
    """
    if title and title.strip():
        return title.strip()
    stem = Path(file_path).stem
    stem = re.sub(r'-snap$', '', stem)
    stem = re.sub(r'^\d{8}(-\d{6})?-', '', stem)
    cleaned = stem.replace('-', ' ').strip()
    return cleaned or 'Recovered meeting note'


def handle_retry(msg: dict) -> None:
    """Re-push a previously failed note to Craft.

    Uses choose_retry_file to select the freshest available content,
    then calls push_to_craft.py the same way main() does.
    """
    title           = msg.get("title", "").strip()
    backup_path_str = msg.get("backupPath", "").strip()

    # A valid backup path is enough to recover — the title is only used to label
    # the Craft note and (as a fallback) to locate the cache file by slug. Only
    # reject when we have neither a title nor a backup path (BUG-6).
    if not title and not backup_path_str:
        send_message({"status": "error", "error": "No title or backup path provided for retry"})
        return

    use_file, source = choose_retry_file(title, backup_path_str)

    if use_file is None:
        send_message({
            "status": "error",
            "error": "No recoverable file found — cache expired and backup unavailable",
        })
        return

    # Derive a readable title from the backup filename when the meeting had none.
    title = retry_title_fallback(title, use_file)

    # BUG-11 B: honor the user's PRIMARY output app instead of always pushing to
    # Craft. Non-Craft apps go through the same route_output dispatch a normal
    # capture uses (it sends its own reply); Craft / none / unknown fall through
    # to the push_to_craft path below.
    output_app = (msg.get("backupType") or "craft").strip()
    if output_app in ('obsidian', 'apple_notes', 'bear', 'google_docs'):
        try:
            body = _strip_frontmatter(use_file.read_text(encoding='utf-8'))
            file_dt = datetime.fromtimestamp(use_file.stat().st_mtime)
            # BUG-11 Fix C: route_output now RETURNS a per-destination result dict
            # instead of sending — handle_retry sends the {status} reply itself.
            result = route_output(output_app, body, title, use_file,
                                  obsidian_vault_path=msg.get("obsidianVaultPath", ""),
                                  dt=file_dt, label=title)
            if result is not None:
                if result.get("ok"):
                    reply: dict = {"status": "ok", "title": title, "source": source}
                    if result.get("link"):
                        reply["link"] = result["link"]
                    send_message(reply)
                else:
                    send_message({"status": "error",
                                  "error": result.get("error", "failed")})
                return
        except Exception as exc:
            send_message({"status": "error", "error": str(exc)})
            return

    try:
        folder_id = msg.get("craftFolderId", "").strip()
        space_id  = os.environ.get("CRAFT_SPACE_ID", "")
        cmd = [sys.executable, str(PUSH_PY), "--title", title,
               "--content-file", str(use_file), "--background"]
        if space_id:
            cmd += ["--space-id", space_id]
        if folder_id:
            cmd += ["--folder-id", folder_id]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if result.returncode == 0:
            notify("Meeting Notes → Craft", title)
            send_message({"status": "ok", "title": title, "source": source})
        else:
            error = _PUSH_EXIT_MESSAGES.get(
                result.returncode,
                result.stderr.strip() or f"push_to_craft exited {result.returncode}",
            )
            send_message({"status": "error", "error": error})
    except Exception as exc:
        send_message({"status": "error", "error": str(exc)})


def find_latest_snapshot(backup_path: Path, slug: str, file_ext: str) -> Path | None:
    """Return the most recently modified snapshot file for this slug, or None."""
    snaps = sorted(
        backup_path.glob(f"*-{slug}-snap{file_ext}"),
        key=lambda p: p.stat().st_mtime,
    )
    return snaps[-1] if snaps else None


def _strip_frontmatter(content: str) -> str:
    """Remove a leading YAML frontmatter block ('---' … '---') if present."""
    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end != -1:
            nl = content.find("\n", end + 1)
            return content[nl + 1:] if nl != -1 else ""
    return content


def pick_recovery_text(inflight_text: str, snapshot_text) -> str:
    """RB-1d freshest-copy pick: return whichever recovery source is more complete
    (greater stripped length). The in-flight text wins ties and is the fallback
    when there's no snapshot."""
    inflight = inflight_text or ""
    snap = snapshot_text or ""
    return snap if len(snap.strip()) > len(inflight.strip()) else inflight


def _recover_freshest_text(inflight_text: str, msg: dict) -> str:
    """Best-effort: pick the longer of the in-flight text and the latest on-disk
    snapshot body for this meeting. Never raises — falls back to inflight_text."""
    try:
        label = (msg.get("meetingTitle") or "").strip() or "Meeting"
        slug = _file_slug(label)
        file_ext = ".txt" if msg.get("fileBackupType") == "txt" else ".md"
        backup_path = _resolve_backup_path(msg.get("fileBackupPath"))
        snap = find_latest_snapshot(backup_path, slug, file_ext)
        snap_text = _strip_frontmatter(snap.read_text(encoding="utf-8")) if snap else None
        return pick_recovery_text(inflight_text, snap_text)
    except Exception:
        return inflight_text


def build_bear_url(title: str, text: str) -> str:
    """bear://x-callback-url to create a Bear note (5.8). URL-encodes title+body."""
    from urllib.parse import quote
    return f"bear://x-callback-url/create?title={quote(title)}&text={quote(text)}"


def _default_open_url(url: str) -> None:
    subprocess.run(["open", url], timeout=10)


# Human-readable destination names for the per-destination result dicts
# (BUG-11 Fix C). Used by both route_output (primary) and send_to_destinations.
_DEST_NAMES = {
    'craft': 'Craft',
    'obsidian': 'Obsidian',
    'apple_notes': 'Apple Notes',
    'bear': 'Bear',
    'google_docs': 'Google Docs',
    'none': 'None',
}


def route_output(
    back_type: str,
    craft_md: str,
    title: str,
    file_path,
    *,
    obsidian_vault_path: str = '',
    dt=None,
    label: str = '',
    apple_push_fn=None,
    notify_fn=None,
    open_url_fn=None,
    gdocs_create_fn=None,
    cal_fields=None,
):
    """Handle the PRIMARY non-Craft output destination.

    BUG-11 Fix C: returns a per-destination RESULT dict instead of sending the
    reply (the caller aggregates saved/failed across destinations and sends one
    message):
      success → {"ok": True, "dest": <human>, "title": title[, "file", "link"]}
      failure → {"ok": False, "dest": <human>, "error": <msg>}
      'craft' / unrecognised → None (caller handles the Craft push).

    The per-destination "→ <App>" notifications still fire on success. Injectable
    deps default to the real implementations when None — kept None-default rather
    than module-level so the function is importable before they're defined.
    """
    _push  = apple_push_fn if apple_push_fn is not None else push_to_apple_notes
    _note  = notify_fn     if notify_fn     is not None else notify
    _open  = open_url_fn   if open_url_fn   is not None else _default_open_url
    _gdocs = gdocs_create_fn if gdocs_create_fn is not None else gdocs.create_doc

    if back_type == 'obsidian':
        # Blank vault → fall back to the one auto-detected from Obsidian's own
        # config, for parity with the additional-destinations path (#98). Without
        # this, Obsidian-as-PRIMARY errored on a blank vault while Obsidian-as-
        # secondary auto-detected — so Primary=Obsidian/Secondary=Craft failed and
        # the recovery re-pushed Craft, creating duplicates.
        vault_path = obsidian_vault_path or _detect_obsidian_vault()
        if not vault_path:
            return {"ok": False, "dest": _DEST_NAMES['obsidian'],
                    "error": "Obsidian vault path not set — configure it in Settings"}
        try:
            from datetime import datetime as _dt
            effective_dt    = dt if dt is not None else _dt.now()
            effective_label = label or title
            _write_obsidian_note(vault_path, effective_label, effective_dt, craft_md, cal_fields=cal_fields)
            _note("Meeting Notes → Obsidian", title)
            resp: dict = {"ok": True, "dest": _DEST_NAMES['obsidian'], "title": title}
            if file_path:
                resp["file"] = str(file_path)
            return resp
        except Exception as exc:
            return {"ok": False, "dest": _DEST_NAMES['obsidian'], "error": str(exc)}

    if back_type == 'apple_notes':
        try:
            html = body_to_html(craft_md)
            note_id = _push(title, html)
            _note("Meeting Notes → Apple Notes", title)
            resp = {"ok": True, "dest": _DEST_NAMES['apple_notes'], "title": title}
            if file_path:
                resp["file"] = str(file_path)
            if note_id:
                # Deep-link reference so History can re-open the note later.
                resp["link"] = {"app": "apple_notes", "kind": "note_id", "value": note_id}
            return resp
        except Exception as exc:
            return {"ok": False, "dest": _DEST_NAMES['apple_notes'], "error": str(exc)}

    if back_type == 'bear':
        # Bear note via x-callback-url (5.8). Untested against a live Bear app.
        try:
            _open(build_bear_url(title, craft_md))
            _note("Meeting Notes → Bear", title)
            resp_bear: dict = {"ok": True, "dest": _DEST_NAMES['bear'], "title": title}
            if file_path:
                resp_bear["file"] = str(file_path)
            return resp_bear
        except Exception as exc:
            return {"ok": False, "dest": _DEST_NAMES['bear'], "error": str(exc)}

    if back_type == 'google_docs':
        # Google Docs as the primary output (5.7). Separate OAuth grant; create_doc
        # loads its own token and returns {ok, url} or {ok:False, error}.
        result = _gdocs(title, craft_md) or {}
        if result.get('ok'):
            _note("Meeting Notes → Google Docs", title)
            resp_gd: dict = {"ok": True, "dest": _DEST_NAMES['google_docs'], "title": title}
            if file_path:
                resp_gd["file"] = str(file_path)
            if result.get('url'):
                # Deep-link reference so History can re-open the Doc later.
                resp_gd["link"] = {"app": "gdocs", "kind": "url", "value": result["url"]}
            return resp_gd
        err = result.get('error') or 'unknown error'
        human = ("Google Docs isn't connected — connect it in Settings → Primary output"
                 if err == 'not_connected'
                 else f"Google Docs error: {err}")
        return {"ok": False, "dest": _DEST_NAMES['google_docs'], "error": human}

    if back_type == 'none':
        resp_none: dict = {"ok": True, "dest": _DEST_NAMES['none']}
        if file_path:
            resp_none["file"] = str(file_path)
        return resp_none

    return None  # 'craft' or unrecognised → caller handles


def _file_slug(label: str) -> str:
    """Filesystem-safe slug for note filenames: lowercase, spaces→dashes,
    ASCII word chars only, capped at 50."""
    return re.sub(r'[^\w\-]', '', label.lower().replace(' ', '-'), flags=re.ASCII)[:50]


# Obsidian records its known vaults here; we read it so a blank "additional
# destination" Obsidian row can fall back to the user's actual vault — the
# "uses your vault if blank" promise shown in the popup.
_OBSIDIAN_CONFIG = Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"


def _select_obsidian_vault(config) -> str:
    """Pure — pick a vault path from a parsed obsidian.json dict. Prefers the
    currently-open vault, else the most recently used (max ts); '' when there are
    no usable vaults or the shape is unexpected."""
    vaults = config.get("vaults") if isinstance(config, dict) else None
    if not isinstance(vaults, dict):
        return ""
    entries = [v for v in vaults.values() if isinstance(v, dict) and v.get("path")]
    if not entries:
        return ""
    pool = [v for v in entries if v.get("open")] or entries
    return str(max(pool, key=lambda v: v.get("ts", 0))["path"])


def _detect_obsidian_vault(config_path=None) -> str:
    """Best-effort — the user's Obsidian vault from Obsidian's own config. Returns
    '' when it can't be determined (Obsidian not installed, no vaults, unreadable)."""
    try:
        raw = Path(config_path or _OBSIDIAN_CONFIG).read_text(encoding="utf-8")
        return _select_obsidian_vault(json.loads(raw))
    except Exception:
        return ""


# --- destination_status probe -----------------------------------------------
# Bundle id → fallback /Applications path, so a sandboxed/mdfind-blind install
# still resolves the common case.
_APP_FALLBACK_PATHS = {
    'com.lukilabs.lukiapp': Path('/Applications/Craft.app'),
    'net.shinyfrog.bear':   Path('/Applications/Bear.app'),
}
_APP_INSTALLED_CACHE: dict[str, bool] = {}


def _app_installed(bundle_id: str) -> bool:
    """True if a macOS app with this bundle id is installed. Best-effort: asks
    Spotlight (mdfind) and falls back to a known /Applications path. Any failure
    or timeout → False. Cached per-process so repeated probes don't re-shell."""
    if bundle_id in _APP_INSTALLED_CACHE:
        return _APP_INSTALLED_CACHE[bundle_id]
    found = False
    try:
        result = subprocess.run(
            ["mdfind", f"kMDItemCFBundleIdentifier == '{bundle_id}'"],
            capture_output=True, text=True, timeout=5,
        )
        found = bool(result.stdout.strip())
    except Exception:
        found = False
    if not found:
        fallback = _APP_FALLBACK_PATHS.get(bundle_id)
        if fallback is not None:
            try:
                found = fallback.exists()
            except Exception:
                found = False
    _APP_INSTALLED_CACHE[bundle_id] = found
    return found


def build_destination_status(craft_installed: bool, bear_installed: bool,
                             gdocs_status: dict, obsidian_vault: str) -> dict:
    """Pure — assemble the per-destination availability map from already-probed
    inputs. No I/O. Reasons are '' when available, else a short human string."""
    gd = gdocs_status if isinstance(gdocs_status, dict) else {}
    if gd.get('available') is False:
        gdocs = (False, 'Google libraries missing — re-run install.sh')
    elif gd.get('connected'):
        gdocs = (True, '')
    elif gd.get('needs_reconnect'):
        gdocs = (False, 'Reconnect needed')
    else:
        gdocs = (False, 'Not connected')

    obsidian_ok = bool(isinstance(obsidian_vault, str) and obsidian_vault)

    return {
        'craft':       {'available': craft_installed,
                        'reason': '' if craft_installed else 'Not installed'},
        'bear':        {'available': bear_installed,
                        'reason': '' if bear_installed else 'Not installed'},
        'apple_notes': {'available': True, 'reason': ''},
        'google_docs': {'available': gdocs[0], 'reason': gdocs[1]},
        'obsidian':    {'available': obsidian_ok,
                        'reason': '' if obsidian_ok else 'No vault set'},
    }


def handle_destination_status(msg: dict) -> dict:
    """Probe which output destinations can actually receive a note and return the
    ok-wrapped availability map. Best-effort: a failing gdocs import is treated as
    not-connected so the probe never raises."""
    craft = _app_installed('com.lukilabs.lukiapp')
    bear = _app_installed('net.shinyfrog.bear')
    try:
        gdocs_status = gdocs.status()
    except Exception:
        gdocs_status = {'connected': False, 'available': True}
    obsidian_vault = _detect_obsidian_vault()
    return {
        'status': 'ok',
        'destinations': build_destination_status(craft, bear, gdocs_status, obsidian_vault),
    }


def _obsidian_filename(label, dt) -> str:
    """Readable, filesystem-safe Obsidian note filename: 'YYYYMMDD HH:MM Title.md'.
    Obsidian shows the filename as the note title, so (unlike internal backup/
    snapshot names) it keeps real words and casing — matching what Craft displays —
    rather than a lowercased hyphen-slug. The colon in the time is intentional (macOS
    allows it; it mirrors Craft). Only genuinely-unsafe characters are stripped (path
    separators, the Windows-reserved set, control chars) — ordinary punctuation like
    % & : ( ) , . is kept so the title reads like Craft shows it. An over-long title
    is trimmed at a word boundary (no mid-word cut), and a label with no usable
    characters falls back to just the timestamp."""
    _MAX_TITLE = 80
    # Path separators (/ \) become a space so words don't run together
    # ("Reigo/Carlos" → "Reigo Carlos", not "ReigoCarlos"); the rest of the
    # Windows-reserved set + control chars are dropped.
    clean = re.sub(r'[/\\]', ' ', str(label or ''))
    clean = re.sub(r'[*?"<>|\x00-\x1f]', '', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    if not re.search(r'\w', clean):   # only punctuation/blank → no usable title
        clean = ''
    if len(clean) > _MAX_TITLE:
        head = clean[:_MAX_TITLE]
        # Drop the trailing partial word unless the cut already landed on a space.
        if not clean[_MAX_TITLE].isspace() and ' ' in head:
            head = head[:head.rfind(' ')]
        clean = head.strip()
    stamp = dt.strftime('%Y%m%d %H:%M')
    return f"{stamp} {clean}.md" if clean else f"{stamp}.md"


def _write_obsidian_note(vault_path, label, dt, body, cal_fields=None):
    """Write a note .md into an Obsidian vault folder with YAML frontmatter."""
    vault = Path(vault_path).expanduser()
    vault.mkdir(parents=True, exist_ok=True)
    (vault / _obsidian_filename(label, dt)).write_text(
        build_yaml_frontmatter(label, dt, cal_fields=cal_fields) + body, encoding='utf-8')


def send_to_destinations(destinations, craft_md, title, dt, label,
                         obsidian_vault_path: str = '', craft_folder_id: str = '',
                         cal_fields=None):
    """Fan out the note to each extra destination row (the unified repeater),
    best-effort. Per-row config falls back to the passed-in global default when
    blank, so a blank row behaves like the legacy 'also send to' checkbox.
    Never raises — a failing row never affects the primary capture or other rows.

    BUG-11 Fix C: returns one result row per PROCESSED destination so the caller
    can surface every secondary failure:
      [{"dest": <human name>, "ok": bool, "error": <msg>}]
    Non-dict / unknown-type entries are skipped (no row), as before. An obsidian
    row that resolves to no vault is skipped (no row) — there is nothing to retry."""
    results: list = []
    for entry in (destinations or []):
        if not isinstance(entry, dict):
            continue
        dest = entry.get('type')
        if dest not in _DEST_NAMES:
            continue  # unknown type — best-effort skip, no result row
        human = _DEST_NAMES[dest]
        try:
            if dest == 'apple_notes':
                push_to_apple_notes(title, body_to_html(craft_md))
                notify("Meeting Notes → Apple Notes", title)
            elif dest == 'obsidian':
                # Row vault → global default → the vault detected from Obsidian's
                # own config (the "uses your vault if blank" fallback). Only when
                # none of those resolve do we skip — and we log it so the skip is
                # visible instead of silent.
                vault_path = (str(entry.get('vaultPath') or '').strip()
                              or obsidian_vault_path or _detect_obsidian_vault())
                if not vault_path:
                    _heartbeat("obsidian_skip no_vault")
                    continue  # nothing to write/retry → no result row
                _write_obsidian_note(vault_path, label, dt, craft_md, cal_fields=cal_fields)
                notify("Meeting Notes → Obsidian", title)
            elif dest == 'craft':
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                safe = re.sub(r'[^\w\s\-]', '', title)[:80].strip() or dt.strftime('%Y%m%d')
                cf = CACHE_DIR / f"{safe}.md"
                cf.write_text(craft_md, encoding='utf-8')
                cmd = [sys.executable, str(PUSH_PY), "--title", title, "--content-file", str(cf), "--background"]
                folder_id = str(entry.get('folderId') or '').strip() or craft_folder_id
                if folder_id:
                    cmd += ["--folder-id", folder_id]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
                if proc.returncode != 0:
                    err = _PUSH_EXIT_MESSAGES.get(
                        proc.returncode,
                        proc.stderr.strip() or f"push_to_craft exited {proc.returncode}")
                    results.append({"dest": human, "ok": False, "error": err})
                    continue
            elif dest == 'bear':
                _default_open_url(build_bear_url(title, craft_md))
                notify("Meeting Notes → Bear", title)
            elif dest == 'google_docs':
                res = gdocs.create_doc(title, craft_md)
                if isinstance(res, dict) and res.get('ok'):
                    notify("Meeting Notes → Google Docs", title)
                else:
                    err = (res or {}).get('error') if isinstance(res, dict) else None
                    human_err = ("Google Docs isn't connected — connect it in Settings"
                                 if err == 'not_connected'
                                 else f"Google Docs error: {err or 'unknown error'}")
                    results.append({"dest": human, "ok": False, "error": human_err})
                    continue
            results.append({"dest": human, "ok": True, "error": ""})
        except Exception as exc:
            # best-effort per-row output — never affect the primary capture, but
            # record the failure so the caller can surface it.
            results.append({"dest": human, "ok": False, "error": str(exc)})
    return results


# Wall-clock budget for Google Calendar enrichment. The google API client has no
# network timeout, so a stalled token-refresh or events query would otherwise hang
# the whole capture indefinitely (the "best-effort, never blocks capture" promise).
_GCAL_ENRICH_TIMEOUT = 12  # seconds


def _enrich_calendar_bounded(msg, timeout=_GCAL_ENRICH_TIMEOUT) -> dict:
    """Run Calendar enrichment with a hard wall-clock cap. A try/except can't rescue
    a *hung* network call, so the work runs on a daemon thread we simply stop waiting
    on after `timeout`; on timeout or any error we return {} and the capture proceeds.
    The abandoned thread dies with the (one-shot) host process."""
    result: dict = {}

    def _run():
        try:
            cf, _status = gcal.enrich_frontmatter_fields(
                msg.get("meetingCode", ""), msg.get("timestamp", ""),
                msg.get("meetingTitle", ""), bool(msg.get("redactPii")),
                events_provider=gcal.live_events_provider(msg.get("timestamp", "")),
            )
            if isinstance(cf, dict):
                result["cal"] = cf
        except Exception:
            pass  # best-effort — a Calendar failure never affects the note

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        _heartbeat("gcal_enrich_timeout")  # visible: enrichment abandoned, capture continues
    return result.get("cal", {})


def handle_capture(msg) -> None:
    transcript = msg.get("transcript", "").strip()
    # Recovery (RB-1d): when re-sending a note that failed mid-send, prefer the
    # most complete copy — the supplied in-flight text or a fresher on-disk
    # snapshot for this meeting, whichever is longer. Best-effort; never raises.
    if msg.get("recover"):
        transcript = _recover_freshest_text(transcript, msg).strip()
    if not transcript:
        send_message({"status": "error", "error": "transcript is empty"})
        return

    # parse_transcript strips the TITLE: line from the body (we ignore the
    # extracted title — the tab name is the source of truth now)
    _, craft_md = parse_transcript(transcript)
    _heartbeat("parsed")

    # PII redaction (RB-5b) — applied to the note body before ANY write or send.
    if msg.get("redactPii"):
        kws = [k for k in (msg.get("redactKeywords") or "").split(",") if k.strip()]
        craft_md = redact_pii(craft_md, kws)

    # Auto-tagging (RB-4c) — pull the trailing 'Tags:' line out of the body and
    # promote it to YAML frontmatter; the line never reaches the rendered note.
    topic_tags, craft_md = extract_tags(craft_md)

    # Google Calendar enrichment (5.3) — best-effort, never blocks capture. Bounded
    # by a wall-clock timeout because the google client has no network timeout, so a
    # stalled refresh/query would otherwise hang the capture (the failure we saw:
    # the capture froze right after "parsed" with no note written).
    cal_fields = {}
    if msg.get("calendarEnabled") and gcal.GCAL_AVAILABLE:
        cal_fields = _enrich_calendar_bounded(msg)

    # Resolve the timestamp — convert to local timezone so the Craft note title
    # shows wall-clock time rather than UTC (e.g. 09:12 CEST not 07:12 UTC).
    timestamp_str = msg.get("timestamp", "")
    try:
        dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        dt = datetime.now()  # local time as fallback
    date_prefix = dt.strftime("%Y%m%d")

    # Provenance footer (UXC-22) — appended to every persisted/sent note so the
    # file carries its origin. note_body stays footer-free so the structured
    # webhook payload's section parsing isn't polluted by the footer line.
    note_body = craft_md
    # Wikilinks (RB-4e) — wrap attendee names in [[ ]] for graph apps, on the
    # persisted/sent note only (note_body stays plain for structured payloads).
    if msg.get("wikilinks"):
        craft_md = apply_wikilinks(craft_md, msg.get("attendees"))
    craft_md = craft_md + build_provenance_footer(dt)

    # Title: always YYYYMMDD HH:MM + meeting name (or "Meeting" fallback)
    tab_title = msg.get("meetingTitle", "").strip()
    label     = tab_title or "Meeting"
    title     = render_title_template(
        msg.get("titleTemplate", ""), dt, label,
        msg.get("meetingType", ""), msg.get("meetingCode", ""),
    )

    file_backup_enabled = msg.get("fileBackupEnabled", False)
    file_backup_type    = msg.get("fileBackupType", "markdown")
    file_backup_path    = _resolve_backup_path(msg.get("fileBackupPath"))

    # Backup-folder auto-cleanup (UXF-13) — best-effort, never blocks capture.
    try:
        if msg.get("backupCleanup"):
            cleanup_backups(file_backup_path, msg.get("backupCleanup"))
    except Exception:
        pass

    # Optional file backup
    file_ext  = ".txt" if file_backup_type == "txt" else ".md"
    # Strip path separators from the title-derived slug so a meeting title like
    # "Carlos / Pablo" can't smuggle a '/' into the filename and create a phantom
    # subdirectory (BUG-12). Snapshots already route through _file_slug; this is
    # the final-backup equivalent.
    slug      = re.sub(r'[/\\]', '', title[9:]).lower().replace(" ", "-")[:50] \
                if len(title) > 8 else re.sub(r'[/\\]', '', title)[:60]
    file_path = None
    if file_backup_enabled:
        # The file backup is a SAFETY NET, never a gate — a failed write (bad path,
        # full disk, permissions, odd filename) must not abort the capture or block
        # the primary output (BUG-12). Log and carry on with file_path=None.
        try:
            file_backup_path.mkdir(parents=True, exist_ok=True)
            file_path = file_backup_path / f"{title[:8]}-{slug}{file_ext}"
            note_attendees = msg.get("attendees") or []
            note_duration  = msg.get("durationMin")
            fm = build_yaml_frontmatter(
                label, dt,
                attendees=note_attendees,
                duration_min=int(note_duration) if note_duration is not None else None,
                meeting_code=msg.get("meetingCode") or None,
                meeting_type=msg.get("meetingType") or None,
                recording=bool(msg.get("recording")),
                topic_tags=topic_tags,
                cal_fields=cal_fields,
            ) if file_ext == ".md" else ""
            file_path.write_text(fm + craft_md, encoding="utf-8")
            # .ics for the Next Steps section (RB-3b), written next to the note.
            if msg.get("emitIcs"):
                steps = [ln for ln in parse_note_sections(note_body).get('next_steps', '').split('\n') if ln.strip()]
                ics = build_ics(steps, dt, label)
                if ics:
                    file_path.with_suffix('.ics').write_text(ics, encoding="utf-8")
        except Exception as e:
            _heartbeat(f"backup_write_failed {type(e).__name__}: {e}")
            file_path = None

    _heartbeat("backup_written")

    # Generic webhook (P9-D) — POST the structured note before the output routing
    # sends its response (the host process is terminated once the response is read).
    # Best-effort: webhook failures never affect the capture result. Timeouts are
    # kept short (ARCH-3) so a slow/unreachable hook adds at most a few seconds to
    # the "Saved" response rather than blocking the user on the post-meeting page.
    _HOOK_TIMEOUT = 2.5
    webhook_url = (msg.get("webhookUrl") or "").strip()
    slack_url   = (msg.get("slackWebhookUrl") or "").strip()
    if webhook_url or slack_url:
        sections = parse_note_sections(note_body)  # footer-free (UXC-22)
        if webhook_url:
            post_webhook(
                webhook_url,
                build_webhook_payload(
                    title, dt.strftime('%Y-%m-%d'),
                    msg.get("attendees") or [], msg.get("durationMin"), sections,
                ),
                timeout=_HOOK_TIMEOUT,
            )
        if slack_url:
            post_webhook(slack_url, build_slack_payload(title, sections), timeout=_HOOK_TIMEOUT)

    _heartbeat("webhooks_done")

    back_type = msg.get("backupType", "craft")

    # Unified extra destinations — fan out a copy of the note to each row, with
    # per-row config falling back to the global default when blank. Best-effort;
    # returns one {dest, ok, error} row per processed destination (BUG-11 Fix C).
    add_results = send_to_destinations(
        msg.get("destinations"), craft_md, title, dt, label,
        obsidian_vault_path=msg.get("obsidianVaultPath", ""),
        craft_folder_id=msg.get("craftFolderId", "").strip(),
        cal_fields=cal_fields,
    ) or []

    _heartbeat("extras_done")

    # Primary output dispatch. route_output returns a {ok, dest, ...} result for
    # the non-Craft apps, or None for Craft / unrecognised — which we handle here
    # via the push_to_craft path (E2 snapshot retry preserved).
    primary = route_output(back_type, craft_md, title, file_path,
                           obsidian_vault_path=msg.get("obsidianVaultPath", ""),
                           dt=dt, label=label, cal_fields=cal_fields)

    if primary is None:
        # back_type == 'craft' (or anything unrecognised) → Craft push.
        primary = _capture_push_to_craft(
            msg, craft_md, title, label, file_path, date_prefix,
            file_backup_enabled=file_backup_enabled,
            file_backup_path=file_backup_path, file_ext=file_ext,
        )

    # Aggregate the primary + every additional destination into one reply (BUG-11
    # Fix C). saved/failed = the human names; status is ok/partial/error.
    primary_ok = bool(primary.get("ok"))
    saved, failed, errors = [], [], []
    if primary_ok:
        saved.append(primary["dest"])
    else:
        failed.append(primary["dest"])
        if primary.get("error"):
            errors.append(f"{primary['dest']}: {primary['error']}")
    for row in add_results:
        if row.get("ok"):
            saved.append(row["dest"])
        else:
            failed.append(row["dest"])
            errors.append(f"{row['dest']}: {row.get('error', 'failed')}")

    if not failed:
        status = "ok"
    elif not saved:
        status = "error"
    else:
        status = "partial"

    reply: dict = {"status": status, "saved": saved, "failed": failed,
                   "primaryOk": primary_ok, "title": title}
    if primary.get("file"):
        reply["file"] = primary["file"]
    if primary.get("link"):
        reply["link"] = primary["link"]
    if primary.get("retried"):
        reply["retried"] = True
    if status != "ok":
        reply["error"] = "; ".join(errors)
    # Retry widget needs a file backup to recover from. Prefer the primary's own
    # snapshot/backup hint (set by the Craft push), else the file backup path.
    backup_hint = primary.get("backupPath") or (str(file_path) if file_path else "")
    if backup_hint and not primary_ok:
        reply["backupPath"] = backup_hint

    # Desktop notification when the whole capture failed (RB-7e) — the in-page
    # toast is gone by now (the Meet tab closed), so this is the user's only signal.
    if status == "error":
        notify("Meeting Notes — capture failed", reply.get("error", "capture failed"))

    send_message(reply)
    _heartbeat(f"replied status={status}")
    # No finally: note files live in CACHE_DIR — cleaned up by push_to_craft.py
    # on the next run (files older than 2 h are deleted automatically).


def _capture_push_to_craft(msg, craft_md, title, label, file_path, date_prefix, *,
                           file_backup_enabled, file_backup_path, file_ext) -> dict:
    """Push the primary note to Craft (the Craft / unrecognised fall-through) and
    return a per-destination RESULT dict — never sends. On a failed first push it
    retries once with the most recent snapshot file (E2). Result shape:
      success → {"ok": True, "dest": "Craft", "title"[, "file", "retried"]}
      failure → {"ok": False, "dest": "Craft", "error"[, "backupPath"]}"""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        safe_title = re.sub(r'[^\w\s\-]', '', title)[:80].strip() or date_prefix
        note_path  = CACHE_DIR / f"{safe_title}.md"
        note_path.write_text(craft_md, encoding="utf-8")

        space_id  = (msg.get("craftSpaceId") or os.environ.get("CRAFT_SPACE_ID", "")).strip()
        folder_id = msg.get("craftFolderId", "").strip()
        cmd = [sys.executable, str(PUSH_PY), "--title", title,
               "--content-file", str(note_path), "--background"]
        if space_id:
            cmd += ["--space-id", space_id]
        if folder_id:
            cmd += ["--folder-id", folder_id]

        _heartbeat("craft_push_start")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        _heartbeat(f"craft_push_done rc={result.returncode}")

        if result.returncode == 0:
            notify("Meeting Notes → Craft", title)
            res: dict = {"ok": True, "dest": _DEST_NAMES['craft'], "title": title}
            if file_path:
                res["file"] = str(file_path)
            return res

        # Primary push failed — retry once with most recent snapshot file (E2)
        snap_slug = _file_slug(label)
        snap_file = find_latest_snapshot(file_backup_path, snap_slug, file_ext) \
                    if file_backup_enabled else None

        if snap_file:
            retry = subprocess.run(
                [sys.executable, str(PUSH_PY), "--title", title,
                 "--content-file", str(snap_file), "--background"],
                capture_output=True, text=True, timeout=45,
            )
            if retry.returncode == 0:
                notify("Meeting Notes → Craft", title)
                res = {"ok": True, "dest": _DEST_NAMES['craft'], "title": title, "retried": True}
                if file_path:
                    res["file"] = str(file_path)
                return res

        # Both attempts failed (or no snapshot available) — include backup path
        backup_hint = str(snap_file or file_path or "")
        error = _PUSH_EXIT_MESSAGES.get(
            result.returncode,
            result.stderr.strip() or f"push_to_craft exited {result.returncode}",
        )
        res = {"ok": False, "dest": _DEST_NAMES['craft'], "error": error}
        if backup_hint:
            res["backupPath"] = backup_hint
        return res
    except Exception as exc:
        return {"ok": False, "dest": _DEST_NAMES['craft'], "error": str(exc)}


def main() -> None:
    """Top-level guard: a handler that raises before replying would otherwise let
    the host process exit on the traceback, which Chrome surfaces as the cryptic
    'Native host has exited' (and the popup shows a generic error with no detail).
    Catch any uncaught error and reply once with a clean message instead."""
    try:
        _dispatch()
    except Exception as exc:
        send_message({"status": "error", "error": str(exc) or exc.__class__.__name__})
        _heartbeat("replied status=uncaught")


def _dispatch() -> None:
    msg = read_message()
    if not msg:
        send_message({"status": "error", "error": "empty message"})
        return

    _heartbeat_rotate()
    _heartbeat(f"start type={msg.get('type') or 'capture'} chars={len(msg.get('transcript') or '')}")

    if msg.get("type") == "ping":
        send_message({"status": "ok", "home": str(Path.home()), "version": HOST_VERSION})
        return

    if msg.get("type") == "choose_folder":
        # Chrome kills native messaging connections after ~30 s, so cap the
        # osascript dialog well below that limit. If the user takes longer
        # the popup will receive a null response and show an inline error.
        try:
            result = subprocess.run(
                ["osascript", "-e",
                 'POSIX path of (choose folder with prompt "Select folder for meeting notes:")'],
                capture_output=True, text=True, timeout=25
            )
        except subprocess.TimeoutExpired:
            send_message({"status": "error", "error": "Folder picker timed out — please try again"})
            return
        if result.returncode == 0 and result.stdout.strip():
            # Store the pick agnostically of the Mac account (BUG-12): a folder
            # under home is saved as '~/…' so it resolves on any machine/user.
            path = _homerel_path(result.stdout.strip().rstrip("/"))
            send_message({"status": "ok", "path": path})
        else:
            send_message({"status": "error", "error": "No folder selected"})
        return

    if msg.get("type") == "retry":
        handle_retry(msg)
        return

    if msg.get("type") == "snapshot":
        handle_snapshot(msg)
        send_message({"status": "ok"})
        return

    if msg.get("type") == "search":
        results = search_notes(
            msg.get("query", ""),
            str(_resolve_backup_path(msg.get("fileBackupPath"))),
            since=msg.get("since") or None,
            until=msg.get("until") or None,
            attendee=msg.get("attendee") or None,
        )
        send_message({"status": "ok", "results": results})
        return

    if msg.get("type") == "prior_context":
        prior = find_prior_note(
            msg.get("meetingTitle", "").strip(),
            str(_resolve_backup_path(msg.get("fileBackupPath"))),
        )
        ctx = ""
        if prior:
            text = prior.read_text(encoding="utf-8", errors="ignore")
            ctx = build_prior_context(text, _note_date_from(text, prior))
        send_message({"status": "ok", "context": ctx})
        return

    if msg.get("type") == "gcal_status":
        send_message(gcal.status())
        return

    if msg.get("type") == "gcal_disconnect":
        send_message(gcal.disconnect())
        return

    if msg.get("type") == "pre_meeting_brief":
        # P9-G — beta pre-meeting brief. Match the active meeting's calendar
        # event and return ≤3 prep bullets. Best-effort; guarded by the libs.
        if not gcal.GCAL_AVAILABLE:
            send_message({"ok": False, "error": "unavailable"})
            return
        ts = msg.get("timestamp", "")
        send_message(gcal.pre_meeting_brief(
            msg.get("meetingCode", ""),
            ts,
            msg.get("meetingTitle", ""),
            bool(msg.get("redactPii")),
            events_provider=gcal.live_events_provider(ts),
        ))
        return

    if msg.get("type") == "gcal_connect":
        # Run the interactive flow detached so it outlives Chrome's ~30s native-
        # messaging window; the popup polls gcal_status afterward.
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve().with_name("gcal.py"))],
                             start_new_session=True)
            send_message({"status": "ok", "started": True})
        except Exception as exc:
            send_message({"status": "error", "error": str(exc)})
        return

    if msg.get("type") == "gdocs_status":
        send_message(gdocs.status())
        return

    if msg.get("type") == "destination_status":
        send_message(handle_destination_status(msg))
        return

    if msg.get("type") == "gdocs_disconnect":
        send_message(gdocs.disconnect())
        return

    if msg.get("type") == "gdocs_connect":
        # Run the Docs OAuth flow detached so it outlives Chrome's ~30s native-
        # messaging window; the popup polls gdocs_status afterward. Separate grant.
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve().with_name("gdocs.py"))],
                             start_new_session=True)
            send_message({"status": "ok", "started": True})
        except Exception as exc:
            send_message({"status": "error", "error": str(exc)})
        return

    if msg.get("type") == "google_status":
        send_message(gauth.status())
        return

    if msg.get("type") == "google_disconnect":
        send_message(gauth.disconnect())
        return

    if msg.get("type") == "google_connect":
        # One combined Calendar+Docs consent. Run detached so it outlives Chrome's
        # ~30s native-messaging window; the popup polls google_status afterward.
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve().with_name("gauth.py"))],
                             start_new_session=True)
            send_message({"status": "ok", "started": True})
        except Exception as exc:
            send_message({"status": "error", "error": str(exc)})
        return

    if msg.get("type") == "recover_snapshot":
        # Leave-time fallback: Gemini wasn't capturable live, so file the most recent
        # on-disk snapshot for this meeting through the normal save pipeline. Replies
        # {ok:False, reason:'no_snapshot'} cleanly (no error machinery) when there's none.
        label = (msg.get("meetingTitle") or "").strip() or "Meeting"
        slug = _file_slug(label)
        file_ext = ".txt" if msg.get("fileBackupType") == "txt" else ".md"
        backup_path = _resolve_backup_path(msg.get("fileBackupPath"))
        snap = find_latest_snapshot(backup_path, slug, file_ext)
        if not snap:
            send_message({"ok": False, "reason": "no_snapshot"})
            return
        msg["transcript"] = _strip_frontmatter(snap.read_text(encoding="utf-8"))
        handle_capture(msg)  # files it + sends its own {status: ok|error} reply
        return

    if msg.get("type") == "open_note":
        # Open a previously-saved Apple Notes note by id; report not_found so the
        # extension can drop a dead deep-link reference.
        if open_apple_note(msg.get("noteId") or ""):
            send_message({"ok": True})
        else:
            send_message({"ok": False, "reason": "not_found"})
        return

    handle_capture(msg)


if __name__ == "__main__":
    main()
