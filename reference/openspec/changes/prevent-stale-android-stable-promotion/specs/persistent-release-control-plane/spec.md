## MODIFIED Requirements

### Requirement: Android stable promotion is lineage-safe and globally ordered
The release control plane SHALL be the sole authority for the Android stable
head and SHALL reject a normal candidate unless its committed source descends
from both the recorded stable source revision and the freshly resolved protected
source-policy revision. Stable sequence ordering SHALL be global rather than
worktree-local. Android version codes SHALL NOT grant promotion authority.

#### Scenario: Old branch produces a numerically newer APK
- **GIVEN** stable records source revision `S`
- **AND** candidate `C` has a higher Android version code but does not contain `S`
- **WHEN** a publisher proposes `C` for stable
- **THEN** promotion is rejected
- **AND** the stable manifest, APK, head, and sequence remain unchanged
- **AND** a rejection receipt identifies the ancestry failure

#### Scenario: Candidate is based on a stale local master
- **WHEN** the candidate contains the publisher's local tracking ref but not the
  freshly resolved protected source-policy revision
- **THEN** promotion is rejected before stable bytes change

### Requirement: Android stable movement is an atomic exact-candidate transition
Every stable promotion SHALL bind the source revision, parent stable release,
APK digest, application id, signer digest, canonical product identity,
verification evidence, rollback target, expected head, and expected sequence.
The authority SHALL move the head with an atomic compare-and-swap.

#### Scenario: Two valid publishers race
- **GIVEN** two publishers evaluated the same stable head and sequence
- **WHEN** one publisher commits its transition first
- **THEN** the second transition fails with a stale-head conflict
- **AND** it cannot overwrite the winner's stable release or served APK

#### Scenario: Candidate identity differs from policy
- **WHEN** the APK application id, signer, visible product identity, or digest
  differs from the exact approved candidate or channel policy
- **THEN** promotion fails without moving stable

### Requirement: Non-descendant recovery is explicit and durable
A non-descendant candidate SHALL move stable only through a separate recovery
release authorization that persistently names the exact candidate bytes,
current stable head, reason, approver, rollback target, and expiry. A command
line flag or environment variable alone SHALL NOT bypass ancestry policy.

#### Scenario: Authorized recovery release
- **WHEN** an unexpired recovery authorization matches the candidate, current
  head, artifact digest, signer, compatibility evidence, and rollback target
- **THEN** the publisher may attempt the same atomic stable transition
- **AND** the promotion receipt records that recovery authority was used

#### Scenario: Recovery authorization is incomplete or stale
- **WHEN** any bound value differs or the authorization is expired
- **THEN** stable remains unchanged
