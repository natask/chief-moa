const SURFACE_PROGRAM_TOOL = "surface.program.execute";
const SURFACE_PROGRAM_RUNTIME_ID = "browser.javascript.v1";
const SURFACE_PROGRAM_CATALOG_VERSION = 1;
const MAX_SOURCE_BYTES = 64 * 1024;

const CAPABILITY_BASE = [
  { name: "browser.page.snapshot", description: "Read a bounded snapshot of the bound page.", risk: "read_only", approval: "none" },
  { name: "browser.page.query_elements", description: "Find bounded elements in the bound page by CSS selector.", risk: "read_only", approval: "none" },
  { name: "browser.page.get_text", description: "Read bounded text or input value from the bound page.", risk: "read_only", approval: "none" },
  { name: "browser.page.wait", description: "Wait locally for a selector and optional text in the bound page.", risk: "read_only", approval: "none" },
  { name: "browser.tab.get", description: "Read metadata for the exact bound tab.", risk: "read_only", approval: "none" },
  { name: "browser.page.click", description: "Click an element returned by queryElements in the bound page.", risk: "browser_local_action", approval: "local_policy" },
  { name: "browser.page.fill", description: "Replace text in an element returned by queryElements in the bound page.", risk: "browser_local_action", approval: "local_policy" },
  { name: "browser.page.type", description: "Append text in an element returned by queryElements in the bound page.", risk: "browser_local_action", approval: "local_policy" },
];
const CAPABILITIES = Object.freeze(CAPABILITY_BASE.map((entry) => Object.freeze({
  ...entry,
  input_schema: entry.name === "browser.page.query_elements" ? { type: "object", properties: { selector: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["selector"], additionalProperties: false }
    : entry.name === "browser.page.get_text" ? { type: "object", properties: { selector: { type: "string", maxLength: 500 } }, required: ["selector"], additionalProperties: false }
      : entry.name === "browser.page.wait" ? { type: "object", properties: { selector: { type: "string", maxLength: 500 }, text: { type: "string", maxLength: 500 }, timeout_ms: { type: "integer", minimum: 1, maximum: 5000 } }, required: ["selector"], additionalProperties: false }
        : new Set(["browser.page.click", "browser.page.fill", "browser.page.type"]).has(entry.name) ? { type: "object", properties: { element_id: { type: "string" }, text: { type: "string", maxLength: 4000 } }, required: entry.name === "browser.page.click" ? ["element_id"] : ["element_id", "text"], additionalProperties: false }
          : { type: "object", properties: {}, additionalProperties: false },
  output_schema: { type: ["object", "array", "string", "number", "boolean", "null"] },
  effect_class: entry.risk === "read_only" ? "read" : "reversible_page_local",
  concurrency: entry.risk === "read_only" ? "parallel_read" : "serialized_write",
  idempotency: entry.risk === "read_only" ? "safe_retry" : "never_automatic_retry",
  restore: null,
})));

const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((entry) => [entry.name, entry]));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

async function sha256(value, subtle = globalThis.crypto?.subtle) {
  if (!subtle?.digest) throw new Error("sha256_unavailable");
  const input = typeof value === "string" ? value : canonicalJson(value);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${name}`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`unknown_${name}_field`);
}

function identifier(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`invalid_${name}`);
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid_${name}`);
  return value;
}

function exactOrigin(value) {
  if (typeof value !== "string" || value.length > 2000) throw new Error("invalid_origin");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_origin"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value) throw new Error("invalid_origin");
  return parsed.origin;
}

async function browserProgramRuntimeManifest(deviceId = "") {
  const catalog = { version: SURFACE_PROGRAM_CATALOG_VERSION, capability_ids: CAPABILITIES.map((entry) => entry.name) };
  const now = Date.now();
  return {
    version: 1,
    type: "surface.runtime.advertised",
    advertisement_id: `sra_${crypto.randomUUID()}`,
    target: { surface_type: "browser_extension", device_id: deviceId },
    runtime: { runtime_id: SURFACE_PROGRAM_RUNTIME_ID, language: "javascript", bridge_version: 1, entrypoint: "main" },
    catalog: { ...catalog, sha256: await sha256({ version: SURFACE_PROGRAM_CATALOG_VERSION, capabilities: CAPABILITIES }) },
    limits: { source_bytes: MAX_SOURCE_BYTES, wall_ms: 30_000, memory_bytes: 32 * 1024 * 1024, tool_calls: 100, parallel_calls: 8, result_bytes: 64 * 1024, log_bytes: 32 * 1024 },
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 90_000).toISOString(),
  };
}

async function validateSurfaceProgramEnvelope(input, { nowMs = Date.now(), expectedDeviceId, runtime } = {}) {
  exactKeys(input, ["version", "type", "execution_id", "session_id", "turn_id", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy", "idempotency_key", "issued_at", "expires_at"], "envelope");
  if (input.version !== 1 || input.type !== "surface.execution.proposed") throw new Error("unsupported_envelope");
  identifier(input.execution_id, "execution_id");
  identifier(input.session_id, "session_id");
  identifier(input.turn_id, "turn_id");
  identifier(input.idempotency_key, "idempotency_key");

  exactKeys(input.target, ["device_id", "surface_type"], "target");
  if (input.target.surface_type !== "browser_extension") throw new Error("target_surface_mismatch");
  identifier(input.target.device_id, "target_device_id");
  if (expectedDeviceId && input.target.device_id !== expectedDeviceId) throw new Error("target_device_mismatch");

  exactKeys(input.runtime, ["runtime_id", "language", "bridge_version", "entrypoint"], "runtime");
  if (input.runtime.runtime_id !== SURFACE_PROGRAM_RUNTIME_ID || input.runtime.language !== "javascript" || input.runtime.bridge_version !== 1 || input.runtime.entrypoint !== "main") throw new Error("runtime_mismatch");

  exactKeys(input.program, ["source", "sha256"], "program");
  if (typeof input.program.source !== "string" || !input.program.source.trim()) throw new Error("invalid_program_source");
  const sourceBytes = utf8Bytes(input.program.source);
  if (sourceBytes > MAX_SOURCE_BYTES || !SHA_PATTERN.test(input.program.sha256 || "") || await sha256(input.program.source) !== input.program.sha256) throw new Error("program_hash_mismatch");

  const expectedRuntime = runtime || await browserProgramRuntimeManifest();
  exactKeys(input.catalog, ["version", "sha256", "allowed_capability_ids"], "catalog");
  if (input.catalog.version !== expectedRuntime.catalog.version || input.catalog.sha256 !== expectedRuntime.catalog.sha256) throw new Error("runtime_catalog_mismatch");
  if (!Array.isArray(input.catalog.allowed_capability_ids) || input.catalog.allowed_capability_ids.length < 1) throw new Error("invalid_allowed_capability_ids");
  const allowedCapabilityIds = input.catalog.allowed_capability_ids.map(String);
  if (new Set(allowedCapabilityIds).size !== allowedCapabilityIds.length || allowedCapabilityIds.some((id) => !CAPABILITY_BY_ID.has(id))) throw new Error("invalid_allowed_capability_ids");

  exactKeys(input.bindings, ["kind", "tab_id", "window_id", "frame_id", "origin", "document_id", "page_epoch", "observation_id", "observation_sha256", "state_sha256"], "bindings");
  if (input.bindings.kind !== "browser_document") throw new Error("binding_kind_mismatch");
  boundedInteger(input.bindings.tab_id, "tab_id", 0, Number.MAX_SAFE_INTEGER);
  boundedInteger(input.bindings.window_id, "window_id", 0, Number.MAX_SAFE_INTEGER);
  if (input.bindings.frame_id !== 0) throw new Error("invalid_frame_id");
  exactOrigin(input.bindings.origin);
  identifier(input.bindings.document_id, "document_id");
  boundedInteger(input.bindings.page_epoch, "page_epoch", 0, Number.MAX_SAFE_INTEGER);
  identifier(input.bindings.observation_id, "observation_id");
  if (!SHA_PATTERN.test(input.bindings.observation_sha256 || "")) throw new Error("invalid_observation_sha256");
  if (!SHA_PATTERN.test(input.bindings.state_sha256 || "")) throw new Error("invalid_state_sha256");

  exactKeys(input.limits, ["source_bytes", "wall_ms", "memory_bytes", "tool_calls", "parallel_calls", "result_bytes", "log_bytes"], "limits");
  if (input.limits.source_bytes !== sourceBytes) throw new Error("source_bytes_mismatch");
  boundedInteger(input.limits.wall_ms, "wall_ms", 100, 30_000);
  boundedInteger(input.limits.memory_bytes, "memory_bytes", 1024 * 1024, 64 * 1024 * 1024);
  boundedInteger(input.limits.tool_calls, "tool_calls", 1, 100);
  boundedInteger(input.limits.parallel_calls, "parallel_calls", 1, Math.min(16, input.limits.tool_calls));
  boundedInteger(input.limits.result_bytes, "result_bytes", 1024, 64 * 1024);
  boundedInteger(input.limits.log_bytes, "log_bytes", 0, 64 * 1024);

  exactKeys(input.approval_policy, ["program", "always_ask"], "approval_policy");
  if (input.approval_policy.program !== "preauthorized" || !Array.isArray(input.approval_policy.always_ask)) throw new Error("invalid_approval_policy");
  if (input.approval_policy.always_ask.length) throw new Error("interactive_program_approval_unavailable");

  const issuedMs = Date.parse(input.issued_at);
  const expiresMs = Date.parse(input.expires_at);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs || expiresMs - issuedMs > 5 * 60_000 || nowMs >= expiresMs) throw new Error("invalid_expiry");

  return Object.freeze({ envelope: input, allowedCapabilityIds: Object.freeze(allowedCapabilityIds), issuedMs, expiresMs, sourceBytes });
}

function capabilityDefinition(capabilityId) {
  return CAPABILITY_BY_ID.get(capabilityId) || null;
}

export {
  CAPABILITIES,
  MAX_SOURCE_BYTES,
  SURFACE_PROGRAM_CATALOG_VERSION,
  SURFACE_PROGRAM_RUNTIME_ID,
  SURFACE_PROGRAM_TOOL,
  browserProgramRuntimeManifest,
  canonicalJson,
  capabilityDefinition,
  sha256,
  utf8Bytes,
  validateSurfaceProgramEnvelope,
};
