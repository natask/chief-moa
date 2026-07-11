# Research packet: product stack and model selection

Date: 2026-07-10  
Lane: `agent/stack-model-research`  
Scope: architecture research only; no product code, paid service, provider call,
external evaluation, or production inspection was performed.

## Evidence labels

- **Current repo evidence** means an inspected file, dependency, schema, test, or
  documented boundary exists in this checkout. It does not prove production use.
- **Architecture-confidence target** is a proposed design/gate justified by repo
  constraints. It is not a benchmark score.
- **Unmeasured** means no live provider, production traffic, paid benchmark,
  external evaluation, cost measurement, SLO observation, or vendor proof was run.

## Finding

The six boxes named by the user are necessary responsibilities, but they are not
the whole application contract. Moa already has frontend and backend surfaces,
substantial domain-specific diagnostics, a Postgres-capable durable event model,
and deployment machinery. The largest portfolio gaps are production-grade
identity/tenant isolation, a portable telemetry export plane, explicit retention
and data-governance controls, payments/entitlements, and verified operational
SLO/backup/restore evidence. Queues/workflow durability, security policy,
deployment/rollback, product analytics, support/admin tooling, accessibility,
and compliance are also responsibilities even if they do not become independent
services.

## Current evidence and gaps

| Responsibility | Current repo evidence | Gap / residual unknown | Confidence |
|---|---|---|---|
| Frontends | Native Android, Chrome extension, gateway-served UI and website boundary are documented in `README.md` and `ARCHITECTURE.md`. Clients own local actions and receipts. | No whole-product accessibility matrix, frontend error/RUM contract, release-health dashboard, or cross-version compatibility evidence was found. | Architecture boundary: high. Production quality: unmeasured. |
| Backend | Node gateway owns auth, provider routing, voice, sessions, agent runs and tool routing. `gateway/package.json` has deterministic checks and smokes. | Gateway remains a large deployable; service split triggers, load limits, tenancy limits, and production SLOs are not measured. | Architecture boundary: high. Capacity/reliability: unmeasured. |
| Database/product data | `gateway/schema.sql` defines Postgres work nodes/runs/events/artifacts, canonical `product_events`, projections, blobs, sync imports, and account connections. Remote mode requires `DATABASE_URL`; file fallback remains for local QA. | Schema coverage is not the same as active production migration. Retention/deletion/export, RLS, tenant isolation, PITR objectives, restore drills, billing tables, and data-classification enforcement remain incomplete or unproven. | Durable model: medium-high architecture confidence. Production durability: unmeasured. |
| Backend observability | Voice phase diagnostics, durable voice/provider events, run lifecycle, health endpoints, and Moa-native receipts exist. The Wave 1 ledger records deterministic checks. | No verified OTLP collector/export, fleet dashboard, paging policy, SLO burn alerts, or production cardinality/cost evidence. Domain diagnostics must remain canonical even after adopting APM. | Diagnostic code shape: verified deterministically where claimed. Operational effectiveness: unmeasured. |
| Frontend observability | Extension/Android expose observable UI and receipt behavior and have smoke/build gates. | No common crash/error envelope, release correlation, RUM/mobile performance baseline, consent contract, or session replay redaction proof. Browser correctness must not depend on experimental instrumentation. | Target only; unmeasured. |
| Telemetry | `product_events` includes causation/correlation/idempotency and the program stack specifies bounded IDs and redaction. | No common semantic versioned envelope is proven across Android/extension/gateway; no sampling, metric-cardinality, retention, exporter, or cost budgets are enforced. | Architecture direction: medium-high. Implementation: partial/unmeasured. |
| Payments | Payments are an external integration boundary; sensitive payment actions are explicitly blocked in Android/product design. Program plan calls for metering, entitlements, budgets, reconciliation and verified webhooks. | No customer/subscription/entitlement/usage/invoice ledger or payment-provider adapter was found. Tax, refunds, disputes, dunning, webhook replay/idempotency and privacy are unimplemented. | Safety boundary: high. Billing capability: absent/unmeasured. |
| Identity/security | Provider secrets stay gateway-side; remote mode requires auth; account connection credential separation is modeled. Proposal/action/local-authority boundary is explicit. | Current token-derived/single-user assumptions do not prove multi-tenant isolation. Device token lifecycle, scoped auth, RLS, origin binding, audit access, secret rotation and threat-model gates need dedicated work. | Core trust boundary: high. Hosted multi-tenancy: unproven. |
| Operations | Isolated worktrees, preview/promotion gates, VPS backup/restore checks, OTA and extension artifacts are documented. | Production drain/resume, rollback duration, restore success, preview isolation and post-deploy smoke must be evidenced per release; documentation alone is not evidence. | Process architecture: high. Current release readiness: per-release/unmeasured here. |
| Product analytics | Program plan separates privacy-bounded product events from debug telemetry. | No event taxonomy, consent, activation/reliability funnels, warehouse/export, experiment policy or deletion propagation was found. | Target only. |

## Data and trust-boundary contract

Recommended classification before adding any vendor SDK:

| Class | Examples | Default handling |
|---|---|---|
| Public/product metadata | app/version, surface, coarse feature state | May enter metrics/logs after bounded-cardinality review. |
| Pseudonymous operational IDs | trace/session/turn/run/action/receipt IDs | Traces/logs only; hash or rotate where cross-tenant correlation is unnecessary; never metric labels. |
| User content | transcripts, audio, prompts, page/screen context, generated artifacts | Excluded from external telemetry by default; explicit purpose, consent, encryption, retention and deletion required. |
| Authentication/secrets | gateway/device tokens, OAuth/API keys, cookies, payment credentials | Never telemetry/model context; server-side vault/encrypted credential boundary only. |
| Financial/security state | entitlements, usage ledger, invoices, approvals, receipts | Authoritative transactional store; append-only audit and strict access; model can propose or explain, never mutate authority directly. |

Every operation should propagate a bounded correlation context across surfaces,
but the authoritative product event/receipt stays in Moa storage. A vendor outage
must not break actions, receipts, voice turns, billing authority, or diagnosis.

## Build-versus-buy recommendations

### Telemetry and observability

Build the semantic contract; buy or self-host the commodity backend.

1. Define Moa-owned versioned events and spans for voice phases, model calls,
   tool proposals, claims, execution, receipts, deployment and billing.
2. Add an OpenTelemetry-compatible gateway seam and Collector boundary. Keep
   product events and domain diagnostics independent of export success.
3. Evaluate backends with the same scrubbed replay corpus. Options:
   - managed full-stack APM/RUM (for example Datadog) for fastest integrated
     dashboards, alerting and support, at recurring ingestion/cardinality cost;
   - error-focused tooling for crash/release health when APM breadth is not yet
     justified;
   - self-hosted metrics/logs/traces for control and self-hostability, accepting
     operator burden;
   - hybrid: managed errors/APM for hosted Moa, local Collector/backend for
     self-hosted deployments.
4. Select only after official-current capability, SDK maturity, regional data
   handling, retention, deletion, sampling, pricing and OTLP portability review.

Do not build a bespoke trace database, dashboard engine, crash symbolication
service, or paging system. Do build the redaction, domain state machine,
correlation, receipt, canary and export-failure behavior unique to Moa.

### Database

Continue with Postgres as the canonical transactional/event substrate rather
than introducing a second primary database. Use object/blob storage behind
content-addressed references for retained audio/artifacts. Add managed Postgres
when operational load warrants it; keep migrations and restore checks portable.
Do not add a warehouse or vector database until a measured query/retrieval need
cannot be met by Postgres indexes/extensions and bounded projections.

### Payments

Buy payment collection, invoicing, tax and payment-method compliance from a
provider; build a provider-neutral Moa billing boundary:

`meter event -> immutable usage ledger -> price/version -> entitlement/budget
projection -> provider invoice/payment -> verified webhook -> reconciliation`.

The provider is not the entitlement source of truth during webhook delay or
outage. Contracts require idempotency keys, signed webhook verification, replay
handling, refunds/disputes, grace periods, spend caps, audit receipts, deletion
rules and a test clock/sandbox. Payment actions remain outside model authority.

## Model and agent selection rubric

Model choice is a risk allocation decision, not a prestige ranking. The manager
records selection and verifies outputs with commands/auditors.

| Task shape | Data/context | Recommended agent/model class | Required guardrail |
|---|---|---|---|
| Repo inventory, topology, dependency or official-doc research | Broad read-only corpus; potentially current facts | Multiple narrow research agents; strong search/reasoning model when synthesis spans surfaces | Cite repo paths/current primary sources; no edits; distinguish facts from inference. |
| Architecture, tenancy, identity, billing, data retention, trust boundaries | Cross-cutting, high consequence, ambiguous | Most capable reasoning model available plus independent security/anti-gaming auditor from a separate context/model when possible | Contractor compiles a hard contract; human-visible unresolved decisions; threat model and rollback gates. |
| Narrow mechanical implementation with exact owned files | Small bounded context, deterministic behavior | Faster/lower-cost coding model | Strict ownership, focused tests, no architecture invention; block on contradiction. |
| Complex multi-file state machine, concurrency, migration or protocol change | Large code context and edge cases | High-capability coding/reasoning model, optionally paired with specialist researchers | Isolated worktree, invariant tests, failure injection, migration compatibility and repair loop. |
| UI implementation | Design assets, accessibility/state behavior, browser/mobile runtime | Capable UI/code model; vision-capable model only when visual evidence is supplied | Real runtime smoke, accessibility checks, no screenshot-only acceptance. |
| Security audit | Untrusted inputs, auth, storage, execution boundary | Fresh adversarial high-reasoning auditor | Hostile claims ledger, file:line evidence, abuse cases; implementer self-report is not proof. |
| Performance/resource work | Traces/profiles/bench fixtures | Specialist agent/model can propose hypotheses; executor runs measurements | No score claim without measured environment, dataset, repetitions and uncertainty. |
| Model/provider selection for product inference | Representative consented/redacted task corpus | Evaluation harness first; candidate providers/models second | Blind task scoring, safety/failure rubric, latency/cost measurement, version/date pinning; paid runs need explicit approval. |

Escalate to a stronger model when architecture is missing/contradictory, the
change crosses trust boundaries, deterministic gates are weak, failures involve
concurrency/state recovery, or an audit/refutation requires broad synthesis.
More model capability never substitutes for a contract, isolation, measurement,
or an independent audit.

## Acceptance roadmap

1. **Inventory contract:** map every canonical datum to owner, store, retention,
   deletion/export, sensitivity and correlation fields.
2. **Telemetry foundation:** versioned semantic envelope, redaction tests,
   bounded-cardinality metrics, Collector/export failure isolation, Android and
   extension crash/release correlation.
3. **Observability evaluation:** scrubbed deterministic canaries plus a limited
   preview deployment comparing two backend classes; measure ingestion volume,
   query usefulness, alert delay, SDK overhead and cost. No production SDK fanout
   before this gate.
4. **Database hardening:** multi-tenant identity/RLS design, migration and
   backward-compatibility tests, retention/deletion/export jobs, encrypted blob
   references, backup and scratch restore evidence.
5. **Payments contract and sandbox:** immutable usage/entitlement schema,
   provider adapter, signed/replayed webhook tests, reconciliation and test-clock
   scenarios. Keep model and clients outside payment authority.
6. **Product analytics:** consented taxonomy derived from canonical product
   events, not duplicated ad-hoc SDK calls; validate deletion and no-content
   leakage.
7. **Operational SLOs:** define and then measure availability, voice/action
   completion, latency, queue age, error budget, restore and rollback objectives.

## Claims ledger for this packet

| Claim | Evidence checked | Verdict |
|---|---|---|
| Moa has frontend/backend application surfaces | `README.md`, `ARCHITECTURE.md`, component directories | Verified architecture/repo presence; production UX unproven. |
| Moa has a Postgres-capable event/data foundation | `gateway/schema.sql`, `gateway/lib/event-substrate.js`, remote-mode tests | Verified code/schema presence; production migration, scale and restore unproven. |
| Moa has domain observability | voice/run lifecycle docs, scripts and Wave 1 claims ledger | Verified deterministic evidence only for recorded gates; production signal quality unmeasured. |
| Moa has OpenTelemetry/Datadog deployed | No implementation or deployment evidence found | Refuted/unproven; planning direction only. |
| Moa has payments | Boundaries and planning rows only | Refuted as a current capability; payment actions are intentionally blocked. |
| A specific vendor or model is best | No representative benchmark, paid run, pricing evaluation or external eval performed | Unproven. Use the rubrics and measured preview gates above. |

## Residual unknowns

- Actual production schema/deployment, traffic volume, error rates, costs,
  backup/restore recency and tenant count were not inspected.
- No current vendor documentation/pricing comparison was performed in this
  repo-only lane; vendor selection needs a dated primary-source research pass.
- No external SDK overhead, mobile battery/network impact, browser performance,
  metric cardinality, alert precision, or payment sandbox was measured.
- Legal/compliance requirements depend on customer geography, content retention,
  payment flow and business model; no compliance conclusion is claimed.
