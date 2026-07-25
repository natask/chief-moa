## 1. Gateway narration loop (lane: gateway)

Status 2026-07-25: IMPLEMENTED on `proj/chief-moa` (base master@26f7384f).
The loop lives in the new `gateway/lib/voice-narration.js` (env caps, tool
defs, directive, `runNarrationLoop`), wired into
`runCascadedVoiceReasoningInner`; the pacing gate (`drainBelow` /
`segmentsEnqueued`) rides `createStreamingReplyPipeline`. To respect the
source-size debt ceilings, `effectiveProfileForSession` moved to
`gateway/lib/voice-session-profile.js` and the provider catalog to
`gateway/lib/voice-provider-registry.js` (mechanical extractions; ceilings
lowered in `scripts/source-size-policy.js`). 1.7 has NOT run yet — this
session's harness still denies node/npm execution (in-0k4) — so the
implementation is unverified until the check runs attended or the grant
lands.

- [x] 1.1 Env plumbing: `VOICE_SPEAK_FOREVER` (default off) +
      `VOICE_SPEAK_FOREVER_MAX_ROUNDS` (25) / `_MAX_SEGMENTS` (200) /
      `_MAX_MS` (600000) / `_MAX_BUFFERED_SEGMENTS` (6), read once beside
      the existing voice env block; additive `speak_forever` session
      override validated in `effectiveProfileForSession`
      (voice-session-server.js, `response_modality` pattern — never
      persisted).
- [x] 1.2 `begin_continuous_narration` / `finish_narration` tool defs +
      handlers beside `stay_silent` (server.js:12609 pattern), exposed only
      when the master env is on and modality is not text; system-prompt
      guidance added next to the existing stop/silence instructions.
- [x] 1.3 Narration loop in `runCascadedVoiceReasoning` (server.js:12162):
      self-prompt rounds through the same `onTextDelta`/`isActive` hooks,
      `NARRATION_CONTINUE_PROMPT` mirroring `AUTOCONTINUE_PROMPT`, exits on
      finish_narration / stay_silent / barge-in / caps / ttsError / breaker
      (design.md D3, D5).
- [x] 1.4 Pacing gate: `drainBelow(n)` on `createStreamingReplyPipeline`
      (segments enqueued minus segments sent), resolving/rejecting on
      cancel so a superseded turn never awaits a dead pipeline (design.md
      D4).
- [x] 1.5 Additive `narration_rounds` + `narration_stop_reason` on
      `turn_done` and the canonical record; durable-context tail-truncation
      guard for completed narration turns in `durableSessionContextBlock` +
      `voiceLiveContextPrompt` (design.md D6).
- [x] 1.6 Smoke cases in `scripts/smoke-cascaded-voice.js` (stub-reasoner
      driven, deterministic, no clock): `speakForeverLoopsUntilFinishTool`
      (3 rounds, one audio_start/audio_done, `narration_rounds:3`,
      stop_reason `finished`); `speakForeverHaltsOnCancel` (barge-in in
      round 2 → no further frames, `spoken_progress` persisted, mirrors
      `streamingInterruptionGoesSilent` + the spokenProgress cases);
      `speakForeverRespectsRoundCap` (tiny cap → `capped_rounds`);
      `speakForeverPacingBoundsBuffer` (round k+1's reasoner call not made
      until sent-count catches up); `speakForeverKillSwitchInert` (env off →
      tools absent, override ignored); `speakForeverStaySilentWins`.
- [ ] 1.7 Verification: `cd gateway && npm run check` green including the
      new cases. (Still blocked for autonomous ticks by in-0k4 as of
      2026-07-25; runnable attended. The implementation above must not be
      merged until this runs green.)

## 2. Workflow docs (lane: workflow-docs)

- [x] 2.1 Add this OpenSpec change (proposal.md, design.md, tasks.md,
      specs/voice-speak-forever-output-loop/spec.md, .openspec.yaml) as a
      reviewable design BEFORE implementation, per the in-9sw no-grant
      ladder decision of 2026-07-16.
- [ ] 2.2 After implementation lands: add the narration-loop delta to
      `ARCHITECTURE.md`'s cascaded voice section (engagement tools, pacing
      buffer, caps, stop reasons) and validate the change with
      `openspec validate voice-speak-forever-output-loop --strict`.

## 3. Client affordance (lane: browser-voice / android — deferred)

- [ ] 3.1 Decide whether a visible "narrating — tap to stop" state is
      needed beyond existing orb states + barge-in (design.md Open
      Questions); file client tickets only if QA shows users get stuck.
