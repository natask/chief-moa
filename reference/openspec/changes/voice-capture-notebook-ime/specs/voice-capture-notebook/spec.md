## ADDED Requirements

### Requirement: Spoken captures preserve audio before transcription
The system SHALL create a durable capture block linked to retained audio before
asynchronous transcription begins. Upload success and transcription success
SHALL be separate observable states, and a transcription failure SHALL NOT
delete or make a stored recording unavailable.

#### Scenario: Provider failure preserves a retryable capture
- **WHEN** Android completes an audio upload and the selected STT provider fails
- **THEN** the capture block remains linked to the stored audio
- **AND** the block reports a retryable transcription failure
- **AND** the product does not report the spoken content as lost

#### Scenario: Consecutive holds create distinct blocks
- **WHEN** the user completes three press-and-hold captures in sequence
- **THEN** the system creates three independently addressable capture blocks
- **AND** no agent run starts solely because any capture ended

### Requirement: Literal transcripts remain distinct from derived text
The system SHALL preserve the provider-produced literal transcript separately
from user edits, writing-skill rewrites, summaries, coaching feedback, and agent
outputs. Derived text SHALL record its parent and derivation kind and SHALL NOT
silently overwrite the literal transcript.

#### Scenario: Writing skill produces a reversible candidate
- **WHEN** the user applies a named writing skill to a transcribed block
- **THEN** the system stores the result as a derived revision
- **AND** the literal transcript remains unchanged and selectable

### Requirement: Android provides notebook inspection outside the overlay
The Android full app SHALL list and inspect capture blocks, including processing
state, retained audio, literal transcript, revisions, copy/edit controls,
retryable failures, retention or deletion controls, and agent dispatch links.
The overlay SHALL remain a compact capture and quick-action surface.

#### Scenario: User copies a completed transcript
- **WHEN** a capture block reaches `transcribed`
- **THEN** the user can open it in the Android notebook
- **AND** copy or edit the transcript without starting an assistant turn

### Requirement: Android IME inserts selected capture text through the focused editor
The Android keyboard surface SHALL be implemented as an input method service and
SHALL deliver the selected literal or derived text through the active focused
editor's `InputConnection`. It SHALL NOT use accessibility actions to simulate
typing into the destination application.

#### Scenario: Dictation commits to a normal text field
- **WHEN** the Moa IME is active in a normal text editor and the user completes
  voice dictation and selects a candidate
- **THEN** the IME commits that candidate through the active `InputConnection`
- **AND** the corresponding capture remains available according to retention
  settings

#### Scenario: Focus changes before commit
- **WHEN** the destination editor session changes after capture but before text
  commit
- **THEN** the IME does not insert into the new field without reconfirmation

### Requirement: Sensitive editors fail closed
The Android IME SHALL detect configured password and sensitive editor types
before capture. In such an editor it SHALL NOT record, upload, retain, rewrite,
or expose prior captured content.

#### Scenario: Password field refuses voice capture
- **WHEN** the Moa IME starts for a password editor
- **THEN** microphone capture and network transcription controls are unavailable
- **AND** no prior transcript candidate is displayed or committed

### Requirement: Agent dispatch is explicit and observable
Capture completion SHALL NOT imply agent execution. The user SHALL explicitly
select one or more capture revisions and a dispatch action before the gateway
creates agent work, and every accepted dispatch SHALL expose its run identifier
and lifecycle state.

#### Scenario: Selected block launches an agent
- **WHEN** the user explicitly dispatches one selected capture revision
- **THEN** the gateway creates an asynchronous agent run linked to that revision
- **AND** Android shows the run identifier and current lifecycle state

### Requirement: Orb dismissal is reversible and non-destructive
Dragging the Android orb to its visible dismissal target SHALL hide the overlay
surface without deleting capture blocks or silently disabling the underlying
service. Permanent disablement SHALL remain an explicit full-app or system
settings action.

#### Scenario: Drop on dismissal target hides only the orb
- **WHEN** the user drags the orb onto the visible hide target and releases it
- **THEN** the orb surface is removed
- **AND** stored and pending capture records remain intact
- **AND** the user can restore the orb through an explicit app or system control

### Requirement: Capture language state is explicit
Each transcription request SHALL use the user's explicit configured input
languages and SHALL record language/provider evidence on the capture block. A
capture SHALL NOT silently mutate the user's durable global language profile.

#### Scenario: Mixed English and Amharic capture
- **WHEN** English and Amharic are configured input languages and the user speaks
  a mixed-language capture
- **THEN** the block records those requested languages and observed provider
  evidence
- **AND** subsequent captures retain the same durable language configuration
  until the user explicitly changes it

### Requirement: Voice delivery mode is canonical and device-scoped
The gateway SHALL persist a versioned Ask, Note, or Coach selection per device
without changing the device's saved base persona. It SHALL expose authenticated
mode read, change, and version-history operations. Ask SHALL use normal response
policy. Note SHALL select the raw-audio storage path and forbid provider/model
work, assistant replies, and agent launch. Coach SHALL apply a bounded turn-only
coaching overlay while preserving the saved base persona.

#### Scenario: Note admission prevents provider work
- **WHEN** an authenticated client reads a Note selection before capture
- **THEN** the gateway returns `/v1/audio-notes` as the capture endpoint
- **AND** reports that provider work, assistant replies, and agent launch are forbidden

#### Scenario: Coach reverts cleanly to Ask
- **WHEN** a device changes from Coach to Ask
- **THEN** the next turn uses the saved base persona without the coaching overlay
- **AND** the version history retains both explicit changes
