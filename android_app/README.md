# Moa Android Assistant

Android-first Moa assistant prototype. It is a native app that launches a floating animated circle over the phone screen. Double-tap the circle to start a continuous voice loop: speak, pause, hear the reply, and keep talking. Tap while it is listening to send the current speech immediately; tap while it is thinking or speaking to stop/collapse the active voice surface. Voice-originated replies can speak back with Android TextToSpeech.

## Build

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

## Install

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Run

1. Open Aggie on the phone.
2. Grant `Draw over other apps`. The setup screen opens Aggie's overlay permission page; Android requires you to allow it there.
3. Grant microphone access when Android prompts, or tap `Enable microphone`.
4. Grant `Screen access` in Android accessibility settings for current-screen context and controlled actions. If Android blocks the toggle with restricted settings, open App info for Aggie, tap the three-dot menu, choose `Allow restricted settings`, return, then enable Screen access.
5. Set the Moa Gateway URL. The development default is `http://10.147.17.6:8787` for this Mac over ZeroTier. Use `http://10.147.17.10:8788` when the main-machine gateway is online.
6. Tap `Start assistant circle`.
7. Leave the app. The Moa circle stays over the screen.

The setup screen lists every missing requirement. Aggie can request microphone
permission and open the exact Android settings pages, but it cannot silently
grant overlay or Accessibility access.

## Assistant Orb

- Drag: move the orb.
- Single tap: type while idle, send the current speech while listening, or stop/collapse the active voice surface while thinking/speaking.
- Double tap: start the continuous voice loop.
- Long press: send a spoken follow-up to the active agent run; if no run is active, open or minimize the chat panel.

## Gateway

The Android app talks to `software/moa_gateway` instead of putting provider keys on the phone. The gateway saves conversations in its `DATA_DIR` and forwards model calls to OpenAI, LiteLLM, or Ollama.

```sh
cd ../moa_gateway
cp .env.example .env
# Edit .env and set MODEL_API_KEY or point MODEL_BASE_URL at LiteLLM/Ollama.
npm start
```

## Current Scope

- Native Android app surface.
- `SYSTEM_ALERT_WINDOW` overlay service.
- Animated draggable assistant circle.
- Google/Gemini-style live transcript overlay while speaking.
- Bottom live dock with screen-context, agent-run, mic, and close controls.
- Overlay chat panel with text input.
- Android `SpeechRecognizer` mic input.
- Android `AccessibilityService` screen context for visible text/buttons.
- Local overlay commands: `/screen`, `/tap <visible label>`, `/back`, `/home`, and `/open app <name>`.
- Spoken build/fix/change/test commands route to the home-machine Gemini harness through Moa Gateway.
- Android `TextToSpeech` voice replies.
- Self-hosted gateway replies with local fallback when the server is unavailable.

## Deploy

Repo-level Android deploy keeps publishing the OTA artifact and also installs
the same APK directly over ADB when an authorized device is connected:

```sh
bash ../scripts/deploy.sh android
```

If no ADB device is connected or authorized, deploy logs that direct install was
skipped and leaves the OTA artifact available through the gateway.

## Action Runtime

Moa's trust boundary is local-first: the self-hosted gateway may propose actions, but the Android app owns permissions, approval policy, execution, and audit receipts. See [ACTION_RUNTIME.md](ACTION_RUNTIME.md).

The current mobile architecture boundary is documented in [MOBILE_BOUNDARIES.md](MOBILE_BOUNDARIES.md): mobile UI/control plane, self-hosted execution machine, gateway authentication, and local/API action surfaces.

## Next Step

Use the accessibility snapshot to build explicit approval-gated tools for target apps, then replace Android `SpeechRecognizer` with a lower-level button-started audio capture and transcription path when raw audio upload or streaming is needed.
