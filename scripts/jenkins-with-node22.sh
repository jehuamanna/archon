#!/usr/bin/env bash
# Ensure Node.js 22 is on PATH for Jenkins (system node or NVM), then exec the given command.
# Usage from workspace root: bash scripts/jenkins-with-node22.sh npm run deploy -- --stop-old
set -euo pipefail

cd "${WORKSPACE:-.}"

ensure_node22() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.version.slice(1).split('.')[0]" 2>/dev/null || echo "")"
    if [[ "$major" == "22" ]]; then
      return 0
    fi
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    echo "[jenkins-node] Need Node.js 22 on PATH or NVM with nvm.sh at NVM_DIR=$NVM_DIR" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  if ! nvm use 22 2>/dev/null; then
    nvm install 22
    nvm use 22
  fi
}

ensure_node22
exec "$@"
