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
# This low-level publisher accepts --host or MOA_VPS_SSH, but falls back to
# the repository's tracked, non-secret canonical production target in
# scripts/deploy-targets.json when neither is set, so a human running this
# script directly (e.g. to recover a stuck lock) does not have to already know
# the deploy target. MOA_VPS_PUBLIC_GATEWAY_URL falls back the same way. Both
# remain overridable. See DEPLOYMENT.md's "Android OTA" section for the full
# publish/recover/rollback story, including how to read a stuck-lock failure.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_OTA_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
DEPLOY_TARGETS_FILE="${MOA_DEPLOY_TARGETS_FILE:-$ROOT_DIR/scripts/deploy-targets.json}"
HOST="${MOA_VPS_SSH:-}"
# Host-side path of the gateway container's /data named volume. This is the
# store's base directory: the ai.moa.assistant (legacy/default) channel lives
# directly at this path, unchanged. Any other app id gets its own isolated
# subtree under "$REMOTE_OTA_BASE_DIR/channels/<app_id>/" so two application
# ids never share one `current` pointer or `latest.json` -- see the channel
# routing block below, after the local release facts (including the app id
# actually being published) have been read and validated.
# The store is moving onto its own volume (chief-moa_moa-ota-data) so the
# publisher and the gateway stop sharing one directory tree: publishing into
# the gateway's data volume is what crash-looped production on 2026-07-29 and
# what fails the gateway backup when tar meets a 0700 .publish-staging.
# MOA_VPS_OTA_DIR overrides the target for the staged cutover and for a
# rollback to the legacy path.
REMOTE_OTA_BASE_DIR="${MOA_VPS_OTA_DIR:-/var/lib/docker/volumes/chief-moa_moa-ota-data/_data}"
# The gateway reads this store as uid 1000. Everything the publisher creates
# must belong to that uid, or the next gateway boot meets a directory it
# cannot traverse. 0 means "leave ownership alone" for hosts that manage it
# another way.
REMOTE_OTA_OWNER_UID="${MOA_VPS_OTA_OWNER_UID:-1000}"
REMOTE_OTA_OWNER_GID="${MOA_VPS_OTA_OWNER_GID:-1000}"
REMOTE_PUBLIC_GATEWAY_URL="${MOA_VPS_PUBLIC_GATEWAY_URL:-}"
SNAPSHOT_RETENTION="${MOA_OTA_SNAPSHOT_RETENTION:-2}"
# Keep the live release plus one predecessor: exactly the one-step rollback the
# Android client offers. Anything older is a rebuild from the tagged commit with
# the continuity key. Minimum 2, so a rollback target always survives.
RELEASE_RETENTION="${MOA_OTA_RELEASE_RETENTION:-2}"
# Secondary signal only (see the lock-reclaim comment below): how long a
# completed-but-abandoned publish lock must sit before an unrelated operation
# may reclaim it. This guards against racing a publish that is still running
# its own post-commit acknowledgement cleanup.
RECLAIM_MIN_AGE_SECONDS="${MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS:-300}"

# Non-secret canonical target lookup, shared in spirit with scripts/deploy.sh's
# production_vps_target(). Read-only; never writes or prints the file's path
# unless the field itself is missing (in which case the caller's own error
# names the file to fix, not any secret).
canonical_target_field() {
  node - "$DEPLOY_TARGETS_FILE" "$1" <<'NODE'
const fs = require("node:fs");
const [file, field] = process.argv.slice(2);
let config;
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(1);
}
const value = config?.production?.[field];
if (typeof value !== "string" || !value) process.exit(1);
process.stdout.write(value);
NODE
}

if [ -z "$HOST" ]; then
  HOST="$(canonical_target_field vps_ssh 2>/dev/null || true)"
fi
if [ -z "$REMOTE_PUBLIC_GATEWAY_URL" ]; then
  REMOTE_PUBLIC_GATEWAY_URL="$(canonical_target_field public_gateway_url 2>/dev/null || true)"
fi

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
  echo "Missing VPS host: no --host, no MOA_VPS_SSH, and $DEPLOY_TARGETS_FILE has no readable production.vps_ssh. Set MOA_VPS_SSH=user@host, pass --host user@host, or fix that tracked file." >&2
  exit 1
fi
if [[ ! "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "The VPS host must be a plain user@host target (got a value from --host, MOA_VPS_SSH, or $DEPLOY_TARGETS_FILE that does not match)." >&2
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
remote_ota_dir_is_safe() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [[ "$1" != *"//"* ]] \
    && [[ "$1" != *"/../"* ]] \
    && [[ "$1" != *"/./"* ]] \
    && [[ "$1" != */.. ]] \
    && [[ "$1" != */. ]]
}
if ! remote_ota_dir_is_safe "$REMOTE_OTA_BASE_DIR"; then
  echo "The remote OTA directory must be a normalized absolute path." >&2
  exit 1
fi
if [[ ! "$REMOTE_PUBLIC_GATEWAY_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  if [ -z "$REMOTE_PUBLIC_GATEWAY_URL" ]; then
    echo "Missing public gateway origin: no MOA_VPS_PUBLIC_GATEWAY_URL, and $DEPLOY_TARGETS_FILE has no readable production.public_gateway_url. Set MOA_VPS_PUBLIC_GATEWAY_URL=https://<host>, fix that tracked file, or read the value from the running gateway's GET /health (public_gateway_url field)." >&2
  else
    echo "MOA_VPS_PUBLIC_GATEWAY_URL must be an HTTPS origin without a path (got a value from the environment or $DEPLOY_TARGETS_FILE that does not match)." >&2
  fi
  exit 1
fi
if [[ ! "$SNAPSHOT_RETENTION" =~ ^[0-9]+$ ]] \
  || [ "$SNAPSHOT_RETENTION" -lt 1 ] \
  || [ "$SNAPSHOT_RETENTION" -gt 20 ]; then
  echo "MOA_OTA_SNAPSHOT_RETENTION must be between 1 and 20." >&2
  exit 1
fi
if [[ ! "$RECLAIM_MIN_AGE_SECONDS" =~ ^[0-9]+$ ]] \
  || [ "$RECLAIM_MIN_AGE_SECONDS" -gt 86400 ]; then
  echo "MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS must be an integer between 0 and 86400." >&2
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
  || [[ "$APP_ID" != "ai.moa.assistant" && "$APP_ID" != "ag.companion" ]] \
  || [[ ! "$VERSION_CODE" =~ ^[0-9]+$ ]] \
  || [[ ! "$VERSION_NAME" =~ ^[A-Za-z0-9._+-]+$ ]] \
  || [[ ! "$GIT_SHA" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Local OTA store validation returned unsafe release facts." >&2
  exit 1
fi

# Each known application id gets its own release channel so two apps never
# share one `current` pointer or `latest.json`. ai.moa.assistant is the
# original/default channel and keeps publishing straight to the store's base
# directory -- byte-for-byte the same location this script has always used --
# so that channel, and the phone running it today, are never touched by this
# routing. Any other application id is confined to its own named subtree.
# This is an explicit allowlist, not a passthrough of an arbitrary string into
# a filesystem path: a build with an unrecognized application id fails closed
# here rather than silently creating a new channel directory.
case "$APP_ID" in
  ai.moa.assistant)
    REMOTE_OTA_DIR="$REMOTE_OTA_BASE_DIR"
    ;;
  ag.companion)
    REMOTE_OTA_DIR="$REMOTE_OTA_BASE_DIR/channels/ag.companion"
    ;;
  *)
    echo "Local OTA build has an application id ($APP_ID) with no configured release channel." >&2
    exit 1
    ;;
esac
if ! remote_ota_dir_is_safe "$REMOTE_OTA_DIR"; then
  echo "The computed channel OTA directory must be a normalized absolute path." >&2
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

# Translate a bounded, non-secret preflight reason token into an
# operator-facing message. Under CI (GITHUB_ACTIONS=true) this always stays
# generic: the calling workflow step already withholds this script's full
# output because it may reveal target details in a shared build log, and
# that decision must not be undone just because the message got more
# detailed. A human running this script directly gets the specific reason
# and remediation instead of having to read this script and the remote
# store by hand.
print_preflight_failure() {
  local reason="$1"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "Remote OTA backup/preflight failed; no release was published." >&2
    return
  fi
  case "$reason" in
    lock-in-progress-no-receipt)
      echo "Remote OTA publish lock is held with no completion receipt: a publish is still running, or crashed before finishing. This is NOT auto-recoverable -- do not clear it automatically. Confirm on the VPS that no publish is actually in flight, then inspect (and only if truly abandoned, remove by hand) \$REMOTE_OTA_DIR/.publish-lock. See DEPLOYMENT.md's OTA lock-recovery section." >&2
      ;;
    lock-receipt-too-recent)
      echo "Remote OTA publish lock has a completion receipt that matches the live release, but it is younger than the ${RECLAIM_MIN_AGE_SECONDS}s reclaim age (MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS). Its owner may still be finishing its own cleanup. Wait a few minutes and retry; this is not stuck." >&2
      ;;
    lock-receipt-live-mismatch)
      echo "Remote OTA publish lock has a completion receipt that does NOT match the live release on the VPS. This needs manual inspection before any publish proceeds -- the remote store may have been modified out of band. See DEPLOYMENT.md's OTA lock-recovery section." >&2
      ;;
    lock-receipt-corrupt)
      echo "Remote OTA publish lock exists but its owner/receipt files are malformed. This needs manual inspection; it will not self-clear. See DEPLOYMENT.md's OTA lock-recovery section." >&2
      ;;
    remote-store-corrupt)
      echo "The remote OTA store's current release pointer or files are structurally inconsistent. This needs manual inspection before another publish can proceed safely." >&2
      ;;
    remote-store-not-empty-unexpected)
      echo "The remote OTA store has no current release, but is not empty either (stray files or a releases/ entry without a current pointer). This needs manual inspection before another publish can proceed safely." >&2
      ;;
    remote-tools-missing)
      echo "The VPS is missing one of the required tools (sha256sum, cmp, readlink, sync, stat, date). Install it and retry." >&2
      ;;
    *)
      echo "Remote OTA backup/preflight failed; no release was published. Re-run with the remote lock state inspected by hand if this repeats; see DEPLOYMENT.md's OTA lock-recovery section." >&2
      ;;
  esac
}

# Acquire a remote publication lock, validate the prior current pointer, and
# create a verified, bounded snapshot before any upload or mutable update.
#
# Failures below report a bounded, non-secret reason token on stdout right
# before exiting non-zero (never a raw path or host). The caller translates
# that token into an operator-facing message locally and only under a
# non-CI shell; stderr stays fully suppressed here so nothing from the
# remote session (banners, tool output) can leak either way.
PREFLIGHT_REASON=""
if ! PREFLIGHT_REASON="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_OTA_DIR" preflight "$SNAPSHOT_ID" "$OPERATION_ID" "$SNAPSHOT_RETENTION" \
  "$RELEASE_ID" "$APK_SHA256" "$APK_SIZE" "$RELEASE_META_SHA256" "$LATEST_SHA256" \
  "$RECLAIM_MIN_AGE_SECONDS" \
  2>/dev/null <<'REMOTE_PREFLIGHT'
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
reclaim_min_age_seconds="${11}"
# Print a bounded reason token on stdout, then exit 1. Called at every
# operator-actionable decision point below instead of a bare `exit 1` so the
# caller can report which invariant failed without re-deriving it by hand.
fail() { printf '%s\n' "$1"; exit 1; }
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
[[ "$reclaim_min_age_seconds" =~ ^[0-9]+$ ]] || exit 1
command -v sha256sum >/dev/null 2>&1 || fail remote-tools-missing
command -v cmp >/dev/null 2>&1 || fail remote-tools-missing
command -v readlink >/dev/null 2>&1 || fail remote-tools-missing
command -v sync >/dev/null 2>&1 || fail remote-tools-missing
command -v stat >/dev/null 2>&1 || fail remote-tools-missing
command -v date >/dev/null 2>&1 || fail remote-tools-missing
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
# .publish-locks-recovered retains evidence for locks reclaimed below. Nothing
# in this preflight step ever deletes an entry once written.
for name in releases .publish-staging .publish-snapshots .publish-locks-recovered; do
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

# A prior client may have lost its SSH result after the host committed, or
# died between committing the receipt and running its own acknowledgement
# cleanup. Distinguish three lock states:
#
#   - No receipt at all: the prior publish is still running, or crashed
#     before it finished. This is exactly what the lock protects, and it is
#     NEVER auto-reclaimed here, regardless of age.
#   - A receipt that exactly matches the candidate bytes this operation is
#     itself publishing: this call is an exact retry of the same publish
#     that already committed. Reconcile immediately, exactly as before --
#     no age delay, since a client retrying its own publish is not racing
#     the cleanup of a different owner.
#   - A receipt for a DIFFERENT release whose own recorded hashes match the
#     live store exactly: some other publish genuinely completed and only
#     its cleanup was abandoned. An abandoned lock must not block every
#     future publish, only ones that would race an unfinished one, so this
#     is also reclaimed -- but only after the secondary age gate, since its
#     owner may still be running its own post-commit acknowledgement.
if [ -e "$lock" ] || [ -L "$lock" ]; then
  [ -d "$lock" ] && [ ! -L "$lock" ] || fail lock-receipt-corrupt
  [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || fail lock-receipt-corrupt
  lock_owner="$(cat "$lock/owner")" || fail lock-receipt-corrupt
  if [ ! -f "$lock/published.receipt" ] || [ -L "$lock/published.receipt" ]; then
    fail lock-in-progress-no-receipt
  fi
  read -r receipt_operation receipt_release receipt_apk receipt_size receipt_meta receipt_latest \
    < "$lock/published.receipt" || fail lock-receipt-corrupt
  [ "$lock_owner" = "$receipt_operation" ] || fail lock-receipt-corrupt
  [[ "$receipt_operation" =~ ^publish-[A-Za-z0-9._-]+$ ]] || fail lock-receipt-corrupt
  [[ "$receipt_release" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || fail lock-receipt-corrupt
  [[ "$receipt_apk" =~ ^[a-f0-9]{64}$ ]] || fail lock-receipt-corrupt
  [[ "$receipt_size" =~ ^[0-9]+$ ]] || fail lock-receipt-corrupt
  [[ "$receipt_meta" =~ ^[a-f0-9]{64}$ ]] || fail lock-receipt-corrupt
  [[ "$receipt_latest" =~ ^[a-f0-9]{64}$ ]] || fail lock-receipt-corrupt

  exact_retry=0
  if [ "$receipt_release" = "$release_id" ] \
    && [ "$receipt_apk" = "$apk_sha" ] \
    && [ "$receipt_size" = "$apk_size" ] \
    && [ "$receipt_meta" = "$release_meta_sha" ] \
    && [ "$receipt_latest" = "$latest_sha" ]; then
    exact_retry=1
  fi

  # The fields recorded in the receipt itself -- not necessarily this new
  # operation candidate -- must match the live store exactly. This is the
  # primary safety proof that the prior publish finished: the receipt is
  # written last, after every other file already matches it, so a
  # half-finished publish can never produce a match here.
  prior_stage="$root/.publish-staging/$receipt_operation"
  [ -L "$root/current" ] \
    && [ "$(readlink "$root/current")" = "releases/$receipt_release" ] || fail lock-receipt-live-mismatch
  [ "$(hash_file "$root/releases/$receipt_release/moa-assistant.apk")" = "$receipt_apk" ] || fail lock-receipt-live-mismatch
  [ "$(size_file "$root/releases/$receipt_release/moa-assistant.apk")" = "$receipt_size" ] || fail lock-receipt-live-mismatch
  [ "$(hash_file "$root/releases/$receipt_release/release.json")" = "$receipt_meta" ] || fail lock-receipt-live-mismatch
  [ "$(hash_file "$root/moa-assistant.apk")" = "$receipt_apk" ] || fail lock-receipt-live-mismatch
  [ "$(hash_file "$root/latest.json")" = "$receipt_latest" ] || fail lock-receipt-live-mismatch

  if [ "$exact_retry" -ne 1 ]; then
    # Only for a release different from the one this operation is
    # publishing, after the receipt is already proven to describe the
    # live, completed publish, apply the secondary age gate.
    receipt_mtime="$(stat -c %Y "$lock/published.receipt" 2>/dev/null)" || fail lock-receipt-corrupt
    now_ts="$(date +%s)" || fail lock-receipt-corrupt
    receipt_age=$(( now_ts - receipt_mtime ))
    [ "$receipt_age" -ge "$reclaim_min_age_seconds" ] || fail lock-receipt-too-recent
  fi

  # Verified complete and abandoned: move the lock aside as retained recovery
  # evidence (never delete it) and clear its private staging leftovers, then
  # fall through to acquire a fresh lock for this operation below.
  recovered="$root/.publish-locks-recovered/$(date -u +%Y%m%dT%H%M%SZ)-${receipt_operation}"
  [ ! -e "$recovered" ] && [ ! -L "$recovered" ] || fail lock-receipt-corrupt
  mv -- "$lock" "$recovered" || fail lock-receipt-corrupt
  rm -rf -- "$prior_stage"
  [ ! -e "$prior_stage" ] && [ ! -L "$prior_stage" ] || fail lock-receipt-corrupt
  [ ! -e "$lock" ] && [ ! -L "$lock" ] || fail lock-receipt-corrupt
fi

mkdir -- "$lock" || fail lock-in-progress-no-receipt
lock_owned=1
printf '%s\n' "$operation" > "$lock/owner"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || exit 1
[ ! -e "$snapshot" ] && [ ! -L "$snapshot" ] || exit 1
mkdir -p -- "$stage/release" "$stage/legacy" "$snapshot"
printf '%s\n' "$operation" > "$snapshot/operation"

if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  [ -L "$root/current" ] || fail remote-store-corrupt
  current_target="$(readlink "$root/current")"
  [[ "$current_target" =~ ^releases/([a-z0-9][a-z0-9._-]{0,127})$ ]] || fail remote-store-corrupt
  current_release="${BASH_REMATCH[1]}"
  current_dir="$root/releases/$current_release"
  [ -d "$current_dir" ] && [ ! -L "$current_dir" ] || fail remote-store-corrupt
  for file in "$current_dir/moa-assistant.apk" "$current_dir/release.json" \
    "$root/moa-assistant.apk" "$root/latest.json"; do
    [ -f "$file" ] && [ ! -L "$file" ] || fail remote-store-corrupt
  done
  cmp -s "$current_dir/moa-assistant.apk" "$root/moa-assistant.apk" || fail remote-store-corrupt
  prior_sha="$(hash_file "$current_dir/moa-assistant.apk")"
  prior_size="$(size_file "$current_dir/moa-assistant.apk")"
  [ "$(json_string sha256 "$current_dir/release.json")" = "$prior_sha" ] || fail remote-store-corrupt
  [ "$(json_string sha256 "$root/latest.json")" = "$prior_sha" ] || fail remote-store-corrupt
  [ "$(json_number size_bytes "$current_dir/release.json")" = "$prior_size" ] || fail remote-store-corrupt
  [ "$(json_number size_bytes "$root/latest.json")" = "$prior_size" ] || fail remote-store-corrupt
  [ "$(json_string apk "$current_dir/release.json")" = moa-assistant.apk ] || fail remote-store-corrupt
  [ "$(json_string apk "$root/latest.json")" = moa-assistant.apk ] || fail remote-store-corrupt
  [ "$(json_string release_id "$root/latest.json")" = "$current_release" ] || fail remote-store-corrupt
  for key in app_id version_name git_sha published_at; do
    [ "$(json_string "$key" "$current_dir/release.json")" = \
      "$(json_string "$key" "$root/latest.json")" ] || fail remote-store-corrupt
  done
  for key in version_code min_sdk; do
    [ "$(json_number "$key" "$current_dir/release.json")" = \
      "$(json_number "$key" "$root/latest.json")" ] || fail remote-store-corrupt
  done
  printf 'existing\n' > "$snapshot/state"
  printf '%s\n' "$current_target" > "$snapshot/current.target"
  ln -s "$current_target" "$snapshot/current"
  cp -p -- "$current_dir/release.json" "$snapshot/current.release.json"
  cp -p -- "$root/latest.json" "$snapshot/latest.json"
  cp -p -- "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk"
  cmp -s "$root/latest.json" "$snapshot/latest.json" || fail remote-store-corrupt
  cmp -s "$root/moa-assistant.apk" "$snapshot/moa-assistant.apk" || fail remote-store-corrupt
  (
    cd "$snapshot"
    sha256sum current.release.json latest.json moa-assistant.apk > checksums.sha256
    sha256sum -c checksums.sha256 >/dev/null
  )
else
  [ ! -e "$root/moa-assistant.apk" ] && [ ! -L "$root/moa-assistant.apk" ] || fail remote-store-not-empty-unexpected
  [ ! -e "$root/latest.json" ] && [ ! -L "$root/latest.json" ] || fail remote-store-not-empty-unexpected
  shopt -s nullglob
  release_entries=("$root/releases"/*)
  [ "${#release_entries[@]}" -eq 0 ] || fail remote-store-not-empty-unexpected
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
)"; then
  print_preflight_failure "$PREFLIGHT_REASON"
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
  "$REMOTE_OTA_OWNER_UID" "$REMOTE_OTA_OWNER_GID" \
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
owner_uid="${10}"
owner_gid="${11}"
[ "$phase" = finalize ] || exit 1
[[ "$owner_uid" =~ ^[0-9]+$ ]] || exit 1
[[ "$owner_gid" =~ ^[0-9]+$ ]] || exit 1
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

# The gateway reads this store as an unprivileged user. Publishing over SSH
# as root left root-owned 0700 directories inside it; on 2026-07-29 one of
# them (channels/) made the gateway die at boot with EACCES and 502 every
# request. Hand the whole store to the gateway user, so publisher-created
# paths can never be unreadable by the process that has to serve them.
# owner_uid=0 means the host manages ownership another way; skip then.
#
# Only a privileged publisher can hand files to another uid. Production
# publishes over SSH as root, so this applies there. An unprivileged publisher
# cannot chown at all and would already own everything it created consistently,
# so skipping is correct rather than a silent hole. A root publisher that fails
# to chown is a real error.
if [ "$owner_uid" -ne 0 ] && [ "$(id -u)" = "0" ]; then
  chown -R "$owner_uid:$owner_gid" "$root" || exit 1
fi

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
[ "$app_id" = ai.moa.assistant ] || [ "$app_id" = ag.companion ] || exit 1
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
  // ai.moa.assistant is the original/default channel and stays on the
  // unscoped route, byte-for-byte the same endpoint this verifier has always
  // called. Any other application id is verified through its own app-scoped
  // route so a device running one app can never be confirmed against, or
  // served, another app's manifest/APK.
  const updatesBase = appId === "ai.moa.assistant"
    ? `${base}/v1/android/updates`
    : `${base}/v1/android/updates/apps/${encodeURIComponent(appId)}`;
  const manifestResponse = await fetch(`${updatesBase}/latest`, requestOptions());
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

  const apkResponse = await fetch(`${updatesBase}/latest.apk`, requestOptions());
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
  "$RELEASE_META_SHA256" "$LATEST_SHA256" "$RELEASE_RETENTION" "$SNAPSHOT_RETENTION" \
  >/dev/null 2>&1 <<'REMOTE_ACK'
set -euo pipefail
root="$1"
phase="$2"
operation="$3"
release_id="$4"
apk_sha="$5"
apk_size="$6"
release_meta_sha="$7"
latest_sha="$8"
release_retention="$9"
snapshot_retention="${10}"
[ "$phase" = ack ] || exit 1
[[ "$release_retention" =~ ^[0-9]+$ ]] && [ "$release_retention" -ge 2 ] || exit 1
[[ "$snapshot_retention" =~ ^[0-9]+$ ]] && [ "$snapshot_retention" -ge 1 ] || exit 1
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

# Retention. Reached only after the new release is live AND its authenticated
# public manifest/APK verification has already passed, so pruning here can never
# remove a release the phone is about to be offered.
#
# APKs are deployment artifacts, rebuildable from the tagged commit with the
# continuity key. Keeping the live release plus one predecessor preserves the
# one-step rollback the client actually offers. Publication used to delete
# nothing at all, and the store had grown to 33 releases and 36 snapshots inside
# the gateway's data volume.
#
# Every rule fails safe: only well-formed release ids directly under the base are
# considered, the live release is never a candidate, unreadable metadata keeps
# the entry, and the live release is re-checked afterwards.
prune_oldest() {
  # base, how many to keep, name of an entry that must never be dropped, and a
  # newline-separated "sortkey<TAB>name" listing on stdin. Oldest sort keys go
  # first, so the head of the list is what gets dropped.
  local base="$1" keep="$2" protect="$3" listing="" name="" total=0 drop=0
  listing="$(cat)"
  [ -n "$listing" ] || return 0
  total="$(printf '%s\n' "$listing" | wc -l | tr -d '[:space:]')"
  # `keep` counts the protected live entry, which the callers already exclude.
  [ -n "$protect" ] && keep=$(( keep - 1 ))
  drop=$(( total - keep ))
  [ "$drop" -gt 0 ] || return 0
  printf '%s\n' "$listing" | head -n "$drop" | cut -f2 | while IFS= read -r name; do
    [ -n "$name" ] && [ "$name" != "$protect" ] || continue
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || continue
    rm -rf -- "${base:?}/${name:?}"
  done
}

# Releases are ordered by the published_at the gateway itself orders them by
# (compareReleasesAsc in gateway/lib/android-ota.js), so the release this prune
# keeps is exactly the one the client would roll back to.
releases_base="$root/releases"
if [ -d "$releases_base" ] && [ ! -L "$releases_base" ]; then
  for entry in "$releases_base"/*/; do
    entry="${entry%/}"
    [ -d "$entry" ] && [ ! -L "$entry" ] || continue
    name="${entry##*/}"
    [[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || continue
    [ "$name" != "$release_id" ] || continue
    stamp="$(sed -n 's/.*"published_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$entry/release.json" 2>/dev/null | head -n 1)"
    # No readable timestamp means unknown age; keep it rather than guess.
    [ -n "$stamp" ] || continue
    printf '%s\t%s\n' "$stamp" "$name"
  done | sort | prune_oldest "$releases_base" "$release_retention" "$release_id"
fi

# Snapshots carry no release.json. Their ids are timestamp-prefixed, so a plain
# lexical sort is their chronological order.
snapshots_base="$root/.publish-snapshots"
if [ -d "$snapshots_base" ] && [ ! -L "$snapshots_base" ]; then
  for entry in "$snapshots_base"/*/; do
    entry="${entry%/}"
    [ -d "$entry" ] && [ ! -L "$entry" ] || continue
    name="${entry##*/}"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || continue
    printf '%s\t%s\n' "$name" "$name"
  done | sort | prune_oldest "$snapshots_base" "$(( snapshot_retention + 1 ))" ""
fi
# The live release and its pointer must still be intact after pruning.
[ -d "$root/releases/$release_id" ] || exit 1
[ -L "$root/current" ] && [ "$(readlink "$root/current")" = "releases/$release_id" ] || exit 1
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
