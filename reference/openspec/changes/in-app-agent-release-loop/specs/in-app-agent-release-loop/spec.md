# In-App Agent And Release Loop

## ADDED Requirements

### Requirement: feedback creates a named owned request before agent work

Chief Moa SHALL turn a voice or typed development request into one idempotent,
tenant-owned named record and SHALL show its proposed dependency graph,
acceptance checks, and resource-bounded runnable width before execution.

#### Scenario: voice retry and text fallback race

- GIVEN voice fails after producing a partial transcript
- WHEN the user retries voice and submits the retained text
- THEN exactly one named request is stored for the shared idempotency identity
- AND no agent launches until the user starts the reviewed plan.

### Requirement: enrolled devices have narrow request authority

An enrolled device SHALL create and read only its owner's development requests
and MUST NOT choose agent harnesses, working directories, worker leases,
publisher inputs, promotion credentials, or another release assignment scope.

#### Scenario: device attempts direct agent execution

- GIVEN a valid enrolled Device credential
- WHEN it calls an agent, privileged development, worker, internal, publication,
  or deployment route
- THEN the gateway denies the call
- AND no run or active-state mutation occurs.

### Requirement: runtime concurrency follows the dependency graph

The orchestrator SHALL run only dependency-satisfied, resource-bounded,
parallel-safe tasks with non-overlapping path claims and SHALL serialize
dependent or overlapping work.

#### Scenario: plan contains independent and shared-file work

- GIVEN three independent tasks and two tasks that share a file
- WHEN execution starts with sufficient worker capacity
- THEN the independent tasks may run concurrently
- AND the shared-file tasks run in their declared order.

### Requirement: feature, trial, and stable identities stay distinct

The release plane SHALL represent a feature release as an immutable candidate,
a trial as an exact user/device assignment or composed candidate, and stable as
a protected channel head. Selection MUST NOT imply installation, activation,
smoke, acceptance, or promotion.

#### Scenario: device tests one feature

- GIVEN Stable S1 and immutable Feature A
- WHEN one device chooses `Test this feature`
- THEN that device receives an exact assignment to Feature A
- AND Stable, the shared Trial head, and other device assignments do not move.

### Requirement: trial composition records exact parents and conflicts

The orchestrator SHALL compose only published compatible feature candidates
against an exact base sequence, record every parent and conflict, and publish a
new immutable trial only after frozen feature and integration checks pass.

#### Scenario: composed features overlap

- GIVEN Feature A and Feature B modify one shared file
- WHEN the user requests a composed trial
- THEN integration is serialized and the conflict resolution is visible
- AND an unresolved or semantically ambiguous conflict leaves the current trial
  and stable unchanged.

### Requirement: trial undo and stable return use exact history

The release plane SHALL retain append-only assignment history and SHALL bind
undo or stable fallback to the exact historical bundle and artifact bytes.

#### Scenario: stable advances after a trial starts

- GIVEN a trial captured Stable S1 as fallback and global stable later advances
  to S2
- WHEN the device returns using that trial's fallback
- THEN the receipt and install action identify S1's exact bundle and artifact
- AND no S2 release identity is mixed with S1.

### Requirement: Android recovery does not depend on voice or downgrade install

Chief Moa SHALL expose a native, narrowly authorized recovery path that remains
usable when voice, model routing, conversation credentials, or the trial UI
fails. Normal recovery SHALL use continuity-signed, forward-versioned artifacts
for previously confirmed behavior.

#### Scenario: broken trial cannot authenticate conversation

- GIVEN the installed trial cannot use voice or conversation authentication
- WHEN the user opens release rescue
- THEN the app can fetch or use cached signed stable recovery metadata
- AND the recovery authority cannot chat, run agents, publish, promote, or move
  a global head.

### Requirement: stable promotion consumes exact evidence and recent approval

Stable SHALL move only to the exact installed, smoked, and confirmed trial after
a recently authenticated owner decision and a distinct promoter validates all
required compatibility, rollback, interruption, and artifact evidence.

#### Scenario: promotion evidence is incomplete

- GIVEN an accepted trial lacks one required promotion evidence class
- WHEN stable promotion is requested
- THEN the proposal remains blocked
- AND the stable head does not move.

### Requirement: hosted data is isolated per tenant and user

Every stored object SHALL bind tenant and owner at storage and query boundaries,
including conversations, profiles, events, development requests, runs, evidence,
artifact authorization, and assignments. Revocation SHALL terminate both HTTP
and WebSocket access.

#### Scenario: one account guesses another account's identifier

- GIVEN two independently enrolled accounts
- WHEN one supplies the other's session, request, blob, artifact, event, or
  assignment identifier
- THEN the service returns 404 or 403 without revealing the resource
- AND the authorized owner's access remains unchanged.
