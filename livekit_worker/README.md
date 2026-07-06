# Moa LiveKit worker (flag-gated spike)

A standalone `@livekit/agents` (agents-js) worker for the Moa voice-transport
spike. It joins gateway-minted LiveKit rooms and drives:

```
Chirp 3 STT  ->  gateway reasoning (/v1/internal/voice/reason)
             ->  gateway TTS       (/v1/internal/voice/synthesize)
             ->  gateway turn record (/v1/internal/voice/turn-record)
```

This is Option A: the gateway stays the single owner of reasoning, TTS, turn
records, threads, incognito, and the tool loop, so a LiveKit turn is
byte-identical to the existing cascaded WS turn. The worker is only transport +
the three custom plugins. It is separate from the gateway (its own
`package.json`; it is NOT in the gateway's dependencies) and it is a measurement
prototype: nothing here is on the default voice path, and live cutover is not
decided.

## Why a custom Chirp STT plugin

The Node `@livekit/agents` Google plugin has Gemini LLM + beta Gemini TTS but
**no Google Cloud Speech (Chirp) STT**. Our languages (en-US, am-ET) need Chirp,
so `src/plugins/chirp-stt.ts` implements Speech-to-Text v2 with the same request
shape the gateway's `gateway/lib/voice-providers.js` uses: explicit LINEAR16
decoding and `languageCodes` pinned from config (primary + at most one
alternate). Language is **never auto-detected**. am-ET has no turn-detector
model, so turn detection falls back to VAD (Silero) endpointing; the plugin
already pins the languages, so am-ET works through the same path.

## Prerequisites

- A LiveKit server. The production droplet CANNOT host the LiveKit SFU (1 vCPU,
  no spare core, no UDP surface, firewall in the DO control plane), so use
  **LiveKit Cloud** (create a project at cloud.livekit.io) or any external
  LiveKit server. You get `LIVEKIT_URL` (wss://…), `LIVEKIT_API_KEY`, and
  `LIVEKIT_API_SECRET`.
- A running Moa gateway with the same `LIVEKIT_*` env set (so its
  `/v1/voice/livekit/token` + `/v1/internal/voice/*` hooks are live) and a
  cascaded voice provider configured (`VOICE_PROVIDER=chirp` +
  `VOICE_TTS_PROVIDER=cloud-tts` or `gemini-tts`) so the synthesize hook has a
  hosted TTS leg.
- Google Cloud credentials for Chirp: `GOOGLE_APPLICATION_CREDENTIALS` pointing
  at a service-account or authorized_user JSON, or a static `CHIRP_ACCESS_TOKEN`.

## Env

| Var | Meaning |
| --- | --- |
| `LIVEKIT_URL` | wss URL of the LiveKit server/cloud project (read by agents-js). |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit credentials (read by agents-js). |
| `MOA_GATEWAY_URL` | Base URL of the Moa gateway, e.g. `https://api.agee.app`. |
| `MOA_GATEWAY_TOKEN` | Bearer token for the gateway `/v1/internal/voice/*` hooks. |
| `MOA_LIVEKIT_LANGS` | Comma list of pinned STT languages (default `en-US`; capped to 2). |
| `GCP_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` | Chirp project id. |
| `CHIRP_LOCATION` | Speech v2 location (default `us`). |
| `CHIRP_MODEL` | Recognizer model (default `chirp_3`; am-ET requires `chirp_3`). |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC JSON path (service_account or authorized_user). |
| `CHIRP_ACCESS_TOKEN` / `GCP_ACCESS_TOKEN` | Optional static OAuth token (skips the ADC exchange). |

## Run the spike

```sh
cd livekit_worker
pnpm install          # or npm install
npm run build         # tsc -> dist/  (this is the package's verification bar)
npm start             # node dist/agent.js start   (dev: npm run dev)
```

Then have a client mint a room token and join:

```sh
# from any authenticated client (the browser extension's experimental LiveKit
# mode does this automatically):
curl -sX POST "$MOA_GATEWAY_URL/v1/voice/livekit/token" \
  -H "authorization: Bearer $MOA_GATEWAY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"session_id":"sess-demo","branch_id":"default","device_id":"laptop"}'
# -> { url, token, room: "moa-sess-demo-default", ... }
```

The worker is dispatched into the room, runs STT -> gateway -> TTS, publishes
`lk.agent.state` (thinking/speaking) automatically, and records the turn.

## What to measure

- **TTFB / turn latency** vs the current WS cascaded pipeline: time from
  end-of-user-speech to first assistant audio frame. Compare against the gateway
  WS path (`/v1/voice/sessions`) for the same utterance.
- **Pre-connect audio buffer**: the client publishes mic with
  `preConnectBuffer:true` so the start of the utterance is captured before the
  room is fully joined. Measure how much leading audio the WS path drops vs the
  LiveKit path.
- **`lk.agent.state`**: the participant attribute AgentSession publishes for
  free (thinking/speaking) vs the WS pipeline's hand-rolled `turn_progress`
  keepalive.

## API-surface deltas (installed @livekit/agents 1.5.0 vs the plan)

The plan described agents-js ~1.4.x; the installed `latest` is **1.5.0**. Deltas
found against the INSTALLED types and adapted to:

- **Chirp STT is batch-per-utterance, not true bidi streaming.** The STT base
  exposes a streaming `SpeechStream`, but Speech-to-Text v2 real bidi
  `streamingRecognize` is gRPC-only. This plugin buffers each VAD-segmented
  utterance (the framework flushes the stream at end-of-speech) and calls the
  batch `:recognize` REST endpoint — the gateway's proven request shape — then
  emits one `FINAL_TRANSCRIPT` per segment. Swapping in bidi `streamingRecognize`
  (a gRPC client) is the follow-up; interim transcripts are off until then.
- **Worker options class was renamed.** The docs reference `WorkerOptions`; in
  1.5.0 it is `ServerOptions` (with `WorkerOptions` kept as a deprecated alias).
  This worker uses `ServerOptions`.
- **VAD is auto-provisioned.** `AgentSession` auto-provisions a bundled Silero
  VAD when none is passed; we still load it explicitly in `prewarm` (the
  documented pattern) and pass it in.
- **`turnDetection` is deprecated on `AgentSessionOptions`** in favor of
  `turnHandling.turnDetection`, but the flat `turnDetection: 'vad'` still works
  and is used here. `'manual'` + `commitUserTurn()` / `clearUserTurn()` is the
  push-to-talk path and remains available.
- **Expressive-TTS split is best-effort.** The gateway reason hook returns
  `tts_text` / `tts_style` for the Gemini-TTS expressive leg. The plugins share
  a per-turn state object so the TTS plugin can forward those to the synthesize
  hook when the spoken text matches the reply; if the pipeline ever splits the
  reply across TTS segments the style may not apply to every segment.

## Could NOT be verified here

- **Live end-to-end run.** `@livekit/rtc-node`'s native binary is not present in
  this checkout (its postinstall native download did not run), so the worker was
  type-checked and unit-tested but not run against a live LiveKit room. Running
  the spike needs a normal `pnpm install` with network (to fetch the rtc-node
  prebuilt binary) plus real `LIVEKIT_*` + gateway + Chirp credentials.
- Latency numbers, pre-connect buffer behavior, and `lk.agent.state` timing are
  the measurements this prototype exists to gather once those creds are wired.

## Verification

```sh
npm run build   # tsc must pass — this is the bar for this package
npm test        # node --test dist/**/*.test.js (pure config unit test)
```
