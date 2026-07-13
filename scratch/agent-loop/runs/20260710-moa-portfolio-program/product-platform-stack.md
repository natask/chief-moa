# Cross-cutting product platform stack

This is a responsibility map, not a mandate to buy one suite or to create one
service per box. Each product program must state which rows it changes and how
the signals correlate end to end.

| Area | Required responsibility | Current Moa direction | Research/implementation gate |
|---|---|---|---|
| product data | canonical users, devices, profiles, sessions, turns, runs, actions, receipts, billing and artifacts | gateway/Postgres plus bounded blob refs; clients own local permissions and receipts | schema ownership, retention, deletion/export, backup and restore |
| backend | authenticated APIs, provider routing, work orchestration, durable events, policy proposals | self-hostable gateway with local/self-host/hosted modes | service boundaries must be splittable without premature microservices |
| frontend | Android, extension, website, future native shells | thin native surfaces with local authority | accessibility, offline/degraded state, version compatibility and action receipts |
| telemetry | correlated traces, metrics, structured logs and product events | vendor-neutral semantic envelope first | stable IDs, sampling, redaction, cardinality and cost budgets |
| observability | diagnosis, dashboards, alerts, SLOs, replay/fault evidence | local self-hosted diagnosis remains the product truth; optional external backend | build-vs-adopt decision, export interface, canaries and alert verification |
| identity/security | users, devices, scopes, secrets, approvals, audit | least-privilege device tokens; secrets stay server-side | expiry/replay protection, origin binding, RLS and threat model |
| payments | metering, entitlements, budgets, billing adapter and reconciliation | provider-neutral billing seam; no payment authority in model context | ledger idempotency, webhook verification, refunds/disputes and privacy |
| operations | CI, isolated preview, safe promotion, rollback, backup/restore, queues | guarded VPS/OTA/extension paths | prove drain/resume, compatibility, artifact provenance and post-apply smoke |
| product analytics | activation, reliability funnels and feature outcomes | privacy-bounded product events distinct from debug telemetry | consent, aggregation, retention and no sensitive transcript leakage |

## Observability build-versus-adopt decision frame

The default architecture target is OpenTelemetry-compatible instrumentation and
an OTLP/collector seam, because it keeps telemetry portable across self-hosted
and managed backends. It does not itself provide storage or visualization. For
the current Node gateway, traces and metrics are stable in the JavaScript SDK;
logs remain under development, and browser instrumentation is experimental.
Therefore P1 should not make browser correctness depend on experimental OTel
instrumentation or replace Moa's canonical product events with vendor telemetry.

Candidate backend classes must be evaluated separately:

- managed full-stack observability (for example Datadog) when operational speed,
  RUM/APM correlation, alerting, and support justify recurring cost;
- error/product-experience tooling when stack traces, releases, replay, and
  frontend failures are the primary gap;
- self-hosted metrics/logs/traces stacks when data control and self-hostability
  outweigh operator burden;
- Moa-native diagnosis records for voice/action correctness that external APM
  cannot infer, such as transcript source, TTS spoke/error, proposal/claim,
  local apply, receipt, and rollback state.

No vendor is selected by this planning note. A contractor must compare current
official capabilities, pricing/cardinality implications, retention, regional
data handling, mobile/browser SDK maturity, self-hostability, and OTLP export
before adding a dependency.

## Correlation contract

Every cross-surface operation should carry bounded, non-secret identifiers where
applicable: `trace_id`, `session_id`, `branch_id`, `turn_id`, `run_id`,
`action_id`, `receipt_id`, `profile_version`, deployment version, surface,
provider/mode, and redacted failure phase. High-cardinality identifiers belong
in traces/logs, not metric label sets. Raw audio, transcripts, tokens, prompts,
page content, and credentials are excluded by default and governed by explicit
retention/consent when needed for replay.

## Model and agent selection record

Each contract records:

- research uncertainty and whether current external facts are required;
- architecture/security risk;
- code breadth and language/tooling specialization;
- selected agent/model/reasoning level and the reason;
- whether a second independent model is used for adversarial audit;
- commands and evidence used to verify output rather than trusting the model.

Stronger models are reserved for architecture compilation, security boundaries,
cross-repo reconciliation, and hard repair loops. Narrow mechanical edits use a
smaller/faster executor only when deterministic verification is strong.

## Research sources checked on 2026-07-10

- OpenTelemetry documentation: vendor-neutral generation, collection and export
  of traces, metrics and logs; storage/visualization are separate backends.
- OpenTelemetry JavaScript status: traces and metrics stable, logs in
  development, browser client instrumentation experimental.
- OpenTelemetry production guidance: export through a Collector and use context
  propagation for trace/log correlation.

These are architecture inputs, not evidence that Moa has implemented or measured
an OpenTelemetry deployment.
