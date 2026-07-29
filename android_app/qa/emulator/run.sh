#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
API="${MOA_QA_API:-35}"
ABI="${MOA_QA_ABI:-arm64-v8a}"
IMAGE="system-images;android-${API};google_apis;${ABI}"
OUT="${MOA_QA_OUTPUT:-$ROOT_DIR/build/qa/emulator}"
AVD_HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/moa-avd.XXXXXX")"
AVD_NAME="moa-qa-${API}-${ABI}"
ADB="$SDK_ROOT/platform-tools/adb"
EMULATOR="$SDK_ROOT/emulator/emulator"
AVDMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
APKSIGNER="$SDK_ROOT/build-tools/35.0.0/apksigner"

fail_dependency() { printf 'BLOCKED missing_dependency=%s expected=%s\n' "$1" "$2" >&2; exit 2; }
for pair in "adb:$ADB" "emulator:$EMULATOR" "avdmanager:$AVDMANAGER" "apksigner:$APKSIGNER"; do
  name="${pair%%:*}"; path="${pair#*:}"; [ -x "$path" ] || fail_dependency "$name" "$path"
done
[ -f "$SDK_ROOT/system-images/android-${API}/google_apis/${ABI}/package.xml" ] || \
  fail_dependency "android_system_image" "$IMAGE (install with sdkmanager '$IMAGE')"

cleanup() {
  "$ADB" -s emulator-5554 emu kill >/dev/null 2>&1 || true
  [ -n "${EMU_PID:-}" ] && kill "$EMU_PID" >/dev/null 2>&1 || true
  rm -rf "$AVD_HOME_DIR"
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$OUT/device" "$OUT/apks"
cd "$ROOT_DIR"
ANDROID_HOME="$SDK_ROOT" ./gradlew assembleDebug assembleDebugAndroidTest
APP_APK="$ROOT_DIR/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="$ROOT_DIR/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$APP_APK" ] || fail_dependency "application_apk" "$APP_APK"
[ -f "$TEST_APK" ] || fail_dependency "test_apk" "$TEST_APK"
cp "$APP_APK" "$OUT/apks/application.apk"
cp "$TEST_APK" "$OUT/apks/test.apk"

export ANDROID_AVD_HOME="$AVD_HOME_DIR"
printf 'no\n' | "$AVDMANAGER" create avd --force --name "$AVD_NAME" --package "$IMAGE" --device pixel_6 >/dev/null
"$EMULATOR" -avd "$AVD_NAME" -port 5554 -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -no-snapshot -wipe-data >"$OUT/emulator.log" 2>&1 &
EMU_PID=$!
"$ADB" -s emulator-5554 wait-for-device
deadline=$((SECONDS + 180))
while [ "$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
  [ "$SECONDS" -lt "$deadline" ] || { echo 'BLOCKED emulator_boot_timeout=180s' >&2; exit 3; }
  sleep 2
done

"$ADB" -s emulator-5554 shell settings put system font_scale 1.0
"$ADB" -s emulator-5554 shell settings put system accelerometer_rotation 0
"$ADB" -s emulator-5554 shell settings put system user_rotation 0
"$ADB" -s emulator-5554 logcat -c
"$ADB" -s emulator-5554 shell rm -rf /sdcard/Download/moa-qa
"$ADB" -s emulator-5554 install -r "$OUT/apks/application.apk" >/dev/null
"$ADB" -s emulator-5554 install -r "$OUT/apks/test.apk" >/dev/null
"$ADB" -s emulator-5554 shell 'screenrecord --bit-rate 4000000 --time-limit 180 /sdcard/Download/moa-qa.mp4 >/dev/null 2>&1 &' || true

set +e
ANDROID_HOME="$SDK_ROOT" ANDROID_SERIAL=emulator-5554 \
  ./gradlew connectedDebugAndroidTest | tee "$OUT/instrumentation.txt"
TEST_STATUS=${PIPESTATUS[0]}
set -e
"$ADB" -s emulator-5554 shell pkill -INT screenrecord >/dev/null 2>&1 || true
sleep 2
"$ADB" -s emulator-5554 pull /sdcard/Download/moa-qa/. "$OUT/device/" >/dev/null 2>&1 || true
"$ADB" -s emulator-5554 pull /sdcard/Download/moa-qa.mp4 "$OUT/device/screenrecord.mp4" >/dev/null 2>&1 || true
"$ADB" -s emulator-5554 logcat -d > "$OUT/device/logcat.txt"
JUNIT_XML="$(find "$ROOT_DIR/app/build/outputs/androidTest-results/connected/debug" -name 'TEST-*.xml' -print -quit 2>/dev/null || true)"
[ -n "$JUNIT_XML" ] && cp "$JUNIT_XML" "$OUT/device/junit.xml"

node "$ROOT_DIR/qa/emulator/write-manifest.mjs" \
  --root "$OUT" --repo "$(git -C "$ROOT_DIR/.." rev-parse --show-toplevel)" \
  --apk "$OUT/apks/application.apk" --test-apk "$OUT/apks/test.apk" \
  --apksigner "$APKSIGNER" --adb "$ADB" --serial emulator-5554 \
  --image "$IMAGE" --preview "${MOA_QA_PREVIEW_NAMESPACE:-local-emulator}"
node "$ROOT_DIR/qa/emulator/verify-evidence.mjs" "$OUT/evidence-manifest.json"
[ "$TEST_STATUS" -eq 0 ] || { echo "BLOCKED scenario_exit=$TEST_STATUS evidence=$OUT" >&2; exit "$TEST_STATUS"; }
printf 'emulator_smoked evidence=%s/evidence-manifest.json\n' "$OUT"
