## ADDED Requirements

### Requirement: A clean install restores from the account, not from local files
A freshly installed `ag.companion` holding a valid gateway device credential
SHALL restore the user's settings by reading them from the gateway. It SHALL NOT
depend on, read, or claim to read any state belonging to `ai.moa.assistant` or
any other package.

#### Scenario: Fresh install with a verified device credential
- **WHEN** `ag.companion` completes enrollment and holds a scoped device
  credential
- **THEN** it reads the account's restorable settings from the gateway
- **AND** applies them to its local settings cache
- **AND** reports how many settings were restored

#### Scenario: The old package is still installed
- **WHEN** `ai.moa.assistant` is present on the same device
- **THEN** `ag.companion` reads nothing from it
- **AND** every continuity response states that no app-local state was
  transferred
- **AND** the app repeats that statement to the user rather than implying a
  migration occurred

#### Scenario: The restore read fails
- **WHEN** the settings read fails, times out, or returns an unverifiable
  snapshot
- **THEN** the locally stored settings are left exactly as they were
- **AND** the app states plainly that settings were not restored
- **AND** enrollment itself remains valid

### Requirement: Only the device credential and undelivered work stay on the device
The Android app SHALL persist locally only the gateway device credential and
work that has not yet reached the server. All other user settings, profile, and
history SHALL be treated as account-owned and re-fetched.

#### Scenario: Secrets on the device
- **WHEN** the app stores authentication state
- **THEN** it stores only its own scoped gateway device credential
- **AND** it does not store raw OpenAI, Anthropic, Gemini, or integration API
  keys

#### Scenario: Settings are re-fetched rather than migrated
- **WHEN** a user setting exists on both the device and the account
- **THEN** the account value is authoritative on restore
- **AND** the local copy is a cache that a reinstall can rebuild

### Requirement: Audio captured offline survives and reconciles exactly once
Audio captured while the device cannot reach the gateway SHALL be retained
locally under an explicit bound until the server accepts it, and SHALL reconcile
without creating a duplicate turn.

#### Scenario: Capture while offline
- **WHEN** a turn is captured and the gateway is unreachable
- **THEN** the audio is retained in app-private storage with a
  client-generated turn id
- **AND** it survives the app process being killed

#### Scenario: Connectivity returns
- **WHEN** the gateway becomes reachable
- **THEN** the retained turn is delivered using its turn id as the idempotency
  key
- **AND** a replay of the same id produces the same turn, not a second one
- **AND** the local entry is removed only after the gateway acknowledges it

#### Scenario: The bound is reached or retention expires
- **WHEN** retained audio exceeds its byte bound or its retention window
- **THEN** the affected turn fails visibly to the user
- **AND** truncated audio is never sent as though it were complete
- **AND** the entry is not silently retried forever

### Requirement: Settings schema migrations ship with the release
Every settings snapshot SHALL carry the schema version it was produced under,
and each client release SHALL carry the migrations needed to upgrade older
snapshots to the shape that release understands. A schema mismatch SHALL NEVER
silently discard a user's setting.

#### Scenario: The account's schema is older than the installed release
- **WHEN** the snapshot's `settings_schema_version` is below the client's
- **THEN** the client replays only the migration steps between those versions
- **AND** renamed fields arrive under their new names
- **AND** a step already applied is not applied twice

#### Scenario: The account's schema is newer than the installed release
- **WHEN** the snapshot's `settings_schema_version` is above the client's
- **THEN** the snapshot is applied and unrecognized fields are kept intact
- **AND** the restore is reported as partial
- **AND** the user is told to update Ag to apply the rest

#### Scenario: A restore would blank an existing value
- **WHEN** an incoming value is empty or a stored key is absent from the
  snapshot
- **THEN** the stored value is preserved
- **AND** the restore only adds or corrects settings

### Requirement: Settings are scoped to the authenticated account
Restorable settings SHALL be resolved from the identity proven by the presented
device credential, never from a value supplied by the client, so that a second
person installing Ag receives their own settings.

#### Scenario: A device credential is presented
- **WHEN** a device requests its account settings
- **THEN** the account is taken from the authenticated principal
- **AND** any account identifier in the request body is ignored

#### Scenario: A credential lacks the settings scope
- **WHEN** the presented credential is not an `ag.companion` credential holding
  `profile.read`
- **THEN** the request is rejected
- **AND** no settings are disclosed

#### Scenario: Settings that must not reach the device
- **WHEN** the account settings are projected for a device
- **THEN** routing, provider, trust-policy, and system-prompt fields are
  withheld and stay server-applied
- **AND** no credential of any kind appears in the response
