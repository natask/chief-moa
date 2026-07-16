## ADDED Requirements

### Requirement: Android voice-first tap chords retain reviewable drafts
When the Android `voice_first_gestures` preference is enabled, the overlay SHALL
retain its Android-owned reviewable-draft contract. The browser change SHALL NOT
silently change Android behavior or its rollout boundary.

#### Scenario: Android reviewable draft remains separate
- **WHEN** the Android voice-first preference is enabled and the user taps the orb
- **THEN** Android uses its visible local draft controls
- **AND** browser click-toggle semantics do not alter Android disposition

#### Scenario: Android legacy mode remains separate
- **WHEN** the Android voice-first preference is disabled
- **THEN** Android retains its existing legacy gesture behavior

### Requirement: Browser mark gestures directly control canonical capture
The browser extension SHALL always map single, double, triple, hold, and drag
gestures to one canonical capture contract without a user-visible gesture
setting or stored rollout preference.

#### Scenario: Single click toggles current-thread capture
- **WHEN** the user single-clicks the idle mascot
- **THEN** the browser starts a non-auto-committing current-thread capture
- **WHEN** the user single-clicks again
- **THEN** the browser stops and sends that capture exactly once

#### Scenario: Either click stops fresh-thread capture
- **WHEN** the user double-clicks the idle mascot
- **THEN** the browser starts a fresh-thread capture while prior generation may continue
- **WHEN** the user then single-clicks or double-clicks
- **THEN** the browser stops and sends the fresh-thread capture exactly once

#### Scenario: Triple click opens chat without cancelling work
- **WHEN** the user triple-clicks the mascot
- **THEN** the browser opens chat
- **AND** does not cancel an active capture or provider generation

#### Scenario: Hold and drag keep their distinct meanings
- **WHEN** the user holds the still mascot and releases
- **THEN** the browser performs push-to-talk and sends on release
- **WHEN** movement crosses the drag threshold
- **THEN** the browser repositions the mascot without submitting a voice turn

### Requirement: Microphone recovery is explicit and guided
The browser extension SHALL distinguish extension-runtime startup failure from
actual microphone permission denial and SHALL keep recovery visible before any
navigation.

#### Scenario: Runtime receiver is not initially ready
- **WHEN** the offscreen voice receiver is not ready at first contact
- **THEN** the browser waits for the bounded readiness handshake and retries
- **AND** does not label the receiver failure as denied microphone permission

#### Scenario: Microphone failure stays in place
- **WHEN** extension-owned microphone capture fails
- **THEN** the browser reports the truthful failure in the active surface
- **AND** does not open Options automatically

#### Scenario: User requests microphone setup
- **WHEN** the visible recovery action is selected
- **THEN** the browser opens or focuses Options on the microphone setup steps
- **AND** highlights the user-operated Grant microphone control
- **AND** never claims the agent can grant Chrome permission itself
