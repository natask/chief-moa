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

### Requirement: logical placement remains reversible

Every intent SHALL carry tenant, namespace, sphere, and project placement
metadata. Changing placement SHALL append state without changing stable intent,
agent, run, or artifact identities. These labels SHALL NOT be represented as
authorization boundaries while one gateway principal reads the whole plane.

### Requirement: hosted authority detects disappeared agents

A non-terminal registered agent MAY establish a bounded heartbeat lease. The
projection SHALL report unleased, healthy, stale, or terminal after restart.
Expiration SHALL NOT autonomously launch a duplicate agent.

### Requirement: terminal state reopens only through a new run

Progress SHALL NOT move a completed, failed, or cancelled agent into a
non-terminal state. Starting another attempt SHALL require an explicit new run
identity. Reopening a completed intent SHALL require explicit request;
cancelled intents SHALL NOT reopen.

Explicit reopen SHALL return a blocked, needs-user, or completed owning intent
to active before the new run begins.

### Requirement: terminal pings are run-specific

Completion and needs-user notification identity SHALL bind the owning intent,
run, terminal transition, and idempotency identity. A later run SHALL create a
distinct notification and an exact retry SHALL return the original one.
