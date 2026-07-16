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
- **AND** those controls remain independent of the transcript card above the orb

#### Scenario: User explicitly sends
- **WHEN** a tap-started draft is active and the user taps `↑`
- **THEN** Android commits that voice turn exactly once
- **AND** ends the draft capture loop

#### Scenario: User discards
- **WHEN** a tap-started draft is active and the user taps `X`
- **THEN** Android cancels capture and discards the draft locally
- **AND** submits no voice turn

#### Scenario: Orb tap sends through the shared commit path
- **WHEN** a tap-started draft is active and the user taps the orb again
- **THEN** Android commits the draft exactly once
- **AND** the visible `X` and `↑` controls remain available until commit begins

#### Scenario: Natural silence also sends
- **WHEN** speech has been heard and the user pauses for the endpointing window
- **THEN** Android commits the same draft exactly once
- **AND** the endpointing window is longer than the previous 700 ms threshold

### Requirement: Orb-Anchored Mobile Surface
The Android overlay SHALL keep at most one large interactive card visible and
keep that card wholly above the orb at all times, before and after the card's
content expands.

#### Scenario: Surface fits above the orb
- **WHEN** the chat or transcript card opens and has enough room above the orb
- **THEN** the entire card is placed above the orb with a visible gap

#### Scenario: Surface would not fit above the orb
- **WHEN** the card (at its measured height) cannot fit above the orb's current
  position
- **THEN** the orb is repositioned down just enough that the entire card plus
  gap stays on-screen above it
- **AND** the card is never placed below the orb

#### Scenario: Orb moves or the card remeasures with an open surface
- **WHEN** the user drags the orb while a card is open, or the open card's
  content grows or shrinks
- **THEN** the placement is recomputed continuously so the card stays wholly
  above the orb, repositioning the orb when required

#### Scenario: Whole card can be dismissed discoverably
- **WHEN** a chat or transcript card is open
- **THEN** the card shows a visible close control that dismisses the entire
  message surface in one tap
- **AND** swiping transcript rows away continues to work and closes the card
  once no rows remain

### Requirement: Outside-Tap Family Fade
The Android overlay SHALL treat the lion orb and its attached chat and voice
transcript surfaces as one fade family. A tap outside every family window SHALL
fade the whole family in place instead of closing any surface.

#### Scenario: Tap outside fades without closing
- **WHEN** the user taps outside the lion orb, the chat panel, and the voice
  transcript card
- **THEN** every visible family window fades to a dim opacity in place
- **AND** no surface is closed and no chat message, composer draft, transcript
  row, or live voice turn is cancelled or lost

#### Scenario: Touching the faded family restores it
- **WHEN** the family is faded and the user touches any family window
- **THEN** the whole family returns to full opacity
- **AND** that wake touch is consumed: it does not press a control, start a
  voice gesture, focus the composer, or swipe a transcript row

#### Scenario: Same gesture is not both outside and inside
- **WHEN** a single tap lands on one family window while sibling overlay
  windows report the same gesture as an outside touch
- **THEN** the family does not fade for that gesture

#### Scenario: Showing a surface wakes the family
- **WHEN** the chat panel or a fresh voice transcript card is opened while the
  family is faded
- **THEN** the family returns to full opacity before the surface shows

#### Scenario: Explicit close still closes
- **WHEN** the user uses an explicit close control (the panel's close button,
  Hide, drag-to-remove, or a collapse action)
- **THEN** the existing close behavior applies unchanged; only the outside tap
  is remapped from close to fade

#### Scenario: Keyboard interaction does not park the family
- **WHEN** the chat composer is focused and the keyboard/IME is up or being
  summoned
- **THEN** keyboard/IME interactions and other outside reports do not fade the
  family
- **AND** the fade behavior never hides the keyboard
- **AND** once the keyboard is dismissed or the composer loses focus, ordinary
  outside app taps fade the family again

#### Scenario: Keyboard dismissal is observed on every supported API level
- **WHEN** the user dismisses the keyboard with Back or by tapping the app
  underneath on API 26-29, where no IME-visibility inset signal exists
- **THEN** the keyboard hold releases (Back is seen pre-IME on the composer;
  window-focus loss accompanies the system hiding the IME) and ordinary
  outside taps fade the family again
- **AND** tapping the still-focused composer re-engages the hold when the IME
  re-appears
- **AND** the one unobservable pre-30 path — the IME's own internal hide
  affordance — fails conservative: the family stays bright and the keyboard is
  never hidden, until the next observable signal releases the hold

### Requirement: Start Placement Under The Finger
The Android app SHALL center the lion orb on the raw screen point of the
ACTION_UP touch that activated the Start assistant circle control, clamped only
to safe display bounds.

#### Scenario: Touch start places the lion under the finger
- **WHEN** the user activates Start assistant circle by touch
- **THEN** the lion appears centered on the touch's raw ACTION_UP screen
  coordinates
- **AND** the position is clamped only so the orb stays fully within safe
  display bounds, with no other snapping

#### Scenario: Touchless start falls back to the button center
- **WHEN** Start assistant circle is activated without a touch point
  (accessibility service, keyboard, or programmatic click)
- **THEN** the lion appears centered on the Start control's own on-screen
  center, clamped the same way

#### Scenario: Start while running repositions the lion
- **WHEN** Start assistant circle is pressed while the overlay service is
  already running
- **THEN** the existing lion moves to the newly requested center without
  restarting the service or closing any attached surface
- **AND** any open chat panel or transcript card re-anchors to the lion's new
  position through the same anchored positioning the drag gesture uses, with
  no draft, message, or transcript state lost

### Requirement: Native Black Overlay Surfaces
The Android overlay SHALL render its chat panel, voice transcript card, and
full-app surfaces as opaque true-black native surfaces.

#### Scenario: Cards are opaque true black
- **WHEN** the chat panel or voice transcript card renders
- **THEN** its card background is opaque true black with hairline borders
- **AND** underlying app content does not bleed through the card
- **AND** surface fills carry no color cast

### Requirement: User-Removable Overlay
The Android overlay SHALL provide discoverable local ways to remove the orb.

#### Scenario: Drag to remove
- **WHEN** the user drags the orb into the visible removal target and releases
- **THEN** Android removes the orb, every open card, and every control window in
  the same release, then stops the overlay service
- **AND** no overlay window visibly outlives the orb

#### Scenario: Explicit hide fallback
- **WHEN** the user taps Hide in the chat header or overlay notification
- **THEN** Android stops the overlay service and removes all overlay windows

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
