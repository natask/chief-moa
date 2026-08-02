#!/usr/bin/env bash
# Pull-based automatic promotion for the VPS gateway.
#
# CI (deploy-vps.yml) verifies every gateway-touching push to master and, on
# success, fast-forwards the `vps-deploy` ref to that SHA. This script runs
# from a systemd timer on the VPS, notices when origin/vps-deploy moves past
# the deployed checkout, and promotes through the guarded preview/apply path.
#
# GitHub runners cannot reach port 22 on this droplet (cloud firewall), which
# is why promotion pulls from here instead of CI pushing in.
#
# Installed by install-auto-update.sh. Safe to run by hand.

set -euo pipefail

APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"
MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
LOCK_FILE="${MOA_AUTO_UPDATE_LOCK_FILE:-/var/lock/chief-moa-auto-update.lock}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "auto-update: another run holds the lock; skipping."
  exit 0
fi

target="$(git -C "$APP_DIR" ls-remote origin refs/heads/vps-deploy | awk '{print $1}')"
if [ -z "$target" ]; then
  echo "auto-update: origin has no vps-deploy ref yet; nothing to do."
  exit 0
fi

current="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ "$target" = "$current" ]; then
  exit 0
fi

echo "auto-update: promoting $current -> $target (origin/vps-deploy)"

# Run the promotion contract from the verified candidate, not from the active
# checkout. The active checkout can be older than a deployment-protocol change;
# invoking its promoter can wedge forever before it reaches the checkout step
# that would install the repair. A detached candidate worktree keeps the active
# tree immutable until the candidate's own guarded updater applies it.
candidate_root="${MOA_AUTO_UPDATE_CANDIDATE_ROOT:-$MOA_ROOT/auto-update-candidates}"
candidate_source="$candidate_root/${target:0:12}/source"
cleanup_candidate() {
  git -C "$APP_DIR" worktree remove --force "$candidate_source" >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT
mkdir -p "$candidate_root/${target:0:12}"
cleanup_candidate
git -C "$APP_DIR" fetch --no-tags origin vps-deploy
fetched_target="$(git -C "$APP_DIR" rev-parse 'origin/vps-deploy^{commit}')"
if [ "$fetched_target" != "$target" ]; then
  echo "auto-update: vps-deploy moved while preparing $target; retrying on the next timer." >&2
  exit 0
fi
git -C "$APP_DIR" worktree add --detach "$candidate_source" "$target" >/dev/null

set +e
APP_DIR="$APP_DIR" MOA_VPS_APP_DIR="$APP_DIR" \
  bash "$candidate_source/scripts/vps/promote-candidate.sh" vps-deploy
status=$?
set -e
if [ "$status" -eq 75 ]; then
  echo "auto-update: promotion safely deferred; the timer will retry."
  exit 0
fi
exit "$status"
