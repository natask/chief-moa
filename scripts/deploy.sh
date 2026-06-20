#!/usr/bin/env bash
# One deploy entrypoint for chief-moa. Default target is the gateway: it is the
# only live server, so "whenever you change something it gets deployed" means
# pushing gateway code to the main machine and restarting it.
#
# Drift-aware: it compares local gateway files against the deployed copy and
# only rsyncs + restarts when they differ, so it is a cheap no-op when nothing
# changed. Safe to run on every Stop hook.
#
# Usage:
#   scripts/deploy.sh            # gateway, only if it drifted
#   scripts/deploy.sh gateway    # same
#   scripts/deploy.sh --force    # gateway, deploy even with no detected drift
#   scripts/deploy.sh android    # rebuild + sync the Android OTA artifact
#   scripts/deploy.sh extension  # package the Chrome extension for CWS upload
#   scripts/deploy.sh all        # gateway (if drifted) + android OTA + extension package
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-reclaim@10.147.17.10}"
REMOTE_GW_DIR="${REMOTE_GW_DIR:-/home/reclaim-ethiopia/moa-assistant/software/moa_gateway}"
# Files whose change must reach the running gateway. Cheap to hash, covers the
# server, all lib modules, and the served UI.
log() { printf '[deploy] %s\n' "$*"; }

gateway_drifted() {
  # Authoritative drift check: ask rsync (the same tool sync-when-online uses)
  # what it WOULD transfer, by content checksum (-c), without changing anything
  # (-n). Lines ending in "/" are directories; any real file means drift. If the
  # remote is unreachable, treat as drift so we attempt the deploy and surface it.
  local out
  out="$(rsync -rcn --out-format='%n' \
      "$ROOT_DIR/gateway/server.js" \
      "$ROOT_DIR/gateway/package.json" \
      "$ROOT_DIR/gateway/package-lock.json" \
      "$REMOTE:$REMOTE_GW_DIR/" 2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/lib/"    "$REMOTE:$REMOTE_GW_DIR/lib/"    2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/public/" "$REMOTE:$REMOTE_GW_DIR/public/" 2>/dev/null
  )" || return 0
  printf '%s\n' "$out" | grep -qvE '(^$|/$)'
}

deploy_gateway() {
  local force="${1:-}"
  # Hook-safe: when the main machine is unreachable (offline / ZeroTier down),
  # skip quietly instead of erroring. BatchMode avoids any password hang.
  if ! ssh -o ConnectTimeout=6 -o BatchMode=yes "$REMOTE" true 2>/dev/null; then
    log "gateway: remote $REMOTE unreachable — skipping"
    return 0
  fi
  if [ "$force" != "--force" ] && ! gateway_drifted; then
    log "gateway: in sync, nothing to deploy"
    return 0
  fi
  log "gateway: changes detected -> syncing + restarting"
  bash "$ROOT_DIR/gateway/deploy/main-machine/sync-when-online.sh"
}

deploy_android() {
  log "android: building + syncing OTA artifact"
  ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
    bash "$ROOT_DIR/android_app/deploy/ota/sync-main-machine.sh"
}

deploy_extension() {
  log "extension: packaging Chrome extension for CWS upload"
  (cd "$ROOT_DIR/browser_extension" && npm run package)
}

case "${1:-gateway}" in
  gateway|"")        deploy_gateway ;;
  --force)           deploy_gateway --force ;;
  android)           deploy_android ;;
  extension)         deploy_extension ;;
  all)               deploy_gateway; deploy_android; deploy_extension ;;
  *) echo "usage: deploy.sh [gateway|--force|android|extension|all]" >&2; exit 2 ;;
esac
