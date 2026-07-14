# Voice Intent Completion Specification

## ADDED Requirements

### Requirement: Versioned completion objective

The system SHALL represent an approved product intent as an immutable,
versioned completion objective with a user outcome, invariant, required
surfaces/configurations, acceptance cells, evaluator versions, evidence
schemas, freshness and invalidation rules, candidate identity, and operational
completion requirements.

#### Scenario: Objective acceptance changes

- **WHEN** a threshold, evaluator, required surface, or accepted behavior
  changes
- **THEN** the system creates a new objective revision
- **AND** prior evidence is not silently reinterpreted against the new revision

### Requirement: Evidence-class honesty

The system SHALL keep deterministic, live-provider, real-device, real-browser,
usefulness, trust/safety, and operational evidence distinct and SHALL NOT use
one evidence class to satisfy a cell requiring another class.

#### Scenario: Repository checks pass without phone QA

- **WHEN** all deterministic gateway and Android build checks pass
- **AND** no valid real-phone evaluation exists for the bound candidate
- **THEN** required Android real-device cells remain `not_measured` or `blocked`
- **AND** the objective remains incomplete

### Requirement: Durable evidence binding

Every evaluation result SHALL bind to an objective revision, candidate release,
surface, effective configuration/profile, evaluator version, attempt identity,
timestamp, and immutable evidence artifact.

#### Scenario: Candidate changes after evaluation

- **WHEN** candidate code or configuration changes an input declared by an
  acceptance cell
- **THEN** the reducer marks the prior result `stale`
- **AND** schedules or requests re-evaluation of that cell

### Requirement: Honest completion states

Each required acceptance cell SHALL be projected as exactly one of `passed`,
`failed`, `blocked`, `not_measured`, or `stale`. A cell may be omitted only when
the objective revision explicitly marks it optional and records the reason.

#### Scenario: Evaluation cannot access a device or paid provider

- **WHEN** a required evaluator lacks device access, credentials, consent,
  budget, or an external service
- **THEN** the cell is `blocked` with the missing condition named
- **AND** neither Fabro completion nor another passing lane converts it to pass

### Requirement: Cross-surface usefulness

The completion objective SHALL include frozen usefulness journeys that verify
the voice interaction produces a correct visible or spoken result, an
approval/action receipt, or an observable run outcome as appropriate. Fluency
measurements alone SHALL NOT satisfy usefulness.

#### Scenario: Fast reply does not complete the requested action

- **WHEN** first audio meets the latency threshold
- **BUT** the requested bounded action produces no valid proposal, approval,
  receipt, or observable terminal outcome
- **THEN** the fluency cell may pass
- **AND** the usefulness cell fails

### Requirement: Fabro orchestration without completion authority

Fabro SHALL coordinate evaluation, audit, bounded repair, re-evaluation, and
operations lanes, while a deterministic reducer over the objective and durable
evidence SHALL remain the only machine authority for completion state.

#### Scenario: Fabro nodes exit successfully with missing evidence

- **WHEN** every runnable Fabro node exits successfully
- **BUT** one or more required cells are blocked, not measured, failed, or stale
- **THEN** the workflow reports the objective as incomplete
- **AND** retains exact gaps or blockers for resumption

### Requirement: Bounded repair and non-gameable re-evaluation

The system SHALL constrain a repair proposal derived from a failed cell so
candidate workers cannot modify the objective, evaluator, corpus, reducer,
prior evidence, or promotion policy. A repair SHALL create a new candidate
identity and rerun all affected or invalidated cells.

#### Scenario: Candidate weakens its acceptance threshold

- **WHEN** candidate work attempts to change a protected objective, evaluator,
  corpus, reducer, evidence, or promotion-policy input
- **THEN** the repair is rejected
- **AND** the failed acceptance state remains visible

### Requirement: Operational completion

An operational objective SHALL NOT become complete until the same candidate has
valid preview, rollback, compatibility, no-interruption, required backup/restore,
promotion, and promoted-target smoke evidence.

#### Scenario: Candidate passes evaluation but is not promoted

- **WHEN** all pre-promotion evaluation cells pass
- **BUT** promotion is unsafe, blocked, or has not occurred
- **THEN** the objective remains operationally incomplete
- **AND** the promotion condition is reported without mutating the active target
