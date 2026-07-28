"use strict";

import crypto from "node:crypto";
import {
  normalizeChannelHead,
  normalizeReleaseBundle,
} from "./domain.mjs";

const PUBLICATION_VERSION = "moa-release-bundle-publication/v1";
const CHANNELS = new Set(["preview", "stable"]);
const SURFACES = new Set([
  "android",
  "browser_extension",
  "gateway",
  "web",
  "macos",
  "windows",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function createReleaseBundlePublisher({
  adapter,
  authorizePublication,
  inspectSource,
  inspectArtifact,
  loadEvidence,
  loadPromotionEvidence,
  evaluateEvidence,
  now = () => new Date().toISOString(),
} = {}) {
  requireFunction(authorizePublication, "authorizePublication");
  requireFunction(inspectSource, "inspectSource");
  requireFunction(inspectArtifact, "inspectArtifact");
  requireFunction(loadEvidence, "loadEvidence");
  requireFunction(loadPromotionEvidence, "loadPromotionEvidence");
  requireFunction(evaluateEvidence, "evaluateEvidence");
  if (!adapter || typeof adapter.listChannelHeads !== "function"
      || typeof adapter.listPublicationReceipts !== "function"
      || typeof adapter.publishBundleAndChannelHead !== "function") {
    throw new Error("publisher adapter is invalid");
  }

  async function plan(rawManifest, requestContext = {}) {
    const manifest = normalizePublicationManifest(rawManifest);
    const authority = normalizeAuthority(await authorizePublication({
      request_context: requestContext,
      tenant_id: manifest.tenant_id,
      application_id: manifest.application_id,
      channel: manifest.channel,
      source_ref: manifest.source_ref,
      git_sha: manifest.git_sha,
    }));
    enforceAuthority(authority, manifest);

    const source = await inspectSource({
      source_ref: manifest.source_ref,
      git_sha: manifest.git_sha,
      tracked_paths: authority.promotion_evidence_ref
        ? [...manifest.tracked_paths, authority.promotion_evidence_ref]
        : manifest.tracked_paths,
    });
    if (source?.commit_exists !== true) throw blocked("source_commit_missing");
    if (source?.ref_git_sha !== manifest.git_sha) throw blocked("source_ref_mismatch");
    if (source?.tracked_paths_clean !== true) throw blocked("source_paths_not_exact_commit");

    const artifacts = [];
    const evidenceReceipts = [];
    for (const artifactInput of manifest.artifacts) {
      const observed = await inspectArtifact(artifactInput.artifact_ref);
      if (!observed || observed.sha256 !== artifactInput.artifact_sha256) {
        throw blocked("artifact_digest_mismatch", artifactInput.surface_id);
      }
      if (observed.size_bytes !== artifactInput.artifact_size) {
        throw blocked("artifact_size_mismatch", artifactInput.surface_id);
      }
      const evidenceDocument = await loadEvidence(artifactInput.evidence_ref);
      const evidence = evaluateEvidence(evidenceDocument);
      enforceEvidence(evidence, manifest, artifactInput);
      artifacts.push({
        surface_id: artifactInput.surface_id,
        release_id: artifactInput.release_id,
        semantic_version: artifactInput.semantic_version,
        artifact_sha256: artifactInput.artifact_sha256,
        artifact_size: artifactInput.artifact_size,
        git_sha: manifest.git_sha,
        download_url: artifactInput.download_url,
        app_id: artifactInput.app_id,
        version_code: artifactInput.version_code,
        version_name: artifactInput.version_name,
      });
      evidenceReceipts.push(Object.freeze({
        surface_id: artifactInput.surface_id,
        release_id: artifactInput.release_id,
        artifact_sha256: artifactInput.artifact_sha256,
        evidence_ref: artifactInput.evidence_ref,
        highest_proven_state: evidence.highest_proven_state,
        publication_ready: true,
      }));
    }

    const bundle = normalizeReleaseBundle({
      tenant_id: manifest.tenant_id,
      application_id: manifest.application_id,
      bundle_id: manifest.bundle_id,
      compatibility_version: manifest.compatibility_version,
      lineage: manifest.lineage,
      artifacts,
      created_at: manifest.created_at,
    });
    const promotionEvidence = manifest.channel === "stable"
      ? validatePromotionEvidence(
        await loadPromotionEvidence(authority.promotion_evidence_ref),
        manifest,
      )
      : null;
    const [priorHeads, priorReceipts] = await Promise.all([
      adapter.listChannelHeads(manifest.tenant_id, manifest.application_id),
      adapter.listPublicationReceipts(manifest.tenant_id, manifest.application_id),
    ]);
    const currentSequence = priorHeads
      .filter((item) => item.channel === manifest.channel)
      .reduce((maximum, item) => Math.max(maximum, Number(item.sequence) || 0), 0);
    const head = normalizeChannelHead({
      tenant_id: manifest.tenant_id,
      application_id: manifest.application_id,
      channel: manifest.channel,
      bundle_id: manifest.bundle_id,
      sequence: manifest.expected_head_sequence + 1,
      updated_at: manifest.created_at,
    });
    const receiptId = deterministicId("publish", canonicalJson({
      manifest,
      bundle,
      head,
      authority_id: authority.authority_id,
      promotion_bundle_id: authority.promotion_bundle_id,
      promotion_evidence_ref: authority.promotion_evidence_ref,
      promotion_evidence_sha256: promotionEvidence?.sha256 || null,
      evidence: evidenceReceipts,
    }));
    const receipt = Object.freeze({
      receipt_id: receiptId,
      tenant_id: manifest.tenant_id,
      application_id: manifest.application_id,
      channel: manifest.channel,
      prior_sequence: manifest.expected_head_sequence,
      new_sequence: head.sequence,
      bundle_id: manifest.bundle_id,
      git_sha: manifest.git_sha,
      source_ref: manifest.source_ref,
      authority_id: authority.authority_id,
      authority_kind: "repository_release",
      promotion_bundle_id: authority.promotion_bundle_id,
      promotion_evidence_ref: authority.promotion_evidence_ref,
      promotion_evidence_sha256: promotionEvidence?.sha256 || null,
      artifact_bindings: Object.freeze(artifacts.map((artifact) => Object.freeze({
        surface_id: artifact.surface_id,
        release_id: artifact.release_id,
        artifact_sha256: artifact.artifact_sha256,
      }))),
      evidence_receipts: Object.freeze(evidenceReceipts),
      created_at: head.updated_at,
    });
    const priorReceipt = priorReceipts.find((item) => item.receipt_id === receipt.receipt_id);
    if (currentSequence !== manifest.expected_head_sequence && !priorReceipt) {
      throw sequenceConflict(manifest.expected_head_sequence, currentSequence);
    }
    if (priorReceipt && canonicalJson(priorReceipt) !== canonicalJson(receipt)) {
      throw blocked("publication_receipt_immutable_conflict");
    }
    return Object.freeze({
      status: "ready",
      expected_head_sequence: manifest.expected_head_sequence,
      bundle,
      head,
      receipt,
    });
  }

  async function publish(rawManifest, requestContext = {}) {
    const publication = await plan(rawManifest, requestContext);
    const result = await adapter.publishBundleAndChannelHead({
      bundle: publication.bundle,
      head: publication.head,
      receipt: publication.receipt,
      expected_head_sequence: publication.expected_head_sequence,
    });
    return Object.freeze({
      status: "published",
      bundle: result.bundle,
      head: result.head,
      receipt: result.receipt,
    });
  }

  return Object.freeze({ plan, publish });
}

export function normalizePublicationManifest(input) {
  exactObject(input, [
    "version", "tenant_id", "application_id", "bundle_id", "channel",
    "expected_head_sequence", "source_ref", "git_sha", "tracked_paths",
    "compatibility_version", "created_at", "artifacts",
    "lineage",
  ], "manifest");
  if (input.version !== PUBLICATION_VERSION) throw new Error("manifest.version is invalid");
  const channel = cleanId(input.channel, "manifest.channel");
  if (!CHANNELS.has(channel)) throw new Error("manifest.channel is invalid");
  const gitSha = cleanString(input.git_sha, "manifest.git_sha", 40);
  if (!GIT_SHA.test(gitSha)) throw new Error("manifest.git_sha is invalid");
  const trackedPaths = cleanStringArray(input.tracked_paths, "manifest.tracked_paths", 1, 32, 512);
  const artifacts = input.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > SURFACES.size) {
    throw new Error("manifest.artifacts is invalid");
  }
  const seen = new Set();
  const normalizedArtifacts = artifacts.map((artifact, index) => {
    const path = `manifest.artifacts[${index}]`;
    exactObject(artifact, [
      "surface_id", "release_id", "semantic_version", "artifact_ref",
      "artifact_sha256", "artifact_size", "evidence_ref", "download_url",
      "app_id", "version_code", "version_name",
    ], path);
    const surfaceId = cleanId(artifact.surface_id, `${path}.surface_id`);
    if (!SURFACES.has(surfaceId) || seen.has(surfaceId)) throw new Error(`${path}.surface_id is invalid`);
    seen.add(surfaceId);
    const digest = cleanString(artifact.artifact_sha256, `${path}.artifact_sha256`, 64).toLowerCase();
    if (!SHA256.test(digest)) throw new Error(`${path}.artifact_sha256 is invalid`);
    return Object.freeze({
      surface_id: surfaceId,
      release_id: cleanId(artifact.release_id, `${path}.release_id`),
      semantic_version: cleanString(artifact.semantic_version, `${path}.semantic_version`, 80),
      artifact_ref: cleanString(artifact.artifact_ref, `${path}.artifact_ref`, 1024),
      artifact_sha256: digest,
      artifact_size: cleanInteger(artifact.artifact_size, `${path}.artifact_size`, 1),
      evidence_ref: cleanString(artifact.evidence_ref, `${path}.evidence_ref`, 1024),
      download_url: optionalString(artifact.download_url, `${path}.download_url`, 2048),
      app_id: optionalString(artifact.app_id, `${path}.app_id`, 200),
      version_code: artifact.version_code == null
        ? null : cleanInteger(artifact.version_code, `${path}.version_code`, 1),
      version_name: optionalString(artifact.version_name, `${path}.version_name`, 80),
    });
  });
  return Object.freeze({
    version: PUBLICATION_VERSION,
    tenant_id: cleanId(input.tenant_id, "manifest.tenant_id"),
    application_id: cleanId(input.application_id, "manifest.application_id"),
    bundle_id: cleanId(input.bundle_id, "manifest.bundle_id"),
    channel,
    expected_head_sequence: cleanInteger(input.expected_head_sequence, "manifest.expected_head_sequence", 0),
    source_ref: cleanString(input.source_ref, "manifest.source_ref", 512),
    git_sha: gitSha,
    tracked_paths: Object.freeze(trackedPaths),
    compatibility_version: cleanInteger(input.compatibility_version ?? 1, "manifest.compatibility_version", 1),
    lineage: input.lineage == null ? undefined : normalizeManifestLineage(input.lineage),
    created_at: cleanString(input.created_at, "manifest.created_at", 80),
    artifacts: Object.freeze(normalizedArtifacts),
  });
}

function normalizeManifestLineage(value) {
  exactObject(value, ["kind", "series_parent_bundle_id", "parallel_parent_bundle_ids"], "manifest.lineage");
  if (value.parallel_parent_bundle_ids != null && !Array.isArray(value.parallel_parent_bundle_ids)) {
    throw new Error("manifest.lineage.parallel_parent_bundle_ids is invalid");
  }
  return Object.freeze({
    kind: value.kind == null ? undefined : cleanId(value.kind, "manifest.lineage.kind"),
    series_parent_bundle_id: value.series_parent_bundle_id == null ? null : cleanId(value.series_parent_bundle_id, "manifest.lineage.series_parent_bundle_id"),
    parallel_parent_bundle_ids: Object.freeze((value.parallel_parent_bundle_ids || []).map((item) => cleanId(item, "manifest.lineage.parallel_parent_bundle_ids"))),
  });
}

function normalizeAuthority(input) {
  if (!input || typeof input !== "object") throw new Error("repository release authority is required");
  return Object.freeze({
    allowed: input.allowed === true,
    authority_kind: input.authority_kind,
    authority_id: cleanId(input.authority_id, "authority.authority_id"),
    authorized_git_sha: cleanString(input.authorized_git_sha, "authority.authorized_git_sha", 40),
    authorized_source_refs: new Set(cleanStringArray(
      input.authorized_source_refs,
      "authority.authorized_source_refs",
      1,
      16,
      512,
    )),
    authorized_channels: new Set(cleanStringArray(
      input.authorized_channels,
      "authority.authorized_channels",
      1,
      CHANNELS.size,
      32,
    )),
    promotion_bundle_id: input.promotion_bundle_id == null
      ? null : cleanId(input.promotion_bundle_id, "authority.promotion_bundle_id"),
    promotion_evidence_ref: input.promotion_evidence_ref == null
      ? null : cleanString(input.promotion_evidence_ref, "authority.promotion_evidence_ref", 1024),
  });
}

function enforceAuthority(authority, manifest) {
  if (!authority.allowed || authority.authority_kind !== "repository_release") {
    throw blocked("repository_release_authority_required");
  }
  if (authority.authorized_git_sha !== manifest.git_sha) throw blocked("authority_git_sha_mismatch");
  if (!authority.authorized_source_refs.has(manifest.source_ref)) throw blocked("authority_source_ref_mismatch");
  if (!authority.authorized_channels.has(manifest.channel)) throw blocked("authority_channel_mismatch");
  if (manifest.channel === "stable"
      && (authority.promotion_bundle_id !== manifest.bundle_id || !authority.promotion_evidence_ref)) {
    throw blocked("stable_promotion_evidence_required");
  }
}

function enforceEvidence(evidence, manifest, artifact) {
  if (!evidence?.ok) throw blocked("evidence_invalid", artifact.surface_id);
  if (evidence.surface !== artifact.surface_id
      || evidence.release_id !== artifact.release_id
      || evidence.artifact_sha256 !== artifact.artifact_sha256
      || evidence.channel !== manifest.channel) {
    throw blocked("evidence_binding_mismatch", artifact.surface_id);
  }
  if (evidence.publication_ready !== true || evidence.channel_advance_allowed !== true) {
    throw blocked("evidence_not_publication_ready", artifact.surface_id);
  }
}

export function validatePromotionEvidence(input, manifest) {
  if (!input || typeof input !== "object" || !input.document || typeof input.sha256 !== "string") {
    throw blocked("stable_promotion_evidence_invalid");
  }
  const document = input.document;
  exactObject(document, [
    "schema_version", "application_id", "bundle_id", "channel", "git_sha",
    "gate_result", "artifact_digests", "evidence",
  ], "promotion_evidence");
  if (document.schema_version !== "moa-bundle-promotion-evidence/v1"
      || document.application_id !== manifest.application_id
      || document.bundle_id !== manifest.bundle_id
      || document.channel !== "stable"
      || document.git_sha !== manifest.git_sha
      || document.gate_result !== "passed"
      || !SHA256.test(input.sha256)) {
    throw blocked("stable_promotion_evidence_mismatch");
  }
  if (!Array.isArray(document.artifact_digests)
      || document.artifact_digests.length !== manifest.artifacts.length) {
    throw blocked("stable_promotion_artifacts_mismatch");
  }
  const expected = manifest.artifacts.map((artifact) => ({
    surface: artifact.surface_id,
    release_id: artifact.release_id,
    sha256: artifact.artifact_sha256,
    size_bytes: artifact.artifact_size,
  })).sort(compareArtifactBinding);
  const observed = document.artifact_digests.map((artifact, index) => {
    exactObject(artifact, ["surface", "release_id", "sha256", "size_bytes"], `promotion_evidence.artifact_digests[${index}]`);
    return {
      surface: cleanId(artifact.surface, `promotion_evidence.artifact_digests[${index}].surface`),
      release_id: cleanId(artifact.release_id, `promotion_evidence.artifact_digests[${index}].release_id`),
      sha256: cleanDigest(artifact.sha256, `promotion_evidence.artifact_digests[${index}].sha256`),
      size_bytes: cleanInteger(artifact.size_bytes, `promotion_evidence.artifact_digests[${index}].size_bytes`, 1),
    };
  }).sort(compareArtifactBinding);
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw blocked("stable_promotion_artifacts_mismatch");
  }
  if (!Array.isArray(document.evidence) || document.evidence.length < 6 || document.evidence.length > 64) {
    throw blocked("stable_promotion_states_missing");
  }
  const states = new Set();
  const assertions = new Map();
  for (const [index, evidence] of document.evidence.entries()) {
    exactObject(evidence, [
      "state", "assertion", "verifier", "evidence_ref", "occurred_at",
    ], `promotion_evidence.evidence[${index}]`);
    const state = cleanId(evidence.state, `promotion_evidence.evidence[${index}].state`);
    if (states.has(state)) throw blocked("stable_promotion_state_duplicated");
    states.add(state);
    assertions.set(state, cleanId(
      evidence.assertion,
      `promotion_evidence.evidence[${index}].assertion`,
    ));
    cleanString(evidence.verifier, `promotion_evidence.evidence[${index}].verifier`, 160);
    cleanString(evidence.evidence_ref, `promotion_evidence.evidence[${index}].evidence_ref`, 1024);
    const occurredAt = cleanString(evidence.occurred_at, `promotion_evidence.evidence[${index}].occurred_at`, 80);
    if (!Number.isFinite(Date.parse(occurredAt))) throw blocked("stable_promotion_evidence_invalid");
  }
  const required = new Map([
    ["previewed", "preview_smoked"],
    ["backup_restored", "backup_restore_passed"],
    ["state_compatible", "n_minus_one_compatible"],
    ["no_interruption", "drain_safe"],
    ["rollback_ready", "rollback_ready"],
    ["smoked", "exact_artifact_smoked"],
  ]);
  if ([...required].some(([state, assertion]) => assertions.get(state) !== assertion)) {
    throw blocked("stable_promotion_states_missing");
  }
  return Object.freeze({ document, sha256: input.sha256 });
}

function compareArtifactBinding(left, right) {
  return `${left.surface}:${left.release_id}:${left.sha256}:${left.size_bytes}`
    .localeCompare(`${right.surface}:${right.release_id}:${right.sha256}:${right.size_bytes}`);
}

function exactObject(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} is invalid`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
}

function cleanId(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!ID.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function cleanDigest(value, field) {
  const text = cleanString(value, field, 64).toLowerCase();
  if (!SHA256.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function cleanString(value, field, maximum) {
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${field} is invalid`);
  return text;
}

function optionalString(value, field, maximum) {
  return value == null ? null : cleanString(value, field, maximum);
}

function cleanStringArray(value, field, minimum, maximum, itemMaximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return [...new Set(value.map((item, index) => cleanString(item, `${field}[${index}]`, itemMaximum)))];
}

function cleanInteger(value, field, minimum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${field} is invalid`);
  return number;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
}

function deterministicId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function blocked(reason, surfaceId = null) {
  const error = new Error(surfaceId ? `${reason}: ${surfaceId}` : reason);
  error.code = "release_publication_blocked";
  error.reason = reason;
  error.surface_id = surfaceId;
  return error;
}

function sequenceConflict(expected, actual) {
  const error = new Error(`channel head sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "channel_head_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}
