# Tasks

- [x] Profile store: add `speaking_rate` (clamped 0.5-2.0) and `voice_tone`
      (sanitized, reset words clear) to `PROFILE_FIELDS`, `pickProfileFields`,
      `normalizeProfile` (`gateway/lib/agent-profile.js`).
- [x] Gateway defaults: `VOICE_SPEAKING_RATE` (default 1.5) and `VOICE_TONE`
      env defaults into the profile store (`gateway/server.js`).
- [x] Provider: `speakingRate(profile)` / `voiceTone(profile)` precedence
      helpers, per-turn pinning next to the pinned voice, threading through
      the streaming pipeline and both non-streaming synthesis paths
      (`gateway/lib/voice-providers.js`).
- [x] TTS request: `audioConfig.speakingRate` for classic voices;
      `composeTtsStylePrompt` (style -> tone -> pace words) for the Gemini-TTS
      `input.prompt`.
- [x] Session override: `profile_override.speaking_rate|voice_tone` in
      `effectiveProfileForSession` (`gateway/lib/voice-session-server.js`).
- [x] Directives + tool: `voiceDeliveryDirective`, `voiceToolAckDirective`,
      language-switch spoken confirmation line, `update_agent_profile`
      description mentions the new fields (`gateway/server.js`).
- [x] Tool-ack fallback: `onToolRound` tap in `callModelToolLoopStreaming` +
      both provider loops; canned localized ack through the pipeline's new
      `pushImmediate` (`gateway/server.js`, `gateway/lib/voice-providers.js`).
- [x] Ops: `tts_speaking_rate` / `tts_tone` in cascaded provider status.
- [x] Verification: `smoke-cascaded-voice.js` expressive-shape assertions
      updated + new `deliveryRateAndToneRequestShape` scenario; full
      `npm run check` (150 pass) and `npm run eval:voice` green.
- [x] Guaranteed speed: `VOICE_TTS_CLIENT_RATE` mode — gateway emits
      `playback_rate` on `assistant_audio_start`, drops gemini pace words;
      `clientPlaybackRate`/`paceInPrompt` prevent double-apply; status reports
      `tts_client_rate_mode`; `clientRateModeEmitsPlaybackRate` smoke
      (`gateway/lib/voice-providers.js`, `voice-session-server.js`).
- [x] Clients apply `playback_rate`: pet page + extension `source.playbackRate`
      with `bufferDuration / rate` cursor fix; Android
      `AudioTrack.setPlaybackParams` (all default 1.0 when absent). Extension
      `npm run verify && npm run smoke` green; Android `assembleDebug` green.
- [x] Streaming-TTS decision recorded (gRPC-only Chirp vs Gemini SSE caveats vs
      chunked already streams) — see proposal; pending user provider choice.
- [ ] Follow-up (user decision): true streaming TTS leg — gRPC Chirp3-HD
      (`streamingSynthesize`, en-US, honors speaking_rate) or Gemini SSE
      (`streamGenerateContent`, multilingual, no rate, 60s cap).
- [ ] Follow-up: end-to-end voice-model (native_live) pace mapping.
