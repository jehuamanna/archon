#!/usr/bin/env bash
# Build distributables via Electron Forge (delegates to npm scripts).
# Usage: ./build.sh linux|windows|mac|all
#
# Or: npm run build:linux | build:windows | build:mac | build:all
#
# Final artifacts (versioned from package.json) are copied to dist/deb, dist/appimage,
# dist/exe, dist/dmg — never deleted by clean:forge. Plugins go to dist/plugins.
#
# Note: Producing Windows/macOS installers usually requires running that target on the
# respective OS (or a CI matrix). Linux hosts typically build Linux artifacts reliably.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

usage() {
  echo "Usage: $0 {linux|windows|mac|all}" >&2
  exit 1
}

TARGET="${1:-}"
case "$TARGET" in
  linux)
    npm run build:linux
    echo "Installers: $ROOT/dist/deb, $ROOT/dist/appimage"
    ;;
  windows|win)
    npm run build:windows
    echo "Installers: $ROOT/dist/exe"
    ;;
  mac|darwin|macos)
    npm run build:mac
    echo "Installers: $ROOT/dist/dmg"
    ;;
  all)
    npm run build:all
    echo "Installers: $ROOT/dist/{deb,appimage,exe,dmg} — plugins: $ROOT/dist/plugins"
    ;;
  -h|--help|help)
    echo "Build Archon distributables."
    echo ""
    echo "  linux    — .deb + AppImage → dist/deb, dist/appimage"
    echo "  windows  — Squirrel Setup.exe → dist/exe"
    echo "  mac      — .dmg → dist/dmg"
    echo "  all      — linux, windows, mac, then plugins → dist/plugins"
    echo ""
    echo "Same as: npm run build:linux | build:windows | build:mac | build:all"
    echo "Staging (cleaned by npm run clean:forge): out/"
    echo "Plugins only: npm run build:plugins → dist/plugins"
    exit 0
    ;;
  *)
    usage
    ;;
esac
