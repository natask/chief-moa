## ADDED Requirements

### Requirement: Observers register declaratively and are validated at startup
The gateway SHALL expose a registration point that accepts an observer with a
stable id, contract version, trigger set, minimum stability, invocation interval,
per-turn proposal cap, latency budget, language set, partial-safety flag, and its
own delivery ceiling. An invalid registration SHALL throw at registration time.
A registered observer SHALL be frozen and SHALL NOT be able to raise its own
declared delivery ceiling later.

#### Scenario: A registration missing an observe function is rejected
- **WHEN** an observer is registered without an `observe` function
- **THEN** registration throws
- **AND** no voice turn is affected

#### Scenario: A duplicate observer id is rejected
- **WHEN** a second observer registers with an id already in the plane
- **THEN** registration throws

### Requirement: The pre-filter makes declining cheap
The gateway SHALL evaluate observer eligibility for an observation frame before
invoking the observer. The pre-filter SHALL check policy enablement, quarantine,
remaining proposal budget, trigger membership, stability minimum, language match,
minimum invocation interval, stable-revision change, and transcript-quality
acceptance. An observer failing any check SHALL NOT have its `observe` function
called.

#### Scenario: A mid-utterance partial does not reach a pause-triggered observer
- **WHEN** a transcript partial produces a frame with trigger `partial` and an observer declares only `pause`
- **THEN** the observer's `observe` function is not called
- **AND** no proposal is produced

#### Scenario: An unstable frame does not reach an observer requiring stability
- **WHEN** a frame has stability watermark below the observer's declared minimum
- **THEN** the observer's `observe` function is not called

#### Scenario: An observer declining costs nothing further
- **WHEN** an invoked observer returns `null`
- **THEN** no proposal, delivery, or content-bearing receipt is produced

### Requirement: Observation never blocks the voice turn
The gateway SHALL dispatch observations off the voice turn path. The transcript
partial and final handlers SHALL NOT await observer work. Each `observe` call
SHALL run under its declared latency budget with an abort signal; a call
exceeding the budget SHALL be abandoned and its late result discarded. At most
one observation per observer SHALL be in flight, and a frame arriving during an
in-flight observation SHALL replace the pending frame rather than queue.

#### Scenario: A hanging observer does not delay the turn
- **WHEN** an observer never resolves
- **THEN** the transcript handler returns without waiting
- **AND** the observation is abandoned at its latency budget
- **AND** the turn commits normally

#### Scenario: A late result is discarded
- **WHEN** an observer resolves after its latency budget expired
- **THEN** no proposal from that call reaches the arbiter

#### Scenario: Repeated failure quarantines only the failing observer
- **WHEN** one observer times out or throws three times in a turn
- **THEN** that observer is quarantined for the session
- **AND** other observers continue to be invoked
- **AND** the quarantine record contains no transcript or proposal content

### Requirement: The arbiter is the only path from proposal to delivery
The gateway SHALL route every observer proposal through a single delivery
arbiter. An observer SHALL NOT be able to emit audio, emit a client event, alter
a transcript, commit a turn, invoke a tool, launch an agent run, write a profile,
or append canonical conversation history.

#### Scenario: A proposal produces exactly one recorded delivery decision
- **WHEN** an observer returns a proposal
- **THEN** the arbiter emits one delivery decision for it
- **AND** no commit, tool, agent, profile, or canonical-history callback runs

### Requirement: Delivery modes have fixed semantics
The gateway SHALL support delivery modes `overlay`, `interject`, `defer`, and
`drop`. `overlay` SHALL be audible beside the user without stopping capture or
committing the turn. `interject` SHALL yield the floor to the assistant while
leaving the user's turn recording and its transcript accumulating. `defer` SHALL
produce no audio under any condition. `drop` SHALL produce a content-free receipt
only. No delivery SHALL enter canonical conversation history as an assistant
turn.

#### Scenario: Overlay does not stop the user
- **WHEN** a proposal is delivered as `overlay`
- **THEN** the turn status remains `recording`
- **AND** the transcript is unchanged by the delivery

#### Scenario: Interject does not cancel the user's turn
- **WHEN** a proposal is delivered as `interject`
- **THEN** a floor-yield event is emitted
- **AND** the user's turn remains recording and commits normally afterwards

#### Scenario: Defer never synthesizes speech
- **WHEN** a proposal is delivered as `defer`
- **THEN** no text-to-speech call is made

### Requirement: Audible delivery never falls back to a local device voice
The gateway SHALL deliver `overlay` and `interject` audio only through the hosted
text-to-speech path. When hosted synthesis is unavailable the delivery SHALL
degrade to `defer`. The gateway SHALL NOT instruct any client to speak an
observer delivery through a local on-device voice.

#### Scenario: Hosted synthesis is unavailable
- **WHEN** an `overlay` delivery cannot be synthesized through hosted text to speech
- **THEN** the delivery resolves to `defer`
- **AND** no local-voice instruction is emitted

### Requirement: Competing proposals produce at most one voice
The gateway SHALL decide proposals arriving within one arbitration window
together, rank survivors of the eligibility gate by
`0.5*urgency + 0.3*confidence + 0.2*stability_watermark`, and break ties by
registration priority, then proposal time, then observer id. At most one
proposal per window SHALL be delivered above `defer`. Every other surviving
proposal SHALL be delivered as `defer` when its observer allows defer fallback,
and dropped as `superseded` otherwise. The ranking SHALL be deterministic.

#### Scenario: Two observers propose audio at once
- **WHEN** two eligible proposals arrive in the same arbitration window
- **THEN** only the higher-scoring proposal may be audible
- **AND** the other is delivered as `defer` or dropped as `superseded`

#### Scenario: Equal scores resolve deterministically
- **WHEN** two proposals score identically
- **THEN** the higher registration priority wins
- **AND** the same inputs always produce the same winner

### Requirement: Policy can only lower a delivery, never raise it
The gateway SHALL resolve a final delivery mode as the minimum, over the ordered
ladder `interject > overlay > defer > drop`, of the requested mode, the
observer's declared ceiling, the user policy ceiling, and the floor-state
ceiling. No observer output, proposal field, model output, or client request
SHALL raise a delivery above the user policy ceiling.

#### Scenario: An observer requests more than its own ceiling
- **WHEN** an observer whose ceiling is `overlay` requests `interject`
- **THEN** the delivery resolves to at most `overlay`

#### Scenario: A proposal cannot exceed user policy
- **WHEN** user policy sets the ceiling to `defer` and a proposal requests `interject`
- **THEN** the delivery resolves to `defer`
- **AND** the decision records that user policy demoted it

### Requirement: The observer plane is default-off and defaults to bubbles
The gateway SHALL treat the observer plane as disabled unless the user enables
it. When enabled, the default delivery ceiling SHALL be `defer`, so an observer
produces a bubble rather than speech until the user grants audio. The user SHALL
be able to set the ceiling per observer. A user whose reply modality is text
SHALL have the observer ceiling clamped to `defer`.

#### Scenario: A session with no policy runs no observers
- **WHEN** a voice session has no observer policy
- **THEN** no observer is invoked and no delivery is emitted

#### Scenario: Enabling the plane produces bubbles, not speech
- **WHEN** the plane is enabled with default settings and an observer proposes `overlay`
- **THEN** the delivery resolves to `defer`

#### Scenario: Text reply modality clamps observer audio
- **WHEN** the profile reply modality is text and user policy allows `overlay`
- **THEN** the delivery resolves to `defer`

### Requirement: A background completion never preempts an in-flight reply
The gateway SHALL demote any proposal to `defer` while an assistant reply for the
session is in flight, meaning the turn status is `committed` or `playback`, an
assistant audio stream is open, or a streamed reply has unsent frames. An
observer, background task, agent run, or queue job reaching completion SHALL
NEVER cancel, truncate, or preempt an in-flight reply. Audible delivery SHALL
remain blocked for a configured quiet period after the reply reaches a terminal
status.

#### Scenario: A proposal arrives during playback
- **WHEN** an observer proposes `interject` while the assistant reply is playing
- **THEN** the delivery resolves to `defer`
- **AND** the in-flight reply is not stopped, truncated, or cancelled

#### Scenario: A proposal arrives immediately after a reply ends
- **WHEN** a proposal requests audio within the quiet period after the reply terminates
- **THEN** the delivery resolves to `defer`

### Requirement: User speech during assistant playback is classified before the floor changes
The gateway SHALL classify user speech during assistant playback as `stop_now`,
`take_floor`, or `backchannel`. An explicit stop cue SHALL resolve to `stop_now`
immediately, stopping assistant audio and recording the cutoff in the existing
interruption ledger without creating a new turn. Sustained speech past the
take-floor duration, or an interim transcript with at least the configured number
of content words, SHALL resolve to `take_floor` and use the existing barge-in
path. Anything below both thresholds SHALL resolve to `backchannel` and the
assistant SHALL keep speaking.

#### Scenario: An explicit stop cue stops speech at once
- **WHEN** the user says a stop cue during assistant playback
- **THEN** assistant audio stops
- **AND** the cutoff is recorded in the interruption ledger
- **AND** no new turn is created

#### Scenario: A short backchannel does not stop the assistant
- **WHEN** the user emits a short burst with no stop cue and fewer than the configured content words
- **THEN** the assistant continues speaking
- **AND** a floor-intent receipt records the classification

#### Scenario: Sustained speech takes the floor
- **WHEN** user speech exceeds the take-floor duration during playback
- **THEN** the existing barge-in path closes the active turn as interrupted
- **AND** the new turn inherits the partial context as a steering turn

### Requirement: A backchannel decision is revisable upward and never downward
The gateway SHALL escalate a `backchannel` classification to `take_floor` if
speech continues past the take-floor threshold within the configured revisit
window. The gateway SHALL NOT reverse a `take_floor` or `stop_now` decision back
to `backchannel`.

#### Scenario: A backchannel turns into a real interruption
- **WHEN** speech classified as `backchannel` continues past the take-floor threshold within the revisit window
- **THEN** the classification escalates to `take_floor`
- **AND** the existing barge-in path runs at that moment

### Requirement: The stability watermark separates settled speech from the live tail
The gateway SHALL derive a stability watermark from the streaming recognizer's
existing split between finalized segments and the live interim hypothesis.
Finalized text SHALL count as stable only after it is unchanged across two
consecutive partial emissions. The observation frame SHALL expose the stable
prefix and the unstable tail as separate fields and SHALL NOT present them as one
concatenated value.

#### Scenario: Freshly finalized text is not yet stable
- **WHEN** finalized text changed on the most recent partial emission
- **THEN** the watermark does not yet count that text as stable

#### Scenario: The frame separates stable text from the tail
- **WHEN** an observation frame is built during speech
- **THEN** the stable prefix and the live tail are distinct fields

### Requirement: Audible delivery requires stable text and bounded revision drift
The gateway SHALL require a stability watermark of at least 0.6 for `overlay` and
at least 0.8 for `interject`, and SHALL cap at `defer` any proposal that does not
carry a stable-prefix digest matching a prefix the gateway actually served. The
gateway SHALL drop a proposal as `stale` when the turn's transcript revision has
advanced past the proposal's revision by more than the configured drift bound.

#### Scenario: A proposal built from the unstable tail cannot be spoken
- **WHEN** a proposal carries no stable-prefix digest
- **THEN** the delivery resolves to at most `defer`

#### Scenario: A proposal with a forged digest cannot be spoken
- **WHEN** a proposal's stable-prefix digest does not match a prefix the gateway served
- **THEN** the delivery resolves to at most `defer`

#### Scenario: A proposal that fell too far behind is dropped
- **WHEN** the transcript revision advanced past the proposal's revision by more than the drift bound
- **THEN** the proposal is dropped as `stale`

### Requirement: A proposal whose basis was revised is dropped and any bubble retracted
The gateway SHALL compare a proposal's stable-prefix digest to the turn's current
stable prefix at delivery time. An extended prefix SHALL allow delivery. A
diverged prefix SHALL drop the proposal as `revised`. When a `defer` delivery for
that proposal already reached the client, the gateway SHALL emit a retraction for
it.

#### Scenario: The user said more, so the proposal still stands
- **WHEN** the current stable prefix starts with the proposal's prefix
- **THEN** delivery proceeds

#### Scenario: The recognizer revised the words the proposal was built on
- **WHEN** the current stable prefix diverges from the proposal's prefix
- **THEN** the proposal is dropped as `revised`
- **AND** an already-delivered bubble for it is retracted

### Requirement: Non-Latin-script turns restrict audible observer delivery
When the turn's input language profile includes a non-Latin script, the gateway
SHALL make `interject` unavailable, SHALL require a stability watermark of at
least 0.8 for audible delivery, and SHALL cap at `defer` any observer whose
proposal quotes, corrects, or rewrites the user's own words.

#### Scenario: An Amharic turn cannot be interjected into
- **WHEN** the input language profile includes Ethiopic and a proposal requests `interject`
- **THEN** the delivery resolves to at most `overlay`

#### Scenario: The speech coach is silent on an Amharic turn
- **WHEN** the speech coach proposes on a turn whose input profile includes Ethiopic
- **THEN** the delivery resolves to `defer`

### Requirement: Observers unsafe on partial input cannot be audible from partials
The gateway SHALL require an observer to declare partial safety. An observer that
is not partial-safe SHALL be capped at `defer` for proposals derived from a
partial-triggered frame, and SHALL be eligible for audible delivery only from a
final-triggered frame.

#### Scenario: A word-quoting observer proposes on a partial
- **WHEN** an observer declaring `partialSafe: false` proposes from a partial-triggered frame
- **THEN** the delivery resolves to at most `defer`

#### Scenario: A wording-independent observer may speak mid-utterance
- **WHEN** an observer declaring `partialSafe: true` proposes from a partial-triggered frame with a sufficient watermark
- **THEN** audible delivery is permitted subject to the remaining ceilings

### Requirement: The observation path does not weaken the transcript-quality guard
The gateway SHALL keep the existing final-transcript script guard unchanged and
SHALL additionally apply it as a pre-filter on the observation path. A frame
whose stable text the guard would reject SHALL NOT reach an observer, and a
proposal SHALL be dropped as `quality_rejected` when the guard has since rejected
the turn's text. Observer output SHALL NOT be a source of any profile write.

#### Scenario: Wrong-script partial text is withheld from observers
- **WHEN** the guard would reject the stable text for the turn's configured languages
- **THEN** no observer is invoked for that frame

#### Scenario: Observer output never reaches a profile
- **WHEN** any observer proposal is delivered in any mode
- **THEN** no profile write occurs as a result

### Requirement: Observer diagnostics are content-free
The gateway SHALL record observer lifecycle diagnostics containing observer id,
proposal id, trigger, mode requested and resolved, demotion reason, drop reason,
score inputs, stability watermark, transcript revision, timing, and text length.
Diagnostics SHALL NOT contain transcript content or proposal text.

#### Scenario: A dropped proposal is auditable without content
- **WHEN** a proposal is dropped as `revised`
- **THEN** the receipt records the reason, observer, timing, and lengths
- **AND** contains no transcript or proposal text
