# Persistent Intent Plane

## ADDED Requirements

### Requirement: Chief Moa owns one cross-surface intention identity

The gateway SHALL durably admit a user-confirmed intention with stable identity,
title, objective, lifecycle, source/provenance, sensitivity, owner, next action
and timestamps. All Chief Moa surfaces SHALL consume the same projection.

#### Scenario: inferred intention

- WHEN a caller proposes an intention without explicit user confirmation
- THEN admission is rejected
- AND no event is appended.

### Requirement: registered agents remain explainable

Every agent registered in this slice SHALL have a stable id, owning intent,
launch reason, launcher provenance, capabilities/authority summary, status,
last progress, current run and latest recap. Agent progress SHALL be idempotent.

#### Scenario: gateway restarts

- GIVEN intent, agent and progress events exist
- WHEN a new gateway runtime reads the substrate
- THEN the unified projection contains the same canonical identities and links.

### Requirement: user attention is durable and receiptable

Completion and needs-user lifecycle changes SHALL create a durable notification
with pending receipt state. A receipt SHALL idempotently mark it received.

### Requirement: authority stays bounded

The intent plane SHALL execute no external action, persist no credentials, and
SHALL NOT claim current Codex subagent identities persist without explicit
adapter registration.
