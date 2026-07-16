## ADDED Requirements

### Requirement: The macOS companion is summonable without observation

The macOS surface SHALL provide a menu-bar entry and a global summon shortcut
for a compact typed command panel. Summoning, dismissing, or submitting this
panel SHALL NOT implicitly read Accessibility context or capture pixels.

#### Scenario: User summons the assistant

- **WHEN** the user presses the registered global shortcut
- **THEN** the app shows and focuses its compact command panel
- **AND** no Accessibility grant, AX traversal, screen capture, or network call
  occurs until the user submits a turn

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
