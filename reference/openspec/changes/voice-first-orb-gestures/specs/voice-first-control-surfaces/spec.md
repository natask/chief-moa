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

### Requirement: Browser voice-first drafts match Android disposition controls
The browser extension SHALL use a reviewable voice draft as the canonical mark
interaction. Its cancel and Send controls SHALL flank the mascot and remain
independent of the text/result panel. This behavior SHALL NOT depend on a
user-visible feature flag, setting, or previously stored preference.

#### Scenario: Browser click starts a reviewable draft
- **WHEN** the user clicks the idle browser mascot
- **THEN** the browser starts a non-auto-committing voice draft
- **AND** shows `X` to the mascot's left and `↑` to its right

#### Scenario: Browser mascot cannot silently send
- **WHEN** a browser voice draft is active and the user clicks the mascot again
- **THEN** the draft remains active
- **AND** no commit is sent

#### Scenario: Browser side controls own disposition
- **WHEN** the user clicks `X`
- **THEN** the browser cancels and discards the draft locally
- **WHEN** the user instead clicks `↑`
- **THEN** the browser commits that voice turn exactly once

#### Scenario: Fresh install uses the canonical browser gesture
- **WHEN** the extension starts with no prior voice-gesture storage value
- **THEN** a mascot click starts the reviewable voice draft
- **AND** the Options surface exposes no control for restoring the legacy click map

#### Scenario: Multi-click cannot become an Options shortcut
- **WHEN** the user performs the supported single or multi-click voice gestures
- **THEN** the extension routes only the documented voice, fresh-thread, or text-surface intent
- **AND** it does not open Options unless a surfaced permission recovery action requires it
