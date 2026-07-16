# Android Surface-Program Fixture Evidence

## Candidate scope

The Android fixture lane is deliberately synthetic and debug-only:

- `MoaProgramRuntimeServiceInstrumentationTest` binds the real non-exported,
  isolated `:moa_program_runtime` service and uses its package-private Messenger
  constants. It starts a permanently blocked generated worker, proves a
  client-main-loop watchdog callback can replace it, proves the replacement
  finishes, and is intended to prove stale nonce/generation START, STOP, and
  RESPONSE messages cannot replace, terminate, or resolve the successor.
- `MoaAccessibilityFixtureActivity` exists only in the debug source set. It
  contains deterministic synthetic labels, a click counter, a real scroll
  container, a password field whose fixture value must be redacted, and a
  semantic-tree drift control. It contains no page capture, account data,
  contacts, browser data, or user text.
- `MoaAccessibilityProgramAdapterInstrumentationTest` observes and acts only on
  that fixture. It checks redaction, click, scroll, and rejection of an action
  bound before semantic drift.

The production coordinator watchdog remains covered by focused JVM tests. Once
task 12.4 passes, this instrumentation lane will add the missing real Binder,
isolated service, WebView, renderer, and Android Accessibility evidence; it does
not replace the JVM contract/coverage gate.

## Current evidence and blocker (2026-07-16)

- `git diff --check` passed after adding the fixture source.
- No Gradle build, emulator, ADB, install, Accessibility service, browser, or
  live-device command was run for this lane.
- Compilation and runtime QA are blocked on this host: the data volume had only
  about 178 MiB free during the source review, and the Android SDK has no
  installed emulator system image. Creating Gradle intermediates or downloading
  an image under that condition risks unrelated active work.
- Therefore this note is source evidence only. It is not an APK, install,
  runtime, release, or promotion claim.

## Exact future dedicated-emulator procedure

Run this only after freeing sufficient disposable build space. It creates and
wipes a dedicated AVD; it does not use a personal phone or existing AVD.

```sh
cd android_app
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
case "$(uname -m)" in
  arm64|aarch64) MOA_EMULATOR_ABI=arm64-v8a ;;
  x86_64) MOA_EMULATOR_ABI=x86_64 ;;
  *) echo "Unsupported emulator host architecture" >&2; exit 1 ;;
esac
MOA_SYSTEM_IMAGE="system-images;android-35;google_apis;$MOA_EMULATOR_ABI"

"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  "platform-tools" "emulator" "platforms;android-35" \
  "$MOA_SYSTEM_IMAGE"

printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --force \
  --name moa-surface-program-fixture-api35 \
  --package "$MOA_SYSTEM_IMAGE" \
  --device pixel_6

"$ANDROID_HOME/emulator/emulator" \
  -avd moa-surface-program-fixture-api35 \
  -wipe-data -no-snapshot -no-window -no-audio -no-boot-anim &

"$ANDROID_HOME/platform-tools/adb" wait-for-device
until [ "$("$ANDROID_HOME/platform-tools/adb" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do
  sleep 1
done

./gradlew --no-daemon assembleDebugAndroidTest
"$ANDROID_HOME/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
"$ANDROID_HOME/platform-tools/adb" install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$ANDROID_HOME/platform-tools/adb" shell settings put secure enabled_accessibility_services \
  ai.moa.assistant/ai.moa.assistant.MoaAccessibilityService
"$ANDROID_HOME/platform-tools/adb" shell settings put secure accessibility_enabled 1

"$ANDROID_HOME/platform-tools/adb" shell am instrument -w \
  -e class ai.moa.assistant.MoaProgramRuntimeServiceInstrumentationTest,ai.moa.assistant.MoaAccessibilityProgramAdapterInstrumentationTest \
  ai.moa.assistant.test/androidx.test.runner.AndroidJUnitRunner
```

Passing evidence must retain the exact command output, emulator API/ABI, APK
hashes, and final instrumentation result. Delete the dedicated AVD after
evidence capture if it is no longer needed.
