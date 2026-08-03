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

#### Scenario: Admit a stored audio note without provider or agent work

- **GIVEN** an authenticated caller names an existing retained audio note
- **WHEN** it posts the note id, an explicit idempotency key, and bounded source
  metadata to `/v1/capture-blocks`
- **THEN** the gateway creates one stable capture block in `queued` processing
  state and preserves the exact `audio_note_id`
- **AND** an exact retry returns the same block without duplicate creation or
  processing events
- **AND** conflicting reuse of the idempotency key fails closed
- **AND** the request invokes no STT, reasoning, TTS, tool, assistant, or agent
  provider

#### Scenario: Consecutive holds create distinct blocks
- **WHEN** the user completes three press-and-hold captures in sequence
- **THEN** the system creates three independently addressable capture blocks
- **AND** no agent run starts solely because any capture ended

#### Scenario: Background transcription survives gateway restart

- **GIVEN** provider-backed capture transcription is explicitly enabled
- **WHEN** the gateway starts with queued blocks or a prior worker's expired lease
- **THEN** one bounded scheduler claims eligible blocks outside every upload,
  create, and retry request handler
- **AND** cross-process stream locking, unique worker leases, and local in-flight
  deduplication prevent duplicate provider calls
- **AND** health distinguishes queued work, active leases, in-flight processing,
  provider availability, and sanitized failure evidence
- **AND** unavailable providers or unsupported media never delete retained audio

### Requirement: Literal transcripts remain distinct from derived text
The system SHALL preserve the provider-produced literal transcript separately
from user edits, writing-skill rewrites, summaries, coaching feedback, and agent
outputs. Derived text SHALL record its parent and derivation kind and SHALL NOT
silently overwrite the literal transcript.

#### Scenario: Streaming provider repeats or overlaps a hypothesis

- **WHEN** a streaming transcription provider redelivers a final result during
  retry or reconnect, or a rotated stream begins with words already finalized
  by the prior stream
- **THEN** the gateway identifies repeated provider segments idempotently and
  reconciles meaningful boundary overlap in original order
- **AND** the canonical turn, capture block, clipboard output, and submitted
  message each contain one copy of the spoken passage
- **AND** short deliberate repetitions remain literal speech

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

### Requirement: Browser desktop dictation skips assistant work
The browser surface SHALL support an explicitly invoked dictation session that
uses the configured speech-recognition languages, stores the canonical literal
transcript, and performs no reasoning, TTS, or agent dispatch. A browser-owned
shortcut MAY start or finish this session and make a successful final transcript
available on the clipboard. The OS-wide native assistant summon SHALL NOT be
claimed by this browser dictation lifecycle.

The extension worker SHALL own the one active browser dictation lifecycle.
Browser tabs SHALL be views of that shared state, not independent session
authorities. A global finish invocation from a different tab SHALL commit the
active dictation rather than creating a second recorder.

#### Scenario: Browser dictation produces paste-ready text
- **WHEN** the user invokes browser dictation, speaks English, Amharic, or both,
  and invokes it again to finish
- **THEN** the gateway returns the literal transcript without a model reply
- **AND** the browser copies that transcript to the clipboard
- **AND** no reasoning, TTS, or agent run begins

#### Scenario: User explicitly copies the completed dictation again
- **WHEN** a completed dictation card contains a successful final transcript
- **THEN** the card exposes one Copy control bound to that exact final transcript
- **AND** pressing it replaces the clipboard and shows
  `Copied — clipboard replaced`
- **AND** a clipboard failure preserves the transcript and leaves the copy
  action available to retry

#### Scenario: Another tab finishes the active dictation
- **WHEN** dictation starts from one browser tab and the user invokes the global
  command while another tab is active
- **THEN** the extension commits the already-active dictation session
- **AND** it does not start a competing voice session in the newly active tab
- **AND** both tabs can render the same worker-owned lifecycle as passive views

#### Scenario: A late tab hydrates shared dictation state
- **WHEN** an extension surface loads while dictation is already active
- **THEN** it reads the current worker-owned state
- **AND** it does not claim microphone or session ownership solely by loading

### Requirement: Completed browser dictation becomes a literal capture
The gateway SHALL asynchronously project each stored, completed
transcription-only browser voice turn into one deterministic queryable capture
block.
The block SHALL preserve the bounded literal transcript, transcript completeness,
source surface, language/provider provenance, and retained audio reference when
available. The projection SHALL NOT delay the terminal dictation event.

The gateway SHALL append one idempotent routing proposal for that block with
route `file_only`, classification `unclassified`, `executable: false`, and
`model_used: false`. This proposal is durable evidence for later review, not an
intent decision or execution request.

#### Scenario: Clipboard delivery is independent of projection
- **WHEN** a transcription-only browser turn completes successfully
- **THEN** the canonical turn can finish and the browser can copy its literal
  transcript without waiting for capture projection
- **AND** the completed turn is subsequently queryable as one capture block

#### Scenario: Capture routing remains inert
- **WHEN** the gateway creates the routing proposal for a completed dictation
- **THEN** the proposal is `file_only` and `unclassified`
- **AND** it cannot execute an action or launch an agent
- **AND** no model is invoked to derive the proposal

#### Scenario: Reconciliation does not duplicate a capture
- **WHEN** startup reconciliation observes a completed transcription-only turn
  that was already projected
- **THEN** the same deterministic capture identity is retained
- **AND** no duplicate capture block or routing proposal is appended

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
- **AND** a streaming-session attempt terminates with the same storage-only
  guidance before provider construction, provider socket startup, streaming STT,
  or conversational audio-file creation

#### Scenario: Coach reverts cleanly to Ask
- **WHEN** a device changes from Coach to Ask
- **THEN** the next turn uses the saved base persona without the coaching overlay
- **AND** the version history retains both explicit changes
