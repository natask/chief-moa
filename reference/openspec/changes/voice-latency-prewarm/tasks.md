# Tasks

## 0. First-Reply Baseline Correction

- [x] 0.1 Allow the first pending speakable phrase to leave the streaming
  chunker below the normal 60-character later-chunk floor.
- [x] 0.2 Use a separate 250 ms first-phrase microbatch timer while retaining
  the 700 ms later-phrase quality timer, with deterministic chunker coverage.
- [x] 0.3 Strengthen the required voice-mode instruction so replies lead with
  a complete short spoken clause and omit screen-oriented formatting.

## 1. Clause-Boundary Measurement (ship first; decides whether more is worth building)

- [x] 1.1 In `gateway/lib/voice-stt-streaming.js`, expose the optional
  `onFinalSegment(info)` hook invoked from `handleData` for each accepted
  provider-final segment, additive and off by default so no existing caller
  behavior changes.
- [x] 1.2 In `gateway/lib/voice-session-server.js`, wire that hook (only in
  a debug/measurement mode gated by an env flag, e.g.
  `VOICE_LATENCY_MEASURE=1`) to log, per turn, the count of `isFinal`
  clause boundaries reached and the elapsed ms from the first one to
  `commit_turn`. Log to the existing provider-events trail
  (`recordProviderEvent`) as an additive event type, not a new store.
- [x] 1.3 Add a smoke that drives a multi-clause fixture through the fake
  streaming STT double and asserts the logged clause count and timing
  match the fixture's known `isFinal` sequence.
- [ ] 1.4 Run this in fixtures-mode CI only (no live cost) and, separately,
  let it run against real traffic for at least one week before Task 3
  (speculative reasoning) is even scoped, per the proposal's Non-Goals.

## 2. Connection Prewarm

- [x] 2.1 Add a `prewarm()` capability to the reasoner and TTS stage
  interfaces in `gateway/lib/voice-stages.js` (optional, defaults to a
  no-op so providers that don't support it are unaffected).
- [x] 2.2 Implement `prewarm()` for the gateway's configured reasoning
  provider and for the cloud-tts/gemini-tts provider in
  `gateway/lib/voice-providers.js`: a connection/session/token-refresh
  call that issues no inference request and carries no transcript
  content.
- [x] 2.3 Call `prewarm()` from `handleSessionStart`
  (`gateway/lib/voice-session-server.js`), fire-and-forget, alongside the
  existing `contextPromptForTurn` prefetch. It must not block
  `session_ready` and must not throw into the session-start path (log and
  continue on failure, exactly like the existing `contextBuildFailed`
  pattern).
- [x] 2.4 Add a deterministic smoke asserting `prewarm()` is called once
  per turn at `session_start`, not at `commit_turn`, using a fake provider
  double.

## 3. Verification And Reporting

- [ ] 3.1 Run a local controlled comparison (cold-connection vs.
  prewarmed) and record the measured delta in time-to-first-reasoner-token
  under `reference/research/voice-accuracy/` or a new
  `reference/research/voice-latency/` note — state the actual measured
  number, not a projected one.
- [ ] 3.2 After at least one week of Task 1's production measurement
  logging, write a short decision note:
  `reference/research/voice-latency/clause-speculation-decision.md`,
  stating the observed clause-boundary frequency and dead-time-before-
  commit, and an explicit recommendation on whether clause-triggered
  speculative reasoning is worth its quantified cost. This is a decision
  artifact, not a new OpenSpec change — a future change proposing
  speculative reasoning must cite this note's numbers rather than the
  proposal's rough estimate.

## 4. Docs

- [x] 4.1 Add a short note to `ARCHITECTURE.md`'s voice section
  distinguishing this change (post-commit critical-path prewarm plus
  measurement) from the shipped streaming-cascaded-voice work (which
  already overlaps STT/TTS with capture and generation) and from the
  shipped interrupt/barge-in cutoff ledger (which handles a *new*
  utterance replacing an in-flight one, not same-utterance speculative
  work) — so a future reader does not conflate the three.
