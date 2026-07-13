# Research packet: topology and adoption decision

Date: 2026-07-10

## Repository topology

- `gateway/lib/event-substrate.js` owns canonical product-event persistence;
  telemetry must not replace it.
- Voice already records bounded stage diagnostics and explicitly treats those
  writes as best-effort observability.
- Gateway, Android, and extension have surface-specific logs but no common
  semantic release/correlation envelope.
- MF identity/data is the dependency for tenant-aware consent and deletion;
  those behaviors are deferred rather than silently invented.

## Build versus adopt

Reuse the existing Moa event semantics and add a small portable translation
boundary now. Do not add an OpenTelemetry SDK, Collector, Datadog, Sentry, or
another backend in this slice. The existing voice adoption research documents
the primary-source capabilities and risks. A vendor-neutral OTLP-shaped adapter
is still premature until an isolated preview supplies actual volume,
cardinality, resource, retention, and price inputs.

No vendor trial, paid benchmark, external model evaluation, production traffic
analysis, Collector preview, or client crash ingestion ran for this packet.

## Residual unknowns

- Legal consent, residency, and retention policy.
- Production event volume/distribution and scrubbed adversarial corpus.
- Actual exporter CPU/RSS/network cost and backend pricing for Moa's volume.
- Android/extension crash-symbol and release mapping.
- End-to-end deletion behavior after MF identity/data integrates.
