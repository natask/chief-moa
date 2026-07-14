"use strict";

const crypto = require("node:crypto");

const SHA = /^[a-f0-9]{40}$/;

function createPreviewResourcePlan(input = {}) {
  const commit = String(input.commit_sha || "").toLowerCase();
  if (!SHA.test(commit)) throw new Error("commit_sha must be a full lowercase Git SHA");
  const requestId = safeId(input.request_id, "request_id");
  const active = requireActiveIdentity(input.active_identity);
  const suffix = crypto.createHash("sha256").update(`${requestId}:${commit}`).digest("hex").slice(0, 12);
  const plan = Object.freeze({
    request_id: requestId,
    commit_sha: commit,
    image_ref: `${imageRepository(input.image_repository)}@sha256:${imageDigest(input.image_digest)}`,
    database_image_ref: `${imageRepository(input.database_image_repository)}@sha256:${imageDigest(input.database_image_digest)}`,
    project: `moa-preview-${suffix}`,
    hostname: `preview-${suffix}.${required(input.preview_domain, "preview_domain")}`,
    database: `moa_preview_${suffix}`,
    queue: `preview-queue-${suffix}`,
    queue_status: "disabled-but-isolated",
    storage: `preview-storage-${suffix}`,
    worker_pool: `preview-workers-${suffix}`,
    worker_pool_status: "disabled-but-isolated",
  });
  assertNoActiveCollision(plan, active);
  return plan;
}

function assertNoActiveCollision(plan, activeIdentity = {}) {
  const active = requireActiveIdentity(activeIdentity);
  for (const field of ["project", "hostname", "database", "queue", "storage", "worker_pool"]) {
    if (active[field] && plan[field] === active[field]) throw new Error(`preview ${field} collides with active identity`);
  }
  return true;
}

function requireActiveIdentity(value) {
  const active = normalizeIdentity(value);
  const values = Object.values(active);
  if (values.some((item) => !item)) throw new Error("all active baseline identities are required");
  if (new Set(values).size !== values.length) throw new Error("active baseline identities must be mutually distinct");
  return active;
}

function normalizeIdentity(value) {
  const out = {};
  for (const field of ["project", "hostname", "database", "queue", "storage", "worker_pool"]) out[field] = String(value?.[field] || "");
  return out;
}

function safeId(value, name) {
  const text = required(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(text)) throw new Error(`${name} contains unsupported characters`);
  return text;
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`${name} is required and must be a single line`);
  return text;
}

function imageRepository(value) {
  const text = required(value, "image_repository");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,255}$/.test(text) || text.includes("@")) throw new Error("image_repository is malformed");
  return text;
}

function imageDigest(value) {
  const text = required(value, "image_digest").replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("image_digest must be a sha256 digest");
  return text;
}

module.exports = { createPreviewResourcePlan, assertNoActiveCollision };
