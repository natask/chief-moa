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
- [ ] Follow-up: Chirp3-HD `streamingSynthesize` (bidi) TTS leg.
- [ ] Follow-up: end-to-end voice-model (native_live) pace mapping.
