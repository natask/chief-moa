# Tasks

## Gateway slice (this change)

- [x] Extract stage/error diagnostics helpers out of `voice-session-server.js`
  into `voice-stage-diagnostics.js` so the plane can be wired in under the
  source-size ceiling, and lower that file's ceiling.
- [x] Add the observer registry with validated, frozen registrations and
  duplicate-id rejection.
- [x] Build observation frames from the streaming transcript, splitting the
  stable prefix from the live tail and computing the stability watermark from the
  existing finalized/interim split.
- [x] Apply the seven-step pre-filter before invoking any observer, including the
  transcript-quality guard.
- [x] Dispatch observations off the turn path with a latency budget, abort
  signal, coalescing of the pending frame, strike counting, and per-session
  quarantine.
- [x] Add the delivery arbiter: eligibility gate, score, total order,
  one-audible-winner-per-window, and the `interject > overlay > defer > drop`
  demotion ladder.
- [x] Enforce the in-flight reply rule and the post-reply quiet period.
- [x] Enforce stability thresholds, stable-prefix digest verification, revision
  drift, `revised` drops, and bubble retraction.
- [x] Enforce the non-Latin-script restriction and the partial-safety cap.
- [x] Normalize `voice_observer_policy`, default-off with a `defer` ceiling, with
  per-observer overrides and the text-modality clamp.
- [x] Classify user speech during playback as `stop_now`, `take_floor`, or
  `backchannel`, delegating to the existing barge-in and cutoff-ledger paths, and
  allow upward-only revision of a `backchannel` call.
- [x] Ship one trivial observer that makes no model call, and wire the plane into
  the existing transcript partial and final hooks.
- [x] Add unit tests for the plane and the arbiter, including the ranking,
  demotion, in-flight-reply, revised-proposal, and quarantine paths.
- [x] Keep observer diagnostics content-free.

## Follow-up work, not in this change

- [ ] Speech-coach prompt and model adapter, reusing the phrase-assist no-tool
  short-output generation boundary.
- [ ] Android and browser presentation of `overlay` and `defer` deliveries, and
  the retraction event, using the hosted TTS path only.
- [ ] Client VAD transition reporting so `pause` and `vad_stop` frames come from
  real device signals instead of transcript timing.
- [ ] Plumb the recognizer's own finalized/interim split through the session
  transcript hooks. The plane currently derives the settled prefix from the
  longest common prefix of consecutive emissions, which is the same agreement
  signal observed one layer out but cannot see a rotation fold an interim into
  finalized text.
- [ ] Per-language partial-stability measurement for am-ET, as the evidence that
  would justify relaxing the non-Latin `defer` restriction.
- [ ] Surface controls for `voice_observer_policy`, including the per-observer
  bubble-versus-speech toggle.
- [ ] Migrate `live-phrase-assist` to run as a registered observer once the
  surface controls exist, retiring its parallel request path.
