# voice-latency-prewarm

## ADDED Requirements

### Requirement: Reasoner and TTS provider connections are warmed during recording, not at commit

The gateway SHALL issue a content-free connection/session warm-up to the
configured reasoning provider and TTS provider when a voice turn begins
recording (`session_start`), so that connection-setup cost is not paid on
the critical path after the user stops speaking. The warm-up SHALL NOT
carry transcript content and SHALL NOT count as a billable inference
request.

#### Scenario: prewarm fires at recording start

- GIVEN a new voice turn begins via `session_start`
- WHEN the session server admits the turn
- THEN it issues a `prewarm()` call to the reasoner and TTS provider
  stages before any `commit_turn` event is received
- AND the call carries no transcript text and triggers no inference
  billing.

#### Scenario: prewarm never blocks session readiness

- GIVEN the configured provider's `prewarm()` is slow or fails
- WHEN a turn starts recording
- THEN `session_ready` is still sent to the client without waiting for
  `prewarm()` to resolve
- AND a `prewarm()` failure is logged and does not fail the turn.

### Requirement: No reasoning or TTS content is generated before the turn is committed

The gateway SHALL NOT invoke the reasoner or TTS provider with any
utterance-derived text before `commit_turn` (or an equivalent explicit
turn-completion event) is received for that turn. Interim or `isFinal`
partial transcript text SHALL be used only for the existing live-partial
display and for the measurement logging in this change, never as reasoner
or TTS input.

#### Scenario: mid-utterance partial never reaches the reasoner

- GIVEN a turn has produced one or more `isFinal` clause boundaries mid-
  recording
- WHEN no `commit_turn` has been received yet
- THEN the reasoner has not been invoked
- AND no TTS synthesis has been requested for this turn.

### Requirement: Clause-boundary timing is measured without changing turn behavior

When clause-boundary measurement is enabled
(`VOICE_LATENCY_MEASURE=1`), the gateway SHALL log, per turn, the count of
`isFinal` streaming-STT clause boundaries reached before `commit_turn` and
the elapsed time from the first such boundary to `commit_turn`, as an
additive provider-event entry. This logging SHALL NOT alter STT, reasoner,
or TTS behavior, and SHALL be a no-op when the flag is unset.

#### Scenario: measurement is additive and off by default

- GIVEN `VOICE_LATENCY_MEASURE` is unset
- WHEN a multi-clause turn completes
- THEN no clause-boundary measurement event is recorded
- AND turn behavior (transcript, reply, audio) is identical to the
  unflagged path.

#### Scenario: measurement records real clause timing when enabled

- GIVEN `VOICE_LATENCY_MEASURE=1` and a turn with 3 `isFinal` clause
  boundaries before `commit_turn`
- WHEN the turn completes
- THEN the provider-event trail contains a clause-boundary measurement
  entry with `clause_count: 3` and the elapsed ms from the first boundary
  to commit
- AND the turn's transcript, reasoning, and audio output are unchanged
  from the unflagged path.

### Requirement: Speculative reasoning and speculative TTS remain out of scope until measured

This change SHALL NOT implement speculative reasoning or speculative TTS
synthesis triggered by partial or clause-final transcript text. A future
change proposing that work SHALL cite the decision note produced by Task 3
of this change rather than propose it without production clause-boundary
evidence.

#### Scenario: no speculative reasoner call exists

- GIVEN the full implementation of this change
- WHEN the codebase is searched for a reasoner invocation triggered by
  `transcript_partial` or an `isFinal` clause event
- THEN none exists; the only reasoner invocation remains the existing
  post-`commit_turn` call in `CascadedVoiceProvider.processTurn`.

### Requirement: This change is distinct from the shipped streaming pipeline and the shipped interrupt/barge-in ledger

`ARCHITECTURE.md` SHALL document that this change (post-commit critical-
path prewarm and clause-boundary measurement) is separate from
streaming-cascaded-voice (which already overlaps STT/TTS with capture and
generation) and from the interrupt/barge-in cutoff ledger
(`planVoiceTurnRelation` and the steering coordinator, which replace an
in-flight turn when a *new* utterance starts), so a future reader does not
treat any of the three as covering the others.

#### Scenario: a future contributor checks for overlap before proposing new work

- GIVEN a contributor is about to propose speculative-reasoning work
- WHEN they read `ARCHITECTURE.md`'s voice section
- THEN they find this change, streaming-cascaded-voice, and the
  interrupt/barge-in ledger each described with what they do and do not
  cover, avoiding a duplicate or conflicting proposal.
