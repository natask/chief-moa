## ADDED Requirements

### Requirement: Chief Moa exposes four non-collapsed activity paths

Every supported Chief Moa Surface SHALL preserve deliberate, separately
identified paths for responding assistant conversation, literal dictation,
voice/video-note capture, and explicit execution handoff. A Surface that has
not implemented one path SHALL report it as unavailable rather than silently
routing it through another path.

#### Scenario: Assistant remains responding

- **WHEN** the user deliberately selects the assistant path and submits speech
  or text
- **THEN** Chief Moa MAY invoke gateway reasoning and return an assistant reply
- **AND** adding capture or dictation SHALL NOT remove this behavior

#### Scenario: Dictation remains literal

- **WHEN** the user deliberately selects dictation
- **THEN** Chief Moa SHALL return the authoritative literal transcript for edit,
  copy, or Surface-owned insertion
- **AND** it SHALL NOT invoke reasoning, TTS, tools, actions, or agent dispatch

### Requirement: Note capture preserves source before derivation

Chief Moa SHALL make an explicitly stopped voice/video note durable before any
transcription, cleanup, structuring, or intent derivation. Derived text SHALL
remain separately identified and SHALL NOT replace the original media or
literal transcript.

#### Scenario: Provider work fails after durable capture

- **WHEN** note storage succeeds and later transcription or derivation fails
- **THEN** the original media SHALL remain recoverable
- **AND** the Surface SHALL show a retryable failure rather than reporting the
  note as lost

#### Scenario: Capture stays inert

- **WHEN** the user captures, lists, replays, downloads, edits, or deletes a
  note without selecting Hand off
- **THEN** Chief Moa SHALL create no assistant reply, tool request, action
  proposal, Switchboard intent, or agent run

### Requirement: Execution handoff preserves product ownership

Chief Moa SHALL hand a user-confirmed source revision to Agent Switchboard
through a versioned idempotent contract. Switchboard SHALL remain canonical for
the resulting project/intent. Chief Moa SHALL retain only the external identity,
request digest, and receipts required to show continuity and progress.

#### Scenario: Repeated handoff is idempotent

- **WHEN** the same user-confirmed source revision and handoff request are
  submitted again
- **THEN** the integration SHALL return the same Switchboard intent identity
- **AND** it SHALL NOT create a duplicate intent or execution run
- **AND** changing project or context fields while reusing that source revision
  SHALL fail as a conflict rather than silently returning the earlier receipt

#### Scenario: The selected revision is content-bound

- **WHEN** Chief Moa hands off an immutable capture block
- **THEN** it SHALL derive the source hash and revision identity from the exact
  stored literal transcript selected by the user
- **AND** a mutable raw note identifier alone SHALL NOT identify a revision

#### Scenario: A transcribed audio-backed block is content- and provenance-bound

- **WHEN** Chief Moa hands off a schema-v2 audio-backed capture block
- **THEN** its processing state and transcript state SHALL both be `transcribed`
- **AND** the source revision and hash SHALL bind the exact
  `transcript.literal`, immutable transcript result identity, bounded provider
  evidence, and stored audio-note identity
- **AND** queued, transcribing, failed, inconsistent, or provenance-free blocks
  SHALL be rejected before Switchboard is called
- **AND** the raw audio SHALL cross only as an opaque evidence identity

#### Scenario: A confirmed goal upgrades the handoff contract

- **WHEN** the user enters and explicitly confirms a nonempty desired outcome
  plus one or more acceptance criteria for the selected terminal capture
- **THEN** Chief Moa SHALL submit contract version 2 with the desired outcome
  and deduplicated acceptance criteria in addition to the exact v1 source
  evidence and execution authority
- **AND** the request digest and retained receipt SHALL bind those exact goal
  fields
- **AND** a mismatched Switchboard goal echo SHALL be rejected before Chief Moa
  records a receipt
- **AND** Chief Moa SHALL NOT infer, summarize, or fabricate the desired outcome
  or acceptance criteria from the literal transcript

#### Scenario: Unconfirmed source capture remains compatible and inert

- **WHEN** a caller has not explicitly supplied and confirmed both goal fields
- **THEN** Chief Moa MAY retain the source-only v1 handoff contract for existing
  callers
- **AND** capture, transcription, replay, or goal-field editing SHALL create no
  Switchboard admission or agent run

#### Scenario: Chief retains a minimal audio-backed handoff receipt

- **WHEN** Switchboard accepts a transcribed audio-backed capture block
- **THEN** Chief Moa SHALL retain only the content-bound source identity,
  request digest, idempotency identity, explicitly confirmed v2 goal fields when
  present, and external Switchboard identities
- **AND** the Chief receipt SHALL contain no transcript, transcript-result or
  provider details, audio-note identity, media location, or raw media

#### Scenario: Context grants no execution authority

- **WHEN** a handoff includes application, page, element, screenshot, audio, or
  video evidence
- **THEN** the evidence MAY inform Switchboard planning
- **AND** it SHALL NOT itself authorize an external action, agent launch, or
  local Surface effect

#### Scenario: A finished run is not a solved outcome

- **WHEN** a handed-off execution run reaches a terminal state
- **THEN** Chief Moa SHALL show that run state and available evidence
- **AND** it SHALL NOT label the user intent completed unless the canonical
  Switchboard outcome includes the required acceptance and completion receipts

### Requirement: Branch Continue remains a separate product

Chief Moa SHALL NOT treat its session branch, capture block, or handoff records
as the canonical Branch Continue note tree. Integration MAY exchange stable
evidence identities without merging note storage, lineage, or user interfaces.

#### Scenario: Capturing another Chief Moa note

- **WHEN** the user records another Chief Moa voice note
- **THEN** Chief Moa SHALL preserve it as capture evidence under the selected
  Chief activity/thread
- **AND** it SHALL NOT create a Branch Continue parent/child note unless the
  user explicitly uses a separately authorized Branch Continue integration
