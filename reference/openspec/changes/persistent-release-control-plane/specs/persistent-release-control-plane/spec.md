## ADDED Requirements

### Requirement: Release authority is persistent and separate from workers and clients
The system SHALL store release identity, channel state, assignments, authority,
evidence, and receipts in a persistent control plane. Development machines,
hosted runners, and application clients SHALL be replaceable scoped actors and
SHALL NOT become the release-state authority.

#### Scenario: Runner completes and shuts down
- **WHEN** a local or hosted runner uploads an immutable artifact and exact-byte
  evidence, then terminates
- **THEN** the control plane retains the candidate and evidence
- **AND** the runner token cannot move a channel, grant a role, or act after expiry

### Requirement: Preview and stable are channel-backed frames
The control plane SHALL expose preview and stable as signed, monotonic channel
views over immutable release bundles and SHALL keep assignments separate from
actual platform installation or activation.

#### Scenario: User enters preview and returns to stable
- **WHEN** an authorized user changes their assignment from stable to preview
  and later chooses stable fallback
- **THEN** the assignment points to the requested channel and records a receipt
- **AND** the UI reports native surfaces as pending until their platform receipts
  confirm the selected release is installed and smoked

### Requirement: Promotion is a proposal governed by evidence and policy
Application navigation MAY propose promotion, but the control plane SHALL freeze
the candidate identity, authorize the proposer, evaluate exact-artifact evidence,
and require the configured approval policy before channel movement.

#### Scenario: Application proposes merge and promotion
- **WHEN** an authorized release manager proposes a preview candidate for stable
- **THEN** source review/merge and release-channel promotion are separate phases
- **AND** stable moves only after the named artifact/bundle satisfies policy
- **AND** the receipt records the prior head, new head, actor, policy, evidence,
  rollout scope, and fallback target

### Requirement: Administration is delegated explicitly and narrowly
Every administrative action SHALL be tenant-scoped and authorized by an owner or
an unexpired, unrevoked grant that names the grantee, actions, resources, and
scope. A principal SHALL NOT grant itself authority.

#### Scenario: User follows a chosen administrator
- **WHEN** a user explicitly grants an administrator authority over named
  applications/channels/cohorts
- **THEN** that administrator may manage only those release assignments/actions
- **AND** the user retains ownership, revocation, history, and stable fallback
- **AND** the grant conveys no provider credentials or unrelated account access

### Requirement: Channels and assignments scale without per-user binary forks
The control plane SHALL support shared, team, and personal channels, but SHALL
represent ordinary personalization as channel assignment plus a compatible
feature profile rather than creating a binary channel for every user.

#### Scenario: User selects a compatible feature subset
- **WHEN** an AI proposes features X and Z but not Y
- **THEN** a deterministic resolver validates dependencies, conflicts,
  compatibility, tenant policy, and whether the change is declarative
- **AND** compatible data produces an immutable feature-profile version
- **AND** executable or incompatible changes create a new build candidate and QA
  requirement instead of mutating an installed signed artifact

### Requirement: Coordinated bundles preserve surface independence
A release bundle SHALL name exact artifacts/config versions for every included
surface and compatibility bounds between them. Each surface SHALL retain its own
signing, distribution, install/activation, QA, and smoke authority.

#### Scenario: Only some surfaces are ready
- **WHEN** Android and web satisfy their evidence policies but macOS does not
- **THEN** a partial bundle may advance only if policy declares that combination
  compatible and explicitly partial
- **AND** macOS remains on its prior compatible assignment
- **AND** no cross-surface “all deployed” claim is emitted
