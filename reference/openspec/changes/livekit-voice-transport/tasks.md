## 1. Gateway token endpoint + internal voice hooks (env-gated)

- [x] 1.1 Add `lib/livekit-transport.js`: config gate, room naming, room-token
      minting via `livekit-server-sdk` (lazy-required).
- [x] 1.2 `POST /v1/voice/livekit/token` (same auth as peers): 503 not_configured
      when unset; mints a short-lived room token honoring `branch_id` / active
      thread; returns `LIVEKIT_URL`.
- [x] 1.3 `POST /v1/internal/voice/reason` (wraps `runCascadedVoiceReasoning`,
      source `voice-livekit`), `POST /v1/internal/voice/synthesize` (wraps the
      active provider's `synthesizeSpeech`, PCM16@16k octet-stream + headers,
      501 when the provider has no hosted TTS leg), `POST /v1/internal/voice/
      turn-record` (wraps `recordStreamingVoiceTurn`). Same `LIVEKIT_*` env gate.
- [x] 1.4 `/health` gains `livekit_voice`.
- [x] 1.5 `scripts/smoke-livekit-transport.js` (token 503/shape + reason/
      synthesize/turn-record round trip), wired into `npm run check`.

## 2. LiveKit agents worker package (livekit_worker/)

- [x] 2.1 `src/plugins/chirp-stt.ts`: custom STT over Speech-to-Text v2 (explicit
      LINEAR16, languageCodes pinned, ADC auth), mirroring the gateway's Chirp.
- [x] 2.2 `src/plugins/gateway-llm.ts`: LLM plugin calling `/v1/internal/voice/reason`.
- [x] 2.3 `src/plugins/gateway-tts.ts`: TTS plugin calling `/v1/internal/voice/synthesize`.
- [x] 2.4 `src/agent.ts`: AgentSession wiring (Silero VAD, default VAD endpointing,
      manual PTT available, `lk.agent.state` free, turn-record on completion).
- [x] 2.5 `README.md`: run the spike, what to measure, am-ET plan, API-surface
      deltas. `npm run build` (tsc) green; `npm test` green.

## 3. Extension flag-gated LiveKit client path

- [x] 3.1 Settings flag `ageeLivekitVoiceEnabled` (default OFF) + options toggle.
- [x] 3.2 `livekit-voice.js` + `offscreen-livekit.{html,js}` + vendored
      `livekit-client`: token mint, offscreen WebRTC connect, mic publish with
      `preConnectBuffer:true`, agent-audio subscribe, `lk.agent.state` ->
      setAgentState.
- [x] 3.3 Fall back to the WS path with a visible notice on any error.
- [x] 3.4 `verify-extension.mjs` pins the flag default OFF. `npm run verify` +
      `npm run smoke` green (WS path).

## 4. Docs

- [x] 4.1 Add this OpenSpec change.
- [x] 4.2 Add a "LiveKit prototype (flag-gated)" subsection to `ARCHITECTURE.md`'s
      voice section stating the default pipeline is unchanged.

## 5. Verification / deploy

- [x] 5.1 `gateway npm run check` green; `livekit_worker` tsc green; extension
      verify + smoke green.
- [ ] 5.2 Live end-to-end run against LiveKit Cloud is NOT verified here: it needs
      real `LIVEKIT_*` creds, the `@livekit/rtc-node` native binary, and gateway +
      Chirp credentials. Latency / pre-connect-buffer / agent-state measurements
      are the follow-up.
- [ ] 5.3 Live cutover is NOT decided; promotion of any default change is gated on
      the measurements and an explicit user decision.
