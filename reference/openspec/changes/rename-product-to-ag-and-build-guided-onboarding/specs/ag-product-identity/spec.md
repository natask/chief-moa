## ADDED Requirements

### Requirement: Canonical product identity is Ag
Every active user-facing or spoken product surface SHALL use the exact,
case-sensitive name `Ag` and describe the product as a `personal AI companion`.
It SHALL NOT position Ag as an assistant, pet, friend simulation, or sentient
being.

#### Scenario: User encounters the current product
- **WHEN** the launcher, app UI, notification, permission/settings page,
  accessibility label, browser, website, desktop surface, or spoken response
  identifies the product
- **THEN** it identifies the product as `Ag`
- **AND** supporting category copy, when needed, says `personal AI companion`
- **AND** it does not present `AG`, `A.G.`, `A-G`, `Aggie`, `Moa`, or
  `Chief Moa` as the current name

#### Scenario: Historical record names the old product
- **WHEN** source history, an immutable release receipt, or migration guidance
  must refer to an old identity
- **THEN** the old name remains intact or is explicitly labeled legacy
- **AND** it is not reused as current branding

### Requirement: Android uses a clean parallel package identity
The Ag Android app SHALL use application id `ag.companion` and SHALL be treated
as a separate app from `ai.moa.assistant`, not as an OTA update or implicit
transfer of the old package's local authority.

#### Scenario: Ag is installed beside the old package
- **WHEN** a device already has `ai.moa.assistant`
- **THEN** Android can install `ag.companion` in parallel
- **AND** the old app is not overwritten
- **AND** Ag independently requests permissions, roles, and notification access

#### Scenario: User reconnects the same account
- **WHEN** the user authenticates Ag to the same gateway account
- **THEN** Ag may retrieve gateway-owned history and profile data allowed to
  that account
- **AND** it does not claim that old app-private preferences, permissions,
  secrets, downloads, or local receipts were transferred

#### Scenario: Clean Ag install enrolls with the gateway
- **WHEN** an owner approves enrollment for a clean `ag.companion` device
- **THEN** the gateway issues a short-lived, single-use capability bound to the
  authenticated account, device, surface, and application
- **AND** the device exchanges that capability for a server-scoped, hash-only
  device credential without receiving the long-lived gateway bearer token
- **AND** successful device authentication identifies the gateway-owned
  conversations, sessions, runs, and profile eligible for restoration
- **AND** replayed, expired, malformed, or differently scoped capabilities fail
  closed

#### Scenario: Old OTA channel is queried
- **WHEN** an `ai.moa.assistant` client checks its existing update channel
- **THEN** that channel does not offer an `ag.companion` APK as an update
