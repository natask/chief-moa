## ADDED Requirements

### Requirement: Canonical Event Substrate

The gateway SHALL represent durable product state changes as append-only events
with stable ids, origin ids, stream ids, stream versions, schema versions,
actor metadata, authority metadata, causation ids, correlation ids, and
idempotency keys.

#### Scenario: Event appended

- **WHEN** the gateway accepts a voice turn, chat turn, profile change, run
  event, browser task event, tool request event, approval, receipt, or work
  artifact event
- **THEN** it stores an append-only event before deriving current-state views

#### Scenario: Duplicate event submitted

- **WHEN** the gateway receives an event with a known event id or idempotency key
- **THEN** it returns the existing event result without duplicating downstream
  work

### Requirement: Rebuildable Projections

Current views SHALL be projections over events rather than the only durable copy
of product state.

#### Scenario: Projection rebuilt

- **WHEN** a projection is deleted or invalidated
- **THEN** the gateway can rebuild it from events, snapshots, and referenced
  blobs/CRDT updates

### Requirement: Local And Hosted Store Compatibility

The same event-envelope contract SHALL work in hosted Postgres, self-hosted VPS
Postgres, and local personal gateway fallback storage.

#### Scenario: Local gateway without auth

- **WHEN** the gateway runs in loopback/local-only mode
- **THEN** it may disable auth while preserving the same event and export/import
  contracts

#### Scenario: Hosted gateway

- **WHEN** the gateway runs in hosted or remote mode
- **THEN** it requires auth for event append, query, export, import, and sync
  APIs

### Requirement: Durable Execution Checkpoints Stay Separate

Durable execution checkpoints SHALL support resumable work without replacing the
canonical product event log.

#### Scenario: Execution resumes after restart

- **WHEN** a long-running tool or agent execution is interrupted after a completed
  step
- **THEN** the gateway resumes from the latest checkpoint
- **AND** does not duplicate already-recorded domain events

### Requirement: Selective CRDT Objects

The system SHALL use CRDT documents only for mutable objects requiring
concurrent or offline merge.

#### Scenario: Append-only record synced

- **WHEN** a voice turn, provider event, receipt, or run event syncs between
  replicas
- **THEN** it syncs as an append-only event, not as a CRDT object

#### Scenario: Mutable object synced

- **WHEN** a generated UI layout, flow/workspace object, selected config map, or
  collaborative text object syncs between replicas
- **THEN** the event log references the relevant CRDT snapshot or update

### Requirement: Portable Export And Import

A user SHALL be able to export hosted data and import it into a self-hosted
gateway.

#### Scenario: Hosted export imported locally

- **WHEN** a user exports event segments, snapshots, blob refs, and CRDT updates
  from a hosted gateway
- **THEN** a local gateway can import them idempotently and rebuild core
  projections

### Requirement: Optional Synchronization

Hosted and self-hosted gateways SHALL be able to synchronize selected event
segments when configured.

#### Scenario: Replica reconnects

- **WHEN** a replica reconnects after being offline
- **THEN** it imports missing remote events using local per-origin checkpoints
- **AND** keeps checkpoints as local sync bookkeeping rather than user-facing
  synced data
