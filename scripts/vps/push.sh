#!/usr/bin/env bash
# Local-side promotion: push a committed git ref to origin, then run the VPS
# update for that ref over SSH. One explicit command from "ref is ready" to
# "VPS gateway runs it".
#
#   scripts/vps/push.sh --direct-deploy \
#     --target chief-moa-production --host root@vps --commit <full-sha>
#
# This mutates the active remote gateway, so it is a PROMOTION under the
# live-app freeze: run it only when the user explicitly asks to deploy or
# promote in the current turn. It is intentionally not wired into
# `scripts/deploy.sh auto` (the hook target), so no background or cron run
# can promote the VPS by accident. Preview, drain, compatibility, rollback,
# and post-apply health gates stay on the VPS side.
#
# The host is never guessed. It must come from --host or MOA_VPS_SSH.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${MOA_VPS_SSH:-}"
REF=""
EXPECTED_COMMIT=""
DIRECT_DEPLOY=false
EXPECTED_TARGET=""
DEPLOY_TARGETS_FILE="$ROOT_DIR/scripts/deploy-targets.json"
REMOTE_APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      if [ -z "${2:-}" ]; then
        echo "--host requires user@host" >&2
        exit 1
      fi
      HOST="$2"
      shift 2
      ;;
    --ref)
      if [ -z "${2:-}" ]; then
        echo "--ref requires a branch name" >&2
        exit 1
      fi
      REF="$2"
      shift 2
      ;;
    --commit)
      [ -n "${2:-}" ] || { echo "--commit requires a full SHA" >&2; exit 1; }
      EXPECTED_COMMIT="$2"
      shift 2
      ;;
    --direct-deploy) DIRECT_DEPLOY=true; shift ;;
    --target)
      [ -n "${2:-}" ] || { echo "--target requires an identity" >&2; exit 1; }
      EXPECTED_TARGET="$2"
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

read_target_field() {
  node - "$DEPLOY_TARGETS_FILE" "$1" <<'NODE'
const fs = require("node:fs");
const [file, field] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"))?.production?.[field];
if (typeof value !== "string" || !value) process.exit(1);
process.stdout.write(value);
NODE
}

configured_identity="$(read_target_field identity 2>/dev/null || true)"
configured_host="$(read_target_field vps_ssh 2>/dev/null || true)"
[ "$DIRECT_DEPLOY" = true ] || { echo "Remote gateway effects require --direct-deploy." >&2; exit 1; }
[ -n "$configured_identity" ] && [ "$EXPECTED_TARGET" = "$configured_identity" ] \
  || { echo "Gateway target identity mismatch." >&2; exit 1; }
[ "$HOST" = "$configured_host" ] \
  || { echo "Gateway host does not match the verified production target." >&2; exit 1; }

if [ -z "$HOST" ]; then
  echo "No VPS host. Pass --host user@vps or set MOA_VPS_SSH." >&2
  exit 1
fi

if [ -z "$REF" ] && [ -z "$EXPECTED_COMMIT" ]; then
  REF="$(git -C "$ROOT_DIR" symbolic-ref --short -q HEAD || true)"
  if [ -z "$REF" ]; then
    echo "Detached HEAD; pass --ref <branch>." >&2
    exit 1
  fi
fi

if [ -n "$EXPECTED_COMMIT" ]; then
  [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "--commit must be a full lowercase Git SHA." >&2; exit 1; }
  [ "$(git -C "$ROOT_DIR" rev-parse --verify "${EXPECTED_COMMIT}^{commit}" 2>/dev/null || true)" = "$EXPECTED_COMMIT" ] \
    || { echo "Pinned candidate commit is not available locally." >&2; exit 1; }
  local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [ "$local_head" = "$EXPECTED_COMMIT" ] \
    || { echo "Worktree HEAD moved after verification." >&2; exit 1; }
  REF="direct-candidate-$EXPECTED_COMMIT"
fi

# Refuse to promote past uncommitted deploy-path work: the VPS pulls from
# origin, so dirty gateway/compose/script files would silently not ship.
dirty="$(git -C "$ROOT_DIR" status --porcelain -- \
  gateway docker-compose.yml docker-compose.vps.yml gateway/deploy/vps scripts/vps)"
if [ -n "$dirty" ]; then
  echo "Uncommitted changes on the VPS deploy path:" >&2
  printf '%s\n' "$dirty" >&2
  echo "Commit them (or clean the tree) before promoting." >&2
  exit 1
fi

# Make sure origin has the exact commit being promoted. Push only when the
# local branch is ahead of (or absent from) origin. Refuse behind/diverged
# branches so promotion never picks an ambiguous commit.
local_sha="$(git -C "$ROOT_DIR" rev-parse --verify --quiet "refs/heads/$REF" || true)"
if [ -n "$EXPECTED_COMMIT" ]; then
  local_sha="$EXPECTED_COMMIT"
fi
if [ -n "$local_sha" ]; then
  remote_sha="$(git -C "$ROOT_DIR" ls-remote --heads origin "$REF" | awk '{print $1}')"
  if [ -z "$remote_sha" ]; then
    echo "Pushing new branch $REF to origin..."
    git -C "$ROOT_DIR" push origin "$local_sha:refs/heads/$REF"
  elif [ "$remote_sha" = "$local_sha" ]; then
    echo "origin/$REF is already at $local_sha."
  elif git -C "$ROOT_DIR" merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    echo "Pushing $REF to origin..."
    git -C "$ROOT_DIR" push origin "$local_sha:refs/heads/$REF"
  elif git -C "$ROOT_DIR" merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    echo "Local $REF is behind origin/$REF; pull/rebase before promoting." >&2
    exit 1
  else
    echo "Local $REF and origin/$REF have diverged; resolve before promoting." >&2
    exit 1
  fi
else
  git -C "$ROOT_DIR" ls-remote --exit-code --heads origin "$REF" >/dev/null || {
    echo "Ref $REF is neither a local branch nor an origin branch." >&2
    exit 1
  }
fi

echo "Promoting origin/$REF on $HOST (preview + drain + rollback gates run first)..."
# BatchMode fails fast instead of hanging on a password prompt.
remote_update_cmd="$(printf 'APP_DIR=%q %q %q' \
  "$REMOTE_APP_DIR" "$REMOTE_APP_DIR/scripts/vps/promote-candidate.sh" "$REF")"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  "$remote_update_cmd"
