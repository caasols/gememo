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
import time
from datetime import datetime, timezone
from pathlib import Path

HOST_VERSION = '0.1.30'  # updated in lockstep with manifest.json version

SCRIPT_DIR = Path(__file__).parent
# push_to_craft.py is copied alongside the host during install.
# Fall back to the project scripts/ dir when running from source.
_push_local = SCRIPT_DIR / "push_to_craft.py"
_push_dev   = SCRIPT_DIR.parent / "scripts" / "push_to_craft.py"
PUSH_PY     = _push_local if _push_local.exists() else _push_dev
CACHE_DIR   = Path.home() / ".cache" / "mm2c"


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


def build_yaml_frontmatter(
    title: str,
    dt: datetime,
    snapshot: bool = False,
    attendees: list | None = None,
    duration_min: int | None = None,
    meeting_code: str | None = None,
    meeting_type: str | None = None,
    recording: bool = False,
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
    lines.append(f"tags: [meeting, {dt.strftime('%Y/%m')}]")
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


def push_to_apple_notes(title: str, body_html: str) -> None:
    """Push a note to Apple Notes via osascript.

    HTML body is written to a temp file to avoid AppleScript string-escaping
    issues with embedded quotes, backslashes, and newlines.
    Raises subprocess.CalledProcessError on osascript failure.
    """
    import tempfile
    safe_title = title.replace('\\', '\\\\').replace('"', '\\"')
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.html', delete=False, encoding='utf-8'
    ) as f:
        f.write(body_html)
        tmp_path = f.name
    try:
        script = (
            f'set noteBody to read (POSIX file "{tmp_path}") as «class utf8»\n'
            f'tell application "Notes"\n'
            f'  make new note with properties {{name:"{safe_title}", body:noteBody}}\n'
            f'end tell'
        )
        subprocess.run(['osascript', '-e', script], check=True, capture_output=True)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def notify(title: str, message: str) -> None:
    script = f'display notification "{message}" with title "{title}"'
    subprocess.run(["osascript", "-e", script], check=False, capture_output=True)


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


def handle_snapshot(msg: dict) -> None:
    """Write a timestamped snapshot file to the backup folder and prune old ones."""
    file_backup_type = msg.get("fileBackupType", "markdown")
    file_backup_path = Path(msg.get("fileBackupPath", "~/meeting-notes")).expanduser()
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
    slug          = re.sub(r'[^\w\-]', '', label.lower().replace(" ", "-"), flags=re.ASCII)[:50]

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


def search_notes(query: str, backup_dir, limit: int = 20) -> list:
    """Full-text search over final-note .md files in backup_dir (P9-E).

    Case-insensitive substring match. Snapshot files (`*-snap.md`) are excluded
    so each meeting appears once. Results are newest-first, each with
    {file, title, date, snippet}. Returns [] for an empty query or missing dir.
    """
    if not query or not query.strip():
        return []
    base = Path(backup_dir).expanduser()
    if not base.exists():
        return []
    q = query.strip().lower()
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
        if q not in text.lower():
            continue
        results.append({
            'file': str(f),
            'title': _note_title_from(text, f),
            'date': _note_date_from(text, f),
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
    PUSH_EXIT_MESSAGES = {
        1: 'Craft is not running — open Craft and try again',
        2: 'Note file not found — try capturing again',
        3: 'Could not open Craft URL',
    }
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

    try:
        folder_id = msg.get("craftFolderId", "").strip()
        space_id  = os.environ.get("CRAFT_SPACE_ID", "")
        cmd = [sys.executable, str(PUSH_PY), "--title", title,
               "--content-file", str(use_file), "--background"]
        if space_id:
            cmd += ["--space-id", space_id]
        if folder_id:
            cmd += ["--folder-id", folder_id]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            notify("Meeting Notes → Craft", title)
            send_message({"status": "ok", "title": title, "source": source})
        else:
            error = PUSH_EXIT_MESSAGES.get(
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
    send_fn=None,
) -> bool:
    """Handle non-Craft output destinations. Returns True if handled, False to fall through.

    Injectable deps (apple_push_fn, notify_fn, send_fn) default to the real
    implementations when None — kept as None-default rather than module-level
    references so the function is importable before the real functions are defined.
    """
    _push  = apple_push_fn if apple_push_fn is not None else push_to_apple_notes
    _note  = notify_fn     if notify_fn     is not None else notify
    _send  = send_fn       if send_fn       is not None else send_message

    if back_type == 'obsidian':
        if not obsidian_vault_path:
            _send({"status": "error",
                   "error": "Obsidian vault path not set — configure it in Settings"})
            return True
        try:
            from datetime import datetime as _dt
            effective_dt    = dt if dt is not None else _dt.now()
            effective_label = label or title
            vault = Path(obsidian_vault_path).expanduser()
            vault.mkdir(parents=True, exist_ok=True)
            slug      = re.sub(r'[^\w\-]', '',
                               effective_label.lower().replace(' ', '-'),
                               flags=re.ASCII)[:50]
            note_path = vault / f"{effective_dt.strftime('%Y%m%d-%H%M')}-{slug}.md"
            fm        = build_yaml_frontmatter(effective_label, effective_dt)
            note_path.write_text(fm + craft_md, encoding='utf-8')
            _note("Meeting Notes → Obsidian", title)
            resp: dict = {"status": "ok", "title": title}
            if file_path:
                resp["file"] = str(file_path)
            _send(resp)
        except Exception as exc:
            _send({"status": "error", "error": str(exc)})
        return True

    if back_type == 'apple_notes':
        try:
            html = body_to_html(craft_md)
            _push(title, html)
            _note("Meeting Notes → Apple Notes", title)
            resp: dict = {"status": "ok", "title": title}
            if file_path:
                resp["file"] = str(file_path)
            _send(resp)
        except Exception as exc:
            _send({"status": "error", "error": str(exc)})
        return True

    if back_type == 'none':
        resp_none: dict = {"status": "ok", "title": title}
        if file_path:
            resp_none["file"] = str(file_path)
        _send(resp_none)
        return True

    return False  # 'craft' or unrecognised → caller handles


def resolve_extras(primary: str, also_send) -> list:
    """Ordered, de-duplicated secondary destinations, excluding the primary,
    'none', and blanks (P9-X)."""
    seen = {primary, 'none', ''}
    out = []
    for d in (also_send or []):
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def send_to_extras(extras, craft_md, title, dt, label,
                   obsidian_vault_path: str = '', craft_folder_id: str = '') -> None:
    """Write the note to each secondary destination, best-effort (P9-X).
    Never raises — a failed extra must not affect the primary capture result."""
    for dest in extras:
        try:
            if dest == 'apple_notes':
                push_to_apple_notes(title, body_to_html(craft_md))
                notify("Meeting Notes → Apple Notes", title)
            elif dest == 'obsidian' and obsidian_vault_path:
                vault = Path(obsidian_vault_path).expanduser()
                vault.mkdir(parents=True, exist_ok=True)
                slug = re.sub(r'[^\w\-]', '', label.lower().replace(' ', '-'), flags=re.ASCII)[:50]
                (vault / f"{dt.strftime('%Y%m%d-%H%M')}-{slug}.md").write_text(
                    build_yaml_frontmatter(label, dt) + craft_md, encoding='utf-8')
            elif dest == 'craft':
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                safe = re.sub(r'[^\w\s\-]', '', title)[:80].strip() or dt.strftime('%Y%m%d')
                cf = CACHE_DIR / f"{safe}.md"
                cf.write_text(craft_md, encoding='utf-8')
                cmd = [sys.executable, str(PUSH_PY), "--title", title, "--content-file", str(cf), "--background"]
                if craft_folder_id:
                    cmd += ["--folder-id", craft_folder_id]
                subprocess.run(cmd, capture_output=True, text=True)
        except Exception:
            pass  # best-effort secondary output


def main() -> None:
    msg = read_message()
    if not msg:
        send_message({"status": "error", "error": "empty message"})
        return

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
            path = result.stdout.strip().rstrip("/")
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
            msg.get("fileBackupPath", "~/Downloads/meeting-notes"),
        )
        send_message({"status": "ok", "results": results})
        return

    if msg.get("type") == "prior_context":
        prior = find_prior_note(
            msg.get("meetingTitle", "").strip(),
            msg.get("fileBackupPath", "~/Downloads/meeting-notes"),
        )
        ctx = ""
        if prior:
            text = prior.read_text(encoding="utf-8", errors="ignore")
            ctx = build_prior_context(text, _note_date_from(text, prior))
        send_message({"status": "ok", "context": ctx})
        return

    transcript = msg.get("transcript", "").strip()
    if not transcript:
        send_message({"status": "error", "error": "transcript is empty"})
        return

    # parse_transcript strips the TITLE: line from the body (we ignore the
    # extracted title — the tab name is the source of truth now)
    _, craft_md = parse_transcript(transcript)

    # Resolve the timestamp — convert to local timezone so the Craft note title
    # shows wall-clock time rather than UTC (e.g. 09:12 CEST not 07:12 UTC).
    timestamp_str = msg.get("timestamp", "")
    try:
        dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        dt = datetime.now()  # local time as fallback
    date_prefix = dt.strftime("%Y%m%d")

    # Title: always YYYYMMDD HH:MM + meeting name (or "Meeting" fallback)
    tab_title = msg.get("meetingTitle", "").strip()
    label     = tab_title or "Meeting"
    title     = f"{dt.strftime('%Y%m%d %H:%M')} {label}"

    file_backup_enabled = msg.get("fileBackupEnabled", False)
    file_backup_type    = msg.get("fileBackupType", "markdown")
    file_backup_path    = Path(msg.get("fileBackupPath", "~/meeting-notes")).expanduser()

    # Optional file backup
    file_ext  = ".txt" if file_backup_type == "txt" else ".md"
    slug      = title[9:].lower().replace(" ", "-")[:50] if len(title) > 8 else title[:60]
    file_path = None
    if file_backup_enabled:
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
        ) if file_ext == ".md" else ""
        file_path.write_text(fm + craft_md, encoding="utf-8")

    # Generic webhook (P9-D) — POST the structured note before the output routing
    # sends its response (the host process is terminated once the response is read).
    # Best-effort: webhook failures never affect the capture result.
    webhook_url = (msg.get("webhookUrl") or "").strip()
    if webhook_url:
        post_webhook(
            webhook_url,
            build_webhook_payload(
                title, dt.strftime('%Y-%m-%d'),
                msg.get("attendees") or [], msg.get("durationMin"),
                parse_note_sections(craft_md),
            ),
            timeout=6.0,
        )

    back_type = msg.get("backupType", "craft")

    # Multi-destination (P9-X) — write to any "also send to" extras best-effort
    # before the primary output drives the response.
    extras = resolve_extras(back_type, msg.get("alsoSend"))
    if extras:
        send_to_extras(extras, craft_md, title, dt, label,
                       obsidian_vault_path=msg.get("obsidianVaultPath", ""),
                       craft_folder_id=msg.get("craftFolderId", "").strip())

    if route_output(back_type, craft_md, title, file_path,
                    obsidian_vault_path=msg.get("obsidianVaultPath", ""),
                    dt=dt, label=label):
        return

    # back_type == 'craft' (or anything unrecognised) → fall through to Craft push

    # Exit-code → human message map (must match push_to_craft.py exit codes)
    PUSH_EXIT_MESSAGES = {
        1: 'Craft is not running — open Craft and try again',
        2: 'Note file not found — try capturing again',
        3: 'Could not open Craft URL',
    }

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        safe_title = re.sub(r'[^\w\s\-]', '', title)[:80].strip() or date_prefix
        note_path  = CACHE_DIR / f"{safe_title}.md"
        note_path.write_text(craft_md, encoding="utf-8")

        space_id  = os.environ.get("CRAFT_SPACE_ID", "")
        folder_id = msg.get("craftFolderId", "").strip()
        cmd = [sys.executable, str(PUSH_PY), "--title", title,
               "--content-file", str(note_path), "--background"]
        if space_id:
            cmd += ["--space-id", space_id]
        if folder_id:
            cmd += ["--folder-id", folder_id]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0:
            notify("Meeting Notes → Craft", title)
            response: dict = {"status": "ok", "title": title}
            if file_path:
                response["file"] = str(file_path)
            send_message(response)
        else:
            # Primary push failed — retry once with most recent snapshot file (E2)
            snap_slug = re.sub(r'[^\w\-]', '', label.lower().replace(" ", "-"), flags=re.ASCII)[:50]
            snap_file = find_latest_snapshot(file_backup_path, snap_slug, file_ext) \
                        if file_backup_enabled else None

            if snap_file:
                retry = subprocess.run(
                    [sys.executable, str(PUSH_PY), "--title", title,
                     "--content-file", str(snap_file), "--background"],
                    capture_output=True, text=True,
                )
                if retry.returncode == 0:
                    notify("Meeting Notes → Craft", title)
                    resp: dict = {"status": "ok", "title": title, "retried": True}
                    if file_path:
                        resp["file"] = str(file_path)
                    send_message(resp)
                    return

            # Both attempts failed (or no snapshot available) — include backup path
            backup_hint = str(snap_file or file_path or "")
            error = PUSH_EXIT_MESSAGES.get(
                result.returncode,
                result.stderr.strip() or f"push_to_craft exited {result.returncode}",
            )
            response_d: dict = {"status": "error", "error": error}
            if backup_hint:
                response_d["backupPath"] = backup_hint
            send_message(response_d)
    except Exception as exc:
        send_message({"status": "error", "error": str(exc)})
    # No finally: note_path lives in CACHE_DIR — cleaned up by push_to_craft.py
    # on the next run (files older than 2 h are deleted automatically).


if __name__ == "__main__":
    main()
