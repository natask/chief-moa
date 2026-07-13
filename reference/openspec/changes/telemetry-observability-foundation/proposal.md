# Proposal: Moa-owned telemetry and observability foundation

## Why

Moa has durable product events and surface-specific diagnostics, but no shared,
privacy-bounded semantic envelope or portable failure-isolated export seam.
Choosing a vendor before the taxonomy, consent policy, and measured volume are
known would make the SDK/backend define product truth.

## What changes

- Define a versioned Moa semantic telemetry envelope with release and opaque
  cross-surface correlation.
- Enforce an allowlist for low-cardinality attributes and exclude user content,
  credentials, identity, financial data, and high-cardinality IDs by default.
- Add a bounded asynchronous exporter seam whose failure cannot fail product
  behavior.
- Define deterministic preview canaries and the evidence required before a
  vendor or production rollout is approved.

## Non-goals

- Selecting or enrolling in Datadog, Sentry, an OpenTelemetry backend, or any
  other paid service.
- Sending production telemetry or adding client SDKs in this change.
- Claiming measured CPU, memory, network, reliability, or vendor results.
- Implementing consent deletion before the MF identity/sensitivity authority is
  integrated.
