## ADDED Requirements

### Requirement: Explicit implementation intent has one lifecycle owner
The system SHALL create implementation work only from a current explicit
`Create fix` authorization and SHALL bind every nonterminal authorized request
to exactly one current owner or a visible reclaimable/blocked state.

#### Scenario: Feedback is submitted without Create fix
- **WHEN** exact-release interaction feedback is recorded
- **THEN** no modification request, task, worker run, or deployment is started

#### Scenario: Create fix is retried
- **WHEN** the same device retries the same idempotency key and payload
- **THEN** the gateway returns the same request, intent, task, run, and owner
- **AND** no duplicate work is created

### Requirement: Implementation starts from recorded master
Each modification work request SHALL record `origin/master` and its resolved
commit, and the worker SHALL verify that base before editing.

#### Scenario: Worker checkout resolves another commit
- **WHEN** the worker's resolved base differs from the recorded commit
- **THEN** execution stops with a visible base-drift blocker

### Requirement: Routine Android QA does not require a personal phone
Android UI candidates SHALL have a deterministic emulator QA path that renders
the real app and emits exact-artifact runtime evidence.

#### Scenario: The emulator dependency is absent
- **WHEN** the selected runner lacks the emulator or system image
- **THEN** the run reports the missing dependency precisely
- **AND** it does not report the APK as smoked

### Requirement: QA evidence binds exact bytes
Emulator evidence SHALL bind source commit, application APK digest and signer,
test APK digest, preview namespace, scenario revision, environment identity, and
the digest of every retained artifact.

#### Scenario: An evidence artifact changes
- **WHEN** a retained screenshot, video, log, hierarchy, trace, or JUnit file no
  longer matches its recorded digest
- **THEN** evidence verification fails and the candidate is not admitted

### Requirement: Video feedback is bounded evidence
Video-note capture SHALL be explicit, visible, cancellable, bounded, and bound
to the exact running Android release. It SHALL grant no implementation or
deployment authority.

#### Scenario: Video exists but Create fix was not authorized
- **WHEN** feedback includes a valid video-note reference
- **THEN** the record remains inert evidence and no worker is launched

### Requirement: Candidate delivery preserves release-state truth
A preview candidate SHALL become selectable only after matching artifact and QA
evidence, and selection SHALL remain distinct from installation, activation,
smoke, acceptance, and stable promotion.

#### Scenario: Emulator evidence names another APK
- **WHEN** candidate admission receives QA evidence for a different digest
- **THEN** admission fails closed and no preview assignment is created
