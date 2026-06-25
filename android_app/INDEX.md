# Moa Android App Index

The Android app lives here: `software/android_app`.

## What This App Is

Moa is a native Android overlay assistant. It places a draggable orb above the
current phone screen, captures speech with Android `SpeechRecognizer`, shows a
live transcript overlay, sends completed turns to `software/moa_gateway`, and
can speak replies with Android `TextToSpeech`.

## Deploy To A Phone

```sh
cd android_app
./gradlew assembleDebug
adb devices
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

If `adb devices` does not show the phone:

- Enable Developer options on the phone.
- Enable USB debugging.
- Accept the USB debugging prompt on the phone.
- Re-run `adb devices`.

## First Run

1. Open `Moa`.
2. Grant overlay permission from Aggie's direct draw-over-apps settings button.
3. Grant microphone permission when prompted or from `Enable microphone`.
4. Grant Screen access in Accessibility settings when you want screen context.
   If Android says restricted settings are blocking it, open App info for
   Aggie, tap the three-dot menu, choose `Allow restricted settings`, return,
   then enable Screen access.
5. Save the gateway URL and token.
6. Tap `Start assistant circle`.
7. Leave the app and use the floating orb.

The setup screen lists missing requirements. The app can request microphone and
open settings; it cannot silently grant draw-over-apps or Accessibility access.

## Gateway Setup

```sh
cd ../moa_gateway
cp .env.example .env
npm start
```

Useful `.env` values:

```env
HOST=0.0.0.0
PORT=8787
MOA_GATEWAY_TOKEN=<long-random-token>
MODEL_API_KEY=<provider-key>
MODEL_ID=gpt-4o-mini
```

The Android app default gateway URL is `http://10.147.17.6:8787`, which is
this Mac's current ZeroTier address. Use `http://10.147.17.10:8788` when the
main-machine gateway is online.

## Repo Deploy

```sh
bash scripts/deploy.sh android
```

This builds the timestamp-versioned OTA APK, syncs it to the gateway, and then
installs `gateway/data/android-ota/moa-assistant.apk` over ADB when an
authorized phone is connected. If no authorized device is present, direct
install is skipped without failing deploy.

## Main Files

- `README.md`: short build/run overview.
- `INDEX.md`: this deploy and navigation map.
- `docs/voice-agent-router.md`: product behavior and next implementation plan.
- `app/src/main/java/ai/moa/assistant/MainActivity.java`: setup screen.
- `app/src/main/java/ai/moa/assistant/OverlayService.java`: overlay, voice,
  transcript, chat, TTS, gateway, and orb controls.
- `app/src/main/java/ai/moa/assistant/MoaPrefs.java`: saved gateway and voice
  settings.
- `app/src/main/res/drawable/ic_moa_orb.xml`: launcher icon.
- `app/src/main/res/xml/moa_accessibility_config.xml`: accessibility config.

## Assistant Orb Controls

- Drag: move the orb.
- Single tap: type, or stop/collapse the active voice surface.
- Double tap: start the continuous voice loop. Silence commits each turn and the
  mic re-arms after the reply.
- Long press: show or hide the chat panel.

## Current Server Shape

Normal voice turns go to `POST /v1/voice/turns`. The gateway returns separate
`speak` and `display` fields so the phone can keep TTS short while preserving a
fuller overlay/chat record.

Explicit agent work currently goes to `POST /v1/agent/runs`. The Android app
already supports this through text prefixes such as `/agent`, `/run`,
`agent run`, and `moa run`.

The server router now accepts normal spoken requests, decides whether the
request is chat or agent work, can start one or more agent runs, stores compact
voice-turn records, and returns short mobile-safe status updates.
