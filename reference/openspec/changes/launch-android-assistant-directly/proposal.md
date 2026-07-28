## Why

The Android system assistant button and assist gesture are capture entry points,
not configuration entry points. Invoking A.G. should begin an agent voice turn
without opening the full control center or exposing settings through an overlay
tap. Settings remain available in the full app and should also be available as a
bounded local action when the user asks the agent to open them.

## What Changes

- Keep `MoaAssistActivity` as the exported receiver for Android `ASSIST`,
  `VOICE_ASSIST`, and `VOICE_COMMAND` intents.
- Route a permitted assist invocation directly to
  `OverlayService.ACTION_ASSIST_BUTTON`, which opens the orb and begins a
  continuous streaming voice turn.
- Route the normal launcher icon through the same thin assist activity. Keep the
  full control center available from the icon's long-press `Settings` shortcut.
- Show only a short permission hint when overlay or microphone permission is
  absent. The assist path does not open a setup or settings surface.
- Route taps on the ongoing overlay notification back into the assist/voice
  entry instead of opening the full app.
- Advertise and execute `app.settings.open` through Android's existing local
  capability, policy, execution, and receipt path. The action opens the existing
  full `MainActivity` control center and records a navigation receipt.
- Keep settings available when the user launches the full app normally.

## Trust Boundary

The gateway or model may only propose `app.settings.open`. Android advertises
the capability, validates the claimed tool locally, launches its own activity,
and creates the local hash-chained receipt. Server output never directly starts
an Android activity.

## Acceptance

- A system assist, voice-assist, or voice-command invocation with required
  permissions starts the overlay voice turn without showing `MainActivity`.
- Missing permissions produce a hint without opening settings.
- No tap in the orb, chat/voice card, or ongoing overlay notification opens the
  settings/control-center surface.
- A claimed `app.settings.open` request opens the existing full app and returns
  a local receipt naming the tool, navigation risk, implicit user-command
  approval, app target, result, timestamp, and previous receipt hash.
- Tapping the launcher icon starts the companion voice overlay; long-pressing it
  exposes the full-app `Settings` shortcut.

## Verification

- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest`
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
