# Moa Android App Index

The Android app lives here: `android_app`.

## What This App Is

Moa is a native Android overlay assistant. It places a draggable orb above the
current phone screen, captures speech with Android `SpeechRecognizer`, shows a
live transcript overlay, sends completed turns to `gateway`, and
can speak replies with Android `TextToSpeech`.

## Deploy To A Phone

Open `https://api.agee.app/v1/android/updates/latest.apk` on the phone and
approve Android's package installer. An installed app checks the corresponding
OTA manifest and verifies the APK digest and signer before installer handoff.

## First Run

1. Open `Moa`.
2. Grant overlay permission from A.G.'s direct draw-over-apps settings button.
3. Grant microphone permission when prompted or from `Enable microphone`.
4. Grant Screen access in Accessibility settings when you want screen context.
   If Android says restricted settings are blocking it, open App info for
   A.G., tap the three-dot menu, choose `Allow restricted settings`, return,
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

The packaged default gateway URL comes from `MOA_DEFAULT_GATEWAY_URL` at build
time. Use `https://api.agee.app` for a VPS/mobile deployment. The legacy fallback
is `http://10.147.17.10:8787`; use `http://10.147.17.6:8787` only when
intentionally pointing the app at this Mac's local gateway over ZeroTier.

## Repo Deploy

```sh
bash scripts/deploy.sh android
```

This builds the timestamp-versioned OTA APK, syncs it to the gateway, and
publicly verifies the exact manifest and APK. It does not inspect or install to
connected devices.

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

- Single tap: open the chat menu.
- Click and hold while moving: reposition the orb without starting voice.
- Double-click and hold: start manual voice capture; release to send.

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
