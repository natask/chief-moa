"use strict";

const crypto = require("node:crypto");

const PUBLIC_SCHEMA = "moa-forward-recovery-manifest/v1";
const STORED_KIND = "android_forward_recovery";
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

class ForwardRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ForwardRecoveryError";
    this.code = code;
  }
}

async function projectForwardRecoveryManifest(input = {}) {
  const receipt = normalizeReceipt(input.receipt);
  const expected = normalizeExpected(input.expected);
  assertFresh(receipt, expected);
  const inspectArtifact = requiredFunction(input.inspectArtifact, "inspectArtifact");
  const observed = await inspectArtifact(receipt);
  assertArtifactAvailable(receipt.artifact, observed);

  const applicationId = cleanId(input.application_id, "application_id");
  const deviceId = cleanId(input.device_id, "device_id");
  const downloadUrl = cleanDownloadUrl(input.download_url);
  const target = Object.freeze({
    channel: receipt.target_predecessor.channel,
    bundle_id: receipt.target_predecessor.bundle_id,
    release_id: receipt.target_predecessor.release_id,
    sequence: receipt.target_predecessor.sequence,
    source_commit: receipt.source_commit,
    artifact_sha256: receipt.target_predecessor.artifact_sha256,
    version_code: receipt.target_predecessor.artifact_version_code,
  });
  const predecessor = Object.freeze({
    bundle_id: receipt.replaces.bundle_id,
    release_id: receipt.replaces.release_id,
    source_commit: receipt.replaces.source_commit,
    artifact_sha256: receipt.replaces.artifact_sha256,
    version_code: receipt.replaces.artifact_version_code,
  });
  return Object.freeze({
    schema_version: PUBLIC_SCHEMA,
    recovery_id: receipt.recovery_release_id,
    application_id: applicationId,
    device_id: deviceId,
    target,
    predecessor,
    parents: Object.freeze({ stable: receipt.parent_stable, trial: receipt.parent_trial }),
    artifact: Object.freeze({
      release_id: receipt.recovery_release_id,
      version_code: receipt.artifact.version_code,
      version_name: receipt.artifact.version_name,
      package_name: receipt.artifact.app_id,
      sha256: receipt.artifact.sha256,
      size_bytes: receipt.artifact.size_bytes,
      signer_sha256: receipt.artifact.signer_sha256,
      source_commit: receipt.source_commit,
      built_at: receipt.built_at,
      download_url: downloadUrl,
    }),
    provenance: Object.freeze({
      builder_commit: receipt.builder_commit,
      target_bundle_id: receipt.target_predecessor.bundle_id,
      target_release_id: receipt.target_predecessor.release_id,
      target_source_commit: receipt.source_commit,
      predecessor_release_id: receipt.replaces.release_id,
      parent_stable_bundle_id: receipt.parent_stable.bundle_id,
      parent_trial_bundle_id: receipt.parent_trial?.bundle_id || null,
      provenance_sha256: receipt.provenance_sha256,
    }),
  });
}

function normalizeReceipt(value) {
  const receipt = exactObject(value, [
    "schema_version", "kind", "recovery_release_id", "source_commit", "builder_commit",
    "built_at", "download_path", "artifact", "target_predecessor", "replaces",
    "parent_stable", "parent_trial", "provenance_sha256",
  ], "receipt");
  if (receipt.schema_version !== 1 || receipt.kind !== STORED_KIND) {
    invalid("unsupported recovery receipt");
  }
  const normalized = {
    schema_version: 1,
    kind: STORED_KIND,
    recovery_release_id: cleanId(receipt.recovery_release_id, "recovery_release_id"),
    source_commit: cleanCommit(receipt.source_commit, "source_commit"),
    builder_commit: cleanCommit(receipt.builder_commit, "builder_commit"),
    built_at: cleanTime(receipt.built_at),
    download_path: cleanDownloadPath(receipt.download_path),
    artifact: normalizeArtifact(receipt.artifact),
    target_predecessor: normalizeTarget(receipt.target_predecessor),
    replaces: normalizeReplaces(receipt.replaces),
    parent_stable: normalizeParent(receipt.parent_stable, "parent_stable"),
    parent_trial: receipt.parent_trial == null ? null : normalizeParent(receipt.parent_trial, "parent_trial"),
    provenance_sha256: cleanDigest(receipt.provenance_sha256, "provenance_sha256"),
  };
  if (normalized.artifact.apk !== "moa-assistant.apk") {
    invalid("artifact.apk must use the recovery artifact basename");
  }
  if (normalized.artifact.version_code <= normalized.replaces.artifact_version_code) {
    stale("recovery version_code must be higher than the replaced build");
  }
  if (normalized.artifact.version_code <= normalized.target_predecessor.artifact_version_code) {
    stale("recovery version_code must be higher than the recovery target build");
  }
  const targetParent = normalized.target_predecessor.channel === "stable"
    ? normalized.parent_stable : normalized.parent_trial;
  if (!targetParent || canonicalJson(targetParent) !== canonicalJson({
    bundle_id: normalized.target_predecessor.bundle_id,
    release_id: normalized.target_predecessor.release_id,
    sequence: normalized.target_predecessor.sequence,
  })) stale("recovery target does not match its confirmed parent binding");
  const replacementIsParent = [normalized.parent_stable, normalized.parent_trial].some((parent) => (
    parent && parent.bundle_id === normalized.replaces.bundle_id
      && parent.release_id === normalized.replaces.release_id
  ));
  if (!replacementIsParent) stale("replaced release does not match a confirmed parent binding");
  if (provenanceDigest(normalized) !== normalized.provenance_sha256) {
    stale("recovery provenance digest does not match the receipt");
  }
  return deepFreeze(normalized);
}

function normalizeExpected(value) {
  const expected = exactObject(value, [
    "source_commit", "target_predecessor", "replaces", "parent_stable", "parent_trial",
  ], "expected");
  return deepFreeze({
    source_commit: cleanCommit(expected.source_commit, "expected.source_commit"),
    target_predecessor: normalizeTarget(expected.target_predecessor, "expected.target_predecessor"),
    replaces: normalizeReplaces(expected.replaces, "expected.replaces"),
    parent_stable: normalizeParent(expected.parent_stable, "expected.parent_stable"),
    parent_trial: expected.parent_trial == null
      ? null : normalizeParent(expected.parent_trial, "expected.parent_trial"),
  });
}

function normalizeArtifact(value) {
  const artifact = exactObject(value, [
    "apk", "app_id", "version_code", "version_name", "sha256", "size_bytes", "signer_sha256",
  ], "artifact");
  return {
    apk: cleanId(artifact.apk, "artifact.apk"),
    app_id: cleanPackage(artifact.app_id),
    version_code: cleanInteger(artifact.version_code, "artifact.version_code", 1),
    version_name: cleanText(artifact.version_name, "artifact.version_name", 80),
    sha256: cleanDigest(artifact.sha256, "artifact.sha256"),
    size_bytes: cleanInteger(artifact.size_bytes, "artifact.size_bytes", 1),
    signer_sha256: cleanDigest(artifact.signer_sha256, "artifact.signer_sha256"),
  };
}

function normalizeTarget(value, label = "target_predecessor") {
  const target = exactObject(value, [
    "channel", "bundle_id", "release_id", "sequence", "artifact_sha256", "artifact_version_code",
  ], label);
  const channel = cleanText(target.channel, `${label}.channel`, 40);
  if (!new Set(["stable", "trial"]).has(channel)) invalid(`${label}.channel is invalid`);
  return {
    channel,
    bundle_id: cleanId(target.bundle_id, `${label}.bundle_id`),
    release_id: cleanId(target.release_id, `${label}.release_id`),
    sequence: cleanInteger(target.sequence, `${label}.sequence`, 0),
    artifact_sha256: cleanDigest(target.artifact_sha256, `${label}.artifact_sha256`),
    artifact_version_code: cleanInteger(target.artifact_version_code, `${label}.artifact_version_code`, 1),
  };
}

function normalizeReplaces(value, label = "replaces") {
  const replaces = exactObject(value, [
    "bundle_id", "release_id", "source_commit", "artifact_sha256", "artifact_version_code",
  ], label);
  return {
    bundle_id: cleanId(replaces.bundle_id, `${label}.bundle_id`),
    release_id: cleanId(replaces.release_id, `${label}.release_id`),
    source_commit: cleanCommit(replaces.source_commit, `${label}.source_commit`),
    artifact_sha256: cleanDigest(replaces.artifact_sha256, `${label}.artifact_sha256`),
    artifact_version_code: cleanInteger(replaces.artifact_version_code, `${label}.artifact_version_code`, 1),
  };
}

function normalizeParent(value, label) {
  const parent = exactObject(value, ["bundle_id", "release_id", "sequence"], label);
  return {
    bundle_id: cleanId(parent.bundle_id, `${label}.bundle_id`),
    release_id: cleanId(parent.release_id, `${label}.release_id`),
    sequence: cleanInteger(parent.sequence, `${label}.sequence`, 0),
  };
}

function assertFresh(receipt, expected) {
  for (const field of ["source_commit", "target_predecessor", "replaces", "parent_stable", "parent_trial"]) {
    if (canonicalJson(receipt[field]) !== canonicalJson(expected[field])) {
      stale(`${field} no longer matches authoritative release state`);
    }
  }
}

function assertArtifactAvailable(expected, observed) {
  if (!observed || observed.available !== true) unavailable("recovery artifact is unavailable");
  const fields = ["sha256", "size_bytes", "app_id", "version_code", "signer_sha256"];
  if (fields.some((field) => observed[field] !== expected[field])) {
    unavailable("recovery artifact bytes or APK identity do not match provenance");
  }
}

function provenanceDigest(receipt) {
  const unsigned = {};
  for (const field of [
    "schema_version", "kind", "recovery_release_id", "source_commit", "builder_commit",
    "built_at", "download_path", "artifact", "target_predecessor", "replaces",
    "parent_stable", "parent_trial",
  ]) unsigned[field] = receipt[field];
  return crypto.createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) invalid(`${label} contains unknown fields`);
  if (fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) invalid(`${label} is incomplete`);
  return value;
}

function cleanId(value, label) {
  const text = String(value || "").trim();
  if (!ID.test(text)) invalid(`${label} is invalid`);
  return text;
}

function cleanText(value, label, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) invalid(`${label} is invalid`);
  return text;
}

function cleanInteger(value, label, min) {
  if (!Number.isSafeInteger(value) || value < min) invalid(`${label} is invalid`);
  return value;
}

function cleanDigest(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!DIGEST.test(text)) invalid(`${label} is invalid`);
  return text;
}

function cleanCommit(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!COMMIT.test(text)) invalid(`${label} is invalid`);
  return text;
}

function cleanPackage(value) {
  const text = String(value || "").trim();
  if (!PACKAGE.test(text) || text.length > 200) invalid("artifact.app_id is invalid");
  return text;
}

function cleanTime(value) {
  const text = String(value || "").trim();
  const timestamp = Date.parse(text);
  if (!text || !Number.isFinite(timestamp)) invalid("built_at is invalid");
  return text;
}

function cleanDownloadPath(value) {
  const text = String(value || "").trim();
  if (!/^\/[A-Za-z0-9/._-]{1,1000}\.apk$/.test(text) || text.includes("..")) invalid("download_path is invalid");
  return text;
}

function cleanDownloadUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { invalid("download_url is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("download_url is invalid");
  return url.toString();
}

function requiredFunction(value, label) {
  if (typeof value !== "function") invalid(`${label} is required`);
  return value;
}

function invalid(message) { throw new ForwardRecoveryError("invalid_recovery_manifest", message); }
function stale(message) { throw new ForwardRecoveryError("recovery_provenance_stale", message); }
function unavailable(message) { throw new ForwardRecoveryError("recovery_artifact_unavailable", message); }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

module.exports = {
  ForwardRecoveryError,
  canonicalJson,
  projectForwardRecoveryManifest,
  provenanceDigest,
};
