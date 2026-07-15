"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { digest, signManifest, exportPackage, canonicalJson } = require("../lib/companion-package");
const { createBillingDomain } = require("../lib/billing-domain");
const { createCompanionRuntimeAuthority, createBillingRuntimeAuthority } = require("../lib/runtime-authority");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function fixture() {
  const keys = crypto.generateKeyPairSync("ed25519");
  const manifest = signManifest({ schema: "moa-companion-manifest/v1", package_id: "safe-pet", version: "1.0.0",
    created_at: "2026-07-10T12:00:00.000Z", publisher: { id: "local", display_name: "Local" },
    provenance: { source_uri: "urn:test:safe", source_digest: digest("source"), author: "Tester", created_at: "2026-07-10T11:00:00.000Z" },
    license: { spdx_id: "CC-BY-4.0", notice: "test" }, compatibility: { protocol: "aggie", min_version: "1.0.0", max_version: "1.9.9" },
    capabilities: ["profile.patch.declared"], declared_profile_fields: ["assistant_name"], profile_patch: { assistant_name: "Safe" },
    assets: [{ path: "pet.png", media_type: "image/png", sha256: digest(png), size_bytes: png.length, width: 1, height: 1 }],
    moderation: { status: "approved", policy_version: "local-v1", review_id: "review-1" } }, { keyId: "key-1", privateKey: keys.privateKey });
  return { bytes: exportPackage({ manifest, assets: { "pet.png": png.toString("base64") } }), policy: { trustStore: new Map([["key-1", keys.publicKey]]),
    acceptedLicenses: ["CC-BY-4.0"], acceptedModerationPolicies: ["local-v1"], currentProtocolVersion: "1.2.0" } };
}

function approvalInput(preview, approver, overrides = {}) {
  const input = {
    approval_binding: preview.approval_binding,
    expected_profile_version: "v1",
    scope: "global",
    approved_at_ms: 1000,
    expires_at_ms: 2000,
    approver_key_id: "device",
    ...overrides,
  };
  input.approval_signature = crypto.sign(null, Buffer.from(canonicalJson({
    schema: "moa-companion-approval/v1",
    approval_binding: input.approval_binding,
    approved_at_ms: input.approved_at_ms,
    expires_at_ms: input.expires_at_ms,
    approver_key_id: input.approver_key_id,
  })), approver.privateKey).toString("base64");
  return input;
}

test("verified preview is required and apply is approval/profile-version bound and idempotent", () => {
  const f = fixture(); const approver = crypto.generateKeyPairSync("ed25519"); let now = Date.parse("2026-07-11T00:00:00.000Z"); let mutations = 0;
  const durable = new Map(); const options = { policy: { ...f.policy, approvalTrustStore: new Map([["device-1", approver.publicKey]]) }, clock: () => (now += 1000),
    applyProfile(patch) { mutations++; return { before: { version: "v1", assistant_name: "Old" }, after: { version: "v2", ...patch }, receipt_id: "effect-1" }; },
    restoreProfile() { mutations++; return { receipt_id: "revert-1" }; }, loadState(key) { return durable.get(key); }, saveState(key, value) { durable.set(key, value); } };
  let authority = createCompanionRuntimeAuthority(options);
  assert.throws(() => authority.apply({ approval_binding: "missing" }), /verified preview/);
  const preview = authority.preview({ package_base64: f.bytes.toString("base64"), scope: "global", expected_profile_version: "v1" });
  assert.equal(preview.mutates_profile, false); assert.equal(mutations, 0);
  assert.throws(() => authority.apply({ approval_binding: preview.approval_binding, expected_profile_version: "v2", scope: "global",
    approved_at_ms: now, expires_at_ms: now + 10000 }), /not bound/);
  const input = { approval_binding: preview.approval_binding, expected_profile_version: "v1", scope: "global", approved_at_ms: now, expires_at_ms: now + 10000,
    approver_key_id: "device-1" };
  input.approval_signature = crypto.sign(null, Buffer.from(canonicalJson({ schema: "moa-companion-approval/v1", approval_binding: input.approval_binding,
    approved_at_ms: input.approved_at_ms, expires_at_ms: input.expires_at_ms, approver_key_id: input.approver_key_id })), approver.privateKey).toString("base64");
  const applied = authority.apply(input); assert.equal(authority.apply(input), applied); assert.equal(mutations, 1);
  assert.throws(() => authority.rollback({ approval_binding: preview.approval_binding, rollback_binding: "wrong" }), /does not match/);
  authority = createCompanionRuntimeAuthority(options);
  assert.equal(authority.rollback({ approval_binding: preview.approval_binding, rollback_binding: applied.rollback_binding }).status, "rolled_back");
  assert.equal(mutations, 2);
});

test("unknown signer and legacy-shaped input cannot reach profile mutation", () => {
  const f = fixture(); let mutations = 0;
  const authority = createCompanionRuntimeAuthority({ policy: { ...f.policy, trustStore: new Map() },
    applyProfile() { mutations++; }, restoreProfile() { mutations++; } });
  assert.throws(() => authority.preview({ companion_id: "legacy", expected_profile_version: "v1" }), /package_base64/);
  assert.throws(() => authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" }), /signer/);
  assert.equal(mutations, 0);
});

test("crash-after-profile-effect fails closed instead of repeating an uncertain mutation", () => {
  const f = fixture(); const approver = crypto.generateKeyPairSync("ed25519"); const durable = new Map(); let effects = 0; let now = Date.parse("2026-07-11T00:00:00.000Z");
  const options = { policy: { ...f.policy, approvalTrustStore: new Map([["device", approver.publicKey]]) }, clock: () => ++now,
    applyProfile() { effects++; throw new Error("crash after effect"); }, restoreProfile() {},
    loadState: (key) => durable.get(key), saveState: (key, value) => durable.set(key, value) };
  let authority = createCompanionRuntimeAuthority(options);
  const preview = authority.preview({ package_base64: f.bytes.toString("base64"), scope: "global", expected_profile_version: "v1" });
  const input = { approval_binding: preview.approval_binding, expected_profile_version: "v1", scope: "global", approved_at_ms: now, expires_at_ms: now + 1000, approver_key_id: "device" };
  input.approval_signature = crypto.sign(null, Buffer.from(canonicalJson({ schema: "moa-companion-approval/v1", approval_binding: input.approval_binding,
    approved_at_ms: input.approved_at_ms, expires_at_ms: input.expires_at_ms, approver_key_id: input.approver_key_id })), approver.privateKey).toString("base64");
  assert.throws(() => authority.apply(input), /crash after effect/); assert.equal(effects, 1);
  authority = createCompanionRuntimeAuthority(options);
  assert.throws(() => authority.apply(input), (error) => error.code === "effect_recovery_required"); assert.equal(effects, 1);
});

test("billing runtime fails closed, then atomically binds entitlement, budget reservation, and usage", () => {
  let now = 1000; const domain = createBillingDomain({ tenantId: "tenant-a", clock: () => now++ });
  domain.appendPriceVersion({ price_id: "sandbox", version: "v1", currency: "USD", unit_minor: 1, unit_size: 1, effective_at_ms: 1 });
  domain.appendBudgetVersion({ budget_id: "runtime", version: "v1", currency: "USD", limit_minor: 5, effective_at_ms: 1 });
  const runtime = createBillingRuntimeAuthority({ domain, entitlementId: "runtime", budgetId: "runtime", budgetVersion: "v1", priceId: "sandbox", priceVersion: "v1", meter: "model_unit" });
  assert.deepEqual(runtime.authorize({ operation_id: "op-0", estimated_minor: 1 }), { allowed: false, reason: "entitlement_inactive" });
  domain.appendEntitlement({ entitlement_id: "runtime", version: "v1", state: "active", effective_at_ms: 1 });
  assert.throws(() => runtime.recordUsage({ operation_id: "op-bad", estimated_minor: 1, quantity: 3, occurred_at_ms: 2 }), /estimate/);
  const first = runtime.recordUsage({ operation_id: "op-1", estimated_minor: 3, quantity: 3, occurred_at_ms: 2 });
  assert.equal(first.allowed, true); assert.equal(first.usage.amount_minor, 3);
  assert.deepEqual(runtime.authorize({ operation_id: "op-2", estimated_minor: 3 }), { allowed: false, reason: "over_budget" });
  assert.equal(runtime.mode, "sandbox_no_charge");
});

test("authority constructors validate every required dependency and identifier", () => {
  assert.throws(() => createCompanionRuntimeAuthority({ restoreProfile() {} }), /applyProfile/);
  assert.throws(() => createCompanionRuntimeAuthority({ applyProfile() {} }), /restoreProfile/);
  assert.throws(() => createBillingRuntimeAuthority(), /domain/);
  const domain = createBillingDomain({ tenantId: "tenant" });
  const fields = ["entitlementId", "budgetId", "budgetVersion", "priceId", "priceVersion", "meter"];
  for (const missing of fields) {
    const options = {
      domain, entitlementId: "e", budgetId: "b", budgetVersion: "v1",
      priceId: "p", priceVersion: "v1", meter: "unit",
    };
    delete options[missing];
    assert.throws(() => createBillingRuntimeAuthority(options), new RegExp(missing));
  }
});

test("default companion hooks remain inert and fail closed", () => {
  const f = fixture();
  const authority = createCompanionRuntimeAuthority({
    policy: f.policy,
    applyProfile() {},
    restoreProfile() {},
  });
  const preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  assert.equal(preview.status, "verified_preview");
  assert.throws(() => authority.apply({ approval_binding: "unknown" }), /verified preview/);
  assert.throws(() => authority.preview({ package_base64: "x".repeat(16 * 1024 * 1024 + 1) }), /bounded/);
});

test("approval windows, signers, and signatures fail closed", () => {
  const f = fixture();
  const approver = crypto.generateKeyPairSync("ed25519");
  const make = (trust = new Map([["device", approver.publicKey]])) => {
    let now = 1300;
    return createCompanionRuntimeAuthority({
      policy: { ...f.policy, approvalTrustStore: trust },
      clock: () => (now += 100),
      applyProfile: () => ({ before: { version: "v1" }, after: { version: "v2" }, receipt_id: "effect" }),
      restoreProfile: () => ({ receipt_id: "rollback" }),
    });
  };

  for (const times of [
    { approved_at_ms: 1501, expires_at_ms: 1600 },
    { approved_at_ms: 1000, expires_at_ms: 1499 },
    { approved_at_ms: 0, expires_at_ms: 1500 + 15 * 60 * 1000 + 1 },
    { approved_at_ms: 1.5, expires_at_ms: 1600 },
    { approved_at_ms: 1000, expires_at_ms: 1.5 },
  ]) {
    const authority = make();
    const preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
    assert.throws(() => authority.apply({
      approval_binding: preview.approval_binding,
      expected_profile_version: "v1",
      scope: "global",
      approver_key_id: "device",
      ...times,
    }), (error) => error.code === "approval_expired");
  }

  let authority = make();
  let preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  assert.throws(() => authority.apply(approvalInput(preview, approver, { approver_key_id: "missing" })),
    (error) => error.code === "approval_signer_untrusted");

  authority = make();
  preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  const invalid = approvalInput(preview, approver);
  invalid.approval_signature = "bad";
  assert.throws(() => authority.apply(invalid), (error) => error.code === "approval_signature_invalid");

  authority = make({ device: approver.publicKey });
  preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  assert.equal(authority.apply(approvalInput(preview, approver)).status, "applied");
});

test("invalid profile effects and rollback effects require durable receipts", () => {
  const f = fixture();
  const approver = crypto.generateKeyPairSync("ed25519");
  function authorityWith(applyProfile, restoreProfile = () => ({})) {
    let now = 1000;
    return createCompanionRuntimeAuthority({
      policy: { ...f.policy, approvalTrustStore: new Map([["device", approver.publicKey]]) },
      clock: () => (now += 100),
      applyProfile,
      restoreProfile,
    });
  }
  for (const effect of [null, {}, { before: {}, after: {} }, { before: {}, after: {}, receipt_id: "" }]) {
    const authority = authorityWith(() => effect);
    const preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
    assert.throws(() => authority.apply(approvalInput(preview, approver)),
      (error) => error.code === "invalid_profile_effect");
  }

  let authority = authorityWith(
    () => ({ before: { version: "v1" }, after: { version: "v2" }, receipt_id: "effect" }),
    () => ({}),
  );
  let preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  let applied = authority.apply(approvalInput(preview, approver));
  assert.throws(() => authority.rollback({ approval_binding: preview.approval_binding, rollback_binding: applied.rollback_binding }),
    (error) => error.code === "invalid_rollback_effect");

  authority = authorityWith(
    () => ({ before: { version: "v1" }, after: { version: "v2" }, receipt_id: "effect" }),
    () => ({ receipt_id: "rollback" }),
  );
  preview = authority.preview({ package_base64: f.bytes.toString("base64"), expected_profile_version: "v1" });
  applied = authority.apply(approvalInput(preview, approver));
  const rolledBack = authority.rollback({ approval_binding: preview.approval_binding, rollback_binding: applied.rollback_binding });
  assert.equal(authority.rollback({ approval_binding: preview.approval_binding, rollback_binding: applied.rollback_binding }), rolledBack);
  assert.throws(() => authority.rollback({ approval_binding: "missing", rollback_binding: "missing" }),
    (error) => error.code === "apply_not_found");
});

test("billing usage validates immutable price and numeric inputs", () => {
  const make = (withPrice = true) => {
    const domain = createBillingDomain({ tenantId: "tenant" });
    if (withPrice) domain.appendPriceVersion({ price_id: "p", version: "v1", currency: "USD", unit_minor: 2, unit_size: 2, effective_at_ms: 1 });
    domain.appendBudgetVersion({ budget_id: "b", version: "v1", currency: "USD", limit_minor: 100, effective_at_ms: 1 });
    domain.appendEntitlement({ entitlement_id: "e", version: "v1", state: "active", effective_at_ms: 1 });
    return createBillingRuntimeAuthority({ domain, entitlementId: "e", budgetId: "b", budgetVersion: "v1", priceId: "p", priceVersion: "v1", meter: "unit" });
  };
  assert.throws(() => make(false).recordUsage({ quantity: 1, occurred_at_ms: 1 }),
    (error) => error.code === "price_unconfigured");
  for (const input of [
    { operation_id: "op", quantity: -1, occurred_at_ms: 1 },
    { operation_id: "op", quantity: 1.5, occurred_at_ms: 1 },
    { operation_id: "op", quantity: 1, occurred_at_ms: -1 },
    { operation_id: "op", quantity: 1, occurred_at_ms: 1.5 },
  ]) {
    assert.throws(() => make().recordUsage(input), (error) => error.code === "invalid_input");
  }
  assert.throws(() => make().authorize({ operation_id: "x".repeat(201), estimated_minor: 1 }),
    (error) => error.code === "invalid_input");
});
