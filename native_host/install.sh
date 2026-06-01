#!/usr/bin/env bash
# install.sh — registers the native messaging host with Chrome on macOS.
#
# Usage:
#   bash install.sh                    # prompts for extension ID
#   bash install.sh <extension-id>     # non-interactive, useful when run from the popup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PY="$SCRIPT_DIR/meeting_minutes_host.py"
PUSH_PY="$SCRIPT_DIR/../scripts/push_to_craft.py"
CHROME_HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_NAME="io.gememo.host"

# Install the host files to ~/Library/Application Support/ so Chrome can
# always execute them — files in ~/Documents may be blocked by macOS TCC.
INSTALL_DIR="$HOME/Library/Application Support/MeetingMinutesToCraft"
INSTALLED_PY="$INSTALL_DIR/meeting_minutes_host.py"
WRAPPER="$INSTALL_DIR/run_host.sh"

echo "=== Gememo — Native Host Setup ==="
echo ""

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found. Install Python 3 and try again." >&2
  exit 1
fi

PYTHON3="$(command -v python3)"

# Copy the Python host and push script to a TCC-safe location and create the wrapper there.
mkdir -p "$INSTALL_DIR"
cp "$HOST_PY" "$INSTALLED_PY"
cp "$PUSH_PY" "$INSTALL_DIR/push_to_craft.py"
chmod +x "$INSTALLED_PY"

# Detect Craft space ID from the local app cache so notes always land in
# the right space (Unsorted view). Falls back to empty — Craft then uses
# whatever space is currently active.
CRAFT_SPACE_ID=""
CRAFT_CACHE_DIR="$HOME/Library/Containers/com.lukilabs.lukiapp/Data/Documents/QuickSearchAutoCompleteAPICache"
CACHE_FILE=$(ls "$CRAFT_CACHE_DIR"/serverSideQuickSearchAutoComplete_*__en 2>/dev/null | head -1)
if [[ -n "$CACHE_FILE" ]]; then
  CRAFT_SPACE_ID=$(python3 -c "
import json, re, pathlib, sys
try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_bytes())
    for item in data.get('items', []):
        sid = item.get('spaceId','')
        if sid:
            print(sid); break
except: pass
" "$CACHE_FILE" 2>/dev/null)
fi

cat > "$WRAPPER" <<WRAPPER_EOF
#!/bin/bash
export CRAFT_SPACE_ID="$CRAFT_SPACE_ID"
exec "$PYTHON3" "$INSTALLED_PY"
WRAPPER_EOF
chmod +x "$WRAPPER"

# Accept extension ID as first arg or prompt interactively
EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Step 1 — Load the extension in Chrome"
  echo ""
  echo "  1. Open chrome://extensions"
  echo "  2. Enable Developer mode (toggle, top-right)"
  echo "  3. Click 'Load unpacked' → select: $SCRIPT_DIR/../extension"
  echo "  4. Copy the 32-character ID shown under the extension name"
  echo ""
  read -rp "Paste extension ID: " EXT_ID
fi

if [[ -z "$EXT_ID" ]]; then
  echo "Error: extension ID cannot be empty." >&2
  exit 1
fi

if ! [[ "$EXT_ID" =~ ^[a-z]{32}$ ]]; then
  echo "Warning: '$EXT_ID' doesn't look like a Chrome extension ID (32 lowercase letters)."
  echo "Continuing anyway — double-check it in chrome://extensions."
fi

echo ""
echo "Writing native messaging manifest..."

mkdir -p "$CHROME_HOSTS"

python3 - <<PYEOF
import json, pathlib

manifest = {
    "name": "$HOST_NAME",
    "description": "Gememo native messaging host",
    "path": "$WRAPPER",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://$EXT_ID/"]
}

out = pathlib.Path("$CHROME_HOSTS") / "$HOST_NAME.json"
out.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"  Written: {out}")
PYEOF

echo ""
echo "Done. Reload the extension in chrome://extensions, then open a Google Meet."
echo "When you leave a call, your meeting notes will be saved to Craft automatically."
echo ""
echo "Optional — pin notes to a specific Craft space:"
echo "  export CRAFT_SPACE_ID=<your-space-id>"
echo "  (Find it: right-click any Craft doc → Copy Deeplink → grab spaceId from the URL)"
