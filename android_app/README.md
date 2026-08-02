# Moa Android Assistant

Android-first Moa assistant prototype. It is a native app that launches a floating animated circle over the phone screen. Single tap opens the chat menu. Press and drag moves the circle. Double-click and hold starts voice mode; release sends the captured speech immediately without waiting for silence detection. Voice-originated replies can speak back with Android TextToSpeech.

## Build

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

## Install

Open `https://api.agee.app/v1/android/updates/latest.apk` on the phone and
approve Android's package installer. Updates use the same in-app OTA flow and
continuity signer.

## Run

1. Open A.G. on the phone.
2. Grant `Draw over other apps`. The setup screen opens A.G.'s overlay permission page; Android requires you to allow it there.
3. Grant microphone access when Android prompts, or tap `Enable microphone`.
4. Grant `Screen access` in Android accessibility settings for current-screen context and controlled actions. If Android blocks the toggle with restricted settings, open App info for A.G., tap the three-dot menu, choose `Allow restricted settings`, return, then enable Screen access.
5. Set the Moa Gateway URL. VPS/mobile builds should use
   `https://api.agee.app`, either entered here or baked into the APK with
   `MOA_DEFAULT_GATEWAY_URL=https://api.agee.app`. Use `http://10.147.17.6:8787`
   only when you are intentionally pointing the app at this Mac's local gateway
   over ZeroTier.
6. Tap `Start assistant circle`.
7. Leave the app. The Moa circle stays over the screen.

The setup screen lists every missing requirement. A.G. can request microphone
permission and open the exact Android settings pages, but it cannot silently
grant overlay or Accessibility access.

## Assistant Orb

- Drag: move the orb.
- Single tap: open the chat menu for typed input.
- Click and hold while moving: reposition the orb without starting voice capture.
- Double-click and hold: start voice capture; release to send.

## Gateway

The Android app talks to `gateway` instead of putting provider keys on the phone. The gateway saves conversations in its `DATA_DIR` and forwards model calls to OpenAI, LiteLLM, or Ollama.

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

Repo-level Android deploy publishes and publicly verifies the OTA artifact:

```sh
bash ../scripts/deploy.sh android
```

It never inspects connected devices or installs the APK. The phone discovers
the release through the OTA manifest and Android owns installer approval.

## Action Runtime

Moa's trust boundary is local-first: the self-hosted gateway may propose actions, but the Android app owns permissions, approval policy, execution, and audit receipts. See [ACTION_RUNTIME.md](ACTION_RUNTIME.md).

The current mobile architecture boundary is documented in [MOBILE_BOUNDARIES.md](MOBILE_BOUNDARIES.md): mobile UI/control plane, self-hosted execution machine, gateway authentication, and local/API action surfaces.

## Next Step

Use the accessibility snapshot to build explicit approval-gated tools for target apps, then replace Android `SpeechRecognizer` with a lower-level button-started audio capture and transcription path when raw audio upload or streaming is needed.
