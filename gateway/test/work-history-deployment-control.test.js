"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createWorkHistoryStore } = require("../lib/work-history");

function makeStore(tempDir, originId = "deploy-control-test") {
  return createWorkHistoryStore({
    events: createEventSubstrateStore({ dataDir: tempDir, originId }),
  });
}

async function createReadyPreview(store, suffix) {
  const request = await store.requestDeployment({
    target: "gateway",
    branch: `agent/m4-deployment-control-plane-${suffix}`,
    commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
    reason: `preview request ${suffix}`,
    adapter_kind: "deterministic_fake",
    candidate_refs: [{ candidate_id: `cand_${suffix}`, artifact_ref: `artifact://preview-${suffix}`, provenance_ref: `provenance://commit-${suffix}` }],
    artifact_refs: [`artifact://preview-${suffix}`],
    provenance_ref: `provenance://commit-${suffix}`,
    source_turn_id: `turn_deploy_${suffix}`,
  });
  await store.reviewDeploymentRequest({
    request_id: request.request_id,
    decision: "approved",
    reason: `review ${suffix}`,
  });
  const previewClaim = await store.claimDeploymentRequest({
    request_id: request.request_id,
    worker_id: `preview-worker-${suffix}`,
    operation: "preview",
    claim_id: `claim_preview_${suffix}`,
    lease_expires_at: "2099-01-01T00:00:00Z",
  });
  await store.recordDeployment({
    request_id: request.request_id,
    deployment_id: `dep_preview_${suffix}`,
    target: "gateway",
    mode: "preview",
    status: "available",
    preview_url: `https://preview.example.test/${suffix}`,
    commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
    artifact_refs: [`artifact://preview-${suffix}`],
    deployment_control_plane: "deterministic_fake",
    worker_id: previewClaim.worker_id,
    claim_id: previewClaim.claim_id,
  });
  return { request, previewClaim };
}

test("preview records and verifications must match the active preview claim", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-preview-"));
  try {
    const store = makeStore(tempDir, "deploy-preview-binding");
    const { request, previewClaim } = await createReadyPreview(store, "binding");

    await assert.rejects(
      store.recordDeployment({
        request_id: request.request_id,
        deployment_id: "dep_preview_wrong_claim",
        target: "gateway",
        mode: "preview",
        status: "available",
        preview_url: "https://preview.example.test/wrong-claim",
        artifact_refs: ["artifact://preview-binding"],
        worker_id: previewClaim.worker_id,
        claim_id: "claim_preview_wrong",
      }),
      /claim is stale/,
    );

    await assert.rejects(
      store.recordDeploymentVerification({
        request_id: request.request_id,
        deployment_id: "dep_preview_other",
        operation: "preview",
        surface: "deploy",
        command: "wrong deployment smoke",
        status: "passed",
        worker_id: previewClaim.worker_id,
        claim_id: previewClaim.claim_id,
      }),
      /current preview deployment/,
    );

    await assert.rejects(
      store.recordDeploymentVerification({
        request_id: request.request_id,
        deployment_id: "dep_preview_binding",
        operation: "preview",
        surface: "deploy",
        command: "wrong worker smoke",
        status: "passed",
        worker_id: "other-worker",
        claim_id: previewClaim.claim_id,
      }),
      /claimed by/,
    );

    await assert.rejects(
      store.claimDeploymentRequest({
        request_id: request.request_id,
        worker_id: "apply-before-verify",
        operation: "apply",
        claim_id: "claim_apply_preverify",
      }),
      /verification has not passed/,
    );

    await store.recordDeploymentVerification({
      request_id: request.request_id,
      deployment_id: "dep_preview_binding",
      operation: "preview",
      surface: "deploy",
      command: "preview smoke",
      status: "passed",
      worker_id: previewClaim.worker_id,
      claim_id: previewClaim.claim_id,
      summary: "preview smoke passed",
    });

    const detail = await store.deploymentRequestDetail(request.request_id);
    assert.equal(detail.latest_preview_verification.status, "passed");

    const applyClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "apply-worker-binding",
      operation: "apply",
      claim_id: "claim_apply_binding",
      lease_expires_at: "2099-01-01T00:00:00Z",
    });
    assert.equal(applyClaim.claim_id, "claim_apply_binding");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("crash-after-effect requires audited adoption before a replacement worker can receipt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-recovery-"));
  try {
    let store = makeStore(tempDir, "deploy-crash-recovery");
    const { request, previewClaim } = await createReadyPreview(store, "recovery");
    await store.recordDeploymentVerification({
      request_id: request.request_id,
      deployment_id: "dep_preview_recovery",
      operation: "preview",
      surface: "deploy",
      command: "preview smoke",
      status: "passed",
      worker_id: previewClaim.worker_id,
      claim_id: previewClaim.claim_id,
      summary: "preview smoke passed",
    });

    const applyClaim = await store.claimDeploymentRequest({
      request_id: request.request_id,
      worker_id: "apply-worker-recovery",
      operation: "apply",
      claim_id: "claim_apply_recovery_original",
      lease_expires_at: new Date(Date.now() + 40).toISOString(),
    });
    const applyEffect = await store.observeDeploymentOperationEffect({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "apply-worker-recovery",
      claim_id: applyClaim.claim_id,
      effect_id: "eff_apply_recovery",
      deployment_id: "dep_live_recovery",
      target: "gateway",
      active_url: "https://app.example.test/recovery",
      artifact_refs: ["artifact://live-recovery"],
      backup_record_ref: "backup://candidate-recovery",
      restore_check_ref: "restore://candidate-recovery",
      smoke_artifact_ref: "smoke://candidate-recovery",
      rollback_ref: "rollback://candidate-recovery",
      drain_status: "drained",
      compatibility_status: "compatible",
      summary: "effect observed before worker crashed",
    });

    await assert.rejects(
      store.claimDeploymentRequest({
        request_id: request.request_id,
        worker_id: "apply-worker-replacement",
        operation: "apply",
        claim_id: "claim_apply_replacement",
      }),
      /effect is already observed; use explicit adoption/,
    );

    store = makeStore(tempDir, "deploy-crash-recovery");
    await assert.rejects(
      store.adoptDeploymentOperationEffect({
        request_id: request.request_id,
        operation: "apply",
        worker_id: "apply-worker-replacement",
        claim_id: "claim_apply_replacement",
        lease_expires_at: "2099-01-01T00:00:00Z",
        effect_id: applyEffect.effect_id,
      }),
      /original effect claim is still active/,
    );
    await assert.rejects(
      store.claimDeploymentRequest({
        request_id: request.request_id,
        worker_id: "apply-worker-replacement",
        operation: "apply",
        claim_id: "claim_apply_replacement",
      }),
      /effect is already observed; use explicit adoption/,
    );

    await new Promise((resolve) => setTimeout(resolve, 60));

    const adopted = await store.adoptDeploymentOperationEffect({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "apply-worker-replacement",
      claim_id: "claim_apply_replacement",
      lease_expires_at: "2099-01-01T00:00:00Z",
      effect_id: applyEffect.effect_id,
      reason: "replacement worker reconciled the crash-after-effect gap",
    });
    assert.equal(adopted.effect_adoptions.length, 1);
    assert.equal(adopted.effect_adoptions[0].adopted_claim_id, "claim_apply_replacement");

    let detail = await store.receiptDeploymentOperation({
      request_id: request.request_id,
      operation: "apply",
      worker_id: "apply-worker-replacement",
      claim_id: "claim_apply_replacement",
      effect_id: applyEffect.effect_id,
      reason: "guarded apply recovered after crash",
    });
    assert.equal(detail.status, "applied");
    assert.equal(detail.latest_applied.receipt_id, detail.receipts.find((item) => item.operation === "apply").receipt_id);

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
      deployment_id: "dep_live_recovery",
      target: "gateway",
      active_url: "https://app.example.test/recovery",
      artifact_refs: ["artifact://rollback-recovery"],
      rollback_ref: "rollback://candidate-recovery",
      smoke_artifact_ref: "smoke://rollback-recovery",
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

    const rebuilt = makeStore(tempDir, "deploy-crash-recovery");
    const rebuiltDetail = await rebuilt.deploymentRequestDetail(request.request_id);
    assert.equal(rebuiltDetail.status, "rolled_back");
    assert.equal(rebuiltDetail.effect_adoptions.length, 1);
    assert.equal(rebuiltDetail.receipts.length, 2);
    const rebuiltLinks = await rebuilt.deploymentLinks({ target: "gateway" });
    assert.equal(rebuiltLinks.latest_applied, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an expired preview claim can be replaced and rebound before verification", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-preview-recovery-"));
  try {
    const store = makeStore(tempDir, "deploy-preview-recovery");
    const request = await store.requestDeployment({ target: "gateway", source_turn_id: "preview-recovery-turn" });
    await store.reviewDeploymentRequest({ request_id: request.request_id, decision: "approved" });
    const original = await store.claimDeploymentRequest({
      request_id: request.request_id, operation: "preview", worker_id: "preview-original",
      claim_id: "preview-original-claim", lease_expires_at: new Date(Date.now() + 30).toISOString(),
    });
    await store.recordDeployment({
      request_id: request.request_id, deployment_id: "preview-recovery-deployment", target: "gateway",
      mode: "preview", status: "available", preview_url: "https://preview.example.test/rebound",
      worker_id: "preview-original", claim_id: original.claim_id,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      store.recordDeploymentVerification({
        request_id: request.request_id, deployment_id: "preview-recovery-deployment", operation: "preview",
        worker_id: "preview-original", claim_id: original.claim_id, status: "passed",
      }),
      /claim lease expired/,
    );
    const replacement = await store.claimDeploymentRequest({
      request_id: request.request_id, operation: "preview", worker_id: "preview-replacement",
      claim_id: "preview-replacement-claim", lease_expires_at: "2099-01-01T00:00:00Z",
    });
    await store.recordDeployment({
      request_id: request.request_id, deployment_id: "preview-recovery-deployment", target: "gateway",
      mode: "preview", status: "available", preview_url: "https://preview.example.test/rebound",
      worker_id: "preview-replacement", claim_id: replacement.claim_id,
    });
    await store.recordDeploymentVerification({
      request_id: request.request_id, deployment_id: "preview-recovery-deployment", operation: "preview",
      worker_id: "preview-replacement", claim_id: replacement.claim_id, status: "passed",
    });
    const detail = await store.deploymentRequestDetail(request.request_id);
    assert.equal(detail.latest_preview.claim_id, replacement.claim_id);
    assert.equal(detail.latest_preview_verification.created_by_worker_id, "preview-replacement");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("deployment request idempotency rejects mismatched replay payloads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-idem-"));
  try {
    const store = makeStore(tempDir, "deploy-idempotency");
    await store.requestDeployment({
      target: "gateway",
      branch: "agent/m4-deployment-control-plane",
      commit_sha: "dddddddddddddddddddddddddddddddddddddddd",
      reason: "original request",
      source_turn_id: "turn_idempotent_replay",
    });

    await assert.rejects(
      store.requestDeployment({
        target: "gateway",
        branch: "agent/m4-mutated-branch",
        commit_sha: "dddddddddddddddddddddddddddddddddddddddd",
        reason: "mutated request",
        source_turn_id: "turn_idempotent_replay",
      }),
      /mismatched deployment.requested request_fingerprint/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("typed refs reject objects, secrets, and shell payloads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-refs-"));
  try {
    const store = makeStore(tempDir, "deploy-refs");

    await assert.rejects(
      store.createTask({
        title: "bad refs task",
        objective: "prove refs are strings only",
        acceptance_refs: [{ bad: true }],
      }),
      /typed string references|must be a string/,
    );

    await assert.rejects(
      store.requestDeployment({
        target: "gateway",
        reason: "object refs are invalid",
        artifact_refs: [{ artifact_ref: "artifact://bundle" }],
        source_turn_id: "turn_bad_ref_object",
      }),
      /artifact_refs must be an array of typed string references|artifact_refs\[0\]/,
    );

    await assert.rejects(
      store.requestDeployment({
        target: "gateway",
        reason: "secret refs are invalid",
        artifact_refs: ["artifact://sk_live_secretmaterial"],
        source_turn_id: "turn_bad_ref_secret",
      }),
      /secret-like material/,
    );

    await assert.rejects(
      store.requestDeployment({
        target: "gateway",
        reason: "shell refs are invalid",
        artifact_refs: ["artifact://bundle;rm-rf"],
        source_turn_id: "turn_bad_ref_shell",
      }),
      /shell or control syntax/,
    );

    await assert.rejects(
      store.recordDeployment({
        target: "gateway",
        mode: "applied",
        status: "applied",
        active_url: "https://app.example.test",
      }),
      /guarded request_id/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("deployment projections rebuild beyond 500 deployment events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-deploy-pagination-"));
  try {
    const store = makeStore(tempDir, "deploy-pagination");
    const requestIds = [];
    for (let index = 0; index < 501; index += 1) {
      const request = await store.requestDeployment({
        target: "gateway",
        reason: `pagination request ${index}`,
        source_turn_id: `turn_pagination_${index}`,
      });
      requestIds.push(request.request_id);
    }

    let links = await store.deploymentLinks({ target: "gateway" });
    assert.equal(links.open_requests.length, 501);
    assert.ok(links.open_requests.some((item) => item.request_id === requestIds[500]));

    const rebuilt = makeStore(tempDir, "deploy-pagination");
    links = await rebuilt.deploymentLinks({ target: "gateway" });
    assert.equal(links.open_requests.length, 501);
    assert.ok(links.open_requests.some((item) => item.request_id === requestIds[0]));
    const rebuiltDetail = await rebuilt.deploymentRequestDetail(requestIds[500]);
    assert.equal(rebuiltDetail.request.request_id, requestIds[500]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
