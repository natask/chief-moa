"use strict";

const crypto = require("node:crypto");

const ENVELOPE_VERSION = 1;
const MAX_QUEUE_SIZE = 256;
const MAX_BATCH_SIZE = 32;
const MAX_ATTRIBUTE_COUNT = 16;
const MAX_ATTRIBUTE_VALUE_LENGTH = 96;
const DEFAULT_EXPORT_TIMEOUT_MS = 2_000;
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

function createSemanticEnvelope(input = {}, options = {}) {
  const name = normalizeEnum(input.name, ALLOWED_EVENT_NAMES, "event name");
  const surface = normalizeEnum(input.surface, ALLOWED_SURFACES, "surface");
  const now = options.now instanceof Date ? options.now : new Date();
  return Object.freeze({
    schema: "moa.semantic_telemetry",
    schema_version: ENVELOPE_VERSION,
    event_id: normalizeOpaqueId(input.event_id) || `tel_${crypto.randomUUID()}`,
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
  let exporting = false;
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
    if (scheduled || exporting) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void pump();
    });
  }

  async function pump() {
    if (exporting) return;
    exporting = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, maxBatchSize);
        try {
          await withTimeout(options.exportBatch(batch), exportTimeoutMs);
        } catch {
          exportFailures += 1;
        }
      }
    } finally {
      exporting = false;
      if (queue.length) schedule();
    }
  }

  function stats() {
    return Object.freeze({ accepted, dropped, export_failures: exportFailures, queued: queue.length, exporting });
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
    version: boundedText(value.version, 64, "release.version"),
    build_id: boundedText(value.build_id || value.buildId, 96, "release.build_id"),
  });
}

function normalizeCorrelation(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new TypeError("correlation must be an object");
  const output = {};
  for (const key of ["trace_id", "parent_event_id", "canary_id"]) {
    const normalized = normalizeOpaqueId(value[key]);
    if (normalized) output[key] = normalized;
  }
  return Object.freeze(output);
}

function normalizeOpaqueId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(text) || TOKEN_LIKE_VALUE_PATTERN.test(text)) {
    throw new TypeError("invalid opaque correlation id");
  }
  return text;
}

function normalizeTimestamp(value, fallback) {
  const parsed = value ? new Date(value) : fallback;
  if (Number.isNaN(parsed.getTime())) throw new TypeError("invalid telemetry timestamp");
  return parsed.toISOString();
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

function withTimeout(value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("telemetry export timed out")), timeoutMs);
    timer.unref?.();
    Promise.resolve(value).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

module.exports = {
  ALLOWED_ATTRIBUTES,
  ALLOWED_EVENT_NAMES,
  ENVELOPE_VERSION,
  MAX_ATTRIBUTE_COUNT,
  createAsyncTelemetryExporter,
  createSemanticEnvelope,
  metricDimensions,
};
