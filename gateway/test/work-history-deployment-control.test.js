"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createWorkHistoryStore } = require("../lib/work-history");

test("deployment control requests use guarded immutable receipts and rebuild after restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-"));
  try {
    const store = createWorkHistoryStore({
      events: createEventSubstrateStore({ dataDir: tempDir, originId: "deploy-control-test" }),
    });

    const request = await store.requestDeployment({
      target: "gateway",
      branch: "agent/m4-deployment-control-plane",
      commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
      reason: "preview the M4 deployment control plane",
      adapter_kind: "deterministic_fake",
      candidate_refs: [{ candidate_id: "cand_gateway_1", artifact_ref: "artifact://preview-bundle", provenance_ref: "provenance://commit-c" }],
      artifact_refs: ["artifact://preview-bundle"],
      provenance_ref: "provenance://commit-c",
      source_turn_id: "turn_deploy_1",
    });

    let detail = await store.deploymentRequestDetail(request.request_id);
    assert.equal(detail.status, "requested");
    assert.match(detail.blocking_reason, /review approval/);
    await assert.rejects(
      store.claimDeploymentRequest({ request_id: request.request_id, worker_id: "deployer", operation: "preview" }),
      /awaiting review approval/,
    );

    detail = await store.reviewDeploymentRequest({
      request_id: request.request_id,
      decision: "approved",
      reason: "deterministic fake review",
    });
    assert.equal(detail.review.decision, "approved");

    const previewClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "deployer",
      operation: "preview",
      claim_id: "claim_preview_1",
      lease_expires_at: "2099-01-01T00:00:00Z",
    });
    assert.equal(previewClaim.claim_id, "claim_preview_1");

    await store.recordDeployment({
      request_id: request.request_id,
      deployment_id: "dep_preview_gateway",
      target: "gateway",
      mode: "preview",
      status: "available",
      preview_url: "https://preview.example.test/dep_preview_gateway",
      commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
      artifact_refs: ["artifact://preview-bundle"],
      deployment_control_plane: "deterministic_fake",
    });

    await assert.rejects(
      store.claimDeploymentRequest({
        request_id: request.request_id,
        worker_id: "deployer",
        operation: "apply",
        claim_id: "claim_apply_preverify",
      }),
      /verification has not passed/,
    );

    await store.recordDeploymentVerification({
      request_id: request.request_id,
      operation: "preview",
      surface: "deploy",
      command: "fake preview smoke",
      status: "passed",
      worker_id: "deployer",
      summary: "preview smoke passed",
    });

    const staleApplyClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "deployer",
      operation: "apply",
      claim_id: "claim_apply_stale",
      lease_expires_at: "2000-01-01T00:00:00Z",
    });
    assert.equal(staleApplyClaim.claim_id, "claim_apply_stale");
    await assert.rejects(
      store.observeDeploymentOperationEffect({
        request_id: request.request_id,
        operation: "apply",
        worker_id: "deployer",
        claim_id: staleApplyClaim.claim_id,
        effect_id: "eff_apply_stale",
        deployment_id: "dep_live_gateway",
        target: "gateway",
        active_url: "https://app.example.test",
        artifact_refs: ["artifact://live-bundle"],
        backup_record_ref: "backup://candidate-1",
        restore_check_ref: "restore://candidate-1",
        smoke_artifact_ref: "smoke://candidate-1",
        rollback_ref: "rollback://candidate-1",
        drain_status: "drained",
        compatibility_status: "compatible",
      }),
      /lease expired/,
    );

    const applyClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "deployer-recovery",
      operation: "apply",
      claim_id: "claim_apply_fresh",
      lease_expires_at: "2099-01-01T00:00:00Z",
    });
    const applyEffect = await store.observeDeploymentOperationEffect({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "deployer-recovery",
      claim_id: applyClaim.claim_id,
      effect_id: "eff_apply_1",
      deployment_id: "dep_live_gateway",
      target: "gateway",
      active_url: "https://app.example.test",
      artifact_refs: ["artifact://live-bundle"],
      backup_record_ref: "backup://candidate-1",
      restore_check_ref: "restore://candidate-1",
      smoke_artifact_ref: "smoke://candidate-1",
      rollback_ref: "rollback://candidate-1",
      drain_status: "drained",
      compatibility_status: "compatible",
      summary: "applied by deterministic fake adapter",
    });
    assert.equal(applyEffect.effect_id, "eff_apply_1");

    await assert.rejects(
      store.observeDeploymentOperationEffect({
        request_id: request.request_id,
        operation: "apply",
        worker_id: "deployer-recovery",
        claim_id: applyClaim.claim_id,
        effect_id: "eff_apply_2",
        deployment_id: "dep_live_gateway",
        target: "gateway",
        active_url: "https://app.example.test",
        artifact_refs: ["artifact://live-bundle"],
        backup_record_ref: "backup://candidate-2",
        restore_check_ref: "restore://candidate-2",
        smoke_artifact_ref: "smoke://candidate-2",
        rollback_ref: "rollback://candidate-2",
        drain_status: "drained",
        compatibility_status: "compatible",
      }),
      /already has a recorded apply effect/,
    );

    detail = await store.receiptDeploymentOperation({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "deployer-recovery",
      claim_id: applyClaim.claim_id,
      effect_id: applyEffect.effect_id,
      reason: "guarded fake apply completed",
    });
    assert.equal(detail.status, "applied");
    assert.equal(detail.latest_applied.active_url, "https://app.example.test");

    const repeatReceipt = await store.receiptDeploymentOperation({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "deployer-recovery",
      claim_id: applyClaim.claim_id,
      effect_id: applyEffect.effect_id,
      reason: "guarded fake apply completed",
    });
    assert.equal(repeatReceipt.receipts.filter((item) => item.operation === "apply").length, 1);

    const rollbackClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "rollback-worker",
      operation: "rollback",
      claim_id: "claim_rollback_1",
      lease_expires_at: "2099-01-01T00:00:00Z",
    });
    const rollbackEffect = await store.observeDeploymentOperationEffect({
      request_id: request.request_id,
      operation: "rollback",
      worker_id: "rollback-worker",
      claim_id: rollbackClaim.claim_id,
      effect_id: "eff_rollback_1",
      deployment_id: "dep_live_gateway",
      target: "gateway",
      active_url: "https://app.example.test",
      artifact_refs: ["artifact://rollback-bundle"],
      rollback_ref: "rollback://candidate-1",
      smoke_artifact_ref: "smoke://rollback-1",
      summary: "rolled back by deterministic fake adapter",
    });
    detail = await store.receiptDeploymentOperation({
      request_id: request.request_id,
      operation: "rollback",
      worker_id: "rollback-worker",
      claim_id: rollbackClaim.claim_id,
      effect_id: rollbackEffect.effect_id,
      reason: "rollback confirmed",
    });
    assert.equal(detail.status, "rolled_back");
    assert.equal(detail.receipts.filter((item) => item.operation === "rollback").length, 1);

    const links = await store.deploymentLinks({ target: "gateway" });
    assert.equal(links.latest_preview.preview_url, "https://preview.example.test/dep_preview_gateway");
    assert.equal(links.latest_applied, null, "the latest applied link must clear after rollback supersedes it");
    assert.equal(links.open_requests[0].derived_status, "rolled_back");

    const rebuilt = createWorkHistoryStore({
      events: createEventSubstrateStore({ dataDir: tempDir, originId: "deploy-control-test" }),
    });
    const rebuiltDetail = await rebuilt.deploymentRequestDetail(request.request_id);
    assert.equal(rebuiltDetail.status, "rolled_back");
    assert.equal(rebuiltDetail.preview_records[0].preview_url, "https://preview.example.test/dep_preview_gateway");
    assert.equal(rebuiltDetail.receipts.length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
