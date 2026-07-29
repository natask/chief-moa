#!/usr/bin/env bash
# Deterministic publication-safety smoke for sync-vps.sh. All ssh/rsync effects
# are redirected into temporary local directories; this script never contacts a
# network host or builds an APK.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SYNC_SCRIPT="$ROOT_DIR/android_app/deploy/ota/sync-vps.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/android-ota-vps.yml"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
FAKE_CALL_LOG="$TMP_DIR/calls.log"
mkdir -p "$FAKE_BIN"
: > "$FAKE_CALL_LOG"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$FAKE_BIN/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh\n' >> "$FAKE_CALL_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    *) break ;;
  esac
done
[ $# -ge 4 ] || exit 2
shift # validated fake host
[ "$1" = bash ] && [ "$2" = -s ] && [ "$3" = -- ] || exit 2
shift 3
argument_count="$#"
phase="${2:-}"
if [ "$phase" = finalize ] && [ "${FAKE_SSH_FAIL_FINALIZE:-0}" = 1 ]; then
  exit 255
fi
if [ "$phase" = finalize ] && [ "${FAKE_SSH_SIGNAL_FINALIZE:-0}" = 1 ]; then
  kill -TERM "$PPID"
  exit 143
fi
if [ "$phase" = ack ] && [ "${FAKE_SSH_FAIL_ACK_BEFORE:-0}" = 1 ]; then
  exit 255
fi
if [ "$phase" = verify-public ]; then
  /bin/bash -s -- "$@"
  exit $?
fi
/bin/bash -s -- "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$phase" = finalize ] \
  && [ "${FAKE_SSH_FAIL_AFTER_FINALIZE:-0}" = 1 ]; then
  exit 255
fi
if [ "$status" -eq 0 ] && [ "$phase" = ack ] \
  && [ "${FAKE_SSH_FAIL_ACK:-0}" = 1 ]; then
  exit 255
fi
if [ "$status" -eq 0 ] && [ "$phase" = preflight ] \
  && [ "${FAKE_GATEWAY_ROLLBACK_DURING_PREFLIGHT:-0}" = 1 ]; then
  node - "$1" "$FAKE_CONCURRENT_MARKER" <<'FAKE_CONCURRENT_NODE'
const fs = require("node:fs");
const path = require("node:path");
const [otaDir, marker] = process.argv.slice(2);
const ota = require(path.join(process.env.OTA_MODULE_DIR, "android-ota"));
const before = ota.currentReleaseId(otaDir);
let failure = null;
try { ota.rollbackToPreviousRelease(otaDir); } catch (error) { failure = error; }
if (!failure || failure.code !== ota.STORE_BUSY_ERROR_CODE) process.exit(71);
if (ota.currentReleaseId(otaDir) !== before) process.exit(72);
const owner = fs.readFileSync(path.join(otaDir, ".publish-lock", "owner"), "utf8").trim();
if (!owner.startsWith("publish-")) process.exit(73);
fs.writeFileSync(marker, "gateway rollback blocked\n");
FAKE_CONCURRENT_NODE
fi
exit "$status"
FAKE_SSH

cat > "$FAKE_BIN/rsync" <<'FAKE_RSYNC'
#!/usr/bin/env bash
set -euo pipefail
printf 'rsync\n' >> "$FAKE_CALL_LOG"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -*) shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
while [ $# -gt 0 ]; do args+=("$1"); shift; done
[ "${#args[@]}" -ge 2 ] || exit 2
last=$(( ${#args[@]} - 1 ))
destination="${args[$last]}"
remote_path="${destination#*:}"
[ "$remote_path" != "$destination" ] || exit 2
if [ "${FAKE_RSYNC_FAIL_LEGACY:-0}" = 1 ] && [[ "$remote_path" == */legacy/ ]]; then
  exit 74
fi
mkdir -p -- "$remote_path"
for ((i = 0; i < last; i++)); do
  source="${args[$i]}"
  if [[ "$source" == */ ]]; then
    cp -a "${source}." "$remote_path/"
  else
    cp -a "$source" "$remote_path/"
  fi
done
if [ "${FAKE_RSYNC_CORRUPT:-0}" = 1 ] && [[ "$remote_path" == */release/ ]]; then
  printf 'corrupt' >> "$remote_path/moa-assistant.apk"
fi
FAKE_RSYNC

cat > "$FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
canonical_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
worker_id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf 'docker %s\n' "$*" >> "$FAKE_CALL_LOG"
if [ "${1:-}" = ps ]; then
  [ "${FAKE_DOCKER_MISLABELED_WORKER:-0}" = 1 ] && printf '%s\n' "$worker_id"
  printf '%s\n' "$canonical_id"
  exit 0
fi
if [ "${1:-}" = compose ]; then
  expected=(-p chief-moa -f /opt/chief-moa/app/docker-compose.yml -f /opt/chief-moa/app/docker-compose.vps.yml --env-file /opt/chief-moa/gateway.env ps -q gateway)
  shift
  [ "$#" -eq "${#expected[@]}" ] || exit 81
  for expected_arg in "${expected[@]}"; do
    [ "$1" = "$expected_arg" ] || exit 82
    shift
  done
  case "${FAKE_COMPOSE_GATEWAY_IDS:-one}" in
    one) printf '%s\n' "$canonical_id" ;;
    zero) ;;
    multiple) printf '%s\n%s\n' "$canonical_id" cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc ;;
    invalid) printf '%s\n' not-a-container-id ;;
    *) exit 83 ;;
  esac
  exit 0
fi
if [ "${1:-}" = exec ]; then
  shift
  [ "${1:-}" = -i ] || exit 84
  shift
  printf 'docker-exec-container %s\n' "${1:-}" >> "$FAKE_CALL_LOG"
  [ "${1:-}" = "$canonical_id" ] || exit 85
  [ "${FAKE_PUBLIC_VERIFY_FAIL:-0}" != 1 ] || exit 78
  # Consume the inline Node verifier without running it or exposing a token.
  /bin/cat >/dev/null
  exit 0
fi
exit 86
FAKE_DOCKER

# macOS lacks GNU mv -T. The fake remote needs only its replace-destination
# semantics so the production script can be exercised without weakening it.
cat > "$FAKE_BIN/mv" <<'FAKE_MV'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -Tf ]; then
  shift
  [ "${1:-}" = -- ] && shift
  source="$1"
  destination="$2"
  if [ "${FAKE_MV_FAIL_CURRENT_ALWAYS:-0}" = 1 ] \
    && [[ "$source" == */.current.*.tmp ]]; then
    exit 73
  fi
  if [ "${FAKE_MV_FAIL_CURRENT_ONCE:-0}" = 1 ] \
    && [[ "$source" == */.current.*.tmp ]] \
    && [ ! -e "$FAKE_MV_STATE" ]; then
    : > "$FAKE_MV_STATE"
    exit 73
  fi
  rm -f -- "$destination"
  exec /bin/mv -- "$source" "$destination"
fi
exec /bin/mv "$@"
FAKE_MV

cat > "$FAKE_BIN/sha256sum" <<'FAKE_SHA'
#!/usr/bin/env bash
set -euo pipefail
if command -v /usr/bin/sha256sum >/dev/null 2>&1; then
  exec /usr/bin/sha256sum "$@"
fi
if [ "${1:-}" = -c ]; then
  shift
  exec /usr/bin/shasum -a 256 -c "$@"
fi
exec /usr/bin/shasum -a 256 "$@"
FAKE_SHA

cat > "$FAKE_BIN/sync" <<'FAKE_SYNC'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -f ]; then shift; fi
[ "$#" -le 1 ] || exit 2
exit 0
FAKE_SYNC

# macOS lacks GNU `stat -c`. The production script requires GNU stat on the
# real (Linux) VPS; this shim only lets the local fake-transport tests below
# exercise the same `stat -c %Y` call cross-platform.
cat > "$FAKE_BIN/stat" <<'FAKE_STAT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -c ] && [ "${2:-}" = '%Y' ]; then
  shift 2
  if /usr/bin/stat -f '%m' "$1" >/dev/null 2>&1; then
    exec /usr/bin/stat -f '%m' "$1"
  fi
  exec /usr/bin/stat -c '%Y' "$1"
fi
exec /usr/bin/stat "$@"
FAKE_STAT

chmod +x "$FAKE_BIN/ssh" "$FAKE_BIN/rsync" "$FAKE_BIN/docker" "$FAKE_BIN/mv" "$FAKE_BIN/sha256sum" "$FAKE_BIN/sync" "$FAKE_BIN/stat"

publish_release() {
  local dir="$1"
  local version_code="$2"
  local published_at="$3"
  local marker="$4"
  local app_id="${5:-ai.moa.assistant}"
  OTA_MODULE_DIR="$ROOT_DIR/gateway/lib" \
  OTA_DIR="$dir" \
  OTA_VERSION_CODE="$version_code" \
  OTA_PUBLISHED_AT="$published_at" \
  OTA_MARKER="$marker" \
  OTA_APP_ID="$app_id" \
  node <<'NODE'
const path = require("node:path");
const ota = require(path.join(process.env.OTA_MODULE_DIR, "android-ota"));
ota.publishRelease(process.env.OTA_DIR, {
  apk: Buffer.from(`fake-apk:${process.env.OTA_MARKER}`),
  meta: {
    app_id: process.env.OTA_APP_ID,
    version_code: Number(process.env.OTA_VERSION_CODE),
    version_name: `0.1.${process.env.OTA_VERSION_CODE}`,
    git_sha: `test-${process.env.OTA_VERSION_CODE}`,
    published_at: process.env.OTA_PUBLISHED_AT,
    min_sdk: 26,
  },
});
NODE
}

run_sync_with_host() {
  local local_dir="$1"
  local remote_dir="$2"
  local output="$3"
  local host="$4"
  shift 4
  env \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_CALL_LOG="$FAKE_CALL_LOG" \
    OTA_MODULE_DIR="$ROOT_DIR/gateway/lib" \
    ANDROID_OTA_OUT_DIR="$local_dir" \
    MOA_VPS_OTA_DIR="$remote_dir" \
    MOA_VPS_PUBLIC_GATEWAY_URL="https://api.example.invalid" \
    MOA_OTA_SKIP_BUILD=1 \
    MOA_OTA_SNAPSHOT_RETENTION=5 \
    "$@" \
    bash "$SYNC_SCRIPT" --host "$host" >"$output" 2>&1
}

run_sync() {
  local local_dir="$1"
  local remote_dir="$2"
  local output="$3"
  shift 3
  run_sync_with_host "$local_dir" "$remote_dir" "$output" \
    qa-secret@example.invalid "$@"
}

# Manufacture a `.publish-lock` describing a publish of the release currently
# live in $remote_dir, as if that publish had committed but its own cleanup
# never ran. Used to test lock-reclaim without needing a real interrupted run.
manufacture_abandoned_lock() {
  local remote_dir="$1"
  local operation="$2"
  local release_id apk_sha size meta_sha latest_sha
  release_id="$(readlink "$remote_dir/current")"
  release_id="${release_id#releases/}"
  apk_sha="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
  size="$(wc -c < "$remote_dir/moa-assistant.apk" | tr -d '[:space:]')"
  meta_sha="$("$FAKE_BIN/sha256sum" "$remote_dir/releases/$release_id/release.json" | awk '{print $1}')"
  latest_sha="$("$FAKE_BIN/sha256sum" "$remote_dir/latest.json" | awk '{print $1}')"
  mkdir "$remote_dir/.publish-lock"
  printf '%s\n' "$operation" > "$remote_dir/.publish-lock/owner"
  printf '%s %s %s %s %s %s\n' \
    "$operation" "$release_id" "$apk_sha" "$size" "$meta_sha" "$latest_sha" \
    > "$remote_dir/.publish-lock/published.receipt"
}

assert_no_target_leak() {
  local output="$1"
  local remote_dir="$2"
  if grep -Fq 'qa-secret@example.invalid' "$output"; then return 1; fi
  if grep -Fq "$remote_dir" "$output"; then return 1; fi
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

first_line_number_containing() {
  local content="$1"
  local needle="$2"
  local line
  local line_number=0
  while IFS= read -r line; do
    line_number=$((line_number + 1))
    case "$line" in
      *"$needle"*)
        printf '%s\n' "$line_number"
        return 0
        ;;
    esac
  done <<< "$content"
  return 1
}

contains_literal() {
  local content="$1"
  local needle="$2"
  case "$content" in
    *"$needle"*) return 0 ;;
    *) return 1 ;;
  esac
}

first_snapshot_dir() {
  local snapshots_root="$1"
  local name_pattern="${2:-*}"
  local candidate
  local name
  for candidate in "$snapshots_root"/*; do
    [ -d "$candidate" ] || continue
    name="${candidate##*/}"
    case "$name" in
      $name_pattern)
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  done
  return 1
}

if grep -Eq 'rsync.*--delete' "$SYNC_SCRIPT"; then
  echo "sync-vps.sh must never mirror-delete the remote OTA store" >&2
  exit 1
fi

# The production workflow must publish the exact artifact whose signer and
# digest were already verified. Rebuilding inside sync-vps.sh or checking the
# saved digest only after publication would reopen a TOCTOU gap.
publish_step="$(sed -n \
  '/- name: Publish through the existing VPS sync path/,/- name: Fetch and verify the published OTA/p' \
  "$WORKFLOW")"
checksum_line="$(first_line_number_containing "$publish_step" 'sha256sum --check --status' || true)"
sync_line="$(first_line_number_containing "$publish_step" 'bash android_app/deploy/ota/sync-vps.sh' || true)"
[ -n "$checksum_line" ] && [ -n "$sync_line" ] && [ "$checksum_line" -lt "$sync_line" ] || {
  echo "Android OTA workflow must verify the saved APK digest before VPS sync" >&2
  exit 1
}
contains_literal "$publish_step" 'MOA_OTA_SKIP_BUILD=1' || {
  echo "Android OTA workflow must disable rebuilding after stable-signer verification" >&2
  exit 1
}
grep -Fq "node - \"\$manifest\" \"\$apk\"" "$WORKFLOW" || {
  echo "Android OTA signer verification must run its inline script via node stdin" >&2
  exit 1
}
grep -Fq "node - \"\$ANDROID_OTA_OUT_DIR/latest.json\"" "$WORKFLOW" || {
  echo "Android OTA publication verification must run its inline script via node stdin" >&2
  exit 1
}
if grep -Fq "node \"\$manifest\" \"\$apk\"" "$WORKFLOW" \
  || grep -Fq "node \"\$ANDROID_OTA_OUT_DIR/latest.json\"" "$WORKFLOW"; then
  echo "Android OTA workflow must not execute JSON artifacts as JavaScript" >&2
  exit 1
fi
grep -Fq '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$' "$WORKFLOW" || {
  echo "Android OTA workflow must reject option-like SSH targets" >&2
  exit 1
}
if ! grep -Fq 'ssh_host=' "$WORKFLOW" \
  || ! grep -Fq 'VPS_SSH_TARGET#*@' "$WORKFLOW"; then
  echo "Android OTA workflow must validate normalized SSH host labels" >&2
  exit 1
fi

# An option-like SSH target must fail before build or transport even though it
# otherwise fits the old broad user@host character class.
case_dir="$TMP_DIR/unsafe-host"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 5 '2026-07-01T00:00:00Z' local-5
: > "$FAKE_CALL_LOG"
if run_sync_with_host "$local_dir" "$remote_dir" "$case_dir/output" '-F@host'; then exit 1; fi
[ ! -s "$FAKE_CALL_LOG" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"
if run_sync_with_host "$local_dir" "$remote_dir" "$case_dir/dot-output" 'qa@bad..host'; then exit 1; fi
[ ! -s "$FAKE_CALL_LOG" ]
assert_no_target_leak "$case_dir/dot-output" "$remote_dir"

# Happy path: the live release and its one predecessor survive, anything older
# is pruned, the prior state is snapshotted, and current moves only to the fully
# uploaded release.
#
# Retention changed deliberately: publication used to delete nothing, and the
# production store had grown to 33 releases and 36 snapshots inside the
# gateway's data volume. A release older than the predecessor is a rebuild from
# its tagged commit, not a stored artifact.
case_dir="$TMP_DIR/happy"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir/.publish-snapshots"
publish_release "$remote_dir" 8 '2026-07-01T00:00:00Z' old-8
publish_release "$remote_dir" 9 '2026-07-02T00:00:00Z' old-9
publish_release "$local_dir" 10 '2026-07-03T00:00:00Z' new-10
for n in 1 2 3 4 5; do mkdir -p "$remote_dir/.publish-snapshots/2026010${n}T000000Z-old-$n"; done
run_sync "$local_dir" "$remote_dir" "$case_dir/output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-10 ]
# The live release and exactly one predecessor: the one-step rollback the client
# offers is intact, and the release before it is gone.
[ ! -e "$remote_dir/releases/ai.moa.assistant-8" ]
[ -f "$remote_dir/releases/ai.moa.assistant-9/moa-assistant.apk" ]
[ -f "$remote_dir/releases/ai.moa.assistant-10/moa-assistant.apk" ]
[ "$(find "$remote_dir/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 2 ]
cmp -s "$local_dir/moa-assistant.apk" "$remote_dir/moa-assistant.apk"
[ "$(file_mode "$remote_dir")" = 755 ]
[ "$(file_mode "$remote_dir/releases")" = 755 ]
[ "$(file_mode "$remote_dir/releases/ai.moa.assistant-10")" = 755 ]
[ "$(file_mode "$remote_dir/moa-assistant.apk")" = 644 ]
[ "$(file_mode "$remote_dir/latest.json")" = 644 ]
[ "$(file_mode "$remote_dir/releases/ai.moa.assistant-10/moa-assistant.apk")" = 644 ]
[ "$(file_mode "$remote_dir/releases/ai.moa.assistant-10/release.json")" = 644 ]
[ "$(find "$remote_dir/.publish-snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 6 ]
snapshot="$(first_snapshot_dir "$remote_dir/.publish-snapshots" '*ai.moa.assistant-10*')"
[ -n "$snapshot" ]
[ "$(cat "$snapshot/current.target")" = releases/ai.moa.assistant-9 ]
(cd "$snapshot" && "$FAKE_BIN/sha256sum" -c checksums.sha256 >/dev/null)
assert_no_target_leak "$case_dir/output" "$remote_dir"

# The remote publisher's lock is also the gateway store lock. A gateway
# rollback attempted after preflight must fail busy, leave current untouched,
# and allow the publisher to finish normally.
case_dir="$TMP_DIR/concurrent-gateway"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 70 '2026-07-01T00:00:00Z' old-70
publish_release "$remote_dir" 71 '2026-07-02T00:00:00Z' old-71
publish_release "$local_dir" 72 '2026-07-03T00:00:00Z' new-72
run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_GATEWAY_ROLLBACK_DURING_PREFLIGHT=1 \
  FAKE_CONCURRENT_MARKER="$case_dir/gateway-blocked"
[ "$(cat "$case_dir/gateway-blocked")" = "gateway rollback blocked" ]
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-72 ]
[ ! -e "$remote_dir/releases/ai.moa.assistant-70" ]
[ -f "$remote_dir/releases/ai.moa.assistant-71/moa-assistant.apk" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A failed first publication has no older release to fall back to. Rollback
# must therefore remove the just-installed immutable release as well as current
# and the legacy files, leaving a state that can pass preflight on retry.
case_dir="$TMP_DIR/initial-rollback"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 16 '2026-07-03T00:00:00Z' initial-16
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_MV_FAIL_CURRENT_ONCE=1 FAKE_MV_STATE="$case_dir/mv-failed"; then exit 1; fi
[ ! -e "$remote_dir/current" ] && [ ! -L "$remote_dir/current" ]
[ ! -e "$remote_dir/moa-assistant.apk" ] && [ ! -L "$remote_dir/moa-assistant.apk" ]
[ ! -e "$remote_dir/latest.json" ] && [ ! -L "$remote_dir/latest.json" ]
[ ! -e "$remote_dir/releases/ai.moa.assistant-16" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"
run_sync "$local_dir" "$remote_dir" "$case_dir/retry-output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-16 ]
[ -f "$remote_dir/releases/ai.moa.assistant-16/moa-assistant.apk" ]
assert_no_target_leak "$case_dir/retry-output" "$remote_dir"

# Compose service resolution ignores a worker carrying spoofed broad labels and
# executes the verifier only in the canonical gateway returned by `compose ps`.
case_dir="$TMP_DIR/public-compose-canonical"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 134 '2026-07-03T00:00:00Z' local-134
: > "$FAKE_CALL_LOG"
run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_DOCKER_MISLABELED_WORKER=1
grep -Fq 'docker compose -p chief-moa -f /opt/chief-moa/app/docker-compose.yml -f /opt/chief-moa/app/docker-compose.vps.yml --env-file /opt/chief-moa/gateway.env ps -q gateway' "$FAKE_CALL_LOG"
grep -Fq 'docker-exec-container aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$FAKE_CALL_LOG"
if grep -Fq 'docker ps ' "$FAKE_CALL_LOG"; then exit 1; fi
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Zero, multiple, and malformed Compose gateway results all fail closed after
# commit, retaining the durable publication lock for exact retry.
for compose_result in zero multiple invalid; do
  case_dir="$TMP_DIR/public-compose-$compose_result"
  local_dir="$case_dir/local"
  remote_dir="$case_dir/remote"
  mkdir -p "$local_dir" "$remote_dir"
  publish_release "$local_dir" 135 '2026-07-04T00:00:00Z' "local-135-$compose_result"
  : > "$FAKE_CALL_LOG"
  if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
    FAKE_COMPOSE_GATEWAY_IDS="$compose_result"; then exit 1; fi
  [ -f "$remote_dir/.publish-lock/published.receipt" ]
  grep -Fq 'authenticated public manifest/APK verification failed' "$case_dir/output"
  if grep -Fq 'docker-exec-container ' "$FAKE_CALL_LOG"; then exit 1; fi
  assert_no_target_leak "$case_dir/output" "$remote_dir"
done

# Public verification happens after the atomic commit but before ACK cleanup.
# A failure must prevent success and preserve the durable owner lock so an
# exact retry can reconcile and recheck the served bytes.
case_dir="$TMP_DIR/public-verification"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 132 '2026-07-01T00:00:00Z' remote-132
publish_release "$local_dir" 133 '2026-07-02T00:00:00Z' local-133
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_PUBLIC_VERIFY_FAIL=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-133 ]
[ -f "$remote_dir/.publish-lock/published.receipt" ]
grep -Fq 'authenticated public manifest/APK verification failed' "$case_dir/output"
run_sync "$local_dir" "$remote_dir" "$case_dir/retry-output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-133 ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"
assert_no_target_leak "$case_dir/retry-output" "$remote_dir"

# An immutable release-id collision with different bytes fails closed and
# keeps the prior current, legacy artifacts, and release bytes unchanged.
case_dir="$TMP_DIR/release-collision"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 80 '2026-07-01T00:00:00Z' remote-80
publish_release "$local_dir" 80 '2026-07-01T00:00:00Z' different-local-80
old_digest="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-80 ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')" = "$old_digest" ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/releases/ai.moa.assistant-80/moa-assistant.apk" | awk '{print $1}')" = "$old_digest" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A foreign owner is never removed or bypassed. Preflight stops before upload.
case_dir="$TMP_DIR/foreign-lock"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 90 '2026-07-01T00:00:00Z' remote-90
publish_release "$local_dir" 91 '2026-07-02T00:00:00Z' local-91
mkdir "$remote_dir/.publish-lock"
printf '%s\n' gateway-foreign-owner > "$remote_dir/.publish-lock/owner"
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ "$(cat "$remote_dir/.publish-lock/owner")" = gateway-foreign-owner ]
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-90 ]
[ "$(grep -c '^ssh$' "$FAKE_CALL_LOG")" -eq 1 ]
if grep -q '^rsync$' "$FAKE_CALL_LOG"; then exit 1; fi
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Initial publication is allowed only for a truly empty remote store and leaves
# explicit empty-state rollback evidence.
case_dir="$TMP_DIR/initial"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 15 '2026-07-03T00:00:00Z' initial-15
run_sync "$local_dir" "$remote_dir" "$case_dir/output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-15 ]
[ -f "$remote_dir/releases/ai.moa.assistant-15/moa-assistant.apk" ]
snapshot="$(first_snapshot_dir "$remote_dir/.publish-snapshots")"
[ "$(cat "$snapshot/state")" = empty ]
[ -f "$snapshot/published.release" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A transport failure before the finalizer can report a terminal result leaves
# the publisher-owned lock and staged bytes intact for recovery inspection.
case_dir="$TMP_DIR/finalize-unknown"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 100 '2026-07-01T00:00:00Z' remote-100
publish_release "$local_dir" 101 '2026-07-02T00:00:00Z' local-101
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" FAKE_SSH_FAIL_FINALIZE=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-100 ]
[ -f "$remote_dir/.publish-lock/owner" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A finalizer that commits before SSH reports 255 leaves a durable receipt,
# owner lock, and staging evidence. An exact retry reconciles that receipt,
# preserves every snapshot/release, and completes acknowledgement cleanup.
case_dir="$TMP_DIR/finalize-then-255"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 120 '2026-07-01T00:00:00Z' remote-120
publish_release "$local_dir" 121 '2026-07-02T00:00:00Z' local-121
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_SSH_FAIL_AFTER_FINALIZE=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-121 ]
[ -f "$remote_dir/.publish-lock/published.receipt" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
snapshots_before_retry="$(find "$remote_dir/.publish-snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
assert_no_target_leak "$case_dir/output" "$remote_dir"
run_sync "$local_dir" "$remote_dir" "$case_dir/retry-output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-121 ]
[ -f "$remote_dir/releases/ai.moa.assistant-120/moa-assistant.apk" ]
[ -f "$remote_dir/releases/ai.moa.assistant-121/moa-assistant.apk" ]
[ ! -e "$remote_dir/.publish-lock" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 0 ]
[ "$(find "$remote_dir/.publish-snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -ge "$snapshots_before_retry" ]
assert_no_target_leak "$case_dir/retry-output" "$remote_dir"

# The durable receipt also survives when the separate ACK cannot start. An
# exact retry observes and reconciles the already committed publication.
case_dir="$TMP_DIR/ack-before-255"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 130 '2026-07-01T00:00:00Z' remote-130
publish_release "$local_dir" 131 '2026-07-02T00:00:00Z' local-131
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_SSH_FAIL_ACK_BEFORE=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-131 ]
[ -f "$remote_dir/.publish-lock/published.receipt" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
run_sync "$local_dir" "$remote_dir" "$case_dir/retry-output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-131 ]
[ ! -e "$remote_dir/.publish-lock" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 0 ]
assert_no_target_leak "$case_dir/output" "$remote_dir"
assert_no_target_leak "$case_dir/retry-output" "$remote_dir"

# A termination signal delivered while the finalizer SSH call is in flight has
# the same preserve-for-recovery behavior; no EXIT cleanup may race the host.
case_dir="$TMP_DIR/finalize-signal"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 110 '2026-07-01T00:00:00Z' remote-110
publish_release "$local_dir" 111 '2026-07-02T00:00:00Z' local-111
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_SSH_SIGNAL_FINALIZE=1 2>/dev/null; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-110 ]
[ -f "$remote_dir/.publish-lock/owner" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# If exact rollback restoration itself cannot be completed, the unknown store
# retains its owner lock and staging evidence instead of claiming recovery.
case_dir="$TMP_DIR/restore-unknown"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 140 '2026-07-01T00:00:00Z' remote-140
publish_release "$local_dir" 141 '2026-07-02T00:00:00Z' local-141
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_MV_FAIL_CURRENT_ALWAYS=1; then exit 1; fi
[ -f "$remote_dir/.publish-lock/owner" ]
[ "$(find "$remote_dir/.publish-staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Corrupt upload: staged digest validation fails before any pointer or legacy
# mutation, while the verified rollback snapshot remains.
case_dir="$TMP_DIR/corrupt"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 20 '2026-07-01T00:00:00Z' old-20
publish_release "$local_dir" 21 '2026-07-02T00:00:00Z' new-21
old_digest="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" FAKE_RSYNC_CORRUPT=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-20 ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')" = "$old_digest" ]
[ ! -e "$remote_dir/releases/ai.moa.assistant-21" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A failed legacy upload never advances current even though the immutable
# release upload already completed in private staging.
case_dir="$TMP_DIR/legacy-failure"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 25 '2026-07-01T00:00:00Z' old-25
publish_release "$local_dir" 26 '2026-07-02T00:00:00Z' new-26
old_digest="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" FAKE_RSYNC_FAIL_LEGACY=1; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-25 ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')" = "$old_digest" ]
[ ! -e "$remote_dir/releases/ai.moa.assistant-26" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Final pointer failure: legacy artifacts were already replaced, so the remote
# finalize trap must restore and verify the complete prior state.
case_dir="$TMP_DIR/rollback"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 30 '2026-07-01T00:00:00Z' old-30
publish_release "$local_dir" 31 '2026-07-02T00:00:00Z' new-31
old_digest="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  FAKE_MV_FAIL_CURRENT_ONCE=1 FAKE_MV_STATE="$case_dir/mv-failed"; then exit 1; fi
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-30 ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')" = "$old_digest" ]
[ -f "$remote_dir/releases/ai.moa.assistant-31/moa-assistant.apk" ]
[ ! -e "$remote_dir/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Unsafe local current never reaches either transport.
case_dir="$TMP_DIR/unsafe-local"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 40 '2026-07-01T00:00:00Z' local-40
rm "$local_dir/current"
ln -s ../../outside "$local_dir/current"
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ ! -s "$FAKE_CALL_LOG" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Unsafe remote current fails during preflight before either rsync call.
case_dir="$TMP_DIR/unsafe-remote"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 50 '2026-07-02T00:00:00Z' local-50
publish_release "$remote_dir" 49 '2026-07-01T00:00:00Z' remote-49
rm "$remote_dir/current"
ln -s ../../outside "$remote_dir/current"
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ "$(grep -c '^ssh$' "$FAKE_CALL_LOG")" -eq 1 ]
if grep -q '^rsync$' "$FAKE_CALL_LOG"; then exit 1; fi
[ ! -e "$remote_dir/releases/ai.moa.assistant-50" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A lock whose receipt matches the release that is actually live is
# completed-but-abandoned: only its own cleanup crashed. It must be
# reclaimable even though this new publish is a DIFFERENT release than the
# one the stuck lock describes -- an abandoned lock must not block every
# future publish. The old lock is retained as recovery evidence, not deleted.
case_dir="$TMP_DIR/abandoned-lock-reclaim"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 200 '2026-07-01T00:00:00Z' remote-200
publish_release "$local_dir" 201 '2026-07-02T00:00:00Z' new-201
manufacture_abandoned_lock "$remote_dir" publish-abandoned-op
: > "$FAKE_CALL_LOG"
run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS=0
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-201 ]
[ -f "$remote_dir/releases/ai.moa.assistant-200/moa-assistant.apk" ]
[ ! -e "$remote_dir/.publish-lock" ]
recovered="$(find "$remote_dir/.publish-locks-recovered" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "$recovered" ]
[ "$(cat "$recovered/owner")" = publish-abandoned-op ]
[ -f "$recovered/published.receipt" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# The same abandoned, receipt-matching lock must NOT be reclaimed while it is
# younger than the reclaim age gate -- its owner may still be running its own
# acknowledgement cleanup. The lock stays exactly as it was.
case_dir="$TMP_DIR/abandoned-lock-too-recent"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 210 '2026-07-01T00:00:00Z' remote-210
publish_release "$local_dir" 211 '2026-07-02T00:00:00Z' new-211
manufacture_abandoned_lock "$remote_dir" publish-abandoned-op-2
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ -d "$remote_dir/.publish-lock" ]
[ "$(cat "$remote_dir/.publish-lock/owner")" = publish-abandoned-op-2 ]
[ ! -d "$remote_dir/.publish-locks-recovered" ] \
  || [ -z "$(find "$remote_dir/.publish-locks-recovered" -mindepth 1 -maxdepth 1)" ]
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-210 ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A lock with NO receipt at all means a publish is still running or crashed
# before finishing -- exactly what the lock protects. This must never be
# reclaimed, regardless of how permissive the age gate is set.
case_dir="$TMP_DIR/abandoned-lock-no-receipt"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 220 '2026-07-01T00:00:00Z' remote-220
publish_release "$local_dir" 221 '2026-07-02T00:00:00Z' new-221
mkdir "$remote_dir/.publish-lock"
printf '%s\n' publish-crashed-mid-publish > "$remote_dir/.publish-lock/owner"
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS=0; then exit 1; fi
[ -d "$remote_dir/.publish-lock" ]
[ ! -f "$remote_dir/.publish-lock/published.receipt" ]
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-220 ]
[ "$(grep -c '^ssh$' "$FAKE_CALL_LOG")" -eq 1 ]
if grep -q '^rsync$' "$FAKE_CALL_LOG"; then exit 1; fi
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A lock whose receipt does NOT match the live release (tampered or restored
# out of band) must also never be reclaimed, regardless of the age gate.
case_dir="$TMP_DIR/abandoned-lock-mismatch"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 230 '2026-07-01T00:00:00Z' remote-230
publish_release "$local_dir" 231 '2026-07-02T00:00:00Z' new-231
release_id="$(readlink "$remote_dir/current")"; release_id="${release_id#releases/}"
size="$(wc -c < "$remote_dir/moa-assistant.apk" | tr -d '[:space:]')"
meta_sha="$("$FAKE_BIN/sha256sum" "$remote_dir/releases/$release_id/release.json" | awk '{print $1}')"
latest_sha="$("$FAKE_BIN/sha256sum" "$remote_dir/latest.json" | awk '{print $1}')"
bogus_sha="$(printf '0%.0s' $(seq 1 64))"
mkdir "$remote_dir/.publish-lock"
printf '%s\n' publish-mismatch-op > "$remote_dir/.publish-lock/owner"
printf '%s %s %s %s %s %s\n' \
  publish-mismatch-op "$release_id" "$bogus_sha" "$size" "$meta_sha" "$latest_sha" \
  > "$remote_dir/.publish-lock/published.receipt"
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output" \
  MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS=0; then exit 1; fi
[ -d "$remote_dir/.publish-lock" ]
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-230 ]
[ "$(grep -c '^ssh$' "$FAKE_CALL_LOG")" -eq 1 ]
if grep -q '^rsync$' "$FAKE_CALL_LOG"; then exit 1; fi
assert_no_target_leak "$case_dir/output" "$remote_dir"

# A local build whose application id is not an allowed release target fails
# closed before any network contact -- it must not silently fall back to the
# default (ai.moa.assistant) store or invent a new channel directory from an
# unrecognized string.
case_dir="$TMP_DIR/unknown-app-id"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$local_dir" 300 '2026-07-05T00:00:00Z' unknown-300 com.example.unknown
: > "$FAKE_CALL_LOG"
if run_sync "$local_dir" "$remote_dir" "$case_dir/output"; then exit 1; fi
[ ! -s "$FAKE_CALL_LOG" ]
# The allowlist in the local validation step rejects it before any channel
# routing is reached, so assert that message rather than the routing one. What
# matters is proven above: it fails, and FAKE_CALL_LOG is empty, so nothing
# touched the network with an unrecognised application id.
grep -Fq 'Local OTA store validation returned unsafe release facts.' "$case_dir/output"
assert_no_target_leak "$case_dir/output" "$remote_dir"

# ag.companion (the renamed app's own clean install; see the
# rename-product-to-ag OpenSpec change) publishes into
# "$remote_dir/channels/ag.companion" -- a completely separate release chain,
# lock, and snapshot history from the ai.moa.assistant store living directly
# at "$remote_dir". Publishing the new channel must never move, snapshot, or
# even touch the existing channel's `current` pointer or legacy artifacts.
case_dir="$TMP_DIR/two-channels"
local_dir="$case_dir/local"
remote_dir="$case_dir/remote"
mkdir -p "$local_dir" "$remote_dir"
publish_release "$remote_dir" 400 '2026-07-01T00:00:00Z' legacy-400 ai.moa.assistant
legacy_digest_before="$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')"
legacy_current_before="$(readlink "$remote_dir/current")"
publish_release "$local_dir" 401 '2026-07-06T00:00:00Z' companion-401 ag.companion
run_sync "$local_dir" "$remote_dir" "$case_dir/output"
[ "$(readlink "$remote_dir/current")" = "$legacy_current_before" ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/moa-assistant.apk" | awk '{print $1}')" = "$legacy_digest_before" ]
[ ! -e "$remote_dir/.publish-lock" ]
[ "$(readlink "$remote_dir/channels/ag.companion/current")" = releases/ag.companion-401 ]
[ -f "$remote_dir/channels/ag.companion/releases/ag.companion-401/moa-assistant.apk" ]
[ ! -e "$remote_dir/channels/ag.companion/.publish-lock" ]
assert_no_target_leak "$case_dir/output" "$remote_dir"

# Publishing again to the legacy channel afterward must likewise leave the
# ag.companion channel's `current` untouched -- independence holds in both
# directions, not just on the ag.companion channel's first publish.
companion_current_before="$(readlink "$remote_dir/channels/ag.companion/current")"
companion_digest_before="$("$FAKE_BIN/sha256sum" "$remote_dir/channels/ag.companion/moa-assistant.apk" | awk '{print $1}')"
publish_release "$local_dir" 402 '2026-07-07T00:00:00Z' legacy-402 ai.moa.assistant
run_sync "$local_dir" "$remote_dir" "$case_dir/legacy-output"
[ "$(readlink "$remote_dir/current")" = releases/ai.moa.assistant-402 ]
[ "$(readlink "$remote_dir/channels/ag.companion/current")" = "$companion_current_before" ]
[ "$("$FAKE_BIN/sha256sum" "$remote_dir/channels/ag.companion/moa-assistant.apk" | awk '{print $1}')" = "$companion_digest_before" ]
assert_no_target_leak "$case_dir/legacy-output" "$remote_dir"

grep -Fq "docker exec -i \"\$gateway_container\" node -" "$SYNC_SCRIPT" || {
  echo "Public OTA verification must use the running gateway container token" >&2
  exit 1
}
if ! grep -Fq 'docker compose -p chief-moa' "$SYNC_SCRIPT" \
  || ! grep -Fq 'compose_root=/opt/chief-moa/app' "$SYNC_SCRIPT" \
  || ! grep -Fq 'compose_env=/opt/chief-moa/gateway.env' "$SYNC_SCRIPT" \
  || ! grep -Fq "\"\$compose_root/docker-compose.yml\"" "$SYNC_SCRIPT" \
  || ! grep -Fq "\"\$compose_root/docker-compose.vps.yml\"" "$SYNC_SCRIPT" \
  || ! grep -Fq -- "--env-file \"\$compose_env\" ps -q gateway" "$SYNC_SCRIPT"; then
  echo "Public OTA verification must resolve the canonical gateway through the active Compose model" >&2
  exit 1
fi
if grep -Fq 'docker ps ' "$SYNC_SCRIPT"; then
  echo "Public OTA verification must not select containers through broad labels" >&2
  exit 1
fi
grep -Fq 'process.env.MOA_GATEWAY_TOKEN' "$SYNC_SCRIPT" || {
  echo "Public OTA verification must read auth only inside the gateway container" >&2
  exit 1
}

echo "Android OTA VPS publication safety smoke passed (30 fake transport cases + workflow contract)."
