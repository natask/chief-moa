## ADDED Requirements

### Requirement: Canonical signed release envelope
The release service SHALL publish immutable, canonical release manifests and
signed channel heads. A manifest SHALL bind release id, surface, semantic
version, monotonic build number, full git commit, protocol compatibility,
artifact URLs, byte sizes, SHA-256 digests, native trust expectations, and
release-control signatures. A channel head SHALL bind channel, surface,
monotonic sequence, manifest digest, rollout policy, pause state, and freshness.

#### Scenario: Valid release is selected
- **WHEN** a client verifies a fresh channel head and its referenced manifest
  with an allowlisted release-control key
- **THEN** the selected artifact bytes match the declared size and SHA-256
- **AND** the decision records the release id, channel sequence, artifact id,
  and selection reason

#### Scenario: Signature or artifact verification fails
- **WHEN** the channel signature, manifest signature, artifact digest, artifact
  size, or referenced manifest digest does not verify
- **THEN** the client rejects the update and preserves the installed version
- **AND** records `verification_failed` without invoking a platform installer

### Requirement: Channels, cohorts, and compatibility fail closed
The common evaluator SHALL support separate stable, beta, and development
channel heads, deterministic rollout cohorts, paused releases, revoked
artifacts, and explicit client/gateway/platform compatibility bounds. The client
SHALL remember the highest accepted channel sequence.

#### Scenario: Client is outside a staged cohort
- **WHEN** a valid release is at a rollout percentage that excludes the client's
  stable local bucket
- **THEN** the evaluator returns `deferred`, not `up_to_date`
- **AND** no artifact download or installer request begins

#### Scenario: Replayed channel head is rejected
- **WHEN** a validly signed channel head has a sequence lower than the client's
  highest accepted sequence and has no valid rollback authorization
- **THEN** the client rejects it as a replay and remains on its installed build

#### Scenario: Protocol ranges do not overlap
- **WHEN** the release requires a protocol range incompatible with the client's
  configured gateway
- **THEN** the evaluator returns `incompatible` with a bounded reason
- **AND** the working client remains installed

### Requirement: Native platform trust remains mandatory
The common signature SHALL NOT replace platform package trust. Before install,
each adapter SHALL verify the native identity expected by the manifest and SHALL
delegate installation to the platform, store, or an approved maintained updater
under local policy.

#### Scenario: Native signer changes unexpectedly
- **WHEN** an otherwise valid artifact has an Android certificate, browser
  extension/store identity, Apple bundle/team identity, or Windows
  package/publisher identity different from the manifest and installed product
- **THEN** the adapter rejects it before installation
- **AND** emits no installed receipt

#### Scenario: Local approval is required
- **WHEN** the platform or policy requires user approval or elevation
- **THEN** the adapter presents or delegates to the platform-owned approval UI
- **AND** the gateway cannot silently bypass that decision

### Requirement: Android reuses the existing OTA authority boundary
The Android adapter SHALL extend the gateway-served APK update path, verify the
common release envelope plus APK identity/signing continuity, and hand the APK
to Android's package installer. It SHALL NOT remotely install an APK from the
gateway.

#### Scenario: Android update completes
- **WHEN** an eligible APK is downloaded, verified, approved, installed, and the
  app relaunches
- **THEN** the client records the installed package version and release id
- **AND** posts a bounded post-relaunch install/smoke receipt

### Requirement: Browser distribution respects the package boundary
The browser adapter SHALL use store-managed packages for user distribution and
MAY use the existing package/reload bridge only for explicitly enabled unpacked
development installations. It SHALL NOT fetch remotely hosted privileged
executable code.

#### Scenario: Development reload is not confirmed
- **WHEN** a package is built and a reload signal fires but the loaded extension
  version cannot be read back as the expected version
- **THEN** the result is `unverified`
- **AND** it is not reported as installed, smoked, or production-ready

#### Scenario: Store update is evidenced
- **WHEN** a named browser store accepts the exact package and an installed
  browser later reports the expected extension id and version
- **THEN** publication and installation are recorded as separate evidence items

### Requirement: macOS adapter requires signed and notarized real-device evidence
The macOS adapter SHALL wrap a reviewed maintained updater/distribution
mechanism and SHALL enforce the expected application identity, Developer ID
signature, and notarization/stapling policy before requesting installation.

#### Scenario: Unsigned macOS build exists
- **WHEN** CI or a local machine produces an unsigned app or simulator build
- **THEN** the release MAY be recorded as built
- **AND** SHALL NOT be recorded as platform-signed, notarized, published,
  installed, smoked, or production-ready

#### Scenario: macOS updater reaches readiness
- **WHEN** the exact signed/notarized artifact is published, installed on a real
  supported Mac, relaunched, smoked, and its recovery plan is exercised
- **THEN** the adapter may attach those distinct evidence records to the named
  release and channel

### Requirement: Windows adapter requires signed real-device evidence
The Windows adapter SHALL wrap a reviewed platform or maintained updater,
verify package identity and publisher signature, and respect local user,
enterprise, and elevation policy.

#### Scenario: Unsigned Windows package exists
- **WHEN** CI produces an unsigned archive, executable, or package
- **THEN** the release MAY be recorded as built or packaged as appropriate
- **AND** SHALL NOT be recorded as platform-signed, published, installed,
  smoked, or production-ready

#### Scenario: Windows updater reaches readiness
- **WHEN** the exact signed package is published, installed on a real supported
  Windows system, relaunched, smoked, and its recovery plan is exercised
- **THEN** the adapter may attach those distinct evidence records to the named
  release and channel

### Requirement: Rollback is authorized, compatible, and observable
Every promoted channel release SHALL name an available known-good predecessor
and a platform-specific recovery plan. The preferred recovery SHALL be a
forward-moving corrective package with a higher build number. Native downgrade
SHALL require platform support, compatible persisted state, a fresh signed
rollback authorization, and any required local approval.

#### Scenario: Release is paused after failures
- **WHEN** install or post-relaunch smoke failures cross the configured release
  threshold
- **THEN** release infrastructure publishes a higher-sequence paused channel
  head or superseding known-good release
- **AND** clients that have not installed do not begin the bad update

#### Scenario: Rollback is only proposed
- **WHEN** a recovery plan is published but no client has confirmed its final
  installed version after relaunch
- **THEN** the release record reports recovery proposed or attempted
- **AND** SHALL NOT report rollback completed

### Requirement: Release claims require typed evidence
The system SHALL keep built, verified, platform-signed, notarized, packaged,
published, offered, installed, smoked, and production-ready states distinct.
Each state SHALL reference the exact release, artifact digest, environment or
channel, time, verifier, and evidence artifact.

#### Scenario: Upload succeeds without installation
- **WHEN** a release artifact upload or store submission succeeds but no target
  client has installed and relaunched it
- **THEN** the record may advance only to the evidenced publication state
- **AND** user-visible status names the missing install/smoke evidence

#### Scenario: Required evidence is unavailable
- **WHEN** signing credentials, store access, target hardware, rollback proof,
  or a safe installation window is unavailable
- **THEN** work stops at the highest evidenced state
- **AND** records a plain blocker instead of asserting production readiness
