# MB manager goal

Build a provider-neutral, no-charge billing domain seam: immutable usage and
price facts, tenant-scoped entitlement/budget projections, signed replay-safe
webhook ingestion, bounded reconciliation, and immutable audit receipts.

- Branch: `agent/mb-billing-entitlements`
- Worktree: `chief-moa-worktrees/mb-billing-entitlements`
- Own: `gateway/lib/billing-domain.js`, billing migration, billing tests and MB
  OpenSpec/manager evidence.
- Do not touch: clients, identity/auth implementation, general telemetry,
  deployment, model routing, or live provider configuration.
- No real charge, provider account, credential, purchase, tax decision, plan
  price, refund policy, dispute policy, or grace duration is authorized.
- Acceptance: focused billing tests, syntax, gateway check, migration test when
  an isolated `DATABASE_URL` exists, hostile two-principal tests, and a fresh
  auditor claims ledger.
- Live-app constraint: source/artifact only; no preview or active promotion.
