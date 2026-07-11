# Semantic telemetry specification

## ADDED Requirements

### Requirement: Moa owns telemetry semantics

The system SHALL construct every telemetry envelope from a versioned Moa-owned
event vocabulary and SHALL keep canonical product events authoritative.

#### Scenario: Unknown event

- **WHEN** a caller emits an event name outside the vocabulary
- **THEN** the event is dropped locally and is not exported

### Requirement: Sensitive and high-cardinality data are excluded

The system SHALL use allowlisted scalar attributes and SHALL exclude raw audio,
transcripts, prompts, page or screen content, credentials, financial details,
user IDs, tenant IDs, session IDs, and turn IDs by default.

#### Scenario: Token-like value

- **WHEN** an allowlisted attribute contains a token-shaped value
- **THEN** validation rejects the event before it reaches an exporter

#### Scenario: Metric dimensions

- **WHEN** dimensions are derived from a correlated event
- **THEN** opaque correlation and event IDs are absent

### Requirement: Release and correlation identifiers are opaque

The system SHALL accept release versions only in semver form and SHALL accept
release build IDs, event IDs, and correlation IDs only as generated or
validated opaque `prefix_uuid` values. Email addresses, session-like strings,
tenant-like strings, and user-shaped values SHALL be rejected.

#### Scenario: Identity-shaped release metadata

- **WHEN** a caller provides `release.build_id` or `release.version` that is not
  semver or not an opaque `prefix_uuid`
- **THEN** validation rejects the event before it reaches an exporter

#### Scenario: Identity-shaped correlation metadata

- **WHEN** a caller provides `trace_id`, `parent_event_id`, or `canary_id` that
  is not an opaque `prefix_uuid`
- **THEN** validation rejects the event before it reaches an exporter

#### Scenario: Identity-shaped correlation

- **WHEN** release or correlation metadata does not match its field-specific
  semantic-version or prefixed-UUID format
- **THEN** validation rejects the event before export

### Requirement: Export cannot break product behavior

Export SHALL run asynchronously through bounded queues and batches. Validation,
overflow, timeout, and exporter failure SHALL be represented as local drop or
failure counters and SHALL NOT fail the product operation.

#### Scenario: Exporter unavailable

- **WHEN** the exporter rejects a batch
- **THEN** the failure counter advances and the request path remains successful

#### Scenario: Exporter ignores abort after timeout

- **WHEN** an exporter times out and does not settle after its `AbortSignal` is
  aborted
- **THEN** the request path remains successful, the queue remains bounded, and
  unresolved exporter work stays limited to one active underlying batch

#### Scenario: Exporter ignores cancellation

- **WHEN** an export times out and its adapter does not settle after abort
- **THEN** the exporter opens a bounded circuit and starts no additional
  underlying export work

### Requirement: Vendor claims require measured preview evidence

The system SHALL NOT select or describe a backend as best without a dated,
isolated preview measuring mapping correctness, sensitive-data exclusion,
cardinality, queue/drop behavior, resource use, retention, and cost inputs.

#### Scenario: Architecture-only review

- **WHEN** only documentation and local deterministic tests were evaluated
- **THEN** conclusions are labeled architecture confidence rather than measured
  vendor or production results
