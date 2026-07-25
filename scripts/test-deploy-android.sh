#!/usr/bin/env bash
# Deterministic contract checks for the repo-level Android deployment wrapper.
# The OTA publisher and ADB are replaced with local fakes; no network, build,
# publication, or device installation occurs.

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
exec /bin/bash "$@"
FAKE_BASH

cat > "$FAKE_BIN/adb" <<'FAKE_ADB'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
  start-server) exit 0 ;;
  devices)
    printf 'List of devices attached\nqa-phone\tdevice\n'
    ;;
  -s)
    if [ "${3:-}" = install ]; then exit "${FAKE_ADB_INSTALL_STATUS:-0}"; fi
    if [ "${3:-}" = shell ]; then
      printf 'versionCode=1\nversionName=0.1.1\n'
      exit 0
    fi
    exit 2
    ;;
  *) exit 2 ;;
esac
FAKE_ADB

cat > "$FAKE_BIN/curl" <<'FAKE_CURL'
#!/bin/bash
exit 1
FAKE_CURL
chmod +x "$FAKE_BIN/bash" "$FAKE_BIN/adb" "$FAKE_BIN/curl"

run_deploy() {
  local case_dir="$1"
  shift
  mkdir -p "$case_dir/state"
  env \
    PATH="$FAKE_BIN:$PATH" \
    MOA_DEPLOY_STATE_DIR="$case_dir/state" \
    MOA_DEPLOY_TARGETS_FILE="$case_dir/targets.json" \
    FAKE_SYNC_TARGET_RECEIPT="$case_dir/sync-target" \
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

case_dir="$TMP_DIR/install-separation"
mkdir -p "$case_dir"
printf '{"production":{"vps_ssh":"qa@canonical.example","public_gateway_url":"https://api.example"}}\n' \
  > "$case_dir/targets.json"
run_deploy "$case_dir" FAKE_ADB_INSTALL_STATUS=1
[ -f "$case_dir/state/android.sha" ]
grep -Fq 'install receipt status=failed' "$case_dir/output"
grep -Fq 'verified publication remains successful' "$case_dir/output"

echo "Android deploy wrapper contract passed (canonical target, override, verification gate, install separation)."
