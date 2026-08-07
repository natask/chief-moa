# Tiered Update Delivery

## ADDED Requirements

### Requirement: Dynamic layers and native packages use distinct update authority

The system SHALL treat declarative gateway-served layers as Tier 1 and native
packages as Tier 2, with versioned receipts and rollback appropriate to each
tier; an agent-requested Tier 1 move MUST NOT authorize a Tier 2 installation.

#### Scenario: user asks to restore an earlier persona

- GIVEN an earlier compatible profile-layer version exists
- WHEN the user approves that layer rollback
- THEN the gateway moves only the Tier 1 profile pointer and records a receipt
- AND the installed native package remains unchanged.

### Requirement: Runtime bundles fail closed before activation

The gateway SHALL accept a Tier 1 runtime bundle only when its exact manifest
has a valid Ed25519 signature from a configured trust key, valid provenance,
an allowlisted declarative payload, and a shell-protocol range compatible with
the running gateway. Provider credentials MUST NOT be accepted as bundle data.

#### Scenario: signed bytes are changed in transit

- GIVEN a manifest signed by a trusted runtime release key
- WHEN any signed payload value is changed before publication
- THEN the gateway rejects the bundle before it is staged
- AND the current runtime and profile remain unchanged.

#### Scenario: bundle targets a future shell

- GIVEN a correctly signed bundle whose minimum shell protocol is newer than
  the running gateway
- WHEN a publisher submits the bundle
- THEN the compatibility gate rejects it before staging.

### Requirement: Runtime activation is staged, healthy, and reversible

The gateway SHALL persist a pending activation and the pre-change profile
version before applying a bundle. It SHALL make the bundle current only after
the declared health checks pass. A failed or interrupted activation SHALL
restore the recorded profile version and retain the prior current bundle as
last-known-good. Normal activation SHALL reject sequence downgrade or replay;
an explicit rollback MAY reactivate a previously healthy signed bundle.

#### Scenario: candidate fails its profile projection health check

- GIVEN a healthy current runtime bundle and a newer staged bundle
- WHEN the newer bundle's profile projection health check fails
- THEN the gateway restores the pre-activation profile
- AND the prior bundle remains current
- AND the audit records the failed activation and rollback.

#### Scenario: staged activation succeeds

- GIVEN a compatible, trusted, monotonically newer staged bundle
- WHEN its allowlisted profile patch applies and all required checks pass
- THEN the gateway atomically marks it current and last-known-good
- AND exposes its manifest digest and provenance through the runtime status.

### Requirement: The installed Android shell remains the local package authority

The Android application SHALL treat Tier 1 runtime status as a read-only
gateway projection and SHALL keep its compiled base shell usable when the
gateway or bundle status is absent. Tier 1 activation MUST NOT invoke Android's
package installer. APK replacement SHALL continue to require platform install
consent on an ordinary consumer device; silent replacement is outside this
contract and requires explicit device-owner management.

#### Scenario: runtime gateway is unavailable

- GIVEN the installed app cannot fetch runtime status
- WHEN the user opens the app
- THEN the app shows the base shell as available
- AND no package installation is attempted.
