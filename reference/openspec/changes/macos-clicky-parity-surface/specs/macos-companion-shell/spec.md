## ADDED Requirements

### Requirement: The macOS companion uses one explicitly invoked capture surface

The macOS surface SHALL provide a menu-bar entry and a global summon shortcut
for one compact command panel. App launch and the first summon SHALL show that
same panel and begin a latched voice capture. A second summon SHALL commit the
active capture rather than hiding it. Explicit dismissal SHALL cancel capture
before hiding. These actions SHALL NOT implicitly read Accessibility context or
capture pixels.

#### Scenario: User summons the assistant

- **WHEN** the user presses the registered global shortcut
- **THEN** the app shows and focuses its sole compact command panel
- **AND** begins one visible microphone capture against the configured gateway
- **AND** no Accessibility grant, AX traversal, or screen capture occurs

#### Scenario: User repeats the summon

- **WHEN** the compact panel has an active capture and the user invokes the
  global shortcut again
- **THEN** the same capture is committed exactly once
- **AND** the panel remains visible for transcript or failure feedback

#### Scenario: User dismisses the surface

- **WHEN** capture is active and the user presses Escape or the close control
- **THEN** capture is canceled before the sole panel is hidden
- **AND** no second or persistent settings panel is opened

### Requirement: Assistant replies remain on the native audio surface

Committed native voice turns SHALL request assistant-voice delivery. The Mac
surface SHALL render bounded assistant text and play only gateway-announced,
bounded PCM16 assistant audio. Summoning SHALL NOT raise a browser, infer page
context, or add repetitive interface cue sounds.

#### Scenario: Gateway streams an assistant reply

- **WHEN** a committed native turn receives assistant text and valid PCM frames
- **THEN** the same compact panel renders the text and plays the frames in order
- **AND** no browser window or captured page becomes part of the turn

#### Scenario: Audio metadata is invalid

- **WHEN** the gateway announces an unsupported format or an oversized frame
- **THEN** playback fails visibly and safely
- **AND** the bytes are not decoded as executable or JSON instructions

### Requirement: Capture state is visible and tactile without cue noise

The summon command and microphone control SHALL toggle between start and commit.
While the microphone is active, the compact panel SHALL retain an unmistakable
boundary treatment. Invocation SHALL provide a short visual pulse and native
haptic feedback where available. The surface SHALL NOT play dedicated start,
pause, continue, cancel, copy, or finalize cue sounds.

#### Scenario: User toggles capture

- **WHEN** the user summons once and later summons again
- **THEN** the first invocation starts visible capture and the second commits it
- **AND** each transition is confirmed visually and, where supported, tactually
- **AND** no non-assistant audio cue is played

### Requirement: Typed turns use the configured Aggie gateway

The macOS command panel SHALL send bounded typed turns to authenticated
`POST /v1/chat` at the canonical user-configured gateway origin and SHALL show
the returned text as inert presentation data.

#### Scenario: A configured user submits text

- **WHEN** a non-empty bounded prompt is submitted with a valid origin and
  signed-in Ag device bearer
- **THEN** exactly one request is sent with `source: moa-macos`
- **AND** the reply appears without executing any returned local action

#### Scenario: Destination redirects or configuration is invalid

- **WHEN** the gateway redirects, the origin contains an endpoint path, the
  token is missing, or a size bound is exceeded
- **THEN** the turn fails visibly without forwarding the body or executing work

### Requirement: Provider credentials remain outside the Mac client

The macOS surface SHALL store only its Ag account device session and gateway
origin. It SHALL NOT
store raw OpenAI, Anthropic, Gemini, Vertex, or integration credentials, and it
SHALL NOT extract OAuth material from local vendor CLIs.

#### Scenario: User connects the Mac app

- **WHEN** the user signs in through the browser-backed device flow
- **THEN** the origin may be stored in app preferences and the revocable Ag
  device session is stored in the portable owner-only Ag auth file
- **AND** the Mac shows that it is waiting for browser approval with the bound code
- **AND** the browser reports approval before reporting completed app connection
- **AND** both surfaces visibly confirm when the Mac consumes the approved session
- **AND** no provider key or vendor CLI OAuth token is requested or persisted

### Requirement: Apple clients narrowly persist the Ag device session

The macOS surface SHALL NOT persist gateway infrastructure tokens, provider
credentials, or integration credentials. It MAY use one portable, owner-only
`AG_HOME/auth.json` file (default `~/.ag/auth.json`) for the revocable Ag
account device session. Writes SHALL be atomic and existing symlinks or
non-regular files SHALL fail closed. Non-secret origins and session identifiers
MAY remain in app preferences.

#### Scenario: A new process starts or the user disconnects

- **WHEN** the app starts, explicitly disconnects, stops the proactive surface,
  or terminates
- **THEN** the Ag device session is restored only from its portable auth file
- **AND** explicit sign-out deletes that file and clears the in-memory session

### Requirement: Voice capture provides local, non-retained level feedback

While a voice turn is active, the macOS companion SHALL derive a bounded
normalized level from the same PCM16 frames being sent to the gateway and show
it as a waveform. The level path SHALL NOT retain or separately upload audio.

#### Scenario: Active capture receives PCM

- **WHEN** the capture adapter emits a valid PCM16 frame
- **THEN** the command surface updates a bounded `0...1` waveform sample
- **AND** the existing gateway audio frame is unchanged
- **AND** stopping, canceling, or resetting capture clears the waveform

### Requirement: Durable session history stays gateway-owned

The compact macOS companion SHALL provide an authenticated in-place view of
recent canonical history for its current session. It SHALL read
`GET /v1/history/messages` from the configured Chief Moa gateway and SHALL NOT
create a client-local history database or place the bearer token in a URL.

#### Scenario: A connected user opens history

- **WHEN** the user selects the history control
- **THEN** the app requests only the current session's bounded recent messages
- **AND** sends the session-only bearer token in the authorization header
- **AND** renders returned text as inert, non-executable presentation

#### Scenario: History is unavailable

- **WHEN** the gateway is unconfigured, unauthorized, unavailable, or returns
  malformed content
- **THEN** the panel reports the failure without leaking the token or falling
  back to a private client history
