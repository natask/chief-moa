## ADDED Requirements

### Requirement: One durable record owns development from riff through review

The system SHALL store the user's raw riff before planning and SHALL preserve
the riff, evidence references, plan, task state, candidate, and user decision in
one restart-safe intent record.

#### Scenario: Restart preserves the user's intent

- **WHEN** the gateway restarts after work or QA updates
- **THEN** the intent read returns the original riff and every accepted event in
  order

### Requirement: Dependencies and resource limits control parallel work

The system SHALL mark a task runnable only after its dependencies complete. It
SHALL exclude work that conflicts with a running path claim or exceeds the
active worker or memory budget.

#### Scenario: Independent work runs together

- **WHEN** two pending tasks have completed dependencies, separate path claims,
  and enough memory
- **THEN** both tasks appear in the same runnable set

#### Scenario: Dependent work waits

- **WHEN** a pending task depends on incomplete work
- **THEN** the pending task does not appear in the runnable set

### Requirement: First dispatch turns the riff into validated work

The system SHALL ask the configured planner for a task graph when a durable
intent has no plan. It SHALL validate the graph with the same dependency,
resource, and task rules used for manually supplied plans before launching any
worker. Terminal worker receipts SHALL advance the next dependency-safe batch.

#### Scenario: Invalid planner output executes nothing

- **WHEN** the planner returns malformed JSON, a cyclic graph, or unsupported
  task fields
- **THEN** the system stores no plan and launches no task worker

### Requirement: QA precedes final user review

The system SHALL freeze a final candidate only after every planned task
completes and at least one completed task is a QA task.

#### Scenario: Missing QA blocks candidate review

- **WHEN** implementation completes without a completed QA task
- **THEN** the system refuses to freeze the candidate

### Requirement: Integration is serial across intents

The system SHALL allow at most one active integration task across all durable
development intents. It SHALL preserve queued integration work across restart
and recover an abandoned lease after its bounded expiry.

#### Scenario: A second integration waits

- **WHEN** one intent owns the active integration lease and another intent has
  runnable integration work
- **THEN** the second integration remains queued and no agent run launches for
  it

### Requirement: User decisions bind exact candidate bytes

The system SHALL accept or reject only the candidate digest currently frozen
for review.

#### Scenario: A stale decision fails closed

- **WHEN** a decision names a digest other than the frozen candidate digest
- **THEN** the system records no decision

### Requirement: Acceptance preserves the release input

The system SHALL create a release-policy handoff in the same durable event as
user acceptance. The handoff SHALL contain the frozen candidate ref, digest,
and verification references. It SHALL remain a proposal governed by the active
promotion policy.

#### Scenario: Release does not re-derive intent

- **WHEN** the user accepts the frozen candidate
- **THEN** the release handoff names the exact candidate and QA evidence that
  the user reviewed
