# Moa Android Assistant

Android-first Moa assistant prototype. It is a native app that launches a floating animated circle over the phone screen. Press the circle or mic button to start one explicit voice turn, press again while listening to submit the current transcript, double tap to stop silently, or long press to open chat. Voice-originated replies can speak back with Android TextToSpeech.

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
2. Grant `Draw over other apps`.
3. Grant `Screen access` in Android accessibility settings if you want current-screen context and controlled actions.
4. Grant microphone access.
5. Set the Moa Gateway URL. The development default is `http://10.147.17.6:8787` for this Mac over ZeroTier. Use `http://10.147.17.10:8788` when the main-machine gateway is online.
6. Tap `Start assistant circle`.
7. Leave the app. The Moa circle stays over the screen.

## Assistant Orb

- Drag: move the orb.
- Single tap while idle: start one explicit voice turn.
- Single tap while listening: send the current transcript and start the next turn.
- Double tap: stop listening and speech without a confirmation reply.
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
- Local overlay commands: `/screen`, `/tap <visible label>`, `/back`, and `/home`.
- Spoken build/fix/change/test commands route to the home-machine Gemini harness through Moa Gateway.
- Android `TextToSpeech` voice replies.
- Self-hosted gateway replies with local fallback when the server is unavailable.

## Action Runtime

Moa's trust boundary is local-first: the self-hosted gateway may propose actions, but the Android app owns permissions, approval policy, execution, and audit receipts. See [ACTION_RUNTIME.md](ACTION_RUNTIME.md).

The current mobile architecture boundary is documented in [MOBILE_BOUNDARIES.md](MOBILE_BOUNDARIES.md): mobile UI/control plane, self-hosted execution machine, gateway authentication, and local/API action surfaces.

## Next Step

Use the accessibility snapshot to build explicit approval-gated tools for target apps, then replace Android `SpeechRecognizer` with a lower-level button-started audio capture and transcription path when raw audio upload or streaming is needed.
