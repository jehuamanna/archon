#!/usr/bin/env bash
# Shared post-receive implementation: mirror refs to GitHub + tag-triggered deploy.
# Install once on the server:
#   sudo install -d -m 0755 /srv/git/bin
#   sudo install -m 0755 post-receive-shared.sh /srv/git/bin/post-receive-shared.sh
# Each bare repo uses a small hooks/post-receive wrapper (see post-receive.example).
#
# Environment (set by wrapper or ssh environment):
#   BARE_GIT_DIR    — bare repo path
#   GITHUB_REMOTE   — default: github
#   DEPLOY_ROOT     — non-bare checkout for npm run deploy
#   DEPLOY_LOCK     — flock file
#   TAG_PATTERN     — default: ^v
#   FLOCK_WAIT_SEC  — default: 7200
#
# Ref: https://git-scm.com/docs/githooks#Documentation/githooks.txt-post-receive

set -euo pipefail

# ============================== CONFIG (defaults; override via wrapper / env) ===
BARE_GIT_DIR="${BARE_GIT_DIR:-/srv/git/archon/archon.git}"
GITHUB_REMOTE="${GITHUB_REMOTE:-github}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/lib/archon/checkout}"
DEPLOY_LOCK="${DEPLOY_LOCK:-/var/lib/archon/deploy.lock}"
TAG_PATTERN="${TAG_PATTERN:-^v}"
FLOCK_WAIT_SEC="${FLOCK_WAIT_SEC:-7200}"
# =============================================================================

ZERO_OID="0000000000000000000000000000000000000000"

log() { echo "[archon-post-receive] $*" >&2; }

if [[ ! -d "$BARE_GIT_DIR" ]]; then
  log "BARE_GIT_DIR is not a directory: $BARE_GIT_DIR"
  exit 1
fi

git_bare=(git --git-dir="$BARE_GIT_DIR")

if ! "${git_bare[@]}" remote get-url "$GITHUB_REMOTE" &>/dev/null; then
  log "Bare repo missing remote '$GITHUB_REMOTE'. Add it with: git --git-dir=\"$BARE_GIT_DIR\" remote add $GITHUB_REMOTE <url>"
  exit 1
fi

declare -a RELEASE_TAGS=()

sync_ref_to_github() {
  local oldrev=$1 newrev=$2 refname=$3

  if [[ "$newrev" == "$ZERO_OID" ]]; then
    log "Mirror delete to $GITHUB_REMOTE: $refname"
    if ! "${git_bare[@]}" push "$GITHUB_REMOTE" ":$refname"; then
      log "ERROR: failed to delete $refname on $GITHUB_REMOTE"
      return 1
    fi
    return 0
  fi

  log "Mirror to $GITHUB_REMOTE: $newrev -> $refname"
  if ! "${git_bare[@]}" push "$GITHUB_REMOTE" "$newrev:$refname"; then
    log "ERROR: failed to push $refname to $GITHUB_REMOTE (non-fast-forward? resolve manually on server)"
    return 1
  fi
}

while read -r oldrev newrev refname; do
  [[ -z "${refname:-}" ]] && continue
  if ! sync_ref_to_github "$oldrev" "$newrev" "$refname"; then
    log "Aborting: GitHub sync failed for $refname"
    exit 1
  fi

  if [[ "$refname" == refs/tags/* && "$newrev" != "$ZERO_OID" ]]; then
    tag="${refname#refs/tags/}"
    if [[ "$tag" =~ $TAG_PATTERN ]]; then
      RELEASE_TAGS+=("$tag")
    fi
  fi
done

if ((${#RELEASE_TAGS[@]} == 0)); then
  log "Done (no release tag in this push)."
  exit 0
fi

tag_to_deploy="$(printf '%s\n' "${RELEASE_TAGS[@]}" | sort -V | tail -1)"
log "Release tag selected for deploy: $tag_to_deploy (from: ${RELEASE_TAGS[*]})"

if [[ ! -d "$DEPLOY_ROOT/.git" ]]; then
  log "DEPLOY_ROOT is not a git checkout: $DEPLOY_ROOT"
  exit 1
fi

mkdir -p "$(dirname "$DEPLOY_LOCK")"
touch "$DEPLOY_LOCK" 2>/dev/null || true

exec 200>"$DEPLOY_LOCK"
if ! flock -w "$FLOCK_WAIT_SEC" 200; then
  log "ERROR: could not acquire deploy lock $DEPLOY_LOCK within ${FLOCK_WAIT_SEC}s"
  exit 1
fi

log "Fetching and checking out $tag_to_deploy in $DEPLOY_ROOT"
git -C "$DEPLOY_ROOT" fetch origin
git -C "$DEPLOY_ROOT" checkout -f "$tag_to_deploy"

log "npm ci + deploy (--stop-old)"
cd "$DEPLOY_ROOT"
npm ci
npm run deploy -- --stop-old

log "Deploy finished OK for $tag_to_deploy"
exit 0
