"use strict";

const crypto = require("node:crypto");

const ENVELOPE_VERSION = 1;
const MAX_QUEUE_SIZE = 256;
const MAX_BATCH_SIZE = 32;
const MAX_ATTRIBUTE_COUNT = 16;
const MAX_ATTRIBUTE_VALUE_LENGTH = 96;
const DEFAULT_EXPORT_TIMEOUT_MS = 2_000;
const OPAQUE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep release.version deliberately narrower than full SemVer. Free-form
// prerelease/build metadata can smuggle identity or session material; build
// correlation belongs in the separately validated opaque build_id.
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ALLOWED_SURFACES = new Set(["gateway", "android", "browser_extension", "website", "worker"]);
const ALLOWED_EVENT_NAMES = new Set([
  "canary.started",
  "canary.received",
  "request.completed",
  "voice.stage.completed",
  "agent.run.transitioned",
  "client.crash.observed",
]);
const ALLOWED_ATTRIBUTES = new Set([
  "environment",
  "operation",
  "outcome",
  "pipeline",
  "provider_family",
  "release_channel",
  "stage",
  "status_class",
  "transport",
]);
const ALLOWED_ATTRIBUTE_VALUES = Object.freeze({
  environment: new Set(["local", "test", "preview", "staging", "production"]),
  operation: new Set(["canary", "http_request", "voice_stage", "agent_run", "client_crash"]),
  outcome: new Set(["ok", "error", "cancelled", "dropped", "timeout"]),
  pipeline: new Set(["cascaded", "legacy_live", "unknown"]),
  provider_family: new Set(["google", "openai", "anthropic", "local", "other", "unknown"]),
  release_channel: new Set(["local", "preview", "internal", "beta", "stable"]),
  stage: new Set(["capture", "stt", "reasoning", "tts", "playback", "storage", "dispatch"]),
  status_class: new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "none"]),
  transport: new Set(["http", "https", "websocket", "worker", "local"]),
});
const FORBIDDEN_KEY_PATTERN = /(audio|transcript|prompt|content|screen|page|token|secret|authorization|cookie|financial|card|email|phone|user.?id|tenant.?id|session.?id|turn.?id)/i;
const TOKEN_LIKE_VALUE_PATTERN = /(?:bearer\s+|(?:api|access|refresh|session)[_-]?token\s*[:=]|sk-[a-z0-9_-]{12,}|eyJ[a-zA-Z0-9_-]{12,}\.)/i;
const OPAQUE_ID_PREFIXES = Object.freeze({
  build_id: "build",
  canary_id: "canary",
  event_id: "tel",
  parent_event_id: "tel",
  trace_id: "trace",
});

function createSemanticEnvelope(input = {}, options = {}) {
  const name = normalizeEnum(input.name, ALLOWED_EVENT_NAMES, "event name");
  const surface = normalizeEnum(input.surface, ALLOWED_SURFACES, "surface");
  const now = options.now instanceof Date ? options.now : new Date();
  return Object.freeze({
    schema: "moa.semantic_telemetry",
    schema_version: ENVELOPE_VERSION,
    event_id: normalizeOpaqueId(input.event_id, "event_id", OPAQUE_ID_PREFIXES.event_id, { generateWhenMissing: true }),
    occurred_at: normalizeTimestamp(input.occurred_at, now),
    name,
    surface,
    release: normalizeRelease(input.release),
    correlation: normalizeCorrelation(input.correlation),
    attributes: normalizeAttributes(input.attributes),
  });
}

function metricDimensions(envelope) {
  const safe = createSemanticEnvelope(envelope, { now: new Date(envelope?.occurred_at || Date.now()) });
  return Object.freeze({ surface: safe.surface, ...safe.attributes });
}

function createAsyncTelemetryExporter(options = {}) {
  if (typeof options.exportBatch !== "function") throw new TypeError("exportBatch is required");
  const maxQueueSize = boundedInteger(options.maxQueueSize, 1, 4096, MAX_QUEUE_SIZE);
  const maxBatchSize = boundedInteger(options.maxBatchSize, 1, 256, MAX_BATCH_SIZE);
  const exportTimeoutMs = boundedInteger(options.exportTimeoutMs, 1, 60_000, DEFAULT_EXPORT_TIMEOUT_MS);
  const queue = [];
  let activeExport = null;
  let circuitOpen = false;
  let pumping = false;
  let scheduled = false;
  let accepted = 0;
  let dropped = 0;
  let exportFailures = 0;

  function emit(input) {
    let envelope;
    try {
      envelope = createSemanticEnvelope(input);
    } catch {
      dropped += 1;
      return false;
    }
    if (queue.length >= maxQueueSize) {
      dropped += 1;
      return false;
    }
    queue.push(envelope);
    accepted += 1;
    schedule();
    return true;
  }

  function schedule() {
    if (scheduled || pumping || activeExport || circuitOpen) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void pump();
    });
  }

  async function pump() {
    if (pumping || activeExport || circuitOpen) return;
    pumping = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, maxBatchSize);
        const attempt = startExportBatch(options.exportBatch, batch);
        activeExport = attempt;
        try {
          await awaitExportAttempt(attempt, exportTimeoutMs);
        } catch (error) {
          exportFailures += 1;
          if (error?.code === "TELEMETRY_EXPORT_TIMEOUT") {
            circuitOpen = true;
            attempt.settled.finally(() => {
              if (activeExport === attempt) activeExport = null;
              circuitOpen = false;
              schedule();
            });
            break;
          }
        } finally {
          if (!circuitOpen && activeExport === attempt) activeExport = null;
        }
      }
    } finally {
      pumping = false;
      if (queue.length) schedule();
    }
  }

  function stats() {
    return Object.freeze({
      accepted,
      active_exports: activeExport ? 1 : 0,
      circuit_open: circuitOpen,
      dropped,
      export_failures: exportFailures,
      exporting: Boolean(activeExport),
      queued: queue.length,
    });
  }

  return { emit, stats };
}

function normalizeAttributes(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new TypeError("attributes must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_ATTRIBUTE_COUNT) throw new RangeError("too many telemetry attributes");
  const output = {};
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (FORBIDDEN_KEY_PATTERN.test(key) || !ALLOWED_ATTRIBUTES.has(key)) {
      throw new TypeError(`telemetry attribute is not allowlisted: ${key || "(empty)"}`);
    }
    if (!["string", "number", "boolean"].includes(typeof rawValue)) throw new TypeError(`invalid telemetry attribute: ${key}`);
    const normalized = String(rawValue).trim().slice(0, MAX_ATTRIBUTE_VALUE_LENGTH);
    if (TOKEN_LIKE_VALUE_PATTERN.test(normalized)) throw new TypeError(`token-like telemetry attribute rejected: ${key}`);
    if (!ALLOWED_ATTRIBUTE_VALUES[key]?.has(normalized)) throw new TypeError(`unsupported telemetry attribute value: ${key}`);
    output[key] = normalized;
  }
  return Object.freeze(output);
}

function normalizeRelease(value) {
  if (!isPlainObject(value)) throw new TypeError("release is required");
  return Object.freeze({
    version: normalizeReleaseVersion(value.version),
    build_id: normalizeOpaqueId(value.build_id || value.buildId, "release.build_id", OPAQUE_ID_PREFIXES.build_id, { generateWhenMissing: true }),
  });
}

function normalizeCorrelation(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new TypeError("correlation must be an object");
  const output = {};
  for (const [key, prefix] of Object.entries({
    trace_id: OPAQUE_ID_PREFIXES.trace_id,
    parent_event_id: OPAQUE_ID_PREFIXES.parent_event_id,
    canary_id: OPAQUE_ID_PREFIXES.canary_id,
  })) {
    const normalized = normalizeOpaqueId(value[key], key, prefix);
    if (normalized) output[key] = normalized;
  }
  return Object.freeze(output);
}

function normalizeOpaqueId(value, label, prefix, options = {}) {
  const text = String(value || "").trim();
  if (!text) {
    if (options.generateWhenMissing) return generateOpaqueId(prefix);
    return "";
  }
  const expectedPrefix = `${prefix}_`;
  if (
    text.length > 96
    || !text.startsWith(expectedPrefix)
    || TOKEN_LIKE_VALUE_PATTERN.test(text)
    || !OPAQUE_UUID_PATTERN.test(text.slice(expectedPrefix.length))
  ) {
    throw new TypeError(`invalid ${label}; expected ${prefix}_<uuid>`);
  }
  return text.toLowerCase();
}

function normalizeTimestamp(value, fallback) {
  const parsed = value ? new Date(value) : fallback;
  if (Number.isNaN(parsed.getTime())) throw new TypeError("invalid telemetry timestamp");
  return parsed.toISOString();
}

function normalizeReleaseVersion(value) {
  const text = String(value || "").trim();
  if (!SEMVER_PATTERN.test(text) || TOKEN_LIKE_VALUE_PATTERN.test(text)) {
    throw new TypeError("invalid release.version; expected semver");
  }
  return text;
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw new TypeError(`unsupported ${label}: ${normalized || "(empty)"}`);
  return normalized;
}

function boundedText(value, limit, label) {
  const text = String(value || "").trim();
  if (!text || text.length > limit || TOKEN_LIKE_VALUE_PATTERN.test(text)) throw new TypeError(`invalid ${label}`);
  return text;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function generateOpaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function startExportBatch(exportBatch, batch) {
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => exportBatch(batch, { signal: controller.signal }));
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  return { controller, promise, settled };
}

function awaitExportAttempt(attempt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      attempt.controller.abort(createAbortError("telemetry export timed out"));
      reject(createTimeoutError());
    }, timeoutMs);
    timer.unref?.();
    attempt.promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTimeoutError() {
  const error = new Error("telemetry export timed out");
  error.code = "TELEMETRY_EXPORT_TIMEOUT";
  return error;
}

module.exports = {
  ALLOWED_ATTRIBUTES,
  ALLOWED_EVENT_NAMES,
  ENVELOPE_VERSION,
  MAX_ATTRIBUTE_COUNT,
  createAsyncTelemetryExporter,
  createSemanticEnvelope,
  generateOpaqueId,
  metricDimensions,
};
