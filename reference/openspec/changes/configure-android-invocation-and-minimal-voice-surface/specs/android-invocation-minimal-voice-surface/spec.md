## ADDED Requirements

### Requirement: Android exposes distinct invocation behaviors
Android SHALL represent Dictation, Assistant, and Hands-free as distinct typed
invocation behaviors. Dictation SHALL finalize literal transcription without
reasoning or TTS. Assistant SHALL use the reasoning-capable current-thread voice
path. Hands-free SHALL use the reasoning-capable bounded re-arm loop and SHALL
retain a persistent microphone-hardware indicator and an immediate stop path.

#### Scenario: Existing defaults remain safe
- **WHEN** the user has not customized invocation routing
- **THEN** the normal launcher starts or commits Dictation
- **AND** `ASSIST`, `VOICE_ASSIST`, and `VOICE_COMMAND` start or commit Assistant
- **AND** neither path silently enters Hands-free

#### Scenario: Hands-free is invoked explicitly
- **WHEN** the user chooses the Hands-free launcher shortcut or another
  explicitly mapped supported trigger
- **THEN** Android starts the bounded hands-free loop
- **AND** the microphone-hardware indicator remains visible through every re-arm
- **AND** stop prevents any later automatic re-arm

### Requirement: Supported triggers are configurable and honest
The full Android app SHALL list only triggers the installed Android version and
launcher expose to the application. It SHALL let the user map each supported
trigger to Dictation, Assistant, Hands-free, open full app, or no action, and
SHALL provide a reset to the safe defaults. Unsupported hardware chords,
launcher sequences, wake words, and OS-reserved gestures SHALL be shown as
unavailable or experimental rather than claimed as configured.

#### Scenario: User changes a supported trigger
- **WHEN** the user maps an app-owned shortcut to Assistant
- **THEN** the next activation routes to exactly one Assistant invocation
- **AND** the saved mapping does not change the meaning of system-owned triggers
  Android did not delegate to Ag

#### Scenario: Context-sensitive sequence is not implemented
- **WHEN** the user reviews a proposed sequence such as Assistant active followed
  by launcher double-click
- **THEN** the settings surface labels the sequence experimental or unavailable
- **AND** Android keeps the ordinary trigger mapping until a separately tested
  sequence contract is accepted

### Requirement: Launcher shortcuts expose the daily behaviors
The Android launcher shortcut menu SHALL expose Settings, Dictation, Assistant,
and Hands-free when the launcher supports that many shortcuts. Settings SHALL
open the full app without starting capture. Each voice shortcut SHALL route
through the same typed invocation coordinator as every other entry path.

#### Scenario: User long-presses the launcher icon
- **WHEN** the launcher displays Ag shortcuts
- **THEN** the menu offers the supported subset of Settings, Dictation,
  Assistant, and Hands-free
- **AND** selecting one creates no duplicate overlay owner or microphone session

### Requirement: Presentation style is independent from invocation behavior
Android SHALL let the user select Companion or Minimal ring presentation
without changing Dictation, Assistant, Hands-free, session, branch, provider,
or retention semantics. Switching presentation SHALL not start, send, cancel,
or refile a turn.

#### Scenario: User selects Minimal ring
- **WHEN** a later invocation starts capture
- **THEN** Android renders the Minimal ring instead of the mascot and ribbons
- **AND** the selected invocation behavior remains unchanged

#### Scenario: Presentation changes during an active turn
- **WHEN** the user changes presentation while capture or playback is active
- **THEN** Android preserves the exact owned turn and local control state
- **AND** it does not create another microphone, socket, provider turn, or
  conversation turn

### Requirement: Minimal ring is visible, subtle, and touch-bounded
Minimal presentation SHALL use separate thin edge windows rather than one
full-screen overlay window. It SHALL show capture, paused, thinking, speaking,
and error states, and while the microphone hardware is open it SHALL visibly
respond to bounded smoothed input level without changing layout. The display
center and every coordinate outside rendered controls SHALL remain touch-
pass-through.

#### Scenario: User interacts with the app underneath
- **WHEN** Minimal presentation is active and the user touches a coordinate
  outside a rendered edge or control
- **THEN** no Ag window owns that coordinate
- **AND** the underlying application receives the touch

#### Scenario: Microphone captures speech
- **WHEN** the microphone hardware is open and input level changes
- **THEN** the ring provides subtle bounded motion or luminance feedback
- **AND** the feedback does not expose transcript content, resize windows, or
  flicker between provider partials

#### Scenario: Microphone is not open
- **WHEN** capture is paused, stopped, or failed before microphone ownership
- **THEN** the ring does not represent the microphone as recording
- **AND** the user can distinguish paused from idle and error

### Requirement: Companion controls are explicit and non-duplicated
In Companion presentation the mascot SHALL own Send or conversational turn
handoff. One adjacent Pause/Resume control and one adjacent Cancel control SHALL
be available while their current phase permits them. A populated user or
assistant message SHALL contain exactly one Copy action for that message. The
compact surface SHALL NOT add a second Send button, duplicate Copy rail, History
rail, settings panel, or provider-key form.

#### Scenario: User pauses an unsubmitted capture
- **WHEN** the gateway advertises the complete voice-draft capability and the
  user activates Pause during capture
- **THEN** Android stops microphone capture without sending or discarding
- **AND** Resume appends to the same draft in order
- **AND** no reasoning, tool, TTS, broker, memory, or canonical turn writer runs
  before Send

#### Scenario: User cancels an unsubmitted capture
- **WHEN** the user activates Cancel while capture is active or paused
- **THEN** Android discards without `commit_turn`
- **AND** the compact surface returns to a non-recording state

#### Scenario: User copies a message
- **WHEN** a populated user or assistant message is visible and the user
  activates its Copy action
- **THEN** Android copies that exact finalized message
- **AND** no provider, model, tool, history mutation, or send action runs

#### Scenario: User sends from the companion
- **WHEN** an unsubmitted current-thread capture is active and the user
  activates the mascot
- **THEN** Android sends the owned capture exactly once
- **AND** no separate Send control is rendered

### Requirement: Assistant turn handoff is explicit
During assistant speech or generation, Android SHALL treat activation of the
mascot for a new user turn as an explicit steering boundary, stop future old-
generation output, and give the turn to the user without cancelling detached
agent runs. Pause and Resume SHALL affect local assistant playback only unless a
separately receipted gateway control is invoked. Cancel SHALL stop the
conversational generation or playback according to the current owned turn and
preserve the gateway's incomplete-turn evidence contract.

#### Scenario: User takes the turn from the assistant
- **WHEN** the assistant is speaking and the user activates the mascot
- **THEN** Android stops old local playback immediately
- **AND** opens a replacement user capture with a steering relation
- **AND** late old-generation frames cannot extend the current visible or
  audible result

#### Scenario: Detached work remains active
- **WHEN** the user cancels or steers a conversational turn while an agent run is
  detached and active
- **THEN** the agent run is not cancelled, paused, or retargeted implicitly

### Requirement: Edge gestures remain an explicit experiment
Edge gestures SHALL be disabled by default. An experimental build MAY offer the
candidate map of inward-left for Pause/Resume, inward-right for Send or turn
handoff, and outward from either owned edge for Cancel/Stop, but SHALL not ship
that map as the stable default until physical-phone tests prove navigation,
touch pass-through, discoverability, reversibility, and accessibility. Copy
SHALL NOT be assigned to an edge gesture without a later explicit decision.

#### Scenario: Stable configuration
- **WHEN** the user has not opted into the edge-gesture experiment
- **THEN** inward and outward edge motions have no hidden Ag meaning
- **AND** Android system Back and navigation retain their ordinary behavior

#### Scenario: Experimental gesture is ambiguous
- **WHEN** a motion does not cross the configured distance, velocity, and
  dominant-axis thresholds
- **THEN** Ag performs no pause, send, handoff, cancel, stop, or copy operation

#### Scenario: Accessibility fallback
- **WHEN** TalkBack is enabled or edge gestures are unavailable
- **THEN** every permitted Pause/Resume, Cancel/Stop, and Send/turn-handoff
  operation remains reachable through a named visible or accessibility action

### Requirement: Provider selection preserves gateway authority
Android SHALL render reasoning and voice choices from the gateway's bounded
profile-options and provider-capability catalog. It SHALL show configured,
unavailable, and unsupported choices honestly. It SHALL NOT accept, persist, or
transmit raw provider keys except through a gateway-owned short-lived account or
credential action that never returns the secret to Android.

#### Scenario: Provider is not configured
- **WHEN** a catalog entry such as an OpenAI-, Anthropic-, Gemini-, or xAI-backed
  option lacks gateway credentials or a required capability
- **THEN** Android shows it as unavailable with the reported reason
- **AND** selecting it does not mutate the active profile

#### Scenario: User selects a configured provider profile
- **WHEN** the gateway reports a compatible configured choice and the user
  selects it
- **THEN** Android requests a versioned gateway profile update
- **AND** the next admitted turn uses the gateway-confirmed profile version
- **AND** the Android voice-session event contract remains provider-neutral

### Requirement: Conflicting active clauses are superseded narrowly
For Android Companion presentation, this capability SHALL supersede
`voice-first-orb-gestures` and `define-android-core-product-map` only where they
prohibit adjacent Pause/Resume and Cancel controls, and SHALL supersede
`quiet-companion-controls` only where it limits the compact actions to Copy and
voice-reply on/off. It SHALL preserve origin-matched single/double capture
semantics until trigger usability work replaces them, preserve bounded ribbons,
and preserve History and Settings in the full app.

#### Scenario: Implementer encounters the older no-side-control clause
- **WHEN** implementing this accepted Companion control set
- **THEN** the mascot remains Send/turn handoff and the two adjacent controls are
  Pause/Resume and Cancel
- **AND** no separate X/Send review rail or duplicate compact history surface is
  restored
