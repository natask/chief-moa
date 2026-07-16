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
- **AND** Android shows native Cancel to the left of the orb and native Send to
  its right
- **AND** a later single tap does not send the current utterance
- **AND** only the visible Send control commits the draft

#### Scenario: Double tap starts a parallel voice session
- **WHEN** the voice-first Android flag is enabled and the user double-taps the
  orb
- **THEN** Android starts capture with a distinct local voice-session identity
- **AND** starts the next voice turn with the explicit fresh-thread client
  context action
- **AND** if a prior message is visible, does not reuse, clear, or replace its
  identity or visible presentation

#### Scenario: Single tap ends a double-tap-started session
- **WHEN** a double-tap-started Android voice session is capturing
- **AND** the user single-taps the orb
- **THEN** Android stops capture and commits the buffered utterance exactly once
- **AND** does not start an ordinary single-tap draft
- **AND** does not treat the tap as the first click of another chord

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

### Requirement: Android native dark overlay interaction
When voice-first gestures are enabled, Android SHALL render overlay actions with
platform-native interactive controls and SHALL reserve the orb/grab-line band
from content overlap.

#### Scenario: Native dark controls are shown
- **WHEN** Android shows Cancel, Send, grab, or removal actions
- **THEN** each action uses a native Android control with native pressed feedback
- **AND** exposes an accessibility role, label, enabled state, and content
  description
- **AND** uses the overlay's black/dark visual treatment

#### Scenario: Content remains above the interaction band
- **WHEN** a transcript, reply, generated image, composer, or status changes size
  or the orb moves
- **THEN** Android lays out the complete content surface above the orb/grab-line
  band with a visible gap
- **AND** no content covers or crosses that band

#### Scenario: Drag removal clears the overlay atomically
- **WHEN** the user releases the orb over the bottom removal target
- **THEN** Android stops active overlay capture and playback
- **AND** removes the orb, grab line, content surface, composer, draft controls,
  status, and removal target
- **AND** leaves no detached overlay window visible

### Requirement: Browser voice-first drafts match Android disposition controls
The browser extension SHALL, when `ageeVoiceFirstGesturesEnabled` is enabled,
start a reviewable voice draft whose cancel and Send controls flank the mascot
and remain independent of the text/result panel.

#### Scenario: Browser click starts a reviewable draft
- **WHEN** the browser voice-first flag is enabled and the user clicks the idle mascot
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
