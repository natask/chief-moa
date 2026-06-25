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
