# Voice Product Contract Notes

Source: worker task on 2026-07-08 to persist the user's product direction as
OpenSpec/workflow artifacts.

## Raw Direction

The voice product should feel like a reliable always-available assistant, not a
demo bound to one realtime provider. A successful turn is not just "the model
answered"; it is diagnosable, replayable, interruptible, and recoverable across
phone and browser surfaces.

## Success Criteria

- Diagnosable voice failures: every failed or degraded turn identifies the
  failing phase when possible: capture, transport, STT, reasoning, TTS,
  playback, storage, context assembly, or comparison.
- Self-hostable logs: the gateway stores enough normalized events, turn records,
  provider events, and artifact refs in the self-hosted data store to debug a
  failure without depending on a provider console.
- Long-response audio reliability: long replies stream as ordered audio
  segments, record segment counts and TTS errors, and degrade to visible text
  instead of hanging or silently ending.
- Below-perceived-wait first audio: every streamed voice turn records
  `first_audio_ms` from turn commit or final STT to first assistant PCM, and QA
  gates the value against a configured launch profile budget.
- Continuous partial STT: speaking surfaces show provider-normalized partial
  transcripts continuously before the final transcript, with final transcript
  replacement and storage remaining canonical.
- Interrupt context preservation: if the user interrupts, cancels, or drops a
  turn mid-response, the gateway stores the partial user/assistant content and
  includes it in the next turn's Moa-owned context pack.
- Configurable profiles and modes: voice behavior is selected by versioned
  profile state and named mode overlays, not hidden environment-only behavior.
- Voice demonstration: a repeatable phone/browser demo proves partial STT,
  first audio, long response playback, interruption, mode/profile switching,
  and failure diagnosis.
- Voice-first gestures: Android orb and browser mark can run a flag-gated
  voice-first control contract while preserving drag/resize and default
  gesture compatibility.
- Browser shortcuts: keyboard shortcuts must mirror the browser mark contract
  for text intent and voice capture/commit.
- Cache-friendly per-turn context: each turn assembles a bounded context pack
  from stable ids, profile version, summaries, and artifact refs with a cache
  key suitable for retries, routing, and provider restarts.

## Boundary Reminder

Gateway owns provider credentials, routing, logs, turn records, replay evidence,
profile state, context packs, and agent-run storage. Android owns phone UI,
voice capture/playback controls, permissions, approvals, local actions, and
receipts. The browser extension owns browser-local UI, shortcuts, microphone
capture, playback, page context, and local page actions. Model output remains a
proposal until a local client validates and executes it.

## Hard Implementation Contract

### Objective and non-negotiables

Deliver one provider-independent voice contract in which a saved profile change
is durable and reversible, a sample override is ephemeral, every turn is pinned
to an effective profile/version at admission, and failures are explainable from
Moa-owned evidence. Provider output remains data; it cannot grant Android or
browser execution authority.

### Segmented next-utterance switching semantics

"Next utterance" means the next **admitted user turn**, not the next TTS chunk,
provider callback, socket frame, or reconnect:

1. At `turn_started`, the gateway resolves global profile + device override +
   named mode + optional authorized session override into an immutable effective
   profile snapshot. It records the snapshot version/hash on the turn.
2. A voice/profile update accepted while turn N is capturing, reasoning, or
   speaking creates a new profile version but MUST NOT alter any STT, reasoning,
   TTS, playback-rate, or chunking choice already pinned to turn N.
3. Turn N reports `applies=next_turn`. Turn N+1 admitted after the write commits
   resolves the new profile. Reconnect is an internal detail and MUST NOT be
   required unless a capability explicitly reports `requires_reconnect`; then
   the response and normalized event say so.
4. An authorized session-only sample/preview override is pinned only to its
   sample turn/session, MUST NOT advance the durable profile version, and MUST
   disappear when that sample ends. Concurrent ordinary turns use independently
   pinned effective profiles.
5. Interruption never retroactively changes the interrupted turn. A retry is a
   new turn with a new id; it may reuse the prior context-pack hash but resolves
   the effective profile again unless explicitly requested as byte-equivalent
   replay.

These rules prevent a mid-answer switch from mixing voices across segments and
prevent sampling from silently becoming a saved preference.

### Ownership and forbidden shortcuts

- Gateway owns resolution, versioning, provider selection, credentials,
  normalized evidence, and durable records.
- Android/browser own capture, playback, visible state, and local actions.
- Do not use provider session state as truth, parse a voice name client-side to
  bypass the gateway, stuff unbounded history into a turn, infer playback from
  TTS success, or label provider capability as observed behavior.
- Do not check a task merely because a similarly named field, comment, or test
  exists. A checkbox requires its stated acceptance command and retained output.

### Measured gates versus architecture-confidence gates

Measured results exist only when the corresponding command or device/provider
run was executed and its output was retained:

- Deterministic repository gate: `cd gateway && npm run check` plus the named
  focused smoke(s).
- OpenSpec gate: `openspec validate provider-agnostic-voice-agent-runtime --strict`
  and `openspec validate streaming-cascaded-voice --strict`.
- Live latency/reliability: paid/live provider evaluation with sample count,
  environment, timestamps, failures, and percentile output retained.
- Surface behavior: real phone/browser turns with ids and gateway evidence for
  capture, partial/final transcript, first audio, long reply, interruption,
  switch, and fallback.

Architecture confidence may be reported separately. It must name supporting
seams/tests and residual unknowns. A requested confidence bar such as 95+ (or
BEAM 85+) is not a benchmark score. It is justified only by matching proofs,
canaries, rollback, fault injection, trust-boundary checks, and real
surface/provider evidence; otherwise report the target and missing evidence,
not an achieved number.

### Acceptance and escalation

The implementation contractor must provide exact owned files before coding and
must block if turn admission/pinning, profile-write serialization, or playback
evidence cannot be located. Acceptance requires deterministic tests for
mid-turn mutation isolation, concurrent turns, session-only sample cleanup,
reconnect-required reporting, retry semantics, and rollback; fault tests for
STT/reasoner/TTS/transport/storage; and both validation commands above. Live
provider calls and device QA are separate measured gates. Missing credentials,
hardware, retained output, or a compatible preview blocks the live claim but
not an honestly scoped deterministic artifact.
