# Deployment Plane

## ADDED Requirements

### Requirement: One record answers what every surface is running

The system SHALL maintain one durable record per surface per version in the
release-control database, carrying surface, version, state, evidence reference,
use count, and complaints. A single read SHALL answer what each surface is
running, what is confirmed, what is rolling out, and what failed.

#### Scenario: the user asks what is deployed

- WHEN the plane is queried
- THEN it names the gateway commit, the Android release id, and the extension
  version, each with its state and the time it entered that state
- AND each record names the evidence that authorized it.

#### Scenario: a surface has never reported

- GIVEN a surface with no recorded version
- WHEN the plane is queried
- THEN it reports that surface as unknown rather than omitting it or inferring
  a version.

### Requirement: A version is confirmed only by use and silence together

The system SHALL mark a version `confirmed` only when it has been `active` for
at least 24 hours, has met the surface's exercise threshold while active, and
has no complaint recorded in that window. Absence of complaint alone SHALL NOT
confirm a version.

#### Scenario: the user exercises a release and says nothing

- GIVEN a gateway version active for 24 hours
- AND the qualifying voice-turn threshold was met from a real device
- WHEN no complaint was recorded
- THEN the version becomes `confirmed`.

#### Scenario: a release ships and is never used

- GIVEN a version active for a week
- AND the exercise threshold was never met
- WHEN no complaint was recorded
- THEN the version stays `active` and never becomes `confirmed`
- AND it is not offered as a rollback target.

#### Scenario: only synthetic traffic reaches a release

- GIVEN a version whose only interactions came from health checks, CI probes,
  or the preview stack
- WHEN confirmation is evaluated
- THEN those interactions do not count toward the exercise threshold.

### Requirement: Rollback targets the last confirmed version

The system SHALL resolve a rollback to the newest `confirmed` version for that
surface. When no confirmed version exists, rollback SHALL refuse and report
that no confirmed target is available.

#### Scenario: the active version is bad and an older one is confirmed

- GIVEN the active version is `suspect`
- AND an older version is `confirmed`
- WHEN the user asks to roll back
- THEN the plane targets the confirmed version, not merely the previous one.

#### Scenario: nothing has ever been confirmed

- GIVEN no version of a surface is `confirmed`
- WHEN a rollback is requested
- THEN the plane refuses and states that no confirmed target exists
- AND it does not silently fall back to the previous version.

### Requirement: A spoken complaint marks the active version suspect

The system SHALL accept a turn classified as dissatisfaction with the agent's
own behaviour as a complaint against the active version, record the turn id
with it, and move that version to `suspect`. A complaint SHALL NOT itself
perform a rollback.

#### Scenario: the user says the assistant is broken

- WHEN the user complains about the assistant's behaviour
- THEN the active version becomes `suspect` with the turn id recorded
- AND the version can no longer become `confirmed`
- AND the agent offers a rollback rather than performing one.

#### Scenario: the user is annoyed at something else

- WHEN the user expresses frustration not directed at the agent's own behaviour
- THEN no complaint is recorded against the active version.

#### Scenario: the active version crash-loops

- WHEN the active service fails health repeatedly
- THEN the plane marks that version `suspect` without waiting for the user.

### Requirement: Deployment artifacts keep the running version and one predecessor

The system SHALL retain the running artifact and exactly one predecessor per
surface, and SHALL rebuild any older version on demand rather than storing it.
Promotion evidence SHALL be retained in the release-control database
independently of artifact retention.

#### Scenario: a third image accumulates

- WHEN a new gateway image is applied
- THEN the predecessor is kept and any older image is removed.

#### Scenario: rolling back two versions

- WHEN a rollback target is older than the retained predecessor
- THEN the plane reports that a rebuild is required and its expected duration
  before starting it.

#### Scenario: artifacts are pruned

- WHEN artifacts are pruned
- THEN the promotion evidence for those versions remains queryable.

### Requirement: Promotion does not copy persistent state

The system SHALL preserve Postgres and named data volumes in place during a
gateway promotion and SHALL NOT create a deployment-time full-state copy.
Eligible state changes SHALL be additive and readable by the predecessor used
for code rollback.

#### Scenario: promotion retries in a loop

- GIVEN many failed promotion attempts in one day
- WHEN retention is applied
- THEN no persistent-state archive is created.

#### Scenario: an artifact retention change is applied

- WHEN deployment artifacts are pruned to the running version and one
  predecessor
- THEN no persistent gateway data is deleted by that action.

### Requirement: A surface never fails on a directory another surface owns

The system SHALL treat creation of a directory owned by another deployment
surface as best-effort. A permission failure SHALL degrade only the dependent
feature. Any other failure SHALL still be fatal.

#### Scenario: the OTA publisher creates a directory the gateway cannot enter

- GIVEN the Android publisher created an OTA directory the gateway user cannot
  traverse
- WHEN the gateway starts
- THEN the gateway starts and serves traffic
- AND it logs the unavailable OTA channel
- AND that channel reports no release available.

#### Scenario: the data volume itself is broken

- GIVEN a data directory failure that is not a permission problem
- WHEN the gateway starts
- THEN startup fails loudly rather than degrading.

### Requirement: The running version is identifiable after a rollback

The system SHALL build rollback artifacts with the same build identity metadata
as forward promotions, so the active service always reports the commit it is
running.

#### Scenario: a promotion fails and rolls back

- WHEN a promotion fails and the previous version is restored
- THEN the active service reports that previous commit at its health endpoint
- AND it does not report an unknown build.

### Requirement: A promotion is never interrupted by its own trigger

The system SHALL keep the promotion poll interval longer than the worst-case
promotion duration, and a promotion already in progress SHALL NOT be terminated
by a later trigger of the same schedule.

#### Scenario: the schedule fires while a promotion is running

- GIVEN a promotion in progress
- WHEN the poll interval elapses
- THEN the running promotion continues to completion
- AND the new trigger is skipped rather than replacing it.

#### Scenario: the promotion duration grows past the interval

- WHEN a promotion regularly takes longer than the poll interval
- THEN the mismatch is reported as a configuration fault
- AND it is not reported as a promotion timeout.

### Requirement: A failed promotion leaves persistent state in place

The system SHALL prove a candidate can build and boot before apply. A failed
promotion SHALL roll code back without copying, replacing, or deleting the
mounted persistent volumes.

#### Scenario: a candidate fails to build

- WHEN a promotion dies during or before the image build
- THEN no persistent-state copy was written for that attempt.

#### Scenario: a promotion reaches the apply

- WHEN a promotion proceeds to the apply
- THEN the existing Postgres and named data volumes remain mounted.

### Requirement: The plane records outcomes without relaxing the promotion gate

The system SHALL record deployment state in addition to, and never in place of,
the existing gate: isolated preview, compatibility, rollback, the deployment
evidence chain before apply, and the drain check immediately before mutation.

#### Scenario: a promotion runs under the plane

- WHEN a version is promoted
- THEN the preview, compatibility, rollback, evidence, and drain checks all run
- AND the plane records the resulting state transition afterwards.

#### Scenario: the plane is unavailable

- WHEN the plane cannot be written
- THEN the promotion gate still blocks on its own evidence
- AND the promotion does not proceed on the strength of a missing record.
