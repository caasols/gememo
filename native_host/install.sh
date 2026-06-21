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
EDGE_BASE="$HOME/Library/Application Support/Microsoft Edge"
EDGE_HOSTS="$EDGE_BASE/NativeMessagingHosts"
HOST_NAME="io.gememo.host"

# Install the host to ~/Library/Application Support/Gememo so Chrome can
# always execute it — files in ~/Documents may be blocked by macOS TCC.
# meeting_minutes_host.py and push_to_craft.py are symlinked to the project
# so changes propagate without re-running install.
INSTALL_DIR="$HOME/Library/Application Support/Gememo"
INSTALLED_PY="$INSTALL_DIR/meeting_minutes_host.py"
WRAPPER="$INSTALL_DIR/run_host.sh"

echo "=== Gememo — Native Host Setup ==="
echo ""

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found. Install Python 3 and try again." >&2
  exit 1
fi

PYTHON3="$(command -v python3)"

# Symlink the Python host and push script so changes in the project propagate
# automatically without re-running install.
mkdir -p "$INSTALL_DIR"

# Remove old MeetingMinutesToCraft directory if present from a previous install
OLD_DIR="$HOME/Library/Application Support/MeetingMinutesToCraft"
if [[ -d "$OLD_DIR" ]]; then
  echo "Removing old install directory: $OLD_DIR"
  rm -rf "$OLD_DIR"
fi

ln -sf "$HOST_PY" "$INSTALLED_PY"
ln -sf "$PUSH_PY" "$INSTALL_DIR/push_to_craft.py"
chmod +x "$INSTALLED_PY"

# 5.3 — Google Calendar enrichment deps in an isolated venv (best-effort; if this
# fails the optional feature simply stays off and core capture is unaffected).
VENV_DIR="$INSTALL_DIR/venv"
if "$PYTHON3" -m venv "$VENV_DIR" 2>/dev/null; then
  "$VENV_DIR/bin/python3" -m pip install --quiet --upgrade pip 2>/dev/null || true
  if "$VENV_DIR/bin/python3" -m pip install --quiet google-auth google-auth-oauthlib google-api-python-client 2>/dev/null; then
    echo "  Google Calendar libraries installed (optional 5.3 feature available)."
  else
    echo "  (Optional) Google Calendar libraries not installed — Calendar feature stays off."
  fi
else
  echo "  (Optional) Could not create venv — Google Calendar feature stays off."
fi

# Detect Craft space ID from the local app cache so notes always land in
# the right space (Unsorted view). Falls back to empty — Craft then uses
# whatever space is currently active.
CRAFT_SPACE_ID=""
CRAFT_CACHE_DIR="$HOME/Library/Containers/com.lukilabs.lukiapp/Data/Documents/QuickSearchAutoCompleteAPICache"
# `|| true` so an unmatched glob (e.g. Craft not installed) can't abort the whole
# install under `set -euo pipefail` — this is an optional best-effort lookup.
CACHE_FILE=$(ls "$CRAFT_CACHE_DIR"/serverSideQuickSearchAutoComplete_*__en 2>/dev/null | head -1) || true
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
# Prefer the venv python (has the optional Google Calendar libs); fall back to system.
PYBIN="$PYTHON3"
[ -x "$VENV_DIR/bin/python3" ] && PYBIN="$VENV_DIR/bin/python3"
exec "\$PYBIN" "$INSTALLED_PY"
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

# Register with every Chromium browser present (RB-2b). Edge (Chromium) uses
# the same MV3 + chrome-extension:// native-messaging contract as Chrome — only
# the NativeMessagingHosts directory differs. Chrome is always written; Edge is
# written when Edge is installed.
HOST_DIRS=("$CHROME_HOSTS")
if [[ -d "$EDGE_BASE" ]]; then
  HOST_DIRS+=("$EDGE_HOSTS")
  echo "  Microsoft Edge detected — registering for Edge too."
fi

for HOSTS_DIR in "${HOST_DIRS[@]}"; do
  mkdir -p "$HOSTS_DIR"
  python3 - "$HOSTS_DIR" <<PYEOF
import json, pathlib, sys

manifest = {
    "name": "$HOST_NAME",
    "description": "Gememo native messaging host",
    "path": "$WRAPPER",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://$EXT_ID/"]
}

out = pathlib.Path(sys.argv[1]) / "$HOST_NAME.json"
out.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"  Written: {out}")
PYEOF
done

echo ""
echo "Done. Reload the extension in chrome://extensions (or edge://extensions), then open a Google Meet."
echo "When you leave a call, your meeting notes will be saved to Craft automatically."
echo ""
echo "Optional — pin notes to a specific Craft space:"
echo "  export CRAFT_SPACE_ID=<your-space-id>"
echo "  (Find it: right-click any Craft doc → Copy Deeplink → grab spaceId from the URL)"
