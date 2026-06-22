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

### Requirement: Provider Event Normalization
The gateway SHALL normalize provider-specific voice events into Moa event types
for transcript, audio, interruption, completion, error, and profile application.

#### Scenario: Native provider emits provider-specific event
- **WHEN** a voice provider emits a transcript, audio, interruption, completion,
  or error event
- **THEN** the gateway stores a normalized Moa event and may also retain the raw
  provider event for debugging according to retention policy

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
