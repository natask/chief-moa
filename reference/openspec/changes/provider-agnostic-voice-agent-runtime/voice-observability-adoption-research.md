# Voice observability build-vs-adopt decision

Date: 2026-07-10

## Decision

Keep P1 vendor-neutral and local: emit bounded stage events into the existing
per-turn provider-event ledger and copy timing summaries into canonical voice
turns. Do not add an OpenTelemetry SDK, Collector, Datadog agent, exporter, or
paid service in this lane. A later architecture-approved adapter can translate
the stable event schema to OTLP without changing voice execution.

This is an architecture decision, not a measured benchmark result. No paid
benchmark, external telemetry backend, production load test, or live provider
evaluation was run.

## Data and collection points

P1 records stage start/done/error events for STT, reasoning, TTS, and the first
assistant PCM write. Records carry session/turn correlation, provider IDs,
bounded durations, byte/character counts, low-cardinality stage metadata, and a
bounded one-line error summary. Existing transcript and assistant events remain
unchanged; stage events do not add raw audio or new transcript copies.

Collection happens at the gateway provider boundary, where actual stage entry,
exit, failure, and first audio write are observable. The gateway already has
the client session/turn IDs, so browser/phone activity can correlate to backend
voice work without propagating provider credentials or user content through a
new telemetry channel.

## Retention and redaction

P1 inherits the existing DATA_DIR provider-event and canonical-turn lifecycle.
It introduces no new remote retention. Stage detail keys and values are bounded;
errors are flattened and capped. Provider IDs, languages, counts, and timings
are retained, while credentials and raw audio are not stage attributes.

Residual risk: general provider error messages may themselves contain sensitive
upstream detail. Before any external export, an explicit allowlist/redaction
processor and retention policy are required. OpenTelemetry documents Collector
filter, attributes, transform, and redaction processors for governance, but
several processor signal implementations are not all stable, so configuration
must be tested rather than assumed.

## Build versus adopt

OpenTelemetry supports traces, metrics, logs, and baggage, with context
propagation and vendor-selectable exporters. Its metrics model is appropriate
for later aggregate latency histograms, while traces are appropriate for a
turn-to-stage lifecycle. It also warns that baggage crosses process/network
boundaries and can expose sensitive identifiers, and that high-cardinality
metric attributes increase memory cost. Therefore raw session or turn IDs must
not become metric labels, and user identifiers/content must not be propagated as
baggage by default.

Datadog can ingest OTLP traces, metrics, and logs and correlate them, offers log
indexes with retention and quota controls, and prices ingestion, indexing, and
APM separately. That could provide dashboards and alerts faster than building a
full backend. It also creates recurring cost and operational/vendor coupling;
indexed-event volume and high-cardinality traces materially affect the design.
Adopting it before the event semantics and actual traffic volume are known would
prematurely lock collection and retention decisions to a paid backend.

P1's local schema is appropriate now because it supplies deterministic fault
evidence for the existing `moa-voice-qa` read path, preserves the current trust
boundary, has no new availability dependency, and provides real data from which
to design sampling, aggregation, retention, and backend budgets. It does not
claim the query, alerting, fleet aggregation, or visualization capabilities of
OpenTelemetry plus a backend.

## Future adoption gate

Before introducing an external telemetry dependency, architecture approval must
define: OTLP field mapping; trace/span sampling; metric cardinality budget;
content and error allowlists; client-to-gateway correlation without sensitive
baggage; local and vendor retention; deletion/export controls; monthly ingest,
index, and egress budgets; failure behavior; and a second-backend export test to
demonstrate acceptable lock-in.

## Official sources reviewed

- OpenTelemetry signals and instrumentation:
  https://opentelemetry.io/docs/concepts/signals/
  and https://opentelemetry.io/docs/concepts/instrumentation/
- OpenTelemetry metrics/cardinality:
  https://opentelemetry.io/docs/concepts/signals/metrics/
- OpenTelemetry baggage security:
  https://opentelemetry.io/docs/concepts/signals/baggage/
- OpenTelemetry Collector transformation/processors:
  https://opentelemetry.io/docs/collector/transforming-telemetry/
  and https://opentelemetry.io/docs/collector/components/processor/
- Datadog OTLP receiver and compatibility:
  https://docs.datadoghq.com/opentelemetry/config/otlp_receiver/
  and https://docs.datadoghq.com/opentelemetry/compatibility/
- Datadog log retention/index controls:
  https://docs.datadoghq.com/logs/log_configuration/indexes/
- Datadog current public pricing:
  https://www.datadoghq.com/pricing/
