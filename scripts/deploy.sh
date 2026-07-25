#!/usr/bin/env bash
# One deploy entrypoint for chief-moa.
#
# Agents should verify, commit, then deploy. The `auto` target is hook-safe: it
# looks only at committed target changes since the last successful target deploy
# and refuses to deploy dirty target files.
#
# Usage:
#   scripts/deploy.sh auto       # deploy committed changed targets
#   scripts/deploy.sh            # gateway, only if it drifted
#   scripts/deploy.sh gateway    # gateway, only if it drifted
#   scripts/deploy.sh --force    # gateway, deploy even with no detected drift
#   scripts/deploy.sh android    # rebuild + sync the Android OTA artifact
#   scripts/deploy.sh extension  # verify + package + poke loaded browser reload
#   scripts/deploy.sh all        # gateway + android OTA + extension deployment
#   scripts/deploy.sh plan FILE  # read-only cross-surface release evidence plan
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The main machine (10.147.17.10) is decommissioned; the production gateway is
# the DigitalOcean droplet behind https://api.agee.app. REMOTE/REMOTE_GW_DIR
# stay overridable for a future push-style target but no longer default to the
# dead host.
REMOTE="${REMOTE:-}"
REMOTE_GW_DIR="${REMOTE_GW_DIR:-}"
GATEWAY_URL="${GATEWAY_URL:-https://api.agee.app}"
DEPLOY_TARGETS_FILE="${MOA_DEPLOY_TARGETS_FILE:-$ROOT_DIR/scripts/deploy-targets.json}"
log() { printf '[deploy] %s\n' "$*"; }
VERSION_STATUS_SCRIPT="$ROOT_DIR/scripts/deploy-version-status.mjs"

production_vps_target() {
  node - "$DEPLOY_TARGETS_FILE" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
let config;
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(1);
}
const target = config?.production?.vps_ssh;
if (typeof target !== "string"
  || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target)) {
  process.exit(1);
}
const host = target.slice(target.indexOf("@") + 1);
if (host.length > 253 || host.includes("..") || host.includes(".-")
  || host.includes("-.") || host.endsWith(".") || host.endsWith("-")) {
  process.exit(1);
}
process.stdout.write(target);
NODE
}

adb_path() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi
  if [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/platform-tools/adb" ]; then
    printf '%s\n' "$ANDROID_HOME/platform-tools/adb"
    return 0
  fi
  if [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
    printf '%s\n' "$HOME/Library/Android/sdk/platform-tools/adb"
    return 0
  fi
  return 1
}

gateway_drifted() {
  # Authoritative drift check: ask rsync (the same tool sync-when-online uses)
  # what it WOULD transfer, by content checksum (-c), without changing anything
  # (-n). Lines ending in "/" are directories; any real file means drift. If the
  # remote is unreachable, treat as drift so we attempt the deploy and surface it.
  local out
  out="$(rsync -rcn --out-format='%n' \
      "$ROOT_DIR/gateway/server.js" \
      "$ROOT_DIR/gateway/agent-launcher-profiles.json" \
      "$ROOT_DIR/gateway/package.json" \
      "$ROOT_DIR/gateway/package-lock.json" \
      "$REMOTE:$REMOTE_GW_DIR/" 2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/lib/"    "$REMOTE:$REMOTE_GW_DIR/lib/"    2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/agent-workflows/" "$REMOTE:$REMOTE_GW_DIR/agent-workflows/" 2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/scripts/" "$REMOTE:$REMOTE_GW_DIR/scripts/" 2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/public/" "$REMOTE:$REMOTE_GW_DIR/public/" 2>/dev/null
    rsync -rcn --out-format='%n' "$ROOT_DIR/gateway/deploy/main-machine/" "$REMOTE:$REMOTE_GW_DIR/deploy/main-machine/" 2>/dev/null
  )" || return 0
  printf '%s\n' "$out" | grep -qvE '(^$|/$)'
}

deploy_gateway() {
  local force="${1:-}"
  if [ -z "$REMOTE" ] || [ -z "$REMOTE_GW_DIR" ]; then
    log "gateway: push target unset; use the CI verified vps-deploy path for VPS promotion"
    return 75
  fi
  # Hook-safe: when the main machine is unreachable (offline / ZeroTier down),
  # return a distinct status without marking the target deployed. BatchMode
  # avoids any password hang.
  if ! ssh -o ConnectTimeout=6 -o BatchMode=yes "$REMOTE" true 2>/dev/null; then
    log "gateway: remote $REMOTE unreachable — skipping"
    return 75
  fi
  if [ "$force" != "--force" ] && ! gateway_drifted; then
    log "gateway: in sync, nothing to deploy"
    return 0
  fi
  log "gateway: changes detected -> syncing + restarting"
  bash "$ROOT_DIR/gateway/deploy/main-machine/sync-when-online.sh"
}

deploy_android() {
  local vps_target="${MOA_VPS_SSH:-}"
  local install_status=0
  if [ -z "$vps_target" ]; then
    if ! vps_target="$(production_vps_target)"; then
      log "android: canonical production VPS target is invalid or unavailable"
      return 1
    fi
    log "android: using tracked canonical production VPS target"
  else
    log "android: using MOA_VPS_SSH production target override"
  fi
  log "android: building + syncing OTA artifact"
  # OTA hosting moved to the VPS gateway (api.agee.app); the main machine is
  # decommissioned. The target is non-secret; SSH still owns authentication.
  if ! MOA_VPS_SSH="$vps_target" \
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
    bash "$ROOT_DIR/android_app/deploy/ota/sync-vps.sh"; then
    log "android: OTA publication or public verification failed; not marking Android deployed"
    return 1
  fi
  log "android: publication receipt verified"
  if direct_install_android; then
    :
  else
    install_status=$?
    if [ "$install_status" -eq 75 ]; then
      log "android: optional install was not attempted; verified publication remains successful"
    else
      log "android: optional install failed; verified publication remains successful"
    fi
  fi
  if curl -fsS "$GATEWAY_URL/health" >/dev/null 2>&1; then
    log "android: gateway health smoke passed at $GATEWAY_URL"
  else
    log "android: gateway health smoke skipped or failed at $GATEWAY_URL"
  fi
}

direct_install_android() {
  local adb
  local apk="$ROOT_DIR/gateway/data/android-ota/moa-assistant.apk"
  local devices
  local serial
  local failures=0

  if [ ! -f "$apk" ]; then
    apk="$ROOT_DIR/android_app/app/build/outputs/apk/debug/app-debug.apk"
  fi
  if [ ! -f "$apk" ]; then
    log "android: install receipt status=not_attempted reason=apk_missing"
    return 75
  fi
  if ! adb="$(adb_path)"; then
    log "android: install receipt status=not_attempted reason=adb_unavailable"
    return 75
  fi

  "$adb" start-server >/dev/null 2>&1 || true
  devices="$("$adb" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  if [ -z "$devices" ]; then
    log "android: install receipt status=not_attempted reason=no_authorized_device"
    return 75
  fi

  local installed=0
  while IFS= read -r serial; do
    [ -z "$serial" ] && continue
    log "android: direct installing $(basename "$apk") to $serial"
    if "$adb" -s "$serial" install -r -d "$apk" >/dev/null; then
      log "android: installed on $serial $(installed_android_version "$adb" "$serial")"
      installed=$((installed + 1))
    else
      log "android: direct install failed on $serial"
      failures=$((failures + 1))
    fi
  done <<EOF
$devices
EOF

  if [ "$failures" -eq 0 ]; then
    log "android: install receipt status=installed devices=$installed"
    return 0
  fi
  log "android: install receipt status=failed installed=$installed failed=$failures"
  return 1
}

installed_android_version() {
  local adb="$1"
  local serial="$2"
  local version
  version="$("$adb" -s "$serial" shell dumpsys package ai.moa.assistant 2>/dev/null | awk '
    /versionCode=/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^versionCode=/) {
          split($i, value, "=")
          version_code = value[2]
        }
      }
    }
    /versionName=/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^versionName=/) {
          split($i, value, "=")
          version_name = value[2]
        }
      }
    }
    END {
      if (version_code || version_name) {
        printf "(versionCode=%s versionName=%s)", version_code, version_name
      }
    }
  ' | tr -d '\r')"
  if [ -n "$version" ]; then
    printf '%s\n' "$version"
  else
    printf '%s\n' "(version unavailable)"
  fi
}

deploy_extension() {
  local state_dir
  state_dir="$(deploy_state_dir 2>/dev/null || true)"
  if [ -n "$state_dir" ] && target_has_committed_changes extension; then
    node "$VERSION_STATUS_SCRIPT" assert-extension-bumped "$state_dir"
  fi
  log "extension: verifying, smoke testing, packaging, and poking loaded browser reload"
  (
    cd "$ROOT_DIR/browser_extension"
    npm run verify
    npm run smoke
    npm run package
    npm run deploy:browser
  )
}

git_head() {
  git -C "$ROOT_DIR" rev-parse --verify HEAD 2>/dev/null
}

deploy_state_dir() {
  if [ -n "${MOA_DEPLOY_STATE_DIR:-}" ]; then
    case "$MOA_DEPLOY_STATE_DIR" in
      /*) printf '%s\n' "$MOA_DEPLOY_STATE_DIR"; return 0 ;;
      *) return 1 ;;
    esac
  fi
  local git_dir
  git_dir="$(git -C "$ROOT_DIR" rev-parse --git-dir 2>/dev/null)" || return 1
  case "$git_dir" in
    /*) printf '%s/chief-moa-deploy\n' "$git_dir" ;;
    *) printf '%s/%s/chief-moa-deploy\n' "$ROOT_DIR" "$git_dir" ;;
  esac
}

target_patterns() {
  case "$1" in
    android)
      printf '%s\n' \
        "android_app/app/" \
        "android_app/build.gradle" \
        "android_app/settings.gradle" \
        "android_app/gradle/" \
        "android_app/gradlew" \
        "android_app/deploy/ota/" \
        "scripts/deploy-targets.json"
      ;;
    extension)
      printf '%s\n' \
        "browser_extension/extension/" \
        "browser_extension/fixtures/" \
        "browser_extension/scripts/" \
        "browser_extension/package.json" \
        "browser_extension/pnpm-lock.yaml"
      ;;
    gateway)
      printf '%s\n' \
        "docker-compose.yml" \
        "gateway/Dockerfile" \
        "gateway/.dockerignore" \
        "gateway/server.js" \
        "gateway/agent-launcher-profiles.json" \
        "gateway/agent-workflows/" \
        "gateway/lib/" \
        "gateway/public/" \
        "gateway/scripts/" \
        "gateway/deploy/main-machine/" \
        "gateway/schema.sql" \
        "gateway/package.json" \
        "gateway/package-lock.json"
      ;;
  esac
}

path_matches_target() {
  local target="$1"
  local path="$2"
  local pattern
  while IFS= read -r pattern; do
    if [[ "$pattern" == */ ]]; then
      [[ "$path" == "$pattern"* ]] && return 0
    else
      [[ "$path" == "$pattern" ]] && return 0
    fi
  done < <(target_patterns "$target")
  return 1
}

target_has_path() {
  local target="$1"
  local path
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    path_matches_target "$target" "$path" && return 0
  done
  return 1
}

changed_paths_since_deploy() {
  local target="$1"
  local head
  local state_dir
  local marker
  local base=""

  head="$(git_head)" || return 1
  state_dir="$(deploy_state_dir)" || return 1
  marker="$state_dir/$target.sha"

  if [ -f "$marker" ]; then
    base="$(tr -d '[:space:]' < "$marker")"
    if ! git -C "$ROOT_DIR" cat-file -e "$base^{commit}" 2>/dev/null; then
      base=""
    fi
  fi

  if [ -z "$base" ]; then
    base="$(git -C "$ROOT_DIR" rev-parse --verify HEAD^ 2>/dev/null || true)"
  fi

  if [ -n "$base" ]; then
    [ "$base" = "$head" ] && return 0
    git -C "$ROOT_DIR" diff --name-only "$base..$head"
  else
    git -C "$ROOT_DIR" ls-files
  fi
}

target_has_committed_changes() {
  local target="$1"
  changed_paths_since_deploy "$target" | target_has_path "$target"
}

target_has_dirty_changes() {
  local target="$1"
  local paths
  paths="$(
    git -C "$ROOT_DIR" diff --name-only
    git -C "$ROOT_DIR" diff --cached --name-only
    git -C "$ROOT_DIR" ls-files --others --exclude-standard
  )"
  printf '%s\n' "$paths" | target_has_path "$target"
}

mark_deployed() {
  local target="$1"
  local head
  local state_dir
  head="$(git_head)" || return 0
  state_dir="$(deploy_state_dir)" || return 0
  mkdir -p "$state_dir"
  printf '%s\n' "$head" > "$state_dir/$target.sha"
  node "$VERSION_STATUS_SCRIPT" mark "$state_dir" "$target" "$head" | while IFS= read -r line; do
    log "$line"
  done
}

deploy_target() {
  node "$VERSION_STATUS_SCRIPT" current "$1" | while IFS= read -r line; do
    log "$line"
  done
  case "$1" in
    gateway) deploy_gateway ;;
    android) deploy_android ;;
    extension) deploy_extension ;;
  esac
}

deploy_auto() {
  local target
  local dirty_targets=""
  local changed_targets=""
  local did_deploy=0

  if ! git_head >/dev/null; then
    log "auto: not in a git worktree with commits; skipping"
    return 0
  fi

  for target in gateway android extension; do
    if target_has_dirty_changes "$target"; then
      dirty_targets="$dirty_targets $target"
    elif target_has_committed_changes "$target"; then
      changed_targets="$changed_targets $target"
    fi
  done

  if [ -n "$dirty_targets" ]; then
    log "auto: uncommitted target changes present:$dirty_targets"
    log "auto: skipping dirty targets; verify and commit before deployment"
  fi

  for target in $changed_targets; do
    if deploy_target "$target"; then
      mark_deployed "$target"
      did_deploy=1
    else
      status=$?
      if [ "$status" -eq 75 ]; then
        log "auto: $target deploy skipped; not marking deployed"
      else
        return "$status"
      fi
    fi
  done

  if [ "$did_deploy" -eq 0 ]; then
    log "auto: no committed target changes to deploy"
  fi
}

case "${1:-gateway}" in
  plan)
    [ -n "${2:-}" ] || { echo "usage: deploy.sh plan <release-evidence.json>" >&2; exit 2; }
    node "$ROOT_DIR/scripts/release/release-evidence.mjs" plan "$2"
    ;;
  auto)              deploy_auto ;;
  gateway|"")        deploy_target gateway; mark_deployed gateway ;;
  --force)           node "$VERSION_STATUS_SCRIPT" current gateway | while IFS= read -r line; do log "$line"; done; deploy_gateway --force; mark_deployed gateway ;;
  android)           deploy_target android; mark_deployed android ;;
  extension)         deploy_target extension; mark_deployed extension ;;
  all)               deploy_target gateway; mark_deployed gateway; deploy_target android; mark_deployed android; deploy_target extension; mark_deployed extension ;;
  *) echo "usage: deploy.sh [plan FILE|auto|gateway|--force|android|extension|all]" >&2; exit 2 ;;
esac
