# Design

## Authority and trust boundary

Canonical product events remain authoritative. Telemetry is a derived,
loss-tolerant operational projection. Every exported record is constructed by
Moa code from a closed event-name and attribute-key vocabulary; arbitrary
product payloads are never recursively scrubbed and forwarded.

Opaque trace, parent-event, and canary IDs support debugging but are excluded
from metric dimensions. User and tenant IDs are neither attributes nor metric
labels. Release `{version, build_id}` fields correlate gateway, Android,
extension, website, and worker observations without provider credentials.

## Export behavior

`createAsyncTelemetryExporter` validates synchronously, enqueues into a fixed
capacity queue, and starts export on a later event-loop turn. Queue overflow,
validation failure, exporter rejection, and exporter outage increment local
counters; they do not throw into the product request path. Batches are bounded.

This seam is transport-neutral. A future adapter may translate envelopes to
OTLP or another protocol only after a Collector/backend preview proves field
mapping, redaction, cardinality, failure isolation, retention, and cost.

## Cross-surface canary

A preview canary uses one random opaque `canary_id`. Each participating surface
emits `canary.started` or `canary.received` with its own release metadata and
the same ID. Acceptance requires querying the isolated preview exporter and
matching the expected surfaces and releases. Screenshots and local emission
alone are not proof of ingestion or correlation.

## Resource budgets

Architecture-confidence targets, not measured results:

- queue: at most 256 envelopes by default;
- batch: at most 32 envelopes by default;
- attributes: at most 16 allowlisted scalar values, each string at most 96
  characters and constrained to a finite per-key vocabulary;
- exporter wait: at most 2 seconds per batch by default, configurable only
  within 1 millisecond to 60 seconds;
- request path: no await on exporter I/O;
- correlation IDs: never metric dimensions.

The isolated preview must measure serialized bytes/event, queue high-water,
drop count, exporter duration/failures, and process CPU/RSS delta before any
production enablement.

## Deferred identity-dependent work

Consent state, analytics opt-in/out, deletion propagation, tenant residency,
and region policy depend on the MF identity/data foundation. No analytics event
may be enabled until those authorities and hostile two-principal tests exist.
