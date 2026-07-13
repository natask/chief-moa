"use strict";

const crypto = require("node:crypto");

const MAX_ID = 160;
const MAX_CURRENCY = 8;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_RECONCILE_PAGE = 100;
const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const ENTITLEMENT_STATES = new Set([
  "active", "limited", "past_due", "grace", "suspended", "disputed",
  "refunded", "review_required", "disabled",
]);

function createBillingDomain(options = {}) {
  const tenantId = requiredId(options.tenantId, "tenantId");
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const secrets = normalizeSecrets(options.webhookSecrets || {});
  const signatureToleranceMs = boundedInteger(
    options.signatureToleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS,
    "signatureToleranceMs", 1, 60 * 60 * 1000,
  );
  const prices = new Map();
  const usageByDedupe = new Map();
  const usage = [];
  const entitlementFacts = [];
  const entitlementsByVersion = new Map();
  const budgetVersions = new Map();
  const budgetReservations = new Map();
  const budgetTotals = new Map();
  const webhookReceipts = new Map();
  const adjustments = [];
  const adjustmentsById = new Map();
  const reconciliationFacts = [];
  let sequence = 0;

  function appendPriceVersion(input) {
    const priceId = requiredId(input?.price_id, "price_id");
    const version = requiredId(input?.version, "version");
    const key = `${priceId}\u0000${version}`;
    const record = fact("price_version", {
      price_id: priceId,
      version,
      currency: currency(input.currency),
      unit_minor: money(input.unit_minor, "unit_minor", { allowNegative: false }),
      unit_size: boundedInteger(input.unit_size, "unit_size", 1, Number.MAX_SAFE_INTEGER),
      effective_at_ms: timestamp(input.effective_at_ms, "effective_at_ms"),
    });
    const existing = prices.get(key);
    if (existing) {
      if (!sameRecord(existing, record, ["sequence", "recorded_at_ms"])) {
        throw new Error("price version is immutable");
      }
      return copy(existing);
    }
    Object.freeze(record);
    prices.set(key, record);
    return copy(record);
  }

  function appendUsage(input) {
    const sourceEventId = requiredId(input?.source_event_id, "source_event_id");
    const meter = requiredId(input?.meter, "meter");
    const dedupeKey = digestKey("usage", tenantId, meter, sourceEventId);
    const record = fact("usage", {
      usage_id: digestKey("usage-id", tenantId, meter, sourceEventId),
      source_event_id: sourceEventId,
      meter,
      quantity: boundedInteger(input.quantity, "quantity", 0, Number.MAX_SAFE_INTEGER),
      price_id: requiredId(input.price_id, "price_id"),
      price_version: requiredId(input.price_version, "price_version"),
      occurred_at_ms: timestamp(input.occurred_at_ms, "occurred_at_ms"),
    });
    const price = prices.get(`${record.price_id}\u0000${record.price_version}`);
    if (!price) throw new Error("unknown price version");
    const existing = usageByDedupe.get(dedupeKey);
    if (existing) {
      if (!sameRecord(existing, record, ["sequence", "recorded_at_ms", "amount_minor", "currency"])) {
        throw new Error("usage dedupe collision");
      }
      return { duplicate: true, record: copy(existing) };
    }
    const units = Math.ceil(record.quantity / price.unit_size);
    record.amount_minor = safeMultiply(units, price.unit_minor);
    record.currency = price.currency;
    Object.freeze(record);
    usageByDedupe.set(dedupeKey, record);
    usage.push(record);
    return { duplicate: false, record: copy(record) };
  }

  function appendEntitlement(input) {
    const state = String(input?.state || "");
    if (!ENTITLEMENT_STATES.has(state)) throw new Error("invalid entitlement state");
    const record = fact("entitlement", {
      entitlement_id: requiredId(input.entitlement_id, "entitlement_id"),
      version: requiredId(input.version, "version"),
      state,
      effective_at_ms: timestamp(input.effective_at_ms, "effective_at_ms"),
      reason: optionalId(input.reason, "reason"),
      policy_ref: optionalId(input.policy_ref, "policy_ref"),
    });
    const entitlementKey = `${record.entitlement_id}\u0000${record.version}`;
    const existing = entitlementsByVersion.get(entitlementKey);
    if (existing) {
      if (!sameRecord(existing, record, ["sequence", "recorded_at_ms", "out_of_order"])) {
        throw new Error("entitlement version is immutable");
      }
      return copy(existing);
    }
    const prior = latestEntitlement(record.entitlement_id);
    if (prior && record.effective_at_ms < prior.effective_at_ms) {
      record.out_of_order = true;
    }
    Object.freeze(record);
    entitlementsByVersion.set(entitlementKey, record);
    entitlementFacts.push(record);
    return copy(record);
  }

  function appendBudgetVersion(input) {
    const budgetId = requiredId(input?.budget_id, "budget_id");
    const version = requiredId(input?.version, "version");
    const key = `${budgetId}\u0000${version}`;
    const record = fact("budget_version", { budget_id: budgetId, version,
      currency: currency(input.currency),
      limit_minor: money(input.limit_minor, "limit_minor", { allowNegative: false }),
      effective_at_ms: timestamp(input.effective_at_ms, "effective_at_ms") });
    const existing = budgetVersions.get(key);
    if (existing) {
      if (!sameRecord(existing, record, ["sequence", "recorded_at_ms"])) throw new Error("budget version is immutable");
      return copy(existing);
    }
    Object.freeze(record);
    budgetVersions.set(key, record);
    return copy(record);
  }

  function reserveBudget(input) {
    const budgetId = requiredId(input?.budget_id, "budget_id");
    const budgetVersion = requiredId(input?.budget_version, "budget_version");
    const reservationId = requiredId(input?.reservation_id, "reservation_id");
    const amountMinor = money(input.amount_minor, "amount_minor", { allowNegative: false });
    const budget = budgetVersions.get(`${budgetId}\u0000${budgetVersion}`);
    if (!budget) throw new Error("unknown budget version");
    const reservationKey = digestKey("reservation", tenantId, budgetId, reservationId);
    const existing = budgetReservations.get(reservationKey);
    if (existing) {
      const expected = { budget_id: budgetId, budget_version: budgetVersion, amount_minor: amountMinor };
      if (!sameRecord(existing, expected, ["sequence", "recorded_at_ms", "kind", "tenant_id", "reservation_id", "currency", "limit_minor"])) {
        throw new Error("reservation idempotency collision");
      }
      return { accepted: true, duplicate: true, record: copy(existing) };
    }
    const totalKey = digestKey("budget", tenantId, budgetId);
    const total = budgetTotals.get(totalKey);
    if (total && total.currency !== budget.currency) throw new Error("budget currency mismatch");
    const reserved = total?.amount_minor || 0;
    const after = safeAdd(reserved, amountMinor);
    if (after > budget.limit_minor) return { accepted: false, reason: "over_budget", reserved_minor: reserved };
    const record = fact("budget_reservation", {
      reservation_id: reservationId, budget_id: budgetId, budget_version: budgetVersion,
      amount_minor: amountMinor, limit_minor: budget.limit_minor, currency: budget.currency,
    });
    Object.freeze(record);
    budgetReservations.set(reservationKey, record);
    budgetTotals.set(totalKey, { currency: budget.currency, amount_minor: after });
    return { accepted: true, duplicate: false, record: copy(record), reserved_minor: after };
  }

  function ingestWebhook(input) {
    const provider = requiredId(input?.provider, "provider");
    const secretId = requiredId(input?.secret_id, "secret_id");
    const secret = secrets.get(`${provider}\u0000${secretId}`);
    if (!secret) throw new Error("unknown webhook secret");
    const body = Buffer.isBuffer(input.raw_body) ? input.raw_body : Buffer.from(String(input.raw_body ?? ""));
    if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) throw new Error("invalid webhook body size");
    const parsed = verifySignature({ body, header: input.signature, secret, nowMs: clock(), signatureToleranceMs });
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { throw new Error("invalid webhook json"); }
    const eventId = requiredId(payload.id, "webhook event id");
    const eventType = requiredId(payload.type, "webhook event type");
    const key = digestKey("webhook", tenantId, provider, eventId);
    const payloadSha256 = crypto.createHash("sha256").update(body).digest("hex");
    const prior = webhookReceipts.get(key);
    if (prior) {
      if (prior.payload_sha256 !== payloadSha256 || prior.event_type !== eventType) {
        throw new Error("webhook event id collision");
      }
      return { duplicate: true, receipt: copy(prior) };
    }
    const receipt = fact("webhook_receipt", {
      receipt_id: digestKey("receipt", tenantId, provider, eventId), provider,
      provider_event_id: eventId, event_type: eventType,
      signed_at_ms: parsed.signedAtMs,
      payload_sha256: payloadSha256,
      status: "verified_unapplied",
    });
    Object.freeze(receipt);
    webhookReceipts.set(key, receipt);
    reconciliationFacts.push(receipt);
    return { duplicate: false, receipt: copy(receipt), payload: copy(payload) };
  }

  function appendAdjustment(input) {
    const kind = String(input?.kind || "");
    if (!["refund", "dispute", "correction"].includes(kind)) throw new Error("invalid adjustment kind");
    const record = fact("adjustment", {
      adjustment_id: requiredId(input.adjustment_id, "adjustment_id"), kind,
      currency: currency(input.currency),
      amount_minor: money(input.amount_minor, "amount_minor", { allowNegative: true }),
      source_receipt_id: requiredId(input.source_receipt_id, "source_receipt_id"),
      occurred_at_ms: timestamp(input.occurred_at_ms, "occurred_at_ms"),
    });
    const prior = adjustmentsById.get(record.adjustment_id);
    if (prior) {
      if (!sameRecord(prior, record, ["sequence", "recorded_at_ms"])) throw new Error("adjustment is immutable");
      return copy(prior);
    }
    Object.freeze(record);
    adjustmentsById.set(record.adjustment_id, record);
    adjustments.push(record);
    reconciliationFacts.push(record);
    return copy(record);
  }

  function reconcile(input = {}) {
    const limit = boundedInteger(input.limit ?? MAX_RECONCILE_PAGE, "limit", 1, MAX_RECONCILE_PAGE);
    const cursor = input.cursor == null ? 0 : boundedInteger(input.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const items = reconciliationFacts.slice(cursor, cursor + limit).map(copy);
    return { items, next_cursor: cursor + items.length < reconciliationFacts.length ? cursor + items.length : null };
  }

  function snapshot() {
    return {
      tenant_id: tenantId,
      prices: [...prices.values()].map(copy), usage: usage.map(copy),
      entitlements: entitlementFacts.map(copy), budgets: [...budgetVersions.values()].map(copy),
      reservations: [...budgetReservations.values()].map(copy),
      webhooks: [...webhookReceipts.values()].map(copy), adjustments: adjustments.map(copy),
    };
  }

  function fact(kind, fields) {
    sequence += 1;
    return { kind, tenant_id: tenantId, sequence, recorded_at_ms: clock(), ...fields };
  }

  function latestEntitlement(id) {
    for (let i = entitlementFacts.length - 1; i >= 0; i -= 1) {
      if (entitlementFacts[i].entitlement_id === id) return entitlementFacts[i];
    }
    return null;
  }

  return Object.freeze({ appendPriceVersion, appendUsage, appendEntitlement, appendBudgetVersion, reserveBudget,
    ingestWebhook, appendAdjustment, reconcile, snapshot });
}

function createSandboxBillingProvider(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const operations = [];
  return Object.freeze({
    mode: "sandbox_no_charge",
    ensureCustomer(input) { return record("ensure_customer", input); },
    reportUsage(input) { return record("report_usage", input); },
    checkEntitlement(input) { return record("check_entitlement", input); },
    webhook(input) { return record("webhook_evidence", input); },
    operations() { return operations.map(copy); },
  });
  function record(operation, input) {
    const item = Object.freeze({ operation, recorded_at_ms: clock(), input_sha256: digestJson(input),
      effect: "none", charged: false });
    operations.push(item);
    return copy(item);
  }
}

function signWebhookFixture({ rawBody, secret, timestampSeconds }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const timestamp = boundedInteger(timestampSeconds, "timestampSeconds", 0, Number.MAX_SAFE_INTEGER);
  const signature = crypto.createHmac("sha256", String(secret)).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function verifySignature({ body, header, secret, nowMs, signatureToleranceMs }) {
  const parts = String(header || "").split(",").map((part) => part.split("="));
  const timestampPart = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  const seconds = Number(timestampPart);
  if (!Number.isSafeInteger(seconds) || signatures.length === 0) throw new Error("invalid webhook signature header");
  const signedAtMs = seconds * 1000;
  if (Math.abs(nowMs - signedAtMs) > signatureToleranceMs) throw new Error("stale webhook signature");
  const expected = crypto.createHmac("sha256", secret).update(`${seconds}.`).update(body).digest();
  const valid = signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(candidate, "hex"));
  });
  if (!valid) throw new Error("invalid webhook signature");
  return { signedAtMs };
}

function normalizeSecrets(input) {
  const out = new Map();
  for (const [key, value] of Object.entries(input)) {
    const [provider, secretId, extra] = key.split(":");
    if (extra || !provider || !secretId || typeof value !== "string" || value.length < 16 || value.length > 512) {
      throw new Error("invalid webhook secret map");
    }
    out.set(`${requiredId(provider, "provider")}\u0000${requiredId(secretId, "secret_id")}`, value);
  }
  return out;
}

function requiredId(value, name) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(text) || text.length > MAX_ID) throw new Error(`${name} is invalid`);
  return text;
}
function optionalId(value, name) { return value == null || value === "" ? "" : requiredId(value, name); }
function currency(value) {
  const text = String(value ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(text) || text.length > MAX_CURRENCY) throw new Error("currency is invalid");
  return text;
}
function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be a safe integer`);
  return value;
}
function money(value, name, { allowNegative }) {
  return boundedInteger(value, name, allowNegative ? -Number.MAX_SAFE_INTEGER : 0, Number.MAX_SAFE_INTEGER);
}
function timestamp(value, name) { return boundedInteger(value, name, 0, Number.MAX_SAFE_INTEGER); }
function safeAdd(a, b) { const value = a + b; if (!Number.isSafeInteger(value)) throw new Error("money overflow"); return value; }
function safeMultiply(a, b) { const value = a * b; if (!Number.isSafeInteger(value)) throw new Error("money overflow"); return value; }
function digestKey(...parts) { return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function digestJson(value) { return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function sameRecord(a, b, ignored = []) {
  const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.includes(key)));
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

module.exports = { createBillingDomain, createSandboxBillingProvider, signWebhookFixture,
  MAX_RECONCILE_PAGE, MAX_WEBHOOK_BYTES };
