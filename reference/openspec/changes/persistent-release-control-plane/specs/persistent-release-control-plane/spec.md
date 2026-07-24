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

### Requirement: Assignment writes are ordered and retry-safe
The control plane SHALL record assignment changes as append-only events. A
device write SHALL name its expected current sequence and an idempotency key.

#### Scenario: Two surfaces select a channel for one device
- **WHEN** two clients submit channel assignments from the same current sequence
- **THEN** the control plane accepts at most one next sequence
- **AND** rejects the stale write without replacing the accepted assignment
- **AND** a retry with the accepted idempotency key returns the same event

### Requirement: Platform state uses exact-release receipts
The control plane SHALL track assignment, installation, activation, and smoke as
separate states. A platform receipt SHALL name the assignment event, bundle,
surface, release, and artifact digest.

#### Scenario: Assignment succeeds before native installation
- **WHEN** a device selects a preview bundle
- **THEN** the assignment response reports that installation is unconfirmed
- **AND** Android may ask the user to review a verified APK installation
- **AND** the browser may report that a binary reload is required
- **AND** the view reports installed, activated, or smoked only after a matching
  platform receipt arrives

#### Scenario: Receipt names different bytes
- **WHEN** a client submits an install or smoke receipt with a digest that does
  not match the assigned bundle artifact
- **THEN** the control plane rejects the receipt
- **AND** the assigned artifact remains unconfirmed

### Requirement: Release feedback is bound to observed bytes
The control plane SHALL bind release feedback to an assignment event, bundle,
surface, release, and artifact digest. It SHALL reject feedback that does not
match the assigned artifact.

#### Scenario: User comments on the active preview
- **WHEN** the Android full app or browser side panel submits feedback for the
  selected preview
- **THEN** the stored feedback retains the exact release binding and comment
- **AND** later channel movement does not rewrite that binding

### Requirement: Client identity comes from a trusted host boundary
The HTTP boundary SHALL derive tenant and actor identity from authenticated host
context. It SHALL ignore caller-supplied tenant and actor fields.

#### Scenario: Caller forges another tenant
- **WHEN** a request body names a tenant or actor that differs from the
  authenticated context
- **THEN** authorization uses the authenticated tenant and actor
- **AND** the caller cannot read or write the other tenant's release records

### Requirement: Every deployable candidate has a persistent device-reachable preview
The control plane SHALL publish every deployable candidate to an isolated
preview that remains reachable after its build and QA workers terminate. A CI
build, uploaded artifact, loopback-only process, or expiring job environment
SHALL NOT count as a preview deployment.

#### Scenario: Local or simulated QA cannot exercise the real device
- **WHEN** pre-publication checks pass but a real Android phone, loaded browser,
  or supported Mac is unavailable to the runner
- **THEN** the candidate may be published to its isolated persistent preview
  when the evidence policy permits user-led QA
- **AND** the missing real-device checks remain visibly pending
- **AND** the user can test the exact assigned bytes on the owning device

#### Scenario: Candidate spans multiple surfaces
- **WHEN** a release bundle names gateway, browser, Android, or macOS artifacts
- **THEN** each included surface exposes a device-reachable preview locator and
  independent publication, installation or activation, and smoke state
- **AND** an unavailable surface is reported as blocked or explicitly omitted
  by compatible partial-bundle policy
- **AND** the system does not claim that all services are deployed prematurely

### Requirement: Preview resources are isolated from stable resources
Every preview runtime SHALL use separate state stores, queues, storage paths,
worker identities, credentials, callback targets, and endpoints from the active
stable runtime. The preview SHALL declare an expiry, cleanup owner, and stable
fallback before assignment.

#### Scenario: User exercises a gateway preview
- **WHEN** the user sends a bounded request to the preview gateway
- **THEN** the request cannot read or mutate production conversations, jobs,
  queues, or release assignments
- **AND** the preview health and smoke receipts identify the exact candidate
  bundle and artifact digest

### Requirement: User decision governs promotion or rejection cleanup
The control plane SHALL keep a preview available until the user accepts it,
rejects it, or an explicit expiry policy closes it. Acceptance SHALL promote
the exact previewed bundle subject to release policy. Rejection SHALL restore
affected assignments to last-known-good stable before candidate-only resources
are deprovisioned.

#### Scenario: User accepts the tested preview
- **WHEN** the user accepts a preview with matching platform smoke receipts
- **THEN** promotion names the exact accepted preview head and prior stable head
- **AND** stable rollout and post-rollout smoke create separate receipts
- **AND** no artifact may be rebuilt or substituted during promotion

#### Scenario: User rejects the tested preview
- **WHEN** the user rejects a preview
- **THEN** affected assignments return to their recorded last-known-good stable
  bundle
- **AND** native fallback installation and smoke remain pending until separately
  receipted
- **AND** candidate-only runtime resources are deprovisioned only after fallback
  is safe
- **AND** immutable artifacts, evidence, feedback, and decision receipts remain
  available for audit

### Requirement: Preview receipts distinguish build, publication, use, and decision
The control plane SHALL retain append-only, exact-artifact receipts for
candidate creation, build, verification, preview publication, assignment,
platform installation or activation, smoke, user decision, promotion or
fallback, and preview deprovisioning. Every receipt SHALL name its candidate,
bundle, surface, artifact digest, actor, timestamp, and prior sequence.

#### Scenario: CI uploads a successful artifact
- **WHEN** CI builds and uploads an artifact but no device-reachable preview
  serves or assigns those exact bytes
- **THEN** the candidate is reported as built or packaged
- **AND** it is not reported as published, installed, activated, smoked, or
  deployed
