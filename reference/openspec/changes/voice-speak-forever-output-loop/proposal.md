# Voice speak-forever output loop

## Why

The continuous-voice stack is three-quarters shipped: cascaded turns stream
chunked LLM→TTS audio (`streaming-cascaded-voice`, live), listening is
unbounded (streaming STT with rotation, live), and an interrupted reply's
exact spoken position is captured and resumable (`spoken_progress` +
`interruptedAssistantLabel`, live). The missing quarter is the OUTPUT loop:
today a turn ends when the model decides its reply is done. There is no mode
where AG keeps speaking — narrating a story, teaching a topic, walking a
document — by self-prompting for the next segment until the user interrupts
or a cap trips. The only multi-round generation that exists is the
MAX_TOKENS auto-continue, which fires on truncation, never voluntarily.

This is intent transition in-9sw (rescoped 2026-07-15: halves (a) chunked
streaming and (b) unbounded STT verified already live; half (c) — this loop —
is its only remaining scope).

## What Changes

- A session-scoped, default-off **continuous narration mode** for cascaded
  voice turns. When engaged, the gateway re-prompts the model for the next
  narration segment after each completed reasoning round and feeds the deltas
  into the SAME `createStreamingReplyPipeline`, so the client hears one
  uninterrupted audio stream inside one WS turn.
- Engagement is model-decided via a new `begin_continuous_narration` tool
  (mirroring `stay_silent`), or client-decided via an additive
  `speak_forever` session override in `effectiveProfileForSession`.
- Exit paths: model calls `finish_narration` (or stops engaging), user
  barge-in / `cancel_turn` (existing `TurnSupersededError` machinery), the
  `stay_silent` silent-stop, TTS fault/breaker trip, or a hard cap
  (`VOICE_SPEAK_FOREVER_MAX_ROUNDS` / `_MAX_SEGMENTS` / `_MAX_MS`).
- Pacing: the next LLM round is gated on the TTS emit chain draining below a
  segment-count threshold so generation cannot run unboundedly ahead of
  playback.
- Wire protocol event set unchanged; only additive `turn_done` /
  canonical-record fields (`narration_rounds`, `narration_stop_reason`).
- Deterministic smoke coverage in `scripts/smoke-cascaded-voice.js`.

## Non-Goals

- No Live-provider (`legacy-live`) support; cascaded pipeline only.
- No autonomous engagement — the mode starts only from an explicit user
  request (interpreted by the model) or an explicit client setting.
- No persisted profile field; the override is session-scoped like
  `response_modality` (never written to the stored profile).
- No text-modality self-prompt loop; this is a speech feature and the mode
  never engages when `response_modality` resolves to `text`.
- No new client UI or playback code; both clients already play an arbitrary
  number of frames between `assistant_audio_start` and `assistant_audio_done`.

## Impact

- Affected: `gateway/server.js` (`runCascadedVoiceReasoning`, tool defs,
  durable context builders), `gateway/lib/voice-session-server.js` (session
  override validation, additive turn fields), `gateway/lib/voice-providers.js`
  (loop-aware pipeline finish), `gateway/scripts/smoke-cascaded-voice.js`.
- Not affected: wire event set, Android/browser playback code, stored profile
  schema, non-streaming and Live paths, `VOICE_TTS_MAX_CHARS` semantics.
- Deploy note: gateway-only; lands under the same `deploy-vps.yml` trigger.
  Promotion is currently frozen by the M4 evidence requirement (in-xqz) —
  out of this change's scope.
