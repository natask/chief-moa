## ADDED Requirements

### Requirement: Persistent Overlay Voice Session
The Android overlay SHALL keep a voice session active until the user stops it,
the overlay is dismissed, required permission is unavailable, or the gateway
returns a terminal unrecoverable error.

#### Scenario: Turn completes
- **WHEN** a spoken turn completes and the assistant response is delivered
- **THEN** the overlay remains available for the next spoken turn
- **AND** the session state returns to ready or listening instead of dismissing
  after one conversation

#### Scenario: Overlay launched through assistant path
- **WHEN** Moa is launched through Android assistant or voice-command intent
- **THEN** the same persistent overlay voice session behavior applies

### Requirement: Normalized Voice Runtime States
The overlay SHALL render normalized runtime states that do not depend on a
specific provider implementation.

#### Scenario: Runtime state changes
- **WHEN** the gateway emits listening, thinking, speaking, interrupted, ready,
  error, or recovering state
- **THEN** Android updates the overlay state and controls consistently

### Requirement: Transcript Visibility
The overlay SHALL show partial and final user transcript text and assistant
display output when available.

#### Scenario: Partial transcript arrives
- **WHEN** the voice runtime emits a partial transcript
- **THEN** the overlay displays it as provisional text

#### Scenario: Final transcript arrives
- **WHEN** the voice runtime emits the final transcript for a turn
- **THEN** the overlay replaces provisional text with the final transcript
- **AND** stores the transcript under the current session and turn identifiers

### Requirement: Interruption And Barge-In
The voice runtime SHALL support user interruption of assistant playback or
speaking state when the selected provider or fallback runtime supports it.

#### Scenario: User speaks during assistant audio
- **WHEN** the user starts speaking while assistant audio is playing
- **THEN** Moa stops or ducks current playback
- **AND** captures the new user speech as a new turn or interruption event

#### Scenario: User opts into background assistant speech
- **WHEN** the user tells the browser voice session to keep talking while the
  user talks
- **THEN** the browser client records a session-scoped background-speech policy
- **AND** starting the next spoken turn opens a distinct gateway voice turn
  without stopping already queued assistant playback
- **AND** each spoken turn keeps the same durable session identifier while using
  a distinct turn identifier

#### Scenario: Provider lacks native barge-in
- **WHEN** the selected provider does not support native barge-in
- **THEN** Moa uses the best available local playback stop and new-turn capture
- **AND** reports the provider limitation in runtime status

### Requirement: Audio-Reactive Orb Signal
The Android orb SHALL have a voice-level signal derived from local microphone
audio or normalized gateway events.

#### Scenario: User volume changes while listening
- **WHEN** microphone PCM chunks are captured during listening
- **THEN** Android updates the orb visualization using a smoothed voice-level
  value without changing layout size

#### Scenario: Assistant is speaking
- **WHEN** assistant audio is playing
- **THEN** Android can render a distinct speaking state without conflating it
  with user microphone activity
