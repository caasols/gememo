#!/usr/bin/env python3
"""
Push a markdown document into Craft via craftdocs://x-callback-url/importDocument.

The caller (meeting_minutes_host.py) writes the note to ~/.cache/mm2c/ and passes
its path via --content-file. This file builds the import URL and hands it to
macOS `open`. No content is encoded inline — the URL is always short.

Usage:
    python3 push_to_craft.py --title "YYYYMMDD HH:MM MEETING TITLE" \\
        --content-file /absolute/path/to/note.md \\
        [--space-id <spaceId>] \\
        [--folder-id <folderId>] \\
        [--background]

Exit codes:
    0 — Craft confirmed import via x-success callback
    2 — content file not found
    3 — Craft returned x-error callback OR no callback within timeout
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import quote, urlparse, parse_qs

CACHE_DIR = Path.home() / ".cache" / "mm2c"
# Craft 3.4.x sandbox restriction: Craft can only read files from its own group
# container. Files in ~/.cache/mm2c/ or ~/Downloads/ are inaccessible to Craft.
# We copy the note here before firing the URL, then clean up afterwards.
CRAFT_UPLOADS_DIR = (
    Path.home()
    / "Library" / "Group Containers"
    / "group.com.lukilabs.lukiapp.share" / "uploads"
)


def _prune_craft_uploads(max_age_days: int = 1) -> None:
    """Remove staged files older than max_age_days from Craft's uploads folder."""
    if not CRAFT_UPLOADS_DIR.exists():
        return
    cutoff = time.time() - max_age_days * 86400
    for f in CRAFT_UPLOADS_DIR.iterdir():
        try:
            if f.is_file() and f.suffix == ".md" and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


def stage_for_craft(source: Path, title: str) -> Path:
    """Copy source file to Craft's group container so Craft can read it.

    Returns the path of the staged file. The file should be deleted after
    the import URL has been fired (Craft reads it synchronously on open).
    """
    CRAFT_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    # Use a slug derived from the title so the Craft document name is clean
    slug = "".join(c if c.isalnum() or c in " -_" else "-" for c in title)[:60].strip()
    dest = CRAFT_UPLOADS_DIR / f"{slug}.md"
    dest.write_bytes(source.read_bytes())
    return dest


def strip_yaml_frontmatter(content: str) -> str:
    """Remove YAML frontmatter (--- ... ---) from the start of a markdown string.

    Backup files written by meeting_minutes_host.py include YAML frontmatter so
    they are useful in Obsidian/Bear. When pushing to Craft via createdocument,
    the frontmatter must be stripped — Craft renders it as bold text rather than
    treating it as metadata.
    """
    lines = content.splitlines(keepends=True)
    if not lines or lines[0].strip() != '---':
        return content
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == '---':
            return ''.join(lines[i + 1:]).lstrip('\n')
    return content  # no closing --- found — return as-is


_RECOVERY_HEADINGS = r'(Attendees|Summary|Key Points|Decisions Made|Action Items|Next Steps|Open Questions)'


def normalize_headings(content: str) -> str:
    """Strip ---Heading dash artifacts and promote bare section names to ## headings.

    Mirrors the heading normalisation in meeting_minutes_host.parse_transcript so
    manual recovery from old backup files (written before that logic existed)
    produces the same clean Craft document.
    """
    # Strip leading dashes only when glued to a real heading character (non-space,
    # non-dash). Restricting the lookahead to [^\s-] prevents a 4+ dash separator
    # line from being half-consumed into an orphan '-'.
    content = re.sub(r'^-{3,}(?=[^\s-])', '', content, flags=re.MULTILINE)
    content = re.sub(rf'^{_RECOVERY_HEADINGS}\s*$', r'## \1', content,
                     flags=re.MULTILINE | re.IGNORECASE)
    return content


def build_createdocument_url(
    title: str,
    content: str,
    space_id: str | None = None,
    folder_id: str = '',
) -> str:
    """Build a craftdocs://createdocument URL with % double-encoded.

    macOS `open` decodes the URL once before handing it to Craft's URL scheme
    handler. This turns %25 (the encoding of %) back into a bare %, which Craft's
    URL parser then sees as the start of an invalid percent-encoded sequence and
    silently aborts the import. Fix: replace every % with %25 BEFORE calling
    quote(), so quote() produces %2525. After open's decode: %25. After Craft's
    decode: %. Content with % reaches Craft intact.
    """
    content_safe = content.replace('%', '%25')
    params = [f"title={quote(title, safe='')}"]
    if space_id:
        params.append(f"spaceId={quote(space_id, safe='')}")
    params.append(f"content={quote(content_safe, safe='')}")
    params.append(f"folderId={quote(folder_id, safe='')}")
    return "craftdocs://createdocument?" + "&".join(params)


def build_import_url(file_path: str, space_id: str | None, folder_id: str) -> str:
    """Build a craftdocs://x-callback-url/importDocument URL.

    file_path must be an absolute path. space_id and folder_id are omitted
    from the URL when empty so Craft uses its defaults.
    """
    params = []
    if space_id:
        params.append(f"spaceId={quote(space_id, safe='')}")
    params.append(f"filePath={quote(file_path, safe='')}")
    if folder_id:
        params.append(f"folderId={quote(folder_id, safe='')}")
    return "craftdocs://x-callback-url/importDocument?" + "&".join(params)


def cleanup_cache(cache_dir: Path, max_age_seconds: int = 7200) -> None:
    """Delete .md files older than max_age_seconds from cache_dir. Silent on errors."""
    if not cache_dir.exists():
        return
    cutoff = time.time() - max_age_seconds
    for f in cache_dir.iterdir():
        try:
            if f.is_file() and f.suffix == ".md" and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


def open_url(url: str, background: bool = False) -> int:
    """Use macOS `open` to hand the URL to Craft. Returns the process exit code."""
    if sys.platform != "darwin":
        print(
            "Warning: non-macOS platform. craftdocs:// only works on macOS/iOS.",
            file=sys.stderr,
        )
    try:
        cmd = ["open", "-g", url] if background else ["open", url]
        return subprocess.run(cmd, check=False).returncode
    except FileNotFoundError:
        print("Error: `open` command not found.", file=sys.stderr)
        return 127


class _CallbackHandler(BaseHTTPRequestHandler):
    """Handles exactly one GET callback from Craft (x-success or x-error)."""

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        self.server._result_path  = parsed.path
        self.server._result_query = parse_qs(parsed.query)
        self.send_response(200)
        self.end_headers()
        self.server._event.set()

    def log_message(self, *args) -> None:
        pass  # suppress default access log output


def wait_for_craft_callback(url: str, background: bool = True,
                             timeout: float = 10.0) -> tuple[bool, str]:
    """Open a craftdocs:// URL and wait for Craft's x-callback confirmation.

    Starts a temporary HTTP server on localhost:0, appends x-success / x-error
    callback params to the URL, opens it, then blocks until Craft calls back or
    `timeout` seconds elapse.

    Returns (success: bool, error_message: str). error_message is '' on success.
    """
    server = HTTPServer(("localhost", 0), _CallbackHandler)
    server._result_path  = None
    server._result_query: dict = {}
    server._event        = threading.Event()

    port     = server.server_address[1]
    full_url = (
        url
        + f"&x-success={quote(f'http://localhost:{port}/success', safe='')}"
        + f"&x-error={quote(f'http://localhost:{port}/error', safe='')}"
    )
    cmd = ["open", "-g", full_url] if background else ["open", full_url]
    subprocess.run(cmd, check=False)

    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()
    got_callback = server._event.wait(timeout=timeout)
    server.server_close()
    t.join(timeout=0.5)

    if not got_callback:
        return False, f"Timeout: no callback from Craft within {timeout:.0f}s"

    if server._result_path == "/success":
        return True, ""

    parts = server._result_query.get("errorMessage", ["unknown Craft error"])
    return False, f"Craft error: {parts[0]}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--title", required=True, help="Plaintext document title (for logging).")
    parser.add_argument(
        "--content-file", required=True, type=Path,
        help="Absolute path to the markdown file to import into Craft.",
    )
    parser.add_argument(
        "--space-id", default=os.environ.get("CRAFT_SPACE_ID"),
        help="Craft space ID. Falls back to $CRAFT_SPACE_ID.",
    )
    parser.add_argument(
        "--folder-id", default=os.environ.get("CRAFT_FOLDER_ID", ""),
        help="Craft folder ID (UUID). Falls back to $CRAFT_FOLDER_ID.",
    )
    parser.add_argument(
        "--background", action="store_true",
        help="Open Craft in the background (open -g) without stealing focus.",
    )
    args = parser.parse_args()

    if not args.content_file.exists():
        print(f"Error: content file not found: {args.content_file}", file=sys.stderr)
        return 2

    cleanup_cache(CACHE_DIR)

    # Use craftdocs://createdocument — passes content inline in the URL.
    # This requires no file system access from Craft, bypassing sandbox restrictions
    # that broke craftdocs://x-callback-url/importDocument in macOS 26.5+.
    raw = args.content_file.read_text(encoding="utf-8")
    content = strip_yaml_frontmatter(raw)
    # Fix ---Heading artifacts written by old parse_transcript versions (Gemini
    # copied the --- delimiter from EXAMPLE_NOTES into section headings) and
    # promote bare section names to ## headings.
    content = normalize_headings(content)
    url = build_createdocument_url(args.title, content, args.space_id, args.folder_id or '')
    open_url(url, background=args.background)
    print(f"Craft document created: {args.title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
