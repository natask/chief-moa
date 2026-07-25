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

### Requirement: Typed turns use the configured Aggie gateway

The macOS command panel SHALL send bounded typed turns to authenticated
`POST /v1/chat` at the canonical user-configured gateway origin and SHALL show
the returned text as inert presentation data.

#### Scenario: A configured user submits text

- **WHEN** a non-empty bounded prompt is submitted with a valid origin and
  Keychain token
- **THEN** exactly one request is sent with `source: moa-macos`
- **AND** the reply appears without executing any returned local action

#### Scenario: Destination redirects or configuration is invalid

- **WHEN** the gateway redirects, the origin contains an endpoint path, the
  token is missing, or a size bound is exceeded
- **THEN** the turn fails visibly without forwarding the body or executing work

### Requirement: Provider credentials remain outside the Mac client

The macOS surface SHALL store only its gateway connection state. It SHALL NOT
store raw OpenAI, Anthropic, Gemini, Vertex, or integration credentials, and it
SHALL NOT extract OAuth material from local vendor CLIs.

#### Scenario: User connects the Mac app

- **WHEN** the user saves a gateway origin and bearer token
- **THEN** the origin is stored in app preferences and the bearer token is
  stored in Keychain
- **AND** no provider key or vendor CLI OAuth token is requested or persisted
