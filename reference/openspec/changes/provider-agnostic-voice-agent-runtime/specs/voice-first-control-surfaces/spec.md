## ADDED Requirements

### Requirement: Default Cross-Surface Voice Control Contract
Moa SHALL keep one canonical default voice-control contract across the Android
orb and browser mark surfaces.

#### Scenario: Android default gestures
- **WHEN** the voice-first flag is off on Android
- **THEN** a single tap opens the chat menu
- **AND** a first-press hold with movement repositions the orb without starting
  capture
- **AND** double-click-and-hold is the push-to-talk path

#### Scenario: Browser default commands
- **WHEN** the voice-first flag is off in the browser
- **THEN** `Cmd+,` and `Ctrl+,` open the text-intent field
- **AND** `Cmd+.` and `Ctrl+.` toggle or commit a manual voice turn on tap
- **AND** holding `Cmd+.` or holding the second mark click uses push-to-talk

### Requirement: Flag-Gated Voice-First Contract
When the voice-first flag is enabled, the Android orb and browser mark SHALL
switch to one canonical voice-first contract instead of each inventing a
surface-specific variant.

#### Scenario: Voice-first mode is enabled
- **WHEN** `voice_first_gestures` or `ageeVoiceFirstGesturesEnabled` is enabled
- **THEN** single click toggles hands-free talk mode with barge-in
- **AND** a still first-press hold is push-to-talk
- **AND** double-click opens the demoted chat surface
- **AND** drag and resize behavior remain available

### Requirement: Spoken Surface Control Results Stay Structured
Voice-control turns SHALL return exact structured action names instead of
surface-specific ad hoc text.

#### Scenario: User asks the assistant to stop talking
- **WHEN** a spoken turn is classified as control
- **THEN** the turn returns a structured control action with `type: "control"`
  and `name: "stop"`
- **AND** the surface uses that structured result to stop playback without
  inferring a hidden local action from free text
