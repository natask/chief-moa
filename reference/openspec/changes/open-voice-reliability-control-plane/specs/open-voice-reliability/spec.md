# Open voice reliability specification

## ADDED Requirements

### Requirement: The system models endpoint-observed voice behavior honestly

The system SHALL distinguish server audio generation and transport from client
audio receipt and endpoint-observed playout. It SHALL preserve timing, route,
buffer, and hardware uncertainty and SHALL NOT claim physical hearing without
acoustic-loopback evidence.

#### Scenario: Server emits audio before client playback

- **WHEN** the server writes the first assistant audio chunk and the client
  starts playout later
- **THEN** the trace records both milestones and derives an endpoint-observed
  latency proxy rather than calling server first-byte time playback or calling
  the proxy proven physical hearing

### Requirement: Voice semantics are runtime-neutral and honest

The system SHALL represent cascaded and native-audio runtimes without fabricating
provider stages that were not observed.

#### Scenario: Native speech-to-speech provider

- **WHEN** a provider exposes audio activity and chunks but no STT, reasoning,
  or TTS boundary
- **THEN** the turn contains native-audio observations and omits the unavailable
  stage spans

### Requirement: Collection cannot break realtime voice

Telemetry and media export SHALL be asynchronous, bounded, failure-isolated,
and non-authoritative. Exporter failure SHALL NOT fail, delay, or mutate the
canonical voice turn. Before enablement, a profile SHALL define event-rate and
size limits, memory/disk quotas, nonblocking enqueue, exporter concurrency and
timeouts, deterministic overflow priority, disk-full behavior, and measured
CPU/memory/I/O/voice-latency budgets.

#### Scenario: Backend and media store are unavailable

- **WHEN** the event backend rejects exports and the audio object store times
  out
- **THEN** the voice turn continues, queues/spools remain bounded, and local
  counters expose drops or failures

#### Scenario: Exporter is saturated during replay queries

- **WHEN** exporter I/O is saturated while replay and query workloads run
- **THEN** a fault test proves resource use and p50/p99 voice-latency and jitter
  deltas remain within the approved profile budgets

### Requirement: Ingested evidence has authenticated provenance

The system SHALL use tenant/project-bound ingestion credentials, schema/size/rate
validation, idempotency and replay protection, server-assigned authority fields,
and explicit provenance for client, gateway, provider, operator, deterministic,
and evaluator observations.

Browser ingestion SHALL use short-lived, revocable, write-only tickets bound to
tenant, project, session, origin, schema, and nonce, with no query, export,
replay, or administrative authority.

#### Scenario: Client asserts a server-owned release

- **WHEN** a client event attempts to set tenant, release, policy, or evaluator
  authority outside its credential scope
- **THEN** ingestion rejects or quarantines the event and excludes it from
  trusted cohorts

### Requirement: Percentile claims include cohort evidence

Every p50, p95, or p99 result SHALL include the time window, sample count,
filters, and relevant schema/evaluator versions. A versioned query policy SHALL
define the population, inclusion/exclusion rules, minimum sample count,
estimator, confidence/error method, and handling of missing, censored, rejected,
dropped, and clock-uncertain observations; the response SHALL emit that policy
and per-class counts.

#### Scenario: Sparse filtered cohort

- **WHEN** a query filters to a release/device/language cohort with too few
  observations for a stable tail estimate
- **THEN** the system returns the sample count and an insufficiency warning
  instead of presenting the p99 as a reliable product claim

### Requirement: Capacity reports preserve the offered-load denominator

Every capacity window SHALL report offered, admitted, completed, rejected,
timed-out, and dropped turns; active session/turn and provider concurrency;
admission/queue delay; and saturation, rate-limit, and backpressure state.

#### Scenario: Latency appears lower under saturation

- **WHEN** overload rejects or drops work and completed-turn latency decreases
- **THEN** the report includes the rejected/dropped denominator and cannot label
  the result an unqualified throughput or latency improvement

### Requirement: Production failures become tests only through policy

The system SHALL require purpose, retention, redaction, access, artifact hashes,
and deletion lineage before retained production voice becomes a replay fixture.

#### Scenario: Turn lacks replay consent

- **WHEN** an operator attempts to create a fixture from a turn whose policy
  does not permit that purpose
- **THEN** fixture creation is rejected and no audio or transcript is copied

### Requirement: Voice content has end-to-end data governance

The system SHALL classify bounded operational metadata, redacted/derived
content, and raw content artifacts and SHALL default to metadata-only
collection. Raw content retention SHALL require a documented purpose,
participant/tenant policy, retention class, tenant-scoped encryption, and an
opaque artifact reference; raw values SHALL remain out of telemetry attributes
and agent instructions. Sensitive metadata and derived content SHALL be
redacted before persistence. RBAC and audit SHALL cover access/export. Deletion
SHALL propagate through managed sources, derivatives, fixtures, indexes, caches,
exports, and backup-expiry/tombstone processing; recipient-controlled exports
receive revocation of managed links plus a signed tombstone rather than a false
erasure guarantee.

#### Scenario: Deleted content is followed through restore

- **WHEN** retained voice content is deleted and a backup restore drill runs
- **THEN** the restored system honors the tombstone or expiry policy and does
  not silently make the content available again

### Requirement: The improvement agent proves changes without gaming

An independent coordinator SHALL sign a hashed benchmark manifest before the
candidate runs. The improvement agent SHALL compare paired baseline/candidate
sample IDs using the same corpus, collection/aggregation code, evaluators, and
minimum sample/confidence policy; SHALL include every scheduled, failed,
timed-out, dropped, and censored attempt; SHALL report regressions; and SHALL NOT
edit telemetry, corpus, workflow, denominator, status, policy, or quality/safety
authority.

Final improvement claims SHALL use a coordinator-owned sealed holdout with
hidden labels, an immutable ledger of every attempted candidate, and a versioned
repeated-trial/multiple-hypothesis correction.

#### Scenario: Candidate lowers latency by truncating replies

- **WHEN** a candidate improves time-to-first-audio but reduces required answer
  completeness or task success
- **THEN** the result is reported as a trade-off or regression and cannot be
  labeled an unqualified improvement

### Requirement: Production authority remains human-controlled

The initial product SHALL keep diagnosis access read-only. A later candidate
agent SHALL run in a capability-enforced sandbox with exact path/parameter
allowlists, no production credentials or production write API, controlled
egress, and immutable corpus/evaluator/policy/aggregation/telemetry/workflow/
deployment paths. Captured content SHALL be treated as untrusted data, never
instruction. A separate branch-only principal SHALL require human approval for
merge and production rollout.

#### Scenario: Agent finishes a successful experiment

- **WHEN** the candidate passes the fixed replay gate
- **THEN** the system may open an evidence-backed pull request but cannot merge,
  deploy, or change production configuration

### Requirement: Promotion obeys live-state safety gates

Every deployable candidate SHALL use an isolated preview URL, store, queue,
object path, and worker pool. Promotion SHALL require backup/restore evidence,
backward-compatible state, session-sticky or drained/resumable active work,
independent canary monitoring with automatic stop/rollback, and a post-promotion
smoke check.

#### Scenario: Active voice turn cannot drain or resume

- **WHEN** promotion would interrupt or strand an active turn, upload, replay,
  evaluation, or queue job
- **THEN** promotion stops at the preview artifact and records the blocker

### Requirement: Open-source claims are reproducible

Before a release or component is described as open source, that component SHALL
use an OSI-approved license. The system SHALL publish a component/license matrix,
SPDX-marked licenses, and dependency/codec/model license inventory; SHALL label
proprietary and source-available components separately; SHALL run its core
without a mandatory hosted service or phone-home; and SHALL prove a full-fidelity
hosted export can restore into the self-hosted core.

#### Scenario: Hosted export cannot restore locally

- **WHEN** the hosted data export loses required voice evidence or policy state
- **THEN** the release cannot claim full data portability or complete
  self-hostability

### Requirement: Generic CI optimization remains an integration

The voice product SHALL publish voice-specific regression evidence through CI
without requiring ownership of runners, caches, or general workflow optimization.
Candidate execution SHALL use `pull_request`, read-only repository permissions,
SHA-pinned actions, and no secrets, OIDC, production network, or deployment
credentials. Any check-write operation SHALL run as a separate trusted reporter
that consumes only sanitized artifacts and never executes candidate code.

#### Scenario: Voice regression check runs on a pull request

- **WHEN** CI evaluates a candidate voice change
- **THEN** the check reports voice latency/quality/cost deltas and has no
  permission to deploy or move the production deployment ref
