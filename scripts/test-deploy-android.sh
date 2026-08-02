#!/usr/bin/env bash
# Deterministic contract checks for the repo-level Android deployment wrapper.
# The OTA publisher is replaced with a local fake; no network, build,
# publication, or device installation occurs. A sentinel ADB binary proves the
# publication wrapper never inspects or mutates connected devices.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$FAKE_BIN/bash" <<'FAKE_BASH'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == */android_app/deploy/ota/sync-vps.sh ]]; then
  printf '%s\n' "${MOA_VPS_SSH:-}" > "$FAKE_SYNC_TARGET_RECEIPT"
  exit "${FAKE_SYNC_STATUS:-0}"
fi
if [[ "${1:-}" == */android_app/deploy/ota/build-ota-artifact.sh ]]; then
  printf '%s\n' "${GITHUB_SHA:-missing}" > "$FAKE_BUILD_SHA_RECEIPT"
  exit "${FAKE_BUILD_STATUS:-0}"
fi
exec /bin/bash "$@"
FAKE_BASH

cat > "$FAKE_BIN/ssh" <<'FAKE_SSH'
#!/bin/bash
set -euo pipefail
if [ "${FAKE_STABLE_AUTHORITY_STATUS:-0}" -ne 0 ]; then exit "$FAKE_STABLE_AUTHORITY_STATUS"; fi
printf '%s' "${FAKE_STABLE_SHA:-}"
FAKE_SSH

cat > "$FAKE_BIN/adb" <<'FAKE_ADB'
#!/bin/bash
set -euo pipefail
printf 'called\n' > "$FAKE_ADB_CALL_RECEIPT"
exit 97
FAKE_ADB

cat > "$FAKE_BIN/curl" <<'FAKE_CURL'
#!/bin/bash
exit 1
FAKE_CURL
chmod +x "$FAKE_BIN/bash" "$FAKE_BIN/adb" "$FAKE_BIN/curl" "$FAKE_BIN/ssh"

run_deploy() {
  local case_dir="$1"
  shift
  mkdir -p "$case_dir/state"
  env \
    PATH="$FAKE_BIN:$PATH" \
    MOA_DEPLOY_STATE_DIR="$case_dir/state" \
    MOA_DEPLOY_TARGETS_FILE="$case_dir/targets.json" \
    FAKE_SYNC_TARGET_RECEIPT="$case_dir/sync-target" \
    FAKE_BUILD_SHA_RECEIPT="$case_dir/build-sha" \
    FAKE_ADB_CALL_RECEIPT="$case_dir/adb-called" \
    FAKE_STABLE_SHA="${FAKE_STABLE_SHA-$(git -C "$ROOT_DIR" rev-parse HEAD)}" \
    GATEWAY_URL="http://127.0.0.1:1" \
    "$@" \
    /bin/bash "$ROOT_DIR/scripts/deploy.sh" android >"$case_dir/output" 2>&1
}

case_dir="$TMP_DIR/canonical-target"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
run_deploy "$case_dir"
[ "$(cat "$case_dir/sync-target")" = qa@canonical.example ]
[ -f "$case_dir/state/android.sha" ]
grep -Fq 'publication receipt verified' "$case_dir/output"
grep -Fq 'installation remains Android/user-owned through OTA' "$case_dir/output"
[ "$(cat "$case_dir/build-sha")" = "$(git -C "$ROOT_DIR" rev-parse HEAD)" ]
[ ! -e "$case_dir/adb-called" ]

case_dir="$TMP_DIR/env-override"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
run_deploy "$case_dir" MOA_VPS_SSH=qa@override.example
[ "$(cat "$case_dir/sync-target")" = qa@override.example ]

case_dir="$TMP_DIR/verification-failure"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
if run_deploy "$case_dir" FAKE_SYNC_STATUS=1; then exit 1; fi
[ ! -e "$case_dir/state/android.sha" ]
grep -Fq 'not marking Android deployed' "$case_dir/output"

case_dir="$TMP_DIR/missing-stable-authority"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
if FAKE_STABLE_SHA= run_deploy "$case_dir"; then exit 1; fi
[ ! -e "$case_dir/build-sha" ]
[ ! -e "$case_dir/state/android.sha" ]
grep -Fq 'deployed stable Git authority is missing or invalid' "$case_dir/output"

case_dir="$TMP_DIR/unresolvable-stable-authority"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
if FAKE_STABLE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa run_deploy "$case_dir"; then exit 1; fi
[ ! -e "$case_dir/build-sha" ]
[ ! -e "$case_dir/state/android.sha" ]
grep -Fq 'not uniquely resolvable' "$case_dir/output"

echo "Android deploy wrapper contract passed (lineage authority, immutable full-SHA candidate, canonical target, verification gate, OTA-only publication)."
