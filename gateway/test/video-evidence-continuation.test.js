"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  MAX_DURATION_SECONDS,
  MAX_REQUEST_TTL_MS,
  MAX_RECEIPT_FUTURE_SKEW_MS,
  MAX_VIDEO_RETENTION_MS,
  MAX_VIDEO_BYTES,
  SCHEMA,
  STATES,
  createVideoEvidenceContinuationCore,
} = require("../lib/video-evidence-continuation");
const {
  MAX_STATE_BYTES,
  STORE_SCHEMA,
  createFileVideoEvidenceAdapter,
  createMemoryVideoEvidenceAdapter,
} = require("../lib/video-evidence-store");

const SHA = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const POSTURE_SHA = `sha256:${"c".repeat(64)}`;

function fixtureAuthorityVerifier() {
  return {
    verifySurfaceUserAction: (receipt) => receipt.fixture_authenticated === true,
    verifyBlobDeleteReceipt: (receipt) => receipt.fixture_authenticated === true,
    verifyProviderReceipt: (receipt) => receipt.fixture_authenticated === true,
  };
}

function harness(options = {}) {
  let current = "2026-07-15T12:00:00.000Z";
  const core = createVideoEvidenceContinuationCore({
    adapter: options.adapter || createMemoryVideoEvidenceAdapter(),
    authorityVerifier: options.authorityVerifier || fixtureAuthorityVerifier(),
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
      model: "gemini-3-pro",
      direct_video_input: true,
      reason: "direct_video_supported",
      posture_digest: POSTURE_SHA,
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
    assertion_kind: "surface_user_action",
    fixture_authenticated: true,
    user_activated: true,
    surface_id: "surface-browser-1",
    request_id: "video-request-1",
    turn_id: "turn-1",
    session_id: "session-1",
    at: "2026-07-15T12:01:00.000Z",
    ...extra,
  };
}

function uploadedEvidence(extra = {}) {
  const { media = {}, grant = {}, ...fields } = extra;
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
      has_audio: false,
      sha256: SHA,
      blob_ref: "blob-video-1",
      ...media,
    },
    grant: {
      class: "user_started_capture",
      surface_id: "surface-browser-1",
      user_initiated: true,
      ...grant,
    },
    ...fields,
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
    source: "browser",
    surface_id: "surface-browser-1",
    delegation_envelope_id: "envelope-1",
    capability_snapshot_id: "caps-1",
    capability_snapshot_digest: SHA,
    provider: "vertex",
    provider_model: "gemini-3-pro",
    provider_direct_video_input: true,
    provider_posture_digest: POSTURE_SHA,
    evidence_id: "evidence-video-1",
    blob_ref: "blob-video-1",
    evidence_sha256: SHA,
    ...extra,
  };
}

function providerReceipt(extra = {}) {
  return {
    assertion_kind: "provider_processing",
    fixture_authenticated: true,
    receipt_ref: "provider-receipt-1",
    request_id: "video-request-1",
    turn_id: "turn-1",
    session_id: "session-1",
    evidence_id: "evidence-video-1",
    blob_ref: "blob-video-1",
    sha256: SHA,
    provider: "vertex",
    model: "gemini-3-pro",
    direct_video_input: true,
    direct_video_received: true,
    capability_snapshot_id: "caps-1",
    capability_snapshot_digest: SHA,
    provider_posture_digest: POSTURE_SHA,
    ...extra,
  };
}

function blobDeleteReceipt(extra = {}) {
  return {
    assertion_kind: "blob_store_delete",
    fixture_authenticated: true,
    receipt_ref: "blob-delete-1",
    request_id: "video-request-1",
    evidence_id: "evidence-video-1",
    blob_ref: "blob-video-1",
    sha256: SHA,
    deleted: true,
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

function advanceToAttached(core, bindingOverrides = {}) {
  advanceToCaptured(core);
  core.recordUploaded("video-request-1", trusted("upload-1", { evidence: uploadedEvidence() }));
  core.attach("video-request-1", trusted("attach-1", {
    evidence_id: "evidence-video-1",
    binding: binding(bindingOverrides),
  }));
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function withDurableStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-video-evidence-store-"));
  const stateFile = path.join(root, "video-evidence.json");
  return Promise.resolve(fn({ root, stateFile })).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function runFileChild(stateFile, suffix) {
  const fixture = path.join(__dirname, "fixtures", "video-evidence-file-child.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, stateFile, suffix], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`video evidence child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`invalid child output: ${stdout} ${stderr}`)); }
    });
  });
}

test("core requires explicit persistence and authenticated-authority seams", () => {
  assert.throws(() => createVideoEvidenceContinuationCore(), /persistence adapter/);
  assert.throws(() => createVideoEvidenceContinuationCore({ adapter: createMemoryVideoEvidenceAdapter() }), /authority verifier/);
  const denied = harness({
    authorityVerifier: {
      verifySurfaceUserAction: () => false,
      verifyBlobDeleteReceipt: () => false,
      verifyProviderReceipt: () => false,
    },
  }).core;
  denied.proposeFromModel(proposal());
  assertCode(() => denied.recordUserStarted("video-request-1", trusted("unverified-start")), "surface_receipt_unverified");
});

test("persistence adapters expose bounded revisions and fail closed on corrupt or unsafe state", () => withDurableStore(({ root, stateFile }) => {
  const memory = createMemoryVideoEvidenceAdapter();
  assert.equal(memory.read().revision, 0);
  memory.transact((state) => { state.records.one = { id: "one" }; });
  assert.equal(memory.read().revision, 1);
  memory.transact(() => {});
  assert.equal(memory.read().revision, 1);
  assertCode(() => memory.transact(() => {}, { expected_revision: 0 }), "VIDEO_EVIDENCE_STORE_CAS_CONFLICT");

  const file = createFileVideoEvidenceAdapter({ stateFile });
  assert.deepEqual(file.read(), {
    schema: STORE_SCHEMA,
    revision: 0,
    records: {},
    asset_claims: { evidence_id: {}, blob_ref: {}, sha256: {} },
  });
  fs.writeFileSync(stateFile, "{");
  assertCode(() => file.read(), "VIDEO_EVIDENCE_STORE_CORRUPT");
  fs.writeFileSync(stateFile, "x".repeat(MAX_STATE_BYTES + 1));
  assertCode(() => file.read(), "VIDEO_EVIDENCE_STORE_BOUNDED");
  fs.rmSync(stateFile, { force: true });
  const external = path.join(root, "external.json");
  fs.writeFileSync(external, JSON.stringify({ schema: STORE_SCHEMA }));
  fs.symlinkSync(external, stateFile);
  assertCode(() => file.read(), "VIDEO_EVIDENCE_STORE_UNSAFE");
}));

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
  assert.equal(MAX_RECEIPT_FUTURE_SKEW_MS, 300_000);
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
    capability_snapshot: { id: undefined },
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
  assert.equal(record.capability_snapshot.digest, SHA);
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
    assertion_kind: "model_output",
    user_activated: false,
    surface_id: "surface-browser-1",
  }), "surface_user_action_assertion_required");
  assertCode(() => core.recordUserStarted("video-request-1", trusted("wrong-surface", {
    surface_id: "surface-browser-2",
  })), "surface_mismatch");
  assertCode(() => core.recordUserStarted("video-request-1", trusted("wrong-turn-binding", {
    request_id: "video-request-2",
  })), "surface_receipt_binding_mismatch");
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
    provider_receipt: providerReceipt(),
    at: "2026-07-15T12:02:00.000Z",
  });
  assert.equal(processed.status, "processed");
  assert.equal(processed.processing.direct_video_received, true);
  assert.equal(processed.processing.model, "gemini-3-pro");
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
    ["source", "voice"],
    ["surface_id", "surface-browser-2"],
    ["delegation_envelope_id", "envelope-2"],
    ["capability_snapshot_id", "caps-2"],
    ["capability_snapshot_digest", SHA_B],
    ["provider", "openai-compatible"],
    ["provider_model", "other-model"],
    ["provider_direct_video_input", false],
    ["provider_posture_digest", SHA_B],
    ["evidence_id", "evidence-video-2"],
    ["blob_ref", "blob-video-2"],
    ["evidence_sha256", SHA_B],
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

test("receipt timestamps are monotonic and bounded against future skew", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  core.recordUserStarted("video-request-1", trusted("start-time"));
  assertCode(() => core.recordCaptured("video-request-1", trusted("capture-regression", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
    at: "2026-07-15T12:00:59.000Z",
  })), "receipt_time_regression");
  assertCode(() => core.recordCaptured("video-request-1", trusted("capture-future", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
    at: "2026-07-15T12:05:01.000Z",
  })), "receipt_time_future");
  const unchanged = core.get("video-request-1");
  assert.equal(unchanged.status, "user_started");
  assert.equal(unchanged.updated_at, "2026-07-15T12:01:00.000Z");
});

test("durable adapter reloads records, receipts, claims, tombstones, and rejects stale CAS", () => withDurableStore(({ stateFile }) => {
  const adapterOne = createFileVideoEvidenceAdapter({ stateFile });
  const first = harness({ adapter: adapterOne }).core;
  first.proposeFromModel(proposal());
  advanceToAttached(first);
  const beforeDelete = adapterOne.read();
  assert.equal(beforeDelete.records["video-request-1"].status, "attached");
  assert.equal(beforeDelete.records["video-request-1"].receipts.length, 4);
  assert.equal(beforeDelete.asset_claims.evidence_id["evidence-video-1"].turn_id, "turn-1");

  const adapterTwo = createFileVideoEvidenceAdapter({ stateFile });
  const restarted = harness({ adapter: adapterTwo }).core;
  assert.equal(restarted.get("video-request-1").version, 5);
  const staleRevision = adapterOne.read().revision;
  restarted.deleteEvidence("video-request-1", trusted("delete-restart", {
    reason: "restart deletion",
    blob_delete_receipt: blobDeleteReceipt(),
    at: "2026-07-15T12:02:00.000Z",
  }));
  assertCode(() => adapterOne.transact(() => {}, { expected_revision: staleRevision }), "VIDEO_EVIDENCE_STORE_CAS_CONFLICT");

  const adapterThree = createFileVideoEvidenceAdapter({ stateFile });
  const afterRestart = harness({ adapter: adapterThree }).core;
  const tombstone = afterRestart.get("video-request-1");
  assert.equal(tombstone.status, "deleted");
  assert.equal(tombstone.evidence.blob_ref, null);
  assert.equal(adapterThree.read().asset_claims.blob_ref["blob-video-1"].request_id, "video-request-1");
  afterRestart.proposeFromModel(proposal({
    model_output: { request_id: "video-request-after-delete" },
    turn: { turn_id: "turn-after-delete", session_id: "session-after-delete", query: "Reuse deleted asset?" },
  }));
  const afterDeleteBinding = {
    request_id: "video-request-after-delete",
    turn_id: "turn-after-delete",
    session_id: "session-after-delete",
  };
  afterRestart.recordUserStarted("video-request-after-delete", trusted("start-after-delete", afterDeleteBinding));
  afterRestart.recordCaptured("video-request-after-delete", trusted("capture-after-delete", {
    ...afterDeleteBinding,
    duration_seconds: 4.5,
    capture_scope: "tab",
    has_audio: false,
  }));
  assertCode(() => afterRestart.recordUploaded("video-request-after-delete", trusted("upload-after-delete", {
    ...afterDeleteBinding,
    evidence: uploadedEvidence(),
  })), "evidence_identity_reuse");
}));

test("parallel file-backed instances serialize and only one can claim a shared blob and digest", () => withDurableStore(async ({ stateFile }) => {
  const results = await Promise.all([runFileChild(stateFile, "alpha"), runFileChild(stateFile, "beta")]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.deepEqual(results.filter((item) => !item.ok).map((item) => item.code), ["evidence_identity_reuse"]);
  const adapter = createFileVideoEvidenceAdapter({ stateFile });
  const state = adapter.read();
  assert.equal(Object.keys(state.records).length, 2);
  assert.equal(Object.keys(state.asset_claims.blob_ref).length, 1);
  assert.equal(Object.keys(state.asset_claims.sha256).length, 1);
  assert.equal(Object.values(state.records).filter((record) => record.status === "uploaded").length, 1);
  assert.equal(Object.values(state.records).filter((record) => record.status === "captured").length, 1);
}));

test("evidence id, blob ref, and digest are globally single-owner across requests and turns", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToCaptured(core);
  core.recordUploaded("video-request-1", trusted("upload-owner", { evidence: uploadedEvidence() }));

  core.proposeFromModel(proposal({
    model_output: { request_id: "video-request-2" },
    turn: { turn_id: "turn-2", session_id: "session-2", query: "Second question" },
  }));
  const secondTurnReceipt = { request_id: "video-request-2", turn_id: "turn-2", session_id: "session-2" };
  core.recordUserStarted("video-request-2", trusted("start-2", secondTurnReceipt));
  core.recordCaptured("video-request-2", trusted("capture-2", {
    ...secondTurnReceipt,
    duration_seconds: 4.5,
    capture_scope: "tab",
    has_audio: false,
  }));

  const reuses = [
    uploadedEvidence(),
    uploadedEvidence({
      media: { blob_ref: "blob-video-2", sha256: SHA_B },
    }),
    uploadedEvidence({
      evidence_id: "evidence-video-3",
      media: { blob_ref: "blob-video-1", sha256: SHA_B },
    }),
    uploadedEvidence({
      evidence_id: "evidence-video-4",
      media: { blob_ref: "blob-video-4", sha256: SHA },
    }),
  ];
  for (const [index, evidence] of reuses.entries()) {
    assertCode(() => core.recordUploaded("video-request-2", trusted(`reuse-${index}`, {
      ...secondTurnReceipt,
      evidence,
    })), "evidence_identity_reuse");
  }
  assert.equal(core.get("video-request-2").status, "captured");
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
    uploadedEvidence({ media: { duration_seconds: 4.4 } }),
    uploadedEvidence({ media: { has_audio: true } }),
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
  advanceToAttached(core, {
    provider: "openai_compatible",
    provider_direct_video_input: false,
  });
  assert.equal(core.createContinuation("video-request-1").provider_video.direct_video_input, false);
  assertCode(() => core.recordProcessed("video-request-1", {
    receipt_id: "provider-unsupported",
    provider_receipt: providerReceipt(),
  }), "video_provider_unsupported");

  const direct = harness().core;
  direct.proposeFromModel(proposal());
  advanceToAttached(direct);
  assertCode(() => direct.recordProcessed("video-request-1", {
    receipt_id: "provider-derived",
    provider_receipt: providerReceipt({ receipt_ref: "provider-receipt-2" }),
    derivation: "sampled_frames",
  }), "silent_derivation_forbidden");
});

test("provider processing requires a trusted receipt bound to provider, model, posture, and exact asset", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToAttached(core);
  const falsifications = [
    { assertion_kind: "model_output" },
    { fixture_authenticated: false },
    { direct_video_received: false },
    { request_id: "video-request-2" },
    { turn_id: "turn-2" },
    { session_id: "session-2" },
    { evidence_id: "evidence-video-2" },
    { blob_ref: "blob-video-2" },
    { sha256: SHA_B },
    { provider: "openai-compatible" },
    { model: "other-model" },
    { direct_video_input: false },
    { capability_snapshot_id: "caps-2" },
    { capability_snapshot_digest: SHA_B },
    { provider_posture_digest: SHA_B },
    { receipt_ref: "" },
  ];
  for (const [index, mutation] of falsifications.entries()) {
    assert.throws(() => core.recordProcessed("video-request-1", {
      receipt_id: `provider-falsification-${index}`,
      provider_receipt: providerReceipt(mutation),
    }));
    assert.equal(core.get("video-request-1").status, "attached");
  }
  const processed = core.recordProcessed("video-request-1", {
    receipt_id: "provider-bound",
    provider_receipt: providerReceipt(),
    at: "2026-07-15T12:02:00.000Z",
  });
  assert.equal(processed.processing.provider_receipt_ref, "provider-receipt-1");
  assert.equal(processed.processing.evidence_sha256, SHA);
  assert.equal(processed.processing.provider_posture_digest, POSTURE_SHA);
});

test("explicit deletion clears the blob reference and keeps a bounded deletion tombstone receipt", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToAttached(core);
  const deleted = core.deleteEvidence("video-request-1", trusted("delete-1", {
    reason: "user requested immediate deletion",
    blob_delete_receipt: blobDeleteReceipt(),
    at: "2026-07-15T12:03:00.000Z",
  }));
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.evidence.blob_ref, null);
  assert.equal(deleted.evidence.deleted, true);
  assert.equal(deleted.deletion.blob_delete_receipt_ref, "blob-delete-1");
  assert.equal(deleted.receipts.at(-1).event, "deleted");
  assert.deepEqual(core.deleteEvidence("video-request-1", trusted("delete-1", {
    reason: "user requested immediate deletion",
    blob_delete_receipt: blobDeleteReceipt(),
    at: "2026-07-15T12:03:00.000Z",
  })), deleted);
  assertCode(() => core.createContinuation("video-request-1"), "invalid_transition");
});

test("deletion clears a blob ref only after a trusted store receipt binds the exact asset", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  advanceToAttached(core);
  const falsifications = [
    null,
    { assertion_kind: "surface_claim" },
    { fixture_authenticated: false },
    { deleted: false },
    { request_id: "video-request-2" },
    { evidence_id: "evidence-video-2" },
    { blob_ref: "blob-video-2" },
    { sha256: SHA_B },
    { receipt_ref: "" },
  ];
  for (const [index, mutation] of falsifications.entries()) {
    const blobReceipt = mutation === null ? undefined : blobDeleteReceipt(mutation);
    assert.throws(() => core.deleteEvidence("video-request-1", trusted(`delete-falsification-${index}`, {
      reason: "delete",
      blob_delete_receipt: blobReceipt,
    })));
    const unchanged = core.get("video-request-1");
    assert.equal(unchanged.status, "attached");
    assert.equal(unchanged.evidence.blob_ref, "blob-video-1");
  }
  const deleted = core.deleteEvidence("video-request-1", trusted("delete-bound", {
    reason: "delete",
    blob_delete_receipt: blobDeleteReceipt(),
  }));
  assert.equal(deleted.evidence.blob_ref, null);
  assert.equal(deleted.deletion.deleted_blob_ref, "blob-video-1");
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

test("explicit failure is bounded and cannot claim blob deletion without uploaded evidence", () => {
  const { core } = harness();
  core.proposeFromModel(proposal());
  const failed = core.fail("video-request-1", {
    receipt_id: "failure-1",
    code: "capture_cancelled",
    message: "User cancelled the picker",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.code, "capture_cancelled");
  assertCode(() => core.deleteEvidence("video-request-1", trusted("delete-failed", {
    reason: "remove request metadata",
    blob_delete_receipt: blobDeleteReceipt(),
  })), "evidence_required");
});
