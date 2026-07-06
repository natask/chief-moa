## Why

The current browser/phone voice path streams PCM over a gateway WebSocket
(`/v1/voice/sessions`). We want to measure whether a WebRTC transport
(LiveKit) gives lower turn latency and a cleaner start-of-utterance capture
(pre-connect audio buffer) and agent-state signaling than the hand-rolled WS
pipeline, without giving up gateway ownership of reasoning, TTS, turn records,
threads, incognito, and the tool loop. This is a measurement prototype, not a
cutover: the live cascaded WS pipeline stays the untouched default behind env
and settings flags.

## Decision facts (settled)

- TS-native `@livekit/agents` (agents-js, installed 1.5.0) is chosen over
  Pipecat (Python-only) and Vocode (stale), and over realtime single-model APIs
  (OpenAI/Gemini Realtime), because we must host our own Chirp STT + hosted TTS
  legs and keep the gateway as the reasoning owner — a single-model realtime API
  cannot host the Chirp + Gemini-TTS split.
- The production droplet CANNOT host the LiveKit SFU (1 vCPU, no spare core, no
  UDP surface, firewall in the DO control plane). The spike targets LiveKit
  Cloud (or any external LiveKit server) via `LIVEKIT_URL` +
  `LIVEKIT_API_KEY`/`SECRET`.
- Integration is Option A: the gateway mints room tokens; a standalone Node
  agents worker joins rooms and drives STT -> the gateway's existing reasoning
  -> the gateway's existing TTS, so turn records, threads, incognito, and the
  tool loop stay gateway-owned and byte-identical.
- A custom Chirp STT plugin is required: the Node `@livekit/agents` Google
  plugin has Gemini LLM + beta Gemini TTS but NO Google Cloud STT (Chirp).
- The pre-connect audio buffer (`preConnectBuffer`) and the `lk.agent.state`
  participant attribute are the two features being measured.
- Live cutover is NOT decided. Everything ships behind flags; the default WS
  pipeline is unchanged.

## What Changes

- Gateway (env-gated on `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`,
  503 when unset):
  - `POST /v1/voice/livekit/token` mints a short-lived room token for room
    `moa-{session_id}-{branch_id}`, identity = device/client id, and returns
    `LIVEKIT_URL`. Honors an explicit `branch_id` or the session's active thread.
  - `POST /v1/internal/voice/reason` wraps `runCascadedVoiceReasoning`
    (source `voice-livekit`); `POST /v1/internal/voice/synthesize` wraps the
    active provider's `synthesizeSpeech` returning PCM16@16k as
    `application/octet-stream`; `POST /v1/internal/voice/turn-record` persists a
    completed turn through the same `recordStreamingVoiceTurn` path.
  - `/health` gains `livekit_voice` for runtime detection.
- A standalone `livekit_worker/` TypeScript package (its own `package.json`, NOT
  in the gateway deps): a custom Chirp STT plugin, a gateway-LLM plugin, a
  gateway-TTS plugin, and the `AgentSession` wiring (Silero VAD, default VAD
  endpointing with manual PTT available, `lk.agent.state` published free, and
  turn-record on completion).
- Browser extension: a settings flag `ageeLivekitVoiceEnabled` (default OFF).
  When on, voice start mints a LiveKit token, connects through an offscreen
  WebRTC document with the vendored `livekit-client`, publishes the mic with
  `preConnectBuffer:true`, subscribes to agent audio, and maps `lk.agent.state`
  onto the existing mark states. Any error falls back to the WS path with a
  visible notice.

## Boundaries

- Clients hold only a gateway URL + token; a room token is the same short-lived
  credential posture as the browser voice ticket. Android/browser store no raw
  provider keys.
- The gateway stays the single owner of reasoning, TTS, turn records, threads,
  incognito, and the tool loop. The worker is transport + plugins only.
- The default cascaded WS pipeline is unchanged: the gateway routes are inert
  unless the `LIVEKIT_*` env is set, and the extension flag is OFF by default so
  verify/smoke stay on the WS path.
- The worker's credentials never mount into the VPS gateway; it runs on an
  external execution machine, matching the worker-pull posture.

## Verification

- `cd gateway && npm run check` (adds `smoke-livekit-transport`: token
  503-when-unconfigured + shape-when-configured with fake env; reason/synthesize/
  turn-record round trip with a stubbed model fallback + Cloud TTS endpoint).
- `cd livekit_worker && npm run build` (tsc) + `npm test` (pure config unit test).
- `cd browser_extension && npm run verify && npm run smoke` (flag OFF; WS path).
