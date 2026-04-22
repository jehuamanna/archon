#!/usr/bin/env bash
# POST /auth/mcp/device/start against a deployed sync API (Option B Next or standalone).
# Usage:
#   bash scripts/verify-mcp-device-start.sh [ARCHON_SYNC_API_BASE]
# Env fallback: ARCHON_SYNC_API_VERIFY_BASE (must include /api/v1, no trailing slash).
# Example:
#   bash scripts/verify-mcp-device-start.sh https://archon.studio/api/v1
set -euo pipefail
RAW="${1:-${ARCHON_SYNC_API_VERIFY_BASE:-https://archon.studio/api/v1}}"
BASE="${RAW%/}"
URL="${BASE}/auth/mcp/device/start"
echo "POST ${URL}"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT
CODE="$(curl -sS -o "${TMP}" -w "%{http_code}" -X POST "${URL}" \
  -H "Content-Type: application/json" -d '{}')"
if [[ "${CODE}" != "200" ]]; then
  echo "Expected HTTP 200, got ${CODE}"
  cat "${TMP}"
  exit 1
fi
export VERIFY_MCP_BODY
VERIFY_MCP_BODY="$(cat "${TMP}")"
node -e '
const j = JSON.parse(process.env.VERIFY_MCP_BODY || "{}");
if (typeof j.verification_uri !== "string" || !j.verification_uri.includes("mcp-auth")) {
  console.error("Response missing verification_uri pointing at mcp-auth:", j);
  process.exit(1);
}
if (typeof j.device_code !== "string" || j.device_code.length < 8) {
  console.error("Response missing device_code:", j);
  process.exit(1);
}
console.log("OK: verification_uri and device_code present.");
console.log(j.verification_uri);
'
