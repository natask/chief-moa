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
const MAX_CLOCK_SKEW_MS = 30_000;
const APPROVAL_PROGRAMS = Object.freeze(["preauthorized", "local_policy", "approval_required"]);
const EFFECT_CLASSES = Object.freeze(["read", "navigation", "local_mutation", "external_side_effect", "destructive", "security_sensitive", "financial", "publishing", "sending"]);
const RUNTIME_PROFILES = Object.freeze({
  "browser.javascript.v1": { language: "javascript", entrypoint: "main", bindings: "browser_document", surfaces: ["browser_extension"] },
  "android.webview-js.v1": { language: "javascript", entrypoint: "main", bindings: "android_accessibility", surfaces: ["android"] },
  "macos.javascriptcore-ax.v1": { language: "javascript", entrypoint: "main", bindings: "macos_accessibility", surfaces: ["macos"] },
  "macos.jxa.v1": { language: "jxa", entrypoint: "main", bindings: "macos_apple_events", surfaces: ["macos"] },
  "macos.applescript.v1": { language: "applescript", entrypoint: "main", bindings: "macos_apple_events", surfaces: ["macos"] },
  "macos.shell.v1": { language: "shell", entrypoint: "main", bindings: "macos_shell", surfaces: ["macos"] },
  "gateway.quickjs.v1": { language: "javascript", entrypoint: "main", bindings: "gateway_server", surfaces: ["gateway"] },
});

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
  const normalized = Object.freeze({
    runtime_id: requiredText(runtime.runtime_id, "runtime_id", 80),
    language: requiredText(runtime.language, "language", 40),
    bridge_version: integer(runtime.bridge_version, "bridge_version", 1, 1000),
    entrypoint: requiredText(runtime.entrypoint, "entrypoint", 40),
  });
  const profile = RUNTIME_PROFILES[normalized.runtime_id];
  if (!profile || normalized.bridge_version !== 1 || normalized.language !== profile.language || normalized.entrypoint !== profile.entrypoint) {
    throw new SurfaceProgramValidationError("unsupported_runtime_profile");
  }
  return normalized;
}

function validateRuntimeTargetBindings(runtime, target, bindings) {
  const profile = RUNTIME_PROFILES[runtime.runtime_id];
  if (!profile || !profile.surfaces.includes(target.surface_type) || profile.bindings !== bindings.kind) {
    throw new SurfaceProgramValidationError("runtime_binding_target_mismatch");
  }
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
    const nowMs = options.nowMs ?? Date.now();
    if (issued.millis > nowMs + MAX_CLOCK_SKEW_MS) throw new SurfaceProgramValidationError("future_runtime_advertisement");
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
    .flatMap((device) => sanitizeExecutionRuntimes(device.execution_runtimes, { nowMs, device_id: device.device_id || device.id, surface_type: device.surface_type }).map((advertisement) => ({ device, advertisement, runtime: advertisement.runtime })))
    .filter(({ advertisement }) => Date.parse(advertisement.expires_at) > nowMs)
    .filter(({ runtime }) => !runtimeId || runtime.runtime_id === runtimeId)
    .filter(({ runtime }) => !language || runtime.language === language)
    .sort((a, b) => Date.parse(b.advertisement.issued_at) - Date.parse(a.advertisement.issued_at))[0] || null;
}

const BINDING_FIELDS = Object.freeze({
  browser_document: ["kind", "tab_id", "window_id", "frame_id", "origin", "document_id", "page_epoch", "observation_id", "observation_sha256", "state_sha256", "allowed_frames", "allowed_worlds", "site_grant_id"],
  android_accessibility: ["kind", "package_name", "window_id", "observation_id", "observation_generation", "state_sha256"],
  macos_accessibility: ["kind", "bundle_id", "pid", "process_generation", "signing_identity", "window_id", "ax_snapshot_id", "state_sha256", "local_grant_id"],
  macos_apple_events: ["kind", "target_bundle_id", "signing_identity", "suite_allowlist", "command_allowlist", "state_sha256", "local_grant_id"],
  macos_shell: ["kind", "policy_id", "argument_sha256", "cwd_profile_id", "filesystem_profile_id", "network_profile_id", "environment_sha256", "state_sha256", "local_grant_id"],
  gateway_server: ["kind", "tenant_id", "project_id", "connection_id", "resource_id", "state_sha256"],
});

function validateBindings(value, allowedCapabilityIds = []) {
  if (!isRecord(value)) throw new SurfaceProgramValidationError("invalid_bindings");
  const kind = requiredText(value.kind, "binding_kind", 80);
  const fields = BINDING_FIELDS[kind];
  if (!fields) throw new SurfaceProgramValidationError("invalid_binding_kind");
  const input = closedRecord(value, fields, "bindings");
  const browserEvaluationFields = ["allowed_frames", "allowed_worlds", "site_grant_id"];
  const requiredFields = kind === "gateway_server" ? ["tenant_id", "state_sha256"]
    : fields.filter((field) => field !== "kind" && !(kind === "browser_document" && browserEvaluationFields.includes(field)));
  const missing = requiredFields.find((field) => input[field] == null);
  if (missing) throw new SurfaceProgramValidationError(`missing_${missing}`);
  if (kind === "gateway_server" && ["project_id", "connection_id", "resource_id"].filter((field) => input[field] != null).length !== 1) throw new SurfaceProgramValidationError("invalid_gateway_resource_binding");
  if (kind === "browser_document") {
    const evaluationAllowed = allowedCapabilityIds.includes("browser.page.evaluate");
    const supplied = browserEvaluationFields.filter((field) => input[field] != null);
    if (evaluationAllowed && supplied.length !== browserEvaluationFields.length) throw new SurfaceProgramValidationError("missing_browser_evaluation_binding");
    if (!evaluationAllowed && supplied.length !== 0) throw new SurfaceProgramValidationError("unexpected_browser_evaluation_binding");
  }
  const output = { kind };
  const textFields = fields.filter((field) => !["kind", "tab_id", "window_id", "frame_id", "page_epoch", "observation_generation", "pid", "allowed_frames", "allowed_worlds", "suite_allowlist", "command_allowlist"].includes(field) && !field.endsWith("sha256"));
  for (const field of textFields) if (input[field] != null) output[field] = requiredText(input[field], field, field === "origin" ? 2000 : 240);
  for (const field of fields.filter((field) => field.endsWith("sha256") || field === "observation_digest")) if (input[field] != null) output[field] = digest(input[field], field);
  for (const field of ["tab_id", "frame_id", "page_epoch", "observation_generation", "pid"]) if (fields.includes(field) && input[field] != null) output[field] = integer(input[field], field);
  if (fields.includes("window_id") && input.window_id != null) output.window_id = kind === "browser_document" ? integer(input.window_id, "window_id") : requiredText(input.window_id, "window_id", 240);
  if (input.allowed_frames != null) output.allowed_frames = integerArray(input.allowed_frames, "allowed_frames", 64);
  if (input.allowed_worlds != null) output.allowed_worlds = stringArray(input.allowed_worlds, "allowed_worlds", 8, 40);
  if (input.suite_allowlist != null) output.suite_allowlist = stringArray(input.suite_allowlist, "suite_allowlist", 32);
  if (input.command_allowlist != null) output.command_allowlist = stringArray(input.command_allowlist, "command_allowlist", 64);
  for (const field of ["allowed_frames", "allowed_worlds", "suite_allowlist", "command_allowlist"]) {
    if (input[field] != null && output[field].length === 0) throw new SurfaceProgramValidationError(`empty_${field}`);
  }
  if (output.allowed_worlds?.some((world) => !["MAIN", "ISOLATED"].includes(world))) throw new SurfaceProgramValidationError("invalid_allowed_worlds");
  if (kind === "browser_document") {
    let origin;
    try { origin = new URL(output.origin); } catch { throw new SurfaceProgramValidationError("invalid_origin"); }
    if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.origin !== output.origin) throw new SurfaceProgramValidationError("invalid_origin");
  }
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
  const bindings = validateBindings(input.bindings, allowed);
  validateRuntimeTargetBindings(selected.advertisement.runtime, selected.advertisement.target, bindings);
  const approvalProgram = requiredText(approvalInput.program, "approval_program", 80);
  const alwaysAsk = stringArray(approvalInput.always_ask, "always_ask", 32, 80);
  if (!APPROVAL_PROGRAMS.includes(approvalProgram) || alwaysAsk.some((effect) => !EFFECT_CLASSES.includes(effect)) || new Set(alwaysAsk).size !== alwaysAsk.length) throw new SurfaceProgramValidationError("invalid_approval_policy");
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
    bindings,
    limits: validateLimits(requestedLimits, selected.advertisement.limits),
    approval_policy: Object.freeze({ program: approvalProgram, always_ask: Object.freeze(alwaysAsk) }),
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
  const bindings = validateBindings(envelope.bindings, allowed);
  validateRuntimeTargetBindings(runtime, target, bindings);
  const limits = validateLimits(envelope.limits);
  const approval = closedRecord(envelope.approval_policy, ["program", "always_ask"], "approval_policy");
  const approvalProgram = requiredText(approval.program, "approval_program", 80);
  const alwaysAsk = stringArray(approval.always_ask, "always_ask", 32, 80);
  if (!APPROVAL_PROGRAMS.includes(approvalProgram) || alwaysAsk.some((effect) => !EFFECT_CLASSES.includes(effect)) || new Set(alwaysAsk).size !== alwaysAsk.length) throw new SurfaceProgramValidationError("invalid_approval_policy");
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

const SENSITIVE_TEXT = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk|AIza|ya29)[-._A-Za-z0-9]{8,}|password\s*[:=]|cookie\s*[:=]|authorization\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

function safeSummary(value, label, max = 1000) {
  const text = value == null ? "" : String(value).trim();
  if (text.length > max || SENSITIVE_TEXT.test(text)) throw new SurfaceProgramValidationError(`sensitive_or_invalid_${label}`);
  return text;
}

function validateClaimant(value, envelope, claim) {
  const claimant = closedRecord(value, ["surface_type", "device_id", "client_instance_id"], "claimant");
  const normalized = {
    surface_type: requiredText(claimant.surface_type, "claimant_surface_type", 80),
    device_id: requiredText(claimant.device_id, "claimant_device_id", 120),
    client_instance_id: requiredText(claimant.client_instance_id, "client_instance_id", 160),
  };
  if (normalized.surface_type !== envelope.target.surface_type || normalized.device_id !== claim.device_id || normalized.client_instance_id !== claim.client_instance_id) throw new SurfaceProgramValidationError("claimant_mismatch");
  return Object.freeze(normalized);
}

function receiptDigest(value) {
  const copy = { ...value };
  delete copy.receipt_sha256;
  return sha256(copy);
}

const EVENT_PAYLOAD_FIELDS = Object.freeze({
  accepted: ["proposal_sha256"],
  started: [],
  tool_started: ["capability_id", "tool_call_id", "attempt"],
  tool_finished: ["capability_id", "tool_call_id", "attempt", "status", "receipt_id", "receipt_sha256"],
  approval_required: ["approval_id", "effect_class", "capability_id", "tool_call_id", "attempt", "expires_at"],
  approval_resolved: ["approval_id", "status"],
  progress: ["message", "completed", "total"],
  stopping: ["reason"],
  terminal: ["status", "receipt_id", "receipt_sha256"],
});

function validateSurfaceExecutionEvent(envelope, value, claim, options = {}) {
  validateSurfaceProgramEnvelope(envelope, { nowMs: options.nowMs ?? Date.now(), allowExpired: true });
  const event = closedRecord(value, ["version", "type", "event_id", "execution_id", "sequence", "kind", "occurred_at", "claimant", "payload"], "execution_event");
  if (event.version !== 1 || event.type !== "surface.execution.event") throw new SurfaceProgramValidationError("unsupported_execution_event");
  if (requiredText(event.execution_id, "execution_id", 160) !== envelope.execution_id) throw new SurfaceProgramValidationError("execution_id_mismatch");
  const kind = requiredText(event.kind, "event_kind", 40);
  const fields = EVENT_PAYLOAD_FIELDS[kind];
  if (!fields) throw new SurfaceProgramValidationError("invalid_event_kind");
  const payload = closedRecord(event.payload, fields, "event_payload");
  const occurred = timestamp(event.occurred_at, "occurred_at");
  if (occurred.millis > (options.nowMs ?? Date.now()) + MAX_CLOCK_SKEW_MS) throw new SurfaceProgramValidationError("future_event");
  integer(event.sequence, "event_sequence", 1);
  requiredText(event.event_id, "event_id", 160);
  const claimant = validateClaimant(event.claimant, envelope, claim);
  if (kind === "accepted" && digest(payload.proposal_sha256, "proposal_sha256") !== sha256(envelope)) throw new SurfaceProgramValidationError("proposal_sha256_mismatch");
  if (["tool_started", "tool_finished"].includes(kind)) {
    if (!envelope.catalog.allowed_capability_ids.includes(requiredText(payload.capability_id, "capability_id", 120))) throw new SurfaceProgramValidationError("capability_escalation");
    requiredText(payload.tool_call_id, "tool_call_id", 160); integer(payload.attempt, "attempt", 1);
  }
  if (kind === "tool_finished") {
    if (!["succeeded", "failed", "rejected", "stale_state", "timed_out", "stopped", "indeterminate"].includes(payload.status)) throw new SurfaceProgramValidationError("invalid_tool_status");
    requiredText(payload.receipt_id, "receipt_id", 160); digest(payload.receipt_sha256, "receipt_sha256");
  }
  if (kind === "approval_required") {
    requiredText(payload.approval_id, "approval_id", 160);
    if (!EFFECT_CLASSES.includes(payload.effect_class)) throw new SurfaceProgramValidationError("invalid_effect_class");
    if (!envelope.catalog.allowed_capability_ids.includes(requiredText(payload.capability_id, "capability_id", 120))) throw new SurfaceProgramValidationError("capability_escalation");
    requiredText(payload.tool_call_id, "tool_call_id", 160); integer(payload.attempt, "attempt", 1); timestamp(payload.expires_at, "approval_expires_at");
  }
  if (kind === "approval_resolved") {
    requiredText(payload.approval_id, "approval_id", 160);
    if (!["approved", "denied", "expired", "cancelled"].includes(payload.status)) throw new SurfaceProgramValidationError("invalid_approval_status");
  }
  if (kind === "progress") {
    safeSummary(payload.message, "progress", 500); integer(payload.completed, "completed"); integer(payload.total, "total");
    if (payload.completed > payload.total) throw new SurfaceProgramValidationError("invalid_progress");
  }
  if (kind === "stopping" && !["user_stop", "timeout", "policy_revoked", "surface_shutdown"].includes(payload.reason)) throw new SurfaceProgramValidationError("invalid_stopping_reason");
  if (kind === "terminal") {
    if (!["rejected", "completed", "failed", "timed_out", "stopped", "interrupted", "indeterminate"].includes(payload.status)) throw new SurfaceProgramValidationError("invalid_terminal_status");
    requiredText(payload.receipt_id, "receipt_id", 160); digest(payload.receipt_sha256, "receipt_sha256");
  }
  return Object.freeze({ ...event, claimant, occurred_at: occurred.text, payload: Object.freeze({ ...payload }) });
}

function validateSurfaceProgramToolReceipt(envelope, value, claim, options = {}) {
  validateSurfaceProgramEnvelope(envelope, { nowMs: options.nowMs ?? Date.now(), allowExpired: true });
  const receipt = closedRecord(value, ["version", "type", "receipt_id", "execution_id", "claimant", "tool_call_id", "attempt", "capability_id", "program_sha256", "catalog_sha256", "bindings_sha256", "input_sha256", "pre_state_sha256", "approval_id", "started_at", "finished_at", "status", "result", "post_state_sha256", "previous_receipt_sha256", "receipt_sha256"], "tool_receipt");
  if (receipt.version !== 1 || receipt.type !== "surface.execution.tool_receipt") throw new SurfaceProgramValidationError("unsupported_tool_receipt");
  if (requiredText(receipt.execution_id, "execution_id", 160) !== envelope.execution_id) throw new SurfaceProgramValidationError("execution_id_mismatch");
  const claimant = validateClaimant(receipt.claimant, envelope, claim);
  requiredText(receipt.receipt_id, "receipt_id", 160); requiredText(receipt.tool_call_id, "tool_call_id", 160);
  integer(receipt.attempt, "attempt", 1);
  const capabilityId = requiredText(receipt.capability_id, "capability_id", 120);
  if (!envelope.catalog.allowed_capability_ids.includes(capabilityId)) throw new SurfaceProgramValidationError("capability_escalation");
  const expected = surfaceProgramReceiptBindings(envelope);
  for (const field of Object.keys(expected)) if (digest(receipt[field], field) !== expected[field]) throw new SurfaceProgramValidationError(`${field}_mismatch`);
  digest(receipt.input_sha256, "input_sha256"); digest(receipt.pre_state_sha256, "pre_state_sha256");
  const previous = options.previousToolReceipt || null;
  const expectedPrevious = previous ? previous.receipt_sha256 : null;
  if (receipt.previous_receipt_sha256 !== expectedPrevious) throw new SurfaceProgramValidationError("tool_receipt_chain_mismatch");
  const expectedPreState = previous?.post_state_sha256 || envelope.bindings.state_sha256;
  if (receipt.pre_state_sha256 !== expectedPreState) throw new SurfaceProgramValidationError("pre_state_sha256_mismatch");
  nullableText(receipt.approval_id, "approval_id", 160);
  const started = timestamp(receipt.started_at, "started_at"); const finished = timestamp(receipt.finished_at, "finished_at");
  if (finished.millis < started.millis) throw new SurfaceProgramValidationError("invalid_receipt_timestamps");
  if (!["succeeded", "failed", "rejected", "stale_state", "timed_out", "stopped", "indeterminate"].includes(receipt.status)) throw new SurfaceProgramValidationError("invalid_tool_status");
  const result = closedRecord(receipt.result, ["summary", "data_sha256", "resource_id"], "tool_result");
  safeSummary(result.summary, "tool_result", 1000);
  if (result.data_sha256 != null) digest(result.data_sha256, "data_sha256");
  nullableText(result.resource_id, "resource_id", 240);
  if (receipt.post_state_sha256 != null) digest(receipt.post_state_sha256, "post_state_sha256");
  const claimedDigest = digest(receipt.receipt_sha256, "receipt_sha256");
  if (claimedDigest !== receiptDigest(receipt)) throw new SurfaceProgramValidationError("receipt_sha256_mismatch");
  return Object.freeze({ ...receipt, claimant, started_at: started.text, finished_at: finished.text, result: Object.freeze({ ...result }) });
}

function validateSurfaceProgramTerminalReceipt(envelope, value, claim, options = {}) {
  validateSurfaceProgramEnvelope(envelope, { nowMs: options.nowMs ?? Date.now(), allowExpired: true });
  const receipt = closedRecord(value, ["version", "type", "receipt_id", "execution_id", "session_id", "turn_id", "claimant", "runtime_id", "program_sha256", "catalog_sha256", "bindings_sha256", "started_at", "finished_at", "status", "tool_attempts", "result", "final_state_sha256", "error", "previous_receipt_sha256", "receipt_sha256"], "terminal_receipt");
  if (receipt.version !== 1 || receipt.type !== "surface.execution.receipt") throw new SurfaceProgramValidationError("unsupported_terminal_receipt");
  const statuses = ["rejected", "completed", "failed", "timed_out", "stopped", "interrupted", "indeterminate"];
  if (!statuses.includes(receipt.status)) throw new SurfaceProgramValidationError("invalid_terminal_status");
  for (const field of ["execution_id", "session_id", "turn_id"]) if (requiredText(receipt[field], field, 160) !== envelope[field]) throw new SurfaceProgramValidationError(`${field}_mismatch`);
  const claimant = validateClaimant(receipt.claimant, envelope, claim);
  if (requiredText(receipt.runtime_id, "runtime_id", 80) !== envelope.runtime.runtime_id) throw new SurfaceProgramValidationError("runtime_id_mismatch");
  const expected = surfaceProgramReceiptBindings(envelope);
  for (const field of Object.keys(expected)) if (digest(receipt[field], field) !== expected[field]) throw new SurfaceProgramValidationError(`${field}_mismatch`);
  const started = receipt.started_at == null ? null : timestamp(receipt.started_at, "started_at");
  const finished = timestamp(receipt.finished_at, "finished_at");
  if (started && finished.millis < started.millis) throw new SurfaceProgramValidationError("invalid_receipt_timestamps");
  const attempts = closedRecord(receipt.tool_attempts, ["count", "first_receipt_sha256", "last_receipt_sha256"], "tool_attempts");
  integer(attempts.count, "tool_attempt_count", 0, envelope.limits.tool_calls);
  for (const field of ["first_receipt_sha256", "last_receipt_sha256"]) if (attempts[field] != null) digest(attempts[field], field);
  const toolReceipts = options.toolReceipts || [];
  if (attempts.count !== toolReceipts.length) throw new SurfaceProgramValidationError("tool_attempt_count_mismatch");
  const firstDigest = toolReceipts[0]?.receipt_sha256 || null;
  const lastDigest = toolReceipts[toolReceipts.length - 1]?.receipt_sha256 || null;
  if (attempts.first_receipt_sha256 !== firstDigest || attempts.last_receipt_sha256 !== lastDigest) throw new SurfaceProgramValidationError("tool_attempt_chain_mismatch");
  const result = closedRecord(receipt.result, ["summary", "data_sha256", "artifact_refs"], "terminal_result");
  const summary = safeSummary(result.summary, "terminal_result", Math.min(2000, envelope.limits.result_bytes));
  if (result.data_sha256 != null) digest(result.data_sha256, "data_sha256");
  const artifactRefs = stringArray(result.artifact_refs, "artifact_refs", 32, 129);
  if (artifactRefs.some((ref) => !/^artifact_[A-Za-z0-9_-]{1,120}$/.test(ref))) throw new SurfaceProgramValidationError("invalid_artifact_refs");
  const error = closedRecord(receipt.error, ["code", "message"], "terminal_error");
  nullableText(error.code, "error_code", 120); if (error.message != null) safeSummary(error.message, "error_message", 1000);
  if (receipt.final_state_sha256 != null) digest(receipt.final_state_sha256, "final_state_sha256");
  const expectedTerminalPrevious = toolReceipts[toolReceipts.length - 1]?.receipt_sha256 || null;
  if (receipt.previous_receipt_sha256 !== expectedTerminalPrevious) throw new SurfaceProgramValidationError("terminal_receipt_chain_mismatch");
  const claimedDigest = digest(receipt.receipt_sha256, "receipt_sha256");
  if (claimedDigest !== receiptDigest(receipt)) throw new SurfaceProgramValidationError("receipt_sha256_mismatch");
  requiredText(receipt.receipt_id, "receipt_id", 160);
  return Object.freeze({ ...receipt, claimant: Object.freeze({ ...claimant }), started_at: started?.text || null, finished_at: finished.text });
}

module.exports = {
  PROGRAM_TOOL, MAX_SOURCE_BYTES, SurfaceProgramValidationError, canonicalJson, sha256,
  sanitizeExecutionRuntime, sanitizeExecutionRuntimes, selectSurfaceRuntime,
  createSurfaceProgramEnvelope, validateSurfaceProgramEnvelope, surfaceProgramReceiptBindings,
  receiptDigest, validateSurfaceExecutionEvent, validateSurfaceProgramToolReceipt,
  validateSurfaceProgramTerminalReceipt,
};
