#!/usr/bin/env bash
#
# Cut a GitHub release for the current extension version.
#
#   scripts/release.sh            # tag + push + create the release
#   scripts/release.sh --dry-run  # show what it would do, change nothing
#
# Reads the version from extension/manifest.json, pulls the matching section
# from CHANGELOG.md as the release notes, builds a clean source zip with
# `git archive` (gitignored files excluded), then tags and publishes via gh.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── 1. Version from the manifest ─────────────────────────────────────────────
VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' extension/manifest.json \
           | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')"
[[ -n "$VERSION" ]] || { echo "✗ could not read version from extension/manifest.json"; exit 1; }
TAG="v$VERSION"
echo "→ Version $VERSION  (tag $TAG)"

# ── 2. Preconditions ─────────────────────────────────────────────────────────
command -v gh >/dev/null         || { echo "✗ gh CLI not found (brew install gh)"; exit 1; }
gh auth status >/dev/null 2>&1   || { echo "✗ gh not authenticated (gh auth login)"; exit 1; }

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "⚠ tag $TAG already exists"
  $DRY_RUN || { echo "  → bump the version in extension/manifest.json first"; exit 1; }
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠ working tree is not clean — commit & push before releasing"
  $DRY_RUN || exit 1
fi

# ── 3. Release notes from the matching CHANGELOG section ─────────────────────
NOTES_FILE="$(mktemp)"
ZIP_DIR="$(mktemp -d)"
trap 'rm -rf "$NOTES_FILE" "$ZIP_DIR"' EXIT

awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" { flag=1; print; next }
  flag && /^## \[/         { exit }
  flag                     { print }
' CHANGELOG.md > "$NOTES_FILE"
[[ -s "$NOTES_FILE" ]] || echo "⚠ no CHANGELOG section for $VERSION — will use auto-generated notes"

# ── 4. Clean source zip at HEAD (the commit being tagged) ────────────────────
ZIP="$ZIP_DIR/gememo-$VERSION.zip"
git archive --format=zip --prefix="gememo-$VERSION/" HEAD -o "$ZIP"
echo "→ Built gememo-$VERSION.zip ($(du -h "$ZIP" | cut -f1))"

# ── 5. Tag, push, publish ────────────────────────────────────────────────────
if $DRY_RUN; then
  echo "── DRY RUN — would run:"
  echo "     git tag -a $TAG -m 'Gememo $TAG' && git push origin $TAG"
  echo "     gh release create $TAG --title $TAG --notes-file <below> gememo-$VERSION.zip"
  echo "── notes preview ─────────────────────────────────────────────"
  cat "$NOTES_FILE"
  exit 0
fi

git tag -a "$TAG" -m "Gememo $TAG"
git push origin "$TAG"

if [[ -s "$NOTES_FILE" ]]; then
  gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE" "$ZIP"
else
  gh release create "$TAG" --title "$TAG" --generate-notes "$ZIP"
fi

echo "✓ Released $TAG"
