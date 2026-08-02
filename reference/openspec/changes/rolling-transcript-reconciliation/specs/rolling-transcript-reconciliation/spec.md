# rolling-transcript-reconciliation

## ADDED Requirements

### Requirement: Live streaming text remains immediate

The gateway SHALL continue publishing streaming Chirp partial/final snapshots
without waiting for rolling batch recognition. Rolling reconciliation SHALL NOT
delay turn finalization, reasoning, tool routing, TTS, or terminal receipts.

#### Scenario: batch worker is blocked

- **GIVEN** a voice turn has live streaming text and the batch worker is stalled
- **WHEN** the user commits the turn
- **THEN** the streaming transcript enters ordinary turn execution immediately
- **AND** reasoning, TTS, and the terminal receipt do not wait for correction

### Requirement: Natural streaming boundaries own exact audio spans

The gateway SHALL derive reconciliation boundaries only from streaming Chirp
`isFinal` results with valid, strictly increasing `resultEndOffset` values. Each
boundary SHALL map to a frame-aligned, immutable, non-overlapping PCM byte span
against the exact retained-audio generation or digest. Fixed text, byte, or
wall-clock chunking SHALL NOT cut speech for rolling correction.

#### Scenario: repeated or regressing result offset

- **GIVEN** a provider repeats an `isFinal` result or reports an end offset at
  or before the last sealed byte
- **WHEN** the gateway handles that event
- **THEN** it creates no new span and leaves prior span bounds unchanged

#### Scenario: exact tail is flushed

- **GIVEN** the last valid boundary ends before the durable PCM length
- **WHEN** the turn commits
- **THEN** the gateway seals exactly the remaining byte range as the tail
- **AND** it queues that tail asynchronously without delaying commit

### Requirement: Corrected snapshots are ordered whole-turn replacements

Completed batch spans SHALL serialize by source-audio ordinal, regardless of
worker completion order. Each publication SHALL carry a strictly increasing
turn-local `sequence`, the contiguous batch-corrected `finalized_text`, and the
current streaming `unsealed_text`. Clients SHALL replace the prior snapshot and
SHALL NOT concatenate it.

#### Scenario: later span finishes first

- **GIVEN** span 2 completes before span 1
- **WHEN** the gateway considers publication
- **THEN** span 2 is not published ahead of span 1
- **AND** the next snapshot advances only after the corrected prefix is
  contiguous from span 0

### Requirement: Revision zero and execution causality are preserved

The gateway SHALL preserve the streaming transcript used for turn execution as
immutable revision 0. It SHALL append and activate a corrected revision only
after every exact audio span has succeeded and their full serialized text is
nonempty. Activating that revision SHALL NOT rerun reasoning, tools, actions, or
TTS.

#### Scenario: one span is empty or terminally failed

- **GIVEN** revision 0 exists and a full corrected transcript cannot be formed
- **WHEN** reconciliation reaches a terminal state
- **THEN** no empty or partial corrected revision becomes active
- **AND** revision 0 remains readable and identifies what execution used

### Requirement: Android applies corrections only to the exact authorized user message

Rolling transcript events SHALL be capability-gated and SHALL bind exact
owner/user, session, branch, turn, and message identity. A prefix event SHALL
include a strictly increasing `transcript_sequence`, batch revision,
`finalized_text`, `unsealed_text`, and authoritative whole text. Android SHALL
render the authoritative whole text without overlap inference. A completed
correction SHALL update only the exact retained finalized user message when its
revision is newer; it SHALL NOT update assistant text or a current capture.

#### Scenario: stale or wrong-authority event arrives

- **GIVEN** Android has a retained finalized user message
- **WHEN** it receives a duplicate, non-increasing, out-of-order, wrong-user,
  wrong-session, wrong-branch, wrong-turn, or wrong-message correction
- **THEN** Android rejects the event and leaves every visible message unchanged

#### Scenario: complete correction updates retained history accessibly

- **GIVEN** a newer complete revision binds the exact retained finalized user
  message and includes tail-completion evidence
- **WHEN** Android applies it
- **THEN** only that user message changes to the authoritative whole text
- **AND** any accessibility announcement does not move focus

#### Scenario: missing tail cannot finalize a message

- **GIVEN** a prefix event has corrected sealed spans but no completed tail
- **WHEN** Android receives it after the original message was retained
- **THEN** it does not claim or apply a complete finalized revision
- **AND** it does not modify an assistant message or the current capture

### Requirement: Browser preserves the live tail and rejects stale correction authority

The browser extension SHALL accept rolling correction events only when
`transcript_revisions_v1` version 1 was advertised for the exact voice session.
It SHALL request reconciliation only with exact
`{enabled:true, version:1, privacy_scope:"retained"}` consent for a normal
retained-audio session, SHALL bind that consent to explicit
`context_action:"continue"` on the same `session_start`, and SHALL omit consent
for incognito, new, fork, or non-audio sessions.
Each accepted prefix revision SHALL bind the current session, branch, turn,
canonical user `message_id`, strictly increasing transcript sequence, and
strictly increasing batch revision. The browser SHALL render the event's
authoritative whole snapshot and SHALL NOT infer text overlap. Canonical History
hydration SHALL never replace a newer finalized user-message revision with an
older or same-revision/different-text response. Copy SHALL read the currently
rendered corrected text.

#### Scenario: rolling correction preserves a newer live tail

- **GIVEN** the browser displays a whole transcript snapshot with an editable
  live tail
- **WHEN** a newer authorized prefix revision supplies corrected
  `finalized_text`, current `unsealed_text`, and their authoritative whole text
- **THEN** the browser replaces the prior snapshot with that whole text
- **AND** a later out-of-order prefix event cannot rewind the newer live tail

#### Scenario: private capture cannot enqueue reconciliation

- **GIVEN** the browser starts an incognito voice turn
- **WHEN** it sends `session_start`
- **THEN** it omits transcript-reconciliation consent
- **AND** the gateway cannot treat the session as eligible for a second audio
  pass

#### Scenario: correction cannot cross message authority

- **GIVEN** the browser has a live capture and retained user and assistant
  messages from multiple branches
- **WHEN** a correction has a duplicate revision, stale sequence, wrong
  session, wrong branch, wrong turn, wrong canonical message id, or assistant
  speaker
- **THEN** the browser leaves all visible and copyable text unchanged

#### Scenario: corrected history is immediately copyable

- **GIVEN** canonical History returns a strictly newer completed transcript
  revision for the exact retained user message
- **WHEN** the browser renders the new revision and the user selects Copy
- **THEN** Copy writes the corrected visible text
- **AND** a later stale History response cannot restore the older text

### Requirement: Durable claims bound duplicate paid recognition

Every queued span SHALL use a durable claim with an attempt identity, lease,
audio identity, and durable outcome. Recovery SHALL NOT submit a span whose
successful result is already durable. Ambiguous provider outcomes SHALL use a
stable idempotency identity where supported and a bounded retry policy; the
gateway SHALL NOT claim exact external once-only billing where the provider
offers no such guarantee.

#### Scenario: process crashes after durable completion

- **GIVEN** a span result and completed outcome were durably recorded
- **WHEN** the gateway restarts and reconciles its queue
- **THEN** that span is not sent to paid STT again
- **AND** publication resumes from the durable result

### Requirement: Privacy and unavailable dependencies fail soft

Reconciliation SHALL run only for audio whose retention policy permits the
additional provider pass. A client SHALL opt in with version 1,
`privacy_scope: retained`, and the ordinary `continue` context action; new,
forked, incognito, unknown-retention, and legacy sessions SHALL NOT enqueue it.
Before each read and paid call, the gateway SHALL
verify owner, audio availability, generation/digest, and current privacy
eligibility. Missing, deleted, expired, mismatched, or forbidden audio and an
unavailable provider SHALL leave the turn and revision 0 usable without
recreating audio or failing the interactive voice path.

#### Scenario: audio is deleted while queued

- **GIVEN** an eligible span is queued and its source audio is then deleted
- **WHEN** a worker claims the span
- **THEN** it records a content-free terminal skip without reading or sending
  audio
- **AND** ordinary transcript history remains available

### Requirement: Queue, concurrency, retries, and spend are bounded

The gateway SHALL enforce configured limits for pending spans, eligible audio
duration or bytes per turn, global and per-owner worker concurrency, claim
attempts, and retry count. Adjacent natural finals SHALL accumulate until at
least 20 seconds of eligible audio is available, except for the exact final
tail. Backpressure SHALL skip or defer reconciliation rather
than consume resources needed by live capture, commit, reasoning, or TTS.

#### Scenario: queue is full

- **GIVEN** the pending-span limit has been reached
- **WHEN** another natural boundary arrives
- **THEN** interactive streaming continues unchanged
- **AND** the gateway records a content-free skipped/deferred reason without an
  unbounded enqueue or provider call
