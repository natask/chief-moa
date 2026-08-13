#!/usr/bin/env bash
# Build, test, and package Chief MOA entirely on the operator machine.
# This command has no network publication, GitHub, SSH, ADB, browser reload,
# or active-service side effects. Release artifacts are accompanied by SHA-256
# receipts under .git/chief-moa-local-releases/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-all}"
HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
GIT_COMMON_DIR="$(git -C "$ROOT_DIR" rev-parse --path-format=absolute --git-common-dir)"
RECEIPT_DIR="${MOA_LOCAL_RELEASE_RECEIPT_DIR:-$GIT_COMMON_DIR/chief-moa-local-releases}"
mkdir -p "$RECEIPT_DIR"

log() { printf '[local-release] %s\n' "$*"; }
fail() { printf '[local-release] ERROR: %s\n' "$*" >&2; exit 1; }

require_clean_paths() {
  local dirty
  dirty="$(git -C "$ROOT_DIR" status --porcelain -- "$@")"
  [ -z "$dirty" ] || fail "release inputs are dirty:\n$dirty"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

write_receipt() {
  local surface="$1" artifact="$2" digest="$3"
  local receipt="$RECEIPT_DIR/${surface}-${HEAD_SHA}.json"
  node - "$receipt" "$surface" "$HEAD_SHA" "$artifact" "$digest" <<'NODE'
const fs = require("node:fs");
const [receipt, surface, gitSha, artifact, sha256] = process.argv.slice(2);
const value = {
  schema_version: "chief-moa-local-release/v1",
  surface,
  git_sha: gitSha,
  artifact,
  sha256,
  verified_locally: true,
  remote_effects: false,
};
fs.writeFileSync(receipt, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
  log "$surface: receipt $receipt"
  log "$surface: artifact SHA-256 $digest"
}

release_gateway() {
  require_clean_paths gateway docker-compose.yml docker-compose.vps.yml scripts/vps
  log "gateway: running local verification"
  bash -n "$ROOT_DIR"/scripts/vps/*.sh
  bash "$ROOT_DIR/scripts/vps/test-node-runtime.sh"
  bash "$ROOT_DIR/scripts/vps/test-preview-tls-proxy.sh"
  bash "$ROOT_DIR/scripts/vps/test-install-promotion-control-plane.sh"
  bash "$ROOT_DIR/scripts/vps/test-install-release-control-database-credentials.sh"
  bash "$ROOT_DIR/scripts/vps/test-install-auto-update.sh"
  bash "$ROOT_DIR/scripts/vps/test-auto-update.sh"
  bash "$ROOT_DIR/scripts/vps/test-update-rollback.sh"
  bash "$ROOT_DIR/scripts/vps/test-wait-for-live-commit.sh"
  (cd "$ROOT_DIR/gateway" && corepack pnpm install --frozen-lockfile && corepack pnpm run check)

  local archive="$RECEIPT_DIR/gateway-${HEAD_SHA}.tar"
  git -C "$ROOT_DIR" archive --format=tar --output="$archive" HEAD -- \
    gateway docker-compose.yml docker-compose.vps.yml scripts/vps
  write_receipt gateway "$archive" "$(sha256_file "$archive")"
}

release_android() {
  require_clean_paths android_app gateway/lib/android-ota.js scripts/deploy-targets.json
  log "android: running lint, unit tests, package build, and OTA safety tests"
  (
    cd "$ROOT_DIR/android_app"
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
      ./gradlew check assembleDebug
  )
  bash "$ROOT_DIR/android_app/deploy/ota/test-sync-vps.sh"
  GITHUB_SHA="$HEAD_SHA" \
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
    bash "$ROOT_DIR/android_app/deploy/ota/build-ota-artifact.sh"

  local ota_dir="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
  local manifest="$ota_dir/latest.json"
  local apk="$ota_dir/moa-assistant.apk"
  [ -f "$manifest" ] && [ -f "$apk" ] || fail "Android OTA artifact is incomplete"
  local expected actual
  expected="$(node -e 'console.log(require(process.argv[1]).sha256)' "$manifest")"
  actual="$(sha256_file "$apk")"
  [ "$expected" = "$actual" ] || fail "Android OTA manifest digest does not match APK bytes"

  local apksigner expected_signer actual_signer
  apksigner="$(find "${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools" -type f -name apksigner | sort -V | tail -n 1)"
  [ -n "$apksigner" ] || fail "Android apksigner was not found"
  "$apksigner" verify "$apk"
  actual_signer="$("$apksigner" verify --print-certs "$apk" \
    | awk -F': ' '/certificate SHA-256 digest/ {print $2; exit}' \
    | tr -d ':' | tr '[:upper:]' '[:lower:]')"
  expected_signer="$(node -e '
    const value = require(process.argv[1]).production.android_signer_sha256;
    if (!/^[0-9a-fA-F]{64}$/.test(value || "")) process.exit(1);
    process.stdout.write(value.toLowerCase());
  ' "$ROOT_DIR/scripts/deploy-targets.json")"
  [ "$actual_signer" = "$expected_signer" ] \
    || fail "Android APK signer does not match the configured continuity certificate"
  local immutable_apk="$RECEIPT_DIR/android-${HEAD_SHA}.apk"
  cp "$apk" "$immutable_apk"
  chmod 600 "$immutable_apk"
  [ "$(sha256_file "$immutable_apk")" = "$actual" ] \
    || fail "immutable Android artifact copy changed"
  write_receipt android "$immutable_apk" "$actual"
}

release_extension() {
  require_clean_paths browser_extension
  local base="${MOA_RELEASE_BASE_REF:-}"
  if [ -n "$base" ] && git -C "$ROOT_DIR" cat-file -e "$base^{commit}" 2>/dev/null \
    && ! git -C "$ROOT_DIR" diff --quiet "$base" HEAD -- browser_extension/extension; then
    local current_version previous_version
    current_version="$(node -p "require('$ROOT_DIR/browser_extension/extension/manifest.json').version")"
    previous_version="$(git -C "$ROOT_DIR" show "$base:browser_extension/extension/manifest.json" \
      | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).version))')"
    [ "$current_version" != "$previous_version" ] \
      || fail "extension sources changed without a manifest version bump ($current_version)"
  fi
  log "extension: running verification, smoke, and package"
  (cd "$ROOT_DIR/browser_extension" && npm run verify && npm run smoke && npm run package)
  local version archive digest immutable_archive
  version="$(node -p "require('$ROOT_DIR/browser_extension/extension/manifest.json').version")"
  archive="$(find "$ROOT_DIR/browser_extension/dist" -maxdepth 1 -type f -name "*-${version}.zip" -print -quit)"
  [ -n "$archive" ] || fail "extension package for version $version was not found"
  digest="$(sha256_file "$archive")"
  immutable_archive="$RECEIPT_DIR/extension-${HEAD_SHA}.zip"
  cp "$archive" "$immutable_archive"
  chmod 600 "$immutable_archive"
  [ "$(sha256_file "$immutable_archive")" = "$digest" ] \
    || fail "immutable extension artifact copy changed"
  write_receipt extension "$immutable_archive" "$digest"
}

release_macos() {
  require_clean_paths apple_surfaces
  log "macos: running tests and packaging QA app"
  (
    cd "$ROOT_DIR/apple_surfaces"
    swift test
    swift build --product Ag
    bash scripts/package-ag-mac.sh
  )
  local version build architectures archive
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT_DIR/apple_surfaces/Resources/Info.plist")"
  build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ROOT_DIR/apple_surfaces/Resources/Info.plist")"
  architectures="$(lipo -archs "$ROOT_DIR/apple_surfaces/dist/Ag.app/Contents/MacOS/Ag" | tr ' ' '-')"
  archive="$ROOT_DIR/apple_surfaces/dist/Ag-${version}-${build}-${architectures}.zip"
  [ -n "$archive" ] || fail "macOS QA archive was not found"
  local digest immutable_archive="$RECEIPT_DIR/macos-${HEAD_SHA}.zip"
  digest="$(sha256_file "$archive")"
  cp "$archive" "$immutable_archive"
  chmod 600 "$immutable_archive"
  [ "$(sha256_file "$immutable_archive")" = "$digest" ] \
    || fail "immutable macOS artifact copy changed"
  write_receipt macos "$immutable_archive" "$digest"
}

node "$ROOT_DIR/scripts/source-size-policy.js"

case "$TARGET" in
  gateway) release_gateway ;;
  android) release_android ;;
  extension) release_extension ;;
  macos) release_macos ;;
  all)
    release_gateway
    release_android
    release_extension
    release_macos
    ;;
  *) fail "usage: scripts/release/local-release.sh [gateway|android|extension|macos|all]" ;;
esac
