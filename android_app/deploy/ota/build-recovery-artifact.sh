#!/usr/bin/env bash
# Rebuild exact confirmed predecessor behavior as a new in-place-installable APK.
# This writes a separate immutable recovery artifact store. It never changes the
# canonical OTA current pointer and never contacts a remote host.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOOL="$ROOT_DIR/android_app/deploy/ota/recovery-artifact.mjs"
REQUEST=""
PREDECESSOR_APK=""
OUT_DIR="${ANDROID_RECOVERY_OUT_DIR:-$ROOT_DIR/android_app/dist/recovery}"
VERSION_CODE="${MOA_ANDROID_RECOVERY_VERSION_CODE:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) REQUEST="${2:-}"; shift 2 ;;
    --predecessor-apk) PREDECESSOR_APK="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --version-code) VERSION_CODE="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -f "$REQUEST" ] || { echo "A readable --request provenance JSON file is required." >&2; exit 1; }
[ -f "$PREDECESSOR_APK" ] || { echo "The exact --predecessor-apk is unavailable." >&2; exit 1; }
[[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || { echo "A numeric --version-code is required." >&2; exit 1; }

SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
AAPT="$(find "$SDK_ROOT/build-tools" -type f -name aapt 2>/dev/null | sort -V | tail -n1)"
APKSIGNER="$(find "$SDK_ROOT/build-tools" -type f -name apksigner 2>/dev/null | sort -V | tail -n1)"
[ -x "$AAPT" ] || { echo "Android aapt is unavailable." >&2; exit 1; }
[ -x "$APKSIGNER" ] || { echo "Android apksigner is unavailable." >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

apk_facts() {
  local apk="$1"
  local output="$2"
  local badging signer app_id version_code sha size
  badging="$("$AAPT" dump badging "$apk" | sed -n '1p')"
  app_id="$(printf '%s\n' "$badging" | sed -nE "s/^package: name='([^']+)'.*/\1/p")"
  version_code="$(printf '%s\n' "$badging" | sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p")"
  signer="$("$APKSIGNER" verify --print-certs "$apk" | sed -nE 's/^Signer #1 certificate SHA-256 digest: ([A-Fa-f0-9:]+)$/\1/p' | head -n1 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
  sha="$(shasum -a 256 "$apk" | awk '{print $1}')"
  size="$(wc -c < "$apk" | tr -d '[:space:]')"
  APK_FACTS_APP_ID="$app_id" APK_FACTS_VERSION_CODE="$version_code" \
    APK_FACTS_SIGNER="$signer" APK_FACTS_SHA="$sha" APK_FACTS_SIZE="$size" \
    node - "$output" <<'NODE'
const fs = require("node:fs");
const value = {
  app_id: process.env.APK_FACTS_APP_ID,
  version_code: Number(process.env.APK_FACTS_VERSION_CODE),
  signer_sha256: process.env.APK_FACTS_SIGNER,
  sha256: process.env.APK_FACTS_SHA,
  size_bytes: Number(process.env.APK_FACTS_SIZE),
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
NODE
}

apk_facts "$PREDECESSOR_APK" "$TMP_DIR/predecessor-facts.json"
SOURCE_COMMIT="$(node -e 'const v=require(process.argv[1]); process.stdout.write(String(v.target_predecessor?.source_commit||""))' "$REQUEST")"
RESOLVED_SOURCE="$(git -C "$ROOT_DIR" rev-parse --verify "$SOURCE_COMMIT^{commit}" 2>/dev/null || true)"
node --input-type=module - "$TOOL" "$RESOLVED_SOURCE" "$SOURCE_COMMIT" <<'NODE'
const [tool, resolved, expected] = process.argv.slice(2);
const { assertSourceCommitAvailable } = await import(`file://${tool}`);
assertSourceCommitAvailable(resolved, expected);
NODE
BUILDER_COMMIT="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
node "$TOOL" prepare "$REQUEST" "$TMP_DIR/predecessor-facts.json" \
  "$VERSION_CODE" "$BUILDER_COMMIT" "$TMP_DIR/plan.json"

mkdir "$TMP_DIR/source"
git -C "$ROOT_DIR" archive "$SOURCE_COMMIT" | tar -x -C "$TMP_DIR/source"
PLAN_VALUE="$(node -e 'const v=require(process.argv[1]); process.stdout.write(String(v[process.argv[2]]))' "$TMP_DIR/plan.json" source_commit)"
[ "$PLAN_VALUE" = "$SOURCE_COMMIT" ] || { echo "Prepared source provenance changed." >&2; exit 1; }
APP_ID="$(node -e 'const v=require(process.argv[1]); process.stdout.write(v.app_id)' "$TMP_DIR/plan.json")"
VERSION_NAME="$(node -e 'const v=require(process.argv[1]); process.stdout.write(v.version_name)' "$TMP_DIR/plan.json")"

if [ -n "${MOA_ANDROID_KEYSTORE_PATH:-}" ]; then
  VARIANT=Release
  APK="$TMP_DIR/source/android_app/app/build/outputs/apk/release/app-release.apk"
else
  VARIANT=Debug
  APK="$TMP_DIR/source/android_app/app/build/outputs/apk/debug/app-debug.apk"
fi
(
  cd "$TMP_DIR/source/android_app"
  ANDROID_HOME="$SDK_ROOT" \
  MOA_ANDROID_VERSION_CODE="$VERSION_CODE" \
  MOA_ANDROID_VERSION_NAME="$VERSION_NAME" \
  MOA_ANDROID_GIT_SHA="$SOURCE_COMMIT" \
  ./gradlew ":app:assemble$VARIANT" -x verifySourceSizePolicy
)
[ -f "$APK" ] || { echo "Recovery APK build did not produce the expected artifact." >&2; exit 1; }
apk_facts "$APK" "$TMP_DIR/built-facts.json"
BUILT_APP_ID="$(node -e 'const v=require(process.argv[1]); process.stdout.write(v.app_id)' "$TMP_DIR/built-facts.json")"
[ "$BUILT_APP_ID" = "$APP_ID" ] || { echo "Recovery build changed Android package identity." >&2; exit 1; }
BUILT_AT="${MOA_RECOVERY_BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
RELEASE_DIR="$(node "$TOOL" finalize "$TMP_DIR/plan.json" "$TMP_DIR/built-facts.json" \
  "$APK" "$OUT_DIR" "$BUILT_AT")"
echo "Forward Android recovery artifact written to $RELEASE_DIR"
echo "Canonical stable/trial pointers were not changed."
