## 1. Gateway streaming (lane: gateway-streaming)

- [ ] 1.1 `lib/voice-chunker.js`: pure sentence/clause chunker (Latin +
      Ethiopic + Arabic + CJK boundaries, abbreviation/decimal/ellipsis
      guards, first-chunk-fastest policy, `[tag]` atomicity).
- [ ] 1.2 Interruption guard: turn-identity + non-terminal-status check at
      hook entry, re-check immediately before each socket write,
      `writeAssistantAudio` null/closed-latch guard. Lands in the same commit
      as 1.4.
- [ ] 1.3 `callModelToolLoopStreaming` for the Vertex (`streamGenerateContent?
      alt=sse`) and OpenAI-compatible (`stream: true` SSE) reasoning paths,
      with tool-round text buffering/flush-at-end and a per-round
      non-streaming safety valve on transport/parse error.
- [ ] 1.4 `streamSynthesizedReply` pipelined-TTS helper: bounded concurrency
      (`VOICE_TTS_CONCURRENCY`, default 2), strictly ordered emission,
      mid-stream fault degrade to `tts_error` + text-only, abort on
      interruption via a shared `AbortController`.
- [ ] 1.5 Gate hoisting: resolve `modality`/pinned TTS language before the LLM
      stream starts so chunk 1 can synthesize.
- [ ] 1.6 `lib/voice-stages.js` provider seam (`SttProvider`/`Reasoner`/
      `TtsProvider`, registry `create(options)` factories) and
      `streaming_tts`/`streaming_reasoning` capability flags on `/health`.
- [ ] 1.7 `VOICE_STREAMING` per-turn flag read + in-process streaming circuit
      breaker (3-fault trip, `voice_streaming_tripped` log once).
- [ ] 1.8 `VOICE_STREAM_MAX_CHARS` streaming cap, separate from the untouched
      `VOICE_TTS_MAX_CHARS`; tuning envs (`VOICE_CHUNK_MIN_CHARS`,
      `VOICE_CHUNK_MAX_CHARS`, `VOICE_CHUNK_FIRST_MAX_CHARS`,
      `VOICE_CHUNK_FLUSH_MS`).
- [ ] 1.9 `scripts/smoke-cascaded-voice.js` additions (multi-chunk ordering,
      mid-stream TTS failure, interruption, null-stream guard, circuit
      breaker, cap prefix property, kill switch, tool-round-only text,
      long-response ordered-segment fixture, first-audio latency budget,
      `turn_done` fields) and `scripts/test-voice-chunker.js`, both wired into
      `npm run check`.
- [ ] 1.10 Second commit: expose profile language tools
      (`update_agent_profile`/`revert_agent_profile`/`get_profile_options`) on
      `POST /v1/chat` text turns via the same sanitizer path.
- [ ] 1.11 Verification: `cd gateway && npm run check && node
      scripts/smoke-cascaded-voice.js && node scripts/test-voice-chunker.js &&
      npm run eval:voice`, asserting a long response produces ordered segments
      and `first_audio_ms` stays within the configured launch-profile budget.
- [ ] 1.12 Product diagnostics handoff: propagate `first_audio_ms`,
      `tts_segments`, `tts_spoke`, `tts_error`, streaming trip state, and
      mid-stream fault phase labels into the provider-agnostic voice diagnosis
      records so "why did voice fail?" can be answered from self-hosted logs.
- [ ] 1.13 Merge to master and push; `Deploy VPS gateway` + droplet
      auto-update timer promote behind the unchanged backup/restore-check
      gate.

## 2. Android compatibility (lane: android-compat)

- [ ] 2.1 Verify multi-frame cascaded audio: per-frame watchdog reset, drain
      on `assistant_audio_done`, no regression on interrupt.
- [ ] 2.2 Apply any hardening found during QA to
      `MoaStreamingVoiceSessionController.java`, `MoaVoiceGatewaySocket.java`,
      `MoaAudioPlaybackController.java`.
- [ ] 2.3 Verification: `cd android_app && ANDROID_HOME="$HOME/Library/
      Android/sdk" ./gradlew assembleDebug`, then one phone voice turn against
      the promoted gateway.
- [ ] 2.4 OTA when a phone session is not active, or record the blocker.

## 3. Browser compatibility (lane: browser-compat)

- [ ] 3.1 Verify multi-frame cascaded audio: per-frame watchdog reset,
      `playbackTime` scheduling, stop-guard halts mid-stream.
- [ ] 3.2 Apply any hardening found during QA to `content.js`,
      `background.js`; patch-bump `manifest.json`.
- [ ] 3.3 Verification: `cd browser_extension && npm run verify && npm run
      smoke`.
- [ ] 3.4 `moa-extension-refresh` (verify + package + reload poke), or record
      the package path as the blocker if the dev-reload bridge is not
      enabled.

## 4. LiveKit worker language pinning (lane: livekit-language)

- [ ] 4.1 Worker reads `input_languages`/`input_language_primary` from `GET
      /v1/agent/profile` at session start (existing `MOA_GATEWAY_TOKEN`
      bearer), normalized to at most 2 codes, primary first.
- [ ] 4.2 Fall back to `MOA_LIVEKIT_LANGS` on fetch failure, 401, or no codes.
- [ ] 4.3 Verification: `cd livekit_worker && npm test && npm run build`.
- [ ] 4.4 No live deploy; the LiveKit path stays a flag-gated prototype off by
      default.

## 5. Workflow docs (lane: workflow-docs)

- [x] 5.1 Add this OpenSpec change (`proposal.md`, `design.md`, `tasks.md`,
      `specs/streaming-cascaded-voice/spec.md`, `.openspec.yaml`) mirroring
      the shipped streaming design, not aspiration.
- [x] 5.2 Add the streaming-pipeline delta to `ARCHITECTURE.md`'s cascaded
      voice section: multi-frame emission, inverted text/audio ordering,
      chunker contract, interruption guard, circuit breaker, the
      `VOICE_STREAM_MAX_CHARS`/`VOICE_TTS_MAX_CHARS` split, and the mandatory
      post-promote live QA step.
- [x] 5.3 Note in `proposal.md` that this docs change must land in the same
      master push as the gateway lane, since `deploy-vps.yml` triggers only
      on `gateway/**`.
- [x] 5.4 Verification: inspect
      `reference/openspec/changes/streaming-cascaded-voice/` for structural
      parity with sibling changes and run `openspec validate
      streaming-cascaded-voice --strict` if the CLI is initialized for this
      checkout. Ran clean: `Change 'streaming-cascaded-voice' is valid`.

## 6. Product contract handoff (lane: workflow-docs)

- [ ] 6.1 Link this streaming lane to
      `provider-agnostic-voice-agent-runtime`: the streaming lane owns
      long-response audio reliability, ordered segment emission,
      first-audio timing, TTS degradation, and streaming diagnostics for the
      cascaded LLM/TTS legs.
- [ ] 6.2 Keep continuous partial STT out of this specific streaming lane unless
      the implementation scope is widened; partial STT remains a
      provider-agnostic runtime task because this change currently streams only
      the LLM and TTS legs.
- [ ] 6.3 Add the launch-demo evidence item after promotion: one long spoken
      response on phone and one in browser must show first audio before the
      full answer completes, finish playback, and leave queryable
      `first_audio_ms`/`tts_segments` provider-event evidence.
