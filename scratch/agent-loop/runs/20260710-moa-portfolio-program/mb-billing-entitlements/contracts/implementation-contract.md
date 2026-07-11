# MB implementation contract

## Objective and non-negotiables

Add an isolated provider-neutral billing substrate that proves local domain
invariants without charging. Money is integer minor units plus currency;
historical usage, price, webhook and receipt facts are append-only. Tenant scope
comes from constructor/server authority. Signed webhook fixtures are replay-safe.
Budgets fail closed and reconciliation is bounded.

## Owned files

- `gateway/lib/billing-domain.js`
- `gateway/migrations/1783296000002_billing-domain.js`
- `gateway/test/billing-domain.test.js`
- `gateway/test/integration/migrations.integration.test.js` (table expectations)
- `gateway/package.json` (focused script only)
- `reference/openspec/changes/production-grade-hosted-product/*` only if needed
- this MB evidence directory

No `server.js`, client, auth, telemetry or deployment edits.

## Required interfaces and behavior

`createBillingDomain({tenantId, clock, webhookSecrets})` exposes price-version,
usage, entitlement, budget-reservation, webhook, adjustment/reconciliation and
snapshot methods. Inputs are bounded plain records. Returned records are copies.
All identifiers are typed/bounded. Usage dedupe is tenant + meter + source event.
Prices cannot mutate; a new version is required. Webhook signatures cover the
raw body and timestamp; stale/invalid/unknown-secret requests have no effect.
Duplicate webhook delivery returns the original receipt. Provider event time
may be out of order; local append order and explicit version prevent rollback.
Refund/dispute/grace changes append adjustment/entitlement facts. Reconciliation
accepts at most 100 records per page and returns a cursor.

The additive migration creates tenant-owned immutable fact tables and current
projection tables with safe-integer numeric checks, compound uniqueness, RLS,
indexes and no destructive down migration.

## Forbidden shortcuts

No floats, mutable fact updates, unsigned webhook authority, provider-as-truth,
raw caller-global idempotency, client/model payment mutation, embedded secrets,
real provider SDK/calls, unbounded list/reconcile, tax or grace defaults, or
tests that only assert mocks were invoked.

## Quality and performance gates

- Decision complexity <=10 and CRAP <=15 target; auditor must inspect.
- O(1) indexed/deduped append and budget operations in the in-process seam.
- Reconciliation page <=100; identifier/body bounds; no unbounded retry loop.
- Exact checks: `node --test test/billing-domain.test.js`, `node --check
  lib/billing-domain.js`, `npm run check`, and migration integration when an
  isolated Postgres URL is available.

## Audit blockers and escalation

Block on any forbidden shortcut, cross-tenant read/write, replay effect,
currency alias, overflow, rewritten history, policy invention or broad gateway
regression. Escalate real provider selection, pricing, taxes, refunds, grace,
trials, legal retention, credentials and live deployment to Tier 0/user.
