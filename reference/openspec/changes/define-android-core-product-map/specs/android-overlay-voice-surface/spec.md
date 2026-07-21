## ADDED Requirements

### Requirement: Always-Available Overlay Control
The Android app SHALL provide an overlay control that remains available above other apps after the user grants overlay permission.

#### Scenario: Start overlay from app
- **WHEN** the user grants overlay permission and taps start
- **THEN** the app displays a draggable assistant orb above the current Android screen

#### Scenario: Use another app while overlay is active
- **WHEN** the user leaves the Moa app
- **THEN** the assistant orb remains available without opening the full Moa app

### Requirement: Tap-Based Voice Loop
The overlay SHALL make the primary voice loop available through simple orb gestures.

#### Scenario: Single tap opens chat menu
- **WHEN** the user single taps the orb while no command speech is active
- **THEN** the app opens the chat menu for typed input
- **AND** it does not start, stop, or submit a voice turn

#### Scenario: Click-and-hold drags orb
- **WHEN** the user presses the orb, holds, and moves it
- **THEN** the app repositions the orb
- **AND** it does not start voice capture or toggle the chat menu

#### Scenario: Double-click-and-hold push-to-talk
- **WHEN** the user double-clicks and holds the orb while no voice turn is active
- **THEN** the app starts a push-to-talk voice turn after the second press is held
- **AND** displays a live transcript overlay
- **AND** releasing the orb submits the best available speech without waiting
  for the continuous-loop silence timeout

#### Scenario: Continuous loop commits after short silence
- **WHEN** the user starts a continuous voice launch path and speaks a short utterance
- **THEN** the app auto-submits after a short post-speech silence window
- **AND** keeps the continuous loop eligible to re-arm after the assistant reply

### Requirement: System Assistant Button Launch
The Android app SHALL expose the overlay voice loop through standard Android
assistant and voice-command entry points used by system gestures and compatible
earbud or headset buttons.

#### Scenario: Launch from Android assist action
- **WHEN** Android launches Moa through `android.intent.action.ASSIST` or
  `android.intent.action.VOICE_ASSIST`
- **THEN** the app starts the overlay service
- **AND** begins a voice turn when overlay and microphone permissions are
  available

#### Scenario: Launch from earbud voice command action
- **WHEN** Android launches Moa through `android.intent.action.VOICE_COMMAND`
  from an earbud or headset assistant gesture
- **THEN** the app starts the overlay service
- **AND** begins a voice turn using the same overlay transcript path as an orb
  tap

#### Scenario: Assistant launch keeps listening after replies
- **WHEN** Android launches Moa through an assistant or voice-command action
  and the spoken response finishes
- **THEN** the current response card clears
- **AND** the overlay starts the next listening turn without requiring a new
  assistant-button launch
- **AND** a user stop gesture cancels the continuous loop locally

#### Scenario: Assistant launch before required permissions
- **WHEN** Android launches Moa through an assistant or voice-command action
  before overlay or microphone permission is available
- **THEN** the app opens the setup surface
- **AND** preserves the user's intent to start the overlay after permissions are
  granted

#### Scenario: Media button is not an assistant command
- **WHEN** a normal headset media play/pause button is routed to the active media
  session
- **THEN** Moa does not rely on that media-button event to start an assistant
  turn

### Requirement: Transcript Visibility
The Android app SHALL show current speech text while the user is speaking.

#### Scenario: Partial recognition received
- **WHEN** Android speech recognition emits partial text
- **THEN** the overlay updates visible transcript text without opening the full chat panel

#### Scenario: Turn is submitted
- **WHEN** the current voice turn is submitted
- **THEN** the transcript overlay closes or resets for the next loop

#### Scenario: Assistant response replaces user transcript
- **WHEN** the assistant response starts for a submitted voice turn
- **THEN** the visible user transcript fades out
- **AND** the assistant response appears in the same compact voice surface
- **AND** previous voice-turn messages are not shown in that surface

### Requirement: Reviewable Tap Voice Draft
When voice-first gestures are enabled, the Android overlay SHALL treat a tap
voice turn as a reversible draft rather than an implicit submission.

#### Scenario: Tap starts a draft
- **WHEN** the user taps the idle orb
- **THEN** the overlay begins voice capture
- **AND** immediately shows `X` to discard on the left of the orb and `↑` to
  Send on the right of the orb
- **AND** those controls remain independent of the transcript card above or below

#### Scenario: User explicitly sends
- **WHEN** a tap-started draft is active and the user taps `↑`
- **THEN** Android commits that voice turn exactly once
- **AND** ends the draft capture loop

#### Scenario: User discards
- **WHEN** a tap-started draft is active and the user taps `X`
- **THEN** Android cancels capture and discards the draft locally
- **AND** submits no voice turn

#### Scenario: Orb tap cannot silently send
- **WHEN** a tap-started draft is active and the user taps the orb again
- **THEN** Android does not commit the draft
- **AND** the visible `X` and `↑` controls remain the disposition authority

### Requirement: Orb-Anchored Mobile Surface
The Android overlay SHALL keep at most one large interactive card visible and
place that card predictably relative to the orb.

#### Scenario: Surface fits above the orb
- **WHEN** the chat or transcript card opens and has enough room above the orb
- **THEN** the entire card is placed above the orb with a visible gap

#### Scenario: Surface must flip below
- **WHEN** the card cannot fit above the orb
- **THEN** the entire card is placed below the orb and clamped to the display

#### Scenario: Orb moves with an open surface
- **WHEN** the user drags the orb while a card is open
- **THEN** the card follows and recomputes its above-or-below placement

### Requirement: User-Removable Overlay
The Android overlay SHALL provide discoverable local ways to remove the orb.

#### Scenario: Drag to remove
- **WHEN** the user drags the orb into the visible removal target and releases
- **THEN** Android stops the overlay service and removes the orb and open card

#### Scenario: Explicit hide fallback
- **WHEN** the user taps Hide in the chat header or overlay notification
- **THEN** Android stops the overlay service and removes all overlay windows

#### Scenario: Remove target stays unobtrusive and fully visible
- **WHEN** the user begins dragging the orb
- **THEN** Android shows a fully measured removal target above system navigation
- **AND** keeps it barely visible until the orb enters the drop zone
- **AND** moving the orb away disables and dims the target again

### Requirement: Low-Interruption Orb Presence
The Android overlay SHALL remain available without visually dominating the
current app.

#### Scenario: Idle orb is barely visible
- **WHEN** the orb is idle and not touched
- **THEN** Android renders it at approximately ten percent opacity
- **AND** pressing or dragging the orb restores full opacity for the gesture

### Requirement: Stable Scrollable Voice Transcript
The Android overlay SHALL give the voice transcript a stable viewport instead
of resizing the card for each partial or completed turn.

#### Scenario: Transcript content grows
- **WHEN** transcript rows exceed the fixed transcript viewport
- **THEN** the card keeps the same measured height
- **AND** the transcript scrolls to reveal the latest content

#### Scenario: User controls reply delivery in the overlay
- **WHEN** the transcript surface is visible
- **THEN** its header exposes a Text/Voice delivery control
- **AND** changing it persists the spoken-reply preference for the next turn

### Requirement: Minimal Spoken Interruption
The Android app SHALL separate displayed response text from spoken response text.

#### Scenario: Gateway returns display and speak fields
- **WHEN** the gateway returns a response with `display` and `speak`
- **THEN** the overlay records or displays the full `display` text
- **AND** only speaks the shorter `speak` text when voice replies are enabled

#### Scenario: Gateway returns empty speak text
- **WHEN** a voice turn starts agent work and returns no `speak` text
- **THEN** the app displays status without speaking a confirmation

### Requirement: Spoken Profile Control
The Android Live voice path SHALL route spoken profile-control requests through
the gateway profile-control path instead of leaving them as provider-only chat.

#### Scenario: User changes voice or language while using Live voice
- **WHEN** the user says a profile-control request such as "use the Kore voice"
  or "only speak English and Amharic"
- **THEN** Android submits the finalized transcript to `/v1/voice/turns`
- **AND** the gateway records a `profile_control` turn and persists the new
  profile version
- **AND** the next Live voice session starts with that effective profile and the
  prior session context

#### Scenario: User asks to sample every voice
- **WHEN** the user says a voice-sampling request such as "go through all the
  voices" or "say hello in every voice"
- **THEN** Android submits the finalized transcript to `/v1/voice/turns`
- **AND** the gateway returns a `voice_sampler` action containing the ordered
  supported voice catalog and per-voice sample text
- **AND** Android plays the samples by opening one text-only Live voice session
  per voice with a session-only voice override
- **AND** the saved profile voice remains unchanged unless the user chooses a
  specific voice
