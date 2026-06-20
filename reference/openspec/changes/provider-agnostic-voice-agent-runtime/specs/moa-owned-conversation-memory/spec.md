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

### Requirement: Provider Event Normalization
The gateway SHALL normalize provider-specific voice events into Moa event types
for transcript, audio, interruption, completion, error, and profile application.

#### Scenario: Native provider emits provider-specific event
- **WHEN** a voice provider emits a transcript, audio, interruption, completion,
  or error event
- **THEN** the gateway stores a normalized Moa event and may also retain the raw
  provider event for debugging according to retention policy
