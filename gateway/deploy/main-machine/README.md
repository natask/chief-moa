# Main-Machine Gateway Setup

This is the remote payload for `reclaim@10.147.17.10`. It makes the gateway run
as a normal Node service on port `8787` so Android and browser clients can
connect to:

```text
http://10.147.17.10:8787
ws://10.147.17.10:8787/v1/voice/sessions
```

## What Goes On The Server

Remote project path:

```text
/home/reclaim-ethiopia/moa-assistant/gateway
```

Files that must be present there:

```text
server.js
package.json
package-lock.json
lib/voice-session-server.js
lib/voice-providers.js
public/gateway-ui.html
.env
```

Persistent data should live outside the deploy copy:

```text
/home/reclaim-ethiopia/moa-assistant-data/moa_gateway
```

Android OTA artifacts are served from:

```text
/home/reclaim-ethiopia/moa-assistant-data/moa_gateway/android-ota
```

## First Transport-Only Run

Start with `VOICE_PROVIDER=loopback`. That proves:

1. Android opens the WebSocket.
2. Android streams PCM16 microphone audio.
3. Gateway stores the audio.
4. Android sends `commit_turn`.
5. Gateway sends a fake transcript and PCM test tone.
6. Android plays the returned audio.

Real Gemini Live audio should be enabled only after that loop works.

## Install

```sh
cd /home/reclaim-ethiopia/moa-assistant/gateway
npm ci
cp deploy/main-machine/env.example .env
# Edit .env and set MOA_GATEWAY_TOKEN.
npm run check
```

## Run Directly

```sh
cd /home/reclaim-ethiopia/moa-assistant/gateway
npm start
```

## Run With systemd

```sh
sudo cp deploy/main-machine/moa-gateway.service /etc/systemd/system/moa-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now moa-gateway.service
sudo systemctl status moa-gateway.service --no-pager
```

If Node is installed through `nvm`, replace the unit's `ExecStart` with the full
path from:

```sh
command -v node
```

## Smoke Tests

From the main machine:

```sh
curl -fsS http://127.0.0.1:8787/health
node deploy/main-machine/smoke-voice-session.js ws://127.0.0.1:8787/v1/voice/sessions "$MOA_GATEWAY_TOKEN"
```

From this Mac after ZeroTier works:

```sh
curl -fsS http://10.147.17.10:8787/health
node gateway/deploy/main-machine/smoke-voice-session.js ws://10.147.17.10:8787/v1/voice/sessions "$MOA_GATEWAY_TOKEN"
```

Protected OTA + Gemini Live smoke from this repo:

```sh
cd gateway
MOA_GATEWAY_TOKEN=<token> npm run smoke:main-machine -- http://10.147.17.10:8787
```

Success means the WebSocket emits `session_ready`, `transcript_final`,
`assistant_audio_start`, binary audio, `assistant_audio_done`, and `turn_done`.

## Android OTA Updates

The gateway serves the latest Android APK metadata and APK through token-protected
endpoints:

```text
GET /v1/android/updates/latest
GET /v1/android/updates/latest.apk
```

Build and sync an OTA artifact from this Mac:

```sh
cd /Users/natnaelkahssay/projs/chief-moa
version_code=$(date +%s)
MOA_ANDROID_VERSION_CODE=$version_code \
MOA_ANDROID_VERSION_NAME=0.1.$version_code \
android_app/deploy/ota/sync-main-machine.sh
```

For automatic deploys, configure the GitHub Actions secrets
`MOA_MAIN_MACHINE_SSH_KEY`, `MOA_ANDROID_KEYSTORE_B64`,
`MOA_ANDROID_KEYSTORE_PASSWORD`, `MOA_ANDROID_KEY_ALIAS`, and
`MOA_ANDROID_KEY_PASSWORD`. The app downloads the APK through the gateway token,
verifies size and SHA-256 from `latest.json`, then opens Android's package
installer for local approval.

## Real Audio Provider

After loopback works, switch `.env` to:

```env
VOICE_PROVIDER=gemini-live
GEMINI_API_KEY=...
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
```

Then restart:

```sh
sudo systemctl restart moa-gateway.service
```
