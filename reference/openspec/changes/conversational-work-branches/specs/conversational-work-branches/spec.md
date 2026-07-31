## ADDED Requirements

### Requirement: Foreground conversation does not wait for detached work
The gateway SHALL stream a concise conversational response independently from
durable branch or agent-run execution created by the same accepted turn.

#### Scenario: One message asks for several deliverables
- **WHEN** an accepted message contains multiple explicit work outcomes
- **THEN** the gateway returns or begins streaming a conversational response
- **AND** records a bounded, idempotent dispatch item for each outcome
- **AND** no detached run must complete before first response audio can play

### Requirement: Draft, thread, and run continuation remain distinct
The system SHALL distinguish resuming unsent capture, continuing a conversation
thread, and steering an active run.

#### Scenario: User pauses before finishing one message
- **WHEN** the user pauses an unsubmitted voice draft and later resumes it
- **THEN** the resumed audio belongs to the same draft in capture order
- **AND** no turn, provider request, tool call, or run is created before send

#### Scenario: User returns to old work
- **WHEN** the user selects a prior durable thread
- **THEN** the next turn uses that thread's branch history
- **AND** detached work in other branches continues independently

### Requirement: Work branches are first-class and recoverable
Every launched work branch SHALL have stable thread identity, source-turn
lineage, separate history, status, and a bounded summary queryable independently
of the voice connection that launched it.

#### Scenario: Voice connection closes after dispatch
- **WHEN** the client disconnects after branch/run admission
- **THEN** admitted work remains queryable and may continue under existing run
  policy
- **AND** reconnecting can list its thread and status without replaying the
  source message

### Requirement: Prior threads are conversationally navigable
The user SHALL be able to ask for prior threads and switch to one without
remembering its identifier.

#### Scenario: Several summaries match a spoken selection
- **WHEN** a spoken thread selection is ambiguous
- **THEN** the companion asks a short disambiguating question
- **AND** does not silently change the active thread

### Requirement: Transcript snapshots never accumulate on clients
Gateway transcript events SHALL carry authoritative whole-turn snapshots and
clients SHALL replace the current transcript rather than concatenate events.

#### Scenario: Recognizer revises an early phrase
- **WHEN** a later snapshot changes early words but retains most later words
- **THEN** Android and browser display only the later snapshot
- **AND** the earlier whole utterance is not duplicated
