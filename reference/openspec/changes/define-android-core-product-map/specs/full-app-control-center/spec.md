## ADDED Requirements

### Requirement: History-First Everyday Surface
The full Android app SHALL open to a plain history surface rather than an
operations dashboard.

#### Scenario: User opens AG normally
- **WHEN** the user opens the full Android app
- **THEN** the app shows canonical conversation history first
- **AND** it does not show gateway, run, receipt, benchmark, release, sizing, or
  gesture diagnostics unless the user explicitly opens Setup & developer
- **AND** opening the app does not start, stop, expand, or collapse the overlay

#### Scenario: User copies a finalized turn
- **WHEN** a retained turn contains user or assistant text
- **THEN** the text is selectable
- **AND** one explicit Copy turn action writes the exact retained text to the
  Android clipboard and shows a visible copied receipt

#### Scenario: User needs setup or diagnostics
- **WHEN** the user chooses Setup & developer
- **THEN** the existing permission, gateway, release, action, sizing, gesture,
  session, run, receipt, and benchmark controls remain available there
- **AND** the user can return to History through persistent top-level navigation

### Requirement: Explicit Control-Center Entry
The full Android app SHALL remain available for setup and deep inspection
without being the default launcher surface.

#### Scenario: User explicitly requests the app UI
- **WHEN** the user opens the overlay notification, uses the launcher Settings
  shortcut or Quick Settings entry, or says an explicit command such as "show
  me the app UI"
- **THEN** Android opens the full control center
- **AND** collapses large overlay surfaces while keeping the single overlay
  service available

### Requirement: Android Display Name
The Android surface SHALL present the app name as exactly `AG`, without dots,
while preserving its existing package identity, signer, update authority, and
cross-surface protocol identifiers.

#### Scenario: User finds an Android surface
- **WHEN** Android renders the launcher, Assistant chooser, Quick Settings,
  accessibility or notification settings, shortcuts, or app-owned UI
- **THEN** the user-visible app name is `AG`
- **AND** an installed update remains compatible with the existing app identity

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

#### Scenario: Trusted build provides a temporary gateway bootstrap
- **GIVEN** the build received `MOA_ANDROID_BUNDLED_GATEWAY_TOKEN`
- **AND** the user has not saved a gateway token
- **WHEN** Android resolves the effective gateway token
- **THEN** it uses the bundled value as a temporary fallback
- **AND** the repository contains no literal value for that token

#### Scenario: User saves a gateway token
- **GIVEN** the APK contains a bundled fallback
- **WHEN** the user saves a non-empty gateway token
- **THEN** the saved token overrides the bundled value
- **AND** later gateway calls use the saved token

#### Scenario: Tokenless build starts without saved state
- **GIVEN** the build omitted `MOA_ANDROID_BUNDLED_GATEWAY_TOKEN`
- **AND** the user has not saved a token
- **WHEN** the app resolves gateway authentication
- **THEN** it remains tokenless
- **AND** it can read the public current Android OTA manifest and latest APK

### Requirement: Bundled Gateway Bearer Is Transitional
The bundled gateway bearer SHALL be treated as extractable shared legacy
authority. It SHALL NOT be treated as user identity, device identity, secure
secret storage, or the permanent onboarding contract.

#### Scenario: Tokenless installed app checks for an update
- **GIVEN** the app has no saved or bundled token
- **WHEN** it requests the current Android OTA manifest or latest APK
- **THEN** the gateway permits the read without authentication
- **AND** the token-bearing APK remains subject to signer, digest, installer,
  and user-approval checks
- **AND** the shared bearer is treated as extractable from that public artifact

#### Scenario: Anonymous client requests broader authority
- **WHEN** an unauthenticated client requests a version-pinned APK, OTA
  rollback, publication, another mutation, or any non-OTA gateway route
- **THEN** the gateway denies the request

#### Scenario: Scoped authentication becomes available
- **WHEN** Android can obtain a revocable credential bound to the signed-in user
  and registered device
- **THEN** chat, history, voice, and OTA onboarding use that scoped credential
- **AND** the build-time shared-bearer fallback can be removed

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
