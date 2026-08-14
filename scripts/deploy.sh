#!/usr/bin/env bash
# One deploy entrypoint for chief-moa.
#
# Agents should verify, commit, then deploy. The `auto` target is hook-safe: it
# looks only at committed target changes since the last successful target deploy
# and refuses to deploy dirty target files.
#
# Usage:
#   scripts/deploy.sh auto       # locally verify/package committed changes
#   scripts/deploy.sh android    # locally verify/package the Android OTA APK
#   scripts/deploy.sh extension  # locally verify/package the extension
#   scripts/deploy.sh gateway    # locally verify/package the gateway source
#   scripts/deploy.sh TARGET --direct-deploy --target chief-moa-production
#                               # explicitly promote the verified target
#   scripts/deploy.sh plan FILE  # read-only cross-surface release evidence plan
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The main machine (10.147.17.10) is decommissioned; the production gateway is
# the DigitalOcean droplet behind https://api.agee.app. REMOTE/REMOTE_GW_DIR
# stay overridable for a future push-style target but no longer default to the
# dead host.
GATEWAY_URL=""
DEPLOY_TARGETS_FILE="$ROOT_DIR/scripts/deploy-targets.json"
log() { printf '[deploy] %s\n' "$*"; }
VERSION_STATUS_SCRIPT="$ROOT_DIR/scripts/deploy-version-status.mjs"
LOCAL_RELEASE_SCRIPT="$ROOT_DIR/scripts/release/local-release.sh"
DIRECT_DEPLOY=false
EXPECTED_TARGET=""

production_target_identity() {
  node - "$DEPLOY_TARGETS_FILE" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const identity = value?.production?.identity;
if (typeof identity !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(identity)) process.exit(1);
process.stdout.write(identity);
NODE
}

require_direct_target() {
  local configured
  [ "$DIRECT_DEPLOY" = true ] || {
    log "remote effects blocked; pass --direct-deploy and the verified --target identity" >&2
    return 1
  }
  configured="$(production_target_identity 2>/dev/null || true)"
  [ -n "$configured" ] || {
    log "production target identity is invalid or unavailable" >&2
    return 1
  }
  [ "$EXPECTED_TARGET" = "$configured" ] || {
    log "target identity mismatch: expected explicit --target $configured" >&2
    return 1
  }
  log "verified direct-deploy target identity: $configured"
}

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

production_public_gateway_url() {
  node - "$DEPLOY_TARGETS_FILE" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))?.production?.public_gateway_url;
if (typeof value !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(value)) process.exit(1);
process.stdout.write(value);
NODE
}

android_release_candidate() {
  local head origin_master stable_reported stable_commit

  head="$(git_head)" || {
    log "android: cannot resolve the candidate HEAD; publication blocked" >&2
    return 1
  }
  if target_has_dirty_changes android; then
    log "android: Android release inputs are not clean; publication blocked" >&2
    return 1
  fi
  origin_master="$(git -C "$ROOT_DIR" rev-parse --verify 'refs/remotes/origin/master^{commit}' 2>/dev/null || true)"
  if [[ ! "$origin_master" =~ ^[0-9a-f]{40}$ ]]; then
    log "android: authoritative origin/master commit is missing or ambiguous; publication blocked" >&2
    return 1
  fi
  if ! git -C "$ROOT_DIR" merge-base --is-ancestor "$origin_master" "$head"; then
    log "android: candidate $head does not contain origin/master $origin_master; publication blocked" >&2
    return 1
  fi

  stable_reported="$(android_stable_git_sha "$1" 2>/dev/null || true)"
  if [ -z "$stable_reported" ] || [[ ! "$stable_reported" =~ ^[0-9A-Fa-f]{7,64}$ ]]; then
    log "android: deployed stable Git authority is missing or invalid; publication blocked" >&2
    return 1
  fi
  stable_commit="$(git -C "$ROOT_DIR" rev-parse --verify "$stable_reported^{commit}" 2>/dev/null || true)"
  if [[ ! "$stable_commit" =~ ^[0-9a-f]{40}$ ]]; then
    log "android: deployed stable Git SHA '$stable_reported' is not uniquely resolvable; publication blocked" >&2
    return 1
  fi
  if ! git -C "$ROOT_DIR" merge-base --is-ancestor "$stable_commit" "$head"; then
    log "android: candidate $head does not contain deployed stable $stable_commit; publication blocked" >&2
    return 1
  fi
  printf '%s\n' "$head"
}

android_stable_git_sha() {
  local vps_target="$1"
  ssh -o ConnectTimeout=8 -o BatchMode=yes "$vps_target" sh -s <<'REMOTE_STABLE_SHA'
set -eu
containers="$(docker ps -q \
  --filter label=com.docker.compose.project=chief-moa \
  --filter label=com.docker.compose.service=gateway \
  --filter label=com.docker.compose.container-number=1)"
set -- $containers
[ "$#" -eq 1 ] || exit 1
docker exec -i "$1" node - /data/android-ota/latest.json <<'NODE'
const fs = require("node:fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).git_sha; } catch { process.exit(1); }
if (typeof value !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(value)) process.exit(1);
process.stdout.write(value);
NODE
REMOTE_STABLE_SHA
}

android_bootstrap_gateway_token() {
  local vps_target="$1"
  if [ -n "${MOA_ANDROID_BUNDLED_GATEWAY_TOKEN:-}" ]; then
    printf '%s' "$MOA_ANDROID_BUNDLED_GATEWAY_TOKEN"
    return 0
  fi
  ssh -o ConnectTimeout=8 -o BatchMode=yes "$vps_target" sh -s <<'REMOTE_ANDROID_BOOTSTRAP_TOKEN'
set -eu
containers="$(docker ps -q \
  --filter label=com.docker.compose.project=chief-moa \
  --filter label=com.docker.compose.service=gateway \
  --filter label=com.docker.compose.container-number=1)"
set -- $containers
[ "$#" -eq 1 ] || exit 1
docker exec -i "$1" sh -c 'test -n "$MOA_GATEWAY_TOKEN" && printf %s "$MOA_GATEWAY_TOKEN"'
REMOTE_ANDROID_BOOTSTRAP_TOKEN
}

deploy_gateway() {
  local vps_target candidate
  require_direct_target || return 1
  vps_target="$(production_vps_target)"
  candidate="$(git_head)" || return 1
  bash "$LOCAL_RELEASE_SCRIPT" gateway
  [ "$(git_head)" = "$candidate" ] \
    || { log "gateway: candidate HEAD moved during local verification" >&2; return 1; }
  log "gateway: promoting exact candidate $candidate through the VPS safety gate"
  bash "$ROOT_DIR/scripts/vps/push.sh" --direct-deploy \
    --target "$EXPECTED_TARGET" --host "$vps_target" --commit "$candidate"
}

deploy_android() {
  local vps_target
  local candidate_head
  local bootstrap_gateway_token
  require_direct_target || return 1
  if ! vps_target="$(production_vps_target)"; then
    log "android: canonical production VPS target is invalid or unavailable"
    return 1
  fi
  if ! GATEWAY_URL="$(production_public_gateway_url)"; then
    log "android: canonical public gateway origin is invalid or unavailable"
    return 1
  fi
  log "android: using verified canonical production VPS target"
  candidate_head="$(android_release_candidate "$vps_target")" || return 1
  log "android: captured release candidate $candidate_head"
  bootstrap_gateway_token="$(android_bootstrap_gateway_token "$vps_target")" || {
    log "android: production gateway bootstrap credential is unavailable; refusing a tokenless stable OTA" >&2
    return 1
  }
  [ -n "$bootstrap_gateway_token" ] || {
    log "android: production gateway bootstrap credential is empty; refusing a tokenless stable OTA" >&2
    return 1
  }
  log "android: running the exact local release gate and building the OTA artifact"
  MOA_ANDROID_BUNDLED_GATEWAY_TOKEN="$bootstrap_gateway_token" \
    bash "$LOCAL_RELEASE_SCRIPT" android
  if [ "$(git_head)" != "$candidate_head" ] || target_has_dirty_changes android; then
    log "android: candidate HEAD or Android input cleanliness changed during build; publication blocked"
    return 1
  fi
  log "android: candidate unchanged; syncing exact OTA artifact"
  # OTA hosting moved to the VPS gateway (api.agee.app); the main machine is
  # decommissioned. The target is non-secret; SSH still owns authentication.
  if ! MOA_VPS_SSH="$vps_target" \
    MOA_VPS_PUBLIC_GATEWAY_URL="$GATEWAY_URL" \
    MOA_OTA_SKIP_BUILD=1 \
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
    bash "$ROOT_DIR/android_app/deploy/ota/sync-vps.sh" \
      --direct-deploy --target "$EXPECTED_TARGET"; then
    log "android: OTA publication or public verification failed; not marking Android deployed"
    return 1
  fi
  log "android: publication receipt verified"
  log "android: publication complete; installation remains Android/user-owned through OTA"
  if curl -fsS "$GATEWAY_URL/health" >/dev/null 2>&1; then
    log "android: gateway health smoke passed at $GATEWAY_URL"
  else
    log "android: gateway health smoke skipped or failed at $GATEWAY_URL"
  fi
}

deploy_extension() {
  local state_dir candidate
  require_direct_target || return 1
  candidate="$(git_head)" || return 1
  bash "$LOCAL_RELEASE_SCRIPT" extension
  [ "$(git_head)" = "$candidate" ] || {
    log "extension: candidate HEAD moved during local verification" >&2
    return 1
  }
  state_dir="$(deploy_state_dir 2>/dev/null || true)"
  if [ -n "$state_dir" ] && target_has_committed_changes extension; then
    node "$VERSION_STATUS_SCRIPT" assert-extension-bumped "$state_dir"
  fi
  log "extension: local release verified; poking loaded browser reload"
  (
    cd "$ROOT_DIR/browser_extension"
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

package_target() {
  node "$VERSION_STATUS_SCRIPT" current "$1" | while IFS= read -r line; do
    log "$line"
  done
  bash "$LOCAL_RELEASE_SCRIPT" "$1"
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
    if [ "$DIRECT_DEPLOY" = true ]; then
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
    elif package_target "$target"; then
      did_deploy=1
    else
      return $?
    fi
  done

  if [ "$did_deploy" -eq 0 ]; then
    log "auto: no committed target changes to deploy"
  fi
}

MODE="${1:-gateway}"
if [ "$#" -gt 0 ]; then shift; fi

if [ "$MODE" = plan ]; then
  [ -n "${1:-}" ] || { echo "usage: deploy.sh plan <release-evidence.json>" >&2; exit 2; }
  node "$ROOT_DIR/scripts/release/release-evidence.mjs" plan "$1"
  exit 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --direct-deploy) DIRECT_DEPLOY=true; shift ;;
    --target)
      [ -n "${2:-}" ] || { echo "--target requires an identity" >&2; exit 2; }
      EXPECTED_TARGET="$2"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  plan)
    exit 0
    ;;
  auto)              deploy_auto ;;
  gateway|android|extension)
    if [ "$DIRECT_DEPLOY" = true ]; then
      deploy_target "$MODE"
      mark_deployed "$MODE"
    else
      package_target "$MODE"
    fi
    ;;
  all)
    for target in gateway android extension; do
      if [ "$DIRECT_DEPLOY" = true ]; then
        deploy_target "$target"
        mark_deployed "$target"
      else
        package_target "$target"
      fi
    done
    ;;
  *) echo "usage: deploy.sh [plan FILE|auto|gateway|android|extension|all] [--direct-deploy --target IDENTITY]" >&2; exit 2 ;;
esac
