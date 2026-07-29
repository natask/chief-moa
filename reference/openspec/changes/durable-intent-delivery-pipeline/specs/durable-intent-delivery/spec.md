# Durable Intent Delivery

## ADDED Requirements

### Requirement: Current work requests have one canonical delivery identity

The gateway SHALL link one explicit current user-authored work request to one
durable intent, one work task, and at most one queued run proposal.

#### Scenario: user requests implementation

- GIVEN a broker-first work-history turn with a stable turn identity
- WHEN the gateway records the work request
- THEN it creates a delivery intent and links the task and queued run to that
  intent revision
- AND the queued run remains inert until a worker claims it.

#### Scenario: client retries the same turn

- GIVEN the delivery intent, task, and run were already recorded
- WHEN the client retries the same turn
- THEN the gateway returns the original intent, task, and run identities
- AND appends no duplicate capture, task, or queued-run records.

### Requirement: Delivery status preserves evidence boundaries

The gateway SHALL expose an inspectable delivery projection that names source,
intent revision, acceptance contract, tasks, and runs. It MUST NOT infer
execution, verification, preview, promotion, smoke, or completion from an
earlier lifecycle fact.

#### Scenario: work is only queued

- GIVEN a delivery intent has one queued run proposal
- WHEN the user reads its delivery projection
- THEN the projection reports that execution has not started
- AND reports no promotion.

### Requirement: Partial linkage is visible and retryable

The gateway SHALL preserve successfully appended records when a later linkage
step fails and SHALL expose their stable identities as partial-linkage evidence.

#### Scenario: task creation fails after intent planning

- GIVEN intent capture and planning succeeded
- WHEN task creation fails
- THEN the gateway reports the intent identity and revision
- AND retrying the same turn continues without duplicating the intent.

### Requirement: Explicit execution remains linked and review-gated

The gateway SHALL bind an explicitly launched broker agent run to exactly one
canonical delivery intent and work-history run. A terminal harness result SHALL
update only that linkage and SHALL NOT by itself prove delivery completion.

#### Scenario: linked run produces output

- GIVEN an explicit broker launch has one linked executable agent run
- WHEN that run produces a successful terminal result
- THEN the work-history run reports output proposed and waiting for review
- AND the canonical intent records progress plus one pending notification
- AND the intent remains active with no completion or promotion record.

#### Scenario: a different linked run is still active

- GIVEN two distinct stable messages created two linked delivery chains
- WHEN one executable run finishes
- THEN the other intent and work-history run receive no progress or notification
  from that result.
