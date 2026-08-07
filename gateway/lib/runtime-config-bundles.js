"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalJson, digest } = require("./companion-package");

const SCHEMA = "ag.runtime-config-bundle.v1";
const STORE_VERSION = 1;
const DEFAULT_PROTOCOL = "1.0.0";
const STORE_FILENAME = "self-extension-runtime-bundles.json";
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_FIELDS = new Set([
  "system_prompt", "model", "temperature", "voice_max_chars", "voice", "speaking_rate",
  "voice_tone", "language", "language_primary", "language_output", "language_auto_switch",
  "input_languages", "input_language_primary", "response_modality", "voice_provider",
  "stt_provider", "reasoning_provider", "tts_provider", "tool_policy", "autonomy_level",
  "memory_policy", "recovery_mode",
]);
const CAPABILITIES = new Set([
  "agent.execution", "intent.capture", "provider.routing", "response.policy",
  "voice.cascaded", "voice.realtime", "workflow.routing",
]);
const HEALTH_CHECKS = new Set(["profile_projection"]);

class RuntimeBundleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeBundleError";
    this.code = code;
    this.details = details;
  }
}

function createRuntimeConfigBundleStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const storePath = path.join(dataDir, STORE_FILENAME);
  const protocolVersion = semver(options.protocolVersion) || DEFAULT_PROTOCOL;
  const trustStore = normalizeTrustStore(options.trustStore);
  const applyProfile = requiredFunction(options.applyProfile, "applyProfile");
  const rollbackProfile = requiredFunction(options.rollbackProfile, "rollbackProfile");
  const currentProfileVersion = requiredFunction(options.currentProfileVersion, "currentProfileVersion");
  const healthCheck = typeof options.healthCheck === "function" ? options.healthCheck : (() => ({ ok: true }));
  const now = typeof options.now === "function" ? options.now : (() => new Date().toISOString());
  fs.mkdirSync(dataDir, { recursive: true });

  let state = loadState(storePath, { trustStore, protocolVersion });
  recoverPending();

  function publish(input) {
    const manifest = verifyManifest(input, { trustStore, protocolVersion });
    const existing = state.bundles[manifest.bundle_id];
    const manifestDigest = digest(manifest);
    if (existing) {
      if (existing.manifest_digest !== manifestDigest) fail("bundle_collision", "bundle id is already bound to different bytes");
      return publicRecord(existing);
    }
    const createdAt = now();
    const record = {
      id: manifest.bundle_id,
      type: "runtime_bundle",
      title: `${manifest.channel} runtime ${manifest.version}`,
      status: "staged",
      variant_group_id: `runtime_${manifest.channel}`,
      parent_id: state.active_id || "",
      prompt: "",
      spec: manifest,
      preview: runtimePreview(manifest),
      validation: { ok: true, errors: [], warnings: [] },
      apply_context: {},
      created_at: createdAt,
      updated_at: createdAt,
      applied_at: "",
      manifest_digest: manifestDigest,
      activation: {},
    };
    state.bundles[record.id] = record;
    appendAudit("bundle_staged", record.id, { manifest_digest: manifestDigest });
    flush();
    return publicRecord(record);
  }

  function activate(id, applyContext = {}, activationPolicy = {}) {
    const record = find(id);
    if (!record) return null;
    const previousId = state.active_id || "";
    if (previousId === record.id) return publicRecord(record);
    const previous = find(previousId);
    if (previous && record.spec.sequence <= previous.spec.sequence && activationPolicy.allowRollback !== true) {
      fail("stale_bundle", "runtime bundle sequence must advance monotonically");
    }
    const beforeProfileVersion = String(currentProfileVersion() || "");
    const startedAt = now();
    state.pending = {
      bundle_id: record.id,
      previous_bundle_id: previousId,
      before_profile_version: beforeProfileVersion,
      started_at: startedAt,
    };
    appendAudit("activation_started", record.id, { previous_bundle_id: previousId });
    flush();

    let activation;
    try {
      activation = applyProfile(record.spec.payload.profile_patch, {
        source: "runtime_bundle",
        reason: `activate:${record.id}`,
        bundle_id: record.id,
      }) || {};
      const result = normalizeHealth(healthCheck({ manifest: record.spec, activation }));
      if (!result.ok) {
        throw new RuntimeBundleError("health_check_failed", "runtime bundle health check failed", { checks: result.checks });
      }
      const appliedAt = now();
      if (previousId && state.bundles[previousId] && previousId !== record.id) {
        state.bundles[previousId].status = "staged";
        state.bundles[previousId].updated_at = appliedAt;
      }
      record.status = "applied";
      record.updated_at = appliedAt;
      record.applied_at = appliedAt;
      record.apply_context = plainObject(applyContext);
      record.activation = {
        health: result,
        before_profile_version: beforeProfileVersion,
        after_profile_version: String(activation.after_profile_version || currentProfileVersion() || ""),
      };
      state.active_id = record.id;
      state.previous_good_id = previousId && previousId !== record.id ? previousId : state.previous_good_id;
      state.last_known_good_id = record.id;
      state.pending = null;
      appendAudit("activation_succeeded", record.id, { previous_bundle_id: previousId, checks: result.checks });
      flush();
      return publicRecord(record);
    } catch (error) {
      rollbackToProfile(beforeProfileVersion, record.id, "activation_failed");
      record.status = "failed";
      record.updated_at = now();
      record.activation = {
        error_code: cleanToken(error?.code, 80) || "activation_failed",
        rolled_back_to_bundle_id: previousId,
        before_profile_version: beforeProfileVersion,
      };
      state.pending = null;
      appendAudit("activation_rolled_back", record.id, {
        previous_bundle_id: previousId,
        error_code: record.activation.error_code,
      });
      flush();
      throw new RuntimeBundleError(record.activation.error_code,
        "runtime bundle activation failed; last-known-good remains active", { bundle_id: record.id, previous_bundle_id: previousId });
    }
  }

  function rollbackLastKnownGood(context = {}) {
    const targetId = state.previous_good_id;
    if (!targetId || targetId === state.active_id) {
      return { ok: false, reason: "no_previous_good_bundle", runtime: runtime() };
    }
    const artifact = activate(targetId, context, { allowRollback: true });
    return { ok: true, artifact, runtime: runtime() };
  }

  function runtime(clientProtocol = protocolVersion) {
    const requestedProtocol = semver(clientProtocol) || protocolVersion;
    const active = find(state.active_id);
    const compatible = active ? isCompatible(active.spec.compatibility, requestedProtocol) : true;
    return {
      schema: "ag.runtime-config-status.v1",
      protocol_version: protocolVersion,
      client_protocol_version: requestedProtocol,
      signing_configured: trustStore.size > 0,
      state: active ? (compatible ? "healthy" : "incompatible_client") : "base",
      active: active ? runtimeArtifact(active, compatible) : null,
      last_known_good_bundle_id: state.last_known_good_id || "",
      previous_good_bundle_id: state.previous_good_id || "",
      pending: state.pending ? { bundle_id: state.pending.bundle_id, started_at: state.pending.started_at } : null,
      recent_audit: state.audit.slice(-20).reverse(),
    };
  }

  function list(filter = {}) {
    const status = cleanToken(filter.status, 40);
    const limit = clamp(filter.limit, 100);
    return Object.values(state.bundles)
      .filter((record) => !status || record.status === status)
      .sort((a, b) => b.spec.sequence - a.spec.sequence)
      .slice(0, limit)
      .map(publicRecord);
  }

  function get(id) {
    const record = find(id);
    return record ? publicRecord(record) : null;
  }

  function recoverPending() {
    if (!state.pending) return;
    const pending = state.pending;
    rollbackToProfile(pending.before_profile_version, pending.bundle_id, "startup_recovery");
    const record = find(pending.bundle_id);
    if (record) {
      record.status = "failed";
      record.updated_at = now();
      record.activation = { error_code: "interrupted_activation", rolled_back_to_bundle_id: pending.previous_bundle_id };
    }
    appendAudit("activation_recovered", pending.bundle_id, { previous_bundle_id: pending.previous_bundle_id });
    state.pending = null;
    flush();
  }

  function rollbackToProfile(version, bundleId, reason) {
    if (!version || String(currentProfileVersion() || "") === version) return;
    rollbackProfile(version, { source: "runtime_bundle", reason: `${reason}:${bundleId}` });
  }

  function find(id) {
    return state.bundles[cleanToken(id, 100)] || null;
  }

  function appendAudit(event, bundleId, details = {}) {
    state.audit.push({ event, bundle_id: bundleId || "", at: now(), ...plainObject(details) });
    if (state.audit.length > 200) state.audit = state.audit.slice(-200);
  }

  function flush() {
    atomicWrite(storePath, state);
  }

  return {
    storePath,
    publish,
    activate,
    rollbackLastKnownGood,
    runtime,
    list,
    get,
    known: () => ({ schema: SCHEMA, protocol_version: protocolVersion, channels: ["stable", "nightly"], capabilities: [...CAPABILITIES] }),
  };
}

function verifyManifest(input, policy = {}) {
  exactKeys(input, ["schema", "bundle_id", "version", "sequence", "channel", "created_at", "compatibility", "provenance", "payload", "health", "signer", "signature"], "manifest");
  if (input.schema !== SCHEMA) fail("unsupported_schema", "runtime bundle schema is unsupported");
  id(input.bundle_id, "bundle_id");
  if (!SEMVER.test(input.version || "")) fail("invalid_version", "version must be stable semver");
  integer(input.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence");
  if (!["stable", "nightly"].includes(input.channel)) fail("invalid_channel", "channel must be stable or nightly");
  timestamp(input.created_at, "created_at");
  validateCompatibility(input.compatibility, policy.protocolVersion, policy.enforceCompatibility !== false);
  validateProvenance(input.provenance);
  validatePayload(input.payload);
  validateHealth(input.health);
  validateSignature(input, policy.trustStore);
  return JSON.parse(canonicalJson(input));
}

function validateCompatibility(value, current, enforceCurrent) {
  exactKeys(value, ["protocol", "min_version", "max_version"], "compatibility");
  if (value.protocol !== "ag.android.runtime") fail("invalid_protocol", "runtime bundle protocol is unsupported");
  if (!SEMVER.test(value.min_version || "") || !SEMVER.test(value.max_version || "")) fail("invalid_compatibility", "compatibility versions must be semver");
  if (compareSemver(value.min_version, value.max_version) > 0) fail("invalid_compatibility", "minimum exceeds maximum");
  if (enforceCurrent && !isCompatible(value, current)) fail("incompatible_shell", "runtime bundle is incompatible with this shell protocol");
}

function validateProvenance(value) {
  exactKeys(value, ["source_uri", "source_digest", "author", "git_sha"], "provenance");
  if (typeof value.source_uri !== "string" || !/^(https:\/\/|urn:)/.test(value.source_uri) || value.source_uri.length > 500) fail("invalid_provenance", "source URI is invalid");
  if (!SHA256.test(value.source_digest || "")) fail("invalid_provenance", "source digest is invalid");
  text(value.author, 1, 160, "provenance.author");
  if (!/^[a-f0-9]{7,64}$/.test(value.git_sha || "")) fail("invalid_provenance", "git SHA is invalid");
}

function validatePayload(value) {
  exactKeys(value, ["profile_patch", "capabilities"], "payload");
  if (!isPlainObject(value.profile_patch)) fail("invalid_profile_patch", "profile patch must be an object");
  const keys = Object.keys(value.profile_patch);
  if (keys.length < 1 || keys.length > PROFILE_FIELDS.size) fail("invalid_profile_patch", "profile patch must contain bounded fields");
  for (const key of keys) {
    if (!PROFILE_FIELDS.has(key)) fail("forbidden_profile_field", `runtime bundle cannot set profile field: ${key}`);
    const item = value.profile_patch[key];
    if (!(typeof item === "string" || typeof item === "number" || typeof item === "boolean")) fail("invalid_profile_value", `profile value must be scalar: ${key}`);
  }
  if (Buffer.byteLength(canonicalJson(value.profile_patch)) > 32 * 1024) fail("profile_patch_too_large", "profile patch exceeds byte limit");
  uniqueList(value.capabilities, 32, "capabilities");
  for (const capability of value.capabilities) if (!CAPABILITIES.has(capability)) fail("forbidden_capability", `unknown declarative capability: ${capability}`);
}

function validateHealth(value) {
  exactKeys(value, ["required_checks"], "health");
  uniqueList(value.required_checks, 8, "health.required_checks");
  if (!value.required_checks.includes("profile_projection")) fail("missing_health_check", "profile_projection health check is required");
  for (const check of value.required_checks) if (!HEALTH_CHECKS.has(check)) fail("unknown_health_check", `unsupported health check: ${check}`);
}

function validateSignature(manifest, trustStore) {
  exactKeys(manifest.signer, ["key_id", "algorithm"], "signer");
  id(manifest.signer.key_id, "signer.key_id");
  if (manifest.signer.algorithm !== "Ed25519") fail("unsupported_signature", "only Ed25519 is supported");
  const key = trustStore?.get(manifest.signer.key_id);
  if (!key) fail("unknown_signer", "runtime bundle signer is not trusted");
  let signature;
  try { signature = Buffer.from(manifest.signature, "base64"); } catch { fail("invalid_signature", "signature is malformed"); }
  const unsigned = JSON.parse(JSON.stringify(manifest));
  delete unsigned.signature;
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(canonicalJson(unsigned)), key, signature)) fail("invalid_signature", "runtime bundle signature verification failed");
}

function signRuntimeBundle(manifest, { keyId, privateKey }) {
  id(keyId, "signer.key_id");
  const unsigned = { ...manifest, signer: { key_id: keyId, algorithm: "Ed25519" } };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
  return { ...unsigned, signature };
}

function loadState(storePath, policy) {
  if (!fs.existsSync(storePath)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (!isPlainObject(raw) || raw.version !== STORE_VERSION || !isPlainObject(raw.bundles) || !Array.isArray(raw.audit)) throw new Error("invalid state");
    const next = emptyState();
    for (const record of Object.values(raw.bundles)) {
      if (!isPlainObject(record) || typeof record.id !== "string") continue;
      const manifest = verifyManifest(record.spec, { ...policy, enforceCompatibility: false });
      if (manifest.bundle_id !== record.id || digest(manifest) !== record.manifest_digest) continue;
      next.bundles[record.id] = { ...record, spec: manifest };
    }
    next.active_id = next.bundles[raw.active_id] ? raw.active_id : "";
    next.last_known_good_id = next.bundles[raw.last_known_good_id] ? raw.last_known_good_id : next.active_id;
    next.previous_good_id = next.bundles[raw.previous_good_id] ? raw.previous_good_id : "";
    next.pending = isPlainObject(raw.pending) ? raw.pending : null;
    next.audit = raw.audit.slice(-200).filter(isPlainObject);
    return next;
  } catch {
    archive(storePath);
    return emptyState();
  }
}

function publicRecord(record) { return JSON.parse(JSON.stringify(record)); }
function runtimeArtifact(record, compatible) {
  return {
    artifact_id: record.id, type: record.type, title: record.title, status: record.status,
    manifest_digest: record.manifest_digest, manifest: runtimeManifest(record.spec),
    applied_at: record.applied_at, compatible, activation: JSON.parse(JSON.stringify(record.activation || {})),
  };
}
function runtimeManifest(manifest) {
  const { payload, signature, ...safe } = manifest;
  return JSON.parse(JSON.stringify(safe));
}
function runtimePreview(manifest) { return { version: manifest.version, sequence: manifest.sequence, channel: manifest.channel, capabilities: [...manifest.payload.capabilities] }; }
function normalizeHealth(value) {
  const input = isPlainObject(value) ? value : {};
  return { ok: input.ok === true, checks: Array.isArray(input.checks) ? input.checks.filter((item) => typeof item === "string").slice(0, 8) : [] };
}
function emptyState() { return { version: STORE_VERSION, bundles: {}, active_id: "", last_known_good_id: "", previous_good_id: "", pending: null, audit: [] }; }
function atomicWrite(file, value) { const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function archive(file) { if (!fs.existsSync(file)) return; try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`); } catch {} }
function normalizeTrustStore(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(isPlainObject(value) ? value : {});
  const output = new Map();
  for (const [keyId, publicKey] of entries) {
    try {
      id(keyId, "key_id");
      output.set(keyId, publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey));
    } catch {}
  }
  return output;
}
function runtimeBundleTrustStore(value) { try { return normalizeTrustStore(JSON.parse(String(value || "{}"))); } catch { return new Map(); } }
function exactKeys(value, expected, label) { if (!isPlainObject(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) fail("unknown_or_missing_field", `${label} fields do not match schema`); }
function uniqueList(value, max, label) { if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 100) || new Set(value).size !== value.length) fail("invalid_list", `${label} must be a bounded unique string list`); }
function isCompatible(value, current) { return SEMVER.test(current || "") && compareSemver(current, value.min_version) >= 0 && compareSemver(current, value.max_version) <= 0; }
function compareSemver(a, b) { const aa = a.split(".").map(Number); const bb = b.split(".").map(Number); return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]; }
function semver(value) { const textValue = String(value || "").trim(); return SEMVER.test(textValue) ? textValue : ""; }
function timestamp(value, label) { const parsed = typeof value === "string" ? new Date(value) : null; if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail("invalid_timestamp", `${label} is invalid`); }
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail("invalid_integer", `${label} is invalid`); }
function id(value, label) { if (typeof value !== "string" || !SAFE_ID.test(value)) fail("invalid_id", `${label} is invalid`); }
function text(value, min, max, label) { if (typeof value !== "string" || value.length < min || value.length > max) fail("invalid_text", `${label} is invalid`); }
function cleanToken(value, max) { return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, max) : ""; }
function plainObject(value) { return isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : {}; }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function clamp(value, fallback) { const number = Number(value || fallback); return Number.isFinite(number) ? Math.max(1, Math.min(Math.trunc(number), 500)) : fallback; }
function requiredFunction(value, name) { if (typeof value !== "function") throw new Error(`${name} is required`); return value; }
function fail(code, message) { throw new RuntimeBundleError(code, message); }

module.exports = {
  SCHEMA,
  DEFAULT_PROTOCOL,
  RuntimeBundleError,
  createRuntimeConfigBundleStore,
  runtimeBundleTrustStore,
  signRuntimeBundle,
  verifyManifest,
};
