"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SurfaceProgramContractError, canonicalize, digest, validateProgramEnvelope,
  validateCapabilityLease, validateLifecycleTransition, validateEffectIntent,
  validateTerminalReceipt, validateCancellationRequest,
} = require("../lib/surface-program-contract");

const NOW = "2026-07-28T12:00:00.000Z";
const target = Object.freeze({ surface: "browser", device_id: "device-1", instance_id: "chrome-1" });
const manifest = Object.freeze({ capabilities: [{ id: "tabs.create" }, { id: "tabs.close" }] });

function seal(value, field) { return { ...value, [field]: digest(value) }; }

function program(overrides = {}) {
  const value = {
    protocol_version: 1, program_id: "program-1", program_kind: "surface_program",
    runtime: "browser_javascript", program: { source: "return tools.tabs.create();" },
    capability_manifest: manifest, capability_manifest_digest: digest(manifest),
    target_binding: target, budgets: { effects: 2, runtime_ms: 1000 },
    created_at: "2026-07-28T11:00:00.000Z", expires_at: "2026-07-28T13:00:00.000Z",
    ...overrides,
  };
  return seal(value, "program_digest");
}

function lease(p = program(), overrides = {}) {
  const value = {
    lease_id: "lease-1", program_id: p.program_id, program_digest: p.program_digest,
    capability_manifest_digest: p.capability_manifest_digest, target_binding: target,
    capability_ids: ["tabs.create", "tabs.close"], budgets: { effects: 2, runtime_ms: 1000 },
    issued_at: "2026-07-28T11:30:00.000Z", expires_at: "2026-07-28T12:30:00.000Z",
    ...overrides,
  };
  return seal(value, "lease_digest");
}

function effect(p, l, overrides = {}) {
  const value = {
    effect_id: "effect-1", program_id: p.program_id, program_digest: p.program_digest,
    lease_id: l.lease_id, capability_manifest_digest: p.capability_manifest_digest,
    target_binding: target, capability_id: "tabs.create", arguments: { url: "https://example.com" },
    budget_charge: { effects: 1, runtime_ms: 50 }, ...overrides,
  };
  return seal(value, "intent_digest");
}

function context(p, l, overrides = {}) {
  return {
    program_id: p.program_id, program_digest: p.program_digest, lease_id: l.lease_id,
    capability_manifest_digest: p.capability_manifest_digest, target_binding: target,
    capability_ids: l.capability_ids, budgets: l.budgets, usage: { effects: 0, runtime_ms: 0 },
    ...overrides,
  };
}

function receipt(p, l, intent, overrides = {}) {
  const value = {
    effect_id: intent.effect_id, program_id: p.program_id, program_digest: p.program_digest,
    lease_id: l.lease_id, intent_digest: intent.intent_digest, target_binding: target,
    status: "succeeded", completed_at: "2026-07-28T12:00:01.000Z", output: { tab_id: 42 },
    ...overrides,
  };
  return seal(value, "receipt_digest");
}

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof SurfaceProgramContractError && error.code === code);
}

test("canonicalization and digest are deterministic across property order", () => {
  assert.equal(canonicalize({ z: 1, a: [true, { y: null, x: "v" }] }), '{"a":[true,{"x":"v","y":null}],"z":1}');
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  rejectsCode(() => canonicalize(Number.NaN), "invalid_canonical_value");
});

test("validates supported surface and global program envelopes", () => {
  assert.equal(validateProgramEnvelope(program(), { now: NOW }).runtime, "browser_javascript");
  const android = program({ runtime: "moa_android_ir_v1", target_binding: { surface: "android", device_id: "phone-1", instance_id: "app-1" } });
  assert.equal(validateProgramEnvelope(android, { now: NOW }).target_binding.surface, "android");
  const global = program({ program_kind: "global_program", runtime: "harness", target_binding: undefined });
  assert.equal(validateProgramEnvelope(global, { now: NOW }).program_kind, "global_program");
  const javascript = program({ program_kind: "global_program", runtime: "javascript", target_binding: undefined });
  assert.equal(validateProgramEnvelope(javascript, { now: NOW }).runtime, "javascript");
});

test("program envelope rejects bad pairing, digest, manifest, target, and expiry", () => {
  rejectsCode(() => validateProgramEnvelope(program({ runtime: "harness" }), { now: NOW }), "unsupported_runtime");
  rejectsCode(() => validateProgramEnvelope({ ...program(), program_digest: "sha256:nope" }, { now: NOW }), "program_digest_mismatch");
  rejectsCode(() => validateProgramEnvelope(program({ capability_manifest_digest: "sha256:nope" }), { now: NOW }), "manifest_digest_mismatch");
  rejectsCode(() => validateProgramEnvelope(program(), { now: NOW, manifest_digest: "sha256:other" }), "manifest_digest_mismatch");
  rejectsCode(() => validateProgramEnvelope(program(), { now: NOW, target_binding: { device_id: "wrong" } }), "target_mismatch");
  rejectsCode(() => validateProgramEnvelope(program({ expires_at: NOW }), { now: NOW }), "expired");
});

test("validates a bound capability lease and rejects authority escape", () => {
  const p = program(); const l = lease(p);
  assert.equal(validateCapabilityLease(l, { ...p, now: NOW }).lease_id, "lease-1");
  rejectsCode(() => validateCapabilityLease(lease(p, { program_id: "other" }), { ...p, now: NOW }), "cross_program_lease");
  rejectsCode(() => validateCapabilityLease(lease(p, { capability_manifest_digest: "sha256:other" }), { ...p, now: NOW }), "manifest_digest_mismatch");
  rejectsCode(() => validateCapabilityLease(lease(p, { target_binding: { ...target, device_id: "wrong" } }), { ...p, now: NOW }), "target_mismatch");
  rejectsCode(() => validateCapabilityLease(lease(p, { expires_at: NOW }), { ...p, now: NOW }), "expired");
  rejectsCode(() => validateCapabilityLease(lease(p, { revoked_at: "2026-07-28T11:59:00.000Z" }), { ...p, now: NOW }), "revoked");
  rejectsCode(() => validateCapabilityLease(l, { ...p, now: NOW, usage: { effects: 3 } }), "budget_exceeded");
});

test("lifecycle transitions are monotonic and terminal retries are idempotent", () => {
  assert.deepEqual(validateLifecycleTransition("proposed", "validated"), { from: "proposed", to: "validated", idempotent: false });
  assert.deepEqual(validateLifecycleTransition("succeeded", "succeeded"), { from: "succeeded", to: "succeeded", idempotent: true });
  rejectsCode(() => validateLifecycleTransition("running", "validated"), "invalid_lifecycle_transition");
  rejectsCode(() => validateLifecycleTransition("unknown", "running"), "invalid_lifecycle_state");
});

test("effect intent binds capability, target, manifest, lease, and remaining budget", () => {
  const p = program(); const l = lease(p); const c = context(p, l);
  assert.equal(validateEffectIntent(effect(p, l), c).capability_id, "tabs.create");
  rejectsCode(() => validateEffectIntent(effect(p, l, { program_id: "other" }), c), "cross_program_lease");
  rejectsCode(() => validateEffectIntent(effect(p, l, { capability_manifest_digest: "sha256:other" }), c), "manifest_digest_mismatch");
  rejectsCode(() => validateEffectIntent(effect(p, l, { target_binding: { ...target, device_id: "wrong" } }), c), "target_mismatch");
  rejectsCode(() => validateEffectIntent(effect(p, l, { capability_id: "cookies.read" }), c), "capability_denied");
  rejectsCode(() => validateEffectIntent(effect(p, l, { budget_charge: { effects: 2 } }), context(p, l, { usage: { effects: 1 } })), "budget_exceeded");
});

test("terminal receipts are digest-bound to the exact effect and target", () => {
  const p = program(); const l = lease(p); const intent = effect(p, l);
  const c = { ...context(p, l), effect_id: intent.effect_id, intent_digest: intent.intent_digest };
  assert.equal(validateTerminalReceipt(receipt(p, l, intent), c).status, "succeeded");
  rejectsCode(() => validateTerminalReceipt(receipt(p, l, intent, { status: "running" }), c), "non_terminal_receipt");
  rejectsCode(() => validateTerminalReceipt(receipt(p, l, intent, { program_digest: "sha256:other" }), c), "cross_program_lease");
  rejectsCode(() => validateTerminalReceipt(receipt(p, l, intent, { target_binding: { ...target, instance_id: "wrong" } }), c), "target_mismatch");
  rejectsCode(() => validateTerminalReceipt({ ...receipt(p, l, intent), receipt_digest: "sha256:nope" }, c), "receipt_digest_mismatch");
});

test("all contract records and nested target bindings reject unknown fields", () => {
  const p = program(); const l = lease(p); const intent = effect(p, l);
  rejectsCode(() => validateProgramEnvelope(seal({ ...p, surprise: true, program_digest: undefined }, "program_digest"), { now: NOW }), "unknown_field");
  rejectsCode(() => validateProgramEnvelope(program({ target_binding: { ...target, tab_id: 9 } }), { now: NOW }), "unknown_field");
  rejectsCode(() => validateCapabilityLease(lease(p, { unexpected: 1 }), { ...p, now: NOW }), "unknown_field");
  rejectsCode(() => validateEffectIntent(effect(p, l, { unexpected: 1 }), context(p, l)), "unknown_field");
  const receiptContext = { ...context(p, l), effect_id: intent.effect_id, intent_digest: intent.intent_digest };
  rejectsCode(() => validateTerminalReceipt(receipt(p, l, intent, { unexpected: 1 }), receiptContext), "unknown_field");
});

test("cancellation requests bind program, lease, target, digest, and next sequences", () => {
  const p = program(); const l = lease(p);
  const cancellation = seal({
    request_id: "cancel-1", program_id: p.program_id, program_digest: p.program_digest,
    lease_id: l.lease_id, target_binding: target, cancel_sequence: 4,
    revocation_sequence: 8, requested_at: NOW, reason: "user_requested",
  }, "cancellation_digest");
  const cancelContext = {
    program_id: p.program_id, program_digest: p.program_digest, lease_id: l.lease_id,
    target_binding: target, cancel_sequence: 3, revocation_sequence: 7,
  };
  assert.equal(validateCancellationRequest(cancellation, cancelContext).request_id, "cancel-1");
  rejectsCode(() => validateCancellationRequest(seal({ ...cancellation, unexpected: true, cancellation_digest: undefined }, "cancellation_digest"), cancelContext), "unknown_field");
  rejectsCode(() => validateCancellationRequest(cancellation, { ...cancelContext, cancel_sequence: 4 }), "replayed_cancellation");
  rejectsCode(() => validateCancellationRequest(seal({ ...cancellation, cancel_sequence: 6, cancellation_digest: undefined }, "cancellation_digest"), cancelContext), "out_of_order_cancellation");
  rejectsCode(() => validateCancellationRequest(cancellation, { ...cancelContext, revocation_sequence: 8 }), "stale_revocation");
  rejectsCode(() => validateCancellationRequest(seal({ ...cancellation, revocation_sequence: 10, cancellation_digest: undefined }, "cancellation_digest"), cancelContext), "out_of_order_revocation");
  rejectsCode(() => validateCancellationRequest(seal({ ...cancellation, lease_id: "other", cancellation_digest: undefined }, "cancellation_digest"), cancelContext), "cross_program_lease");
  rejectsCode(() => validateCancellationRequest(seal({ ...cancellation, target_binding: { ...target, device_id: "other" }, cancellation_digest: undefined }, "cancellation_digest"), cancelContext), "target_mismatch");
});
