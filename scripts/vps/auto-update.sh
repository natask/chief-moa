#!/usr/bin/env bash
# Pull-based automatic promotion for the VPS gateway.
#
# CI (deploy-vps.yml) verifies every gateway-touching push to master and, on
# success, fast-forwards the `vps-deploy` ref to that SHA. This script runs
# from a systemd timer on the VPS, notices when origin/vps-deploy moves past
# the deployed checkout, and promotes through update.sh — so every automatic
# promotion still passes the backup + restore-check data gate.
#
# GitHub runners cannot reach port 22 on this droplet (cloud firewall), which
# is why promotion pulls from here instead of CI pushing in.
#
# Installed by install-auto-update.sh. Safe to run by hand.

set -euo pipefail

APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"
LOCK_FILE="/var/lock/chief-moa-auto-update.lock"

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
set +e
bash "$APP_DIR/scripts/vps/promote-candidate.sh" vps-deploy
status=$?
set -e
if [ "$status" -eq 75 ]; then
  echo "auto-update: promotion safely deferred; the timer will retry."
  exit 0
fi
exit "$status"
