#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
VERSION=$(jq -r '.version' manifest.json)
OUT="metadata-filler-${VERSION}.xpi"
rm -f "$OUT"

# The Apple-only Swift helper is OPT-IN for local builds: most people don't
# need it, and merely invoking `swift` on a Mac without Xcode CLI tools
# triggers an install prompt. Set MF_BUILD_HELPER=1 to include it.
#
# CI builds the helper unconditionally (see .github/workflows/build.yml)
# and ships it inside the released .xpi.
if [ "${MF_BUILD_HELPER:-0}" = "1" ]; then
  if [ "$(uname)" != "Darwin" ]; then
    echo "MF_BUILD_HELPER=1 set but this isn't macOS — skipping helper build."
  elif ! xcode-select -p >/dev/null 2>&1; then
    echo "MF_BUILD_HELPER=1 set but Xcode CLI tools aren't installed — skipping helper build."
    echo "  Run: xcode-select --install"
  elif ! command -v swift >/dev/null 2>&1; then
    echo "MF_BUILD_HELPER=1 set but 'swift' isn't on PATH — skipping helper build."
  else
    echo "→ Building fm-helper (MF_BUILD_HELPER=1)"
    if (cd fm-helper && swift build -c release --arch arm64) ; then
      mkdir -p bin
      cp fm-helper/.build/arm64-apple-macosx/release/fm-helper bin/fm-helper
      codesign --sign - --force --timestamp=none bin/fm-helper || true
      chmod +x bin/fm-helper
      echo "  ✓ helper built and ad-hoc signed"
    else
      echo "  ✗ helper build failed (likely missing macOS 26 SDK). Skipping."
    fi
  fi
fi

BIN_ARG=""
if [ -f bin/fm-helper ]; then BIN_ARG="bin/"; fi

# Include fm-helper/ source (Package.swift + Sources/) inside the .xpi so the
# in-dialog "Build helper now" button has something to compile against on
# the user's Mac. Excludes build artifacts.
HELPER_SRC=""
if [ -d fm-helper ]; then HELPER_SRC="fm-helper/"; fi

zip -r "$OUT" manifest.json bootstrap.js lib/ content/ locale/ $BIN_ARG $HELPER_SRC \
  -x "*.DS_Store" "*/.DS_Store" \
     "fm-helper/.build/*" "fm-helper/.swiftpm/*" "fm-helper/Package.resolved"
echo "Built $OUT"
