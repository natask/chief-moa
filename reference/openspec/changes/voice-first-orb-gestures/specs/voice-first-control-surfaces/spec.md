## ADDED Requirements

### Requirement: Android voice-first gestures manually control capture
When the Android `voice_first_gestures` preference is enabled, the overlay SHALL
use explicit user gestures to start and stop capture. Silence or assistant/model
output SHALL NOT dispose a normal manual capture. The gesture that starts a
toggle capture SHALL be the only toggle gesture that can send it.

#### Scenario: Single click toggles current-thread capture
- **WHEN** the voice-first Android flag is enabled and the user single-clicks
  the idle orb
- **THEN** Android starts capture on the current active thread
- **WHEN** the user later single-clicks that current-thread capture
- **THEN** Android stops and sends the turn exactly once

#### Scenario: Double-click toggles fresh-thread capture
- **WHEN** the user double-clicks the idle orb
- **THEN** Android starts capture with the explicit fresh-thread context action
- **WHEN** the user later single-clicks that fresh-thread capture
- **THEN** Android does not send it
- **WHEN** the user later double-clicks that fresh-thread capture
- **THEN** Android stops and sends the turn exactly once

#### Scenario: Fresh start cannot leak current capture
- **WHEN** current-thread capture is active and the user double-clicks
- **THEN** Android cancels that capture without sending
- **AND** starts a fresh-thread capture

#### Scenario: Hold is same-thread push-to-talk
- **WHEN** the user presses and holds the still orb past the hold threshold
- **THEN** Android starts capture on the current thread
- **AND** release stops and sends exactly once
- **AND** a large movement after capture starts cancels and escapes into drag

#### Scenario: Triple click opens chat without sending
- **WHEN** capture is active and the user triple-clicks
- **THEN** Android cancels it without sending
- **AND** opens chat with no hot mic

#### Scenario: Android draft state adds no disposition controls
- **WHEN** Android enters or leaves a voice-first capture state
- **THEN** no separate X or Send overlay control is attached beside the companion
- **AND** the state transition does not reserve side-control space or change the
  companion's settled x coordinate
- **AND** an active draft remains accessible through independent Send and Discard
  actions on the companion

#### Scenario: Flag off preserves the legacy contract
- **WHEN** the voice-first Android flag is disabled
- **THEN** a single tap opens chat
- **AND** double-click-and-hold remains the voice capture gesture

### Requirement: Browser voice-first gestures match Android
When `ageeVoiceFirstGesturesEnabled` is enabled, the browser mascot SHALL expose
the same single, hold, double, and triple gesture meanings as Android. It SHALL
NOT expose separate X/Send voice-draft controls.

#### Scenario: Browser single and double toggles are origin matched
- **WHEN** a single click starts current-thread capture
- **THEN** only a later single click stops and sends it
- **WHEN** a double-click starts fresh-thread capture
- **THEN** a later single click does not send it
- **AND** only a later double-click stops and sends it

#### Scenario: Browser double-click replaces current capture safely
- **WHEN** current-thread capture is active and the user double-clicks
- **THEN** the browser cancels it without sending
- **AND** starts fresh-thread capture

#### Scenario: Browser hold and triple-click are collision safe
- **WHEN** the user holds the still mascot
- **THEN** capture is push-to-talk and release sends exactly once
- **WHEN** the user triple-clicks while capture is active
- **THEN** the browser cancels without sending and opens chat

#### Scenario: Removed side controls cannot retain authority
- **WHEN** voice-first capture is active
- **THEN** no separate X or Send control is rendered beside the mascot
- **AND** transcript/chat cards do not own capture disposition
