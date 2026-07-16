"use strict";

const crypto = require("node:crypto");

const PROGRAM_TOOL = "surface.program.execute";
const MAX_RUNTIMES = 8;
const MAX_CATALOG_TOOLS = 100;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TOOL_CALLS = 100;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MIN_EXPIRY_MS = 1_000;
const MAX_EXPIRY_MS = 5 * 60_000;

class SurfaceProgramValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SurfaceProgramValidationError";
    this.code = code;
  }
}

function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function closedRecord(value, allowed, label) {
  if (!isRecord(value)) throw new SurfaceProgramValidationError(`invalid_${label}`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new SurfaceProgramValidationError(`unknown_${label}_field`, `${label}.${unknown} is not allowed`);
  return value;
}

function requiredText(value, label, max = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return text;
}

function nullableText(value, label, max = 240) {
  if (value == null) return null;
  return requiredText(value, label, max);
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return value;
}

function digest(value, label) {
  const text = requiredText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return text;
}

function timestamp(value, label) {
  const text = requiredText(value, label, 64);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return { text: new Date(millis).toISOString(), millis };
}

function stringArray(value, label, maxItems, maxLength = 120) {
  if (!Array.isArray(value) || value.length > maxItems) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return value.map((item) => requiredText(item, label.replace(/s$/, ""), maxLength));
}

function integerArray(value, label, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) throw new SurfaceProgramValidationError(`invalid_${label}`);
  return value.map((item) => integer(item, label.replace(/s$/, "")));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function validateLimits(value, maxima = {}) {
  const limits = closedRecord(value, ["source_bytes", "wall_ms", "memory_bytes", "tool_calls", "parallel_calls", "result_bytes", "log_bytes"], "limits");
  const bounds = {
    source_bytes: Math.min(maxima.source_bytes ?? MAX_SOURCE_BYTES, MAX_SOURCE_BYTES),
    wall_ms: Math.min(maxima.wall_ms ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
    memory_bytes: Math.min(maxima.memory_bytes ?? MAX_MEMORY_BYTES, MAX_MEMORY_BYTES),
    tool_calls: Math.min(maxima.tool_calls ?? MAX_TOOL_CALLS, MAX_TOOL_CALLS),
    parallel_calls: Math.min(maxima.parallel_calls ?? 16, 16),
    result_bytes: Math.min(maxima.result_bytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES),
    log_bytes: Math.min(maxima.log_bytes ?? 64 * 1024, 64 * 1024),
  };
  return Object.freeze({
    source_bytes: integer(limits.source_bytes, "source_bytes", 1, bounds.source_bytes),
    wall_ms: integer(limits.wall_ms, "wall_ms", 100, bounds.wall_ms),
    memory_bytes: integer(limits.memory_bytes, "memory_bytes", 1024 * 1024, bounds.memory_bytes),
    tool_calls: integer(limits.tool_calls, "tool_calls", 1, bounds.tool_calls),
    parallel_calls: integer(limits.parallel_calls, "parallel_calls", 1, bounds.parallel_calls),
    result_bytes: integer(limits.result_bytes, "result_bytes", 1024, bounds.result_bytes),
    log_bytes: integer(limits.log_bytes, "log_bytes", 0, bounds.log_bytes),
  });
}

function validateTarget(value, label = "target") {
  const target = closedRecord(value, ["surface_type", "device_id"], label);
  return Object.freeze({
    surface_type: requiredText(target.surface_type, "surface_type", 80),
    device_id: requiredText(target.device_id, "device_id", 120),
  });
}

function validateRuntime(value) {
  const runtime = closedRecord(value, ["runtime_id", "language", "bridge_version", "entrypoint"], "runtime");
  return Object.freeze({
    runtime_id: requiredText(runtime.runtime_id, "runtime_id", 80),
    language: requiredText(runtime.language, "language", 40),
    bridge_version: integer(runtime.bridge_version, "bridge_version", 1, 1000),
    entrypoint: requiredText(runtime.entrypoint, "entrypoint", 40),
  });
}

function validateAdvertisedCatalog(value) {
  const catalog = closedRecord(value, ["version", "sha256", "capability_ids"], "catalog");
  const capabilityIds = stringArray(catalog.capability_ids, "capability_ids", MAX_CATALOG_TOOLS);
  if (new Set(capabilityIds).size !== capabilityIds.length || capabilityIds.some((id) => !/^[a-z][a-z0-9_.:-]{0,119}$/.test(id))) {
    throw new SurfaceProgramValidationError("invalid_capability_ids");
  }
  return Object.freeze({ version: integer(catalog.version, "catalog_version", 1), sha256: digest(catalog.sha256, "catalog_sha256"), capability_ids: Object.freeze(capabilityIds) });
}

function sanitizeExecutionRuntime(value, options = {}) {
  try {
    const advertisement = closedRecord(value, ["version", "type", "advertisement_id", "target", "runtime", "catalog", "limits", "issued_at", "expires_at"], "runtime_advertisement");
    if (advertisement.version !== 1 || advertisement.type !== "surface.runtime.advertised") throw new SurfaceProgramValidationError("unsupported_runtime_advertisement");
    const issued = timestamp(advertisement.issued_at, "issued_at");
    const expires = timestamp(advertisement.expires_at, "expires_at");
    if (expires.millis <= issued.millis || expires.millis - issued.millis > MAX_EXPIRY_MS) throw new SurfaceProgramValidationError("invalid_runtime_expiry");
    const normalized = {
      version: 1,
      type: advertisement.type,
      advertisement_id: requiredText(advertisement.advertisement_id, "advertisement_id", 160),
      target: validateTarget(advertisement.target),
      runtime: validateRuntime(advertisement.runtime),
      catalog: validateAdvertisedCatalog(advertisement.catalog),
      limits: validateLimits(advertisement.limits),
      issued_at: issued.text,
      expires_at: expires.text,
    };
    if (options.device_id && normalized.target.device_id !== options.device_id) throw new SurfaceProgramValidationError("advertisement_target_mismatch");
    if (options.surface_type && normalized.target.surface_type !== options.surface_type) throw new SurfaceProgramValidationError("advertisement_surface_mismatch");
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

function sanitizeExecutionRuntimes(value, options = {}) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  return Object.freeze(value.map((item) => sanitizeExecutionRuntime(item, options)).filter((item) => {
    if (!item || seen.has(item.runtime.runtime_id)) return false;
    seen.add(item.runtime.runtime_id);
    return true;
  }).slice(0, MAX_RUNTIMES));
}

function selectSurfaceRuntime(devices, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const deviceId = options.target_device_id || options.device_id || "";
  const surfaceType = options.target_surface_type || options.surface_type || "";
  const runtimeId = options.runtime_id || "";
  const language = options.language || "";
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device && device.online !== false)
    .filter((device) => !deviceId || (device.device_id || device.id) === deviceId)
    .filter((device) => !surfaceType || device.surface_type === surfaceType)
    .flatMap((device) => sanitizeExecutionRuntimes(device.execution_runtimes, { device_id: device.device_id || device.id, surface_type: device.surface_type }).map((advertisement) => ({ device, advertisement, runtime: advertisement.runtime })))
    .filter(({ advertisement }) => Date.parse(advertisement.expires_at) > nowMs)
    .filter(({ runtime }) => !runtimeId || runtime.runtime_id === runtimeId)
    .filter(({ runtime }) => !language || runtime.language === language)
    .sort((a, b) => Date.parse(b.advertisement.issued_at) - Date.parse(a.advertisement.issued_at))[0] || null;
}

const BINDING_FIELDS = Object.freeze({
  browser_document: ["kind", "tab_id", "window_id", "frame_id", "origin", "document_id", "page_epoch", "observation_id", "observation_digest", "state_sha256", "allowed_frames", "allowed_worlds", "site_grant_id"],
  android_accessibility: ["kind", "package_name", "window_id", "observation_id", "observation_generation", "state_sha256", "app_grant_id"],
  macos_accessibility: ["kind", "bundle_id", "pid", "process_generation", "signing_identity", "window_id", "ax_snapshot_id", "state_sha256", "local_grant_id"],
  macos_apple_events: ["kind", "target_bundle_id", "signing_identity", "suite_allowlist", "command_allowlist", "state_sha256", "local_grant_id"],
  macos_shell: ["kind", "policy_id", "argument_sha256", "cwd_profile_id", "filesystem_profile_id", "network_profile_id", "environment_sha256", "state_sha256", "local_grant_id"],
  gateway_server: ["kind", "tenant_id", "project_id", "connection_id", "resource_id", "state_sha256"],
});

function validateBindings(value) {
  if (!isRecord(value)) throw new SurfaceProgramValidationError("invalid_bindings");
  const kind = requiredText(value.kind, "binding_kind", 80);
  const fields = BINDING_FIELDS[kind];
  if (!fields) throw new SurfaceProgramValidationError("invalid_binding_kind");
  const input = closedRecord(value, fields, "bindings");
  const output = { kind };
  const textFields = fields.filter((field) => !["kind", "tab_id", "window_id", "frame_id", "page_epoch", "observation_generation", "pid", "process_generation", "allowed_frames", "allowed_worlds", "suite_allowlist", "command_allowlist"].includes(field) && !field.endsWith("sha256") && field !== "observation_digest");
  for (const field of textFields) if (input[field] != null) output[field] = requiredText(input[field], field, field === "origin" ? 2000 : 240);
  for (const field of fields.filter((field) => field.endsWith("sha256") || field === "observation_digest")) if (input[field] != null) output[field] = digest(input[field], field);
  for (const field of ["tab_id", "frame_id", "page_epoch", "observation_generation", "pid", "process_generation"]) if (fields.includes(field) && input[field] != null) output[field] = integer(input[field], field);
  if (fields.includes("window_id") && input.window_id != null) output.window_id = kind === "browser_document" ? integer(input.window_id, "window_id") : requiredText(input.window_id, "window_id", 240);
  if (input.allowed_frames != null) output.allowed_frames = integerArray(input.allowed_frames, "allowed_frames", 64);
  if (input.allowed_worlds != null) output.allowed_worlds = stringArray(input.allowed_worlds, "allowed_worlds", 8, 40);
  if (input.suite_allowlist != null) output.suite_allowlist = stringArray(input.suite_allowlist, "suite_allowlist", 32);
  if (input.command_allowlist != null) output.command_allowlist = stringArray(input.command_allowlist, "command_allowlist", 64);
  return Object.freeze(output);
}

function createSurfaceProgramEnvelope(input, selected, options = {}) {
  closedRecord(input, ["source", "session_id", "turn_id", "bindings", "limits", "approval_policy", "expires_in_ms", "idempotency_key", "allowed_capability_ids"], "request");
  if (!selected?.device || !selected?.advertisement) throw new SurfaceProgramValidationError("runtime_unavailable");
  const source = typeof input.source === "string" ? input.source : "";
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (!source.trim() || sourceBytes > selected.advertisement.limits.source_bytes) throw new SurfaceProgramValidationError("invalid_program_source");
  const nowMs = options.nowMs ?? Date.now();
  const expiryMs = integer(input.expires_in_ms ?? 60_000, "expires_in_ms", MIN_EXPIRY_MS, Math.min(MAX_EXPIRY_MS, Date.parse(selected.advertisement.expires_at) - nowMs));
  const allowed = input.allowed_capability_ids == null ? selected.advertisement.catalog.capability_ids : stringArray(input.allowed_capability_ids, "allowed_capability_ids", MAX_CATALOG_TOOLS);
  if (new Set(allowed).size !== allowed.length || allowed.some((id) => !selected.advertisement.catalog.capability_ids.includes(id))) throw new SurfaceProgramValidationError("capability_escalation");
  const requestedLimits = { ...selected.advertisement.limits, ...(input.limits || {}), source_bytes: sourceBytes };
  const approvalInput = closedRecord(input.approval_policy || { program: "local_policy", always_ask: [] }, ["program", "always_ask"], "approval_policy");
  const envelope = {
    version: 1,
    type: "surface.execution.proposed",
    execution_id: requiredText(options.executionId || `exec_${crypto.randomUUID()}`, "execution_id", 160),
    session_id: requiredText(input.session_id, "session_id", 160),
    turn_id: requiredText(input.turn_id, "turn_id", 160),
    target: selected.advertisement.target,
    runtime: selected.advertisement.runtime,
    program: Object.freeze({ source, sha256: sha256(source) }),
    catalog: Object.freeze({ version: selected.advertisement.catalog.version, sha256: selected.advertisement.catalog.sha256, allowed_capability_ids: Object.freeze(allowed.slice()) }),
    bindings: validateBindings(input.bindings),
    limits: validateLimits(requestedLimits, selected.advertisement.limits),
    approval_policy: Object.freeze({ program: requiredText(approvalInput.program, "approval_program", 80), always_ask: Object.freeze(stringArray(approvalInput.always_ask, "always_ask", 32, 80)) }),
    idempotency_key: requiredText(input.idempotency_key || options.idempotencyKey || `idem_${crypto.randomUUID()}`, "idempotency_key", 200),
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + expiryMs).toISOString(),
  };
  return Object.freeze(envelope);
}

function validateSurfaceProgramEnvelope(value, options = {}) {
  const envelope = closedRecord(value, ["version", "type", "execution_id", "session_id", "turn_id", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy", "idempotency_key", "issued_at", "expires_at"], "envelope");
  if (envelope.version !== 1 || envelope.type !== "surface.execution.proposed") throw new SurfaceProgramValidationError("unsupported_envelope");
  requiredText(envelope.execution_id, "execution_id", 160); requiredText(envelope.session_id, "session_id", 160); requiredText(envelope.turn_id, "turn_id", 160);
  const target = validateTarget(envelope.target); const runtime = validateRuntime(envelope.runtime);
  const program = closedRecord(envelope.program, ["source", "sha256"], "program");
  const catalog = closedRecord(envelope.catalog, ["version", "sha256", "allowed_capability_ids"], "catalog");
  integer(catalog.version, "catalog_version", 1); digest(catalog.sha256, "catalog_sha256");
  const allowed = stringArray(catalog.allowed_capability_ids, "allowed_capability_ids", MAX_CATALOG_TOOLS);
  if (new Set(allowed).size !== allowed.length || allowed.some((id) => !/^[a-z][a-z0-9_.:-]{0,119}$/.test(id))) throw new SurfaceProgramValidationError("invalid_allowed_capability_ids");
  validateBindings(envelope.bindings);
  const limits = validateLimits(envelope.limits);
  const approval = closedRecord(envelope.approval_policy, ["program", "always_ask"], "approval_policy");
  requiredText(approval.program, "approval_program", 80); stringArray(approval.always_ask, "always_ask", 32, 80);
  requiredText(envelope.idempotency_key, "idempotency_key", 200);
  if (typeof program.source !== "string" || !program.source.trim() || Buffer.byteLength(program.source, "utf8") !== limits.source_bytes || digest(program.sha256, "program_sha256") !== sha256(program.source)) throw new SurfaceProgramValidationError("program_hash_mismatch");
  const issued = timestamp(envelope.issued_at, "issued_at"); const expires = timestamp(envelope.expires_at, "expires_at");
  if (expires.millis <= issued.millis || expires.millis - issued.millis > MAX_EXPIRY_MS) throw new SurfaceProgramValidationError("invalid_expiry");
  if (!options.allowExpired && (options.nowMs ?? Date.now()) >= expires.millis) throw new SurfaceProgramValidationError("expired");
  if (options.target_device_id && target.device_id !== options.target_device_id) throw new SurfaceProgramValidationError("target_mismatch");
  if (options.advertisement) {
    const advertised = options.advertisement;
    if (canonicalJson(target) !== canonicalJson(advertised.target) || canonicalJson(runtime) !== canonicalJson(advertised.runtime)
      || catalog.version !== advertised.catalog.version || catalog.sha256 !== advertised.catalog.sha256
      || allowed.some((id) => !advertised.catalog.capability_ids.includes(id))) throw new SurfaceProgramValidationError("runtime_catalog_mismatch");
  }
  return envelope;
}

function surfaceProgramReceiptBindings(envelope) {
  return Object.freeze({ program_sha256: envelope.program.sha256, catalog_sha256: envelope.catalog.sha256, bindings_sha256: sha256(envelope.bindings) });
}

function validateSurfaceProgramTerminalReceipt(envelope, value, claim, options = {}) {
  validateSurfaceProgramEnvelope(envelope, { nowMs: options.nowMs ?? Date.now(), allowExpired: true });
  const receipt = closedRecord(value, ["version", "type", "receipt_id", "execution_id", "session_id", "turn_id", "claimant", "runtime_id", "program_sha256", "catalog_sha256", "bindings_sha256", "started_at", "finished_at", "status", "tool_attempts", "result", "final_state_sha256", "error", "previous_receipt_sha256", "receipt_sha256"], "terminal_receipt");
  if (receipt.version !== 1 || receipt.type !== "surface.execution.receipt") throw new SurfaceProgramValidationError("unsupported_terminal_receipt");
  const statuses = ["rejected", "completed", "failed", "timed_out", "stopped", "interrupted", "indeterminate"];
  if (!statuses.includes(receipt.status)) throw new SurfaceProgramValidationError("invalid_terminal_status");
  for (const field of ["execution_id", "session_id", "turn_id"]) if (requiredText(receipt[field], field, 160) !== envelope[field]) throw new SurfaceProgramValidationError(`${field}_mismatch`);
  const claimant = closedRecord(receipt.claimant, ["surface_type", "device_id", "client_instance_id"], "claimant");
  if (requiredText(claimant.surface_type, "claimant_surface_type", 80) !== envelope.target.surface_type || requiredText(claimant.device_id, "claimant_device_id", 120) !== claim.device_id || requiredText(claimant.client_instance_id, "client_instance_id", 160) !== claim.client_instance_id) throw new SurfaceProgramValidationError("claimant_mismatch");
  if (requiredText(receipt.runtime_id, "runtime_id", 80) !== envelope.runtime.runtime_id) throw new SurfaceProgramValidationError("runtime_id_mismatch");
  const expected = surfaceProgramReceiptBindings(envelope);
  for (const field of Object.keys(expected)) if (digest(receipt[field], field) !== expected[field]) throw new SurfaceProgramValidationError(`${field}_mismatch`);
  const started = receipt.started_at == null ? null : timestamp(receipt.started_at, "started_at");
  const finished = timestamp(receipt.finished_at, "finished_at");
  if (started && finished.millis < started.millis) throw new SurfaceProgramValidationError("invalid_receipt_timestamps");
  const attempts = closedRecord(receipt.tool_attempts, ["count", "first_receipt_sha256", "last_receipt_sha256"], "tool_attempts");
  integer(attempts.count, "tool_attempt_count", 0, envelope.limits.tool_calls);
  for (const field of ["first_receipt_sha256", "last_receipt_sha256"]) if (attempts[field] != null) digest(attempts[field], field);
  const result = closedRecord(receipt.result, ["summary", "data_sha256", "artifact_refs"], "terminal_result");
  const summary = String(result.summary || "");
  if (Buffer.byteLength(summary, "utf8") > Math.min(2000, envelope.limits.result_bytes)) throw new SurfaceProgramValidationError("result_too_large");
  if (result.data_sha256 != null) digest(result.data_sha256, "data_sha256");
  stringArray(result.artifact_refs, "artifact_refs", 32, 240);
  const error = closedRecord(receipt.error, ["code", "message"], "terminal_error");
  nullableText(error.code, "error_code", 120); nullableText(error.message, "error_message", 1000);
  for (const field of ["final_state_sha256", "previous_receipt_sha256", "receipt_sha256"]) if (receipt[field] != null) digest(receipt[field], field);
  requiredText(receipt.receipt_id, "receipt_id", 160);
  return Object.freeze({ ...receipt, claimant: Object.freeze({ ...claimant }), started_at: started?.text || null, finished_at: finished.text });
}

module.exports = {
  PROGRAM_TOOL, MAX_SOURCE_BYTES, SurfaceProgramValidationError, canonicalJson, sha256,
  sanitizeExecutionRuntime, sanitizeExecutionRuntimes, selectSurfaceRuntime,
  createSurfaceProgramEnvelope, validateSurfaceProgramEnvelope, surfaceProgramReceiptBindings,
  validateSurfaceProgramTerminalReceipt,
};
