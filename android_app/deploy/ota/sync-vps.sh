#!/usr/bin/env bash
# Build and safely publish one Android OTA release to the VPS gateway store.
#
# Publication is intentionally two-phase:
#   1. validate the local store, lock/snapshot the remote store, and upload into
#      a private staging directory without deleting any prior release; then
#   2. verify the staged bytes, install the immutable release, refresh legacy
#      artifacts, and atomically move `current` last.
#
#   MOA_VPS_SSH=root@vps android_app/deploy/ota/sync-vps.sh
#   android_app/deploy/ota/sync-vps.sh --host root@vps
#
# This low-level publisher requires --host or MOA_VPS_SSH. The repository
# deployment entrypoint resolves its tracked canonical production target.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_OTA_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
HOST="${MOA_VPS_SSH:-}"
# Host-side path of the gateway container's /data named volume.
REMOTE_OTA_DIR="${MOA_VPS_OTA_DIR:-/var/lib/docker/volumes/chief-moa_moa-gateway-data/_data/android-ota}"
REMOTE_PUBLIC_GATEWAY_URL="${MOA_VPS_PUBLIC_GATEWAY_URL:-}"
SNAPSHOT_RETENTION="${MOA_OTA_SNAPSHOT_RETENTION:-5}"

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
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "No VPS host. Pass --host user@vps or set MOA_VPS_SSH." >&2
  exit 1
fi
if [[ ! "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "The VPS host must be a plain user@host target." >&2
  exit 1
fi
SSH_HOST="${HOST#*@}"
if [ "${#SSH_HOST}" -gt 253 ] \
  || [[ "$SSH_HOST" == *..* ]] \
  || [[ "$SSH_HOST" == *.-* ]] \
  || [[ "$SSH_HOST" == *-.* ]] \
  || [[ "$SSH_HOST" == *. ]] \
  || [[ "$SSH_HOST" == *- ]]; then
  echo "The VPS host must use normalized DNS labels." >&2
  exit 1
fi
if [[ ! "$REMOTE_OTA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || [[ "$REMOTE_OTA_DIR" == *"//"* ]] \
  || [[ "$REMOTE_OTA_DIR" == *"/../"* ]] \
  || [[ "$REMOTE_OTA_DIR" == *"/./"* ]] \
  || [[ "$REMOTE_OTA_DIR" == */.. ]] \
  || [[ "$REMOTE_OTA_DIR" == */. ]]; then
  echo "The remote OTA directory must be a normalized absolute path." >&2
  exit 1
fi
if [[ ! "$REMOTE_PUBLIC_GATEWAY_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "MOA_VPS_PUBLIC_GATEWAY_URL must be an HTTPS origin without a path." >&2
  exit 1
fi
if [[ ! "$SNAPSHOT_RETENTION" =~ ^[0-9]+$ ]] \
  || [ "$SNAPSHOT_RETENTION" -lt 1 ] \
  || [ "$SNAPSHOT_RETENTION" -gt 20 ]; then
  echo "MOA_OTA_SNAPSHOT_RETENTION must be between 1 and 20." >&2
  exit 1
fi

# Callers that already built a stable-signed artifact may opt out of a second
# build. The exact same strict local-store validation below still runs.
case "${MOA_OTA_SKIP_BUILD:-0}" in
  0) "$ROOT_DIR/android_app/deploy/ota/build-ota-artifact.sh" ;;
  1) ;;
  *) echo "MOA_OTA_SKIP_BUILD must be 0 or 1." >&2; exit 1 ;;
esac

# Validate that `current` is a relative, in-store symlink and that its release,
# metadata, and legacy compatibility artifacts are byte-consistent. Emit only
# bounded, non-secret values needed by the remote verifier.
LOCAL_RELEASE_FACTS=""
if ! LOCAL_RELEASE_FACTS="$(node - "$LOCAL_OTA_DIR" 2>/dev/null <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
const releaseIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => process.exit(1);
const regular = (file) => {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
};
const directory = (dir) => {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { fail(); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
};
const parseJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(); }
};

const releases = path.join(root, "releases");
const current = path.join(root, "current");
directory(root);
directory(releases);
let currentStat;
try { currentStat = fs.lstatSync(current); } catch { fail(); }
if (!currentStat.isSymbolicLink()) fail();

let target;
try { target = fs.readlinkSync(current); } catch { fail(); }
const match = /^releases\/([a-z0-9][a-z0-9._-]{0,127})$/.exec(target);
if (!match || path.posix.normalize(target) !== target) fail();
const releaseId = match[1];
if (!releaseIdPattern.test(releaseId)) fail();

const releaseDir = path.join(releases, releaseId);
const releaseApkPath = path.join(releaseDir, "moa-assistant.apk");
const releaseMetaPath = path.join(releaseDir, "release.json");
const legacyApkPath = path.join(root, "moa-assistant.apk");
const latestPath = path.join(root, "latest.json");
directory(releaseDir);
for (const file of [releaseApkPath, releaseMetaPath, legacyApkPath, latestPath]) regular(file);

const releaseApk = fs.readFileSync(releaseApkPath);
const legacyApk = fs.readFileSync(legacyApkPath);
if (!releaseApk.equals(legacyApk)) fail();
const digest = sha256(releaseApk);
const releaseMetaBytes = fs.readFileSync(releaseMetaPath);
const latestBytes = fs.readFileSync(latestPath);
const releaseMeta = parseJson(releaseMetaPath);
const latest = parseJson(latestPath);
if (releaseMeta.apk !== "moa-assistant.apk" || latest.apk !== "moa-assistant.apk") fail();
if (latest.release_id !== releaseId) fail();
if (releaseMeta.sha256 !== digest || latest.sha256 !== digest) fail();
if (releaseMeta.size_bytes !== releaseApk.length || latest.size_bytes !== releaseApk.length) fail();
for (const key of ["app_id", "version_code", "version_name", "git_sha", "min_sdk"]) {
  if (releaseMeta[key] !== latest[key]) fail();
}
if (!Number.isSafeInteger(latest.version_code) || latest.version_code <= 0) fail();
if (typeof latest.version_name !== "string" || !latest.version_name) fail();

process.stdout.write([
  releaseId,
  digest,
  String(releaseApk.length),
  sha256(releaseMetaBytes),
  sha256(latestBytes),
  latest.app_id,
  String(latest.version_code),
  latest.version_name,
  latest.git_sha,
].join(" "));
NODE
)"; then
  echo "Local OTA store validation failed; publication was not attempted." >&2
  exit 1
fi

read -r RELEASE_ID APK_SHA256 APK_SIZE RELEASE_META_SHA256 LATEST_SHA256 \
  APP_ID VERSION_CODE VERSION_NAME GIT_SHA <<<"$LOCAL_RELEASE_FACTS"
if [[ ! "$RELEASE_ID" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] \
  || [[ ! "$APK_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || [[ ! "$APK_SIZE" =~ ^[0-9]+$ ]] \
  || [[ ! "$RELEASE_META_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || [[ ! "$LATEST_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || [[ "$APP_ID" != "ai.moa.assistant" ]] \
  || [[ ! "$VERSION_CODE" =~ ^[0-9]+$ ]] \
  || [[ ! "$VERSION_NAME" =~ ^[A-Za-z0-9._+-]+$ ]] \
  || [[ ! "$GIT_SHA" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Local OTA store validation returned unsafe release facts." >&2
  exit 1
fi

SNAPSHOT_ID="$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_ID}-$$-${RANDOM:-0}"
OPERATION_ID="publish-${SNAPSHOT_ID}"
REMOTE_PREPARED=0

cleanup_remote() {
  [ "$REMOTE_PREPARED" -eq 1 ] || return 0
  if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
    "$REMOTE_OTA_DIR" "$OPERATION_ID" >/dev/null 2>&1 <<'REMOTE_CLEANUP'
set -euo pipefail
root="$1"
operation="$2"
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
[[ "$root" != *"//"* && "$root" != *"/../"* && "$root" != *"/./"* \
  && "$root" != */.. && "$root" != */. ]] || exit 1
[[ "$operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || exit 1
lock="$root/.publish-lock"
stage="$root/.publish-staging/$operation"
[ -d "$lock" ] && [ ! -L "$lock" ] || exit 1
[ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || exit 1
[ "$(cat "$lock/owner")" = "$operation" ] || exit 1
[ ! -e "$lock/published.receipt" ] && [ ! -L "$lock/published.receipt" ] || exit 1
rm -rf -- "$stage"
rm -rf -- "$lock"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || exit 1
[ ! -e "$lock" ] && [ ! -L "$lock" ] || exit 1
REMOTE_CLEANUP
  then
    return 1
  fi
  REMOTE_PREPARED=0
  return 0
}

cleanup_remote_best_effort() {
  cleanup_remote || true
}
trap cleanup_remote_best_effort EXIT

# Acquire a remote publication lock, validate the prior current pointer, and
# create a verified, bounded snapshot before any upload or mutable update.
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_OTA_DIR" preflight "$SNAPSHOT_ID" "$OPERATION_ID" "$SNAPSHOT_RETENTION" \
  "$RELEASE_ID" "$APK_SHA256" "$APK_SIZE" "$RELEASE_META_SHA256" "$LATEST_SHA256" \
  >/dev/null 2>&1 <<'REMOTE_PREFLIGHT'
set -euo pipefail
umask 077
root="$1"
phase="$2"
snapshot_id="$3"
operation="$4"
retention="$5"
release_id="$6"
apk_sha="$7"
apk_size="$8"
release_meta_sha="$9"
latest_sha="${10}"
 [ "$phase" = preflight ] || exit 1
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
[[ "$root" != *"//"* && "$root" != *"/../"* && "$root" != *"/./"* \
  && "$root" != */.. && "$root" != */. ]] || exit 1
[[ "$snapshot_id" =~ ^[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$retention" =~ ^[0-9]+$ ]] && [ "$retention" -ge 1 ] && [ "$retention" -le 20 ] || exit 1
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 1
[[ "$apk_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$apk_size" =~ ^[0-9]+$ ]] || exit 1
[[ "$release_meta_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$latest_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
command -v sha256sum >/dev/null 2>&1 || exit 1
command -v cmp >/dev/null 2>&1 || exit 1
command -v readlink >/dev/null 2>&1 || exit 1
command -v sync >/dev/null 2>&1 || exit 1
hash_file() { sha256sum "$1" | awk '{print $1}'; }
size_file() { wc -c < "$1" | tr -d '[:space:]'; }
json_string() {
  local key="$1" file="$2" value
  value="$(sed -nE 's/^[[:space:]]*"'"$key"'"[[:space:]]*:[[:space:]]*"([^"]*)"[[:space:]]*,?[[:space:]]*$/\1/p' "$file")" || return 1
  [ -n "$value" ] && [[ "$value" != *$'\n'* ]] || return 1
  printf '%s\n' "$value"
}
json_number() {
  local key="$1" file="$2" value
  value="$(sed -nE 's/^[[:space:]]*"'"$key"'"[[:space:]]*:[[:space:]]*([0-9]+)[[:space:]]*,?[[:space:]]*$/\1/p' "$file")" || return 1
  [ -n "$value" ] && [[ "$value" != *$'\n'* ]] || return 1
  printf '%s\n' "$value"
}

if [ -L "$root" ] || { [ -e "$root" ] && [ ! -d "$root" ]; }; then exit 1; fi
mkdir -p -- "$root"
for name in releases .publish-staging .publish-snapshots; do
  item="$root/$name"
  if [ -e "$item" ] || [ -L "$item" ]; then
    [ -d "$item" ] && [ ! -L "$item" ] || exit 1
  else
    mkdir -- "$item"
  fi
done

lock="$root/.publish-lock"
stage="$root/.publish-staging/$operation"
snapshot="$root/.publish-snapshots/$snapshot_id"
ready=0
lock_owned=0
preflight_cleanup() {
  status=$?
  trap - EXIT
  if [ "$ready" -ne 1 ]; then
    rm -rf -- "$stage" "$snapshot"
    if [ "$lock_owned" -eq 1 ]; then
      rm -rf -- "$lock"
    fi
  fi
  exit "$status"
}
trap preflight_cleanup EXIT

# A prior client may have lost its SSH result after the host committed. Only an
# exact durable receipt plus exact canonical bytes can reconcile that unknown
# operation. Anything else remains locked for operator inspection.
if [ -e "$lock" ] || [ -L "$lock" ]; then
  [ -d "$lock" ] && [ ! -L "$lock" ] || exit 1
  [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || exit 1
  [ -f "$lock/published.receipt" ] && [ ! -L "$lock/published.receipt" ] || exit 1
  read -r receipt_operation receipt_release receipt_apk receipt_size receipt_meta receipt_latest \
    < "$lock/published.receipt" || exit 1
  [ "$(cat "$lock/owner")" = "$receipt_operation" ] || exit 1
  [ "$receipt_release" = "$release_id" ] \
    && [ "$receipt_apk" = "$apk_sha" ] \
    && [ "$receipt_size" = "$apk_size" ] \
    && [ "$receipt_meta" = "$release_meta_sha" ] \
    && [ "$receipt_latest" = "$latest_sha" ] || exit 1
  [[ "$receipt_operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || exit 1
  prior_stage="$root/.publish-staging/$receipt_operation"
  [ -d "$prior_stage" ] && [ ! -L "$prior_stage" ] || exit 1
  [ -L "$root/current" ] \
    && [ "$(readlink "$root/current")" = "releases/$release_id" ] || exit 1
  [ "$(hash_file "$root/releases/$release_id/moa-assistant.apk")" = "$apk_sha" ] || exit 1
  [ "$(size_file "$root/releases/$release_id/moa-assistant.apk")" = "$apk_size" ] || exit 1
  [ "$(hash_file "$root/releases/$release_id/release.json")" = "$release_meta_sha" ] || exit 1
  [ "$(hash_file "$root/moa-assistant.apk")" = "$apk_sha" ] || exit 1
  [ "$(hash_file "$root/latest.json")" = "$latest_sha" ] || exit 1
  rm -rf -- "$prior_stage" "$lock"
  [ ! -e "$prior_stage" ] && [ ! -L "$prior_stage" ] || exit 1
  [ ! -e "$lock" ] && [ ! -L "$lock" ] || exit 1
fi

mkdir -- "$lock" || exit 1
lock_owned=1
printf '%s\n' "$operation" > "$lock/owner"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || exit 1
[ ! -e "$snapshot" ] && [ ! -L "$snapshot" ] || exit 1
mkdir -p -- "$stage/release" "$stage/legacy" "$snapshot"
printf '%s\n' "$operation" > "$snapshot/operation"

if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  [ -L "$root/current" ] || exit 1
  current_target="$(readlink "$root/current")"
  [[ "$current_target" =~ ^releases/([a-z0-9][a-z0-9._-]{0,127})$ ]] || exit 1
  current_release="${BASH_REMATCH[1]}"
  current_dir="$root/releases/$current_release"
  [ -d "$current_dir" ] && [ ! -L "$current_dir" ] || exit 1
  for file in "$current_dir/moa-assistant.apk" "$current_dir/release.json" \
    "$root/moa-assistant.apk" "$root/latest.json"; do
    [ -f "$file" ] && [ ! -L "$file" ] || exit 1
  done
  cmp -s "$current_dir/moa-assistant.apk" "$root/moa-assistant.apk" || exit 1
  prior_sha="$(hash_file "$current_dir/moa-assistant.apk")"
  prior_size="$(size_file "$current_dir/moa-assistant.apk")"
  [ "$(json_string sha256 "$current_dir/release.json")" = "$prior_sha" ] || exit 1
  [ "$(json_string sha256 "$root/latest.json")" = "$prior_sha" ] || exit 1
  [ "$(json_number size_bytes "$current_dir/release.json")" = "$prior_size" ] || exit 1
  [ "$(json_number size_bytes "$root/latest.json")" = "$prior_size" ] || exit 1
  [ "$(json_string apk "$current_dir/release.json")" = moa-assistant.apk ] || exit 1
  [ "$(json_string apk "$root/latest.json")" = moa-assistant.apk ] || exit 1
  [ "$(json_string release_id "$root/latest.json")" = "$current_release" ] || exit 1
  for key in app_id version_name git_sha published_at; do
    [ "$(json_string "$key" "$current_dir/release.json")" = \
      "$(json_string "$key" "$root/latest.json")" ] || exit 1
  done
  for key in version_code min_sdk; do
    [ "$(json_number "$key" "$current_dir/release.json")" = \
      "$(json_number "$key" "$root/latest.json")" ] || exit 1
  done
  printf 'existing\n' > "$snapshot/state"
  printf '%s\n' "$current_target" > "$snapshot/current.target"
  ln -s "$current_target" "$snapshot/current"
  cp -p -- "$current_dir/release.json" "$snapshot/current.release.json"
  cp -p -- "$root/latest.json" "$snapshot/latest.json"
  cp -p -- "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk"
  cmp -s "$root/latest.json" "$snapshot/latest.json" || exit 1
  cmp -s "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk" || exit 1
  (
    cd "$snapshot"
    sha256sum current.release.json latest.json moa-assistant.apk > checksums.sha256
    sha256sum -c checksums.sha256 >/dev/null
  )
else
  [ ! -e "$root/moa-assistant.apk" ] && [ ! -L "$root/moa-assistant.apk" ] || exit 1
  [ ! -e "$root/latest.json" ] && [ ! -L "$root/latest.json" ] || exit 1
  shopt -s nullglob
  release_entries=("$root/releases"/*)
  [ "${#release_entries[@]}" -eq 0 ] || exit 1
  printf 'empty\n' > "$snapshot/state"
  : > "$snapshot/checksums.sha256"
fi

# Publication never destroys prior rollback evidence. Snapshot lifecycle is a
# separate, explicitly audited maintenance operation.
shopt -s nullglob
snapshots=("$root/.publish-snapshots"/*)
for candidate in "${snapshots[@]}"; do
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || exit 1
done

[ "$(cat "$snapshot/operation")" = "$operation" ] || exit 1
[ -f "$snapshot/state" ] && [ -f "$snapshot/checksums.sha256" ] || exit 1
ready=1
REMOTE_PREFLIGHT
then
  echo "Remote OTA backup/preflight failed; no release was published." >&2
  exit 1
fi
REMOTE_PREPARED=1

# Upload only the new release and legacy compatibility artifacts to the private
# operation directory. No command mirrors or deletes the remote releases tree.
if ! rsync -az -- "$LOCAL_OTA_DIR/releases/$RELEASE_ID/" \
  "$HOST:$REMOTE_OTA_DIR/.publish-staging/$OPERATION_ID/release/" \
  >/dev/null 2>&1; then
  echo "OTA release upload failed; the remote current release is unchanged." >&2
  exit 1
fi
if ! rsync -az -- "$LOCAL_OTA_DIR/moa-assistant.apk" "$LOCAL_OTA_DIR/latest.json" \
  "$HOST:$REMOTE_OTA_DIR/.publish-staging/$OPERATION_ID/legacy/" \
  >/dev/null 2>&1; then
  echo "OTA legacy-artifact upload failed; the remote current release is unchanged." >&2
  exit 1
fi

# Verify staged bytes, preserve any existing immutable release, refresh legacy
# files, and atomically replace `current` only after all uploads are complete.
# Once finalization starts, a signal, job cancellation, or transport failure can
# leave remote state unknown. Disable the pre-finalization cleanup trap first so
# it can never remove the evidence/lock needed to recover that unknown state.
trap - EXIT
set +e
ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_OTA_DIR" finalize "$RELEASE_ID" "$SNAPSHOT_ID" "$OPERATION_ID" \
  "$APK_SHA256" "$APK_SIZE" "$RELEASE_META_SHA256" "$LATEST_SHA256" \
  >/dev/null 2>&1 <<'REMOTE_FINALIZE'
set -euo pipefail
umask 077
root="$1"
phase="$2"
release_id="$3"
snapshot_id="$4"
operation="$5"
apk_sha="$6"
apk_size="$7"
release_meta_sha="$8"
latest_sha="$9"
[ "$phase" = finalize ] || exit 1
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
[[ "$root" != *"//"* && "$root" != *"/../"* && "$root" != *"/./"* \
  && "$root" != */.. && "$root" != */. ]] || exit 1
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 1
[[ "$snapshot_id" =~ ^[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$apk_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$apk_size" =~ ^[0-9]+$ ]] || exit 1
[[ "$release_meta_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$latest_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1

lock="$root/.publish-lock"
stage="$root/.publish-staging/$operation"
snapshot="$root/.publish-snapshots/$snapshot_id"
target="$root/releases/$release_id"
legacy_apk_tmp="$root/.moa-assistant.apk.$operation.tmp"
legacy_json_tmp="$root/.latest.json.$operation.tmp"
current_tmp="$root/.current.$operation.tmp"
receipt_tmp="$lock/.published.receipt.$operation.tmp"
mutated=0
committed=0
target_created=0

hash_file() { sha256sum "$1" | awk '{print $1}'; }
size_file() { wc -c < "$1" | tr -d '[:space:]'; }
regular_file() { [ -f "$1" ] && [ ! -L "$1" ]; }

restore_snapshot() {
  set +e
  state="$(cat "$snapshot/state" 2>/dev/null)" || return 1
  if [ "$state" = existing ]; then
    old_target="$(cat "$snapshot/current.target" 2>/dev/null)" || return 1
    [[ "$old_target" =~ ^releases/[a-z0-9][a-z0-9._-]{0,127}$ ]] || return 1
    (
      cd "$snapshot" && sha256sum -c checksums.sha256 >/dev/null 2>&1
    ) || return 1
    cp -p -- "$snapshot/moa-assistant.apk" "$legacy_apk_tmp" || return 1
    cp -p -- "$snapshot/latest.json" "$legacy_json_tmp" || return 1
    mv -f -- "$legacy_apk_tmp" "$root/moa-assistant.apk" || return 1
    mv -f -- "$legacy_json_tmp" "$root/latest.json" || return 1
    rm -f -- "$current_tmp"
    ln -s "$old_target" "$current_tmp" || return 1
    mv -Tf -- "$current_tmp" "$root/current" || return 1
    [ "$(readlink "$root/current" 2>/dev/null)" = "$old_target" ] || return 1
    cmp -s "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk" || return 1
    cmp -s "$root/latest.json" "$snapshot/latest.json" || return 1
  elif [ "$state" = empty ]; then
    rm -f -- "$root/current" "$root/moa-assistant.apk" "$root/latest.json" \
      "$current_tmp" "$legacy_apk_tmp" "$legacy_json_tmp" || return 1
    if [ "$target_created" -eq 1 ]; then
      [ -d "$target" ] && [ ! -L "$target" ] || return 1
      rm -rf -- "$target" || return 1
      [ ! -e "$target" ] && [ ! -L "$target" ] || return 1
    fi
    shopt -s nullglob dotglob
    empty_release_entries=("$root/releases"/*)
    [ "${#empty_release_entries[@]}" -eq 0 ] || return 1
  else
    return 1
  fi
  return 0
}

finalize_exit() {
  status=$?
  rollback_status=0
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$mutated" -eq 1 ] && [ "$committed" -eq 0 ]; then
    restore_snapshot || rollback_status=1
  fi
  rm -f -- "$legacy_apk_tmp" "$legacy_json_tmp" "$current_tmp" "$receipt_tmp"
  if [ "$rollback_status" -ne 0 ]; then exit 90; fi
  exit "$status"
}
trap finalize_exit EXIT

[ -f "$lock/owner" ] && [ "$(cat "$lock/owner")" = "$operation" ] || exit 1
[ -d "$root" ] && [ ! -L "$root" ] || exit 1
[ -d "$root/releases" ] && [ ! -L "$root/releases" ] || exit 1
[ -d "$root/.publish-staging" ] && [ ! -L "$root/.publish-staging" ] || exit 1
[ -d "$root/.publish-snapshots" ] && [ ! -L "$root/.publish-snapshots" ] || exit 1
[ -d "$lock" ] && [ ! -L "$lock" ] || exit 1
[ -d "$stage" ] && [ ! -L "$stage" ] || exit 1
[ -d "$snapshot" ] && [ ! -L "$snapshot" ] || exit 1
[ -d "$stage/release" ] && [ ! -L "$stage/release" ] || exit 1
[ -d "$stage/legacy" ] && [ ! -L "$stage/legacy" ] || exit 1
[ -f "$snapshot/state" ] && [ ! -L "$snapshot/state" ] || exit 1
[ -f "$snapshot/operation" ] && [ ! -L "$snapshot/operation" ] || exit 1
[ -f "$snapshot/checksums.sha256" ] && [ ! -L "$snapshot/checksums.sha256" ] || exit 1
[ "$(cat "$snapshot/operation")" = "$operation" ] || exit 1

# Revalidate the exact pre-publish state to detect an out-of-band publisher.
state="$(cat "$snapshot/state")"
if [ "$state" = existing ]; then
  for file in "$snapshot/current.target" "$snapshot/current.release.json" \
    "$snapshot/latest.json" "$snapshot/moa-assistant.apk"; do
    regular_file "$file" || exit 1
  done
  old_target="$(cat "$snapshot/current.target")"
  [[ "$old_target" =~ ^releases/[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 1
  [ -L "$root/current" ] && [ "$(readlink "$root/current")" = "$old_target" ] || exit 1
  (
    cd "$snapshot" && sha256sum -c checksums.sha256 >/dev/null
  )
  cmp -s "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk" || exit 1
  cmp -s "$root/latest.json" "$snapshot/latest.json" || exit 1
  cmp -s "$root/$old_target/moa-assistant.apk" "$snapshot/moa-assistant.apk" || exit 1
  cmp -s "$root/$old_target/release.json" "$snapshot/current.release.json" || exit 1
elif [ "$state" = empty ]; then
  [ ! -e "$root/current" ] && [ ! -L "$root/current" ] || exit 1
  [ ! -e "$root/moa-assistant.apk" ] && [ ! -L "$root/moa-assistant.apk" ] || exit 1
  [ ! -e "$root/latest.json" ] && [ ! -L "$root/latest.json" ] || exit 1
else
  exit 1
fi

for file in "$stage/release/moa-assistant.apk" "$stage/release/release.json" \
  "$stage/legacy/moa-assistant.apk" "$stage/legacy/latest.json"; do
  regular_file "$file" || exit 1
done
[ "$(hash_file "$stage/release/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(hash_file "$stage/legacy/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(size_file "$stage/release/moa-assistant.apk")" = "$apk_size" ] || exit 1
[ "$(size_file "$stage/legacy/moa-assistant.apk")" = "$apk_size" ] || exit 1
[ "$(hash_file "$stage/release/release.json")" = "$release_meta_sha" ] || exit 1
[ "$(hash_file "$stage/legacy/latest.json")" = "$latest_sha" ] || exit 1
cmp -s "$stage/release/moa-assistant.apk" "$stage/legacy/moa-assistant.apk" || exit 1

# Release directories are immutable. An idempotent retry may reuse identical
# bytes; a colliding release id with different bytes fails closed.
if [ -e "$target" ] || [ -L "$target" ]; then
  [ -d "$target" ] && [ ! -L "$target" ] || exit 1
  regular_file "$target/moa-assistant.apk" || exit 1
  regular_file "$target/release.json" || exit 1
  [ "$(hash_file "$target/moa-assistant.apk")" = "$apk_sha" ] || exit 1
  [ "$(size_file "$target/moa-assistant.apk")" = "$apk_size" ] || exit 1
  [ "$(hash_file "$target/release.json")" = "$release_meta_sha" ] || exit 1
  rm -rf -- "$stage/release"
else
  mv -- "$stage/release" "$target"
  target_created=1
  # An empty-store rollback must remove this release as well as the legacy
  # files and pointer, even if a later temporary-file operation fails.
  mutated=1
fi

cp -p -- "$stage/legacy/moa-assistant.apk" "$legacy_apk_tmp"
cp -p -- "$stage/legacy/latest.json" "$legacy_json_tmp"
[ "$(hash_file "$legacy_apk_tmp")" = "$apk_sha" ] || exit 1
[ "$(hash_file "$legacy_json_tmp")" = "$latest_sha" ] || exit 1
rm -f -- "$current_tmp"
ln -s "releases/$release_id" "$current_tmp"

mutated=1
mv -f -- "$legacy_apk_tmp" "$root/moa-assistant.apk"
mv -f -- "$legacy_json_tmp" "$root/latest.json"
# GNU mv -T maps to one rename(2) replacement instead of following the old
# current symlink as a directory. The VPS host must support this primitive.
mv -Tf -- "$current_tmp" "$root/current"

[ -L "$root/current" ] && [ "$(readlink "$root/current")" = "releases/$release_id" ] || exit 1
[ "$(hash_file "$root/releases/$release_id/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(hash_file "$root/releases/$release_id/release.json")" = "$release_meta_sha" ] || exit 1
[ "$(hash_file "$root/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(hash_file "$root/latest.json")" = "$latest_sha" ] || exit 1
if [ "$state" = existing ]; then
  (cd "$snapshot" && sha256sum -c checksums.sha256 >/dev/null)
fi

# rsync preserves the local builder's private 0600 mode and numeric owner.
# OTA bytes are authenticated downloads, not credentials; make only the
# canonical artifacts and immutable release readable by the unprivileged
# gateway container. Private staging, snapshots, and publisher locks stay 0700.
chmod 755 "$root" "$root/releases" "$target"
chmod 644 "$target/moa-assistant.apk" "$target/release.json" \
  "$root/moa-assistant.apk" "$root/latest.json"

printf '%s %s %s %s %s %s\n' \
  "$operation" "$release_id" "$apk_sha" "$apk_size" "$release_meta_sha" "$latest_sha" \
  > "$receipt_tmp"
sync -f "$receipt_tmp"
cp -p -- "$receipt_tmp" "$snapshot/published.release"
regular_file "$snapshot/published.release" || exit 1
# From this point forward the canonical publication stays committed even if
# receipt installation or the SSH response becomes unknown. The owner lock and
# staging directory remain the fail-closed recovery evidence.
committed=1
mv -- "$receipt_tmp" "$lock/published.receipt"
sync -f "$lock"
regular_file "$lock/published.receipt" || exit 1
REMOTE_FINALIZE
FINALIZE_STATUS=$?
set -e

if [ "$FINALIZE_STATUS" -ne 0 ]; then
  if [ "$FINALIZE_STATUS" -eq 90 ]; then
    echo "OTA finalization failed and automatic rollback could not be verified; remote publication remains locked." >&2
  elif [ "$FINALIZE_STATUS" -ge 128 ]; then
    echo "OTA finalization was interrupted or transport failed; remote state is unverified and publication remains locked." >&2
  else
    if cleanup_remote; then
      echo "OTA finalization failed; the pre-publish state was preserved or restored." >&2
    else
      echo "OTA finalization failed after restoring state, but cleanup could not be verified; publication remains locked." >&2
    fi
  fi
  exit 1
fi

# Verify the exact manifest and APK through the authenticated public endpoint
# before acknowledging publication. The token never leaves the already-running
# gateway container and is never printed by this script or the remote verifier.
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_OTA_DIR" verify-public "$RELEASE_ID" "$APK_SHA256" "$APK_SIZE" \
  "$APP_ID" "$VERSION_CODE" "$VERSION_NAME" "$GIT_SHA" \
  "$REMOTE_PUBLIC_GATEWAY_URL" >/dev/null 2>&1 <<'REMOTE_PUBLIC_VERIFY'
set -euo pipefail
root="$1"
phase="$2"
release_id="$3"
apk_sha="$4"
apk_size="$5"
app_id="$6"
version_code="$7"
version_name="$8"
git_sha="$9"
public_gateway_url="${10}"
[ "$phase" = verify-public ] || exit 1
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 1
[[ "$apk_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$apk_size" =~ ^[0-9]+$ ]] || exit 1
[ "$app_id" = ai.moa.assistant ] || exit 1
[[ "$version_code" =~ ^[0-9]+$ ]] || exit 1
[[ "$version_name" =~ ^[A-Za-z0-9._+-]+$ ]] || exit 1
[[ "$git_sha" =~ ^[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$public_gateway_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || exit 1

compose_root=/opt/chief-moa/app
compose_env=/opt/chief-moa/gateway.env
container_ids="$(docker compose -p chief-moa \
  -f "$compose_root/docker-compose.yml" \
  -f "$compose_root/docker-compose.vps.yml" \
  --env-file "$compose_env" ps -q gateway)"
gateway_container=""
container_count=0
while IFS= read -r container_id; do
  [ -n "$container_id" ] || continue
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || exit 1
  container_count=$((container_count + 1))
  [ "$container_count" -le 1 ] || exit 1
  gateway_container="$container_id"
done <<< "$container_ids"
[ "$container_count" -eq 1 ] && [ -n "$gateway_container" ] || exit 1

docker exec -i "$gateway_container" node - \
  "$release_id" "$apk_sha" "$apk_size" "$app_id" "$version_code" \
  "$version_name" "$git_sha" "$public_gateway_url" <<'REMOTE_PUBLIC_NODE'
const crypto = require("node:crypto");
const [releaseId, apkSha, apkSizeText, appId, versionCodeText, versionName, gitSha, publicGatewayUrl] =
  process.argv.slice(2);
const base = String(publicGatewayUrl || "").replace(/\/+$/, "");
const token = process.env.MOA_GATEWAY_TOKEN;
if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(base) || !token) process.exit(1);
const headers = { authorization: `Bearer ${token}` };

async function main() {
  const requestOptions = () => ({ headers, signal: AbortSignal.timeout(10000) });
  const manifestResponse = await fetch(`${base}/v1/android/updates/latest`, requestOptions());
  if (!manifestResponse.ok) process.exit(1);
  const manifest = await manifestResponse.json();
  const expectedSize = Number(apkSizeText);
  const expectedVersionCode = Number(versionCodeText);
  if (manifest.release_id !== releaseId
    || manifest.sha256 !== apkSha
    || manifest.size_bytes !== expectedSize
    || manifest.app_id !== appId
    || manifest.version_code !== expectedVersionCode
    || manifest.version_name !== versionName
    || manifest.git_sha !== gitSha) process.exit(1);

  const apkResponse = await fetch(`${base}/v1/android/updates/latest.apk`, requestOptions());
  if (!apkResponse.ok) process.exit(1);
  const apk = Buffer.from(await apkResponse.arrayBuffer());
  if (apk.length !== expectedSize
    || crypto.createHash("sha256").update(apk).digest("hex") !== apkSha) process.exit(1);
}

main().catch(() => process.exit(1));
REMOTE_PUBLIC_NODE
REMOTE_PUBLIC_VERIFY
then
  echo "OTA publication committed, but authenticated public manifest/APK verification failed; remote state remains locked for exact retry." >&2
  exit 1
fi

# The client observed the successful finalizer. A separate acknowledgement now
# verifies the durable receipt and exact committed bytes before removing the
# owner lock and staging evidence. Lost ACK transport stays reconcilable.
set +e
ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_OTA_DIR" ack "$OPERATION_ID" "$RELEASE_ID" "$APK_SHA256" "$APK_SIZE" \
  "$RELEASE_META_SHA256" "$LATEST_SHA256" >/dev/null 2>&1 <<'REMOTE_ACK'
set -euo pipefail
root="$1"
phase="$2"
operation="$3"
release_id="$4"
apk_sha="$5"
apk_size="$6"
release_meta_sha="$7"
latest_sha="$8"
[ "$phase" = ack ] || exit 1
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
[[ "$root" != *"//"* && "$root" != *"/../"* && "$root" != *"/./"* \
  && "$root" != */.. && "$root" != */. ]] || exit 1
[[ "$operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || exit 1
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 1
[[ "$apk_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$apk_size" =~ ^[0-9]+$ ]] || exit 1
[[ "$release_meta_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$latest_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
hash_file() { sha256sum "$1" | awk '{print $1}'; }
size_file() { wc -c < "$1" | tr -d '[:space:]'; }
lock="$root/.publish-lock"
stage="$root/.publish-staging/$operation"
[ -d "$lock" ] && [ ! -L "$lock" ] || exit 1
[ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || exit 1
[ "$(cat "$lock/owner")" = "$operation" ] || exit 1
[ -f "$lock/published.receipt" ] && [ ! -L "$lock/published.receipt" ] || exit 1
[ "$(cat "$lock/published.receipt")" = \
  "$operation $release_id $apk_sha $apk_size $release_meta_sha $latest_sha" ] || exit 1
[ -d "$stage" ] && [ ! -L "$stage" ] || exit 1
[ -L "$root/current" ] && [ "$(readlink "$root/current")" = "releases/$release_id" ] || exit 1
[ "$(hash_file "$root/releases/$release_id/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(size_file "$root/releases/$release_id/moa-assistant.apk")" = "$apk_size" ] || exit 1
[ "$(hash_file "$root/releases/$release_id/release.json")" = "$release_meta_sha" ] || exit 1
[ "$(hash_file "$root/moa-assistant.apk")" = "$apk_sha" ] || exit 1
[ "$(hash_file "$root/latest.json")" = "$latest_sha" ] || exit 1
rm -rf -- "$stage" "$lock"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || exit 1
[ ! -e "$lock" ] && [ ! -L "$lock" ] || exit 1
REMOTE_ACK
ACK_STATUS=$?
set -e
if [ "$ACK_STATUS" -ne 0 ]; then
  echo "OTA publication committed, but acknowledgement cleanup is unverified; remote state remains locked for retry reconciliation." >&2
  exit 1
fi

REMOTE_PREPARED=0
trap - EXIT
echo "Published Android OTA release $RELEASE_ID with verified rollback snapshot $SNAPSHOT_ID."
