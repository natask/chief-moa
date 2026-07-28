"use strict";

const { createHash } = require("node:crypto");

const PROGRAM_RUNTIMES = Object.freeze({
  global_program: new Set(["javascript", "harness"]),
  surface_program: new Set(["browser_javascript", "moa_android_ir_v1"]),
});

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired", "revoked"]);
const TRANSITIONS = Object.freeze({
  proposed: new Set(["validated", "cancelled", "expired"]),
  validated: new Set(["leased", "cancelled", "expired", "revoked"]),
  leased: new Set(["running", "cancelled", "expired", "revoked"]),
  running: new Set(["succeeded", "failed", "cancelled", "expired", "revoked"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), expired: new Set(), revoked: new Set(),
});

class SurfaceProgramContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SurfaceProgramContractError";
    this.code = code;
  }
}

function fail(code, message) { throw new SurfaceProgramContractError(code, message); }
function rejectUnknown(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail("unknown_field", `${name} contains unknown field: ${unknown.sort()[0]}`);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_shape", `${name} must be an object`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("invalid_shape", `${name} must be a non-empty string`);
  return value;
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_budget", `${name} must be a non-negative safe integer`);
  return value;
}
function timestamp(value, name) {
  text(value, name);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail("invalid_time", `${name} must be an ISO timestamp`);
  return time;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_canonical_value", "canonical numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  fail("invalid_canonical_value", "only JSON values can be canonicalized");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function without(value, fields) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}

function assertDigest(actual, value, code = "digest_mismatch") {
  text(actual, "digest");
  if (actual !== digest(value)) fail(code, `expected ${digest(value)}, received ${actual}`);
  return actual;
}

function validateTargetBinding(binding, expected = {}) {
  object(binding, "target_binding");
  rejectUnknown(binding, ["surface", "device_id", "instance_id"], "target_binding");
  const normalized = {
    surface: text(binding.surface, "target_binding.surface"),
    device_id: text(binding.device_id, "target_binding.device_id"),
    instance_id: text(binding.instance_id, "target_binding.instance_id"),
  };
  for (const key of Object.keys(normalized)) {
    if (expected[key] !== undefined && normalized[key] !== expected[key]) fail("target_mismatch", `${key} does not match target`);
  }
  return Object.freeze(normalized);
}

function validateBudgets(budgets) {
  object(budgets, "budgets");
  const normalized = {};
  for (const [name, value] of Object.entries(budgets)) normalized[text(name, "budget name")] = integer(value, `budgets.${name}`);
  return Object.freeze(normalized);
}

function validateProgramEnvelope(envelope, options = {}) {
  object(envelope, "program envelope");
  rejectUnknown(envelope, [
    "protocol_version", "program_id", "program_kind", "runtime", "program",
    "capability_manifest", "capability_manifest_digest", "target_binding", "budgets",
    "created_at", "expires_at", "program_digest",
  ], "program envelope");
  if (envelope.protocol_version !== 1) fail("unsupported_protocol", "protocol_version must be 1");
  const runtimes = PROGRAM_RUNTIMES[envelope.program_kind];
  if (!runtimes || !runtimes.has(envelope.runtime)) fail("unsupported_runtime", "program kind/runtime pairing is unsupported");
  text(envelope.program_id, "program_id");
  object(envelope.program, "program");
  object(envelope.capability_manifest, "capability_manifest");
  assertDigest(envelope.capability_manifest_digest, envelope.capability_manifest, "manifest_digest_mismatch");
  if (options.manifest_digest && envelope.capability_manifest_digest !== options.manifest_digest) fail("manifest_digest_mismatch", "manifest digest is not the expected manifest");
  if (envelope.program_kind === "surface_program") {
    const requiredSurface = envelope.runtime === "browser_javascript" ? "browser" : "android";
    const binding = validateTargetBinding(envelope.target_binding, options.target_binding);
    if (binding.surface !== requiredSurface) fail("target_mismatch", `runtime requires ${requiredSurface} target`);
  } else if (envelope.target_binding !== undefined) {
    fail("invalid_target", "global programs cannot carry a surface target binding");
  }
  validateBudgets(envelope.budgets);
  const created = timestamp(envelope.created_at, "created_at");
  const expires = timestamp(envelope.expires_at, "expires_at");
  if (expires <= created) fail("invalid_time", "expires_at must be after created_at");
  const now = options.now === undefined ? Date.now() : timestamp(options.now, "now");
  if (expires <= now) fail("expired", "program has expired");
  assertDigest(envelope.program_digest, without(envelope, ["program_digest"]), "program_digest_mismatch");
  return Object.freeze({ ...envelope });
}

function validateCapabilityLease(lease, context) {
  object(lease, "capability lease");
  object(context, "lease context");
  rejectUnknown(lease, [
    "lease_id", "program_id", "program_digest", "capability_manifest_digest",
    "target_binding", "capability_ids", "budgets", "issued_at", "expires_at",
    "revoked_at", "lease_digest",
  ], "capability lease");
  text(lease.lease_id, "lease_id");
  if (lease.program_id !== context.program_id || lease.program_digest !== context.program_digest) fail("cross_program_lease", "lease is bound to another program");
  if (lease.capability_manifest_digest !== context.capability_manifest_digest) fail("manifest_digest_mismatch", "lease manifest does not match program manifest");
  validateTargetBinding(lease.target_binding, context.target_binding || {});
  if (context.target_binding && digest(lease.target_binding) !== digest(context.target_binding)) fail("target_mismatch", "lease target does not match program target");
  if (!Array.isArray(lease.capability_ids) || lease.capability_ids.length === 0) fail("invalid_capabilities", "capability_ids must be non-empty");
  const ids = lease.capability_ids.map((id) => text(id, "capability_id"));
  if (new Set(ids).size !== ids.length) fail("invalid_capabilities", "capability_ids must be unique");
  const budgets = validateBudgets(lease.budgets);
  const issued = timestamp(lease.issued_at, "issued_at");
  const expires = timestamp(lease.expires_at, "expires_at");
  if (expires <= issued) fail("invalid_time", "lease expiry must follow issuance");
  const now = context.now === undefined ? Date.now() : timestamp(context.now, "now");
  if (lease.revoked_at != null && timestamp(lease.revoked_at, "revoked_at") <= now) fail("revoked", "lease has been revoked");
  if (expires <= now) fail("expired", "lease has expired");
  if (context.usage) {
    object(context.usage, "usage");
    for (const [name, used] of Object.entries(context.usage)) {
      integer(used, `usage.${name}`);
      if (!(name in budgets) || used > budgets[name]) fail("budget_exceeded", `${name} exceeds its lease budget`);
    }
  }
  assertDigest(lease.lease_digest, without(lease, ["lease_digest"]), "lease_digest_mismatch");
  return Object.freeze({ ...lease, capability_ids: Object.freeze(ids), budgets });
}

function validateLifecycleTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[to]) fail("invalid_lifecycle_state", "unknown lifecycle state");
  if (from === to && TERMINAL_STATES.has(from)) return Object.freeze({ from, to, idempotent: true });
  if (!TRANSITIONS[from].has(to)) fail("invalid_lifecycle_transition", `cannot transition from ${from} to ${to}`);
  return Object.freeze({ from, to, idempotent: false });
}

function validateEffectIntent(intent, context) {
  object(intent, "effect intent"); object(context, "effect context");
  rejectUnknown(intent, [
    "effect_id", "program_id", "program_digest", "lease_id",
    "capability_manifest_digest", "target_binding", "capability_id", "arguments",
    "budget_charge", "intent_digest",
  ], "effect intent");
  text(intent.effect_id, "effect_id"); text(intent.capability_id, "capability_id");
  if (intent.program_id !== context.program_id || intent.program_digest !== context.program_digest || intent.lease_id !== context.lease_id) fail("cross_program_lease", "effect does not match its program lease");
  if (intent.capability_manifest_digest !== context.capability_manifest_digest) fail("manifest_digest_mismatch", "effect manifest does not match");
  validateTargetBinding(intent.target_binding, context.target_binding);
  if (digest(intent.target_binding) !== digest(context.target_binding)) fail("target_mismatch", "effect target does not match");
  if (!context.capability_ids.includes(intent.capability_id)) fail("capability_denied", "capability is not present in lease");
  object(intent.arguments, "arguments");
  validateBudgets(intent.budget_charge);
  for (const [name, charge] of Object.entries(intent.budget_charge)) {
    const used = context.usage?.[name] || 0;
    if (!(name in context.budgets) || charge + used > context.budgets[name]) fail("budget_exceeded", `${name} exceeds its lease budget`);
  }
  assertDigest(intent.intent_digest, without(intent, ["intent_digest"]), "intent_digest_mismatch");
  return Object.freeze({ ...intent });
}

function validateTerminalReceipt(receipt, context) {
  object(receipt, "terminal receipt"); object(context, "receipt context");
  rejectUnknown(receipt, [
    "effect_id", "program_id", "program_digest", "lease_id", "intent_digest",
    "target_binding", "status", "completed_at", "output", "receipt_digest",
  ], "terminal receipt");
  if (!TERMINAL_STATES.has(receipt.status)) fail("non_terminal_receipt", "receipt status must be terminal");
  for (const field of ["effect_id", "program_id", "program_digest", "lease_id", "intent_digest"]) {
    if (receipt[field] !== context[field]) fail(field === "program_id" || field === "program_digest" ? "cross_program_lease" : "receipt_binding_mismatch", `${field} does not match effect intent`);
  }
  validateTargetBinding(receipt.target_binding, context.target_binding);
  if (digest(receipt.target_binding) !== digest(context.target_binding)) fail("target_mismatch", "receipt target does not match");
  timestamp(receipt.completed_at, "completed_at");
  if (receipt.output !== undefined) object(receipt.output, "output");
  assertDigest(receipt.receipt_digest, without(receipt, ["receipt_digest"]), "receipt_digest_mismatch");
  return Object.freeze({ ...receipt });
}

function validateCancellationRequest(request, context) {
  object(request, "cancellation request"); object(context, "cancellation context");
  rejectUnknown(request, [
    "request_id", "program_id", "program_digest", "lease_id", "target_binding",
    "cancel_sequence", "revocation_sequence", "requested_at", "reason",
    "cancellation_digest",
  ], "cancellation request");
  text(request.request_id, "request_id"); text(request.reason, "reason");
  if (request.program_id !== context.program_id || request.program_digest !== context.program_digest || request.lease_id !== context.lease_id) {
    fail("cross_program_lease", "cancellation does not match its program lease");
  }
  validateTargetBinding(request.target_binding, context.target_binding);
  if (digest(request.target_binding) !== digest(context.target_binding)) fail("target_mismatch", "cancellation target does not match");
  integer(request.cancel_sequence, "cancel_sequence");
  integer(request.revocation_sequence, "revocation_sequence");
  integer(context.cancel_sequence, "context.cancel_sequence");
  integer(context.revocation_sequence, "context.revocation_sequence");
  if (request.cancel_sequence <= context.cancel_sequence) fail("replayed_cancellation", "cancel sequence was already observed");
  if (request.cancel_sequence !== context.cancel_sequence + 1) fail("out_of_order_cancellation", "cancel sequence must be the next sequence");
  if (request.revocation_sequence <= context.revocation_sequence) fail("stale_revocation", "revocation sequence was already observed");
  if (request.revocation_sequence !== context.revocation_sequence + 1) fail("out_of_order_revocation", "revocation sequence must be the next sequence");
  timestamp(request.requested_at, "requested_at");
  assertDigest(request.cancellation_digest, without(request, ["cancellation_digest"]), "cancellation_digest_mismatch");
  return Object.freeze({ ...request });
}

module.exports = {
  PROGRAM_RUNTIMES, TERMINAL_STATES, SurfaceProgramContractError, canonicalize, digest,
  validateTargetBinding, validateBudgets, validateProgramEnvelope, validateCapabilityLease,
  validateLifecycleTransition, validateEffectIntent, validateTerminalReceipt,
  validateCancellationRequest,
};
