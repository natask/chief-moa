## ADDED Requirements

### Requirement: Canonical Moa Conversation Record
The gateway SHALL store canonical conversation records independent of provider
session memory.

#### Scenario: Voice turn completes
- **WHEN** a voice turn completes
- **THEN** the gateway stores session, branch, turn, timestamps, transcript,
  assistant output, audio artifact references, provider identifiers, provider
  events, and profile version

#### Scenario: Provider session resumes or restarts
- **WHEN** a provider session is resumed or restarted
- **THEN** Moa reconstructs necessary context from stored conversation records
  and summaries rather than relying only on provider-held history

#### Scenario: Live turn is interrupted before completion
- **WHEN** a live voice turn is interrupted, canceled, or its transport drops
  before the turn completes
- **THEN** the gateway stores a canonical turn record marked incomplete with the
  partial transcript and partial assistant output captured before the cutoff
- **AND** that partial turn is included in the next live session's Moa-owned
  context pack so the conversation continues across turns and devices

### Requirement: Local Audio Artifact Tracking
The system SHALL track user and assistant audio artifacts associated with each
voice turn when retention is enabled.

#### Scenario: User audio captured
- **WHEN** Android sends microphone audio for a turn
- **THEN** the gateway stores or references the user audio artifact with session
  and turn identifiers according to retention policy

#### Scenario: Assistant audio produced
- **WHEN** the provider or TTS runtime produces assistant audio
- **THEN** the gateway stores or references the assistant audio artifact with
  session and turn identifiers according to retention policy

#### Scenario: User replays what they said
- **WHEN** a retained streaming voice turn has archived PCM audio
- **THEN** the gateway exposes token-protected playback/download references for
  the user audio and assistant audio from the session history and history search
  read models
- **AND** fetching a playback reference returns the exact archived audio bytes
  for that session and turn

#### Scenario: Voice turn is searchable
- **WHEN** the user searches sent-message history by session id or text
- **THEN** retained voice turns appear with transcript, assistant output,
  profile version, classification, timestamps, and available audio references
- **AND** a provider's live-session memory is not required to show or replay the
  sent turn

### Requirement: Queryable Context For Agents
Agent harnesses SHALL be able to query current Moa session, branch, turn,
profile, run, approval, receipt, and memory summary records from the gateway
store.

#### Scenario: Agent run starts
- **WHEN** the gateway starts a code-mode or execution-machine agent run
- **THEN** the run can receive or query the relevant Moa context identifiers
  instead of relying on chat transcript memory alone

#### Scenario: Browser task context is queryable
- **WHEN** Gemini Live or another gateway-side agent queues browser work
- **THEN** the gateway stores the browser task with session, branch, profile
  version, status, claim metadata, and extension receipts
- **AND** current session context exposes bounded recent browser tasks alongside
  voice turns, chat turns, provider events, profile status, and runs

### Requirement: Token-Protected Read Paths Stay In One User Scope
The current implementation SHALL treat conversation-memory reads as bearer-gated
single-user scope until hosted multi-user auth replaces the token-derived user
resolver.

#### Scenario: Stored conversation read without the gateway token
- **WHEN** a caller requests `GET /v1/sessions/{sessionId}/context`,
  `GET /v1/sessions/{sessionId}/turns`, `GET /v1/history/messages`,
  `GET /v1/voice/turns/{turnId}`, or
  `GET /v1/voice/audio/{sessionId}/{turnId}?kind=user|assistant` without the
  configured gateway bearer token
- **THEN** the gateway denies the read
- **AND** a single-use voice session ticket does not authorize those read paths

#### Scenario: Default shared session stays within one authenticated scope
- **WHEN** the gateway derives its current-user scope from the configured
  gateway token
- **THEN** the default shared session id stays inside that authenticated scope
- **AND** conversation-memory reads do not merge data across token scopes

### Requirement: Provider Event Normalization
The gateway SHALL normalize provider-specific voice events into Moa event types
for transcript, audio, interruption, completion, error, and profile application.

#### Scenario: Native provider emits provider-specific event
- **WHEN** a voice provider emits a transcript, audio, interruption, completion,
  or error event
- **THEN** the gateway stores a normalized Moa event and may also retain the raw
  provider event for debugging according to retention policy

### Requirement: Stored Memory Respects Redaction And Retention Boundaries
Conversation-memory records SHALL expose only Moa-owned fields and redacted
provider metadata. PCM retention SHALL follow the current storage boundary:
ordinary retained turns may expose token-protected audio refs when files exist,
while incognito turns and deleted PCM SHALL expose no durable audio bytes.

#### Scenario: Provider metadata includes an endpoint secret
- **WHEN** provider status or diagnostic metadata is stored with a turn or
  provider event
- **THEN** secret-bearing endpoint query parameters are redacted before the
  value is stored or returned

#### Scenario: Audio artifact is missing or was deleted
- **WHEN** a caller requests a user or assistant PCM artifact for a turn whose
  retained file is absent
- **THEN** the gateway returns no audio reference in the read model
- **AND** the direct audio read returns not found instead of synthesizing or
  guessing the artifact

### Requirement: Replayable Voice Evidence
The gateway SHALL be able to turn retained spoken turns into replayable QA
evidence records.

#### Scenario: Spoken turn is retained for QA
- **WHEN** voice evidence retention is enabled for a spoken turn
- **THEN** the gateway stores or references the user audio, expected or observed
  user transcript, assistant text, assistant audio reference, provider IDs,
  profile version, and test criteria under the session and turn identifiers

#### Scenario: Voice evidence is replayed
- **WHEN** a verification smoke replays a voice evidence fixture through the
  configured voice runtime
- **THEN** the gateway records the observed transcript, assistant text, assistant
  audio reference, and pass/fail verdict
- **AND** the verdict identifies whether the failure is in capture, STT,
  reasoning, TTS, storage, or comparison when that can be determined
