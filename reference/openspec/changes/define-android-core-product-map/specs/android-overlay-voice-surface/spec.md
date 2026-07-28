## ADDED Requirements

### Requirement: Always-Available Overlay Control
The Android app SHALL provide an overlay control that remains available above other apps after the user grants overlay permission.

#### Scenario: Start overlay from app
- **WHEN** the user grants overlay permission and taps start
- **THEN** the app displays a draggable assistant orb above the current Android screen

#### Scenario: Use another app while overlay is active
- **WHEN** the user leaves the Moa app
- **THEN** the assistant orb remains available without opening the full Moa app

#### Scenario: Multiple launch paths target the running overlay
- **WHEN** the app, assistant intent, or quick tile starts the overlay while it
  is already active
- **THEN** Android keeps one overlay service owner and one orb window
- **AND** routes the new invocation to that existing owner instead of attaching
  another orb

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
- **AND** after touch slop Android moves the companion, compact ribbons, and
  draft controls as one bounded overlay root with exactly one WindowManager
  layout submission per display frame
- **AND** transparent space outside that compact root remains touch-pass-through
- **AND** release or cancellation preserves the latest streamed transcript and
  voice-control state without creating or reattaching dependent windows

#### Scenario: Double-click-and-hold push-to-talk
- **WHEN** the user double-clicks and holds the orb while no voice turn is active
- **THEN** the app starts a push-to-talk voice turn after the second press is held
- **AND** displays a live transcript overlay
- **AND** releasing the orb submits the best available speech without waiting
  for the continuous-loop silence timeout
- **AND** normal release drains captured audio and commits the owned voice
  controller exactly once, even if transport activity changes during release
- **AND** Android gesture cancellation or hold-drag cancellation submits no
  commit and retains explicit cancel semantics

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
- **AND** begins one latched manual voice turn when overlay and microphone permissions are
  available
- **AND** does not submit on silence or automatically re-arm after a reply

#### Scenario: Launch from earbud voice command action
- **WHEN** Android launches Moa through `android.intent.action.VOICE_COMMAND`
  from an earbud or headset assistant gesture
- **THEN** the app starts the overlay service
- **AND** begins a latched manual voice turn using the same overlay transcript
  path as an orb tap

#### Scenario: Repeated invocation commits the latched turn
- **WHEN** an assistant-, voice-command-, or launcher-started voice turn is active
- **AND** the user invokes the same entry again or single-clicks the orb
- **THEN** Android commits that turn exactly once
- **AND** does not re-arm the microphone after the reply

#### Scenario: Hold remains push-to-talk after invocation
- **WHEN** an invocation-started manual turn is active and the user holds the orb
- **THEN** Android replaces it locally with push-to-talk capture
- **AND** release commits the push-to-talk turn exactly once

#### Scenario: Assistant launch before required permissions
- **WHEN** Android launches Moa through an assistant or voice-command action
  before overlay or microphone permission is available
- **THEN** the app shows a bounded permission hint without pretending capture
  started

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

### Requirement: Launcher Opens The Overlay
The normal Android launcher entry SHALL invoke the same single overlay voice
surface as Android Assistant rather than opening the full control center.

#### Scenario: User taps the app icon
- **WHEN** the required overlay and microphone permissions are available and the
  user taps the A.G. launcher icon
- **THEN** Android starts or reuses the one overlay service
- **AND** starts or commits the current latched manual turn
- **AND** does not render `MainActivity`

### Requirement: Recoverable Voice Failure
Unexpected voice failures SHALL remain recoverable from the compact voice
surface without reviving an intentionally superseded session.

#### Scenario: Unexpected voice failure is recoverable
- **WHEN** an active voice turn fails unexpectedly
- **THEN** the overlay shows a concise failure state with an accessible
  `Record again` control
- **AND** activating that control starts exactly one fresh reviewable voice
  draft
- **AND** stale or repeated activation cannot start another capture

#### Scenario: Intentional voice teardown is quiet
- **WHEN** Android cancels or replaces a voice session because the user
  discarded, closed, or started a replacement turn
- **THEN** close and error callbacks from the superseded session do not render
  a generic voice failure
- **AND** no retry affordance remains authorized for that superseded session

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

#### Scenario: Orb tap cannot silently send
- **WHEN** a tap-started draft is active and the user taps the orb again
- **THEN** Android does not commit the draft
- **AND** the visible `X` and `↑` controls remain the disposition authority

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

### Requirement: User-Removable Overlay
The Android overlay SHALL provide discoverable local ways to remove the orb.

#### Scenario: Drag to remove
- **WHEN** the user drags the orb into the visible removal target and releases
- **THEN** Android removes the orb, every open card, and every control window in
  the same release, then stops the overlay service
- **AND** no overlay window visibly outlives the orb

#### Scenario: Move while speech capture is active
- **WHEN** the user drags the compact overlay while speech capture is active
- **THEN** Android moves the complete overlay unit without canceling or ending capture
- **AND** releasing a push-to-talk drag commits through the normal release path
- **AND** Android does not expose or arm the removal target until speech capture has ended

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

#### Scenario: Idle orb stays visible without dominating the screen
- **WHEN** the orb is idle and not touched
- **THEN** Android renders the default orb at seventy percent of its 96dp base
  window and approximately thirty percent opacity
- **AND** pressing or dragging the orb restores full opacity for the gesture

#### Scenario: User changes orb size
- **WHEN** the user changes the orb-size setting while the overlay is active
- **THEN** Android resizes the existing orb window without creating a second one
- **AND** updates its drag bounds and anchored card placement for the new size

### Requirement: Stable Scrollable Voice Transcript
The Android overlay SHALL give the voice transcript a stable viewport instead
of resizing the card for each partial or completed turn.

#### Scenario: Current turn reads as a conversation
- **WHEN** the current user and assistant bubbles are visible around the companion
- **THEN** the user bubble sits above and to the right with its left edge anchored
  to the companion centerline when space permits
- **AND** the assistant bubble sits below and to the left with its right edge
  anchored to that centerline when space permits
- **AND** either bubble clamps inward rather than painting through a display edge

#### Scenario: Listening is visible before recognition
- **WHEN** a system assistant invocation starts a valid microphone turn
- **THEN** the user bubble appears immediately with a blinking caret
- **AND** provider partials replace text in that same bubble
- **AND** only the newest unstable token is accented until final recognition
- **AND** an empty placeholder is neither copyable nor admitted to history

#### Scenario: Spoken response follows device playback
- **WHEN** hosted assistant audio is enabled for a response
- **THEN** an empty assistant bubble with a blinking caret appears after user commit
- **AND** its collapsed text advances from the PCM/text segment ledger according to the AudioTrack playback head, coalesced to display frames
- **AND** network receipt and provider `audio_done` do not claim that text was heard
- **AND** expanded view retains the complete display response independently of the shorter spoken response
- **AND** cancellation, replacement, barge-in, or a stale turn cannot advance the current bubble

#### Scenario: Empty or failed turn removes placeholders
- **WHEN** a turn ends with no speech, fails, or is intentionally cancelled before text exists
- **THEN** Android removes its empty live placeholders
- **AND** does not create transcript-history entries for them

#### Scenario: Bubble text remains bounded and readable
- **WHEN** current-turn text exceeds five wrapped lines
- **THEN** the collapsed bubble shows at most the newest five lines
- **AND** tapping expands a bounded reading viewport that scrolls vertically

#### Scenario: User transcript actions stay explicit
- **WHEN** the user bubble contains transcript text
- **THEN** exactly one Copy action remains visible without expanding or holding it
- **AND** a separate History action opens the full history surface
- **AND** double-tap does not reveal duplicate copy controls or trigger history
- **AND** Android accessibility exposes Expand, Copy, and History as independently
  invokable actions on API 26 and later

#### Scenario: Transcript content grows
- **WHEN** transcript rows exceed the fixed transcript viewport
- **THEN** the card keeps the same measured height
- **AND** the transcript scrolls to reveal the latest content

#### Scenario: User controls reply delivery in the overlay
- **WHEN** the transcript surface is visible
- **THEN** its header exposes a Text/Voice delivery control
- **AND** changing it immediately updates hosted-audio playback for the open
  voice session
- **AND** persists the spoken-reply preference for later sessions

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

### Requirement: Mobile Voice End-to-End Benchmark Evidence
The working interpretation of the user's undefined term "BNC" SHALL be
documented as mobile voice end-to-end benchmark/confidence evidence until the
user supplies a different expansion. Android SHALL measure this evidence
locally without granting the gateway new telemetry authority.

#### Scenario: Successful audible turn
- **WHEN** microphone capture starts, the user commits, a result arrives, and
  hosted audio is enabled
- **THEN** Android records monotonic capture, commit, first-result, playback,
  confirmed device-drain, and terminal timings
- **AND** audible success is counted only after the AudioTrack playback head
  reaches every accepted PCM frame

#### Scenario: Playback does not drain
- **WHEN** the playback head does not reach every accepted PCM frame within the
  bounded drain timeout
- **THEN** Android stops playback without first flushing away measurement
  evidence
- **AND** records a playback drain timeout rather than a completed audible turn

#### Scenario: Rolling on-device diagnostics
- **WHEN** voice turns complete, fail, or are intentionally torn down
- **THEN** Android retains at most 100 bounded outcome samples in private app
  storage
- **AND** the full app shows completion, failure, teardown, audible-success,
  p50, and p95 end-to-end evidence
- **AND** samples contain no transcript, audio, URL, token, raw session id, raw
  turn id, or exception content

#### Scenario: Lifecycle ordering
- **WHEN** a turn reaches a terminal outcome
- **THEN** later asynchronous callbacks cannot append new stages
- **AND** an unexpected active socket close is a connection failure while an
  intentional user cancel, replacement, or destroy remains a teardown
