## ADDED Requirements

### Requirement: Android voice-first tap chords route continue, new, and chat
When the Android `voice_first_gestures` preference is enabled, the overlay SHALL
map quick orb tap chords to distinct user intents: single tap continues the
current voice thread, double tap starts a fresh voice thread, and triple tap
opens the chat surface. The default flag-off Android contract SHALL remain tap
for chat and double-click-and-hold for voice.

#### Scenario: Single tap continues the current voice thread
- **WHEN** the voice-first Android flag is enabled and the user single-taps the
  orb while idle
- **THEN** Android starts hands-free voice on the current active thread
- **AND** Android shows `X` to the left of the orb and `↑` to its right
- **AND** a later single tap does not send the current utterance
- **AND** only the visible `↑` commits the draft

#### Scenario: Double tap starts a fresh voice thread
- **WHEN** the voice-first Android flag is enabled and the user double-taps the
  orb
- **THEN** Android cancels any just-started or pending current-thread voice loop
- **AND** Android starts the next voice turn with the explicit fresh-thread
  client context action

#### Scenario: Triple tap opens chat without leaving a hot mic
- **WHEN** the voice-first Android flag is enabled and the user triple-taps the
  orb
- **THEN** Android cancels any milliseconds-old fresh voice loop created by the
  double tap
- **AND** Android opens the chat surface

#### Scenario: Flag off preserves the legacy contract
- **WHEN** the voice-first Android flag is disabled
- **THEN** a single tap opens chat
- **AND** double-click-and-hold remains the voice capture gesture

### Requirement: Browser mark gestures directly control canonical capture
The browser extension SHALL always map single, double, triple, and hold gestures
to one canonical capture contract without a user-visible gesture setting.

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

#### Scenario: Microphone failure stays in place
- **WHEN** extension-owned microphone capture fails
- **THEN** the browser reports the failure in the current surface
- **AND** does not open Options automatically
