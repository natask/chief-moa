"use strict";

const crypto = require("node:crypto");
const { importPackage, createLifecycleReceipt, canonicalJson } = require("./companion-package");

const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;

function createCompanionRuntimeAuthority(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const policy = options.policy || {};
  const append = typeof options.appendReceipt === "function" ? options.appendReceipt : () => {};
  const loadState = typeof options.loadState === "function" ? options.loadState : () => null;
  const saveState = typeof options.saveState === "function" ? options.saveState : () => {};
  const applyProfile = requiredFunction(options.applyProfile, "applyProfile");
  const restoreProfile = requiredFunction(options.restoreProfile, "restoreProfile");
  const sessions = new Map();

  function preview(input) {
    const verified = importPackage(packageBytes(input), policy);
    const now = new Date(clock()).toISOString();
    const receipt = createLifecycleReceipt("preview", { verified_package: verified, created_at: now });
    const approvalBinding = binding(verified, input, receipt);
    const result = Object.freeze({
      status: "verified_preview",
      package_digest: verified.package_digest,
      profile_patch: verified.manifest.profile_patch,
      receipt,
      approval_binding: approvalBinding,
      mutates_profile: false,
    });
    const state = { verified, preview: receipt, scope: scope(input), applied: null,
      approvalTrustStore: policy.approvalTrustStore, package_base64: input.package_base64 };
    sessions.set(approvalBinding, state);
    persistState(approvalBinding, state);
    append({ event: "companion_preview", ...result, profile_patch: undefined });
    return result;
  }

  function apply(input) {
    const key = requiredText(input?.approval_binding, "approval_binding");
    const state = resolveState(key);
    if (!state) throw authorityError("approval_not_found", "verified preview approval is required");
    if (state.applied) return state.applied.result;
    if (state.applying) throw authorityError("effect_recovery_required", "an interrupted apply requires receipt reconciliation");
    verifyApproval(input, state, clock());
    const createdAt = new Date(clock()).toISOString();
    const plan = createLifecycleReceipt("apply_plan", {
      verified_package: state.verified, created_at: createdAt,
      previous_receipt: state.preview,
    });
    state.applying = true;
    persistState(key, state);
    const effect = applyProfile(Object.freeze({ ...state.verified.manifest.profile_patch }), state.scope);
    if (!effect || typeof effect !== "object" || !effect.before || !effect.after || !effect.receipt_id) {
      throw authorityError("invalid_profile_effect", "profile authority returned no durable effect receipt");
    }
    const result = Object.freeze({
      status: "applied",
      package_digest: state.verified.package_digest,
      approval_binding: key,
      apply_plan: plan,
      profile_receipt_id: String(effect.receipt_id),
      profile_version_before: String(effect.before.version),
      profile_version_after: String(effect.after.version),
      rollback_binding: digest(["rollback", key, effect.receipt_id, effect.after.version]),
    });
    state.applied = { result, before: effect.before, after: effect.after, plan };
    state.applying = false;
    persistState(key, state);
    append({ event: "companion_apply", ...result });
    return result;
  }

  function rollback(input) {
    const key = requiredText(input?.approval_binding, "approval_binding");
    const state = resolveState(key);
    if (!state?.applied) throw authorityError("apply_not_found", "applied companion receipt is required");
    if (input.rollback_binding !== state.applied.result.rollback_binding) {
      throw authorityError("rollback_binding_mismatch", "rollback binding does not match applied effect");
    }
    if (state.rollback) return state.rollback;
    const restored = restoreProfile(state.applied.before, state.scope, state.applied.after);
    if (!restored?.receipt_id) throw authorityError("invalid_rollback_effect", "profile authority returned no rollback receipt");
    const receipt = createLifecycleReceipt("revert_plan", {
      verified_package: state.verified, created_at: new Date(clock()).toISOString(), previous_receipt: state.applied.plan,
    });
    state.rollback = Object.freeze({ status: "rolled_back", package_digest: state.verified.package_digest,
      receipt, profile_receipt_id: String(restored.receipt_id) });
    append({ event: "companion_rollback", ...state.rollback });
    persistState(key, state);
    return state.rollback;
  }

  function resolveState(key) {
    if (sessions.has(key)) return sessions.get(key);
    const stored = loadState(key);
    if (!stored?.package_base64) return null;
    const verified = importPackage(Buffer.from(stored.package_base64, "base64"), policy);
    const state = { ...stored, verified, approvalTrustStore: policy.approvalTrustStore };
    sessions.set(key, state);
    return state;
  }

  function persistState(key, state) {
    saveState(key, { package_base64: state.package_base64, preview: state.preview, scope: state.scope,
      applied: state.applied, applying: Boolean(state.applying), rollback: state.rollback || null });
  }

  return Object.freeze({ preview, apply, rollback });
}

function createBillingRuntimeAuthority(options = {}) {
  const domain = options.domain;
  if (!domain) throw new TypeError("domain is required");
  const entitlementId = requiredText(options.entitlementId, "entitlementId");
  const budgetId = requiredText(options.budgetId, "budgetId");
  const budgetVersion = requiredText(options.budgetVersion, "budgetVersion");
  const priceId = requiredText(options.priceId, "priceId");
  const priceVersion = requiredText(options.priceVersion, "priceVersion");
  const meter = requiredText(options.meter, "meter");

  function authorize(input) {
    const snapshot = domain.snapshot();
    const entitlement = [...snapshot.entitlements].reverse().find((fact) => fact.entitlement_id === entitlementId);
    if (!entitlement || entitlement.state !== "active") return Object.freeze({ allowed: false, reason: "entitlement_inactive" });
    const reservation = domain.reserveBudget({ budget_id: budgetId, budget_version: budgetVersion,
      reservation_id: requiredText(input?.operation_id, "operation_id"), amount_minor: input?.estimated_minor });
    if (!reservation.accepted) return Object.freeze({ allowed: false, reason: reservation.reason });
    return Object.freeze({ allowed: true, reservation: reservation.record });
  }

  function recordUsage(input) {
    const quantity = safeInteger(input?.quantity, "quantity", 0);
    const occurredAt = safeInteger(input?.occurred_at_ms, "occurred_at_ms", 0);
    const snapshot = domain.snapshot();
    const price = snapshot.prices.find((fact) => fact.price_id === priceId && fact.version === priceVersion);
    if (!price) throw authorityError("price_unconfigured", "runtime price version is not configured");
    const expectedMinor = Math.ceil(quantity / price.unit_size) * price.unit_minor;
    if (!Number.isSafeInteger(expectedMinor) || input?.estimated_minor !== expectedMinor) {
      throw authorityError("estimate_mismatch", "budget estimate must equal immutable price calculation");
    }
    const authorized = authorize(input);
    if (!authorized.allowed) return authorized;
    const usage = domain.appendUsage({ source_event_id: requiredText(input.operation_id, "operation_id"), meter,
      quantity, price_id: priceId, price_version: priceVersion, occurred_at_ms: occurredAt });
    return Object.freeze({ allowed: true, reservation: authorized.reservation, usage: usage.record, duplicate: usage.duplicate });
  }

  return Object.freeze({ authorize, recordUsage, mode: "sandbox_no_charge" });
}

function verifyApproval(input, state, now) {
  const approvedAt = Number(input?.approved_at_ms);
  const expiresAt = Number(input?.expires_at_ms);
  if (!Number.isSafeInteger(approvedAt) || !Number.isSafeInteger(expiresAt) || approvedAt > now || expiresAt < now || expiresAt - approvedAt > MAX_APPROVAL_TTL_MS) {
    throw authorityError("approval_expired", "approval time window is invalid");
  }
  const expected = binding(state.verified, input, state.preview);
  if (expected !== input.approval_binding || scope(input) !== state.scope) {
    throw authorityError("approval_scope_mismatch", "approval is not bound to this package and profile scope");
  }
  const keyId = requiredText(input?.approver_key_id, "approver_key_id");
  const trust = stateApprovalTrust(state, input);
  const key = trust.get(keyId);
  if (!key) throw authorityError("approval_signer_untrusted", "approval signer is not trusted");
  let signature;
  try { signature = Buffer.from(String(input?.approval_signature || ""), "base64"); } catch { signature = Buffer.alloc(0); }
  const approval = canonicalJson({ schema: "moa-companion-approval/v1", approval_binding: expected,
    approved_at_ms: approvedAt, expires_at_ms: expiresAt, approver_key_id: keyId });
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(approval), key, signature)) {
    throw authorityError("approval_signature_invalid", "approval signature is invalid");
  }
}

function stateApprovalTrust(state) {
  const configured = state.approvalTrustStore;
  return configured instanceof Map ? configured : new Map(Object.entries(configured || {}));
}

function binding(verified, input, preview) {
  return digest(["companion-approval/v1", verified.package_digest, preview.receipt_digest, scope(input),
    requiredText(input?.expected_profile_version, "expected_profile_version")]);
}
function scope(input) { return `${input?.scope === "device" ? "device" : "global"}:${input?.scope === "device" ? requiredText(input?.device_id, "device_id") : ""}`; }
function packageBytes(input) { if (typeof input?.package_base64 !== "string" || input.package_base64.length > 16 * 1024 * 1024) throw authorityError("invalid_package", "bounded package_base64 is required"); return Buffer.from(input.package_base64, "base64"); }
function requiredText(value, name) { const text = String(value || ""); if (!text || text.length > 200) throw authorityError("invalid_input", `${name} is invalid`); return text; }
function safeInteger(value, name, min) { if (!Number.isSafeInteger(value) || value < min) throw authorityError("invalid_input", `${name} is invalid`); return value; }
function requiredFunction(value, name) { if (typeof value !== "function") throw new TypeError(`${name} is required`); return value; }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function authorityError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = { createCompanionRuntimeAuthority, createBillingRuntimeAuthority, MAX_APPROVAL_TTL_MS };
