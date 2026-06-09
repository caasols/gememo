#!/usr/bin/env python3
"""
Push a markdown document into Craft via craftdocs://createdocument.

The caller (meeting_minutes_host.py) writes the note to ~/.cache/mm2c/ and passes
its path via --content-file. This file reads it, strips YAML frontmatter, and
hands an inline-content craftdocs://createdocument URL to macOS `open`.

createdocument (content encoded inline in the URL) replaced the older
craftdocs://x-callback-url/importDocument file-staging flow, which Craft's
sandbox blocked from reading staged files on macOS 26.5+.

Usage:
    python3 push_to_craft.py --title "YYYYMMDD HH:MM MEETING TITLE" \\
        --content-file /absolute/path/to/note.md \\
        [--space-id <spaceId>] \\
        [--folder-id <folderId>] \\
        [--background]

Exit codes:
    0 — document URL handed to Craft
    2 — content file not found
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

CACHE_DIR = Path.home() / ".cache" / "mm2c"


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
        return subprocess.run(cmd, check=False, timeout=30).returncode
    except FileNotFoundError:
        print("Error: `open` command not found.", file=sys.stderr)
        return 127
    except subprocess.TimeoutExpired:
        print("Error: `open` timed out.", file=sys.stderr)
        return 124


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
