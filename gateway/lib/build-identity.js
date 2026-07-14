"use strict";

const UNKNOWN = "unknown";

function buildIdentity(env = process.env) {
  return Object.freeze({
    git_sha: valid(env.MOA_BUILD_SHA, /^[0-9a-f]{7,64}$/i),
    git_ref: valid(env.MOA_BUILD_REF, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
    built_at: timestamp(env.MOA_BUILD_TIME),
  });
}

function valid(value, pattern) {
  const candidate = String(value || "").trim();
  return pattern.test(candidate) ? candidate : UNKNOWN;
}

function timestamp(value) {
  const candidate = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(candidate) || Number.isNaN(Date.parse(candidate))) return UNKNOWN;
  return new Date(candidate).toISOString();
}

module.exports = { buildIdentity };
