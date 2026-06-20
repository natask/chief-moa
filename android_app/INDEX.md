# Moa Android App Index

The Android app lives here: `android_app`.

## What This App Is

Moa is a native Android overlay assistant. It places a draggable orb above the
current phone screen, captures speech with Android `SpeechRecognizer`, shows a
live transcript overlay, sends completed turns to `gateway`, and
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
2. Grant overlay permission.
3. Grant microphone permission.
4. Save the gateway URL and token.
5. Tap `Start assistant circle`.
6. Leave the app and use the floating orb.

## Gateway Setup

```sh
cd ../gateway
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
this Mac's current ZeroTier address. Use `http://10.147.17.10:8787` when the
main-machine gateway is online.

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
- Single tap while idle: start listening.
- Single tap while listening: submit the current transcript and start a fresh
  listening loop.
- Double tap: stop listening and stop speech output without sending a reply.
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
