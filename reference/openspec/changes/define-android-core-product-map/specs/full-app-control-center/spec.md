## ADDED Requirements

### Requirement: Setup And Health
The full Android app SHALL expose setup state for overlay permission, microphone permission, screen access, gateway health, and harness availability.

#### Scenario: Gateway configured
- **WHEN** the user opens the full app with a gateway URL configured
- **THEN** the app shows whether the gateway is reachable

#### Scenario: Harness status available
- **WHEN** the gateway exposes harness status
- **THEN** the app shows which configured harnesses are available for agent runs

#### Scenario: Missing Android access is visible
- **WHEN** overlay permission, microphone permission, or Screen access is missing
- **THEN** the setup surface lists the missing requirements
- **AND** it requests microphone access directly when Android allows it
- **AND** it opens the Android draw-over-apps settings for overlay permission
- **AND** it does not claim it can silently grant Accessibility access

#### Scenario: Restricted settings blocks Screen access
- **WHEN** Android prevents enabling Screen access because restricted settings
  are blocked
- **THEN** the setup surface tells the user to open App info for Aggie, tap the
  three-dot menu, choose Allow restricted settings, return, and enable Screen
  access
- **AND** it offers an App info button alongside the Screen access button

### Requirement: Session Inspection
The full Android app SHALL expose the current mobile session and recent voice turns.

#### Scenario: User opens sessions view
- **WHEN** the user opens the sessions area
- **THEN** the app shows the current session ID, branch, recent turns, and whether each turn became chat, control, agent, or multi-agent work

### Requirement: Run Inspection
The full Android app SHALL expose active and historical home-machine agent runs.

#### Scenario: Active runs exist
- **WHEN** one or more runs are queued or running
- **THEN** the app shows their harness, status, prompt preview, created time, and available controls

#### Scenario: Run has terminal status
- **WHEN** a run is completed, failed, timed out, or canceled
- **THEN** the app shows its final status and output preview

### Requirement: Intent Portfolio Inspection
The full Android app SHALL expose the gateway-owned canonical intent portfolio
without creating a second phone-local source of truth.

#### Scenario: Canonical intents exist
- **WHEN** the user refreshes the full app against a compatible gateway
- **THEN** the app shows each recent intent's lifecycle, objective, next step,
  blocker count, and linked run count

#### Scenario: Intent runtime is unavailable
- **WHEN** the configured gateway is older, unreachable, or does not expose the
  authenticated intent list projection
- **THEN** the app reports that the intent portfolio is unavailable
- **AND** it does not invent or display a phone-local replacement backlog

### Requirement: Approval And Receipt Inspection
The full Android app SHALL expose pending approvals and local action receipts.

#### Scenario: Approval is pending
- **WHEN** a phone-local action requires user confirmation
- **THEN** the full app can show the action summary, risk, reason, and approve/reject controls

#### Scenario: Receipts exist
- **WHEN** the user opens action history
- **THEN** the app shows recent local action receipts in timestamp order

### Requirement: Settings For Voice And Gateway
The full Android app SHALL let the user configure gateway URL, gateway token, trigger words, wake mode, and spoken reply preference.

#### Scenario: User disables spoken replies
- **WHEN** the user turns off spoken replies
- **THEN** voice turns still display full text while TTS remains silent

#### Scenario: Hard voice and language settings persist
- **WHEN** the user changes the assistant voice, heard language, or reply language
- **THEN** the gateway persists the change as a hard runtime profile setting
- **AND** the setting applies on later turns without restarting the gateway

#### Scenario: User scopes a profile setting
- **WHEN** the user asks to save a voice or language setting for this device
- **THEN** the gateway stores a device-scoped override for the current device id
- **AND** other devices continue to use the all-devices profile unless they have
  their own override
- **WHEN** the user asks to save the setting for all devices
- **THEN** the gateway updates the global profile used by every device without a
  device override

#### Scenario: Agent lists and validates profile options
- **WHEN** a surface or agent asks the gateway for supported profile options
- **THEN** the gateway returns a catalog of valid voices, voice tone metadata,
  voice aliases, and valid reply/heard language codes
- **AND** profile writes for voice, reply language, and heard languages persist
  only catalog-backed values
- **AND** heard and reply language fields support comma-separated language code
  lists
- **AND** the gateway derives provider-primary languages internally from the
  first selected code rather than exposing primary language as a separate user
  setting

#### Scenario: Mission agent lacks access
- **WHEN** the agent is blocked by missing permission, credentials, integration
  setup, local approval, or device capability
- **THEN** it names the specific access it needs instead of giving a flat refusal
- **AND** it still treats server/model output as a proposal until the owning
  device or integration returns a receipt

### Requirement: Android OTA Updates
The full Android app SHALL check the configured gateway for a newer app build and install only after local verification and user approval.

#### Scenario: Newer APK is available
- **WHEN** the gateway returns an Android update manifest with a higher version code than the installed app
- **THEN** the full app shows that an update is available

#### Scenario: User installs update
- **WHEN** the user chooses to install the available update
- **THEN** the app downloads the APK through the gateway token
- **AND** verifies the APK size and SHA-256 from the manifest
- **AND** opens Android's package installer instead of silently installing it

#### Scenario: Deploy records surface versions
- **WHEN** a gateway, Android OTA, or browser extension target deploy completes
- **THEN** the deploy marker records a monotonic deploy sequence, git SHA, and
  target version metadata
- **AND** Android OTA deploys expose a higher generated version code for new
  artifacts
- **AND** changed browser-extension deploys require the extension manifest
  version to advance after the first recorded extension deploy
