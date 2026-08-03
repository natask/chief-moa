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

### Requirement: QA precedes final user review

The system SHALL freeze a final candidate only after every planned task
completes and at least one completed task is a QA task.

#### Scenario: Missing QA blocks candidate review

- **WHEN** implementation completes without a completed QA task
- **THEN** the system refuses to freeze the candidate

### Requirement: User decisions bind exact candidate bytes

The system SHALL accept or reject only the candidate digest currently frozen
for review.

#### Scenario: A stale decision fails closed

- **WHEN** a decision names a digest other than the frozen candidate digest
- **THEN** the system records no decision
