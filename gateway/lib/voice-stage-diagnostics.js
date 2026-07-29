"use strict";

// Content-bounded normalizers for voice provider-event diagnostics.
//
// Extracted from voice-session-server.js: these are pure, own no session state,
// and are shared by the session server and the observer plane. Everything here
// exists to keep a diagnostic record small, single-line, and free of anything a
// provider might have stuffed into an error or a details bag.

const PROVIDER_EVENT_ERROR_MAX_CHARS = 240;
const PROVIDER_EVENT_VALUE_MAX_CHARS = 400;

function normalizeStageName(stage) {
  const value = String(stage || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return value || "unknown";
}

function sanitizeStageDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = String(rawKey || "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
      .slice(0, 80);
    if (!key || rawValue === undefined || typeof rawValue === "function") {
      continue;
    }
    if (key === "error" || key === "error_summary") {
      output[key] = cleanErrorSummary(rawValue);
      continue;
    }
    if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue)) {
        output[key] = Math.max(0, Math.round(rawValue));
      }
      continue;
    }
    if (typeof rawValue === "boolean") {
      output[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue)) {
      output[key] = rawValue
        .slice(0, 8)
        .map((item) => String(item || "").replace(/[\r\n]+/g, " ").slice(0, 80));
      continue;
    }
    if (rawValue && typeof rawValue === "object") {
      output[key] = JSON.stringify(rawValue).replace(/[\r\n]+/g, " ").slice(0, PROVIDER_EVENT_VALUE_MAX_CHARS);
      continue;
    }
    output[key] = String(rawValue || "").replace(/[\r\n]+/g, " ").slice(0, PROVIDER_EVENT_VALUE_MAX_CHARS);
  }
  return output;
}

function normalizeDurationMs(value, startedAtMs) {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(explicit);
  }
  const started = Number(startedAtMs);
  if (Number.isFinite(started) && started > 0) {
    return Math.max(0, Date.now() - started);
  }
  return 0;
}

function elapsedMsSince(iso) {
  const started = Date.parse(iso || "");
  if (!Number.isFinite(started)) {
    return 0;
  }
  return Math.max(0, Date.now() - started);
}

function sanitizeStageTimings(timings) {
  if (!timings || typeof timings !== "object" || Array.isArray(timings)) {
    return {};
  }
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(timings)) {
    const key = String(rawKey || "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
      .slice(0, 80);
    const value = Number(rawValue);
    if (key && Number.isFinite(value) && value >= 0) {
      output[key] = Math.round(value);
    }
  }
  return output;
}

function cleanErrorSummary(error) {
  return cleanError(error).slice(0, PROVIDER_EVENT_ERROR_MAX_CHARS);
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function turnErrorReason(error) {
  const message = cleanError(error).toLowerCase();
  if (error?.name === "AbortError" || message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("no speech") || message.includes("empty audio")) {
    return "stt_empty";
  }
  return "processing_error";
}

module.exports = {
  PROVIDER_EVENT_ERROR_MAX_CHARS,
  PROVIDER_EVENT_VALUE_MAX_CHARS,
  cleanError,
  cleanErrorSummary,
  elapsedMsSince,
  normalizeDurationMs,
  normalizeStageName,
  sanitizeStageDetails,
  sanitizeStageTimings,
  turnErrorReason,
};
