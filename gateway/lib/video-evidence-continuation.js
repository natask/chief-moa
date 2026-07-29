"use strict";

const crypto = require("node:crypto");
const { deriveVideoEvidenceRecordLifecycle } = require("./video-evidence-store");

// This module does not authenticate routes, devices, providers, or blob stores.
// Receipt fields are assertions until the caller's injected authorityVerifier
// authenticates them. Durability and cross-process serialization likewise come
// only from an injected durable adapter such as createFileVideoEvidenceAdapter.

const SCHEMA = "moa.video-evidence-request.v1";
const EVIDENCE_SCHEMA = "evidence_asset.v1";
const STATES = Object.freeze([
  "proposed",
  "user_started",
  "captured",
  "uploaded",
  "attached",
  "processed",
  "deleted",
  "failed",
]);
const CAPTURE_SCOPES = new Set(["tab", "window", "screen"]);
const ROLES = new Set(["explain", "help", "collaborate", "delegate"]);
const MAX_REASON_CHARS = 600;
const MAX_QUERY_CHARS = 12_000;
const MAX_DURATION_SECONDS = 120;
const MAX_REQUEST_TTL_MS = 15 * 60 * 1000;
const MAX_VIDEO_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const MAX_RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ALLOWED_VIDEO_TYPES = new Set(["video/webm", "video/mp4"]);

function createVideoEvidenceContinuationCore(options = {}) {
  const adapter = requireAdapter(options.adapter);
  const authorityVerifier = requireAuthorityVerifier(options.authorityVerifier);
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const createId = typeof options.createId === "function"
    ? options.createId
    : () => `video-request-${crypto.randomUUID()}`;

  function proposeFromModel(input = {}) {
    return mutate(({ records }) => {
      rejectRawMedia(input);
    const modelOutput = object(input.model_output, "model_output");
    if (modelOutput.schema !== SCHEMA) throw contractError("invalid_schema", `${SCHEMA} is required`);
    if (modelOutput.status != null && modelOutput.status !== "proposed") {
      throw contractError("model_status_has_no_authority", "model output may only create a proposed request");
    }
    const turn = object(input.turn, "turn");
    const createdAt = iso(now(), "now");
    const expiresAt = iso(modelOutput.expires_at || new Date(Date.parse(createdAt) + MAX_REQUEST_TTL_MS).toISOString(), "expires_at");
    const ttl = Date.parse(expiresAt) - Date.parse(createdAt);
    if (ttl <= 0 || ttl > MAX_REQUEST_TTL_MS) {
      throw contractError("invalid_expiry", "video request expiry must be within 15 minutes");
    }
    const requestId = token(modelOutput.request_id || createId(), "request_id");
    if (records.has(requestId)) throw contractError("request_conflict", "request_id already exists", 409);
    const originalQuery = boundedText(turn.original_query || turn.query, "original_query", MAX_QUERY_CHARS);
    const captureScope = enumValue(modelOutput.capture_scope, CAPTURE_SCOPES, "capture_scope");
    const maxDurationSeconds = integer(modelOutput.max_duration_seconds, "max_duration_seconds", 1, MAX_DURATION_SECONDS);
    const providerSupport = normalizeProviderSupport(input.provider_support);
    const capabilitySnapshot = object(input.capability_snapshot, "capability_snapshot");
    const capabilitySnapshotId = token(
      capabilitySnapshot.id || input.capability_snapshot_id,
      "capability_snapshot_id",
    );
    const surfaceId = token(input.surface_id || turn.surface_id, "surface_id");
    const record = {
      schema: SCHEMA,
      request_id: requestId,
      status: "proposed",
      version: 1,
      turn: Object.freeze({
        turn_id: token(turn.turn_id, "turn_id"),
        session_id: token(turn.session_id, "session_id"),
        branch: token(turn.branch || turn.branch_id, "branch"),
        role: enumValue(turn.role, ROLES, "role"),
        source: token(turn.source, "source"),
        surface_id: surfaceId,
        original_query: originalQuery,
        query_revision: integer(modelOutput.query_revision ?? turn.query_revision, "query_revision", 1, 1_000_000),
        delegation_envelope_id: optionalToken(turn.delegation_envelope_id),
      }),
      request: Object.freeze({
        reason: boundedText(modelOutput.reason, "reason", MAX_REASON_CHARS),
        capture_scope: captureScope,
        max_duration_seconds: maxDurationSeconds,
        needs_audio: strictBoolean(modelOutput.needs_audio, "needs_audio"),
        expires_at: expiresAt,
      }),
      capability_snapshot: Object.freeze({
        id: capabilitySnapshotId,
        digest: digest(capabilitySnapshot.digest, "capability_snapshot.digest"),
      }),
      provider_support: Object.freeze(providerSupport),
      retention: Object.freeze(normalizeRetention(input.retention, createdAt, expiresAt)),
      evidence: null,
      processing: null,
      failure: null,
      receipts: [],
      idempotency: {},
      created_at: createdAt,
      updated_at: createdAt,
    };
      records.set(requestId, record);
      return clone(record);
    });
  }

  function recordUserStarted(requestId, receipt, options = {}) {
    return transition(requestId, "user_started", receipt, options, (record, value) => {
      requireTrustedSurfaceReceipt(record, value, "user_started", authorityVerifier);
      return {};
    });
  }

  function recordCaptured(requestId, receipt, options = {}) {
    return transition(requestId, "captured", receipt, options, (record, value) => {
      requireTrustedSurfaceReceipt(record, value, "captured", authorityVerifier);
      const durationSeconds = finiteNumber(value.duration_seconds, "duration_seconds", 0, record.request.max_duration_seconds);
      const captureScope = enumValue(value.capture_scope, CAPTURE_SCOPES, "capture_scope");
      if (captureScope !== record.request.capture_scope) throw contractError("scope_mismatch", "captured scope differs from proposal");
      const hasAudio = strictBoolean(value.has_audio, "has_audio");
      if (hasAudio && !record.request.needs_audio) throw contractError("audio_scope_exceeded", "audio was not authorized");
      return { capture: { duration_seconds: durationSeconds, capture_scope: captureScope, has_audio: hasAudio } };
    });
  }

  function recordUploaded(requestId, receipt, options = {}) {
    return transition(requestId, "uploaded", receipt, options, (record, value, runtime) => {
      requireTrustedSurfaceReceipt(record, value, "uploaded", authorityVerifier);
      const evidence = normalizeEvidence(value.evidence, record);
      assertAssetIdentityAvailable(runtime.assetClaims, evidence, record);
      claimAssetIdentity(runtime.assetClaims, evidence, record);
      return { evidence };
    });
  }

  function attach(requestId, receipt, options = {}) {
    return transition(requestId, "attached", receipt, options, (record, value) => {
      requireTrustedSurfaceReceipt(record, value, "attached", authorityVerifier);
      const binding = object(value.binding, "binding");
      assertBinding(record, binding);
      if (token(value.evidence_id, "evidence_id") !== record.evidence.evidence_id) {
        throw contractError("evidence_mismatch", "attachment evidence does not match uploaded evidence");
      }
      return { attached_at: iso(value.at || now(), "attached_at") };
    });
  }

  function createContinuation(requestId) {
    return inspect(({ records }) => {
      const record = requireRecord(records, requestId);
      const lifecycle = deriveVideoEvidenceRecordLifecycle(record.request_id, record);
      rejectExpired(record);
      if (!["attached", "processed"].includes(lifecycle.status)) throw invalidTransition(lifecycle.status, "continuation");
      if (!record.turn.original_query.trim()) throw contractError("blank_original_query", "continuation query cannot be blank");
      return {
      schema: "moa.reasoning-turn.v2",
      continuation: "video_evidence",
      turn: {
        turn_id: record.turn.turn_id,
        session_id: record.turn.session_id,
        branch: record.turn.branch,
        source: record.turn.source,
        role: record.turn.role,
        query: record.turn.original_query,
        query_revision: record.turn.query_revision,
        delegation_envelope_id: record.turn.delegation_envelope_id,
      },
      evidence_refs: [record.evidence.evidence_id],
      capability_snapshot_id: record.capability_snapshot.id,
      capability_snapshot: clone(record.capability_snapshot),
      provider_video: clone(record.provider_support),
      };
    });
  }

  function recordProcessed(requestId, receipt, options = {}) {
    return transition(requestId, "processed", receipt, options, (record, value) => {
      if (record.provider_support.direct_video_input !== true) {
        throw contractError("video_provider_unsupported", record.provider_support.reason || "provider has no direct video support", 422);
      }
      if (value.derivation != null) {
        throw contractError("silent_derivation_forbidden", "frame or transcript derivation is a separate disclosed flow");
      }
      const providerReceipt = object(value.provider_receipt, "provider_receipt");
      assertProviderReceipt(record, providerReceipt, authorityVerifier);
      return {
        processing: {
          provider: record.provider_support.provider,
          model: record.provider_support.model,
          direct_video_received: true,
          provider_receipt_ref: token(providerReceipt.receipt_ref, "provider_receipt.receipt_ref"),
          evidence_id: record.evidence.evidence_id,
          evidence_sha256: record.evidence.sha256,
          provider_posture_digest: record.provider_support.posture_digest,
          processed_at: iso(value.at || now(), "processed_at"),
        },
      };
    });
  }

  function fail(requestId, receipt, options = {}) {
    return transition(requestId, "failed", receipt, options, (record, value) => ({
      failure: {
        code: token(value.code, "failure.code"),
        message: boundedText(value.message, "failure.message", 500),
        failed_at: iso(value.at || now(), "failed_at"),
      },
    }), { allowFrom: ["proposed", "user_started", "captured", "uploaded", "attached"] });
  }

  function deleteEvidence(requestId, receipt, options = {}) {
    return transition(requestId, "deleted", receipt, options, (record, value) => {
      requireTrustedSurfaceReceipt(record, value, "deleted", authorityVerifier);
      if (!record.evidence || !record.evidence.blob_ref) {
        throw contractError("evidence_required", "deletion requires uploaded video evidence", 409);
      }
      const deleteReceipt = object(value.blob_delete_receipt, "blob_delete_receipt");
      assertBlobDeleteReceipt(record, deleteReceipt, authorityVerifier);
      return {
        evidence: {
          evidence_id: record.evidence.evidence_id,
          deleted: true,
          blob_ref: null,
          sha256: record.evidence.sha256,
          duration_seconds: record.evidence.duration_seconds,
          has_audio: record.evidence.has_audio,
        },
        deletion: {
          reason: boundedText(value.reason, "deletion.reason", 200),
          deleted_at: iso(value.at || now(), "deleted_at"),
          deleted_blob_ref: record.evidence.blob_ref,
          blob_delete_receipt_ref: token(deleteReceipt.receipt_ref, "blob_delete_receipt.receipt_ref"),
        },
      };
    }, { allowFrom: ["uploaded", "attached", "processed", "failed"] });
  }

  function expire(requestId, receipt = {}, options = {}) {
    return transition(requestId, "failed", {
      ...receipt,
      receipt_id: receipt.receipt_id || `expiry-${token(requestId, "request_id")}`,
      code: "expired",
      message: "video evidence request expired before completion",
      at: receipt.at || now(),
    }, options, (record, value) => ({
      failure: {
        code: "expired",
        message: "video evidence request expired before completion",
        failed_at: iso(value.at || now(), "failed_at"),
      },
    }), {
      allowFrom: ["proposed", "user_started", "captured", "uploaded", "attached"],
      precheck(record) {
        if (Date.parse(now()) <= Date.parse(record.request.expires_at)) {
          throw contractError("not_expired", "video request has not expired", 409);
        }
      },
    });
  }

  function transition(requestId, target, receipt, options, buildPatch, policy = {}) {
    return mutate((runtime) => {
      const record = requireRecord(runtime.records, requestId);
      const value = object(receipt, "receipt");
      rejectRawMedia(value);
    const receiptId = token(value.receipt_id, "receipt_id");
    const fingerprint = digestCanonical({ target, receipt: value });
    const replay = record.idempotency[receiptId];
    if (replay) {
      if (replay.fingerprint !== fingerprint || replay.target !== target) {
        throw contractError("idempotency_conflict", "receipt_id was already used for different input", 409);
      }
      return clone(record);
    }
    if (options.expected_version != null && options.expected_version !== record.version) {
      throw contractError("version_conflict", `expected version ${options.expected_version}, found ${record.version}`, 409);
    }
      if (target !== "failed" && target !== "deleted") rejectExpired(record);
      if (typeof policy.precheck === "function") policy.precheck(record, value);
      const allowedFrom = policy.allowFrom || [previousState(target)];
      if (!allowedFrom.includes(record.status)) throw invalidTransition(record.status, target);
      const patch = buildPatch(record, value, runtime) || {};
      const at = iso(value.at || now(), "receipt.at");
      assertMonotonicReceiptTime(record, at, now());
      const next = {
      ...record,
      ...patch,
      status: target,
      version: record.version + 1,
      receipts: [...record.receipts, sanitizeReceipt(value, target, at, record, patch)],
      idempotency: { ...record.idempotency, [receiptId]: { target, fingerprint } },
      updated_at: at,
    };
      runtime.records.set(record.request_id, next);
      return clone(next);
    });
  }

  return {
    proposeFromModel,
    recordUserStarted,
    recordCaptured,
    recordUploaded,
    attach,
    createContinuation,
    recordProcessed,
    fail,
    deleteEvidence,
    expire,
    get: (requestId) => inspect(({ records }) => clone(requireRecord(records, requestId))),
  };

  function requireRecord(records, requestId) {
    const id = token(requestId, "request_id");
    const record = records.get(id);
    if (!record) throw contractError("request_not_found", "video evidence request not found", 404);
    return record;
  }

  function mutate(fn) {
    return adapter.transact((state) => {
      const runtime = hydrateState(state);
      const result = fn(runtime);
      dehydrateState(state, runtime);
      return result;
    });
  }

  function inspect(fn) {
    return fn(hydrateState(adapter.read()));
  }

  function rejectExpired(record) {
    if (Date.parse(now()) > Date.parse(record.request.expires_at)) {
      throw contractError("request_expired", "video evidence request expired", 410);
    }
  }
}

function normalizeProviderSupport(value) {
  const support = object(value, "provider_support");
  const direct = strictBoolean(support.direct_video_input, "provider_support.direct_video_input");
  const provider = token(support.provider, "provider_support.provider");
  const model = token(support.model, "provider_support.model");
  const postureDigest = digest(support.posture_digest, "provider_support.posture_digest");
  const reason = boundedText(support.reason, "provider_support.reason", 300);
  if (direct && reason !== "direct_video_supported") {
    throw contractError("provider_support_mismatch", "supported providers must say direct_video_supported");
  }
  if (!direct && reason === "direct_video_supported") {
    throw contractError("provider_support_mismatch", "unsupported providers need an honest reason");
  }
  return { provider, model, direct_video_input: direct, reason, posture_digest: postureDigest };
}

function requireAdapter(value) {
  if (!value || typeof value.read !== "function" || typeof value.transact !== "function") {
    throw new TypeError("a video evidence persistence adapter with read/transact is required");
  }
  return value;
}

function requireAuthorityVerifier(value) {
  if (!value
    || typeof value.verifySurfaceUserAction !== "function"
    || typeof value.verifyBlobDeleteReceipt !== "function"
    || typeof value.verifyProviderReceipt !== "function") {
    throw new TypeError("an injected authenticated authority verifier is required");
  }
  return value;
}

function hydrateState(state) {
  return {
    records: new Map(Object.entries(state.records || {})),
    assetClaims: {
      evidence_id: new Map(Object.entries(state.asset_claims?.evidence_id || {})),
      blob_ref: new Map(Object.entries(state.asset_claims?.blob_ref || {})),
      sha256: new Map(Object.entries(state.asset_claims?.sha256 || {})),
    },
  };
}

function dehydrateState(state, runtime) {
  state.records = Object.fromEntries(runtime.records);
  state.asset_claims = {
    evidence_id: Object.fromEntries(runtime.assetClaims.evidence_id),
    blob_ref: Object.fromEntries(runtime.assetClaims.blob_ref),
    sha256: Object.fromEntries(runtime.assetClaims.sha256),
  };
}

function normalizeRetention(value, createdAt, requestExpiry) {
  const retention = object(value, "retention");
  if (retention.policy !== "short_lived") throw contractError("invalid_retention", "video retention must be short_lived");
  const deleteAt = iso(retention.delete_at || requestExpiry, "retention.delete_at");
  const retentionMs = Date.parse(deleteAt) - Date.parse(createdAt);
  if (retentionMs < 0 || retentionMs > MAX_VIDEO_RETENTION_MS) {
    throw contractError("invalid_retention", "video retention must end within 24 hours");
  }
  return { policy: "short_lived", delete_at: deleteAt, immediate_delete_available: true };
}

function normalizeEvidence(value, record) {
  const evidence = object(value, "evidence");
  if (evidence.schema !== EVIDENCE_SCHEMA) throw contractError("invalid_evidence_schema", `${EVIDENCE_SCHEMA} is required`);
  if (evidence.kind !== "video") throw contractError("invalid_evidence_kind", "video evidence is required");
  const grant = object(evidence.grant, "evidence.grant");
  if (grant.class !== "user_started_capture" || grant.user_initiated !== true) {
    throw contractError("capture_grant_required", "video requires a user-started capture grant");
  }
  if (token(grant.surface_id, "evidence.grant.surface_id") !== record.turn.surface_id) {
    throw contractError("surface_mismatch", "evidence grant belongs to another surface");
  }
  const media = object(evidence.media, "evidence.media");
  if (media.transport !== "gateway_blob") throw contractError("inline_video_forbidden", "video bytes must be stored outside this metadata module");
  const mediaType = enumValue(media.media_type, ALLOWED_VIDEO_TYPES, "evidence.media.media_type");
  const byteCount = integer(media.byte_count, "evidence.media.byte_count", 1, MAX_VIDEO_BYTES);
  const durationSeconds = finiteNumber(media.duration_seconds, "evidence.media.duration_seconds", 0, record.request.max_duration_seconds);
  const hasAudio = strictBoolean(media.has_audio, "evidence.media.has_audio");
  const capturedAt = iso(evidence.captured_at, "evidence.captured_at");
  const expiresAt = iso(evidence.expires_at, "evidence.expires_at");
  const subject = enumValue(evidence.subject, CAPTURE_SCOPES, "evidence.subject");
  if (subject !== record.capture.capture_scope) throw contractError("scope_mismatch", "video subject differs from trusted capture receipt");
  if (durationSeconds !== record.capture.duration_seconds) {
    throw contractError("duration_mismatch", "uploaded duration differs from trusted capture receipt");
  }
  if (hasAudio !== record.capture.has_audio) {
    throw contractError("audio_mismatch", "uploaded audio posture differs from trusted capture receipt");
  }
  if (Date.parse(capturedAt) < Date.parse(record.created_at) || Date.parse(expiresAt) <= Date.parse(capturedAt)) {
    throw contractError("invalid_evidence_time", "video capture and expiry must be ordered within the request");
  }
  if (Date.parse(expiresAt) > Date.parse(record.retention.delete_at)) {
    throw contractError("retention_exceeded", "evidence expiry exceeds its retention policy");
  }
  return {
    schema: EVIDENCE_SCHEMA,
    evidence_id: token(evidence.evidence_id, "evidence.evidence_id"),
    kind: "video",
    subject,
    captured_at: capturedAt,
    expires_at: expiresAt,
    media_type: mediaType,
    byte_count: byteCount,
    duration_seconds: durationSeconds,
    has_audio: hasAudio,
    sha256: digest(evidence.media.sha256, "evidence.media.sha256"),
    blob_ref: token(media.blob_ref, "evidence.media.blob_ref"),
    grant: { class: "user_started_capture", surface_id: record.turn.surface_id, user_initiated: true },
    retention: "short_lived",
  };
}

function requireTrustedSurfaceReceipt(record, receipt, event, verifier) {
  if (receipt.assertion_kind !== "surface_user_action" || receipt.user_activated !== true) {
    throw contractError("surface_user_action_assertion_required", `${event} requires a Surface user-action assertion`, 403);
  }
  if (token(receipt.surface_id, "receipt.surface_id") !== record.turn.surface_id) {
    throw contractError("surface_mismatch", "receipt belongs to another surface", 403);
  }
  assertExactFields(receipt, {
    request_id: record.request_id,
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
  }, "surface_receipt_binding_mismatch");
  if (verifier.verifySurfaceUserAction(receipt, {
    ...assetClaim(record),
    surface_id: record.turn.surface_id,
  }) !== true) {
    throw contractError("surface_receipt_unverified", "Surface assertion was not authenticated by the injected authority verifier", 403);
  }
}

function assertBinding(record, binding) {
  const expected = attachmentBinding(record);
  for (const [key, value] of Object.entries(expected)) {
    if (binding[key] !== value) throw contractError("turn_binding_mismatch", `attachment ${key} does not match the originating turn`);
  }
}

function attachmentBinding(record) {
  return {
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
    branch: record.turn.branch,
    role: record.turn.role,
    original_query: record.turn.original_query,
    query_revision: record.turn.query_revision,
    source: record.turn.source,
    surface_id: record.turn.surface_id,
    delegation_envelope_id: record.turn.delegation_envelope_id,
    capability_snapshot_id: record.capability_snapshot.id,
    capability_snapshot_digest: record.capability_snapshot.digest,
    provider: record.provider_support.provider,
    provider_model: record.provider_support.model,
    provider_direct_video_input: record.provider_support.direct_video_input,
    provider_posture_digest: record.provider_support.posture_digest,
    evidence_id: record.evidence.evidence_id,
    blob_ref: record.evidence.blob_ref,
    evidence_sha256: record.evidence.sha256,
  };
}

function assetClaim(record) {
  return {
    request_id: record.request_id,
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
  };
}

function assertAssetIdentityAvailable(claims, evidence, record) {
  const expected = assetClaim(record);
  for (const key of ["evidence_id", "blob_ref", "sha256"]) {
    const existing = claims[key].get(evidence[key]);
    if (existing && canonical(existing) !== canonical(expected)) {
      throw contractError("evidence_identity_reuse", `${key} is already bound to another video request`, 409);
    }
  }
}

function claimAssetIdentity(claims, evidence, record) {
  const claim = Object.freeze(assetClaim(record));
  for (const key of ["evidence_id", "blob_ref", "sha256"]) claims[key].set(evidence[key], claim);
}

function assertBlobDeleteReceipt(record, receipt, verifier) {
  if (receipt.assertion_kind !== "blob_store_delete" || receipt.deleted !== true) {
    throw contractError("blob_delete_assertion_required", "blob deletion requires a successful store assertion", 403);
  }
  assertExactFields(receipt, {
    request_id: record.request_id,
    evidence_id: record.evidence.evidence_id,
    blob_ref: record.evidence.blob_ref,
    sha256: record.evidence.sha256,
  }, "blob_delete_binding_mismatch");
  token(receipt.receipt_ref, "blob_delete_receipt.receipt_ref");
  if (verifier.verifyBlobDeleteReceipt(receipt, record.evidence) !== true) {
    throw contractError("blob_delete_receipt_unverified", "blob deletion assertion was not authenticated by the injected authority verifier", 403);
  }
}

function assertProviderReceipt(record, receipt, verifier) {
  if (receipt.assertion_kind !== "provider_processing" || receipt.direct_video_received !== true) {
    throw contractError("provider_processing_assertion_required", "processing requires a direct-video provider assertion", 403);
  }
  assertExactFields(receipt, {
    request_id: record.request_id,
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
    evidence_id: record.evidence.evidence_id,
    blob_ref: record.evidence.blob_ref,
    sha256: record.evidence.sha256,
    provider: record.provider_support.provider,
    model: record.provider_support.model,
    capability_snapshot_id: record.capability_snapshot.id,
    capability_snapshot_digest: record.capability_snapshot.digest,
    provider_posture_digest: record.provider_support.posture_digest,
  }, "provider_receipt_binding_mismatch");
  if (receipt.direct_video_input !== record.provider_support.direct_video_input) {
    throw contractError("provider_receipt_binding_mismatch", "provider receipt capability posture does not match the request");
  }
  token(receipt.receipt_ref, "provider_receipt.receipt_ref");
  if (verifier.verifyProviderReceipt(receipt, record.provider_support) !== true) {
    throw contractError("provider_receipt_unverified", "provider assertion was not authenticated by the injected authority verifier", 403);
  }
}

function assertExactFields(actual, expected, code) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw contractError(code, `${key} does not match the bound video request`);
  }
}

function assertMonotonicReceiptTime(record, receiptAt, currentTime) {
  const atMs = Date.parse(receiptAt);
  if (atMs < Date.parse(record.updated_at)) {
    throw contractError("receipt_time_regression", "receipt timestamp cannot move updated_at backward", 409);
  }
  if (atMs > Date.parse(iso(currentTime, "now")) + MAX_RECEIPT_FUTURE_SKEW_MS) {
    throw contractError("receipt_time_future", "receipt timestamp exceeds the bounded future-skew allowance", 409);
  }
}

function sanitizeReceipt(value, event, at, record, patch) {
  const receipt = {
    receipt_id: token(value.receipt_id, "receipt_id"),
    event,
    at,
    assertion_kind: optionalToken(value.assertion_kind),
    surface_id: optionalToken(value.surface_id),
    user_activated: value.user_activated === true,
  };
  if (value.code) receipt.code = token(value.code, "receipt.code");
  if (["user_started", "captured", "uploaded", "attached", "deleted"].includes(event)) {
    receipt.authority_verifier_accepted = true;
    receipt.turn_binding = {
      ...assetClaim(record),
      surface_id: record.turn.surface_id,
    };
  }
  if (event === "captured") receipt.capture = clone(patch.capture);
  if (event === "uploaded") receipt.evidence = clone(patch.evidence);
  if (event === "attached") {
    receipt.attachment_binding = attachmentBinding(record);
    receipt.attached_at = patch.attached_at;
  }
  if (event === "processed") {
    receipt.authority_verifier_accepted = true;
    receipt.provider_binding = providerReceiptBinding(value.provider_receipt);
    receipt.processing = clone(patch.processing);
  }
  if (event === "deleted") {
    receipt.blob_authority_verifier_accepted = true;
    receipt.blob_delete_binding = blobDeleteReceiptBinding(value.blob_delete_receipt);
    receipt.deleted_evidence = clone(patch.evidence);
    receipt.deletion = clone(patch.deletion);
  }
  if (event === "failed") receipt.failure = clone(patch.failure);
  return receipt;
}

function providerReceiptBinding(value) {
  return {
    assertion_kind: value.assertion_kind,
    receipt_ref: value.receipt_ref,
    request_id: value.request_id,
    turn_id: value.turn_id,
    session_id: value.session_id,
    evidence_id: value.evidence_id,
    blob_ref: value.blob_ref,
    sha256: value.sha256,
    provider: value.provider,
    model: value.model,
    direct_video_input: value.direct_video_input,
    direct_video_received: value.direct_video_received,
    capability_snapshot_id: value.capability_snapshot_id,
    capability_snapshot_digest: value.capability_snapshot_digest,
    provider_posture_digest: value.provider_posture_digest,
  };
}

function blobDeleteReceiptBinding(value) {
  return {
    assertion_kind: value.assertion_kind,
    receipt_ref: value.receipt_ref,
    request_id: value.request_id,
    evidence_id: value.evidence_id,
    blob_ref: value.blob_ref,
    sha256: value.sha256,
    deleted: value.deleted,
  };
}

function previousState(target) {
  return ({ user_started: "proposed", captured: "user_started", uploaded: "captured", attached: "uploaded", processed: "attached" })[target];
}

function invalidTransition(from, to) {
  return contractError("invalid_transition", `cannot transition from ${from} to ${to}`, 409);
}

function rejectRawMedia(value, path = "input", seen = new Set()) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw contractError("raw_media_forbidden", `${path} must contain metadata only`);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["bytes", "base64", "inline_data", "body", "data"].includes(key)) {
      throw contractError("raw_media_forbidden", `${path}.${key} is not accepted`);
    }
    rejectRawMedia(child, `${path}.${key}`, seen);
  }
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError("invalid_input", `${field} is required`);
  return value;
}

function boundedText(value, field, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) throw contractError("invalid_input", `${field} must contain 1-${max} characters`);
  return text;
}

function token(value, field) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(text)) throw contractError("invalid_input", `${field} is invalid`);
  return text;
}

function optionalToken(value) { return value == null || value === "" ? "" : token(value, "optional token"); }
function strictBoolean(value, field) {
  if (typeof value !== "boolean") throw contractError("invalid_input", `${field} must be boolean`);
  return value;
}
function enumValue(value, allowed, field) {
  if (!allowed.has(value)) throw contractError("invalid_input", `${field} is invalid`);
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw contractError("invalid_input", `${field} is out of bounds`);
  return value;
}
function finiteNumber(value, field, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw contractError("invalid_input", `${field} is out of bounds`);
  return value;
}
function iso(value, field) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw contractError("invalid_input", `${field} must be an RFC3339 timestamp`);
  return new Date(text).toISOString();
}
function digest(value, field) {
  const text = String(value || "");
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw contractError("invalid_input", `${field} is invalid`);
  return text;
}
function clone(value) { return value == null ? value : structuredClone(value); }

function contractError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  CAPTURE_SCOPES,
  MAX_DURATION_SECONDS,
  MAX_REQUEST_TTL_MS,
  MAX_RECEIPT_FUTURE_SKEW_MS,
  MAX_VIDEO_RETENTION_MS,
  MAX_VIDEO_BYTES,
  SCHEMA,
  STATES,
  createVideoEvidenceContinuationCore,
};
