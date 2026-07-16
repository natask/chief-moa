## ADDED Requirements

### Requirement: Android voice-first gestures use one durable thread
When `voice_first_gestures` is enabled, Android SHALL keep ordinary voice
capture on the active durable thread. Silence, the orb, and the visible Send
control MAY converge on the same idempotent commit operation.

#### Scenario: Single tap starts or sends
- **WHEN** the user single-taps the idle orb
- **THEN** Android starts capture on the active thread
- **WHEN** the user single-taps while that capture is active
- **THEN** Android commits the turn exactly once

#### Scenario: Silence sends a completed utterance
- **WHEN** speech has been detected and the post-speech silence reaches the
  endpointing threshold
- **THEN** Android commits the same draft exactly once
- **AND** a later orb or Send tap cannot duplicate it

#### Scenario: Double tap never replaces the thread
- **WHEN** the user double-taps while idle
- **THEN** Android starts or continues voice on the active durable thread
- **AND** does not issue a fresh-thread context action
- **WHEN** capture is already active
- **THEN** double tap neither cancels nor commits that capture

#### Scenario: Triple tap is the hard interrupt
- **WHEN** the user triple-taps during capture, playback, or an active response
- **THEN** Android stops that active voice work without sending an uncommitted draft
- **AND** preserves prior transcript/history text
- **AND** a fourth tap and beyond do nothing

#### Scenario: Draft controls remain explicit alternatives
- **WHEN** a tap-started draft is active
- **THEN** Android renders native X and Send controls beside the orb
- **AND** X cancels an uncommitted draft locally
- **AND** Send invokes the same idempotent commit as silence or an orb tap

### Requirement: Streaming transcripts are authoritative snapshots
Android SHALL treat streaming partial hypotheses as cumulative snapshots and
the final hypothesis as authoritative.

#### Scenario: Provider corrects a word
- **WHEN** a partial changes from `draw the lion` to `draw the line`
- **THEN** the visible transcript is `draw the line`
- **AND** the superseded word is not appended

### Requirement: Session termination distinguishes intent
Android SHALL distinguish an intentional local cancel from an unexpected remote
socket close.

#### Scenario: Intentional cancel is quiet
- **WHEN** Android locally cancels or supersedes a voice session
- **THEN** it does not show a connection-dropped error
- **AND** a transport failure racing graceful socket close does not show a
  voice-turn-failed error
- **WHEN** the same transport failure occurs before any local termination
- **THEN** Android reports the genuine failure

#### Scenario: Unexpected remote close retains evidence
- **WHEN** a committed voice session closes remotely before turn completion
- **THEN** Android keeps the recognized utterance visible
- **AND** reports the close code while keeping native Send visible
- **WHEN** the user taps Send
- **THEN** Android consumes retry admission exactly once
- **AND** routes the preserved transcript without duplicating its chat row

### Requirement: Browser converges on the same chord
The browser voice-first surface SHALL converge on the same single/double/triple
meanings and idempotent send behavior. Browser delivery is a separate lane from
this Android implementation unit.

#### Scenario: Browser follow-up retains the durable thread
- **WHEN** the browser voice-first lane adopts this contract
- **THEN** double click does not create a fresh thread
- **AND** triple click is the hard interrupt
