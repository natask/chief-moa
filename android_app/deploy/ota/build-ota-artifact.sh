#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android_app"
OUT_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
VERSION_CODE="${MOA_ANDROID_VERSION_CODE:-$(date +%s)}"
VERSION_NAME="${MOA_ANDROID_VERSION_NAME:-0.1.$VERSION_CODE}"
GIT_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)}"

mkdir -p "$OUT_DIR"

export MOA_ANDROID_VERSION_CODE="$VERSION_CODE"
export MOA_ANDROID_VERSION_NAME="$VERSION_NAME"
export MOA_ANDROID_GIT_SHA="$GIT_SHA"

if [[ -n "${MOA_ANDROID_KEYSTORE_PATH:-}" ]]; then
  VARIANT="Release"
  APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
else
  VARIANT="Debug"
  APK_PATH="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
fi

(
  cd "$ANDROID_DIR"
  ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" ./gradlew ":app:assemble$VARIANT"
)

cp "$APK_PATH" "$OUT_DIR/moa-assistant.apk"

node - "$OUT_DIR/moa-assistant.apk" "$OUT_DIR/latest.json" "$VERSION_CODE" "$VERSION_NAME" "$GIT_SHA" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [apkPath, manifestPath, versionCode, versionName, gitSha] = process.argv.slice(2);
const apk = fs.readFileSync(apkPath);
const manifest = {
  app_id: "ai.moa.assistant",
  version_code: Number(versionCode),
  version_name: versionName,
  apk: "moa-assistant.apk",
  size_bytes: apk.length,
  sha256: crypto.createHash("sha256").update(apk).digest("hex"),
  git_sha: gitSha,
  built_at: new Date().toISOString(),
  min_sdk: 26,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
NODE

echo "Android OTA artifact written to $OUT_DIR"
