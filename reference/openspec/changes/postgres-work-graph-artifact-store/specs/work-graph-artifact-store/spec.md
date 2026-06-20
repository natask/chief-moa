## ADDED Requirements

### Requirement: Postgres Work Graph Store
The gateway SHALL use Postgres for work nodes, node event streams, and produced
artifacts when `DATABASE_URL` is configured.

#### Scenario: Database configured
- **WHEN** the gateway starts with `DATABASE_URL`
- **THEN** the work-graph store uses Postgres
- **AND** supervisor status reports Postgres as configured
- **AND** the gateway does not require Android or browser protocol changes

#### Scenario: Database not configured
- **WHEN** the gateway starts without `DATABASE_URL`
- **THEN** the work-graph store uses local JSON/JSONL fallback storage
- **AND** supervisor and work-node routes remain usable for local QA

### Requirement: Append-Only Work Events
Workers SHALL be able to append ordered events to a work node.

#### Scenario: Worker posts an event
- **WHEN** an authenticated worker POSTs a node event
- **THEN** the gateway stores the event with node id, optional run id, event type,
  payload, timestamp, and a monotonic per-node sequence

### Requirement: Durable Work Artifacts
Workers SHALL store produced plans, decisions, tool specs, results, notes, and
merged answers as queryable artifacts.

#### Scenario: Worker posts an artifact
- **WHEN** an authenticated worker POSTs an artifact
- **THEN** the gateway stores the artifact with node id, optional run id, kind,
  title, body, refs, and creation timestamp

#### Scenario: User or agent queries artifacts
- **WHEN** an authenticated caller queries artifacts by node, run, kind, or text
- **THEN** the gateway returns matching durable artifacts without requiring chat
  transcript search

### Requirement: Reducer Artifact
The gateway SHALL provide a reducer path that materializes a merged answer from
a node event stream.

#### Scenario: Node reduced
- **WHEN** an authenticated caller asks to reduce a work node
- **THEN** the gateway reads that node's events
- **AND** writes a `merged_answer` artifact for later recall
