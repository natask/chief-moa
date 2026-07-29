#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android_app"
OUT_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
VERSION_CODE="${MOA_ANDROID_VERSION_CODE:-$(date +%s)}"
VERSION_NAME="${MOA_ANDROID_VERSION_NAME:-0.1.$VERSION_CODE}"
GIT_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse --verify HEAD 2>/dev/null || echo unknown)}"

if [[ ! "$GIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Android OTA metadata requires a full 40-character Git commit SHA." >&2
  exit 1
fi

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

# Publish into the versioned release store: releases/<release_id>/ (apk +
# release.json) plus an atomic `current` symlink. publishRelease also refreshes
# the legacy moa-assistant.apk + latest.json so pre-rollback clients keep working.
OTA_MODULE_DIR="$ROOT_DIR/gateway/lib" \
ANDROID_OTA_DIR="$OUT_DIR" \
MOA_OTA_APK_PATH="$APK_PATH" \
MOA_ANDROID_VERSION_CODE="$VERSION_CODE" \
MOA_ANDROID_VERSION_NAME="$VERSION_NAME" \
MOA_ANDROID_GIT_SHA="$GIT_SHA" \
node -e '
const path = require("node:path");
const androidOta = require(path.join(process.env.OTA_MODULE_DIR, "android-ota"));
const published = androidOta.publishRelease(process.env.ANDROID_OTA_DIR, {
  apk: process.env.MOA_OTA_APK_PATH,
  meta: {
    app_id: "ag.companion",
    version_code: Number(process.env.MOA_ANDROID_VERSION_CODE),
    version_name: process.env.MOA_ANDROID_VERSION_NAME,
    git_sha: process.env.MOA_ANDROID_GIT_SHA,
    published_at: new Date().toISOString(),
    min_sdk: 26,
  },
});
console.log("Published Android OTA release " + published.release_id +
  " (version_code " + published.version_code + ") to " + process.env.ANDROID_OTA_DIR);
'

echo "Android OTA artifact written to $OUT_DIR"
