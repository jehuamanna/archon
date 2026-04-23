#!/usr/bin/env bash
# Run all repo-root unit tests under src/ with Node's test runner + strip-types.
# Excludes tests that import the TS core graph without .ts extensions (Node strip-types
# cannot resolve them): run those via `tsx --test` from npm "test".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mapfile -t files < <(
  find src -name '*.test.ts' \
    ! -name 'note-vfs-link-rewrite.test.ts' \
    ! -name 'legacy-flat-to-wpn-migrate.test.ts' \
    ! -name 'refresh-session.test.ts' | sort
)
if [ "${#files[@]}" -eq 0 ]; then
  echo "No test files found under src/" >&2
  exit 1
fi
exec node --experimental-strip-types --test "${files[@]}"
