## ADDED Requirements

### Requirement: Meaningful action is engine-routed
The proof of this slice SHALL be that the rendered output originated from the
engine, not merely that output rendered — establishing the thin-client → engine
route. The extension SHALL reach the engine for the command and describe paths
rather than acting on its own.

#### Scenario: Reply provenance is the engine
- **WHEN** the overlay renders a command or describe result with a gateway configured
- **THEN** that result demonstrably originated from the engine endpoint (`/v1/voice/turns` or `/v1/chat`), confirming the action was routed through the engine

### Requirement: Command round trip through gateway
The extension SHALL render command replies that originate from the configured
gateway `/v1/voice/turns` endpoint.

#### Scenario: Command reply from gateway
- **WHEN** the user opens the overlay via Cmd+, and submits a command with a gateway configured
- **THEN** the reply rendered in the overlay originates from `/v1/voice/turns`

### Requirement: Browser surface is not visible chat history
The extension SHALL present a one-current-intent surface rather than a visible
chat transcript. Typed replies SHALL render in the result stack above the
command input, and assistant replies, errors, and voice events SHALL NOT clear
or replace the user's current input draft. Durable turn history SHALL remain
gateway-owned context and SHALL be retrieved only when the user asks for it
through an intent.

#### Scenario: Typed reply preserves the draft
- **WHEN** the user opens the text surface with Cmd+, and submits an intent
- **THEN** the assistant reply or error renders above the command input
- **AND** the command input still contains whatever draft text was present
  before the response arrived

#### Scenario: Voice shows live feedback above the input
- **WHEN** the user starts a browser voice turn with Cmd+.
- **THEN** the extension keeps the command input surface available for typing
- **AND** displays partial/final user transcript feedback above the input while
  the user speaks and while the turn is processing
- **AND** streams assistant text above the input instead of writing it into the
  command input
- **AND** it does not clear or replace any typed input draft during listening,
  commit, done, or error states
- **AND** it does not show older chat-history turns unless the user explicitly
  asks for history through an intent

### Requirement: Describe round trip through gateway
The extension SHALL render page descriptions that originate from the configured
gateway `/v1/chat` endpoint.

#### Scenario: Describe reply from gateway
- **WHEN** the user runs "describe page" with a gateway configured
- **THEN** the description rendered in the overlay originates from `/v1/chat`

### Requirement: Visible gateway failure
The extension SHALL surface gateway connection and authorization failures to the
user rather than failing silently.

#### Scenario: Unreachable or unauthorized gateway
- **WHEN** the gateway is unreachable or rejects the token
- **THEN** a clear error message renders in the overlay

### Requirement: Browser voice uses gateway streaming voice
The extension SHALL route browser voice through the configured gateway streaming
voice protocol and SHALL NOT use browser-native speech recognition or browser
text-to-speech as the production voice path.

#### Scenario: Browser voice session ticket
- **WHEN** the extension has a configured gateway URL and token
- **THEN** it can mint a short-lived `/v1/voice/sessions` ticket from the gateway
- **AND** use that ticket for a browser WebSocket connection without exposing the
  long-lived gateway token in the WebSocket URL

#### Scenario: Browser microphone audio reaches the gateway voice provider
- **WHEN** the user starts a browser voice turn
- **THEN** the extension captures microphone PCM16 audio from an extension-owned
  offscreen document and streams it to
  `/v1/voice/sessions`
- **AND** assistant audio rendered in the browser originates from the gateway
  streaming voice response

#### Scenario: Browser voice auto-commits on silence
- **WHEN** the user starts a browser voice turn and speaks
- **THEN** the extension commits the turn after speech silence without requiring
  a second click or hotkey press
- **AND** conversation mode re-arms listening after the assistant reply unless
  the user explicitly stops it

#### Scenario: Browser mark single click opens chat menu
- **WHEN** the user single clicks the browser Moa mark
- **THEN** the extension opens the chat menu for typed input
- **AND** it does not start, stop, or submit a voice turn

#### Scenario: Cmd/Ctrl+Comma matches browser mark single click
- **WHEN** the user presses Cmd+, or Ctrl+, while the browser content keydown
  listener and the Chrome `commands` listener may both receive the shortcut
- **THEN** the extension opens the same typed command/chat surface as a single
  click on the browser Moa mark
- **AND** the duplicate deliveries are idempotent and leave one typed surface
  open
- **AND** the shortcut does not start, stop, commit, or submit a voice turn

#### Scenario: Browser mark click-and-hold drags
- **WHEN** the user presses the browser Moa mark, holds, and moves it
- **THEN** the extension repositions the mark
- **AND** it does not start voice capture or toggle the chat menu

#### Scenario: Browser mark quick double-click opens chat menu
- **WHEN** the user double-clicks the browser Moa mark but releases before the
  push-to-talk hold threshold
- **THEN** the extension opens the chat menu for typed input
- **AND** it does not start, stop, or submit a voice turn

#### Scenario: Browser mark double-click-and-hold push-to-talk commits on release
- **WHEN** the user double-clicks and holds the browser Moa mark
- **THEN** the extension starts a manual gateway voice session after the second
  press is held
- **AND** the browser background worker disables silence auto-commit for that
  session
- **AND** releasing the mark commits the current speech turn immediately
- **AND** the manual turn does not re-arm the microphone after the assistant
  reply

#### Scenario: Website does not own the microphone grant
- **WHEN** the overlay starts voice on a website
- **THEN** the page content script does not call `getUserMedia`
- **AND** any microphone approval belongs to the extension origin, not the
  current website

#### Scenario: Browser offscreen microphone capture uses AudioWorklet
- **WHEN** the extension captures microphone audio from the offscreen document
- **THEN** the offscreen capture path uses `AudioWorkletNode` plus an extension
  owned worklet module to collect audio frames
- **AND** the production capture path does not use deprecated
  `ScriptProcessorNode`/`createScriptProcessor`
- **AND** the background worker receives PCM chunks from the offscreen document
  before forwarding them to the gateway voice WebSocket

#### Scenario: Extension microphone capture is blocked
- **WHEN** Chrome blocks microphone capture in the extension offscreen document
- **THEN** the overlay renders a visible microphone permission error
- **AND** the error tells the user to grant microphone access to the Aggie
  extension from Options or Chrome extension settings
- **AND** the failure is treated as non-recoverable for that voice turn instead
  of silently respawning Live voice

#### Scenario: Voice WebSocket sends only while open and current
- **WHEN** a voice session is revoked, closed, or replaced while microphone
  capture and auto-commit callbacks are still unwinding
- **THEN** the background worker checks that the socket is the current open
  session before sending JSON or audio frames
- **AND** callbacks for closed sessions return a normal "not open" result
  instead of attempting to send on a CLOSING/CLOSED WebSocket

#### Scenario: Browser page has one Aggie root after reinjection
- **WHEN** Chrome reinjects the content script after extension reload, browser
  restart, update, or a manual script reinjection
- **THEN** the page contains exactly one top-level Aggie root by default
- **AND** stale duplicate `#agee-root` nodes are removed
- **AND** the extension does not inject Aggie roots into iframes

### Requirement: Browser agent ownership is shared across tabs
The extension SHALL maintain one active browser-agent owner across tabs for a
configured engine session. The owner state SHALL live in shared
extension/gateway-facing state, not only in one page content script.

#### Scenario: Starting work in another tab transfers ownership
- **WHEN** a browser agent turn, branch task, ambient capture, or voice session
  starts in tab B while tab A is the active browser-agent owner
- **THEN** tab B becomes the active owner in shared extension state
- **AND** tab A receives revocation, stops listening, stops queued assistant
  playback, and clears browser-local task cues
- **AND** tab A may show passive status but does not capture microphone audio,
  play assistant speech, or claim local task cues for the active owner

#### Scenario: Owner state follows page work
- **WHEN** a browser task has no explicit target URL
- **THEN** the extension prefers the active owner tab's page URL before falling
  back to the foreground tab
- **AND** the latest owner status/result is stored in shared extension state so
  another tab can answer progress or completion questions without visible chat
  scrollback
