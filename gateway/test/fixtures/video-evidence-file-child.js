"use strict";

const { createVideoEvidenceContinuationCore } = require("../../lib/video-evidence-continuation");
const { createFileVideoEvidenceAdapter } = require("../../lib/video-evidence-store");

const [stateFile, suffix] = process.argv.slice(2);
const sha = `sha256:${"d".repeat(64)}`;
const posture = `sha256:${"e".repeat(64)}`;
const requestId = `video-request-${suffix}`;
const turnId = `turn-${suffix}`;
const sessionId = `session-${suffix}`;
const receipt = (id, extra = {}) => ({
  receipt_id: `${id}-${suffix}`,
  assertion_kind: "surface_user_action",
  fixture_authenticated: true,
  user_activated: true,
  surface_id: "surface-parallel",
  request_id: requestId,
  turn_id: turnId,
  session_id: sessionId,
  at: "2026-07-15T12:01:00.000Z",
  ...extra,
});

const core = createVideoEvidenceContinuationCore({
  adapter: createFileVideoEvidenceAdapter({ stateFile }),
  authorityVerifier: {
    verifySurfaceUserAction: (value) => value.fixture_authenticated === true,
    verifyBlobDeleteReceipt: (value) => value.fixture_authenticated === true,
    verifyProviderReceipt: (value) => value.fixture_authenticated === true,
  },
  now: () => "2026-07-15T12:00:00.000Z",
});

try {
  core.proposeFromModel({
    model_output: {
      schema: "moa.video-evidence-request.v1",
      request_id: requestId,
      query_revision: 1,
      reason: "Parallel identity claim",
      capture_scope: "tab",
      max_duration_seconds: 10,
      needs_audio: false,
      expires_at: "2026-07-15T12:10:00.000Z",
    },
    turn: {
      turn_id: turnId,
      session_id: sessionId,
      branch: "default",
      source: "browser",
      role: "explain",
      query: `Question ${suffix}`,
      surface_id: "surface-parallel",
    },
    capability_snapshot: { id: `caps-${suffix}`, digest: sha },
    provider_support: {
      provider: "vertex",
      model: "gemini-3-pro",
      direct_video_input: true,
      reason: "direct_video_supported",
      posture_digest: posture,
    },
    retention: { policy: "short_lived", delete_at: "2026-07-15T12:10:00.000Z" },
  });
  core.recordUserStarted(requestId, receipt("start"));
  core.recordCaptured(requestId, receipt("capture", {
    duration_seconds: 1,
    capture_scope: "tab",
    has_audio: false,
  }));
  core.recordUploaded(requestId, receipt("upload", {
    evidence: {
      schema: "evidence_asset.v1",
      evidence_id: `evidence-${suffix}`,
      kind: "video",
      subject: "tab",
      captured_at: "2026-07-15T12:01:00.000Z",
      expires_at: "2026-07-15T12:10:00.000Z",
      media: {
        transport: "gateway_blob",
        media_type: "video/webm",
        byte_count: 100,
        duration_seconds: 1,
        has_audio: false,
        sha256: sha,
        blob_ref: "blob-parallel-shared",
      },
      grant: {
        class: "user_started_capture",
        surface_id: "surface-parallel",
        user_initiated: true,
      },
    },
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, request_id: requestId })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, request_id: requestId, code: error.code, message: error.message })}\n`);
}
