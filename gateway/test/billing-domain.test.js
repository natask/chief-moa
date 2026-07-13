"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  createBillingDomain, createSandboxBillingProvider, signWebhookFixture,
  MAX_RECONCILE_PAGE,
} = require("../lib/billing-domain");

function fixture(tenantId = "tenant-a", now = 1_800_000_000_000) {
  return createBillingDomain({ tenantId, clock: () => now,
    webhookSecrets: { "sandbox:primary": "test-secret-at-least-sixteen" } });
}

function addPrice(domain, overrides = {}) {
  return domain.appendPriceVersion({ price_id: "model-token", version: "v1", currency: "USD",
    unit_minor: 3, unit_size: 100, effective_at_ms: 1, ...overrides });
}

test("money is safe integer minor units and price history is immutable", () => {
  const domain = fixture();
  addPrice(domain);
  assert.throws(() => addPrice(domain, { unit_minor: 3.1 }), /safe integer/);
  assert.throws(() => addPrice(domain, { unit_minor: 4 }), /immutable/);
  assert.throws(() => addPrice(domain, { currency: "US$" }), /currency/);
  assert.throws(() => addPrice(domain, { version: "crypto", currency: "USDT" }), /currency/);
});

test("usage is tenant-domain deduped, priced by immutable version and append-only", () => {
  const domain = fixture();
  addPrice(domain);
  const input = { source_event_id: "call-1", meter: "output_tokens", quantity: 101,
    price_id: "model-token", price_version: "v1", occurred_at_ms: 2 };
  const first = domain.appendUsage(input);
  const retry = domain.appendUsage(input);
  assert.strictEqual(first.record.amount_minor, 6);
  assert.strictEqual(retry.duplicate, true);
  assert.strictEqual(domain.snapshot().usage.length, 1);
  assert.throws(() => domain.appendUsage({ ...input, quantity: 102 }), /dedupe collision/);
  addPrice(domain, { version: "v2", unit_minor: Number.MAX_SAFE_INTEGER, unit_size: 1 });
  assert.throws(() => domain.appendUsage({ ...input, source_event_id: "call-2", quantity: 2,
    price_version: "v2" }), /overflow/);
});

test("two principals cannot share or probe domain state", () => {
  const a = fixture("tenant-a");
  const b = fixture("tenant-b");
  addPrice(a);
  addPrice(b);
  const input = { source_event_id: "same-provider-id", meter: "requests", quantity: 1,
    price_id: "model-token", price_version: "v1", occurred_at_ms: 2 };
  a.appendUsage(input);
  assert.strictEqual(a.snapshot().usage.length, 1);
  assert.strictEqual(b.snapshot().usage.length, 0);
  assert.strictEqual(a.snapshot().tenant_id, "tenant-a");
  assert.strictEqual(b.snapshot().tenant_id, "tenant-b");
});

test("budget reservation is idempotent, currency-safe and fail-closed", async () => {
  const domain = fixture();
  domain.appendBudgetVersion({ budget_id: "monthly", version: "v1", currency: "USD",
    limit_minor: 10, effective_at_ms: 1 });
  const base = { budget_id: "monthly", budget_version: "v1" };
  const attempts = await Promise.all([1, 2, 3].map(async (n) => domain.reserveBudget({
    ...base, reservation_id: `request-${n}`, amount_minor: 4,
  })));
  assert.strictEqual(attempts.filter((item) => item.accepted).length, 2);
  assert.strictEqual(attempts.filter((item) => item.reason === "over_budget").length, 1);
  assert.strictEqual(domain.reserveBudget({ ...base, reservation_id: "request-1", amount_minor: 4 }).duplicate, true);
  assert.throws(() => domain.reserveBudget({ ...base, budget_version: "missing", reservation_id: "missing", amount_minor: 1 }), /unknown budget/);
  assert.throws(() => domain.reserveBudget({ ...base, reservation_id: "request-1", amount_minor: 5 }), /collision/);
});

test("budget authority is immutable and caller cannot raise its limit", () => {
  const domain = fixture();
  domain.appendBudgetVersion({ budget_id: "monthly", version: "v1", currency: "USD",
    limit_minor: 10, effective_at_ms: 1 });
  domain.reserveBudget({ budget_id: "monthly", budget_version: "v1", reservation_id: "one", amount_minor: 8 });
  const attack = domain.reserveBudget({ budget_id: "monthly", budget_version: "v1",
    reservation_id: "two", amount_minor: 3, limit_minor: 1000 });
  assert.deepStrictEqual(attack, { accepted: false, reason: "over_budget", reserved_minor: 8 });
  assert.throws(() => domain.appendBudgetVersion({ budget_id: "monthly", version: "v1", currency: "USD",
    limit_minor: 1000, effective_at_ms: 1 }), /immutable/);
  domain.appendBudgetVersion({ budget_id: "other", version: "v1", currency: "USD", limit_minor: 10, effective_at_ms: 1 });
  assert.strictEqual(domain.reserveBudget({ budget_id: "other", budget_version: "v1",
    reservation_id: "one", amount_minor: 2 }).accepted, true, "reservation namespaces include budget");
});

test("signed raw webhook is replay-safe, stale-safe, bounded and provider evidence only", () => {
  const now = 1_800_000_000_000;
  const domain = fixture("tenant-a", now);
  const raw = Buffer.from(JSON.stringify({ id: "evt-1", type: "invoice.paid", state: "active" }));
  const signature = signWebhookFixture({ rawBody: raw, secret: "test-secret-at-least-sixteen", timestampSeconds: now / 1000 });
  const first = domain.ingestWebhook({ provider: "sandbox", secret_id: "primary", raw_body: raw, signature });
  const duplicate = domain.ingestWebhook({ provider: "sandbox", secret_id: "primary", raw_body: raw, signature });
  assert.strictEqual(first.receipt.status, "verified_unapplied");
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(domain.snapshot().entitlements.length, 0, "provider payload must not directly mutate authority");
  assert.throws(() => domain.ingestWebhook({ provider: "sandbox", secret_id: "primary", raw_body: `${raw} `, signature }), /signature/);
  const collisionRaw = Buffer.from(JSON.stringify({ id: "evt-1", type: "invoice.paid", state: "different" }));
  const collisionSignature = signWebhookFixture({ rawBody: collisionRaw,
    secret: "test-secret-at-least-sixteen", timestampSeconds: now / 1000 });
  assert.throws(() => domain.ingestWebhook({ provider: "sandbox", secret_id: "primary",
    raw_body: collisionRaw, signature: collisionSignature }), /collision/);
  const stale = signWebhookFixture({ rawBody: raw, secret: "test-secret-at-least-sixteen", timestampSeconds: now / 1000 - 301 });
  assert.throws(() => domain.ingestWebhook({ provider: "sandbox", secret_id: "primary", raw_body: raw, signature: stale }), /stale/);
});

test("out-of-order entitlement, refund and dispute facts remain explicit and immutable", () => {
  const domain = fixture();
  domain.appendEntitlement({ entitlement_id: "plan", version: "v2", state: "active", effective_at_ms: 20, policy_ref: "policy-unresolved" });
  const old = domain.appendEntitlement({ entitlement_id: "plan", version: "v1", state: "past_due", effective_at_ms: 10, policy_ref: "policy-unresolved" });
  assert.strictEqual(old.out_of_order, true);
  domain.appendAdjustment({ adjustment_id: "refund-1", kind: "refund", currency: "USD",
    amount_minor: -5, source_receipt_id: "receipt-1", occurred_at_ms: 30 });
  domain.appendAdjustment({ adjustment_id: "dispute-1", kind: "dispute", currency: "USD",
    amount_minor: -5, source_receipt_id: "receipt-2", occurred_at_ms: 31 });
  assert.throws(() => domain.appendAdjustment({ adjustment_id: "refund-1", kind: "refund", currency: "USD",
    amount_minor: -6, source_receipt_id: "receipt-1", occurred_at_ms: 30 }), /immutable/);
  assert.strictEqual(domain.snapshot().adjustments.length, 2);
});

test("reconciliation is cursor-paginated and hard bounded", () => {
  const domain = fixture();
  for (let i = 0; i < 205; i += 1) {
    domain.appendAdjustment({ adjustment_id: `correction-${i}`, kind: "correction", currency: "USD",
      amount_minor: 0, source_receipt_id: `receipt-${i}`, occurred_at_ms: i });
  }
  const first = domain.reconcile({ limit: MAX_RECONCILE_PAGE });
  const second = domain.reconcile({ cursor: first.next_cursor, limit: MAX_RECONCILE_PAGE });
  const third = domain.reconcile({ cursor: second.next_cursor, limit: MAX_RECONCILE_PAGE });
  assert.deepStrictEqual([first.items.length, second.items.length, third.items.length], [100, 100, 5]);
  assert.strictEqual(third.next_cursor, null);
  assert.throws(() => domain.reconcile({ limit: 101 }), /safe integer/);
});

test("sandbox adapter records hashes and can never charge", () => {
  const provider = createSandboxBillingProvider({ clock: () => 12 });
  for (const result of [provider.ensureCustomer({ tenant: "a" }), provider.reportUsage({ amount: 4 }),
    provider.checkEntitlement({ tenant: "a" }), provider.webhook({ event: "x" })]) {
    assert.strictEqual(result.effect, "none");
    assert.strictEqual(result.charged, false);
    assert.match(result.input_sha256, /^[a-f0-9]{64}$/);
  }
  assert.strictEqual(provider.operations().length, 4);
});
