# MB bounded research packet

Date: 2026-07-10

## 1. Repository and data topology

The gateway is one deployable Node process with internal modules. Postgres is
relational product truth and `product_events` is audit/outbox, not a replayed
hot-path projection. The MF migration establishes tenant-owned `users` and RLS
through `current_setting('moa.user_id')`. Billing should therefore add additive
tables with `user_id`, RLS and bounded indexes, while domain logic stays behind
one narrow module. It must not add a service or modify live model routing.

## 2. Money and idempotency invariants

All monetary values are safe integers in minor units plus uppercase ISO-like
currency identifiers. A price version is immutable. A usage fact is immutable
and uniquely deduped in a tenant-scoped namespace. Corrections append facts;
they never rewrite history. Provider operations derive domain-separated
idempotency identities rather than trusting caller keys globally. Overflow,
negative billable usage and currency mixing fail closed.

## 3. Tenant and trust boundaries

Trusted server identity supplies `tenant_id`; payload identity may not replace
it. Models and clients receive read/proposal surfaces only and cannot create
payment facts or entitlement authority. Webhook payloads are untrusted until a
raw-body signature and timestamp are verified. Provider state is evidence that
produces an append-only local fact; it is never the canonical ledger itself.

## 4. Crash, replay and reconciliation

Expected failures are duplicate and out-of-order webhooks, crash after receipt,
concurrent budget reservations, provider outage, stale grace transitions,
refund/dispute corrections, and reconciliation restart. Receipt/event IDs are
deduped before effects. Reconciliation is cursor-based and hard-page-bounded.
Unknown policy states remain `review_required`; they do not silently grant or
revoke access.

## 5. Test and quality strategy

Use deterministic clocks and HMAC fixtures, hostile tenant probes, duplicate and
out-of-order delivery, safe-integer boundaries, currency mismatch, concurrent
reservation attempts, outage/grace, refund/dispute append-only transitions and
pagination. Decision functions target cyclomatic complexity <=10 and CRAP <=15;
exceptions block audit. No mock demonstrates a live provider, charge, tax, or
production webhook.

## 6. Dated official provider facts and tool/model choice

Official Stripe documentation reviewed 2026-07-10 says webhook raw bodies are
required for signature verification, delivery can duplicate and arrive out of
order, timestamp tolerance mitigates replay, and processing should be
asynchronous. It also documents request idempotency, asynchronous meter
aggregation and whole-number usage. These facts justify generic invariants, not
selecting Stripe or copying its state model. Sources:

- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api
- https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

Tool choice: Node built-ins (`crypto`, `node:test`) and existing Postgres
migrations are sufficient. No SDK is needed for a provider-neutral sandbox.
The strongest available state/security reasoning context is warranted for the
contract and a fresh hostile context for audit. This is an architecture choice,
not a measured model-quality result.

## Unresolved policy escalations

Commercial plan shape, tax geography, currency set, prices, trial boundary,
refund/grace/dispute policy, provider selection and paid-account authority are
unknown. The implementation may represent these as versioned facts and explicit
states only; it may not choose values or execute money movement.
