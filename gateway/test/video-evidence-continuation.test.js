"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_DURATION_SECONDS,
  MAX_REQUEST_TTL_MS,
  MAX_VIDEO_RETENTION_MS,
  MAX_VIDEO_BYTES,
  SCHEMA,
  STATES,
  createVideoEvidenceContinuationCore,
} = require("../lib/video-evidence-continuation");

const SHA = `sha256:${"a".repeat(64)}`;

function harness() {
  let current = "2026-07-15T12:00:00.000Z";
  const core = createVideoEvidenceContinuationCore({
    now: () => current,
    createId: () => "video-request-generated",
  });
  return { core, setNow: (value) => { current = value; } };
}

function proposal(overrides = {}) {
  return {
    model_output: {
      schema: SCHEMA,
      request_id: "video-request-1",
      query_revision: 3,
      reason: "Motion over time is needed to explain this page.",
      capture_scope: "tab",
      max_duration_seconds: 30,
      needs_audio: false,
      expires_at: "2026-07-15T12:10:00.000Z",
      ...overrides.model_output,
    },
    turn: {
      turn_id: "turn-1",
      session_id: "session-1",
      branch: "default",
      source: "browser",
      role: "explain",
      query: "Why does this chart move when I scroll?",
      surface_id: "surface-browser-1",
      delegation_envelope_id: "envelope-1",
      ...overrides.turn,
    },
    capability_snapshot: { id: "caps-1", digest: SHA, ...overrides.capability_snapshot },
    provider_support: {
      provider: "vertex",
      direct_video_input: true,
      reason: "direct_video_supported",
      ...overrides.provider_support,
    },
    retention: { policy: "short_lived", delete_at: "2026-07-15T12:10:00.000Z", ...overrides.retention },
    surface_id: "surface-browser-1",
    ...overrides.top,
  };
}

function trusted(receiptId, extra = {}) {
  return {
    receipt_id: receiptId,
    authority: "trusted_surface_user_action",
    user_activated: true,
    surface_id: "surface-browser-1",
    at: "2026-07-15T12:01:00.000Z",
    ...extra,
  };
}

function uploadedEvidence(extra = {}) {
  return {
    schema: "evidence_asset.v1",
    evidence_id: "evidence-video-1",
    kind: "video",
    subject: "tab",
    captured_at: "2026-07-15T12:01:00.000Z",
    expires_at: "2026-07-15T12:10:00.000Z",
    media: {
      transport: "gateway_blob",
      media_type: "video/webm",
      byte_count: 1024,
      duration_seconds: 4.5,
      sha256: SHA,
      blob_ref: "blob-video-1",
      ...extra.media,
    },
    grant: {
      class: "user_started_capture",
      surface_id: "surface-browser-1",
      user_initiated: true,
      ...extra.grant,
    },
    ...extra,
  };
}

function binding(extra = {}) {
  return {
    turn_id: "turn-1",
    session_id: "session-1",
    branch: "default",
    role: "explain",
    original_query: "Why does this chart move when I scroll?",
    query_revision: 3,
    capability_snapshot_id: "caps-1",
    ...extra,
  };
}

function advanceToCaptured(core) {
  core.recordUserStarted("video-request-1", trusted("start-1"));
  core.recordCaptured("video-request-1", trusted("capture-1", {
    duration_seconds: 4.5,
    capture_scope: "tab",
    has_audio: false,
  }));
}

function advanceToAttached(core) {
  advanceToCaptured(core);
  core.recordUploaded("video-request-1", trusted("upload-1", { evidence: uploadedEvidence() }));
  core.attach("video-request-1", trusted("attach-1", {
    evidence_id: "evidence-video-1",
    binding: binding(),
  }));
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("model output creates a bounded zero-authority proposal with immutable turn bindings", () => {
  const { core } = harness();
  const record = core.proposeFromModel(proposal());
  assert.equal(record.status, "proposed");
  assert.equal(record.version, 1);
  assert.equal(record.turn.original_query, "Why does this chart move when I scroll?");
  assert.equal(record.capability_snapshot.id, "caps-1");
  assert.equal(record.provider_support.direct_video_input, true);
  assert.equal(record.retention.immediate_delete_available, true);
  assert.deepEqual(record.receipts, []);
  assert.deepEqual(STATES, ["proposed", "user_started", "captured", "uploaded", "attached", "processed", "deleted", "failed"]);
  assert.equal(MAX_DURATION_SECONDS, 120);
  assert.equal(MAX_REQUEST_TTL_MS, 900_000);
  assert.equal(MAX_VIDEO_RETENTION_MS, 86_400_000);
  assert.equal(MAX_VIDEO_BYTES, 24 * 1024 * 1024);

  record.turn.original_query = "mutated";
  assert.equal(core.get("video-request-1").turn.original_query, "Why does this chart move when I scroll?");
  assertCode(() => core.get("missing"), "request_not_found");
});

test("proposal defaults remain bounded and generated ids do not weaken validation", () => {
  const { core } = harness();
  const input = proposal({
    model_output: { request_id: undefined, expires_at: undefined, query_revision: undefined },
    turn: {
      query: undefined,
      original_query: "Keep this original question",
      query_revision: 7,
      surface_id: undefined,
      delegation_envelope_id: undefined,
    },
    capability_snapshot: { id: undefined, digest: undefined },
    retention: { delete_at: undefined },
    top: { capability_snapshot_id: "caps-fallback", surface_id: "surface-browser-1" },
  });
  const record = core.proposeFromModel(input);
  assert.equal(record.request_id, "video-request-generated");
  assert.equal(record.request.expires_at, "2026-07-15T12:15:00.000Z");
  assert.equal(record.turn.original_query, "Keep this original question");
  assert.equal(record.turn.query_revision, 7);
  assert.equal(record.turn.delegation_envelope_id, "");
  assert.equal(record.capability_snapshot.id, "caps-fallback");
  assert.equal(record.capability_snapshot.digest, "");
  assert.equal(record.retention.delete_at, record.request.expires_at);
  assertCode(() => core.proposeFromModel(input), "request_conflict");
});

test("model output alone cannot start capture and only a trusted user action advances it", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  assert.equal(core.get("video-request-1").status, "proposed");
  assertCode(() => core.recordCaptured("video-request-1", trusted("skip", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
  })), "invalid_transition");
  assertCode(() => core.recordUserStarted("video-request-1", {
    receipt_id: "model-start",
    authority: "model_output",
    user_activated: false,
    surface_id: "surface-browser-1",
  }), "trusted_user_action_required");
  assertCode(() => core.recordUserStarted("video-request-1", trusted("wrong-surface", {
    surface_id: "surface-browser-2",
  })), "surface_mismatch");
  assert.equal(core.get("video-request-1").status, "proposed");

  const started = core.recordUserStarted("video-request-1", trusted("start-ok"));
  assert.equal(started.status, "user_started");
  assert.equal(started.receipts[0].event, "user_started");
});

test("trusted capture, upload, attachment, and direct processing preserve the original reasoning turn", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToAttached(core);
  const continuation = core.createContinuation("video-request-1");
  assert.equal(continuation.schema, "moa.reasoning-turn.v2");
  assert.equal(continuation.continuation, "video_evidence");
  assert.equal(continuation.turn.query, "Why does this chart move when I scroll?");
  assert.equal(continuation.turn.turn_id, "turn-1");
  assert.equal(continuation.turn.session_id, "session-1");
  assert.equal(continuation.turn.branch, "default");
  assert.equal(continuation.turn.role, "explain");
  assert.equal(continuation.capability_snapshot_id, "caps-1");
  assert.deepEqual(continuation.evidence_refs, ["evidence-video-1"]);
  assert.equal("transcript" in continuation.turn, false);
  assert.equal("voice_turn" in continuation, false);

  const processed = core.recordProcessed("video-request-1", {
    receipt_id: "provider-1",
    provider_receipt_ref: "provider-receipt-1",
    at: "2026-07-15T12:02:00.000Z",
  });
  assert.equal(processed.status, "processed");
  assert.equal(processed.processing.direct_video_received, true);
  assert.equal(processed.evidence.blob_ref, "blob-video-1");
});

test("attachment rejects cross-turn, cross-session, query, capability, and evidence replay", () => {
  for (const [field, value] of [
    ["turn_id", "turn-2"],
    ["session_id", "session-2"],
    ["branch", "other"],
    ["role", "delegate"],
    ["original_query", "different question"],
    ["query_revision", 4],
    ["capability_snapshot_id", "caps-2"],
  ]) {
    const { core } = harness();
    core.proposeFromModel(proposal());
    advanceToCaptured(core);
    core.recordUploaded("video-request-1", trusted("upload-1", { evidence: uploadedEvidence() }));
    assertCode(() => core.attach("video-request-1", trusted(`attach-${field}`, {
      evidence_id: "evidence-video-1",
      binding: binding({ [field]: value }),
    })), "turn_binding_mismatch");
  }
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToCaptured(core);
  core.recordUploaded("video-request-1", trusted("upload-1", { evidence: uploadedEvidence() }));
  assertCode(() => core.attach("video-request-1", trusted("attach-wrong-evidence", {
    evidence_id: "evidence-video-2",
    binding: binding(),
  })), "evidence_mismatch");
});

test("receipt replay is idempotent and optimistic versions reject concurrent competitors", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  const receipt = trusted("start-idempotent");
  const first = core.recordUserStarted("video-request-1", receipt, { expected_version: 1 });
  const replay = core.recordUserStarted("video-request-1", receipt, { expected_version: 1 });
  assert.deepEqual(replay, first);
  assert.equal(replay.version, 2);
  assert.equal(replay.receipts.length, 1);
  assertCode(() => core.recordUserStarted("video-request-1", trusted("start-idempotent", {
    at: "2026-07-15T12:01:01.000Z",
  })), "idempotency_conflict");
  assertCode(() => core.recordCaptured("video-request-1", trusted("capture-competing", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
  }), { expected_version: 1 }), "version_conflict");

  const captured = core.recordCaptured("video-request-1", trusted("capture-winner", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
  }), { expected_version: 2 });
  assert.equal(captured.version, 3);
});

test("proposal, capture, media, audio, expiry, and retention bounds fail closed", () => {
  const invalidProposals = [
    proposal({ model_output: { max_duration_seconds: 121 } }),
    proposal({ model_output: { capture_scope: "application" } }),
    proposal({ model_output: { needs_audio: "yes" } }),
    proposal({ model_output: { status: "captured" } }),
    proposal({ model_output: { expires_at: "2026-07-15T12:16:00.000Z" } }),
    proposal({ turn: { query: " " } }),
    proposal({ turn: { role: "owner" } }),
    proposal({ provider_support: { direct_video_input: false, reason: "direct_video_supported" } }),
    proposal({ provider_support: { direct_video_input: true, reason: "unsupported" } }),
    proposal({ retention: { policy: "forever" } }),
    proposal({ retention: { delete_at: "2026-07-15T11:59:00.000Z" } }),
    proposal({ retention: { delete_at: "2026-07-16T12:00:01.000Z" } }),
  ];
  for (const input of invalidProposals) assert.throws(() => harness().core.proposeFromModel(input));

  const { core } = harness();
  core.proposeFromModel(proposal());
  core.recordUserStarted("video-request-1", trusted("start-1"));
  for (const invalid of [
    { duration_seconds: 31, capture_scope: "tab", has_audio: false },
    { duration_seconds: 1, capture_scope: "screen", has_audio: false },
    { duration_seconds: 1, capture_scope: "tab", has_audio: true },
  ]) {
    assert.throws(() => core.recordCaptured("video-request-1", trusted(`bad-${invalid.duration_seconds}-${invalid.capture_scope}-${invalid.has_audio}`, invalid)));
  }
  core.recordCaptured("video-request-1", trusted("capture-ok", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
  }));
  for (const evidence of [
    uploadedEvidence({ media: { transport: "inline" } }),
    uploadedEvidence({ media: { media_type: "video/avi" } }),
    uploadedEvidence({ media: { byte_count: MAX_VIDEO_BYTES + 1 } }),
    uploadedEvidence({ media: { duration_seconds: 31 } }),
    { ...uploadedEvidence(), grant: { ...uploadedEvidence().grant, user_initiated: false } },
    { ...uploadedEvidence(), grant: { ...uploadedEvidence().grant, surface_id: "surface-browser-2" } },
    { ...uploadedEvidence(), subject: "screen" },
    { ...uploadedEvidence(), captured_at: "2026-07-15T11:59:00.000Z" },
    { ...uploadedEvidence(), expires_at: "2026-07-15T12:00:30.000Z" },
    uploadedEvidence({ expires_at: "2026-07-15T12:11:00.000Z" }),
  ]) {
    assert.throws(() => core.recordUploaded("video-request-1", trusted(`bad-upload-${Math.random()}`, { evidence })));
  }
});

test("raw video bytes are rejected and only opaque blob metadata is stored", () => {
  const { core } = harness();
  assertCode(() => core.proposeFromModel(proposal({ top: { bytes: Buffer.from("video") } })), "raw_media_forbidden");
  assertCode(() => core.proposeFromModel(proposal({ top: { payload: Buffer.from("video") } })), "raw_media_forbidden");
  core.proposeFromModel(proposal());
  advanceToCaptured(core);
  assertCode(() => core.recordUploaded("video-request-1", trusted("raw-upload", {
    evidence: uploadedEvidence({ media: { data: "base64-video" } }),
  })), "raw_media_forbidden");
  core.recordUploaded("video-request-1", trusted("metadata-upload", { evidence: uploadedEvidence() }));
  const stored = JSON.stringify(core.get("video-request-1"));
  assert.doesNotMatch(stored, /base64-video/);
  assert.match(stored, /blob-video-1/);
});

test("malformed schemas, identifiers, timestamps, digests, and media metadata are rejected", () => {
  const cases = [
    null,
    { ...proposal(), model_output: null },
    proposal({ model_output: { schema: "unknown" } }),
    proposal({ model_output: { request_id: "bad/id" } }),
    proposal({ model_output: { reason: "x".repeat(601) } }),
    proposal({ model_output: { query_revision: 0 } }),
    proposal({ model_output: { expires_at: "not-a-date" } }),
    proposal({ turn: { turn_id: "" } }),
    proposal({ capability_snapshot: { digest: "sha256:bad" } }),
    proposal({ provider_support: { direct_video_input: "yes" } }),
    proposal({ retention: { delete_at: "not-a-date" } }),
  ];
  for (const input of cases) assert.throws(() => harness().core.proposeFromModel(input));

  const invalidEvidence = [
    null,
    { ...uploadedEvidence(), schema: "unknown" },
    { ...uploadedEvidence(), kind: "screenshot" },
    { ...uploadedEvidence(), grant: null },
    { ...uploadedEvidence(), media: null },
    { ...uploadedEvidence(), evidence_id: "bad/id" },
    { ...uploadedEvidence(), media: { ...uploadedEvidence().media, byte_count: 0 } },
    { ...uploadedEvidence(), media: { ...uploadedEvidence().media, duration_seconds: Number.NaN } },
    { ...uploadedEvidence(), media: { ...uploadedEvidence().media, sha256: "sha256:bad" } },
    { ...uploadedEvidence(), media: { ...uploadedEvidence().media, blob_ref: "" } },
  ];
  for (const [index, evidence] of invalidEvidence.entries()) {
    const { core } = harness();
    core.proposeFromModel(proposal());
    advanceToCaptured(core);
    assert.throws(() => core.recordUploaded("video-request-1", trusted(`invalid-evidence-${index}`, { evidence })));
  }
});

test("unsupported providers are explicit and derivation cannot masquerade as direct video", () => {
  const { core } = harness();
  core.proposeFromModel(proposal({
    provider_support: {
      direct_video_input: false,
      provider: "openai_compatible",
      reason: "model_video_input_unavailable",
    },
  }));
  advanceToAttached(core);
  assert.equal(core.createContinuation("video-request-1").provider_video.direct_video_input, false);
  assertCode(() => core.recordProcessed("video-request-1", {
    receipt_id: "provider-unsupported",
    provider_receipt_ref: "provider-receipt-1",
  }), "video_provider_unsupported");

  const direct = harness().core;
  direct.proposeFromModel(proposal());
  advanceToAttached(direct);
  assertCode(() => direct.recordProcessed("video-request-1", {
    receipt_id: "provider-derived",
    provider_receipt_ref: "provider-receipt-2",
    derivation: "sampled_frames",
  }), "silent_derivation_forbidden");
});

test("explicit deletion clears the blob reference and keeps a bounded deletion tombstone receipt", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToAttached(core);
  const deleted = core.deleteEvidence("video-request-1", trusted("delete-1", {
    reason: "user requested immediate deletion",
    blob_delete_receipt_ref: "blob-delete-1",
    at: "2026-07-15T12:03:00.000Z",
  }));
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.evidence.blob_ref, null);
  assert.equal(deleted.evidence.deleted, true);
  assert.equal(deleted.deletion.blob_delete_receipt_ref, "blob-delete-1");
  assert.equal(deleted.receipts.at(-1).event, "deleted");
  assert.deepEqual(core.deleteEvidence("video-request-1", trusted("delete-1", {
    reason: "user requested immediate deletion",
    blob_delete_receipt_ref: "blob-delete-1",
    at: "2026-07-15T12:03:00.000Z",
  })), deleted);
  assertCode(() => core.createContinuation("video-request-1"), "invalid_transition");
});

test("expired proposals cannot advance and become a durable failed expiry receipt", () => {
  const { core, setNow } = harness();
  core.proposeFromModel(proposal());
  assertCode(() => core.expire("video-request-1"), "not_expired");
  setNow("2026-07-15T12:10:01.000Z");
  assertCode(() => core.recordUserStarted("video-request-1", trusted("late-start")), "request_expired");
  const expired = core.expire("video-request-1", { receipt_id: "expiry-1" });
  assert.equal(expired.status, "failed");
  assert.equal(expired.failure.code, "expired");
  assert.equal(expired.receipts.at(-1).code, "expired");
});

test("explicit failure is bounded, versioned, and deletable by the owning surface", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  const failed = core.fail("video-request-1", {
    receipt_id: "failure-1",
    code: "capture_cancelled",
    message: "User cancelled the picker",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.code, "capture_cancelled");
  const deleted = core.deleteEvidence("video-request-1", trusted("delete-failed", { reason: "remove request metadata" }));
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.evidence, null);
});
