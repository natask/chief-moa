## ADDED Requirements

### Requirement: Android OTA publication is transactional and recoverable
The OTA publisher SHALL preserve immutable rollback releases, SHALL serialize
publication with an owner lock, and SHALL not report success or discard recovery
evidence until exact committed state is acknowledged.

#### Scenario: Publish from a healthy existing release
- **WHEN** the local candidate and remote current release are byte-consistent
- **THEN** the publisher acquires an operation-owned lock and creates a verified
  bounded snapshot of the prior pointer, manifest, and APK
- **AND** stages the candidate without deleting previous release directories
- **AND** atomically replaces the legacy artifacts and `current` pointer only
  after the immutable candidate release passes exact digest and size checks

#### Scenario: Finalization fails before commit
- **WHEN** finalization mutates remote state but fails before writing the durable
  publication receipt
- **THEN** the publisher restores and verifies the pre-publish snapshot
- **AND** reports failure without claiming that the candidate is active

#### Scenario: Finalization or acknowledgement is uncertain
- **WHEN** finalization commits but the SSH response or separate acknowledgement
  is lost or fails
- **THEN** the operation-owned lock, staging evidence, snapshot, and durable
  publication receipt remain available for exact retry reconciliation
- **AND** a later publisher refuses to overwrite unknown state
- **AND** cleanup occurs only after acknowledgement verifies the release bytes,
  metadata, legacy artifacts, `current` pointer, and receipt

#### Scenario: Release identifier collides
- **WHEN** an immutable release directory already exists for the candidate id
- **AND** any expected APK or metadata byte differs
- **THEN** publication fails closed and neither the current pointer nor the prior
  release evidence is changed
