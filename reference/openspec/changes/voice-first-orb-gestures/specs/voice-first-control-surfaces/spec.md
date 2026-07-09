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
- **AND** a later single tap sends the current utterance after the multi-click
  window if no rapid second tap supersedes it

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
