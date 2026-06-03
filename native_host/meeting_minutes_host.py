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

    date_str = ""
    if len(title) >= 8:
        try:
            date_str = datetime.strptime(title[:8], "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            pass
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")

    body = "\n".join(body_lines).strip()

    # Gemini sometimes copies the ---Heading pattern from the EXAMPLE_NOTES
    # delimiter format (e.g. "---Attendees" as one token). Strip the leading
    # dashes so the heading normalisation regex below can promote it correctly.
    body = re.sub(r'^-{3,}(?=\S)', '', body, flags=re.MULTILINE)

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
) -> str:
    """Return a YAML front-matter block for a .md backup file.

    Only called for .md files — callers guard on file_ext == '.md'.
    The snapshot flag is set to true for intermediate snapshots so they
    are distinguishable from the final capture in Obsidian / Bear / Notion.
    Attendees and duration_min are optional; omitted when empty/None.
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

    if not title:
        send_message({"status": "error", "error": "No title provided for retry"})
        return

    use_file, source = choose_retry_file(title, backup_path_str)

    if use_file is None:
        send_message({
            "status": "error",
            "error": "No recoverable file found — cache expired and backup unavailable",
        })
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
        ) if file_ext == ".md" else ""
        file_path.write_text(fm + craft_md, encoding="utf-8")

    back_type = msg.get("backupType", "craft")
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
